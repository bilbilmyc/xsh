import { useEffect, useState } from "react";
import { ArrowDownUp, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { transferFilterCounts, type TransferFilter } from "../transfer-queue";
import type { TransferListSnapshot } from "../types";

const speedFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function speedLabel(bytes: number) {
  return bytes >= 1024 ** 2 ? `${speedFormat.format(bytes / 1024 ** 2)} MiB/s` : `${speedFormat.format(bytes / 1024)} KiB/s`;
}

export function GlobalTransferStatus({ onOpen }: { onOpen: (filter: TransferFilter) => void }) {
  const [snapshot, setSnapshot] = useState<TransferListSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (disposed || inFlight) return;
      window.clearTimeout(timer);
      if (document.hidden) return;
      inFlight = true;
      let active = false;
      try {
        const next = await api.listTransfers();
        if (disposed) return;
        active = next.summary.running + next.summary.queued + next.summary.cancelling > 0;
        setSnapshot(next);
        setUnavailable(false);
      } catch {
        if (!disposed) setUnavailable(true);
      } finally {
        inFlight = false;
        if (!disposed) timer = window.setTimeout(() => void refresh(), active ? 1200 : 3000);
      }
    };
    const resume = () => { void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, []);
  const counts = snapshot ? transferFilterCounts(snapshot.transfers) : null;
  if (!unavailable && !counts?.all) return null;
  const upload = snapshot?.summary.aggregateUploadBytesPerSecond ?? 0;
  const download = snapshot?.summary.aggregateDownloadBytesPerSecond ?? 0;
  return <div className="workspace-transfers" aria-label="后台传输">
    <button type="button" title={unavailable ? "传输状态暂不可用，打开管理器重试" : "查看所有主机的后台传输"}
      onClick={() => onOpen(counts?.active ? "active" : "all")}>
      <ArrowDownUp size={12} /><span>{unavailable ? "传输状态待刷新" : counts?.active ? `传输 ${counts.active}` : "传输记录"}</span>
      {!unavailable && upload + download > 0 && <span className="workspace-transfer-speed">↑ {speedLabel(upload)} · ↓ {speedLabel(download)}</span>}
    </button>
    {!!counts?.failed && <button type="button" className="workspace-transfer-failed" onClick={() => onOpen("failed")} aria-label={`${counts.failed} 项传输失败，查看失败任务`}><TriangleAlert size={12} />失败 {counts.failed}</button>}
  </div>;
}
