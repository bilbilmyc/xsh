import assert from "node:assert/strict";
import test from "node:test";
import { readRecentTerminalOutput } from "../apps/desktop/src/terminal-context.ts";
import { prepareAiText } from "../apps/desktop/src/ai-context.ts";

function createBuffer(lines: string[], cursor = lines.length - 1) {
  return { baseY: 0, cursorY: cursor, length: lines.length, getLine: (index: number) => ({ translateToString: () => lines[index] ?? "" }) };
}

test("recent AI context is limited to the last 50 lines through the cursor", () => {
  const lines = Array.from({ length: 120 }, (_, index) => `output ${index}`);
  const context = readRecentTerminalOutput(createBuffer(lines, 109));
  assert.equal(context.split("\n").length, 50);
  assert.ok(context.startsWith("output 60\n"));
  assert.ok(context.endsWith("output 109"));
  assert.equal(readRecentTerminalOutput(createBuffer(lines), 999).split("\n").length, 50);
});

test("recent context keeps the most recent UTF-8 text within 16 KiB", () => {
  const context = readRecentTerminalOutput(createBuffer(["旧输出", "中文".repeat(12000), "last error"]));
  assert.ok(new TextEncoder().encode(context).length <= 16384);
  assert.ok(context.endsWith("last error"));
  assert.ok(!context.includes("\ufffd"));
  assert.equal(readRecentTerminalOutput(createBuffer([])), "");
});

test("soft wrapped credentials are joined before redaction", () => {
  const lines = ["OPENAI_API_KEY=sk-" + "a".repeat(63), "b".repeat(64), "next output"];
  const buffer = { ...createBuffer(lines), getLine: (index: number) => ({ isWrapped: index === 1, translateToString: () => lines[index] }) };
  const safe = prepareAiText(readRecentTerminalOutput(buffer)).text;
  assert.ok(!safe.includes("a".repeat(63)));
  assert.ok(!safe.includes("b".repeat(64)));
  assert.ok(safe.includes("next output"));
});

test("a window starting inside a soft wrap drops the incomplete logical line", () => {
  const lines = ["API_KEY=sk-original", "secret-continuation", ...Array.from({ length: 49 }, (_, index) => `safe ${index}`)];
  const buffer = { ...createBuffer(lines), getLine: (index: number) => ({ isWrapped: index === 1, translateToString: () => lines[index] }) };
  const recent = readRecentTerminalOutput(buffer);
  assert.ok(!recent.includes("secret-continuation"));
  assert.ok(recent.startsWith("safe 0"));
  const huge = readRecentTerminalOutput(createBuffer(["API_KEY=" + "a".repeat(17000) + "hidden-tail", "last output"]));
  assert.ok(!huge.includes("hidden-tail"));
  assert.ok(huge.endsWith("last output"));
});

test("a window ending inside a soft wrap drops the entire incomplete logical line", () => {
  const lines = ["complete output", "status: sk-abcdef", "ghijklmnopqrstuv"];
  const buffer = { ...createBuffer(lines, 1), getLine: (index: number) => ({ isWrapped: index === 2, translateToString: () => lines[index] }) };
  assert.equal(readRecentTerminalOutput(buffer), "complete output");

  const wrappedLines = ["complete output", "status: sk-abc", "defghi", "jklmnopqrstuv"];
  const wrappedBuffer = { ...createBuffer(wrappedLines, 2), getLine: (index: number) => ({ isWrapped: index >= 2 && index < wrappedLines.length, translateToString: () => wrappedLines[index] }) };
  assert.equal(readRecentTerminalOutput(wrappedBuffer), "complete output");
  assert.equal(readRecentTerminalOutput({ ...buffer, baseY: 0, cursorY: 2 }), lines[0] + "\n" + lines[1] + lines[2]);
});

test("soft wrap reconstruction retains meaningful spaces at the wrap boundary", () => {
  const lines = ["printf hello ", "world"];
  const buffer = { ...createBuffer(lines), getLine: (index: number) => ({ isWrapped: index === 1, translateToString: (trimRight: boolean) => trimRight ? lines[index].trimEnd() : lines[index] }) };
  assert.equal(readRecentTerminalOutput(buffer), "printf hello world");
});
