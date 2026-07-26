import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  loadCommandHistory,
  recordCommandHistory,
  saveCommandHistory,
  type CommandHistoryEntry,
} from "../apps/desktop/src/command-history.ts";

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function entry(command: string): CommandHistoryEntry {
  return {
    id: `id-${command}`,
    sessionId: "session-1",
    sessionName: "demo",
    command,
    source: "terminal",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

test("does not persist high-confidence secrets in command history", () => {
  const storage = createStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;

  const result = recordCommandHistory([], {
    sessionId: "session-1",
    sessionName: "demo",
    command: "curl -H 'Authorization: Bearer live-secret-value' https://example.com",
    source: "terminal",
  });

  assert.deepEqual(result, []);
  assert.equal(storage.getItem("xsh.command-history.v1"), null);
});

test("keeps variable references in command history", () => {
  const storage = createStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;

  const result = recordCommandHistory([], {
    sessionId: "session-1",
    sessionName: "demo",
    command: "curl -H 'Authorization: Bearer $TOKEN' https://example.com",
    source: "terminal",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.command, "curl -H 'Authorization: Bearer $TOKEN' https://example.com");
});

test("cleans sensitive entries already stored in localStorage", () => {
  const stored = [entry("echo safe"), entry("mysql -pactual-secret database")];
  (globalThis as { localStorage?: unknown }).localStorage = createStorage({
    "xsh.command-history.v1": JSON.stringify(stored),
  });

  assert.deepEqual(loadCommandHistory().map((item) => item.command), ["echo safe"]);
});

test("filters sensitive entries when saving a history list", () => {
  const storage = createStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;

  saveCommandHistory([entry("echo safe"), entry("password=actual-secret")]);

  assert.deepEqual(
    JSON.parse(storage.getItem("xsh.command-history.v1") ?? "[]").map((item: { command: string }) => item.command),
    ["echo safe"],
  );
});
