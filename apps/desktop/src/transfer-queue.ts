import type { TransferEvent, TransferWaitingReason } from "./types";

const statusOrder: Record<TransferEvent["status"], number> = {
  running: 0,
  queued: 1,
  paused: 2,
  cancelling: 3,
  failed: 4,
  cancelled: 5,
  completed: 6,
};

const waitingReasonLabels: Record<TransferWaitingReason, string> = {
  globalConcurrency: "等待全局并发名额",
  perHostConcurrency: "等待当前主机并发名额",
  queueOrder: "等待前序任务",
  userPaused: "由用户暂停",
};

export function sortTransfersForDisplay(transfers: TransferEvent[]): TransferEvent[] {
  return [...transfers].sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status]
      || left.submissionSequence - right.submissionSequence
      || left.transferId.localeCompare(right.transferId));
}

export function formatTransferWaitingState(transfer: TransferEvent): string | null {
  if (transfer.status === "paused") {
    return waitingReasonLabels.userPaused;
  }
  if (transfer.status !== "queued") return null;

  const position = transfer.queuePosition === null ? null : `队列 #${transfer.queuePosition}`;
  const reason = transfer.waitingReason === null
    ? null
    : waitingReasonLabels[transfer.waitingReason];
  return [position, reason].filter(Boolean).join(" · ") || "等待调度";
}
