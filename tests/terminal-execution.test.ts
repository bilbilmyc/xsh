import assert from "node:assert/strict";
import test from "node:test";
import { TerminalExecutionLedger, executionAiContext, mergeTerminalExecutions } from "../apps/desktop/src/terminal-execution.ts";
import { byteLength } from "../apps/desktop/src/ai-context.ts";

function terminal() {
  const lines: Array<{ text: string; wrapped: boolean }> = [{ text: "$ command", wrapped: false }];
  const markers: Array<{ line: number; isDisposed: boolean; dispose(): void }> = [];
  const buffer = {
    type: "normal" as "normal" | "alternate", baseY: 0, cursorY: 0, cursorX: 9,
    getLine(index: number) {
      const line = lines[index];
      return line && { isWrapped: line.wrapped, translateToString(trim = false, start = 0, end?: number) { const result = line.text.slice(start, end); return trim ? result.trimEnd() : result; } };
    },
  };
  const cursor = { buffer, marker() { const marker = { line: buffer.cursorY, isDisposed: false, dispose() { this.isDisposed = true; } }; markers.push(marker); return marker; } };
  const at = (row: number, text: string, wrapped = false) => { lines[row] = { text, wrapped }; buffer.cursorY = row; buffer.cursorX = text.length; };
  return { cursor, at, markers };
}

test("OSC C/D associates only the command output and its real exit code", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("bad-command", "original", "terminal", term.cursor, true, true);
  term.at(1, "");
  ledger.osc("C", term.cursor);
  term.at(1, "command not found");
  term.at(2, "");
  ledger.osc("D;127", term.cursor);
  term.at(2, "$ next prompt");
  ledger.osc("A", term.cursor);
  const [record] = ledger.getSnapshot();
  assert.equal(record.output, "command not found");
  assert.equal(record.exitCode, 127);
  assert.equal(record.status, "finished");
  assert.equal(record.connectionId, "original");
  assert.match(executionAiContext(record)!, /退出码 127/);
  assert.doesNotMatch(record.output!, /next prompt|\$ command/);
});

test("transport delivery and silence never finish an execution", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("sleep 60", "c1", "ai", term.cursor, true, false);
  assert.equal(ledger.getSnapshot()[0].status, "sent");
  assert.equal(executionAiContext(ledger.getSnapshot()[0]), null);
  ledger.osc("C", term.cursor);
  assert.equal(ledger.getSnapshot()[0].status, "running");
  assert.equal(ledger.getSnapshot()[0].exitCode, null);
});

test("prompt-only fallback uses verified echo but reports unknown exit code", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("command", "c1", "terminal", term.cursor, true, true);
  term.at(1, "actual output");
  term.at(2, "");
  ledger.osc("A", term.cursor);
  assert.equal(ledger.getSnapshot()[0].output, "actual output");
  assert.equal(ledger.getSnapshot()[0].boundary, "prompt");
  assert.equal(ledger.getSnapshot()[0].exitCode, null);
});

test("multiline or unverified sends never invent a reliable output scope", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("one\rtwo\r", "c1", "ai", term.cursor, true, false);
  ledger.sent("unknown", "c1", "command", term.cursor, false, false);
  ledger.osc("C", term.cursor);
  term.at(1, "unrelated");
  ledger.osc("D;0", term.cursor);
  assert.ok(ledger.getSnapshot().every((record) => record.status === "unknown" && record.output === null && record.exitCode === null));
});

test("disconnect and send failure preserve uncertainty, never success", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("one", "old", "terminal", term.cursor, true, true);
  term.at(1, "partial");
  ledger.disconnected(term.cursor.buffer);
  assert.equal(ledger.getSnapshot()[0].status, "interrupted");
  assert.equal(executionAiContext(ledger.getSnapshot()[0]), null);
  const id = ledger.sent("two", "new", "ai", term.cursor, true, false);
  ledger.failed(id);
  ledger.osc("D;0", term.cursor);
  assert.equal(ledger.getSnapshot()[0].status, "send-failed");
  assert.equal(ledger.getSnapshot()[0].exitCode, null);
});

