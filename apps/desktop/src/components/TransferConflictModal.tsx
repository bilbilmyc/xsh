import { useEffect, useRef, useState } from "react";
import { CircleAlert, X } from "lucide-react";
import { transferNameError, type ConflictChoice, type TransferConflict } from "../transfer-plan";
import { formatTransferBytes } from "./TransferCard";
import type { RemoteEntry } from "../types";
import "./TransferPlanModal.css";

const typeLabels = { directory: "目录", file: "文件", symlink: "符号链接", other: "其他类型" };
function Metadata({ entry, path, label }: { entry: RemoteEntry; path: string; label: string }) {
  return <div className="transfer-conflict-metadata"><strong>{label}</strong><code>{path}</code><span>{typeLabels[entry.fileType]} · {formatTransferBytes(entry.size)}</span><time>{entry.modifiedAtUnix === null ? "修改时间未知" : `修改于 ${new Date(entry.modifiedAtUnix * 1000).toLocaleString()}`}</time></div>;
}
export function TransferConflictModal({ conflict, direction, onConfirm, onCancel }: { conflict: TransferConflict; direction: "upload" | "download"; onConfirm(choice: ConflictChoice): void; onCancel(): void }) {
  const [strategy, setStrategy] = useState<ConflictChoice["type"]>("keep-both");
  const [name, setName] = useState("");
  const [applyToBatch, setApplyToBatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopImmediatePropagation(); onCancel(); } };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [busy, onCancel]);
  const confirm = async () => {
    if (busy) return;
    if (strategy !== "rename") { onConfirm({ type: strategy, applyToBatch }); return; }
    setBusy(true);
    try {
      const next = name.trim();
      const message = transferNameError(next) ?? await conflict.validateName(next);
      if (!alive.current) return;
      if (message) { setError(message); return; }
      onConfirm({ type: "rename", name: next });
    } catch (caught) {
      if (alive.current) setError(String(caught));
    } finally { if (alive.current) setBusy(false); }
  };
  return <div className="modal-backdrop transfer-conflict-backdrop" onMouseDown={() => { if (!busy) onCancel(); }}>
    <section className="transfer-plan-modal" role="dialog" aria-modal="true" aria-label="传输文件冲突" onMouseDown={(event) => event.stopPropagation()}>
      <header className="modal-header"><div className="modal-title-wrap"><CircleAlert size={20} /><div><h2>目标已存在</h2><p>{direction === "upload" ? "上传" : "下载"} · {conflict.source.name}</p></div></div><button type="button" className="icon-button" disabled={busy} aria-label="取消本批传输" onClick={onCancel}><X size={18} /></button></header>
      <div className="transfer-plan-body">
        <div className="transfer-conflict-comparison"><Metadata entry={conflict.source} path={conflict.source.path} label="传入项目" /><Metadata entry={conflict.destination} path={conflict.destinationPath} label="目标已有项目" /></div>
        {!conflict.canOverwrite && <p className="transfer-plan-note">此冲突不能直接覆盖，可保留两份、重命名或跳过。</p>}
        <label className="field"><span>处理方式</span><select autoFocus disabled={busy} value={strategy} onChange={(event) => { setStrategy(event.target.value as ConflictChoice["type"]); setError(""); }}><option value="keep-both">保留两份，自动命名</option><option value="rename">使用其他名称</option><option value="skip">跳过此项</option>{conflict.canOverwrite && <option value="overwrite">覆盖目标文件</option>}</select></label>
        {strategy === "rename" && <label className="field"><span>新的目标名称</span><input aria-label="新的目标名称" value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void confirm(); }} placeholder={conflict.source.name} spellCheck={false} /></label>}
        {strategy !== "rename" && <label className="transfer-plan-check"><input type="checkbox" checked={applyToBatch} disabled={busy} onChange={(event) => setApplyToBatch(event.target.checked)} />应用于本批后续同名文件</label>}
        <p className="transfer-plan-note">本层后续还有 {conflict.remainingItems} 项待检查。取消将取消本批尚未提交的全部项目。</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消本批</button><button type="button" className="primary-button" disabled={busy || (strategy === "rename" && !name.trim())} onClick={() => void confirm()}>{busy ? "检查名称…" : "确定"}</button></footer>
    </section>
  </div>;
}
