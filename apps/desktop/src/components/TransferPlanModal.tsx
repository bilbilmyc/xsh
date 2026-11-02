import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, ArrowUpFromLine, FolderOpen, X } from "lucide-react";
import type { ConflictPolicy, TransferDraft } from "../transfer-plan";
import { formatTransferBytes } from "./TransferCard";
import "./TransferPlanModal.css";

interface Props {
  draft: TransferDraft;
  busy: boolean;
  error: string | null;
  onConfirm(destination: string, policy: ConflictPolicy): void;
  onCancel(): void;
}
export function TransferPlanModal({ draft, busy, error, onConfirm, onCancel }: Props) {
  const [destination, setDestination] = useState(draft.destination);
  const [policy, setPolicy] = useState<ConflictPolicy>("ask");
  const [choosingDestination, setChoosingDestination] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onCancel(); } };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [onCancel]);
  const upload = draft.direction === "upload";
  const disabled = busy || choosingDestination;
  const chooseDestination = async () => {
    if (upload || disabled) return;
    setChoosingDestination(true);
    setDestinationError(null);
    try {
      const selected = draft.destinationKind === "file"
        ? await save({ title: "选择下载保存位置", defaultPath: destination })
        : await open({ title: "选择下载保存目录", defaultPath: destination, directory: true, multiple: false });
      if (typeof selected === "string") setDestination(selected);
    } catch (caught) {
      setDestinationError("选择下载保存位置失败：" + String(caught));
    } finally {
      setChoosingDestination(false);
    }
  };
  const directories = draft.sources.filter((source) => source.fileType === "directory").length;
  return <div className="modal-backdrop transfer-plan-backdrop" onMouseDown={onCancel}>
    <section className="transfer-plan-modal" role="dialog" aria-modal="true" aria-label={upload ? "确认上传目标" : "确认下载目标"} onMouseDown={(event) => event.stopPropagation()}>
      <header className="modal-header"><div className="modal-title-wrap">{upload ? <ArrowUpFromLine size={20} /> : <ArrowDownToLine size={20} />}<div><h2>{upload ? "上传文件" : "下载文件"}</h2><p>{draft.sources.length} 项 · {formatTransferBytes(draft.sources.filter((source) => source.fileType !== "directory").reduce((sum, source) => sum + source.size, 0))}{directories > 0 ? ` + ${directories} 个目录（含子目录）` : ""}</p></div></div><button type="button" className="icon-button" aria-label="取消传输" onClick={onCancel}><X size={18} /></button></header>
      <div className="transfer-plan-body">
        <div className="transfer-plan-route"><span>来源 · {upload ? "本机" : draft.host}</span><ul>{draft.sources.map((source) => <li key={source.path} title={source.path}><code>{source.path}</code></li>)}</ul></div>
        <div className="transfer-plan-arrow" aria-hidden="true">↓</div>
        <label className="field"><span>保存到 · {upload ? draft.host : "本机"}{draft.destinationKind === "file" ? " · 完整文件路径" : " · 目录"}</span>{upload
          ? <input autoFocus value={destination} disabled={disabled} spellCheck={false} onChange={(event) => setDestination(event.target.value)} />
          : <button type="button" autoFocus className="secondary-button transfer-plan-destination" disabled={disabled} title={destination} aria-label={draft.destinationKind === "file" ? "选择下载保存位置" : "选择下载保存目录"} onClick={() => void chooseDestination()}><span className="transfer-plan-destination-path">{destination}</span><FolderOpen size={16} aria-hidden="true" /><span className="transfer-plan-destination-action">{choosingDestination ? "选择中…" : draft.destinationKind === "file" ? "选择位置" : "选择文件夹"}</span></button>}</label>
        <label className="field"><span>遇到同名文件</span><select value={policy} disabled={disabled} onChange={(event) => setPolicy(event.target.value as ConflictPolicy)}><option value="ask">逐个询问（推荐）</option><option value="keep-both">保留两份，自动命名</option><option value="skip">跳过已有文件</option><option value="overwrite">覆盖已有普通文件</option></select></label>
        <p className="transfer-plan-note">本批固定使用 {draft.host}。目录会合并到同名文件夹；文件冲突按所选策略处理。{upload ? "目录中的符号链接及特殊文件会跳过。" : "文件与目录冲突会单独询问。"}</p>
        {(destinationError || error) && <p className="form-error" role="alert">{destinationError || error}</p>}
      </div>
      <footer className="modal-footer"><span className="transfer-plan-note">{busy ? "正在检查目标和同名文件…" : "确认后检查冲突，再加入传输队列"}</span><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="button" className="primary-button" disabled={disabled || !destination.trim()} onClick={() => onConfirm(destination.trim(), policy)}>{busy ? "检查中…" : upload ? "确认上传" : "确认下载"}</button></footer>
    </section>
  </div>;
}
