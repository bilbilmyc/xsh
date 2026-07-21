import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ExternalLink,
  File,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import type { RemoteEntry, SavedSession, TransferEvent } from "../types";

interface SftpPanelProps {
  session: SavedSession;
  onClose: () => void;
  onToast?: (message: string) => void;
}

interface PendingUpload {
  id: string;
  localPath: string;
  remotePath: string;
}

interface RemoteEditState {
  remotePath: string;
  fileName: string;
  localPath: string;
  originalSize: number;
  originalModifiedAtUnix: number | null;
  status: "downloading" | "ready" | "uploading";
}

interface UploadSlotWaiter {
  cancelEpoch: number;
  resolve: (acquired: boolean) => void;
}

const MAX_CONCURRENT_UPLOADS = 2;

export function SftpPanel({ session, onClose, onToast }: SftpPanelProps) {
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [path, setPath] = useState(session.initialDirectory ?? ".");
  const [pathInput, setPathInput] = useState(path);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Record<string, TransferEvent>>({});
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [remoteEdit, setRemoteEdit] = useState<RemoteEditState | null>(null);
  const remoteListRef = useRef<HTMLDivElement>(null);
  const uploadQueueCancelEpochRef = useRef(0);
  const activeUploadCountRef = useRef(0);
  const uploadSlotWaitersRef = useRef<UploadSlotWaiter[]>([]);

  const transferItems = useMemo(() => Object.values(transfers).sort((left, right) => {
    const rank = (status: TransferEvent["status"]) => status === "running" ? 0 : status === "queued" ? 1 : status === "failed" ? 2 : 3;
    return rank(left.status) - rank(right.status);
  }), [transfers]);
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );
  const selected = selectedEntries[0] ?? null;

  const load = async (id: string, target: string) => {
    setLoading(true);
    setError(null);
    try {
      const canonical = await api.sftpCanonicalize(id, target);
      const nextEntries = await api.sftpListDirectory(id, canonical);
      setPath(canonical);
      setPathInput(canonical);
      setEntries(nextEntries.filter((entry) => !isUploadCheckpoint(entry.name)));
      setSelectedPaths(new Set());
      setAnchorPath(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let activeId: string | null = null;

    const connect = async (trustUnknownHost: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const id = await api.connectSftp(session.id, trustUnknownHost);
        if (disposed) {
          await api.disconnectSftp(id).catch(() => undefined);
          return;
        }
        activeId = id;
        setConnectionId(id);
        await load(id, session.initialDirectory ?? ".");
      } catch (caught) {
        if (disposed) return;
        const message = String(caught);
        if (!trustUnknownHost && message.includes("SFTP Host Key 未确认")) {
          const accepted = window.confirm(
            `SFTP 首次连接需要确认服务器密钥。\n\n${message}\n\n是否信任并保存此服务器密钥？`,
          );
          if (accepted) {
            await connect(true);
            return;
          }
        }
        setError(`SFTP 连接失败：${message}`);
        setLoading(false);
      }
    };

    void connect(false);
    return () => {
      disposed = true;
      if (activeId) void api.disconnectSftp(activeId).catch(() => undefined);
    };
  }, [session.id]);

  useEffect(() => () => {
    uploadQueueCancelEpochRef.current += 1;
    const waiters = uploadSlotWaitersRef.current.splice(0);
    waiters.forEach((waiter) => waiter.resolve(false));
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDraggingFiles(true);
          return;
        }
        if (payload.type === "leave") {
          setDraggingFiles(false);
          return;
        }
        setDraggingFiles(false);
        const rect = remoteListRef.current?.getBoundingClientRect();
        if (!rect || !connectionId) return;
        const scale = window.devicePixelRatio || 1;
        const x = payload.position.x / scale;
        const y = payload.position.y / scale;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        void enqueueUploads(payload.paths);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((caught) => setError(`启用文件拖拽失败：${String(caught)}`));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [connectionId, path, entries]);

  const parentPath = () => {
    if (path === "/") return "/";
    const parts = path.replace(/\/$/, "").split("/");
    parts.pop();
    return parts.join("/") || "/";
  };

  const updateTransfer = (event: TransferEvent) => {
    setTransfers((current) => ({ ...current, [event.transferId]: event }));
  };

  const waitForTransfer = async (
    start: (channel: Channel<TransferEvent>) => Promise<unknown>,
  ): Promise<TransferEvent> => {
    const channel = new Channel<TransferEvent>();
    const terminal = new Promise<TransferEvent>((resolve, reject) => {
      channel.onmessage = (event) => {
        updateTransfer(event);
        if (event.status === "completed" || event.status === "cancelled") resolve(event);
        if (event.status === "failed") reject(new Error(event.error ?? "传输失败"));
      };
    });
    await start(channel);
    const result = await terminal;
    if (result.status === "cancelled") throw new Error("传输已取消");
    return result;
  };

  const uploadFiles = async (selectedPaths: string[]) => {
    if (!connectionId || selectedPaths.length === 0) return;
    const tasks: Array<{ localPath: string; remotePath: string }> = [];
    let batchConflictStrategy: "overwrite" | "skip" | null = null;
    for (const localPath of selectedPaths) {
      const fileName = localPath.split(/[\\/]/).pop();
      if (!fileName) continue;
      let remoteName = fileName;
      const existing = entries.find((entry) => entry.name === remoteName);
      if (existing) {
        if (existing.fileType === "directory") {
          setError(`远程目录已存在，无法覆盖：${remoteName}`);
          continue;
        }
        let choice = batchConflictStrategy;
        if (!choice) {
          const answer = window.prompt(
            `远程文件“${remoteName}”已存在。

输入 overwrite 覆盖、overwrite-all 全部覆盖、skip 跳过、skip-all 全部跳过，或 rename 重命名：`,
            "overwrite",
          )?.trim().toLowerCase();
          if (answer === "overwrite-all") {
            batchConflictStrategy = "overwrite";
            choice = "overwrite";
          } else if (answer === "skip-all") {
            batchConflictStrategy = "skip";
            choice = "skip";
          } else {
            choice = answer === "overwrite" || answer === "skip" ? answer : null;
            if (answer === "rename") {
              remoteName = window.prompt("输入新的远程文件名", `${remoteName}.new`)?.trim() ?? "";
              if (!isValidRemoteName(remoteName)) {
                setError("已跳过无效的远程文件名。");
                continue;
              }
            } else if (!choice) {
              if (answer !== undefined) setError("未知的文件冲突策略，已跳过该文件。");
              continue;
            }
          }
        }
        if (choice === "skip") continue;
      }
      const remotePath = path === "/" ? `/${remoteName}` : `${path}/${remoteName}`;
      tasks.push({ localPath, remotePath });
    }
    await runUploadQueue(tasks);
  };

  const enqueueUploads = async (paths: string[]) => {
    await uploadFiles(paths);
  };

  const acquireUploadSlot = (cancelEpoch: number): Promise<boolean> => {
    if (uploadQueueCancelEpochRef.current !== cancelEpoch) return Promise.resolve(false);
    if (activeUploadCountRef.current < MAX_CONCURRENT_UPLOADS) {
      activeUploadCountRef.current += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      uploadSlotWaitersRef.current.push({ cancelEpoch, resolve });
    });
  };

  const releaseUploadSlot = () => {
    while (uploadSlotWaitersRef.current.length > 0) {
      const waiter = uploadSlotWaitersRef.current.shift();
      if (!waiter) break;
      if (waiter.cancelEpoch !== uploadQueueCancelEpochRef.current) {
        waiter.resolve(false);
        continue;
      }
      // Transfer the released slot directly to the next waiter. The active
      // count remains unchanged until that upload eventually releases it.
      waiter.resolve(true);
      return;
    }
    activeUploadCountRef.current = Math.max(0, activeUploadCountRef.current - 1);
  };

  const cancelWaitingUploadSlots = () => {
    const waiters = uploadSlotWaitersRef.current.splice(0);
    waiters.forEach((waiter) => waiter.resolve(false));
  };

  const runUploadQueue = async (tasks: Array<{ localPath: string; remotePath: string }>) => {
    if (!connectionId || tasks.length === 0) return;
    const queuedTasks = tasks.map((task) => ({ ...task, id: crypto.randomUUID() }));
    let cursor = 0;
    const cancelEpoch = uploadQueueCancelEpochRef.current;
    let completed = 0;
    let failed = 0;
    setPendingUploads((current) => [...current, ...queuedTasks]);
    const worker = async () => {
      while (cursor < queuedTasks.length && uploadQueueCancelEpochRef.current === cancelEpoch) {
        const task = queuedTasks[cursor++];
        const acquired = await acquireUploadSlot(cancelEpoch);
        if (!acquired) return;
        if (uploadQueueCancelEpochRef.current !== cancelEpoch) {
          releaseUploadSlot();
          return;
        }
        setPendingUploads((current) => current.filter((item) => item.id !== task.id));
        try {
          await waitForTransfer((channel) =>
            api.sftpUpload(connectionId, task.localPath, task.remotePath, true, channel),
          );
          completed += 1;
        } catch (caught) {
          if (uploadQueueCancelEpochRef.current !== cancelEpoch) continue;
          failed += 1;
          setError(`上传失败：${String(caught)}`);
        } finally {
          releaseUploadSlot();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, queuedTasks.length) }, () => worker()));
    if (completed > 0) await load(connectionId, path);
    if (uploadQueueCancelEpochRef.current !== cancelEpoch) return;
    onToast?.(failed > 0 ? `上传完成 ${completed} 项，失败 ${failed} 项。` : `${completed} 个文件已上传。`);
  };

  const upload = async () => {
    if (!connectionId) return;
    const selectedPath = await open({ multiple: true, directory: false, title: "选择要上传的文件" });
    if (Array.isArray(selectedPath)) await uploadFiles(selectedPath);
    else if (typeof selectedPath === "string") await uploadFiles([selectedPath]);
  };

  const downloadTo = async (remotePath: string, localPath: string) => {
    if (!connectionId) return;
    await waitForTransfer((channel) =>
      api.sftpDownload(connectionId, remotePath, localPath, true, channel),
    );
  };

  const downloadDirectoryEntry = async (entry: RemoteEntry, localParent: string): Promise<number> => {
    if (!connectionId) return 0;
    const localDirectory = joinLocalPath(localParent, entry.name);
    await api.createLocalDirectory(localDirectory);
    const children = await api.sftpListDirectory(connectionId, entry.path);
    let downloaded = 0;
    for (const child of children) {
      if (child.fileType === "directory") downloaded += await downloadDirectoryEntry(child, localDirectory);
      else {
        await downloadTo(child.path, joinLocalPath(localDirectory, child.name));
        downloaded += 1;
      }
    }
    return downloaded;
  };

  const download = async (openAfterDownload: boolean) => {
    if (!connectionId || selectedEntries.length === 0) return;
    const files = selectedEntries.filter((entry) => entry.fileType !== "directory");
    const directories = selectedEntries.filter((entry) => entry.fileType === "directory");
    let localDirectory: string | null = null;
    let singleLocalPath: string | null = null;
    if (files.length === 1 && directories.length === 0) {
      singleLocalPath = await save({
        title: openAfterDownload ? "下载并打开远程文件" : "保存远程文件",
        defaultPath: files[0].name,
      });
      if (!singleLocalPath) return;
    } else {
      localDirectory = await open({
        title: `选择保存 ${selectedEntries.length} 项的目录`,
        directory: true,
        multiple: false,
      });
      if (typeof localDirectory !== "string") return;
    }
    try {
      let downloaded = 0;
      for (const [index, entry] of files.entries()) {
        const localPath = singleLocalPath ?? joinLocalPath(localDirectory!, entry.name);
        await downloadTo(entry.path, localPath);
        downloaded += 1;
        if (openAfterDownload && index === 0) await api.openLocalPath(localPath);
      }
      for (const directory of directories) downloaded += await downloadDirectoryEntry(directory, localDirectory!);
      setSelectedPaths(new Set());
      onToast?.(`${downloaded} 个文件已下载。`);
    } catch (caught) {
      setError(`下载失败：${String(caught)}`);
    }
  };

  const editRemote = async (entry: RemoteEntry = selected as RemoteEntry) => {
    if (!connectionId || !entry || entry.fileType === "directory") return;
    if (remoteEdit?.status === "downloading" || remoteEdit?.status === "uploading") {
      setError("当前远程文件仍在传输，请等待完成后再编辑其他文件");
      return;
    }
    try {
      const localPath = await api.prepareRemoteEditPath(entry.name);
      setRemoteEdit({
        remotePath: entry.path,
        fileName: entry.name,
        localPath,
        originalSize: entry.size,
        originalModifiedAtUnix: entry.modifiedAtUnix,
        status: "downloading",
      });
      await downloadTo(entry.path, localPath);
      setRemoteEdit((current) => current && current.remotePath === entry.path ? { ...current, status: "ready" } : current);
      await api.openLocalPath(localPath);
    } catch (caught) {
      setRemoteEdit(null);
      setError(`打开远程文件失败：${String(caught)}`);
    }
  };

  const reopenRemoteEdit = async () => {
    if (!remoteEdit) return;
    try {
      await api.openLocalPath(remoteEdit.localPath);
    } catch (caught) {
      setError(`打开本地编辑副本失败：${String(caught)}`);
    }
  };

  const uploadEditedFile = async () => {
    if (!connectionId || !remoteEdit || remoteEdit.status !== "ready") return;
    const edit = remoteEdit;
    setRemoteEdit({ ...edit, status: "uploading" });
    try {
      const latest = await api.sftpStat(connectionId, edit.remotePath);
      const changed = latest.size !== edit.originalSize || latest.modifiedAtUnix !== edit.originalModifiedAtUnix;
      if (changed && !window.confirm(`远程文件“${edit.fileName}”在下载后已发生变化。\n\n仍要覆盖远程文件吗？`)) {
        setRemoteEdit(edit);
        return;
      }
      await waitForTransfer((channel) =>
        api.sftpUpload(connectionId, edit.localPath, edit.remotePath, true, channel),
      );
      const saved = await api.sftpStat(connectionId, edit.remotePath);
      setRemoteEdit({
        ...edit,
        originalSize: saved.size,
        originalModifiedAtUnix: saved.modifiedAtUnix,
        status: "ready",
      });
      await load(connectionId, path);
    } catch (caught) {
      setRemoteEdit(edit);
      setError(`重新上传失败：${String(caught)}`);
    }
  };

  const retryTransfer = async (transfer: TransferEvent) => {
    if (!connectionId) return;
    setTransfers((current) => {
      const next = { ...current };
      delete next[transfer.transferId];
      return next;
    });
    try {
      if (transfer.direction === "upload") {
        await waitForTransfer((channel) =>
          api.sftpUpload(connectionId, transfer.localPath, transfer.remotePath, true, channel),
        );
        await load(connectionId, path);
      } else {
        await waitForTransfer((channel) =>
          api.sftpDownload(connectionId, transfer.remotePath, transfer.localPath, true, channel),
        );
      }
      onToast?.("传输重试已完成。");
    } catch (caught) {
      setError(`重试失败：${String(caught)}`);
    }
  };

  const removeTransfer = (transferId: string) => {
    setTransfers((current) => {
      const next = { ...current };
      delete next[transferId];
      return next;
    });
  };

  const clearFinishedTransfers = () => {
    setTransfers((current) => Object.fromEntries(
      Object.entries(current).filter(([, transfer]) => transfer.status === "queued" || transfer.status === "running" || transfer.status === "failed"),
    ));
  };

  const cancelActiveTransfers = async () => {
    const pendingCount = pendingUploads.length;
    uploadQueueCancelEpochRef.current += 1;
    cancelWaitingUploadSlots();
    const active = transferItems.filter((transfer) => transfer.status === "queued" || transfer.status === "running");
    await Promise.all(active.map((transfer) => api.cancelTransfer(transfer.transferId).catch(() => undefined)));
    setPendingUploads([]);
    onToast?.(`已请求取消 ${active.length + pendingCount} 个传输任务。`);
  };

  const selectEntry = (entry: RemoteEntry, event: MouseEvent<HTMLButtonElement>) => {
    const rangeStart = anchorPath ? entries.findIndex((candidate) => candidate.path === anchorPath) : -1;
    const rangeEnd = entries.findIndex((candidate) => candidate.path === entry.path);
    if (event.shiftKey && rangeStart >= 0 && rangeEnd >= 0) {
      const [start, end] = rangeStart < rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
      setSelectedPaths(new Set(entries.slice(start, end + 1).map((candidate) => candidate.path)));
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedPaths((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchorPath(entry.path);
    } else {
      setSelectedPaths(new Set([entry.path]));
      setAnchorPath(entry.path);
    }
  };

  const rename = async () => {
    if (!connectionId || selectedEntries.length !== 1 || !selected) return;
    const name = window.prompt("新的名称", selected.name)?.trim();
    if (!name || name === selected.name) return;
    if (!isValidRemoteName(name)) {
      setError("名称不能包含路径分隔符，也不能是 . 或 ..");
      return;
    }
    const target = path === "/" ? `/${name}` : `${path}/${name}`;
    await api.sftpRename(connectionId, selected.path, target)
      .then(() => load(connectionId, path))
      .catch((caught) => setError(`重命名失败：${String(caught)}`));
  };

  const createDirectory = async () => {
    if (!connectionId) return;
    const name = window.prompt("新目录名称");
    if (!name) return;
    const normalizedName = name.trim();
    if (!isValidRemoteName(normalizedName)) {
      setError("目录名称不能包含路径分隔符，也不能是 . 或 ..");
      return;
    }
    const target = path === "/" ? `/${normalizedName}` : `${path}/${normalizedName}`;
    await api.sftpCreateDirectory(connectionId, target).then(() => load(connectionId, path)).catch((caught) => setError(String(caught)));
  };

  const deleteRemoteEntry = async (entry: RemoteEntry, counter: { value: number }) => {
    if (!connectionId) return;
    counter.value += 1;
    if (counter.value > 10_000) throw new Error("递归删除超过 10000 项，已为安全起见停止");
    if (entry.fileType === "directory") {
      const children = await api.sftpListDirectory(connectionId, entry.path);
      for (const child of children) await deleteRemoteEntry(child, counter);
      await api.sftpDelete(connectionId, entry.path, true);
    } else {
      await api.sftpDelete(connectionId, entry.path, false);
    }
  };

  const remove = async () => {
    if (!connectionId || selectedEntries.length === 0) return;
    const names = selectedEntries.map((entry) => entry.name);
    const containsDirectory = selectedEntries.some((entry) => entry.fileType === "directory");
    const message = names.length === 1
      ? `确定删除 ${names[0]}？${containsDirectory ? "\n\n该目录中的全部子目录和文件也会被永久删除。" : ""}`
      : `确定删除选中的 ${names.length} 项？\n\n${names.slice(0, 8).join("、")}${names.length > 8 ? "…" : ""}${containsDirectory ? "\n\n选中目录中的全部内容也会被永久删除。" : ""}`;
    if (!window.confirm(message)) return;
    try {
      const counter = { value: 0 };
      for (const entry of selectedEntries) {
        await deleteRemoteEntry(entry, counter);
      }
      await load(connectionId, path);
      onToast?.(`已删除 ${counter.value} 项远程文件或目录。`);
    } catch (caught) {
      setError(`删除失败：${String(caught)}`);
    }
  };

  return (
    <aside className="sftp-panel">
      <header className="sftp-header">
        <div><strong>SFTP</strong><span>{session.name}</span></div>
        <button className="icon-button" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="sftp-toolbar">
        <button onClick={() => connectionId && load(connectionId, parentPath())} title="上级目录">..</button>
        <button onClick={() => void upload()} disabled={!connectionId} title="选择文件并上传到当前远程目录">
          <ArrowUpFromLine size={15} />
        </button>
        <button onClick={() => void download(false)} disabled={selectedEntries.length === 0} title="下载选中文件或目录">
          <ArrowDownToLine size={15} />
        </button>
        <button onClick={() => void download(true)} disabled={selectedEntries.length !== 1 || !selected || selected.fileType === "directory"} title="下载并打开">
          <ExternalLink size={15} />
        </button>
        <button onClick={() => void editRemote()} disabled={selectedEntries.length !== 1 || !selected || selected.fileType === "directory"} title="编辑远程文件">
          <Pencil size={14} />
        </button>
        <button onClick={createDirectory} title="新建目录"><FolderPlus size={15} /></button>
        <button onClick={rename} disabled={selectedEntries.length !== 1} title="重命名"><Pencil size={14} /></button>
        <button onClick={remove} disabled={selectedEntries.length === 0} title="删除选中项"><Trash2 size={15} /></button>
        <button onClick={() => connectionId && load(connectionId, path)} title="刷新远程目录"><RefreshCw size={15} /></button>
      </div>
      <div className="sftp-browser-head sftp-browser-head-single">
        <section>
          <Folder size={13} />
          <strong>远程目录</strong>
          <form className="remote-path" onSubmit={(event) => { event.preventDefault(); if (connectionId) void load(connectionId, pathInput); }}>
            <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} aria-label="远程路径" />
          </form>
        </section>
      </div>
      <div className="sftp-browser sftp-browser-single">
        <section className="sftp-browser-pane">
          <div className="sftp-pane-label">
            <span>{path}</span>
            <span>{selectedEntries.length > 0 ? `已选 ${selectedEntries.length}` : ""}</span>
          </div>
          <div className={`remote-list ${draggingFiles ? "dragging-files" : ""}`} ref={remoteListRef}>
            <div className="sftp-upload-hint" aria-live="polite">
              <ArrowUpFromLine size={16} />
              <div>
                <strong>{draggingFiles ? "松开鼠标即可上传" : "上传文件到当前目录"}</strong>
                <span>点击上方上传按钮选择文件，或直接拖入此区域</span>
              </div>
            </div>
            {loading && <div className="panel-message">读取远程目录…</div>}
            {error && <div className="panel-error">{error}</div>}
            {!loading && !error && entries.length === 0 && <div className="panel-message">当前目录为空。</div>}
            {!loading && !error && entries.map((entry) => (
              <button
                key={entry.path}
                className={`remote-entry ${selectedPaths.has(entry.path) ? "selected" : ""}`}
                onClick={(event) => selectEntry(entry, event)}
                onDoubleClick={() => entry.fileType === "directory" && connectionId ? void load(connectionId, entry.path) : void editRemote(entry)}
              >
                {entry.fileType === "directory" ? <Folder size={15} /> : <File size={15} />}
                <span className="remote-entry-name">{entry.name}</span>
                <span className="remote-entry-size">{entry.fileType === "directory" ? "—" : formatBytes(entry.size)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {(transferItems.length > 0 || pendingUploads.length > 0 || remoteEdit) && (
        <div className="transfer-list">
          {remoteEdit && (
            <div className="remote-edit-card">
              <div className="transfer-title">远程编辑</div>
              <div className="remote-edit-copy">
                <strong title={remoteEdit.localPath}>{remoteEdit.fileName}</strong>
                <small>{remoteEdit.status === "downloading" ? "正在下载…" : remoteEdit.status === "uploading" ? "正在重新上传…" : "已下载，编辑后点击重新上传"}</small>
              </div>
              <div className="remote-edit-actions">
                <button onClick={() => void reopenRemoteEdit()} disabled={remoteEdit.status !== "ready"}>打开副本</button>
                <button className="primary-button" onClick={() => void uploadEditedFile()} disabled={remoteEdit.status !== "ready"}>重新上传</button>
              </div>
            </div>
          )}
          {(transferItems.length > 0 || pendingUploads.length > 0) && (
            <>
              <div className="transfer-title transfer-title-row">
                <span>传输任务{pendingUploads.length ? ` · 队列 ${pendingUploads.length}` : ""}</span>
                <span className="transfer-list-actions">
                  {(pendingUploads.length > 0 || transferItems.some((transfer) => transfer.status === "queued" || transfer.status === "running")) && <button onClick={() => void cancelActiveTransfers()}>取消全部</button>}
                  {transferItems.some((transfer) => transfer.status === "completed" || transfer.status === "cancelled") && <button onClick={clearFinishedTransfers}>清理已结束</button>}
                </span>
              </div>
              {pendingUploads.map((task) => (
                <div className="pending-upload" key={task.id} title={task.localPath}>等待上传 · {task.localPath.split(/[\/]/).pop()}</div>
              ))}
              {transferItems.map((transfer) => {
                const percent = transfer.totalBytes ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100)) : 0;
                return (
                  <div className="transfer-item" key={transfer.transferId}>
                    <div className="transfer-copy">
                      <span>{transfer.direction === "upload" ? "上传" : "下载"} · {transfer.remotePath.split("/").pop()}</span>
                      <small className={`transfer-status ${transfer.status}`} title={transfer.error ?? undefined}>
                        {formatTransferStatus(transfer.status)} · {percent}% · {formatBytes(transfer.transferredBytes)}{transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
                      </small>
                      {transfer.error && <small className="transfer-error" title={transfer.error}>{transfer.error}</small>}
                    </div>
                    <div className="progress-track"><div className={transfer.status} style={{ width: `${percent}%` }} /></div>
                    <div className="transfer-actions">
                      {(transfer.status === "queued" || transfer.status === "running") && (
                        <button onClick={() => void api.cancelTransfer(transfer.transferId)} title="取消传输"><X size={12} /></button>
                      )}
                      {(transfer.status === "failed" || transfer.status === "cancelled") && (
                        <button onClick={() => void retryTransfer(transfer)} title="重试传输"><RefreshCw size={12} /></button>
                      )}
                      {(transfer.status === "completed" || transfer.status === "failed" || transfer.status === "cancelled") && (
                        <button onClick={() => removeTransfer(transfer.transferId)} title="移除任务"><Trash2 size={12} /></button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function isUploadCheckpoint(name: string) {
  return name.endsWith(".xsh-part") || name.endsWith(".xsh-part.meta") || name.endsWith(".xsh-part.meta.tmp");
}

function isValidRemoteName(value: string) {
  return Boolean(value) && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

function joinLocalPath(parent: string, child: string) {
  const separator = parent.includes("\\") ? "\\" : "/";
  const normalizedChild = child.replace(/[\\/]+/g, separator);
  return `${parent.replace(/[\\/]$/, "")}${separator}${normalizedChild}`;
}

function formatTransferStatus(status: TransferEvent["status"]) {
  return {
    queued: "等待中",
    running: "传输中",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
  }[status];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
