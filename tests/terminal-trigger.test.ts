import assert from "node:assert/strict";
import test from "node:test";
import { TerminalTriggerMatcher, matchesTerminalShortcut } from "../apps/desktop/src/terminal-trigger.ts";
import { decodeTerminalKeyMapping, normalizeTerminalCommand } from "../apps/desktop/src/terminal-command.ts";
import type { TerminalTrigger } from "../apps/desktop/src/types.ts";

const trigger = (overrides: Partial<TerminalTrigger> = {}): TerminalTrigger => ({
  id: "trigger-1",
  label: "Failure",
  pattern: "FAILED",
  matchMode: "keyword",
  caseSensitive: false,
  cooldownSeconds: 30,
  enabled: true,
  ...overrides,
});

test("matches terminal trigger text across output chunks and strips ANSI sequences", () => {
  const matcher = new TerminalTriggerMatcher();
  assert.deepEqual(matcher.match("build fa", [trigger()], 1_000), []);
  const matches = matcher.match("\u001b[31miled\u001b[0m", [trigger()], 2_000);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchedText.toLowerCase(), "failed");
});

test("supports regex triggers and applies each trigger cooldown", () => {
  const matcher = new TerminalTriggerMatcher();
  const regex = trigger({ matchMode: "regex", pattern: "error\\s+\\d+", cooldownSeconds: 5 });
  assert.equal(matcher.match("Error 42", [regex], 1_000).length, 1);
  assert.equal(matcher.match("Error 43", [regex], 5_999).length, 0);
  assert.equal(matcher.match("Error 44", [regex], 6_000).length, 1);
});

test("does not re-alert from stale output after its cooldown expires", () => {
  const matcher = new TerminalTriggerMatcher();
  const failure = trigger({ cooldownSeconds: 1 });
  assert.equal(matcher.match("FAILED", [failure], 1_000).length, 1);
  assert.equal(matcher.match(" next output", [failure], 2_000).length, 0);
});

test("matches F keys and normalized modifier combinations", () => {
  assert.equal(matchesTerminalShortcut({ key: "F5", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent, "F5"), true);
  assert.equal(matchesTerminalShortcut({ key: "K", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false } as KeyboardEvent, "Ctrl + Alt + k"), true);
  assert.equal(matchesTerminalShortcut({ key: "K", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent, "Ctrl+Alt+K"), false);
});

test("decodes readable one-backslash terminal escapes", () => {
  assert.equal(decodeTerminalKeyMapping("\\e[15~"), "\u001b[15~");
  assert.equal(normalizeTerminalCommand("show\\tstatus"), "show\tstatus\r");
});
