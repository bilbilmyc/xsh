export interface SessionActivitySummary {
  openTabs: number;
  connected: number;
  connecting: number;
  reconnecting: number;
  waitingNetwork: number;
  failed: number;
  disconnected: number;
}

export type SessionActivityState = "idle" | "connected" | "connecting" | "reconnecting" | "waiting-network" | "failed" | "disconnected";

export const SESSION_ACTIVITY_LABELS: Record<SessionActivityState, string> = {
  idle: "未连接",
  connected: "已连接",
  connecting: "连接中",
  reconnecting: "重连中",
  "waiting-network": "等待网络",
  failed: "连接失败",
  disconnected: "已断开",
};

export function primaryActivityState(activity?: SessionActivitySummary): SessionActivityState {
  if (!activity) return "idle";
  if (activity.connected > 0) return "connected";
  if (activity.waitingNetwork > 0) return "waiting-network";
  if (activity.reconnecting > 0) return "reconnecting";
  if (activity.connecting > 0) return "connecting";
  if (activity.failed > 0) return "failed";
  if (activity.disconnected > 0) return "disconnected";
  return "idle";
}

export function formatActivitySummary(activity?: SessionActivitySummary): string {
  if (!activity || activity.openTabs === 0) return SESSION_ACTIVITY_LABELS[primaryActivityState(activity)];
  const parts = [`${activity.openTabs} 个标签`];
  if (activity.connected > 0) parts.push(`${activity.connected} 个已连接`);
  if (activity.connecting > 0) parts.push(`${activity.connecting} 个连接中`);
  if (activity.reconnecting > 0) parts.push(`${activity.reconnecting} 个重连中`);
  if (activity.waitingNetwork > 0) parts.push(`${activity.waitingNetwork} 个等待网络`);
  if (activity.failed > 0) parts.push(`${activity.failed} 个失败`);
  if (activity.disconnected > 0) parts.push(`${activity.disconnected} 个已断开`);
  return parts.join("，");
}
