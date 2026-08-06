import { useMemo, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, FolderOpen, Play, RefreshCw, Upload, X } from "lucide-react";
import { api } from "../api";
import { buildSftpSyncPreview, matchesSyncExclude, type SyncChange } from "../sftp-sync-plan";
import type { RemoteEntry, TransferEvent } from "../types";

interface SftpSyncModalProps {
  connectionId: string;
  initialRemotePath: string;
  onClose: () => void;
  onRefreshRemote: () => void;
  onToast: (message: string) => void;
}

const DEFAULT_EXCLUDES = ".git/**\nnode_modules/**\n*.xsh-part";
const MAX_PREVIEW_ENTRIES = 10_000;

export function SftpSyncModal({ connectionId, initialRemotePath, onClose, onRefreshRemote, onToast }: SftpSyncModalProps) {
  const [localRoot, setLocalRoot] = useState("");
  const [remoteRoot, setRemoteRoot] = useState(initialRemotePath);
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDES);
  const [changes, setChanges] = useState<SyncChange[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executableChanges = useMemo(
    () => (changes ?? []).filter((change) => change.type !== "conflict"),
    [changes],
  );
  const conflicts = useMemo(
    () => (changes ?? []).filter((change) => change.type === "conflict"),
    [changes],
  );

  const chooseLocalRoot = async () => {
    const selected = await open({ title: "选择要同步的本地目录", directory: true, multiple: false });
    if (typeof selected === "string") setLocalRoot(selected);
  };

  const preview = async () => {
    if (!localRoot.trim()) {
      setError("请选择本地目录。");
      return;
    }
    if (!remoteRoot.trim()) {
      setError("请输入远程目录。");
      return;
    }
    setScanning(true);
    setError(null);
    setChanges(null);
    try {
      const excludes = excludeText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
      const [localEntries, canonicalRemoteRoot] = await Promise.all([
        api.listLocalSyncEntries(localRoot.trim(), excludes),
        api.sftpCanonicalize(connectionId, remoteRoot.trim()),
      ]);
      if (localEntries.length > MAX_PREVIEW_ENTRIES) throw new Error(`本地目录超过 ${MAX_PREVIEW_ENTRIES.toLocaleString()} 项，请增加排除规则。`);
      const remoteEntries = await collectRemoteEntries(connectionId, canonicalRemoteRoot, excludes);
      if (remoteEntries.size > MAX_PREVIEW_ENTRIES) throw new Error(`远程目录超过 ${MAX_PREVIEW_ENTRIES.toLocaleString()} 项，请增加排除规则后再同步。`);
      setRemoteRoot(canonicalRemoteRoot);
      setChanges(buildSftpSyncPreview(localEntries, remoteEntries, canonicalRemoteRoot));
    } catch (caught) {
      setError(`生成同步预览失败：${String(caught)}`);
    } finally {
      setScanning(false);
    }
  };

  const submit = async () => {
    if (executableChanges.length === 0) {
      onToast(conflicts.length ? "当前只有冲突项，未提交同步。" : "没有需要同步的变更。");
      return;
    }
    if (!window.confirm(`将创建 ${executableChanges.filter((change) => change.type === "createDirectory").length} 个远程目录，并提交 ${executableChanges.filter((change) => change.type === "upload").length} 个上传任务。远端多出的文件不会删除。继续？`)) return;
    setSubmitting(true);
    setError(null);
    try {
      const directories = executableChanges.filter((change): change is Extract<SyncChange, { type: "createDirectory" }> => change.type === "createDirectory")
        .sort((left, right) => left.relativePath.split("/").length - right.relativePath.split("/").length);
      const uploads = executableChanges.filter((change): change is Extract<SyncChange, { type: "upload" }> => change.type === "upload");
      for (const directory of directories) await api.sftpCreateDirectory(connectionId, directory.remotePath);
      for (const upload of uploads) {
        await waitForTransfer((channel) =>
          api.sftpUpload(connectionId, upload.localPath, upload.remotePath, true, channel),
        );
      }
      onRefreshRemote();
      onToast(`已提交 ${directories.length} 个目录创建和 ${uploads.length} 个上传任务。`);
    } catch (caught) {
      setError(`提交同步失败：${String(caught)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const copyPreview = async () => {
    const text = (changes ?? []).map((change) => `${change.type}\t${change.relativePath}\t${"reason" in change ? change.reason : change.remotePath}`).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onToast("同步预览已复制。");
    } catch {
      onToast("复制失败，请检查系统剪贴板权限。");
    }
  };

  return (
    <div className="modal-backdrop sftp-sync-backdrop" onMouseDown={onClose}>
      <section className="sftp-sync-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="SFTP 文件夹同步">
        <header className="modal-header">
          <div className="modal-title-wrap"><span className="modal-icon"><RefreshCw size={18} /></span><div><h2>文件夹同步</h2><p>单向：本地目录覆盖更新到远程目录。预览只列出创建和上传，不删除远端文件。</p></div></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭文件夹同步"><X size={18} /></button>
        </header>
        <div className="sftp-sync-body">
          <section className="sftp-sync-settings">
            <label className="field"><span>本地目录</span><div className="input-action-row"><input value={localRoot} onChange={(event) => setLocalRoot(event.target.value)} placeholder="选择本地目录" /><button type="button" className="secondary-button" onClick={() => void chooseLocalRoot()}><FolderOpen size={14} />选择</button></div></label>
            <label className="field"><span>远程目录</span><input value={remoteRoot} onChange={(event) => setRemoteRoot(event.target.value)} spellCheck={false} /></label>
            <label className="field"><span>排除规则（每行一条）</span><textarea value={excludeText} onChange={(event) => setExcludeText(event.target.value)} rows={5} spellCheck={false} /><small className="field-help">支持 <code>*</code> 与 <code>?</code>；规则作用于相对路径。</small></label>
            <button type="button" className="primary-button sftp-sync-preview-button" disabled={scanning || submitting} onClick={() => void preview()}><RefreshCw size={15} />{scanning ? "正在比较…" : "生成差异预览"}</button>
            {error && <div className="form-error" role="alert">{error}</div>}
          </section>
          <section className="sftp-sync-preview" aria-live="polite">
            <div className="sftp-sync-preview-heading"><div><strong>变更预览</strong><span>{changes ? `${executableChanges.length} 项将提交${conflicts.length ? ` · ${conflicts.length} 项冲突` : ""}` : "选择目录后生成预览"}</span></div>{changes && <button className="icon-button" title="复制预览" onClick={() => void copyPreview()}><ClipboardCopy size={14} /></button>}</div>
            {changes ? <div className="sftp-sync-change-list">
              {changes.length === 0 ? <div className="sftp-sync-empty"><Upload size={20} />本地与远程已无需要提交的差异。</div> : changes.map((change) => <div className={`sftp-sync-change ${change.type}`} key={`${change.type}:${change.relativePath}`}><strong>{change.type === "createDirectory" ? "新建目录" : change.type === "upload" ? "上传" : "冲突"}</strong><span>{change.relativePath}</span><small>{"reason" in change ? change.reason : change.remotePath}</small></div>)}
            </div> : <div className="sftp-sync-empty"><RefreshCw size={20} />同步前先比较本地目录与当前远程目录。</div>}
            <div className="sftp-sync-actions"><button type="button" className="primary-button" disabled={submitting || executableChanges.length === 0} onClick={() => void submit()}><Play size={15} />{submitting ? "正在提交…" : "提交同步"}</button></div>
          </section>
        </div>
      </section>
    </div>
  );
}

async function collectRemoteEntries(connectionId: string, root: string, excludes: string[]): Promise<Map<string, RemoteEntry>> {
  const entries = new Map<string, RemoteEntry>();
  const visit = async (directory: string) => {
    const children = await api.sftpListDirectory(connectionId, directory);
    for (const child of children) {
      const relativePath = child.path.startsWith(root) ? child.path.slice(root.length).replace(/^\/+/, "") : child.name;
      if (!relativePath) continue;
      if (excludes.some((pattern) => matchesSyncExclude(pattern, relativePath))) continue;
      entries.set(relativePath, child);
      if (entries.size > MAX_PREVIEW_ENTRIES) return;
      if (child.fileType === "directory") await visit(child.path);
    }
  };
  await visit(root);
  return entries;
}


function waitForTransfer(start: (channel: Channel<TransferEvent>) => Promise<string>) {
  return new Promise<void>((resolve, reject) => {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = (event) => {
      if (event.status === "completed") resolve();
      else if (event.status === "failed" || event.status === "cancelled") reject(new Error(event.error ?? "传输未完成"));
    };
    void start(channel).catch(reject);
  });
}
