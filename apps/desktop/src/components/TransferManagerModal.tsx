import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw, Search, X } from "lucide-react";
import { api } from "../api";
import { isActiveTransferStatus } from "../sftp-transfer-scope";
import { matchesTransferFilter, matchesTransferScope, sortTransfersForDisplay, transferFilterCounts, type TransferFilter, type TransferScope } from "../transfer-queue";
import { formatTransferBytes, TransferCard, TransferFilters } from "./TransferCard";
import "./TransferManagerModal.css";
import type { TransferEvent, TransferListSnapshot } from "../types";

interface TransferManagerModalProps {
  onClose: () => void;
  onToast?: (message: string) => void;
  onLocateRemote?: (transfer: TransferEvent) => void;
  initialFilter?: TransferFilter;
}

const emptySnapshot: TransferListSnapshot = {
  transfers: [],
  summary: {
    occupiedSlots: 0,
    globalLimit: 0,
    running: 0,
    queued: 0,
    paused: 0,
    cancelling: 0,
    aggregateUploadBytesPerSecond: 0,
    aggregateDownloadBytesPerSecond: 0,
  },
};

export function TransferManagerModal({ onClose, onToast, onLocateRemote, initialFilter = "all" }: TransferManagerModalProps) {
  const [snapshot, setSnapshot] = useState<TransferListSnapshot>(emptySnapshot);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TransferFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TransferScope>({ direction: "all", endpoint: "", batchId: "" });
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const retryingRef = useRef(new Set<string>());
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) bodyRef.current?.scrollTo({ top: 0 }); }, [error]);
  const transfers = useMemo(
    () => sortTransfersForDisplay(snapshot.transfers),
    [snapshot.transfers],
  );
  const scopedTransfers = useMemo(() => transfers.filter((transfer) => matchesTransferScope(transfer, scope)), [transfers, scope]);
  const counts = useMemo(() => transferFilterCounts(scopedTransfers), [scopedTransfers]);
  const endpoints = [...new Set(transfers.map((item) => item.endpoint))].sort();
  const batches = [...new Set(transfers.flatMap((item) => item.batchId ? [item.batchId] : []))];
  const visibleTransfers = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return scopedTransfers.filter((transfer) => matchesTransferFilter(transfer, filter) && (!search || [transfer.localPath, transfer.remotePath, transfer.endpoint].some((value) => value.toLocaleLowerCase().includes(search))));
  }, [scopedTransfers, filter, query]);

  const refresh = async () => {
    try {
      setSnapshot(await api.listTransfers());
      setLoadError(null);
    } catch (caught) {
      setLoadError(`读取传输任务失败：${String(caught)}`);
    }
  };

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const next = await api.listTransfers();
        if (!disposed) {
          setSnapshot(next);
          setLoadError(null);
        }
      } catch (caught) {
        if (!disposed) setLoadError(`读取传输任务失败：${String(caught)}`);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 600);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const { summary } = snapshot;
  const activeCount = summary.running + summary.queued + summary.paused + summary.cancelling;
  const retryable = (transfer: TransferEvent) => transfer.status === "failed" || transfer.status === "cancelled";
  const selectedTransfers = transfers.filter((transfer) => selectedIds.has(transfer.transferId) && retryable(transfer));

  const retry = async (items: TransferEvent[]) => {
    const batch = items.filter((item) => retryable(item) && !retryingRef.current.has(item.transferId));
    if (!batch.length) return;
    batch.forEach((item) => retryingRef.current.add(item.transferId));
    setBusyIds((previous) => new Set([...previous, ...batch.map((item) => item.transferId)]));
    setError(null);
    let submitted = 0;
    const failures: string[] = [];
    try {
      for (const item of batch) {
        try {
          await api.retryTransfer(item.transferId);
          submitted += 1;
          setSelectedIds((previous) => { const next = new Set(previous); next.delete(item.transferId); return next; });
        } catch (caught) { failures.push(`${item.endpoint} · ${item.remotePath}：${String(caught)}`); }
      }
      await refresh();
      if (submitted) onToast?.(`已将 ${submitted} 项重试加入原主机的传输队列。`);
      if (failures.length) setError(`${submitted} 项已提交，${failures.length} 项无法重试。\n${failures.slice(0, 3).join("\n")}`);
    } finally {
      batch.forEach((item) => retryingRef.current.delete(item.transferId));
      setBusyIds((previous) => { const next = new Set(previous); batch.forEach((item) => next.delete(item.transferId)); return next; });
    }
  };

  const update = (event: TransferEvent) => {
    setSnapshot((current) => ({
      ...current,
      transfers: [
        ...current.transfers.filter((transfer) => transfer.transferId !== event.transferId),
        event,
      ],
    }));
  };

  const control = async (transfer: TransferEvent, action: "pause" | "resume" | "cancel") => {
    if (busyIds.has(transfer.transferId)) return;
    setBusyIds((previous) => new Set(previous).add(transfer.transferId));
    try {
      const event = action === "pause"
        ? await api.pauseTransfer(transfer.transferId)
        : action === "resume"
          ? await api.resumeTransfer(transfer.transferId)
          : await api.cancelTransfer(transfer.transferId);
      update(event);
      setError(null);
    } catch (caught) {
      setError(`更新传输状态失败：${String(caught)}`);
    } finally {
      setBusyIds((previous) => { const next = new Set(previous); next.delete(transfer.transferId); return next; });
    }
  };

  const remove = async (transfer: TransferEvent) => {
    try {
      await api.removeTransfer(transfer.transferId);
      setError(null);
      await refresh();
    } catch (caught) {
      setError(`移除传输任务失败：${String(caught)}`);
    }
  };

  const clearFinished = async () => {
    if (clearing) return;
    setClearing(true);
    setError(null);
    const completed = transfers.filter((transfer) => !isActiveTransferStatus(transfer.status));
    try {
      const results = await Promise.allSettled(completed.map((transfer) => api.removeTransfer(transfer.transferId)));
      const removed = results.filter((result) => result.status === "fulfilled").length;
      await refresh();
      if (removed > 0) onToast?.(`已清理 ${removed} 个已结束传输任务。`);
      if (removed < completed.length) setError(`${completed.length - removed} 项记录未能移除，请重试。`);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="modal-backdrop transfer-manager-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-modal transfer-manager-modal" role="dialog" aria-modal="true" aria-label="传输管理" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>传输管理</h2>
            <p>{activeCount > 0
              ? `${activeCount} 项进行中 · ${summary.running} 项正在传输 · ${summary.queued} 项等待 · ${summary.paused} 项暂停`
              : "查看所有主机的上传、下载和已完成记录"}</p>
          </div>
          <div className="transfer-manager-header-actions">
            <button className="secondary-button" onClick={() => void refresh()} title="刷新任务"><RefreshCw size={14} />刷新</button>
            {transfers.some((transfer) => !isActiveTransferStatus(transfer.status)) && <button className="secondary-button" disabled={clearing || busyIds.size > 0} onClick={() => void clearFinished()}>{clearing ? "清理中…" : "清理已结束"}</button>}
            <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭传输管理"><X size={16} /></button>
          </div>
        </header>
        <div className="transfer-manager-body" ref={bodyRef}>
          <div className="transfer-manager-filter-bar">
            <TransferFilters value={filter} counts={counts} onChange={setFilter} />
            <label className="transfer-manager-search"><Search size={13} /><input aria-label="搜索传输任务" value={query} placeholder="搜索文件或主机…" onChange={(event) => setQuery(event.target.value)} /></label>
          </div>
          <div className="transfer-manager-scope">
            <label>方向<select aria-label="按传输方向筛选" value={scope.direction} onChange={(event) => setScope((previous) => ({ ...previous, direction: event.target.value as TransferScope["direction"] }))}><option value="all">全部方向</option><option value="upload">上传</option><option value="download">下载</option></select></label>
            <label>主机<select aria-label="按传输主机筛选" value={scope.endpoint} onChange={(event) => setScope((previous) => ({ ...previous, endpoint: event.target.value }))}><option value="">全部主机</option>{endpoints.map((endpoint) => <option key={endpoint} value={endpoint}>{endpoint}</option>)}</select></label>
            <label>批次<select aria-label="按传输批次筛选" value={scope.batchId} onChange={(event) => setScope((previous) => ({ ...previous, batchId: event.target.value }))}><option value="">全部批次</option><option value="unbatched">未分批任务</option>{batches.map((id) => <option key={id} value={id}>批次 {id.slice(0, 8)} · {transfers.filter((item) => item.batchId === id).length} 项</option>)}</select></label>
          </div>
          {transfers.some(retryable) && <div className="transfer-manager-batch">
            <label><input type="checkbox" aria-label="选择当前可重试任务" disabled={busyIds.size > 0 || clearing} checked={visibleTransfers.some(retryable) && visibleTransfers.filter(retryable).every((item) => selectedIds.has(item.transferId))} onChange={(event) => { const checked = event.target.checked; setSelectedIds((previous) => { const next = new Set(previous); visibleTransfers.filter(retryable).forEach((item) => { if (checked) next.add(item.transferId); else next.delete(item.transferId); }); return next; }); }} />选择当前可重试任务</label>
            <button type="button" className="secondary-button" disabled={!selectedTransfers.length || busyIds.size > 0 || clearing} onClick={() => void retry(selectedTransfers)}>重试所选 {selectedTransfers.length || ""}</button>
            <span>保留原记录，沿用原主机、路径和覆盖决定</span>
          </div>}
          {(error || loadError) && <p className="form-error" role="alert">{error || loadError}</p>}
          {transfers.length === 0 ? (
            <div className="transfer-manager-empty"><ArrowDownToLine size={27} /><strong>还没有传输任务</strong><p>在远程文件面板上传或下载文件，任务会集中显示在这里。</p></div>
          ) : visibleTransfers.length === 0 ? <p className="transfer-empty-filter">没有符合当前筛选的任务。</p>
            : visibleTransfers.map((transfer) => <div className="transfer-manager-selectable" key={transfer.transferId}>
              {retryable(transfer) && <input type="checkbox" aria-label={`选择重试 ${transfer.remotePath}`} disabled={busyIds.has(transfer.transferId) || clearing} checked={selectedIds.has(transfer.transferId)} onChange={(event) => { const checked = event.target.checked; setSelectedIds((previous) => { const next = new Set(previous); if (checked) next.add(transfer.transferId); else next.delete(transfer.transferId); return next; }); }} />}
              <TransferCard transfer={transfer} busy={busyIds.has(transfer.transferId) || clearing} onControl={(item, action) => void control(item, action)} onRemove={(item) => void remove(item)} onRetry={(item) => void retry([item])} onError={setError} onLocateRemote={onLocateRemote} />
            </div>)}
        </div>
        <footer className="modal-footer transfer-manager-footer"><span>{activeCount > 0 ? `后台传输中 · ↑ ${formatTransferBytes(summary.aggregateUploadBytesPerSecond)}/s · ↓ ${formatTransferBytes(summary.aggregateDownloadBytesPerSecond)}/s` : "关闭此窗口后，传输任务仍会保留"}</span><button className="primary-button" onClick={onClose}>关闭</button></footer>
      </section>
    </div>
  );
}
