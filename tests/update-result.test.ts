import assert from "node:assert/strict";
import test from "node:test";
import { consumeUpdateResult, rememberUpdateTarget } from "../apps/desktop/src/update-result.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("only a running target version reports update success, once", () => {
  const state = storage();
  assert.equal(consumeUpdateResult(state, "0.2.3"), null);
  rememberUpdateTarget(state, "0.2.4");
  assert.equal(consumeUpdateResult(state, "0.2.4"), "XSH 已更新至 v0.2.4。");
  assert.equal(consumeUpdateResult(state, "0.2.4"), null);
});

test("cancelled or failed installation never reports success on reopening the old version", () => {
  const state = storage();
  rememberUpdateTarget(state, "0.2.4");
  assert.match(consumeUpdateResult(state, "0.2.3")!, /未确认完成.*0\.2\.3/);
  assert.equal(consumeUpdateResult(state, "0.2.3"), null);
});

test("a launch failure clears the pending result and unavailable storage is tolerated", () => {
  const state = storage();
  rememberUpdateTarget(state, "0.2.4");
  rememberUpdateTarget(state, null);
  assert.equal(consumeUpdateResult(state, "0.2.4"), null);
  const fail = () => { throw new Error("storage unavailable"); };
  const unavailable = { getItem: fail, setItem: fail, removeItem: fail };
  assert.doesNotThrow(() => rememberUpdateTarget(unavailable, "0.2.4"));
  assert.equal(consumeUpdateResult(unavailable, "0.2.4"), null);
});
