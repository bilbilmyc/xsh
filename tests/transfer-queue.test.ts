import assert from "node:assert/strict";
import test from "node:test";
import { localParentDirectory, matchesTransferFilter, matchesTransferScope, transferFilterCounts, transferPercent } from "../apps/desktop/src/transfer-queue.ts";
import type { TransferEvent } from "../apps/desktop/src/types.ts";

function transfer(status: TransferEvent["status"], totalBytes: number | null = null, transferredBytes = 0): TransferEvent {
  return { transferId: status, connectionId: "connection", endpoint: "example.com:22", direction: "download", localPath: "/tmp/file.txt", remotePath: "/srv/file.txt", status, transferredBytes, totalBytes, speedBytesPerSecond: null, error: null, submissionSequence: 1, queuePosition: null, waitingReason: null };
}

test("transfer scopes preserve actual batch identity across retries and combine host with direction", () => {
  const original = { ...transfer("failed"), batchId: "batch-1" };
  const retried = { ...original, transferId: "retry", retryOf: original.transferId, status: "queued" as const };
  const scope = { batchId: "batch-1", direction: "download" as const, endpoint: "example.com:22" };
  assert.ok(matchesTransferScope(original, scope));
  assert.ok(matchesTransferScope(retried, scope));
  assert.ok(!matchesTransferScope({ ...retried, batchId: "batch-2" }, scope));
  assert.ok(!matchesTransferScope({ ...retried, endpoint: "other.example.com:22" }, scope));
  assert.ok(!matchesTransferScope({ ...retried, direction: "upload" }, scope));
  assert.ok(matchesTransferScope(transfer("running"), { direction: "all", endpoint: "", batchId: "unbatched" }));
});

test("unknown sizes are indeterminate while completed empty downloads are fully complete", () => {
  assert.equal(transferPercent(transfer("queued")), null);
  assert.equal(transferPercent(transfer("running", null, 1024)), null);
  assert.equal(transferPercent(transfer("completed", 0, 0)), 100);
  assert.equal(transferPercent(transfer("running", 100, 42)), 42);
  assert.equal(transferPercent(transfer("running", 100, 150)), 100);
  assert.equal(transferPercent(transfer("running", 100, -10)), 0);
});

test("transfer filters account for every lifecycle state without treating failed tasks as finished successes", () => {
  const transfers = (["queued", "running", "paused", "cancelling", "completed", "cancelled", "failed"] as const).map((status) => transfer(status));
  assert.deepEqual(transferFilterCounts(transfers), { all: 7, active: 4, failed: 1, finished: 2 });
  assert.deepEqual(transfers.filter((item) => matchesTransferFilter(item, "failed")).map((item) => item.status), ["failed"]);
  assert.deepEqual(transferFilterCounts([]), { all: 0, active: 0, failed: 0, finished: 0 });
});

test("opening a completed download uses its containing directory on macOS and Windows", () => {
  assert.equal(localParentDirectory("/Users/user/Downloads/file.txt"), "/Users/user/Downloads");
  assert.equal(localParentDirectory("/file.txt"), "/");
  assert.equal(localParentDirectory(String.raw`C:\Users\user\Downloads\file.txt`), String.raw`C:\Users\user\Downloads`);
  assert.equal(localParentDirectory("C:\\file.txt"), "C:\\");
  assert.equal(localParentDirectory("C:/file.txt"), "C:/");
  assert.equal(localParentDirectory(String.raw`\\server\share\file.txt`), String.raw`\\server\share`);
  assert.equal(localParentDirectory("file.txt"), ".");
});
