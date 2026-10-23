import test from "node:test";
import assert from "node:assert/strict";
import {
  completionSuffix,
  historySuggestions,
  parseAiSuggestions,
  safeCompletionCommand,
  sameTerminalPrompt,
  shellSetupPromptState,
  SHELL_INTEGRATION_COMMAND,
  TerminalPromptTracker,
} from "../apps/desktop/src/terminal-completion.ts";

test("shell setup requires a confirmed blank prompt on its original connection", () => {
  const original = {
    connectionId: "ssh-one", promptId: 2, revision: 4,
    integrated: false, phase: "unknown" as const, command: null, ready: false,
  };
  const ready = {
    ...original, promptId: 3, revision: 8, integrated: true,
    phase: "prompt" as const, command: "", ready: true,
  };
  assert.equal(shellSetupPromptState(original, original), "waiting");
  assert.equal(shellSetupPromptState(original, { ...ready, ready: false }), "waiting");
  assert.equal(shellSetupPromptState(original, ready), "ready");
  for (const changed of [
    { ...ready, connectionId: null },
    { ...ready, connectionId: "ssh-two" },
    { ...ready, promptId: 4 },
    { ...ready, promptId: 1 },
    { ...ready, command: "echo other-input" },
    { ...ready, phase: "running" as const, command: null },
    { ...ready, command: null },
  ]) {
    assert.equal(shellSetupPromptState(original, changed), "changed");
  }
});

function harness() {
  const tracker = new TerminalPromptTracker();
  const marker = { line: 0, isDisposed: false, dispose() { this.isDisposed = true; } };
  const lines = [{ text: "demo$ ", isWrapped: false }];
  const buffer = {
    type: "normal" as "normal" | "alternate",
    baseY: 0,
    cursorY: 0,
    cursorX: 6,
    getLine(index: number) {
      const line = lines[index];
      return line && {
        isWrapped: line.isWrapped,
        translateToString(trimRight = false, start = 0, end = 40) {
          const text = line.text.padEnd(40).slice(start, end);
          return trimRight ? text.trimEnd() : text;
        },
      };
    },
  };
  const prompt = () => {
    marker.isDisposed = false;
    tracker.osc("A", 0, () => undefined);
    tracker.osc("B", 6, () => marker);
  };
  const echo = (text: string) => {
    lines[0].text = `demo$ ${text}`;
    buffer.cursorX = 6 + text.length;
  };
  const snapshot = (connectionId = "connection-a") => tracker.snapshot(connectionId, buffer);
  return { tracker, marker, lines, buffer, prompt, echo, snapshot };
}

test("completion requires a marked prompt and matching remote echo", () => {
  const h = harness();
  assert.equal(h.snapshot().ready, false);
  h.prompt();
  assert.equal(h.snapshot().ready, true);
  h.tracker.input("df ");
  assert.equal(h.snapshot().ready, false, "in-flight input cannot accept a suffix");
  h.echo("df ");
  const owner = h.snapshot();
  assert.equal(owner.ready, true);
  assert.equal(completionSuffix("df -h", owner, h.snapshot()), "-h");
  assert.equal(completionSuffix("du -h", owner, h.snapshot()), null, "prefix is never replaced");
  assert.equal(completionSuffix("df -h\r", owner, h.snapshot()), null, "an execution key is never accepted");
});

test("same-text edits, a new prompt, and reconnects invalidate old suggestions", () => {
  const h = harness();
  h.prompt();
  h.tracker.input("ls");
  h.echo("ls");
  const owner = h.snapshot();
  h.tracker.input("\x7f");
  h.tracker.input("s");
  h.echo("ls");
  assert.equal(sameTerminalPrompt(owner, h.snapshot()), false);
  assert.equal(completionSuffix("ls -la", owner, h.snapshot()), null);
  assert.equal(completionSuffix("ls -la", h.snapshot(), h.snapshot("connection-b")), null);
  h.prompt();
  assert.equal(completionSuffix("ls -la", owner, h.snapshot()), null);
  h.tracker.reset();
  assert.equal(h.marker.isDisposed, true);
  assert.equal(h.snapshot().integrated, false);
});

test("execution and password input cannot be treated as shell commands", () => {
  const h = harness();
  h.prompt();
  h.tracker.input("sudo ls");
  h.echo("sudo ls");
  assert.equal(h.tracker.input("\r"), "sudo ls");
  assert.equal(h.snapshot().phase, "running");
  assert.equal(h.tracker.input("secret"), null);
  assert.equal(h.tracker.input("\r"), null);
  assert.equal(h.snapshot().command, null);
  assert.equal(h.snapshot().ready, false);
});

