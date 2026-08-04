import type { HostKeyApproval, SftpConnectResponse, Uuid } from "./types";

export async function connectSftpWithHostKeyApprovals(
  connect: () => Promise<SftpConnectResponse>,
  approve: (challenge: HostKeyApproval) => Promise<boolean>,
): Promise<Uuid | null> {
  while (true) {
    const result = await connect();
    if (result.status === "connected") return result.connectionId;
    if (!await approve(result.challenge)) return null;
  }
}
