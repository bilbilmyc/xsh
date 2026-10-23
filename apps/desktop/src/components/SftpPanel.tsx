import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  Folder,
  FolderPlus,
  Home,
  Pencil,
  RefreshCw,
  Repeat2,
  Search,
  Trash2,
  TextCursorInput,
  X,
  Star,
  Columns2,
  TerminalSquare,
} from "lucide-react";
import { api } from "../api";
import { writeClipboardText } from "../clipboard";
import { ContextMenu } from "./ContextMenu";
import { SftpSyncModal } from "./SftpSyncModal";
import { TransferPlanModal } from "./TransferPlanModal";
import { TransferConflictModal } from "./TransferConflictModal";
import { planTransferBatch, transferParent, type ConflictChoice, type ConflictPolicy, type PlannedTransfer, type TransferConflict, type TransferDraft } from "../transfer-plan";
import { TransferCard, TransferFilters } from "./TransferCard";
import { hostKeyEndpointLabel } from "../host-key";
import { confirmDialog, hostKeyDialog, promptDialog } from "./DialogHost";
import { connectSftpWithHostKeyApprovals } from "../sftp-connection";
import {
  indexTransfersForConnection,
  isActiveTransferStatus,
  isTransferOwnedByConnection,
} from "../sftp-transfer-scope";
import { SftpTransferStore, matchesTransferFilter, sortTransfersForDisplay, transferFilterCounts, type TransferFilter } from "../transfer-queue";
import { browseRemoteEntries, remoteBreadcrumbs, selectBrowserPaths, type SftpSort, type SftpSortField } from "../sftp-browser";
import type { RemoteEntry, SavedSession, TransferEvent } from "../types";
import "./SftpPanel.css";
import { directoryWorkspaceKey, loadDirectoryWorkspace, rememberDirectory, saveDirectoryWorkspace, toggleDirectoryBookmark, type DirectoryWorkspace } from "../directory-workspace";
import { localParentDirectory } from "../transfer-queue";
import { LocalDirectoryPane } from "./LocalDirectoryPane";

