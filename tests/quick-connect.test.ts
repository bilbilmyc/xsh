import assert from "node:assert/strict";
import test from "node:test";
import { parseQuickConnectAddress } from "../apps/desktop/src/quick-connect.ts";

test("quick connect accepts hostnames, SSH users, ports and IPv6", () => {
  assert.deepEqual(parseQuickConnectAddress("server"), { host: "server", port: 22, username: "" });
  assert.deepEqual(parseQuickConnectAddress("ssh://demo@example.com:2222"), { host: "example.com", port: 2222, username: "demo" });
  assert.deepEqual(parseQuickConnectAddress("demo@[::1]:2222"), { host: "::1", port: 2222, username: "demo" });
  assert.deepEqual(parseQuickConnectAddress("::1"), { host: "::1", port: 22, username: "" });
  assert.deepEqual(parseQuickConnectAddress("user@例子.测试"), { host: "xn--fsqu00a.xn--0zwm56d", port: 22, username: "user" });
});

test("quick connect rejects embedded secrets, shell-like inputs and invalid endpoints", () => {
  for (const address of ["demo:secret@example.com", "https://example.com", "example.com/path", "example.com?token=value", "host:0", "host:65536", "ssh -p 22 host", "demo%0A@example.com", "-proxy", "old%40new.example", "host%2Fpath", "host%23hash", "host%3A2222", "host%255cpath", "host%5cpath"]) {
    assert.throws(() => parseQuickConnectAddress(address), undefined, address);
  }
});
