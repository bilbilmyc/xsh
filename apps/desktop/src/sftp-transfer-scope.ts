import type { TransferEvent, Uuid } from "./types";

export function isActiveTransferStatus(status: TransferEvent["status"]): boolean {
  return status === "queued"
    || status === "running"
    || status === "paused"
    || status === "cancelling";
}

export function isTransferOwnedByConnection(
  transfer: TransferEvent,
  connectionId: Uuid | null,
): connectionId is Uuid {
  return connectionId !== null && transfer.connectionId === connectionId;
}

export function indexTransfersForConnection(
  transfers: TransferEvent[],
  connectionId: Uuid | null,
): Record<Uuid, TransferEvent> {
  if (!connectionId) return {};
  return Object.fromEntries(
    transfers
      .filter((transfer) => isTransferOwnedByConnection(transfer, connectionId))
      .map((transfer) => [transfer.transferId, transfer]),
  );
}