interface SftpPanelProps {
  session: SavedSession;
  globalTransferConcurrency: number;
  onClose: () => void;
  onToast?: (message: string) => void;
  terminalDirectory?: string | null;
  onOpenTerminalDirectory?: (path: string) => void;
  onExpandedChange?: (expanded: boolean) => void;
  expanded?: boolean;
  locationRequest?: { id: string; path: string } | null;
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

export function SftpPanel({ session, globalTransferConcurrency, onClose, onToast, terminalDirectory, onOpenTerminalDirectory, onExpandedChange, expanded = false, locationRequest }: SftpPanelProps) {
  const submissionConcurrency = Math.min(32, Math.max(1, Math.floor(globalTransferConcurrency)));
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [path, setPath] = useState(session.initialDirectory ?? ".");
  const [pathInput, setPathInput] = useState(path);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [showHidden, setShowHidden] = useState(true);
  const [sort, setSort] = useState<SftpSort>({ field: "name", descending: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [listContextMenu, setListContextMenu] = useState<{ x: number; y: number; entry: RemoteEntry } | null>(null);
  const [remoteEdit, setRemoteEdit] = useState<RemoteEditState | null>(null);
  const [syncVisible, setSyncVisible] = useState(false);
  const workspaceKey = directoryWorkspaceKey(session);
  const [workspace, setWorkspace] = useState(() => loadDirectoryWorkspace(workspaceKey));
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const dualPane = expanded;
  const [followTerminal, setFollowTerminal] = useState(false);
  const appliedLocationRef = useRef<string | null>(null);
  const commitWorkspace = (change: (current: DirectoryWorkspace) => DirectoryWorkspace) => {
    const next = change(workspaceRef.current);
    workspaceRef.current = next;
    setWorkspace(next);
    if (!saveDirectoryWorkspace(workspaceKey, next)) onToast?.("目录偏好未能保存，本次窗口仍可使用。");
  };
  useEffect(() => {
    if (workspaceRef.current.localDirectory) return;
    let disposed = false;
    void api.localDownloadDirectory().then((directory) => {
      if (!disposed && !workspaceRef.current.localDirectory && directory) commitWorkspace((current) => ({ ...current, localDirectory: directory }));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [workspaceKey]);
  useEffect(() => () => onExpandedChange?.(false), []);
  const [transferDraft, setTransferDraft] = useState<TransferDraft | null>(null);
  const transferDraftRef = useRef<TransferDraft | null>(null);
  const [planning, setPlanning] = useState(false);
  const planningRef = useRef(false);
  const planningEpochRef = useRef(0);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [transferConflict, setTransferConflict] = useState<TransferConflict | null>(null);
  const activeConnectionRef = useRef<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const loadEpochRef = useRef(0);
  const requestedPathRef = useRef(path);
  const remoteListRef = useRef<HTMLDivElement>(null);
  const uploadQueueCancelEpochRef = useRef(0);
  const activeUploadCountRef = useRef(0);
  const uploadSlotWaitersRef = useRef<UploadSlotWaiter[]>([]);
  const conflictResolverRef = useRef<((choice: ConflictChoice | null) => void) | null>(null);
  const enqueueUploadsRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);

  const transferStoreRef = useRef<SftpTransferStore | null>(null);
  if (transferStoreRef.current === null) transferStoreRef.current = new SftpTransferStore();
  const transferStore = transferStoreRef.current;
  const visibleEntries = useMemo(
    () => browseRemoteEntries(entries, filterQuery, showHidden, sort),
    [entries, filterQuery, showHidden, sort],
  );
  const breadcrumbs = useMemo(() => remoteBreadcrumbs(path), [path]);
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );
  const selected = selectedEntries[0] ?? null;
  const selectedDirectoryCount = selectedEntries.filter((entry) => entry.fileType === "directory").length;
  const selectedSizeLabel = [
    selectedEntries.length > selectedDirectoryCount ? formatBytes(selectedEntries.filter((entry) => entry.fileType !== "directory").reduce((sum, entry) => sum + entry.size, 0)) : "",
    selectedDirectoryCount > 0 ? `${selectedDirectoryCount} 个目录` : "",
  ].filter(Boolean).join(" + ");
  const load = async (id: string, target: string) => {
    const epoch = ++loadEpochRef.current;
    requestedPathRef.current = target;
    setLoading(true);
    setError(null);
    try {
      const canonical = await api.sftpCanonicalize(id, target);
      const nextEntries = await api.sftpListDirectory(id, canonical);
      if (epoch !== loadEpochRef.current || activeConnectionRef.current !== id) return;
      setPath(canonical);
      setPathInput(canonical);
      setEntries(nextEntries);
      commitWorkspace((current) => rememberDirectory(current, canonical));
      setFilterQuery("");
      setSelectedPaths(new Set());
      setAnchorPath(null);
    } catch (caught) {
      if (epoch === loadEpochRef.current && activeConnectionRef.current === id) setError(String(caught));
    } finally {
      if (epoch === loadEpochRef.current && activeConnectionRef.current === id) setLoading(false);
    }
  };

  useEffect(() => {
    if (connectionId && followTerminal && terminalDirectory && terminalDirectory !== pathRef.current) void load(connectionId, terminalDirectory);
  }, [connectionId, followTerminal, terminalDirectory]);
  useEffect(() => {
    if (connectionId && locationRequest && appliedLocationRef.current !== locationRequest.id) {
      appliedLocationRef.current = locationRequest.id;
      setFollowTerminal(false);
      void load(connectionId, locationRequest.path);
    }
  }, [connectionId, locationRequest?.id]);

  useEffect(() => {
    let disposed = false;
    let activeId: string | null = null;

    const connect = async () => {
      activeConnectionRef.current = null;
      setConnectionId(null);
      setLoading(true);
      setError(null);
      setConnectionError(null);
      setEntries([]);
      setSelectedPaths(new Set());
      setAnchorPath(null);
      try {
        const id = await connectSftpWithHostKeyApprovals(
          () => api.connectSftp(session.id),
          async (key) => {
            if (disposed) return false;
            const endpointLabel = hostKeyEndpointLabel(key);
            if (!(await hostKeyDialog(key, "SFTP"))) {
              setConnectionError(`SFTP ${endpointLabel} 服务器指纹尚未确认，请核对后重新连接。`);
              return false;
            }
            await api.trustSessionHostKey(session.id, key);
            return !disposed;
          },
        );
        if (!id) {
          if (!disposed) setLoading(false);
          return;
        }
        if (disposed) {
          await api.disconnectSftp(id).catch(() => undefined);
          return;
        }
        activeId = id;
        activeConnectionRef.current = id;
        setConnectionId(id);
        await load(id, pathRef.current);
      } catch (caught) {
        if (disposed) return;
        const message = String(caught);
        setConnectionError(`SFTP 连接失败：${message}`);
        setLoading(false);
      }
    };

    void connect();
    return () => {
      disposed = true;
      loadEpochRef.current += 1;
      planningEpochRef.current += 1;
      planningRef.current = false;
      if (activeConnectionRef.current === activeId) activeConnectionRef.current = null;
      if (activeId) void api.releaseSftpConnection(activeId).catch(() => undefined);
    };
  }, [session.id, connectionAttempt]);

  useEffect(() => () => {
    uploadQueueCancelEpochRef.current += 1;
    const waiters = uploadSlotWaitersRef.current.splice(0);
    waiters.forEach((waiter) => waiter.resolve(false));
    const settleConflict = conflictResolverRef.current;
    conflictResolverRef.current = null;
    settleConflict?.(null);
  }, []);

  useEffect(() => {
    if (!connectionId) {
      transferStore.reset();
      return;
    }
    let disposed = false;
    const refreshTransfers = async () => {
      try {
        const next = await api.listTransfers();
        if (!disposed) {
          transferStore.replaceAll(indexTransfersForConnection(next.transfers, connectionId));
        }
      } catch {
        // A disconnected panel must not surface background polling errors.
      }
    };
    void refreshTransfers();
    const timer = window.setInterval(() => void refreshTransfers(), 750);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [connectionId, transferStore]);

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
        if (!rect) return;
        const scale = window.devicePixelRatio || 1;
        const x = payload.position.x / scale;
        const y = payload.position.y / scale;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        void enqueueUploadsRef.current(payload.paths);
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((caught) => {
        if (!disposed) setError(`启用文件拖拽失败：${String(caught)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const parentPath = () => {
    if (path === "/") return "/";
    const parts = path.replace(/\/$/, "").split("/");
    parts.pop();
    return parts.join("/") || "/";
  };

  const updateTransfer = (event: TransferEvent) => {
    if (!isTransferOwnedByConnection(event, connectionId)) return;
    transferStore.upsert(event);
  };

  const controlTransfer = async (
    transfer: TransferEvent,
    action: "pause" | "resume" | "cancel",
  ) => {
    if (!isTransferOwnedByConnection(transfer, connectionId)) {
      setError("该传输任务不属于当前 SFTP 连接");
      return;
    }
    try {
      const event = action === "pause"
        ? await api.pauseTransfer(transfer.transferId)
        : action === "resume"
          ? await api.resumeTransfer(transfer.transferId)
          : await api.cancelTransfer(transfer.transferId);
      updateTransfer(event);
    } catch (caught) {
      setError(`更新传输状态失败：${String(caught)}`);
    }
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
    // Attach both handlers immediately: a fast worker can report failure
    // before the invoke returning its transfer ID has settled.
    const [, result] = await Promise.all([start(channel), terminal]);
    if (result.status === "cancelled") throw new Error("传输已取消");
    return result;
  };

  const setDraft = (draft: TransferDraft | null) => {
    transferDraftRef.current = draft;
    setTransferDraft(draft);
    setPlanningError(null);
  };

  const settleConflict = (choice: ConflictChoice | null) => {
    const resolve = conflictResolverRef.current;
    conflictResolverRef.current = null;
    setTransferConflict(null);
    resolve?.(choice);
  };

  const cancelTransferPlan = () => {
    planningEpochRef.current += 1;
    planningRef.current = false;
    setPlanning(false);
    settleConflict(null);
    setDraft(null);
  };

  const uploadFiles = async (paths: string[], targetConnection = activeConnectionRef.current, destination = pathRef.current) => {
    if (!targetConnection || !paths.length) return;
    if (transferDraftRef.current || planningRef.current) { setError("请先处理当前传输确认窗口。"); return; }
    planningRef.current = true;
    try {
      const sources: RemoteEntry[] = [];
      for (const localPath of paths) {
        const info = await api.localFileInfo(localPath);
        if (activeConnectionRef.current !== targetConnection) return;
        if (!info || (info.fileType !== "file" && info.fileType !== "directory")) throw new Error("请选择普通文件或目录，符号链接及特殊文件不能上传。");
        sources.push(info);
      }
      setDraft({ id: crypto.randomUUID(), connectionId: targetConnection, host: session.username + "@" + session.host + ":" + session.port, direction: "upload", sources, destination, destinationKind: "directory" });
    } catch (caught) { setError("准备上传失败：" + String(caught)); }
    finally { planningRef.current = false; }
  };

  const enqueueUploads = async (paths: string[]) => {
    await uploadFiles(paths);
  };
  // The drag-drop handler reads through the ref; updating it in an effect
  // keeps the render phase free of side effects.
  useEffect(() => {
    enqueueUploadsRef.current = enqueueUploads;
  });

  const acquireUploadSlot = (cancelEpoch: number): Promise<boolean> => {
    if (uploadQueueCancelEpochRef.current !== cancelEpoch) return Promise.resolve(false);
    if (activeUploadCountRef.current < submissionConcurrency) {
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

  const runUploadQueue = async (tasks: PlannedTransfer[], targetConnection: string, targetDirectory: string, batchId: string) => {
    if (tasks.length === 0) return;
    const navigationEpoch = loadEpochRef.current;
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
            api.sftpUpload(targetConnection, task.localPath, task.remotePath, task.overwrite, channel, batchId),
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
    await Promise.all(Array.from({ length: Math.min(submissionConcurrency, queuedTasks.length) }, () => worker()));
    if (completed > 0 && activeConnectionRef.current === targetConnection && pathRef.current === targetDirectory && loadEpochRef.current === navigationEpoch) await load(targetConnection, targetDirectory);
    if (uploadQueueCancelEpochRef.current !== cancelEpoch) return;
    onToast?.(failed > 0 ? `上传完成 ${completed} 项，失败 ${failed} 项。` : `${completed} 个文件已上传。`);
  };

  const upload = async (directory = false) => {
    const targetConnection = activeConnectionRef.current;
    const destination = pathRef.current;
    if (!targetConnection) return;
    try {
      const selectedPath = await open({ multiple: true, directory, title: `上传${directory ? "目录" : "文件"}到 ${destination}` });
      if (Array.isArray(selectedPath)) await uploadFiles(selectedPath, targetConnection, destination);
      else if (typeof selectedPath === "string") await uploadFiles([selectedPath], targetConnection, destination);
    } catch (caught) {
      setError(`上传失败：${String(caught)}`);
    }
  };

  const downloadTo = async (remotePath: string, localPath: string) => {
    if (!connectionId) return;
    await waitForTransfer((channel) =>
      api.sftpDownload(connectionId, remotePath, localPath, true, channel),
    );
  };

  const runDownloadQueue = async (tasks: PlannedTransfer[], targetConnection: string, batchId: string) => {
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    const epoch = uploadQueueCancelEpochRef.current;
    const worker = async () => {
      while (cursor < tasks.length && epoch === uploadQueueCancelEpochRef.current && activeConnectionRef.current === targetConnection) {
        const task = tasks[cursor++];
        try {
          await waitForTransfer((channel) => api.sftpDownload(targetConnection, task.remotePath, task.localPath, task.overwrite, channel, batchId));
          completed += 1;
        } catch (caught) { failed += 1; setError("下载失败：" + String(caught)); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(submissionConcurrency, tasks.length) }, () => worker()));
    return { completed, failed };
  };

  const download = async (openAfterDownload: boolean) => {
    const targetConnection = activeConnectionRef.current;
    const sources = [...selectedEntries];
    if (!targetConnection || !sources.length) return;
    if (transferDraftRef.current || planningRef.current) { setError("请先处理当前传输确认窗口。"); return; }
    planningRef.current = true;
    try {
      const single = sources.length === 1 && sources[0].fileType !== "directory";
      const localDirectory = workspaceRef.current.localDirectory;
      const destination = localDirectory
        ? single ? `${localDirectory.replace(/[\\/]$/, "")}${localDirectory.includes("\\") ? "\\" : "/"}${sources[0].name}` : localDirectory
        : single
        ? await save({ title: openAfterDownload ? "下载并打开远程文件" : "保存远程文件", defaultPath: sources[0].name })
        : await open({ title: "选择下载保存目录", directory: true, multiple: false });
      if (typeof destination !== "string" || activeConnectionRef.current !== targetConnection) return;
      setDraft({ id: crypto.randomUUID(), connectionId: targetConnection, host: session.username + "@" + session.host + ":" + session.port, direction: "download", sources, destination, destinationKind: single ? "file" : "directory", openAfterDownload });
    } catch (caught) { setError("准备下载失败：" + String(caught)); }
    finally { planningRef.current = false; }
  };

  const confirmTransferPlan = async (destination: string, policy: ConflictPolicy) => {
    const draft = transferDraftRef.current;
    if (!draft || planningRef.current) return;
    setDraft({ ...draft, destination });
    const epoch = ++planningEpochRef.current;
    planningRef.current = true;
    setPlanning(true);
    setPlanningError(null);
    const assertConnected = () => {
      if (planningEpochRef.current !== epoch) throw new Error("本批传输已取消。");
      if (activeConnectionRef.current !== draft.connectionId) throw new Error("原 SFTP 连接已变化，请取消本批并重新选择文件。");
    };
    let submitted = false;
    try {
      assertConnected();
      let fixedDraft = { ...draft, destination };
      const sources: RemoteEntry[] = [];
      for (const source of draft.sources) {
        const current = draft.direction === "upload"
          ? await api.localFileInfo(source.path)
          : await api.sftpStat(draft.connectionId, source.path);
        assertConnected();
        if (!current || (current.fileType !== source.fileType && !(source.fileType === "symlink" && current.fileType === "file"))) throw new Error(`来源已变化，请重新选择：${source.path}`);
        sources.push({ ...current, fileType: source.fileType, name: source.name, path: source.path });
      }
      fixedDraft = { ...fixedDraft, sources };
      const remoteEntries = new Map<string, RemoteEntry>();
      const loadedRemoteDirectories = new Set<string>();
      const missingRemotePaths = new Set<string>();
      if (draft.direction === "upload") {
        const canonical = await api.sftpCanonicalize(draft.connectionId, destination);
        const listing = await api.sftpListDirectory(draft.connectionId, canonical);
        listing.forEach((entry) => remoteEntries.set(entry.path, entry));
        loadedRemoteDirectories.add(canonical);
        fixedDraft = { ...fixedDraft, destination: canonical };
      } else {
        const parent = draft.destinationKind === "directory" ? destination : transferParent(destination);
        const info = await api.localFileInfo(parent);
        if (!info || info.fileType !== "directory") throw new Error("保存目录不存在或不是普通文件夹，请重新选择。");
      }
      const plan = await planTransferBatch(fixedDraft, policy, {
        assertConnected,
        destinationInfo: async (target) => {
          if (draft.direction === "download") return api.localFileInfo(target);
          const parent = transferParent(target).replace(/\/+$/, "") || "/";
          if (!missingRemotePaths.has(parent) && !loadedRemoteDirectories.has(parent)) {
            const listing = await api.sftpListDirectory(draft.connectionId, parent);
            assertConnected();
            listing.forEach((entry) => remoteEntries.set(entry.path, entry));
            loadedRemoteDirectories.add(parent);
          }
          const existing = remoteEntries.get(target) ?? null;
          if (!existing) missingRemotePaths.add(target);
          return existing;
        },
        sourceChildren: (entry) => draft.direction === "upload" ? api.listLocalDirectory(entry.path) : api.sftpListDirectory(draft.connectionId, entry.path),
        choose: (conflict) => new Promise<ConflictChoice | null>((resolve) => { conflictResolverRef.current = resolve; setTransferConflict(conflict); }),
      });
      if (!plan) { setDraft(null); onToast?.("已取消本批传输。"); return; }
      assertConnected();
      // No file or directory is created before every decision in this batch is settled.
      for (const directory of plan.directories) {
        assertConnected();
        if (draft.direction === "upload") await api.sftpCreateDirectory(draft.connectionId, directory);
        else await api.createLocalDirectory(directory);
      }
      assertConnected();
      setDraft(null);
      if (draft.direction === "download") commitWorkspace((current) => ({ ...current, localDirectory: fixedDraft.destinationKind === "directory" ? fixedDraft.destination : localParentDirectory(fixedDraft.destination) }));
      planningRef.current = false;
      setPlanning(false);
      submitted = true;
      if (draft.direction === "upload") {
        await runUploadQueue(plan.tasks, draft.connectionId, fixedDraft.destination, draft.id);
        if (!plan.tasks.length && plan.directories.length) onToast?.(`已创建 ${plan.directories.length} 个远程目录。`);
      }
      else {
        const result = await runDownloadQueue(plan.tasks, draft.connectionId, draft.id);
        if (plan.openPath && result.completed === plan.tasks.length && !result.failed) await api.openLocalPath(plan.openPath);
        onToast?.(result.completed + " 个文件已下载" + (result.failed ? "，失败 " + result.failed + " 项" : "") + "。");
      }
      if (plan.skipped) onToast?.("本批跳过 " + plan.skipped + " 项。");
    } catch (caught) {
      if (planningEpochRef.current !== epoch) return;
      if (!submitted && transferDraftRef.current) setPlanningError(String(caught));
      else setError("传输失败：" + String(caught));
    } finally {
      if (!submitted && planningEpochRef.current === epoch) { planningRef.current = false; setPlanning(false); }
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
      if (changed && !(await confirmDialog({
        title: "远程文件已变化",
        message: `远程文件“${edit.fileName}”在下载后已发生变化。\n\n仍要覆盖远程文件吗？`,
        danger: true,
        confirmLabel: "覆盖",
      }))) {
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
    if (!isTransferOwnedByConnection(transfer, connectionId)) {
      setError("该传输任务不属于当前 SFTP 连接，无法在此重试");
      return;
    }
    const targetConnection = connectionId;
    const targetDirectory = path;
    const navigationEpoch = loadEpochRef.current;
    try {
      await waitForTransfer((channel) => api.retryTransfer(transfer.transferId, channel));
      if (transfer.direction === "upload" && activeConnectionRef.current === targetConnection && pathRef.current === targetDirectory && loadEpochRef.current === navigationEpoch) await load(targetConnection, targetDirectory);
      onToast?.("传输重试已完成。");
    } catch (caught) {
      setError(`重试失败：${String(caught)}`);
    }
  };

  const removeTransfer = async (transferId: string) => {
    if (!connectionId || transferStore.get(transferId)?.connectionId !== connectionId) return;
    await api.removeTransfer(transferId);
    transferStore.remove(transferId);
  };

  const clearFinishedTransfers = async () => {
    if (!connectionId) return;
    const finished = transferStore.list().filter((transfer) =>
      isTransferOwnedByConnection(transfer, connectionId)
      && !isActiveTransferStatus(transfer.status));
    await Promise.all(finished.map((transfer) => api.removeTransfer(transfer.transferId).catch(() => undefined)));
    transferStore.retainActiveOnly();
  };

  const cancelActiveTransfers = async () => {
    if (!connectionId) return;
    const pendingCount = pendingUploads.length;
    uploadQueueCancelEpochRef.current += 1;
    cancelWaitingUploadSlots();
    const active = transferStore.list().filter((transfer) =>
      isTransferOwnedByConnection(transfer, connectionId)
      && isActiveTransferStatus(transfer.status));
    const updates = await Promise.all(active.map((transfer) => api.cancelTransfer(transfer.transferId).catch(() => null)));
    transferStore.upsertAll(updates.filter((transfer): transfer is TransferEvent => transfer !== null));
    setPendingUploads([]);
    onToast?.(`已请求取消 ${active.length + pendingCount} 个传输任务。`);
  };

  const selectEntry = (entry: RemoteEntry, event: MouseEvent<HTMLButtonElement>) => {
    const next = selectBrowserPaths(visibleEntries.map((candidate) => candidate.path), selectedPaths, anchorPath, entry.path, event);
    setSelectedPaths(next.paths);
    setAnchorPath(next.anchor);
  };

  const rename = async () => {
    if (!connectionId || selectedEntries.length !== 1 || !selected) return;
    const name = await promptDialog({
      title: "重命名",
      initialValue: selected.name,
      confirmLabel: "重命名",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed || trimmed === selected.name) return null;
        return isValidRemoteName(trimmed)
          ? null
          : "名称不能包含路径分隔符，也不能是 . 或 ..";
      },
    });
    const trimmed = name?.trim();
    if (!trimmed || trimmed === selected.name) return;
    if (!isValidRemoteName(trimmed)) {
      setError("名称不能包含路径分隔符，也不能是 . 或 ..");
      return;
    }
    const target = path === "/" ? `/${trimmed}` : `${path}/${trimmed}`;
    await api.sftpRename(connectionId, selected.path, target)
      .then(() => load(connectionId, path))
      .catch((caught) => setError(`重命名失败：${String(caught)}`));
  };

  const createDirectory = async () => {
    if (!connectionId) return;
    const name = await promptDialog({
      title: "新建目录",
      placeholder: "目录名称",
      confirmLabel: "创建",
    });
    if (name === null) return;
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
    if (!(await confirmDialog({
      title: "删除远程项目",
      message,
      danger: true,
      confirmLabel: "删除",
    }))) return;
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
    <aside className="sftp-panel sftp-workspace" aria-label="远程文件">
      <header className="sftp-header">
        <div><strong>远程文件</strong><span>{session.name}</span><span className="sftp-connection-state" data-state={connectionId ? "connected" : connectionError ? "failed" : "connecting"}>{connectionId ? "文件已连接" : connectionError ? "文件未连接" : "正在连接文件服务…"}</span></div>
        <button className="icon-button" onClick={onClose} aria-label="关闭文件面板"><X size={16} /></button>
      </header>
      <div className="sftp-toolbar sftp-primary-actions">
        <button className="sftp-upload-button" onClick={() => void upload()} disabled={!connectionId || loading} title={`上传到 ${path}`}>
          <ArrowUpFromLine size={14} />上传文件
        </button>
        <button className="sftp-download-button" onClick={() => void download(false)} disabled={!connectionId || selectedEntries.length === 0} title="下载选中文件或目录到本地">
          <ArrowDownToLine size={14} />下载{selectedEntries.length > 0 ? ` (${selectedEntries.length})` : ""}
        </button>
        <details className="sftp-more-actions" onClick={(event) => { if ((event.target as HTMLElement).closest("button:not(:disabled)")) event.currentTarget.removeAttribute("open"); }}>
          <summary>更多<ChevronDown size={12} /></summary>
          <div className="sftp-more-menu">
            <button onClick={() => void upload(true)} disabled={!connectionId || loading}><FolderPlus size={13} />上传目录…</button>
            <button onClick={() => void download(true)} disabled={selectedEntries.length !== 1 || selected?.fileType === "directory"}><ExternalLink size={13} />下载并打开</button>
            <button onClick={() => void editRemote()} disabled={selectedEntries.length !== 1 || selected?.fileType === "directory"}><Pencil size={13} />编辑远程文件</button>
            <button onClick={() => setSyncVisible(true)} disabled={!connectionId}><Repeat2 size={13} />目录同步…</button>
            <button onClick={createDirectory} disabled={!connectionId}><FolderPlus size={13} />新建目录</button>
            <button onClick={rename} disabled={selectedEntries.length !== 1}><TextCursorInput size={13} />重命名</button>
            <button className="danger" onClick={remove} disabled={selectedEntries.length === 0}><Trash2 size={13} />删除选中项</button>
          </div>
        </details>
        <button className="sftp-refresh-button" disabled={loading} onClick={() => connectionId ? void load(connectionId, path) : setConnectionAttempt((value) => value + 1)} title={connectionId ? "刷新远程目录" : "重新连接文件服务"} aria-label={connectionId ? "刷新远程目录" : "重连文件服务"}><RefreshCw size={14} /></button>
      </div>
      <div className="sftp-location">
        <div className="sftp-path-row">
          <button type="button" disabled={!connectionId || loading || path === "/"} onClick={() => connectionId && void load(connectionId, parentPath())} title="上级目录" aria-label="上级目录"><ArrowUp size={14} /></button>
          <button type="button" disabled={!connectionId || loading} onClick={() => connectionId && void load(connectionId, session.initialDirectory ?? ".")} title="初始目录" aria-label="初始目录"><Home size={14} /></button>
          <form className="remote-path" onSubmit={(event) => { event.preventDefault(); if (connectionId && !loading && pathInput.trim()) void load(connectionId, pathInput.trim()); }}>
            <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} aria-label="远程路径" placeholder="输入路径并按 Enter" spellCheck={false} />
          </form>
        </div>
        <nav className="sftp-breadcrumbs" aria-label="远程目录导航">{breadcrumbs.map((crumb, index) => <span key={crumb.path}>
          {index > 0 && <ChevronRight size={11} />}<button type="button" disabled={!connectionId || loading} aria-current={index === breadcrumbs.length - 1 ? "location" : undefined} title={crumb.path} onClick={() => connectionId && void load(connectionId, crumb.path)}>{crumb.label}</button>
        </span>)}</nav>
        <div className="sftp-directory-tools">
          <button type="button" aria-label="收藏当前目录" aria-pressed={workspace.bookmarks.includes(path)} disabled={!connectionId || loading} onClick={() => commitWorkspace((current) => toggleDirectoryBookmark(current, path))}><Star size={12} fill={workspace.bookmarks.includes(path) ? "currentColor" : "none"} /></button>
          <select aria-label="目录书签与最近访问" value="" disabled={!connectionId || loading} onChange={(event) => { if (connectionId && event.target.value) { setFollowTerminal(false); void load(connectionId, event.target.value); } }}>
            <option value="">书签与最近目录</option><optgroup label="书签">{workspace.bookmarks.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup><optgroup label="最近访问">{workspace.recent.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup>
          </select>
          <button type="button" title={terminalDirectory ? `跟随 Shell 已报告的目录：${terminalDirectory}` : "需要 Shell 报告真实目录，可先启用 Shell 集成"} aria-pressed={followTerminal} disabled={!connectionId || !terminalDirectory} onClick={() => setFollowTerminal((value) => !value)}>跟随终端</button>
          <button type="button" title="在当前终端切换目录（Bash / Zsh），执行前需确认" aria-label="在此目录打开终端" disabled={!connectionId || !onOpenTerminalDirectory || loading} onClick={() => onOpenTerminalDirectory?.(path)}><TerminalSquare size={13} /></button>
        </div>
      </div>
      <div className="sftp-local-destination">
        <div><span>本地保存目录</span><strong title={workspace.localDirectory}>{workspace.localDirectory || "下载时选择"}</strong></div>
        <button type="button" onClick={() => { void open({ title: "选择本地下载目录", directory: true, multiple: false, defaultPath: workspace.localDirectory || undefined }).then((directory) => { if (typeof directory === "string") commitWorkspace((current) => ({ ...current, localDirectory: directory })); }).catch((caught) => setError(String(caught))); }}>选择…</button>
        <button type="button" aria-label="切换本地远程双栏" aria-pressed={dualPane} title={dualPane ? "收起文件工作区" : "展开文件工作区"} onClick={() => onExpandedChange?.(!dualPane)}><Columns2 size={14} /></button>
      </div>
      <div className={`sftp-browser ${dualPane ? "sftp-browser-dual" : "sftp-browser-single"}`}>
        {dualPane && <LocalDirectoryPane path={workspace.localDirectory} disabled={!connectionId || planning || loading} onNavigate={(directory) => commitWorkspace((current) => ({ ...current, localDirectory: directory }))} onUpload={(paths) => void uploadFiles(paths)} />}
        <section className="sftp-browser-pane">
          <div className="sftp-filter-row">
            <div className="sftp-search"><Search size={13} /><input aria-label="搜索当前目录" placeholder="搜索当前目录…" value={filterQuery} onChange={(event) => { setFilterQuery(event.target.value); setSelectedPaths(new Set()); setAnchorPath(null); }} />
              {filterQuery && <button type="button" aria-label="清空文件搜索" onClick={() => { setFilterQuery(""); setSelectedPaths(new Set()); setAnchorPath(null); }}><X size={12} /></button>}
            </div>
            <label className="sftp-hidden-toggle"><input type="checkbox" checked={showHidden} onChange={(event) => { setShowHidden(event.target.checked); setSelectedPaths(new Set()); setAnchorPath(null); }} />显示隐藏项</label>
          </div>
          <div className="sftp-column-head"><span />{([{ field: "name", label: "名称" }, { field: "modified", label: "修改时间" }, { field: "size", label: "大小" }] as { field: SftpSortField; label: string }[]).map((column) => <button type="button" key={column.field} data-sort={column.field} onClick={() => setSort((previous) => ({ field: column.field, descending: previous.field === column.field ? !previous.descending : column.field !== "name" }))}>{column.label}{sort.field === column.field && <span>{sort.descending ? "↓" : "↑"}</span>}</button>)}</div>
          <div className={`remote-list ${draggingFiles ? "dragging-files" : ""}`} ref={remoteListRef} aria-busy={loading}>
            {draggingFiles && <div className="sftp-drop-overlay"><ArrowUpFromLine size={24} /><strong>松开即可上传到此目录</strong><span>{path}</span></div>}
            {loading && <div className="panel-message">读取远程目录…</div>}
            {connectionError && <div className="panel-error sftp-recovery" role="alert"><p>{connectionError}</p><p>文件连接独立于终端，可在此重试。</p><button type="button" className="secondary-button" disabled={loading} onClick={() => setConnectionAttempt((value) => value + 1)}>重新连接文件服务</button></div>}
            {error && <div className="panel-error sftp-recovery" role="alert"><p>{error}</p>{connectionId && <div><button type="button" className="secondary-button" disabled={loading} onClick={() => void load(connectionId, requestedPathRef.current)}>重新读取目录</button><button type="button" className="ai-text-button" disabled={loading} onClick={() => setConnectionAttempt((value) => value + 1)}>重新连接</button></div>}</div>}
            {!loading && !error && !connectionError && entries.length === 0 && <div className="panel-message">当前目录为空。</div>}
            {!loading && entries.length > 0 && visibleEntries.length === 0 && <div className="panel-message">没有匹配的文件。<button type="button" className="sftp-inline-link" onClick={() => { setFilterQuery(""); setShowHidden(true); }}>显示全部文件</button></div>}
            {!loading && visibleEntries.map((entry) => (
              <button
                key={entry.path}
                className={`remote-entry ${selectedPaths.has(entry.path) ? "selected" : ""}`}
                aria-pressed={selectedPaths.has(entry.path)}
                title={entry.name}
                onClick={(event) => selectEntry(entry, event)}
                onDoubleClick={() => entry.fileType === "directory" && connectionId ? void load(connectionId, entry.path) : void editRemote(entry)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!selectedPaths.has(entry.path)) selectEntry(entry, event);
                  setListContextMenu({ x: event.clientX, y: event.clientY, entry });
                }}
              >
                {entry.fileType === "directory" ? <Folder size={15} /> : <File size={15} />}
                <span className="remote-entry-name">{entry.name}</span>
                <span className="remote-entry-time">{formatRemoteTimestamp(entry.modifiedAtUnix)}</span>
                <span className="remote-entry-size">{entry.fileType === "directory" ? "—" : formatBytes(entry.size)}</span>
              </button>
            ))}
          </div>
          <button type="button" className="sftp-drop-hint" disabled={!connectionId || loading} onClick={() => void upload()}><ArrowUpFromLine size={13} /><span>拖入文件上传，或点击选择文件</span></button>
          <div className="sftp-directory-summary"><span>{selectedEntries.length > 0 ? `已选 ${selectedEntries.length} 项 · ${selectedSizeLabel}` : `${visibleEntries.length} 项${visibleEntries.length !== entries.length ? ` / 共 ${entries.length} 项` : ""}`}</span><span>Ctrl / ⌘ 多选 · Shift 连选</span></div>
        </section>
      </div>
      {listContextMenu && (
        <ContextMenu
          x={listContextMenu.x}
          y={listContextMenu.y}
          onClose={() => setListContextMenu(null)}
          items={[
            ...(listContextMenu.entry.fileType === "file"
              ? [
                  { label: "下载", onClick: () => void download(false) },
                  { label: "编辑", onClick: () => void editRemote(listContextMenu.entry) },
                ]
              : []),
            { label: "重命名", onClick: () => void rename() },
            {
              label: "复制路径",
              onClick: () => {
                void writeClipboardText(listContextMenu.entry.path)
                  .then(() => onToast?.(`已复制：${listContextMenu.entry.path}`))
                  .catch(() => onToast?.("复制失败，请检查系统剪贴板权限。"));
              },
            },
            { label: "删除", onClick: () => void remove(), danger: true, separatorBefore: true },
          ]}
        />
      )}
      <SftpTransferSection
        store={transferStore}
        pendingUploads={pendingUploads}
        remoteEdit={remoteEdit}
        onControlTransfer={(transfer, action) => void controlTransfer(transfer, action)}
        onRetry={(transfer) => void retryTransfer(transfer)}
        onRemove={(transferId) => void removeTransfer(transferId)}
        onCancelActive={() => void cancelActiveTransfers()}
        onClearFinished={() => void clearFinishedTransfers()}
        onReopenRemoteEdit={() => void reopenRemoteEdit()}
        onUploadEditedFile={() => void uploadEditedFile()}
        onError={setError}
      />
      {transferDraft && !transferConflict && <TransferPlanModal key={transferDraft.id} draft={transferDraft} busy={planning} error={planningError} onConfirm={(destination, policy) => void confirmTransferPlan(destination, policy)} onCancel={cancelTransferPlan} />}
      {transferConflict && transferDraft && <TransferConflictModal key={transferConflict.destinationPath} conflict={transferConflict} direction={transferDraft.direction} onConfirm={settleConflict} onCancel={() => settleConflict(null)} />}
      {syncVisible && connectionId && <SftpSyncModal
        connectionId={connectionId}
        initialRemotePath={path}
        onClose={() => setSyncVisible(false)}
        onRefreshRemote={() => void load(connectionId, path)}
        onToast={(message) => onToast?.(message)}
      />}
    </aside>
  );
}

function isValidRemoteName(value: string) {
  return Boolean(value) && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

interface SftpTransferSectionProps {
  store: SftpTransferStore;
  pendingUploads: PendingUpload[];
  remoteEdit: RemoteEditState | null;
  onControlTransfer: (transfer: TransferEvent, action: "pause" | "resume" | "cancel") => void;
  onRetry: (transfer: TransferEvent) => void;
  onRemove: (transferId: string) => void;
  onCancelActive: () => void;
  onClearFinished: () => void;
  onReopenRemoteEdit: () => void;
  onUploadEditedFile: () => void;
  onError: (message: string) => void;
}

/**
 * Subscribes to the transfer store directly so per-progress re-renders stay
 * inside this section; the rest of the SFTP panel (directory listing, toolbars)
 * renders independently of transfer events.
 */
function SftpTransferSection({
  store,
  pendingUploads,
  remoteEdit,
  onControlTransfer,
  onRetry,
  onRemove,
  onCancelActive,
  onClearFinished,
  onReopenRemoteEdit,
  onUploadEditedFile,
  onError,
}: SftpTransferSectionProps) {
  const [filter, setFilter] = useState<TransferFilter>("all");
  const [collapsed, setCollapsed] = useState(true);
  const transfers = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const transferItems = useMemo(
    () => sortTransfersForDisplay(Object.values(transfers)),
    [transfers],
  );
  const counts = useMemo(() => transferFilterCounts(transferItems), [transferItems]);
  const visibleTransfers = useMemo(() => transferItems.filter((transfer) => matchesTransferFilter(transfer, filter)), [transferItems, filter]);
  if (transferItems.length === 0 && pendingUploads.length === 0 && !remoteEdit) return null;
  return (
    <section className="transfer-list sftp-transfer-section" data-collapsed={collapsed} aria-label="当前连接的传输任务">
      {remoteEdit && (
        <div className="remote-edit-card">
          <div className="transfer-title">远程编辑</div>
          <div className="remote-edit-copy">
            <strong title={remoteEdit.localPath}>{remoteEdit.fileName}</strong>
            <small>{remoteEdit.status === "downloading" ? "正在下载…" : remoteEdit.status === "uploading" ? "正在重新上传…" : "已下载，编辑后点击重新上传"}</small>
          </div>
          <div className="remote-edit-actions">
            <button onClick={onReopenRemoteEdit} disabled={remoteEdit.status !== "ready"}>打开副本</button>
            <button className="primary-button" onClick={onUploadEditedFile} disabled={remoteEdit.status !== "ready"}>重新上传</button>
          </div>
        </div>
      )}
      {(transferItems.length > 0 || pendingUploads.length > 0) && (
        <>
          <div className="transfer-title transfer-title-row">
            <button type="button" className="transfer-section-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed((previous) => !previous)}><ChevronDown size={13} />传输任务<span>{counts.active + pendingUploads.length > 0 ? `${counts.active + pendingUploads.length} 项进行中` : `${counts.all} 项`}</span>{counts.failed > 0 && <span className="transfer-failure-count">{counts.failed} 项失败</span>}</button>
            <span className="transfer-list-actions">
              {(pendingUploads.length > 0 || transferItems.some((transfer) => isActiveTransferStatus(transfer.status))) && <button onClick={onCancelActive}>取消全部</button>}
              {transferItems.some((transfer) => !isActiveTransferStatus(transfer.status)) && <button onClick={onClearFinished}>清理已结束</button>}
            </span>
          </div>
          {!collapsed && <>
            <TransferFilters value={filter} counts={{ ...counts, all: counts.all + pendingUploads.length, active: counts.active + pendingUploads.length }} onChange={setFilter} />
            {(filter === "all" || filter === "active") && pendingUploads.map((task) => (
              <div className="pending-upload" key={task.id} title={`${task.localPath} → ${task.remotePath}`}>待提交 · {task.localPath.split(/[\\/]/).pop()}</div>
            ))}
            {visibleTransfers.map((transfer) => <TransferCard key={transfer.transferId} transfer={transfer} onControl={onControlTransfer} onRetry={onRetry} onRemove={(item) => onRemove(item.transferId)} onError={onError} />)}
            {visibleTransfers.length === 0 && !((filter === "all" || filter === "active") && pendingUploads.length) && <p className="transfer-empty-filter">此分类暂无任务</p>}
          </>}
        </>
      )}
    </section>
  );
}

function formatRemoteTimestamp(modifiedAtUnix: number | null): string {
  if (modifiedAtUnix === null || !Number.isFinite(modifiedAtUnix) || modifiedAtUnix <= 0) return "";
  const date = new Date(modifiedAtUnix * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const pad = (value: number) => String(value).padStart(2, "0");
  const datePart = sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return datePart;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
