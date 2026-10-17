import { Radio } from "lucide-react";
import { version } from "../../package.json";
import "./WorkspaceStatusBar.css";

interface WorkspaceStatusBarProps {
  loading: boolean;
  connection: { name: string; endpoint: string; state: string; label: string; protocol: string } | null;
  openCount: number;
  connectedCount: number;
  broadcastCount: number | null;
  workspace: { name: string; finished: number; total: number; omitted: number } | null;
}

export function WorkspaceStatusBar({ loading, connection, openCount, connectedCount, broadcastCount, workspace }: WorkspaceStatusBarProps) {
  const state = loading ? "connecting" : connection?.state ?? "idle";
  const label = loading ? "加载会话" : connection?.label ?? "就绪";
  const progress = workspace
    ? `正在打开“${workspace.name}” · ${workspace.finished}/${workspace.total}${workspace.omitted ? ` · 跳过 ${workspace.omitted}` : ""}`
    : null;

  return (
    <footer className="workspace-statusbar" aria-label="工作区状态">
      <div className="workspace-status-main">
        <span className="workspace-status-state" data-state={state} role="status">
          <i aria-hidden="true" />{label}
        </span>
        {connection && <span className="workspace-status-target" title={`${connection.name} · ${connection.endpoint}`}>{connection.endpoint}</span>}
        {progress && <span className="workspace-status-progress" role="status" title={progress}>{progress}</span>}
      </div>
      <div className="workspace-status-meta">
        {broadcastCount !== null && <span className="workspace-status-broadcast" title="输入将发送到所有已连接的广播会话"><Radio size={12} />广播 {broadcastCount}</span>}
        {openCount > 0 && <span className="workspace-status-count" title={`已打开 ${openCount} 个标签，其中 ${connectedCount} 个已连接`}>{connectedCount} 已连接<span aria-hidden="true"> / </span>{openCount} 已打开</span>}
        {connection && <span className="workspace-status-protocol">{connection.protocol}</span>}
        <span className="workspace-status-version" aria-label={`XSH 版本 ${version}`}>v{version}</span>
      </div>
    </footer>
  );
}
