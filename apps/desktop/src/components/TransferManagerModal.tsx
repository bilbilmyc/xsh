import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { TransferEvent } from "../types";

interface TransferManagerModalProps {
  onClose: () => void;
  onToast?: (message: string) => void;
}

export function TransferManagerModal({ onClose, onToast }: TransferManagerModalProps) {
  const [transfers, setTransfers] = useState<TransferEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setTransfers(await api.listTransfers());
      setError(null);
    } catch (caught) {
      setError(`读取传输任务失败：${String(caught)}`);
    }
  };

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await api.listTransfers();
        if (!disposed) {
          setTransfers(next);
          setError(null);
        }
      } catch (caught) {
        if (!disposed) setError(`读取传输任务失败：${String(caught)}`);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 600);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const activeCount = useMemo(
    () => transfers.filter((transfer) => ["queued", "running", "paused"].includes(transfer.status)).length,
    [transfers],
  );

  const update = (event: TransferEvent) => {
    setTransfers((current) => {
      const next = current.filter((transfer) => transfer.transferId !== event.transferId);
      return [...next, event];
    });
  };

  const clearFinished = async () => {
    const completed = transfers.filter((transfer) => !["queued", "running", "paused"].includes(transfer.status));
    await Promise.all(completed.map((transfer) => api.removeTransfer(transfer.transferId).catch(() => undefined)));
    await refresh();
    if (completed.length > 0) onToast?.(`已清理 ${completed.length} 个已结束传输任务。`);
  };

  return (
    <div className="modal-backdrop transfer-manager-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-modal transfer-manager-modal" role="dialog" aria-modal="true" aria-label="传输管理" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>传输管理</h2>
            <p>{activeCount > 0 ? `${activeCount} 个任务正在运行或暂停` : "没有活动传输任务"}</p>
          </div>
          <div className="transfer-manager-header-actions">
            <button className="secondary-button" onClick={() => void refresh()} title="刷新任务"><RefreshCw size={14} />刷新</button>
            {transfers.some((transfer) => !["queued", "running", "paused"].includes(transfer.status)) && <button className="secondary-button" onClick={() => void clearFinished()}>清理已结束</button>}
            <button className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
          </div>
        </header>
        <div className="transfer-manager-body">
          {error && <p className="form-error">{error}</p>}
          {transfers.length === 0 ? (
            <div className="panel-message">暂无传输任务。关闭 SFTP 面板后，正在进行的任务仍会保留在这里。</div>
          ) : transfers.map((transfer) => {
            const percent = transfer.totalBytes ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100)) : 0;
            const active = ["queued", "running", "paused"].includes(transfer.status);
            return (
              <article className="transfer-manager-item" key={transfer.transferId}>
                <div className="transfer-manager-copy">
                  <strong>{transfer.direction === "upload" ? "上传" : "下载"} · {transfer.remotePath.split("/").pop()}</strong>
                  <span title={transfer.localPath}>{transfer.localPath}</span>
                  <small>{formatStatus(transfer.status)} · {percent}% · {formatBytes(transfer.transferredBytes)}{transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}{transfer.status === "running" && transfer.speedBytesPerSecond !== null ? ` · ${formatBytes(transfer.speedBytesPerSecond)}/s` : ""}</small>
                  {transfer.error && <small className="transfer-error">{transfer.error}</small>}
                </div>
                <div className="progress-track"><div className={transfer.status} style={{ width: `${percent}%` }} /></div>
                <div className="transfer-manager-actions">
                  {(transfer.status === "queued" || transfer.status === "running") && <button onClick={() => void api.pauseTransfer(transfer.transferId).then(update)} title="暂停"><Pause size={14} /></button>}
                  {transfer.status === "paused" && <button onClick={() => void api.resumeTransfer(transfer.transferId).then(update)} title="继续"><Play size={14} /></button>}
                  {active && <button onClick={() => void api.cancelTransfer(transfer.transferId).then(update)} title="取消"><X size={14} /></button>}
                  {!active && <button onClick={() => void api.removeTransfer(transfer.transferId).then(() => refresh())} title="移除"><Trash2 size={14} /></button>}
                </div>
              </article>
            );
          })}
        </div>
        <footer className="modal-footer"><button className="primary-button" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}

function formatStatus(status: TransferEvent["status"]) {
  return { queued: "等待中", running: "传输中", paused: "已暂停", completed: "已完成", cancelled: "已取消", failed: "失败" }[status];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
