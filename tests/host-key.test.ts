import assert from "node:assert/strict";
import test from "node:test";
import {
  hostKeyConfirmationMessage,
  hostKeyEndpointLabel,
} from "../apps/desktop/src/host-key.ts";
import type { HostKeyApproval } from "../apps/desktop/src/types.ts";

const proxyChallenge: HostKeyApproval = {
  role: "proxyJump",
  host: "jump.example.com",
  port: 2222,
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:proxy-key",
  publicKey: "ssh-ed25519 AAAA-proxy",
};

test("host key prompt identifies the exact proxy endpoint and fingerprint", () => {
  const message = hostKeyConfirmationMessage(proxyChallenge, "SFTP");

  assert.equal(hostKeyEndpointLabel(proxyChallenge), "ProxyJump");
  assert.match(message, /^SFTP ProxyJump/);
  assert.match(message, /jump\.example\.com:2222/);
  assert.match(message, /ssh-ed25519/);
  assert.match(message, /SHA256:proxy-key/);
});

test("target and proxy challenges cannot share an endpoint label", () => {
  const targetChallenge: HostKeyApproval = {
    ...proxyChallenge,
    role: "target",
    host: "target.example.com",
    port: 22,
  };

  assert.equal(hostKeyEndpointLabel(targetChallenge), "目标服务器");
  assert.notEqual(
    hostKeyConfirmationMessage(targetChallenge, "SSH"),
    hostKeyConfirmationMessage(proxyChallenge, "SSH"),
  );
});