test("alternate buffers, middle-of-line editing and lost markers suspend filling", () => {
  const h = harness();
  h.prompt();
  h.tracker.input("ls");
  h.echo("ls");
  const owner = h.snapshot();
  h.buffer.type = "alternate";
  assert.equal(completionSuffix("ls -la", owner, h.snapshot()), null);
  h.buffer.type = "normal";
  h.lines[0].text = "demo$ ls -l";
  assert.equal(h.snapshot().ready, false, "existing text after the cursor is not overwritten");
  h.echo("ls");
  h.marker.isDisposed = true;
  assert.equal(h.snapshot().ready, false);
});

test("native Tab and cursor keys are untouched and stop speculative input tracking", () => {
  const h = harness();
  h.prompt();
  h.tracker.input("ls");
  h.echo("ls");
  h.tracker.input("\t");
  assert.equal(h.snapshot().command, null);
  h.tracker.input("\x15");
  h.echo("");
  assert.equal(h.snapshot().ready, true, "verified Ctrl+U restores a known empty prompt");
  h.tracker.input("\x1b[A");
  assert.equal(h.snapshot().ready, false);
});

test("single-line bracketed paste is tracked, multiline paste leaves prompt state", () => {
  const h = harness();
  h.prompt();
  h.tracker.input("\x1b[200~ls -la\x1b[201~");
  h.echo("ls -la");
  assert.equal(h.snapshot().ready, true);
  h.tracker.input("\x1b[200~echo one\necho two\x1b[201~");
  assert.equal(h.snapshot().phase, "running");
  assert.equal(h.snapshot().ready, false);
});

test("wrapped command echoes are accepted only across actual wrapped rows", () => {
  const h = harness();
  h.prompt();
  const command = "x".repeat(36);
  h.tracker.input(command);
  h.lines[0].text = "demo$ " + command.slice(0, 34);
  h.lines.push({ text: "xx", isWrapped: true });
  h.buffer.cursorY = 1;
  h.buffer.cursorX = 2;
  assert.equal(h.snapshot().ready, true);
  h.lines[1].isWrapped = false;
  assert.equal(h.snapshot().ready, false);
});

test("local suggestions are prefix-matched, deduplicated, and isolated by host", () => {
  const entry = (command: string, sessionId = "a") => ({ command, sessionId, id: command, sessionName: sessionId, source: "terminal" as const, createdAt: "" });
  const suggestions = historySuggestions([
    entry("git status", "b"), entry("git log"), entry("git log"),
    entry("git"), entry("git -c token=real-secret status"), entry("git show"),
  ], "a", "git");
  assert.deepEqual(suggestions.map((item) => item.command), ["git log", "git show"]);
  assert.deepEqual(historySuggestions([entry("git status")], "a", "g"), []);
});

test("AI suggestions require structured, single-line, prefix-preserving commands", () => {
  const suggestions = parseAiSuggestions(JSON.stringify([
    { command: "du -h", description: "wrong prefix" },
    { command: "df -h", description: "查看磁盘空间，只读" },
    { command: "df -h", description: "duplicate" },
    { command: "df -i\nrm file" },
    { command: "df \x1b[31m" },
    { command: "df --token=real-secret" },
    { command: "df -i", description: "查看 inode" },
  ]), "df ");
  assert.deepEqual(suggestions.map((item) => item.command), ["df -h", "df -i"]);
  assert.equal(parseAiSuggestions("```json\n[{\"command\":\"ls -la\"}]\n```", "")[0].command, "ls -la");
  assert.throws(() => parseAiSuggestions("```sh\nls\n```", ""), /有效/);
  assert.throws(() => parseAiSuggestions("{}", ""), /格式/);
  assert.throws(() => parseAiSuggestions('[{"command":"ls\\r"}]', ""), /没有/);
});

test("oversized commands, line separators and known credentials are rejected", () => {
  assert.equal(safeCompletionCommand("echo " + "你".repeat(1400)), false);
  assert.equal(safeCompletionCommand("echo a\u2028echo b"), false);
  assert.equal(safeCompletionCommand("echo sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(safeCompletionCommand("curl -H \"Authorization: Bearer $TOKEN\" example.com"), true);
  assert.equal(safeCompletionCommand("printf 'hello'"), true);
  assert.ok(SHELL_INTEGRATION_COMMAND.includes("${BASH_VERSION-}"));
  assert.ok(SHELL_INTEGRATION_COMMAND.includes("${ZSH_VERSION-}"));
  assert.ok(!SHELL_INTEGRATION_COMMAND.includes("\n"));
  assert.ok(!SHELL_INTEGRATION_COMMAND.includes("\r"));
});