test("wrapped credentials are redacted after reconstructing logical output lines", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("env", "c1", "terminal", term.cursor, true, true);
  term.at(1, "");
  ledger.osc("C", term.cursor);
  term.at(1, "TOKEN=fixture-");
  term.at(2, "secret-value", true);
  term.at(3, "");
  ledger.osc("D;0", term.cursor);
  assert.equal(ledger.getSnapshot()[0].output, "TOKEN=[已隐藏]");
});

test("lost scrollback markers and alternate screen buffers do not produce guessed output", () => {
  for (const alternate of [false, true]) {
    const term = terminal();
    const ledger = new TerminalExecutionLedger();
    ledger.sent("command", "c1", "terminal", term.cursor, true, true);
    if (alternate) term.cursor.buffer.type = "alternate";
    else term.markers[0].isDisposed = true;
    ledger.osc("D;0", term.cursor);
    assert.equal(ledger.getSnapshot()[0].output, null);
    assert.equal(ledger.getSnapshot()[0].truncated, true);
  }
});

test("a size limit discards incomplete wrapped credentials before redaction", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("env", "c1", "terminal", term.cursor, true, true);
  term.at(1, "");
  ledger.osc("C", term.cursor);
  term.at(1, "TOKEN=" + "private".repeat(10));
  for (let row = 2; row < 300; row += 1) term.at(row, "private".repeat(12), true);
  term.at(300, "public final result");
  term.at(301, "");
  ledger.osc("D;0", term.cursor);
  assert.equal(ledger.getSnapshot()[0].truncated, true);
  assert.equal(ledger.getSnapshot()[0].output, "public final result");
});

test("malformed exit statuses remain unknown and duplicate C does not discard output", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("command", "c1", "terminal", term.cursor, true, true);
  term.at(1, "");
  ledger.osc("C", term.cursor);
  term.at(1, "first");
  ledger.osc("C", term.cursor);
  ledger.osc("D;999", term.cursor);
  assert.equal(ledger.getSnapshot()[0].output, "first");
  assert.equal(ledger.getSnapshot()[0].exitCode, null);
});

test("reconnect merges retain old records by ID while bounding record and output memory", () => {
  const term = terminal();
  const first = new TerminalExecutionLedger();
  first.sent("old", "old-connection", "terminal", term.cursor, true, true);
  first.disconnected(term.cursor.buffer);
  const second = new TerminalExecutionLedger();
  for (let index = 0; index < 50; index += 1) {
    second.sent(`command ${index}`, "new-connection", "terminal", term.cursor, true, true);
    term.at(0, "");
    second.osc("C", term.cursor);
    term.at(0, "x".repeat(10000));
    second.osc("D;0", term.cursor);
  }
  const records = mergeTerminalExecutions(first.getSnapshot(), second.getSnapshot());
  assert.equal(records.length, 40);
  assert.ok(records.reduce((bytes, record) => bytes + byteLength(record.output ?? ""), 0) <= 256 * 1024);
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
});

test("a remounted terminal cannot revive old running records, while live sidebar merges preserve them", () => {
  const term = terminal();
  const ledger = new TerminalExecutionLedger();
  ledger.sent("sleep 60", "old-connection", "terminal", term.cursor, true, true);
  ledger.osc("C", term.cursor);
  const records = ledger.getSnapshot();
  assert.equal(mergeTerminalExecutions([], records)[0].status, "running");
  const remounted = new TerminalExecutionLedger(records);
  assert.equal(remounted.getSnapshot()[0].status, "interrupted");
  assert.equal(remounted.getSnapshot()[0].connectionId, "old-connection");
  assert.equal(remounted.getSnapshot()[0].exitCode, null);
});
