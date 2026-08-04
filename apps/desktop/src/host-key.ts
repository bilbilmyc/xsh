import type { HostKeyApproval } from "./types";

export function hostKeyEndpointLabel(approval: HostKeyApproval): string {
  return approval.role === "proxyJump" ? "ProxyJump" : "目标服务器";
}

export function hostKeyConfirmationMessage(
  approval: HostKeyApproval,
  protocol: "SSH" | "SFTP",
): string {
  const prefix = protocol === "SFTP" ? "SFTP " : "";
  return `${prefix}${hostKeyEndpointLabel(approval)}首次连接 ${approval.host}:${approval.port}\n\n${approval.keyType}\n${approval.fingerprint}\n\n是否信任并保存此服务器密钥？`;
}
