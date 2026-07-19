import { ClipboardCopy, Play, Trash2, X } from "lucide-react";
import type { CommandHistoryEntry } from "../command-history";

interface CommandHistoryModalProps {
  entries: CommandHistoryEntry[];
  activeSessionId: string | null;
  canExecute: boolean;
  executionUnavailableReason: string;
  onExecute: (entry: CommandHistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

export function CommandHistoryModal({
  entries,
  activeSessionId,
  canExecute,
  executionUnavailableReason,
  onExecute,
  onClear,
  onClose,
  onToast,
}: CommandHistoryModalProps) {
  const visible = entries.filter((entry) => !activeSessionId || entry.sessionId === activeSessionId);

  const copy = async (entry: CommandHistoryEntry) => {
    try {
      await navigator.clipboard.writeText(entry.command);
      onToast("命令已复制。");
    } catch {
      onToast("复制失败，请检查系统剪贴板权限。");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal command-history-modal" role="dialog" aria-modal="true" aria-label="命令历史">
        <header className="modal-header">
          <div><strong>命令历史</strong><span>{activeSessionId ? "当前会话" : "全部会话"}</span></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="command-history-body">
          {visible.length === 0 && <div className="panel-message">暂无命令历史。</div>}
          {visible.map((entry) => (
            <article className="command-history-row" key={entry.id}>
              <div className="command-history-copy">
                <code>{entry.command}</code>
                <small>{entry.sessionName} · {new Date(entry.createdAt).toLocaleString()}</small>
              </div>
              <div className="command-history-actions">
                <button className="icon-button" onClick={() => void copy(entry)} title="复制"><ClipboardCopy size={14} /></button>
                <button className="icon-button" disabled={!canExecute} onClick={() => canExecute ? onExecute(entry) : onToast(executionUnavailableReason)} title="发送到当前会话"><Play size={14} /></button>
              </div>
            </article>
          ))}
        </div>
        <footer className="modal-footer">
          <button className="danger-button" disabled={!entries.length} onClick={() => window.confirm("确定清空全部命令历史？") && onClear()}><Trash2 size={14} />清空历史</button>
          <span />
          <button className="secondary-button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}
