import assert from "node:assert/strict";
import test from "node:test";
import {
  indexTransfersForConnection,
  isActiveTransferStatus,
  isTransferOwnedByConnection,
} from "../apps/desktop/src/sftp-transfer-scope.ts";
import type { TransferEvent } from "../apps/desktop/src/types.ts";

function transfer(transferId: string, connectionId: string): TransferEvent {
  return {
    transferId,
    connectionId,
    endpoint: "files.example.com:22",
    direction: "upload",
    localPath: `C:/tmp/${transferId}`,
    remotePath: `/tmp/${transferId}`,
    status: "queued",
    transferredBytes: 0,
    totalBytes: 1024,
    speedBytesPerSecond: null,
    error: null,
  };
}

test("indexes only transfers owned by the active SFTP connection", () => {
  const own = transfer("transfer-own", "connection-a");
  const foreign = transfer("transfer-foreign", "connection-b");

  assert.deepEqual(indexTransfersForConnection([foreign, own], "connection-a"), {
    "transfer-own": own,
  });
  assert.deepEqual(indexTransfersForConnection([own], null), {});
});

test("rejects stale or foreign transfer controls", () => {
  const own = transfer("transfer-own", "connection-a");

  assert.equal(isTransferOwnedByConnection(own, "connection-a"), true);
  assert.equal(isTransferOwnedByConnection(own, "connection-b"), false);
  assert.equal(isTransferOwnedByConnection(own, null), false);
});

test("keeps cancellation requests active until the worker acknowledges them", () => {
  assert.equal(isActiveTransferStatus("cancelling"), true);
  assert.equal(isActiveTransferStatus("cancelled"), false);
});
