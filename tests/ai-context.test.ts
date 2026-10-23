import assert from "node:assert/strict";
import test from "node:test";
import { AI_COMMAND_BYTES, AI_CONTEXT_BYTES, byteLength, commandDraftFromCode, extractCommandDraft, normalizeAiTerminalCommand, prepareAiText, redactAiText, truncateUtf8 } from "../apps/desktop/src/ai-context.ts";

test("AI context removes common credentials without reading any storage", () => {
  const source = [
    "Authorization: Bearer live-secret-value",
    'export OPENAI_API_KEY="sk-a-super-secret-key-123456"',
    '{"password":"spaced secret", "token":"another-secret"}',
    "curl --password 'two words' https://user:pass@example.invalid",
    "ghp_12345678901234567890",
    '{"Authorization":"Bearer quoted-secret"}',
    "DATABASE_URL=postgres://admin:database-secret@localhost/db",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value",
    "Cookie: session=browser-secret-value",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material\n-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const result = redactAiText(source);
  for (const secret of ["live-secret-value", "sk-a-super-secret-key-123456", "spaced secret", "another-secret", "two words", "user:pass", "ghp_12345678901234567890", "quoted-secret", "database-secret", "aws-secret-value", "browser-secret-value", "private-key-material"]) {
    assert.ok(!result.includes(secret), secret);
  }
  assert.ok(result.includes("example.invalid"));
});

test("unterminated PEM content and terminal control sequences are removed", () => {
  assert.equal(redactAiText("before\n-----BEGIN PRIVATE KEY-----\nprivate"), "before\n[已隐藏 PEM 内容]");
  assert.equal(redactAiText("\x1b[31merror\x1b[0m"), "error");
  assert.equal(redactAiText("\x1b]0;title\x07ok"), "ok");
});

test("AI byte limit preserves UTF-8 boundaries and reports truncation", () => {
  assert.equal(truncateUtf8("你好吗", 5), "你");
  assert.equal(truncateUtf8("😊ok", 3), "");
  const prepared = prepareAiText("你好".repeat(AI_CONTEXT_BYTES));
  assert.ok(byteLength(prepared.text) <= AI_CONTEXT_BYTES);
  assert.equal(prepared.truncated, true);
  assert.equal(prepared.redacted, false);
  assert.equal(prepareAiText("password=abc").redacted, true);
});

test("redaction is stable when the backend checks the preview again", () => {
  const redacted = redactAiText('password="secret" Authorization: Bearer another-secret');
  assert.equal(redactAiText(redacted), redacted);
});

test("only explicit fenced command blocks can become editable drafts", () => {
  assert.equal(extractCommandDraft("run rm -rf /"), null);
  assert.equal(extractCommandDraft("```sh\nls -la\n```"), "ls -la");
  assert.equal(extractCommandDraft("```sh\r\necho one\r\necho two\r\n```"), "echo one\r\necho two");
  assert.equal(extractCommandDraft("```sh\necho \x1b[31m\n```"), null);
  assert.equal(extractCommandDraft(`\`\`\`sh\n${"x".repeat(8193)}\n\`\`\``), null);
});

test("a diagnosis can contain configuration and multiple independently usable shell checks", () => {
  const answer = "配置内容：\n```yaml\nport: 8080\n```\n先查监听：\n```bash\nss -ltnp\n```\n再查服务：\n```sh\nsystemctl status app\n```";
  assert.equal(extractCommandDraft(answer), "ss -ltnp");
  assert.equal(commandDraftFromCode("systemctl status app", "sh"), "systemctl status app");
  for (const language of ["text", "json", "yaml", "log", "console", ""]) {
    assert.equal(commandDraftFromCode("Permission denied", language), null, language);
  }
});

test("unfinished or invalid command blocks cannot become executable drafts", () => {
  assert.equal(extractCommandDraft("```bash\nrm -"), null);
  assert.equal(extractCommandDraft("```text\nerror output\n```"), null);
  assert.equal(extractCommandDraft("```sh\necho \x1b[31m\n```\n```powershell\nGet-Process\n```"), "Get-Process");
  assert.equal(commandDraftFromCode(" Get-Process ", "PowerShell"), "Get-Process");
});

test("AI command normalization preserves shell backslash escapes in sed and printf", () => {
  const command = String.raw`sed 's/\r$//' input.txt; printf '%s\n' 'one\ttwo'`;
  assert.equal(normalizeAiTerminalCommand(command), `${command}\r`);
  const windowsPath = String.raw`Get-Content C:\tmp\notes.txt`;
  assert.equal(normalizeAiTerminalCommand(windowsPath), `${windowsPath}\r`);
});

test("AI commands normalize only real line endings and append a single Enter", () => {
  assert.equal(normalizeAiTerminalCommand("echo one\r\necho two\necho three"), "echo one\recho two\recho three\r");
  assert.equal(normalizeAiTerminalCommand("echo one\r"), "echo one\r");
});

test("AI commands reject blank, control characters, and oversized UTF-8 input", () => {
  for (const command of ["", " \r\n ", "ls\x1b[A", "echo\x00hidden", "echo\tcomplete", "echo\x7f", "echo\x9b31m"]) {
    assert.throws(() => normalizeAiTerminalCommand(command), command);
  }
  assert.throws(() => normalizeAiTerminalCommand("你".repeat(Math.floor(AI_COMMAND_BYTES / 3) + 1)));
  assert.throws(() => normalizeAiTerminalCommand("x".repeat(AI_COMMAND_BYTES)));
  assert.equal(byteLength(normalizeAiTerminalCommand("x".repeat(AI_COMMAND_BYTES - 1))), AI_COMMAND_BYTES);
});
