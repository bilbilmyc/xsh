import { Activity, LocateFixed, Lock, RefreshCw, Trash2, X } from "lucide-react";

export interface ConnectionManagerItem {
  id: string;
  name: string;
  state: string;
  locked: boolean;
  focused: boolean;
}

interface ConnectionManagerModalProps {
  items: ConnectionManagerItem[];
  onFocus: (tabId: string) => void;
  onReconnect: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReconnectDisconnected: () => void;
  onCloseDisconnected: () => void;
  onClose: () => void;
}

const disconnectedStates = new Set(["disconnected", "failed"]);

function stateLabel(state: string): string {
  switch (state) {
    case "connected": return "已连接";
    case "queued": return "等待连接资源";
    case "connecting": return "连接中";
    case "reconnecting": return "重连中";
    case "waiting-network": return "等待网络";
    case "authenticating": return "认证中";
    case "awaitingHostKey": return "等待密钥确认";
    case "disconnecting": return "断开中";
    case "disconnected": return "已断开";
    case "failed": return "连接失败";
    default: return state || "未知状态";
  }
}

export function ConnectionManagerModal({
  items,
  onFocus,
  onReconnect,
  onCloseTab,
  onReconnectDisconnected,
  onCloseDisconnected,
  onClose,
}: ConnectionManagerModalProps) {
  const connectedCount = items.filter((item) => item.state === "connected").length;
  const disconnectedCount = items.filter((item) => disconnectedStates.has(item.state)).length;

  return (
    <div className="modal-backdrop connection-manager-backdrop" onMouseDown={onClose}>
      <section className="connection-manager-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Activity size={18} /></span>
            <div>
              <h2>活动连接</h2>
              <p>{items.length} 个标签 · {connectedCount} 个已连接</p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭活动连接"><X size={18} /></button>
        </header>

        <div className="connection-manager-actions">
          <button className="secondary-button" disabled={disconnectedCount === 0} onClick={onReconnectDisconnected}>
            <RefreshCw size={14} />重连失败/断开
          </button>
          <button className="secondary-button danger-button" disabled={disconnectedCount === 0} onClick={onCloseDisconnected}>
            <Trash2 size={14} />关闭已断开
          </button>
        </div>

        <div className="connection-manager-list">
          {items.length === 0 ? (
            <div className="settings-empty">当前没有已打开的 SSH 标签。</div>
          ) : items.map((item) => (
            <article className={`connection-manager-row ${item.focused ? "focused" : ""}`} key={item.id}>
              <span className={`connection-dot ${item.state}`} aria-hidden="true" />
              <div className="connection-manager-copy">
                <strong>{item.name}</strong>
                <small>{stateLabel(item.state)}{item.focused ? " · 当前焦点" : ""}</small>
              </div>
              {item.locked && <span className="connection-manager-lock" title="标签已锁定"><Lock size={13} /></span>}
              <div className="connection-manager-row-actions">
                <button onClick={() => { onFocus(item.id); onClose(); }} title="定位到标签" aria-label={`定位到 ${item.name}`}><LocateFixed size={14} /></button>
                <button onClick={() => onReconnect(item.id)} title="重新连接" aria-label={`重新连接 ${item.name}`}><RefreshCw size={14} /></button>
                <button disabled={item.locked} onClick={() => onCloseTab(item.id)} title={item.locked ? "标签已锁定" : "关闭标签"} aria-label={`关闭 ${item.name}`}><X size={14} /></button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
