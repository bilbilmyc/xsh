import assert from "node:assert/strict";
import test from "node:test";
import {
  indexTransfersForConnection,
  isActiveTransferStatus,
  isTransferOwnedByConnection,
} from "../apps/desktop/src/sftp-transfer-scope.ts";
import {
  formatTransferWaitingState,
  sortTransfersForDisplay,
} from "../apps/desktop/src/transfer-queue.ts";
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
    submissionSequence: Number(transferId.replace(/\D/g, "")) || 0,
    queuePosition: null,
    waitingReason: null,
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

test("orders transfer groups predictably and preserves submission order within a group", () => {
  const queuedLater = { ...transfer("transfer-3", "connection-a"), submissionSequence: 3 };
  const queuedEarlier = { ...transfer("transfer-1", "connection-a"), submissionSequence: 1 };
  const running = {
    ...transfer("transfer-2", "connection-a"),
    status: "running" as const,
    submissionSequence: 2,
  };

  assert.deepEqual(
    sortTransfersForDisplay([queuedLater, queuedEarlier, running]).map((item) => item.transferId),
    ["transfer-2", "transfer-1", "transfer-3"],
  );
});

test("distinguishes backend queue positions from local submission and pause states", () => {
  const queued = {
    ...transfer("transfer-1", "connection-a"),
    queuePosition: 3,
    waitingReason: "perHostConcurrency" as const,
  };
  const paused = {
    ...transfer("transfer-2", "connection-a"),
    status: "paused" as const,
    waitingReason: "userPaused" as const,
  };

  assert.equal(formatTransferWaitingState(queued), "队列 #3 · 等待当前主机并发名额");
  assert.equal(formatTransferWaitingState(paused), "由用户暂停");
});
