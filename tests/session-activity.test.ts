import assert from "node:assert/strict";
import test from "node:test";
import { formatActivitySummary, primaryActivityState, type SessionActivitySummary } from "../apps/desktop/src/session-activity.ts";

const emptyActivity: SessionActivitySummary = {
  openTabs: 0,
  connected: 0,
  connecting: 0,
  reconnecting: 0,
  waitingNetwork: 0,
  failed: 0,
  disconnected: 0,
};

test("saved sessions without active tabs stay unconnected", () => {
  assert.equal(primaryActivityState(), "idle");
  assert.equal(primaryActivityState(emptyActivity), "idle");
  assert.equal(formatActivitySummary(), "未连接");
});

test("an open disconnected tab is distinct from a failed connection", () => {
  assert.equal(primaryActivityState({ ...emptyActivity, openTabs: 1, disconnected: 1 }), "disconnected");
  assert.equal(primaryActivityState({ ...emptyActivity, openTabs: 1, failed: 1 }), "failed");
});

test("one connected tab keeps a multi-tab saved session connected while reporting failures", () => {
  const activity = { ...emptyActivity, openTabs: 3, connected: 1, connecting: 1, failed: 1 };
  assert.equal(primaryActivityState(activity), "connected");
  assert.equal(formatActivitySummary(activity), "3 个标签，1 个已连接，1 个连接中，1 个失败");
});

test("recovery states remain visible when no tab is connected", () => {
  assert.equal(primaryActivityState({ ...emptyActivity, openTabs: 1, connecting: 1 }), "connecting");
  assert.equal(primaryActivityState({ ...emptyActivity, openTabs: 1, reconnecting: 1 }), "reconnecting");
  assert.equal(primaryActivityState({ ...emptyActivity, openTabs: 1, waitingNetwork: 1 }), "waiting-network");
});
