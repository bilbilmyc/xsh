import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, FolderOpen, LoaderCircle, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../api";
import { isActiveTransferStatus } from "../sftp-transfer-scope";
import { formatTransferWaitingState, localParentDirectory, transferPercent, type TransferFilter } from "../transfer-queue";
import type { TransferEvent } from "../types";
import "./TransferCard.css";

export const TRANSFER_FILTER_LABELS: Record<TransferFilter, string> = { all: "全部", active: "进行中", failed: "失败", finished: "已结束" };

export function TransferFilters({ value, counts, onChange }: { value: TransferFilter; counts: Record<TransferFilter, number>; onChange: (filter: TransferFilter) => void }) {
  return <div className="transfer-filters" role="group" aria-label="筛选传输任务">{(Object.keys(TRANSFER_FILTER_LABELS) as TransferFilter[]).map((filter) => (
    <button type="button" key={filter} aria-pressed={value === filter} onClick={() => onChange(filter)}>
      {TRANSFER_FILTER_LABELS[filter]}<span>{counts[filter]}</span>
    </button>
  ))}</div>;
}

interface TransferCardProps {
  transfer: TransferEvent;
  busy?: boolean;
  onControl: (transfer: TransferEvent, action: "pause" | "resume" | "cancel") => void;
  onRemove: (transfer: TransferEvent) => void;
  onRetry?: (transfer: TransferEvent) => void;
  onLocateRemote?: (transfer: TransferEvent) => void;
  onError: (message: string) => void;
}

const statusLabels: Record<TransferEvent["status"], string> = {
  queued: "等待中", running: "传输中", paused: "已暂停", cancelling: "取消中", completed: "已完成", cancelled: "已取消", failed: "失败",
};

export function TransferCard({ transfer, busy = false, onControl, onRemove, onRetry, onError, onLocateRemote }: TransferCardProps) {
  const [opening, setOpening] = useState(false);
  const percent = transferPercent(transfer);
  const waiting = formatTransferWaitingState(transfer);
  const active = isActiveTransferStatus(transfer.status);
  const upload = transfer.direction === "upload";
  const filename = (upload ? transfer.localPath.split(/[\\/]/).pop() : transfer.remotePath.split("/").pop()) || transfer.remotePath;
  const source = upload ? transfer.localPath : `${transfer.endpoint}:${transfer.remotePath}`;
  const destination = upload ? `${transfer.endpoint}:${transfer.remotePath}` : transfer.localPath;
  return (
    <article className={`transfer-card transfer-card-${transfer.status}`} aria-label={`${upload ? "上传" : "下载"} ${filename}`}>
      <div className="transfer-card-heading">
        <span className={`transfer-direction ${transfer.direction}`} title={upload ? "上传" : "下载"}>{upload ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}</span>
        <strong title={filename}>{filename}</strong>
        <span className={`transfer-badge ${transfer.status}`}>{transfer.status === "completed" && <Check size={11} />}{statusLabels[transfer.status]}</span>
      </div>
      <dl className="transfer-route">
        <div><dt>{upload ? "本地" : "远端"}<span>来源</span></dt><dd title={source}>{source}</dd></div>
        <div><dt>{upload ? "远端" : "本地"}<span>目标</span></dt><dd title={destination}>{destination}</dd></div>
      </dl>
      {active && <div className={`transfer-card-progress ${percent === null ? "indeterminate" : ""}`} role="progressbar" aria-label={`${filename} 传输进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? statusLabels[transfer.status] : `${percent}%`}>
        <div style={{ width: percent === null ? "30%" : `${percent}%` }} />
      </div>}
      <div className="transfer-card-footer">
        <span className="transfer-card-metrics">
          {percent !== null && active && <strong>{percent}%</strong>}
          {formatTransferBytes(transfer.transferredBytes)}{transfer.totalBytes !== null ? ` / ${formatTransferBytes(transfer.totalBytes)}` : ""}
          {transfer.status === "running" && transfer.speedBytesPerSecond !== null && <small>{formatTransferBytes(transfer.speedBytesPerSecond)}/s</small>}
        </span>
        <div className="transfer-card-actions">
          {onLocateRemote && <button type="button" disabled={busy} onClick={() => onLocateRemote(transfer)} title="定位原主机的远端目录"><FolderOpen size={13} />远端目录</button>}
          {(transfer.status === "queued" || transfer.status === "running") && <button type="button" disabled={busy} onClick={() => onControl(transfer, "pause")} title="暂停" aria-label={`暂停 ${filename}`}><Pause size={13} /></button>}
          {transfer.status === "paused" && <button type="button" disabled={busy} onClick={() => onControl(transfer, "resume")} title="继续" aria-label={`继续 ${filename}`}><Play size={13} /></button>}
          {active && transfer.status !== "cancelling" && <button type="button" disabled={busy} onClick={() => onControl(transfer, "cancel")} title="取消" aria-label={`取消 ${filename}`}><X size={13} /></button>}
          {(transfer.status === "failed" || transfer.status === "cancelled") && onRetry && <button type="button" disabled={busy} onClick={() => onRetry(transfer)}><RotateCcw size={13} />重试</button>}
          {transfer.status === "completed" && !upload && <button type="button" disabled={opening} onClick={() => {
            setOpening(true);
            void api.openLocalPath(localParentDirectory(transfer.localPath)).catch((caught) => onError(`打开保存目录失败：${String(caught)}`)).finally(() => setOpening(false));
          }}><FolderOpen size={13} />打开目录</button>}
          {!active && <button type="button" disabled={busy} onClick={() => onRemove(transfer)} title="移除记录" aria-label={`移除 ${filename}`}><Trash2 size={13} /></button>}
          {busy && <LoaderCircle size={13} className="transfer-action-pending" aria-label="正在更新任务" />}
        </div>
      </div>
      {waiting && <p className="transfer-card-waiting">{waiting}</p>}
      {transfer.batchId && <p className="transfer-card-waiting" title={`传输批次 ${transfer.batchId}`}>批次 {transfer.batchId.slice(0, 8)}</p>}
      {transfer.retryOf && <p className="transfer-card-waiting" title={`原任务 ${transfer.retryOf}`}>第 {transfer.retryCount ?? 1} 次重试 · 已保留原任务记录</p>}
      {transfer.error && <p className="transfer-card-error" role="status">{transfer.error}</p>}
    </article>
  );
}

export function formatTransferBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
