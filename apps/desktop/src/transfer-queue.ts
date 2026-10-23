import type { TransferEvent, TransferWaitingReason } from "./types";
import { isActiveTransferStatus } from "./sftp-transfer-scope.ts";

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

export type TransferFilter = "all" | "active" | "failed" | "finished";
export interface TransferScope {
  direction: "all" | TransferEvent["direction"];
  endpoint: string;
  batchId: string;
}
export function matchesTransferScope(transfer: TransferEvent, scope: TransferScope): boolean {
  return (scope.direction === "all" || transfer.direction === scope.direction)
    && (!scope.endpoint || transfer.endpoint === scope.endpoint)
    && (!scope.batchId || (scope.batchId === "unbatched" ? !transfer.batchId : transfer.batchId === scope.batchId));
}

export function matchesTransferFilter(transfer: TransferEvent, filter: TransferFilter): boolean {
  if (filter === "active") return isActiveTransferStatus(transfer.status);
  if (filter === "failed") return transfer.status === "failed";
  if (filter === "finished") return transfer.status === "completed" || transfer.status === "cancelled";
  return true;
}

export function transferFilterCounts(transfers: TransferEvent[]): Record<TransferFilter, number> {
  return {
    all: transfers.length,
    active: transfers.filter((transfer) => matchesTransferFilter(transfer, "active")).length,
    failed: transfers.filter((transfer) => matchesTransferFilter(transfer, "failed")).length,
    finished: transfers.filter((transfer) => matchesTransferFilter(transfer, "finished")).length,
  };
}

export function transferPercent(transfer: TransferEvent): number | null {
  if (transfer.status === "completed") return 100;
  if (!transfer.totalBytes || transfer.totalBytes < 0) return null;
  return Math.max(0, Math.min(100, Math.round(transfer.transferredBytes / transfer.totalBytes * 100)));
}

export function localParentDirectory(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separatorIndex < 0) return ".";
  if (separatorIndex === 0) return path[0];
  if (separatorIndex === 2 && /^[a-z]:/i.test(path)) return path.slice(0, 3);
  return path.slice(0, separatorIndex);
}

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

/**
 * Transfer progress events fire many times per second; routing them through
 * component state re-renders the whole SFTP panel (including the remote
 * directory listing). Panels instead keep transfers in this store and render
 * them from a small subscriber via `useSyncExternalStore`, so progress only
 * re-renders the transfer list itself.
 */
export class SftpTransferStore {
  private record: Readonly<Record<string, TransferEvent>> = {};
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): Readonly<Record<string, TransferEvent>> => this.record;

  get(transferId: string): TransferEvent | undefined {
    return this.record[transferId];
  }

  list(): TransferEvent[] {
    return Object.values(this.record);
  }

  upsert(event: TransferEvent): void {
    this.record = { ...this.record, [event.transferId]: event };
    this.emit();
  }

  upsertAll(events: Iterable<TransferEvent>): void {
    const next = { ...this.record };
    for (const event of events) next[event.transferId] = event;
    this.record = next;
    this.emit();
  }

  remove(transferId: string): void {
    if (!(transferId in this.record)) return;
    const next = { ...this.record };
    delete next[transferId];
    this.record = next;
    this.emit();
  }

  retainActiveOnly(): void {
    const next = Object.fromEntries(
      Object.entries(this.record).filter(([, transfer]) => isActiveTransferStatus(transfer.status)),
    );
    this.record = next;
    this.emit();
  }

  replaceAll(record: Record<string, TransferEvent>): void {
    this.record = record;
    this.emit();
  }

  reset(): void {
    this.record = {};
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
