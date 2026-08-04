import assert from "node:assert/strict";
import test from "node:test";
import { rollbackUncommittedCredentials } from "../apps/desktop/src/credential-lifecycle.ts";

test("rolls back credentials when session persistence fails", async () => {
  const deleted: string[] = [];

  await rollbackUncommittedCredentials(false, ["primary", "proxy"], async (credentialRef) => {
    deleted.push(credentialRef);
  });

  assert.deepEqual(deleted, ["primary", "proxy"]);
});

test("does not roll back credentials after the session is persisted", async () => {
  const deleted: string[] = [];

  await rollbackUncommittedCredentials(true, ["persisted"], async (credentialRef) => {
    deleted.push(credentialRef);
  });

  assert.deepEqual(deleted, []);
});

test("best-effort rollback continues when one credential deletion fails", async () => {
  const deleted: string[] = [];

  await rollbackUncommittedCredentials(false, ["first", "second"], async (credentialRef) => {
    deleted.push(credentialRef);
    if (credentialRef === "first") throw new Error("delete failed");
  });

  assert.deepEqual(deleted, ["first", "second"]);
});
