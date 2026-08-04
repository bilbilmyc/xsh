import assert from "node:assert/strict";
import test from "node:test";
import { connectSftpWithHostKeyApprovals } from "../apps/desktop/src/sftp-connection.ts";
import type { HostKeyApproval, SftpConnectResponse } from "../apps/desktop/src/types.ts";

const challenge = (
  role: HostKeyApproval["role"],
  host: string,
): HostKeyApproval => ({
  role,
  host,
  port: 22,
  keyType: "ssh-ed25519",
  fingerprint: `SHA256:${host}`,
  publicKey: `ssh-ed25519 ${host}`,
});

test("connects after independently approving proxy and target host keys", async () => {
  const responses: SftpConnectResponse[] = [
    { status: "hostKeyUnknown", challenge: challenge("proxyJump", "jump.example.com") },
    { status: "hostKeyUnknown", challenge: challenge("target", "target.example.com") },
    { status: "connected", connectionId: "connection-id" },
  ];
  const approvals: HostKeyApproval[] = [];
  let connectCalls = 0;

  const connectionId = await connectSftpWithHostKeyApprovals(
    async () => responses[connectCalls++],
    async (value) => {
      approvals.push(value);
      return true;
    },
  );

  assert.equal(connectionId, "connection-id");
  assert.equal(connectCalls, 3);
  assert.deepEqual(approvals.map((value) => value.role), ["proxyJump", "target"]);
});

test("does not reconnect when host key persistence fails", async () => {
  let connectCalls = 0;
  const persistenceError = new Error("known_hosts is read-only");

  await assert.rejects(
    connectSftpWithHostKeyApprovals(
      async () => {
        connectCalls += 1;
        return {
          status: "hostKeyUnknown",
          challenge: challenge("target", "target.example.com"),
        };
      },
      async () => { throw persistenceError; },
    ),
    persistenceError,
  );
  assert.equal(connectCalls, 1);
});
