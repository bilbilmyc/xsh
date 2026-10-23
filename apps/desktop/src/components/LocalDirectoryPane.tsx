import { useEffect, useMemo, useState } from "react";
import { ArrowUp, ArrowUpFromLine, File, Folder, RefreshCw, Search } from "lucide-react";
import { api } from "../api";
import { localParentDirectory } from "../transfer-queue";
import { browseRemoteEntries, selectBrowserPaths } from "../sftp-browser";
import { formatTransferBytes } from "./TransferCard";
import type { RemoteEntry } from "../types";

export function LocalDirectoryPane({ path, disabled, onNavigate, onUpload }: {
  path: string;
  disabled: boolean;
  onNavigate: (path: string) => void;
  onUpload: (paths: string[]) => void;
}) {
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setSelected(new Set()); setAnchor(null); setQuery(""); setEntries([]); setError("");
    if (!path) { setLoading(false); return; }
    setLoading(true);
    void api.listLocalDirectory(path).then((items) => { if (live) setEntries(items); }).catch((caught) => { if (live) setError(String(caught)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, refresh]);
  const visible = useMemo(() => browseRemoteEntries(entries, query, true, { field: "name", descending: false }), [entries, query]);
  return <section className="sftp-local-pane" aria-label="本地文件">
    <header><strong>本地文件</strong><button className="icon-button" aria-label="本地上级目录" disabled={!path || loading || localParentDirectory(path) === path} onClick={() => onNavigate(localParentDirectory(path))}><ArrowUp size={13} /></button><button className="icon-button" aria-label="刷新本地目录" disabled={!path || loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={13} /></button></header>
    <p className="sftp-local-path" title={path}>{path || "请先选择本地目录"}</p>
    <label className="sftp-search"><Search size={13} /><input aria-label="搜索本地目录" value={query} placeholder="搜索本地目录…" onChange={(event) => { setQuery(event.target.value); setSelected(new Set()); setAnchor(null); }} /></label>
    <div className="sftp-local-list">
      {loading && <p className="panel-message">正在读取本地文件…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && !visible.length && <p className="panel-message">此目录没有匹配项</p>}
      {visible.map((entry) => <button type="button" className={`sftp-local-entry ${selected.has(entry.path) ? "selected" : ""}`} key={entry.path} title={entry.path} aria-pressed={selected.has(entry.path)} disabled={entry.fileType !== "file" && entry.fileType !== "directory"} onDoubleClick={() => { if (entry.fileType === "directory") onNavigate(entry.path); }} onClick={(event) => {
        const next = selectBrowserPaths(visible.filter((item) => item.fileType === "file" || item.fileType === "directory").map((item) => item.path), selected, anchor, entry.path, event);
        setSelected(next.paths); setAnchor(next.anchor);
      }} onKeyDown={(event) => { if (event.key === "Enter" && entry.fileType === "directory") { event.preventDefault(); onNavigate(entry.path); } }}>
        {entry.fileType === "directory" ? <Folder size={14} /> : <File size={14} />}<span>{entry.name}</span><small>{entry.fileType === "directory" ? "目录" : entry.fileType === "file" ? formatTransferBytes(entry.size) : "链接 / 其他"}</small>
      </button>)}
    </div>
    <button type="button" className="secondary-button" disabled={disabled || loading || !selected.size} onClick={() => onUpload([...selected])}><ArrowUpFromLine size={13} />上传所选 {selected.size || ""}</button>
  </section>;
}
