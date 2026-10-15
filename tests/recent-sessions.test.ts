import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { loadRecentSessions, loadRecentlyOpenedSessions, pruneRecentSessions, recordRecentSession } from "../apps/desktop/src/recent-sessions.ts";

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  return storage;
}

test("keeps successful connections separate from legacy open attempts", () => {
  createStorage({ "xsh.session-sidebar.recent.v1": JSON.stringify({ opened: Date.parse("2026-10-15T12:00:00Z") }) });
  assert.deepEqual(loadRecentSessions(), []);
  assert.deepEqual(loadRecentlyOpenedSessions(), [{ sessionId: "opened", lastConnectedAt: "2026-10-15T12:00:00.000Z" }]);
  recordRecentSession("connected", "2026-10-15T13:00:00Z");
  assert.deepEqual(loadRecentSessions().map((item) => item.sessionId), ["connected"]);
});

test("filters corrupted records and orders unique sessions by actual time", () => {
  createStorage({
    "xsh.recent-sessions.v1": JSON.stringify([
      { sessionId: "older", lastConnectedAt: "2026-10-15T15:00:00+08:00" },
      { sessionId: "newer", lastConnectedAt: "2026-10-15T09:00:00Z" },
      { sessionId: "newer", lastConnectedAt: "2026-10-15T08:00:00Z" },
      { sessionId: "invalid", lastConnectedAt: "not-a-date" },
      { sessionId: "", lastConnectedAt: "2026-10-15T10:00:00Z" },
      null,
    ]),
    "xsh.session-sidebar.recent.v1": JSON.stringify({ valid: 1, invalid: -1, string: "1", tooLarge: 1e30 }),
  });
  assert.deepEqual(loadRecentSessions().map((item) => item.sessionId), ["newer", "older"]);
  assert.deepEqual(loadRecentlyOpenedSessions().map((item) => item.sessionId), ["valid"]);
});

test("prunes deleted sessions and bounds successful history", () => {
  createStorage();
  for (let index = 0; index < 15; index += 1) {
    recordRecentSession(`session-${index}`, new Date(1000 * (index + 1)).toISOString());
  }
  assert.equal(loadRecentSessions().length, 12);
  assert.deepEqual(pruneRecentSessions(["session-14", "session-13"]).map((item) => item.sessionId), ["session-14", "session-13"]);
});

test("unavailable history storage cannot fail a connection", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => { throw new Error("storage blocked"); },
    setItem: () => { throw new Error("storage blocked"); },
  };
  assert.deepEqual(loadRecentSessions(), []);
  assert.deepEqual(loadRecentlyOpenedSessions(), []);
  assert.equal(recordRecentSession("connected").length, 1);
});
