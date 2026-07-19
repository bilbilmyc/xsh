import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  Command,
  Columns2,
  Download,
  History,
  Rows2,
  Square,
  Files,
  FileKey,
  Globe2,
  Lock,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Upload,
  X,
} from "lucide-react";
import { api } from "./api";
import { CommandCenterModal } from "./components/CommandCenterModal";
import { ConnectionManagerModal } from "./components/ConnectionManagerModal";
import { CommandHistoryModal } from "./components/CommandHistoryModal";
import { ContextMenu } from "./components/ContextMenu";
import { DiagnosticModal } from "./components/DiagnosticModal";
import { GroupEditorModal } from "./components/GroupEditorModal";
import { SshConfigModal } from "./components/SshConfigModal";
import { QuickCommandBar } from "./components/QuickCommandBar";
import { PortForwardModal } from "./components/PortForwardModal";
import { SessionBatchEditorModal, type SessionBatchUpdates } from "./components/SessionBatchEditorModal";
import { SessionEditor } from "./components/SessionEditor";
import { SettingsModal } from "./components/SettingsModal";
import { SessionSidebar, type SessionActivitySummary } from "./components/SessionSidebar";
import { WorkspaceManagerModal } from "./components/WorkspaceManagerModal";
import type { TerminalCommandRequest } from "./components/TerminalPane";
import { loadCommandLibrary, saveCommandLibrary, type CommandSnippet } from "./command-library";
import { loadCommandHistory, recordCommandHistory, saveCommandHistory, type CommandHistoryEntry } from "./command-history";
import { loadRecentSessions, pruneRecentSessions, recordRecentSession, type RecentSession } from "./recent-sessions";
import { loadQuickCommandBar, saveQuickCommandBar, type QuickCommandItem } from "./quick-command-bar";
import { loadPreferences, savePreferences, type AppPreferences } from "./preferences";
import {
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  type NamedWorkspace,
  type WorkspacePaneLayout,
  type WorkspaceSnapshot,
} from "./workspace-state";
import { defaultTerminalProfile, type SavedSession, type SessionDraft, type SessionGroup, type SessionGroupDraft, type SshConfigEntry, type SshDiagnosticReport } from "./types";
import "./App.css";

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({ default: module.TerminalPane })),
);
const SftpPanel = lazy(() =>
  import("./components/SftpPanel").then((module) => ({ default: module.SftpPanel })),
);

type GroupEditorState =
  | { mode: "create"; parentId: string | null }
  | { mode: "rename"; group: SessionGroup };

type PaneLayout = WorkspacePaneLayout;

const IS_MACOS = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const PANE_LAYOUT_STORAGE_KEY = "xsh.pane-layout.v1";
const SPLIT_RATIO_STORAGE_KEY = "xsh.split-ratio.v1";
const SIDEBAR_VISIBLE_STORAGE_KEY = "xsh.sidebar-visible.v1";
const MIN_SPLIT_RATIO = 15;
const MAX_SPLIT_RATIO = 85;

function loadSplitRatio(): number {
  const value = Number(window.localStorage.getItem(SPLIT_RATIO_STORAGE_KEY));
  return Number.isFinite(value) ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value)) : 50;
}

function loadSidebarVisible(): boolean {
  return window.localStorage.getItem(SIDEBAR_VISIBLE_STORAGE_KEY) !== "false";
}

function loadPaneLayout(): PaneLayout {
  const value = window.localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
  return value === "vertical" || value === "horizontal" ? value : "single";
}

interface TerminalTab {
  id: string;
  session: SavedSession;
  state: string;
  connectionVersion: number;
  locked: boolean;
  color: string | null;
}

const TAB_LABELS_STORAGE_KEY = "xsh.tab-labels.v1";

function loadTabLabels(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(TAB_LABELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function saveTabLabels(labels: Record<string, string>) {
  window.localStorage.setItem(TAB_LABELS_STORAGE_KEY, JSON.stringify(labels));
}

function connectionStateLabel(state: string): string {
  switch (state) {
    case "connected": return "已连接";
    case "connecting": return "连接中";
    case "reconnecting": return "重连中";
    case "waiting-network": return "等待网络";
    case "authenticating": return "认证中";
    case "awaitingHostKey": return "等待密钥确认";
    case "disconnecting": return "断开中";
    case "disconnected": return "已断开";
    case "failed": return "连接失败";
    default: return state || "未知状态";
  }
}

function normalizeTabColor(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function App() {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editorSession, setEditorSession] = useState<SavedSession | null | undefined>();
  const [groupEditor, setGroupEditor] = useState<GroupEditorState | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadPreferences());
  const [sftpVisible, setSftpVisible] = useState(false);
  const [portForwardVisible, setPortForwardVisible] = useState(false);
  const [connectionIds, setConnectionIds] = useState<Record<string, string | null>>({});
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [sshConfigVisible, setSshConfigVisible] = useState(false);
  const [sshConfigEntries, setSshConfigEntries] = useState<SshConfigEntry[]>([]);
  const [sshConfigLoading, setSshConfigLoading] = useState(false);
  const [commandCenterVisible, setCommandCenterVisible] = useState(false);
  const [commands, setCommands] = useState<CommandSnippet[]>(() => loadCommandLibrary());
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>(() => loadCommandHistory());
  const [historyVisible, setHistoryVisible] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>(() => loadRecentSessions());
  const [quickCommands, setQuickCommands] = useState<Array<QuickCommandItem | null>>(() => loadQuickCommandBar());
  const [pendingTerminalCommands, setPendingTerminalCommands] = useState<Record<string, TerminalCommandRequest>>({});
  const [paneLayout, setPaneLayout] = useState<PaneLayout>(() => loadPaneLayout());
  const [splitRatio, setSplitRatio] = useState(() => loadSplitRatio());
  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(() => loadSidebarVisible());
  const [broadcastEnabled, setBroadcastEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [diagnosticSession, setDiagnosticSession] = useState<SavedSession | null>(null);
  const [diagnosticReport, setDiagnosticReport] = useState<SshDiagnosticReport | null>(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabLabels, setTabLabels] = useState<Record<string, string>>(() => loadTabLabels());
  const [sessionDataReady, setSessionDataReady] = useState(false);
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const [workspaceManagerVisible, setWorkspaceManagerVisible] = useState(false);
  const [connectionManagerVisible, setConnectionManagerVisible] = useState(false);
  const [batchEditorSessions, setBatchEditorSessions] = useState<SavedSession[]>([]);
  const workspaceRestoreStartedRef = useRef(false);
  const terminalStageRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const [nextGroups, nextSessions] = await Promise.all([
      api.listGroups(),
      api.listSessions(),
    ]);
    setGroups(nextGroups);
    setSessions(nextSessions);
    setSessionDataReady(true);
  }, []);

  useEffect(() => {
    refresh()
      .catch((error) => setToast(`加载本地数据失败：${String(error)}`))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    setRecentSessions(pruneRecentSessions(sessions.map((session) => session.id)));
  }, [loading, sessions]);

  useEffect(() => {
    if (!sessionDataReady || workspaceRestoreStartedRef.current) return;
    workspaceRestoreStartedRef.current = true;
    const snapshot = loadWorkspaceSnapshot();
    if (snapshot) {
      const sessionsById = new Map(sessions.map((session) => [session.id, session]));
      const restoredTabs = snapshot.tabs.flatMap((tab) => {
        const session = sessionsById.get(tab.sessionId);
        return session
          ? [{ id: tab.id, session, state: "connecting", connectionVersion: 0, locked: tab.locked, color: tab.color }]
          : [];
      });
      const restoredIds = new Set(restoredTabs.map((tab) => tab.id));
      const restoredActiveId = snapshot.activeTabId && restoredIds.has(snapshot.activeTabId)
        ? snapshot.activeTabId
        : restoredTabs[0]?.id ?? null;
      const restoredSecondaryId = snapshot.secondaryTabId &&
        restoredIds.has(snapshot.secondaryTabId) &&
        snapshot.secondaryTabId !== restoredActiveId
        ? snapshot.secondaryTabId
        : restoredTabs.find((tab) => tab.id !== restoredActiveId)?.id ?? null;
      const restoredLayout = snapshot.paneLayout !== "single" && restoredTabs.length < 2
        ? "single"
        : snapshot.paneLayout;
      setTabs(restoredTabs);
      setActiveTabId(restoredActiveId);
      setSecondaryTabId(restoredSecondaryId);
      setPaneLayout(restoredLayout);
      window.localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, restoredLayout);
    }
    setWorkspaceRestored(true);
  }, [sessionDataReady, sessions]);

  useEffect(() => {
    if (!workspaceRestored) return;
    saveWorkspaceSnapshot({
      tabs: tabs.map((tab) => ({ id: tab.id, sessionId: tab.session.id, locked: tab.locked, color: tab.color })),
      activeTabId,
      secondaryTabId,
      paneLayout,
    });
  }, [activeTabId, paneLayout, secondaryTabId, tabs, workspaceRestored]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );

  const activityBySessionId = useMemo<Record<string, SessionActivitySummary>>(() => {
    const result: Record<string, SessionActivitySummary> = {};
    tabs.forEach((tab) => {
      const activity = result[tab.session.id] ?? {
        openTabs: 0,
        connected: 0,
        connecting: 0,
        reconnecting: 0,
        waitingNetwork: 0,
        failed: 0,
        disconnected: 0,
      };
      activity.openTabs += 1;
      if (tab.state === "connected") activity.connected += 1;
      else if (tab.state === "reconnecting") activity.reconnecting += 1;
      else if (tab.state === "waiting-network") activity.waitingNetwork += 1;
      else if (tab.state === "failed") activity.failed += 1;
      else if (tab.state === "disconnected") activity.disconnected += 1;
      else activity.connecting += 1;
      result[tab.session.id] = activity;
    });
    return result;
  }, [tabs]);

  const currentWorkspaceSnapshot = useMemo<Omit<WorkspaceSnapshot, "version">>(() => ({
    tabs: tabs.map((tab) => ({ id: tab.id, sessionId: tab.session.id, locked: tab.locked, color: tab.color })),
    activeTabId,
    secondaryTabId,
    paneLayout,
  }), [activeTabId, paneLayout, secondaryTabId, tabs]);

  useEffect(() => {
    if (paneLayout === "single") return;
    if (tabs.length < 2) {
      setPaneLayout("single");
      setSecondaryTabId(null);
      window.localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, "single");
      return;
    }
    if (secondaryTabId && tabs.some((tab) => tab.id === secondaryTabId && tab.id !== activeTabId)) return;
    setSecondaryTabId(tabs.find((tab) => tab.id !== activeTabId)?.id ?? null);
  }, [activeTabId, paneLayout, secondaryTabId, tabs]);

  const updatePaneLayout = (next: PaneLayout) => {
    if (next !== "single" && tabs.length < 2) {
      setToast("至少打开两个会话才能分屏。");
      return;
    }
    setPaneLayout(next);
    if (next !== "single" && !secondaryTabId) {
      setSecondaryTabId(tabs.find((tab) => tab.id !== activeTabId)?.id ?? null);
    }
    window.localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, next);
  };

  const updateSplitRatio = (next: number) => {
    const normalized = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, Math.round(next * 10) / 10));
    setSplitRatio(normalized);
    window.localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(normalized));
  };

  const beginSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paneLayout === "single" || !terminalStageRef.current) return;
    event.preventDefault();
    const stage = terminalStageRef.current;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    document.body.classList.add("resizing-terminal-split");

    const move = (moveEvent: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      const next = paneLayout === "vertical"
        ? ((moveEvent.clientX - rect.left) / Math.max(rect.width, 1)) * 100
        : ((moveEvent.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
      updateSplitRatio(next);
    };
    const finish = () => {
      document.body.classList.remove("resizing-terminal-split");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const toggleSidebar = () => {
    setSidebarVisible((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_VISIBLE_STORAGE_KEY, String(next));
      return next;
    });
  };

  const focusTab = (tabId: string) => {
    if (paneLayout !== "single" && tabId === secondaryTabId && activeTabId) {
      setSecondaryTabId(activeTabId);
    }
    setActiveTabId(tabId);
  };

  const focusOtherSplitPane = () => {
    if (paneLayout === "single" || !activeTabId || !secondaryTabId) return;
    setActiveTabId(secondaryTabId);
    setSecondaryTabId(activeTabId);
  };

  const getTabLabel = (tab: TerminalTab) => tabLabels[tab.session.id]?.trim() || tab.session.name;

  const renameTab = (tab: TerminalTab) => {
    const currentLabel = getTabLabel(tab);
    const nextLabel = window.prompt("设置标签显示名称", currentLabel);
    if (nextLabel === null) return;
    const trimmed = nextLabel.trim().slice(0, 80);
    const next = { ...tabLabels };
    if (!trimmed || trimmed === tab.session.name) delete next[tab.session.id];
    else next[tab.session.id] = trimmed;
    setTabLabels(next);
    saveTabLabels(next);
  };

  const reorderTabs = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setTabs((current) => {
      const sourceIndex = current.findIndex((tab) => tab.id === sourceId);
      const targetIndex = current.findIndex((tab) => tab.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const canExecuteCommand = activeTab?.state === "connected";
  const commandExecutionUnavailableReason = !activeTab
    ? "请先打开一个 SSH 会话。"
    : activeTab.state === "connected"
      ? ""
      : `“${activeTab.session.name}”尚未连接完成。`;

  const saveCommands = (next: CommandSnippet[]) => {
    setCommands(next);
    saveCommandLibrary(next);
  };

  const saveQuickCommands = (next: Array<QuickCommandItem | null>) => {
    setQuickCommands(next);
    saveQuickCommandBar(next);
  };

  const queueTextForActiveTerminal = (
    label: string,
    text: string,
    source: "命令中心" | "快捷命令" | "命令历史",
  ) => {
    const targets = broadcastEnabled
      ? tabs.filter((tab) => tab.state === "connected")
      : activeTab && activeTab.state === "connected" ? [activeTab] : [];
    if (targets.length === 0) {
      setToast(commandExecutionUnavailableReason);
      return;
    }
    const requestId = crypto.randomUUID();
    const request = { id: requestId, text };
    setPendingTerminalCommands((current) => Object.fromEntries([
      ...Object.entries(current),
      ...targets.map((tab) => [tab.id, request] as const),
    ]));
    if (source !== "命令历史" && activeTab) {
      const historySource = source === "命令中心" ? "command-center" : "quick-command";
      const nextHistory = recordCommandHistory(commandHistory, {
        sessionId: activeTab.session.id,
        sessionName: activeTab.session.name,
        command: text,
        source: historySource,
      });
      setCommandHistory(nextHistory);
    }
    setToast(`已通过${source}向 ${targets.length > 1 ? `${targets.length} 个会话` : `“${targets[0].session.name}”`}发送：${label}`);
  };

  const handleTerminalStateChange = (tabId: string, sessionId: string, state: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, state } : tab));
    if (state === "connected") {
      setRecentSessions(recordRecentSession(sessionId));
    }
  };

  const queueCommandForActiveTerminal = (command: CommandSnippet) => {
    if (!activeTab || activeTab.state !== "connected") {
      setToast(commandExecutionUnavailableReason);
      return;
    }
    setCommandCenterVisible(false);
    queueTextForActiveTerminal(command.name, command.command, "命令中心");
  };

  const sendQuickCommand = (item: QuickCommandItem, text: string) => {
    queueTextForActiveTerminal(item.label, text, "快捷命令");
  };

  const handleCommandResult = (result: { id: string; ok: boolean; error?: string }) => {
    setPendingTerminalCommands((current) => Object.fromEntries(
      Object.entries(current).filter(([, request]) => request.id !== result.id),
    ));
    if (!result.ok) setToast(`命令发送失败：${result.error ?? "未知错误"}`);
  };

  const runDiagnostic = async (session: SavedSession) => {
    setDiagnosticSession(session);
    setDiagnosticReport(null);
    setDiagnosticError(null);
    setDiagnosticLoading(true);
    try {
      setDiagnosticReport(await api.diagnoseSession(session.id));
    } catch (error) {
      setDiagnosticError(String(error));
    } finally {
      setDiagnosticLoading(false);
    }
  };

  const openSession = (session: SavedSession) => {
    const existing = tabs.find((tab) => tab.session.id === session.id);
    if (existing) {
      // Opening an already active session only focuses its existing terminal.
      // Reconnecting here would discard shell state and differs from Xshell/SecureCRT.
      focusTab(existing.id);
      return;
    }
    const tab: TerminalTab = {
      id: crypto.randomUUID(),
      session,
      state: "connecting",
      connectionVersion: 0,
      locked: false,
      color: normalizeTabColor(session.color),
    };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  };

  const openGroupSessions = (group: SessionGroup) => {
    const includedGroupIds = new Set([group.id]);
    let changed = true;
    while (changed) {
      changed = false;
      groups.forEach((candidate) => {
        if (candidate.parentId && includedGroupIds.has(candidate.parentId) && !includedGroupIds.has(candidate.id)) {
          includedGroupIds.add(candidate.id);
          changed = true;
        }
      });
    }
    const groupSessions = sessions.filter((session) => session.groupId && includedGroupIds.has(session.groupId));
    if (groupSessions.length === 0) {
      setToast(`目录“${group.name}”中没有会话。`);
      return;
    }

    const existingBySessionId = new Map(tabs.map((tab) => [tab.session.id, tab]));
    const unopened = groupSessions.filter((session) => !existingBySessionId.has(session.id));
    const openLimit = 24;
    if (unopened.length > 12 && !window.confirm(
      `目录“${group.name}”中有 ${unopened.length} 个尚未打开的会话。批量连接会同时建立多个 SSH 连接，是否继续？${unopened.length > openLimit ? `\n\n为避免瞬时资源占用，本次最多打开前 ${openLimit} 个。` : ""}`,
    )) return;

    const sessionsToOpen = unopened.slice(0, openLimit);
    const additions: TerminalTab[] = sessionsToOpen.map((session) => ({
      id: crypto.randomUUID(),
      session,
      state: "connecting",
      connectionVersion: 0,
      locked: false,
      color: normalizeTabColor(session.color),
    }));
    if (additions.length > 0) setTabs((current) => [...current, ...additions]);

    const firstSession = groupSessions[0];
    const targetTabId = existingBySessionId.get(firstSession.id)?.id ??
      additions.find((tab) => tab.session.id === firstSession.id)?.id ??
      additions[0]?.id;
    if (targetTabId) setActiveTabId(targetTabId);

    const reused = groupSessions.length - unopened.length;
    const omitted = Math.max(0, unopened.length - additions.length);
    const details = [
      additions.length > 0 ? `新建 ${additions.length} 个连接` : "没有新建连接",
      reused > 0 ? `复用 ${reused} 个已打开标签` : "",
      omitted > 0 ? `另有 ${omitted} 个会话未打开` : "",
    ].filter(Boolean).join("，");
    setToast(`已打开目录“${group.name}”：${details}。`);
  };

  const closeTab = (tabId: string, force = false) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return current;
      if (current[index].locked && !force) {
        setToast("标签已锁定，请先解锁后再关闭。");
        return current;
      }
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveTabId((currentActive) => currentActive === tabId
        ? next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? null
        : currentActive);
      return next;
    });
    setSecondaryTabId((current) => current === tabId ? null : current);
  };

  const toggleTabLocked = (tabId: string) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, locked: !tab.locked } : tab));
  };

  const setTabColor = (tab: TerminalTab) => {
    const value = window.prompt(
      "输入标签颜色（HEX，例如 #39b8d6）。留空恢复默认。\n常用：蓝 #39b8d6 · 绿 #56d364 · 黄 #d4a72c · 橙 #db6d28 · 紫 #a371f7 · 红 #f47067",
      tab.color ?? "",
    );
    if (value === null) return;
    const color = normalizeTabColor(value);
    if (value.trim() && !color) {
      setToast("标签颜色格式无效，请输入类似 #39b8d6 的六位 HEX 颜色。");
      return;
    }
    setTabs((current) => current.map((candidate) => candidate.id === tab.id ? { ...candidate, color } : candidate));
  };

  const duplicateTab = (tabId: string) => {
    const source = tabs.find((tab) => tab.id === tabId);
    if (!source) return;
    const duplicated: TerminalTab = {
      id: crypto.randomUUID(),
      session: source.session,
      state: "connecting",
      connectionVersion: 0,
      locked: false,
      color: source.color,
    };
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return [...current, duplicated];
      const next = [...current];
      next.splice(index + 1, 0, duplicated);
      return next;
    });
    setActiveTabId(duplicated.id);
    setToast(`已复制连接：${getTabLabel(source)}`);
  };

  const reconnectTab = (tabId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? { ...tab, state: "connecting", connectionVersion: tab.connectionVersion + 1 }
          : tab,
      ),
    );
    setActiveTabId(tabId);
    setToast("正在重新连接 SSH 会话…");
  };

  const reconnectDisconnectedTabs = () => {
    const reconnectable = tabs.filter((tab) => tab.state === "disconnected" || tab.state === "failed");
    if (reconnectable.length === 0) {
      setToast("当前没有需要重连的标签。");
      return;
    }
    const ids = new Set(reconnectable.map((tab) => tab.id));
    setTabs((current) => current.map((tab) => ids.has(tab.id)
      ? { ...tab, state: "connecting", connectionVersion: tab.connectionVersion + 1 }
      : tab));
    setToast(`正在重新连接 ${reconnectable.length} 个 SSH 标签…`);
  };

  const closeOtherTabs = (tabId: string) => {
    const protectedCount = tabs.filter((tab) => tab.id !== tabId && tab.locked).length;
    const keptIds = new Set(tabs.filter((tab) => tab.id === tabId || tab.locked).map((tab) => tab.id));
    setTabs((current) => current.filter((tab) => tab.id === tabId || tab.locked));
    setSecondaryTabId((current) => current && current !== tabId && keptIds.has(current) ? current : null);
    setActiveTabId(tabId);
    if (protectedCount > 0) setToast(`已保留 ${protectedCount} 个锁定标签。`);
  };

  const closeTabsToRight = (tabId: string) => {
    const targetIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex < 0) return;
    const closableIds = new Set(tabs.slice(targetIndex + 1).filter((tab) => !tab.locked).map((tab) => tab.id));
    const protectedCount = tabs.slice(targetIndex + 1).filter((tab) => tab.locked).length;
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return current;
      return current.filter((tab, candidateIndex) => candidateIndex <= index || tab.locked);
    });
    setSecondaryTabId((current) => current && closableIds.has(current) ? null : current);
    setActiveTabId(tabId);
    if (protectedCount > 0) setToast(`已保留 ${protectedCount} 个锁定标签。`);
  };

  const closeTabsToLeft = (tabId: string) => {
    const targetIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex < 0) return;
    const closableIds = new Set(tabs.slice(0, targetIndex).filter((tab) => !tab.locked).map((tab) => tab.id));
    const protectedCount = tabs.slice(0, targetIndex).filter((tab) => tab.locked).length;
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return current;
      return current.filter((tab, candidateIndex) => candidateIndex >= index || tab.locked);
    });
    setSecondaryTabId((current) => current && closableIds.has(current) ? null : current);
    setActiveTabId(tabId);
    if (protectedCount > 0) setToast(`已保留 ${protectedCount} 个锁定标签。`);
  };

  const closeDisconnectedTabs = () => {
    const disconnected = tabs.filter((tab) => tab.state === "disconnected" || tab.state === "failed");
    const closable = new Set(disconnected.filter((tab) => !tab.locked).map((tab) => tab.id));
    const protectedCount = disconnected.length - closable.size;
    if (closable.size === 0) {
      setToast(protectedCount > 0 ? "断开的标签均已锁定，请先解锁。" : "当前没有已断开或连接失败的标签。");
      return;
    }
    setTabs((current) => current.filter((tab) => !closable.has(tab.id)));
    setSecondaryTabId((current) => current && closable.has(current) ? null : current);
    setActiveTabId((current) => current && closable.has(current) ? tabs.find((tab) => !closable.has(tab.id))?.id ?? null : current);
    setToast(protectedCount > 0
      ? `已关闭 ${closable.size} 个断开标签，并保留 ${protectedCount} 个锁定标签。`
      : `已关闭 ${closable.size} 个断开标签。`);
  };

  const closeAllTabs = () => {
    const lockedTabs = tabs.filter((tab) => tab.locked);
    setTabs(lockedTabs);
    setActiveTabId((current) => current && lockedTabs.some((tab) => tab.id === current)
      ? current
      : lockedTabs[0]?.id ?? null);
    setSecondaryTabId((current) => current && lockedTabs.some((tab) => tab.id === current)
      ? current
      : null);
    if (lockedTabs.length > 0) setToast(`已保留 ${lockedTabs.length} 个锁定标签。`);
  };

  const openNamedWorkspace = (workspace: NamedWorkspace) => {
    if (tabs.length > 0 && !window.confirm(`打开工作区“${workspace.name}”将关闭当前未锁定和锁定标签，并重新建立其中的 SSH 连接。是否继续？`)) {
      return;
    }

    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const idMap = new Map<string, string>();
    const restoredTabs = workspace.snapshot.tabs.flatMap((tab) => {
      const session = sessionsById.get(tab.sessionId);
      if (!session) return [];
      const id = crypto.randomUUID();
      idMap.set(tab.id, id);
      return [{
        id,
        session,
        state: "connecting",
        connectionVersion: 0,
        locked: tab.locked,
        color: tab.color,
      } satisfies TerminalTab];
    });
    const restoredActiveId = workspace.snapshot.activeTabId
      ? idMap.get(workspace.snapshot.activeTabId) ?? restoredTabs[0]?.id ?? null
      : restoredTabs[0]?.id ?? null;
    const restoredSecondaryId = workspace.snapshot.secondaryTabId
      ? idMap.get(workspace.snapshot.secondaryTabId) ?? null
      : null;
    const restoredLayout = workspace.snapshot.paneLayout !== "single" && restoredTabs.length < 2
      ? "single"
      : workspace.snapshot.paneLayout;
    const missingCount = workspace.snapshot.tabs.length - restoredTabs.length;

    setTabs(restoredTabs);
    setActiveTabId(restoredActiveId);
    setSecondaryTabId(restoredSecondaryId && restoredSecondaryId !== restoredActiveId ? restoredSecondaryId : null);
    updatePaneLayout(restoredLayout);
    setConnectionIds({});
    setPendingTerminalCommands({});
    setBroadcastEnabled(false);
    setSftpVisible(false);
    setPortForwardVisible(false);
    setWorkspaceManagerVisible(false);
    setToast(missingCount > 0
      ? `已打开工作区“${workspace.name}”，${missingCount} 个已删除会话已跳过。`
      : `已打开工作区：${workspace.name}`);
  };

  const createGroup = (parentId: string | null) => {
    setGroupEditor({ mode: "create", parentId });
  };

  const renameGroup = (group: SessionGroup) => {
    setGroupEditor({ mode: "rename", group });
  };

  const saveGroup = async (draft: SessionGroupDraft) => {
    if (!groupEditor) return;
    if (groupEditor.mode === "create") {
      await api.createGroup(draft);
      await refresh();
      setGroupEditor(null);
      setToast(`目录“${draft.name}”已创建。`);
      return;
    }
    await api.updateGroup(groupEditor.group.id, draft);
    await refresh();
    setGroupEditor(null);
    setToast(`目录已重命名为：${draft.name}`);
  };

  const deleteGroup = async (group: SessionGroup) => {
    if (!window.confirm(`确定删除目录“${group.name}”？子目录会一并删除，其中的会话将移动到“未分类”。`)) return;
    try {
      await api.deleteGroup(group.id);
      await refresh();
      setToast(`目录“${group.name}”已删除，会话数据仍保留。`);
    } catch (error) {
      setToast(`删除目录失败：${String(error)}`);
    }
  };

  const sessionDraft = (session: SavedSession, overrides: Partial<SessionDraft> = {}): SessionDraft => ({
    groupId: session.groupId,
    name: session.name,
    host: session.host,
    port: session.port,
    username: session.username,
    proxyJump: session.proxyJump,
    proxyJumpUsername: session.proxyJumpUsername,
    proxyJumpAuthentication: session.proxyJumpAuthentication,
    authentication: session.authentication,
    terminal: session.terminal,
    initialDirectory: session.initialDirectory,
    startupCommand: session.startupCommand,
    keepaliveSeconds: session.keepaliveSeconds,
    autoReconnect: session.autoReconnect,
    environment: session.environment,
    color: session.color,
    notes: session.notes,
    tags: session.tags,
    favorite: session.favorite,
    ...overrides,
  });

  const moveSessionToGroup = async (session: SavedSession, groupId: string | null) => {
    if (session.groupId === groupId) return;
    try {
      await api.updateSession(session.id, sessionDraft(session, { groupId }));
      await refresh();
      setToast(groupId ? `会话“${session.name}”已移动到目录。` : `会话“${session.name}”已移到未分类。`);
    } catch (error) {
      setToast(`移动会话失败：${String(error)}`);
    }
  };

  const moveSessionsToGroup = async (selectedSessions: SavedSession[], groupId: string | null) => {
    const changed = selectedSessions.filter((session) => session.groupId !== groupId);
    if (changed.length === 0) {
      setToast("选中的会话已经位于该目录。");
      return;
    }
    try {
      for (const session of changed) {
        await api.updateSession(session.id, sessionDraft(session, { groupId }));
      }
      await refresh();
      setToast(groupId ? `已移动 ${changed.length} 个会话到目录。` : `已将 ${changed.length} 个会话移到未分类。`);
    } catch (error) {
      await refresh();
      setToast(`批量移动未完全完成：${String(error)}`);
    }
  };

  const duplicateSession = async (session: SavedSession) => {
    try {
      const duplicated = await api.createSession(sessionDraft(session, {
        name: `${session.name} 副本`,
        favorite: false,
      }));
      await refresh();
      setEditorSession(duplicated);
      setToast(`已复制会话：${duplicated.name}`);
    } catch (error) {
      setToast(`复制会话失败：${String(error)}`);
    }
  };

  const toggleFavorite = async (session: SavedSession) => {
    try {
      await api.updateSession(session.id, sessionDraft(session, { favorite: !session.favorite }));
      await refresh();
      setToast(session.favorite ? "已取消收藏" : "已加入收藏");
    } catch (error) {
      setToast(`更新收藏失败：${String(error)}`);
    }
  };

  const setSessionsFavorite = async (selectedSessions: SavedSession[], favorite: boolean) => {
    const changed = selectedSessions.filter((session) => session.favorite !== favorite);
    if (changed.length === 0) {
      setToast(favorite ? "选中的会话均已收藏。" : "选中的会话均未收藏。");
      return;
    }
    try {
      for (const session of changed) {
        await api.updateSession(session.id, sessionDraft(session, { favorite }));
      }
      await refresh();
      setToast(favorite ? `已收藏 ${changed.length} 个会话。` : `已取消收藏 ${changed.length} 个会话。`);
    } catch (error) {
      await refresh();
      setToast(`批量更新收藏未完全完成：${String(error)}`);
    }
  };

  const applyBatchSessionUpdates = async (selectedSessions: SavedSession[], updates: SessionBatchUpdates) => {
    const removalSet = new Set(updates.removeTags.map((tag) => tag.toLowerCase()));
    const updatedSessions: SavedSession[] = [];
    try {
      for (const session of selectedSessions) {
        const tags = session.tags.filter((tag) => !removalSet.has(tag.toLowerCase()));
        const existingTags = new Set(tags.map((tag) => tag.toLowerCase()));
        for (const tag of updates.addTags) {
          if (!existingTags.has(tag.toLowerCase())) {
            tags.push(tag);
            existingTags.add(tag.toLowerCase());
          }
        }
        const saved = await api.updateSession(session.id, sessionDraft(session, {
          environment: updates.environment === undefined ? session.environment : updates.environment,
          autoReconnect: updates.autoReconnect === undefined ? session.autoReconnect : updates.autoReconnect,
          tags,
        }));
        updatedSessions.push(saved);
      }
      const byId = new Map(updatedSessions.map((session) => [session.id, session]));
      setTabs((current) => current.map((tab) => {
        const updated = byId.get(tab.session.id);
        return updated ? { ...tab, session: updated } : tab;
      }));
      await refresh();
      setToast(`已批量更新 ${updatedSessions.length} 个会话。`);
    } catch (caught) {
      await refresh();
      throw new Error(`已更新 ${updatedSessions.length} 个会话，随后失败：${String(caught)}`);
    }
  };

  const deleteSession = async (session: SavedSession) => {
    if (!window.confirm(`确定删除会话“${session.name}”？此操作不会删除服务器上的任何内容。`)) return;
    try {
      await api.deleteSession(session.id);
      const relatedTabs = tabs.filter((tab) => tab.session.id === session.id);
      relatedTabs.forEach((tab) => closeTab(tab.id, true));
      await refresh();
      setToast(`会话“${session.name}”已删除。`);
    } catch (error) {
      setToast(`删除会话失败：${String(error)}`);
    }
  };

  const deleteSessions = async (selectedSessions: SavedSession[]) => {
    if (selectedSessions.length === 0) return;
    const preview = selectedSessions.slice(0, 6).map((session) => session.name).join("、");
    const suffix = selectedSessions.length > 6 ? "…" : "";
    if (!window.confirm(`确定删除选中的 ${selectedSessions.length} 个会话？\n\n${preview}${suffix}\n\n此操作不会删除服务器上的任何内容。`)) return;
    const deletedIds = new Set<string>();
    let failed = 0;
    for (const session of selectedSessions) {
      try {
        await api.deleteSession(session.id);
        deletedIds.add(session.id);
      } catch {
        failed += 1;
      }
    }
    tabs.filter((tab) => deletedIds.has(tab.session.id)).forEach((tab) => closeTab(tab.id, true));
    await refresh();
    setToast(failed > 0
      ? `已删除 ${deletedIds.size} 个会话，${failed} 个删除失败。`
      : `已删除 ${deletedIds.size} 个会话及其 XSH 本地凭据。`);
  };

  const refreshSshConfig = async () => {
    setSshConfigLoading(true);
    try {
      setSshConfigEntries(await api.listSshConfigEntries());
    } catch (error) {
      setToast(`读取 SSH 配置失败：${String(error)}`);
    } finally {
      setSshConfigLoading(false);
    }
  };

  const importSshConfigEntries = async (entries: SshConfigEntry[]) => {
    let imported = 0;
    let passwordSessions = 0;

    for (const entry of entries) {
      const existing = sessions.find((session) => session.name === entry.alias);
      const authentication = entry.identityFile
        ? {
            type: "privateKey" as const,
            privateKeyPath: entry.identityFile,
            passphraseRef: null,
          }
        : {
            type: "password" as const,
            credentialRef: null,
          };
      const draft: SessionDraft = {
        groupId: existing?.groupId ?? null,
        name: entry.alias,
        host: entry.hostname,
        port: entry.port,
        username: entry.username,
        proxyJump: entry.proxyJump,
        proxyJumpUsername: null,
        proxyJumpAuthentication: null,
        authentication,
        terminal: existing?.terminal ?? defaultTerminalProfile(),
        initialDirectory: existing?.initialDirectory ?? null,
        startupCommand: existing?.startupCommand ?? null,
        keepaliveSeconds: existing?.keepaliveSeconds ?? 30,
        autoReconnect: existing?.autoReconnect ?? true,
        environment: existing?.environment ?? "development",
        color: existing?.color ?? null,
        notes: existing?.notes ?? null,
        tags: Array.from(new Set([...(existing?.tags ?? []), "ssh-config"])),
        favorite: existing?.favorite ?? false,
      };

      if (existing) {
        await api.updateSession(existing.id, draft);
      } else {
        await api.createSession(draft);
      }
      imported += 1;
      if (!entry.identityFile) passwordSessions += 1;
    }

    await refresh();
    setToast(
      passwordSessions > 0
        ? `已导入 ${imported} 个 SSH 配置；其中 ${passwordSessions} 个需要编辑会话填写密码。`
        : `已导入 ${imported} 个 SSH 配置。`,
    );
  };

  const updatePreferences = (next: AppPreferences) => {
    setPreferences(next);
    savePreferences(next);
  };

  const exportSessions = async () => {
    const targetPath = await save({
      title: "导出 XSH 会话",
      defaultPath: "xsh-sessions.xshpack",
      filters: [{ name: "XSH Session Pack", extensions: ["xshpack"] }],
    });
    if (!targetPath) return;
    try {
      await api.exportSessions(targetPath, false);
      setToast("会话已导出；默认未包含密码和私钥内容。 ");
    } catch (error) {
      setToast(`导出失败：${String(error)}`);
    }
  };

  const importSessions = async () => {
    const sourcePath = await open({
      title: "导入 XSH 会话",
      multiple: false,
      directory: false,
      filters: [{ name: "XSH Session Pack", extensions: ["xshpack", "json"] }],
    });
    if (typeof sourcePath !== "string") return;
    try {
      const summary = await api.importSessions(sourcePath);
      await refresh();
      setToast(`已导入 ${summary.groupsCreated} 个目录和 ${summary.sessionsCreated} 个会话；认证信息需要重新填写。`);
    } catch (error) {
      setToast(`导入失败：${String(error)}`);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // On macOS, application shortcuts use Command only so Ctrl reaches the
      // remote shell unchanged. On Windows, high-conflict actions require
      // Ctrl+Shift to preserve Ctrl+T/W/B for readline, tmux, vim, and shells.
      const appModifier = IS_MACOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!appModifier) return;
      const terminalHasFocus = event.target instanceof Element && event.target.closest(".terminal-pane") !== null;
      if (!IS_MACOS && preferences.terminalShortcutMode === "remote-first" && terminalHasFocus) return;
      const key = event.key.toLowerCase();
      const chromeShift = IS_MACOS ? !event.shiftKey : event.shiftKey;
      const hasOverlay = editorSession !== undefined || settingsVisible || sshConfigVisible ||
        commandCenterVisible || historyVisible || diagnosticSession !== null || groupEditor !== null ||
        workspaceManagerVisible || connectionManagerVisible || batchEditorSessions.length > 0 || portForwardVisible;
      if (hasOverlay) return;

      if (key === "p" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setCommandCenterVisible(true);
        return;
      }
      if (key === "t" && chromeShift && !event.altKey) {
        event.preventDefault();
        setEditorSession(null);
        return;
      }
      if (key === "w" && chromeShift && !event.altKey && activeTabId) {
        event.preventDefault();
        closeTab(activeTabId);
        return;
      }
      if (/^[1-9]$/.test(key) && !event.shiftKey && event.altKey) {
        const target = tabs[Number(key) - 1];
        if (!target) return;
        event.preventDefault();
        focusTab(target.id);
        return;
      }
      if (key === "d" && event.shiftKey && !event.altKey && activeTabId) {
        event.preventDefault();
        duplicateTab(activeTabId);
        return;
      }
      if (key === "r" && event.shiftKey && !event.altKey && activeTabId) {
        event.preventDefault();
        reconnectTab(activeTabId);
        return;
      }
      if (key === "b" && chromeShift && !event.altKey) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (event.altKey && !event.shiftKey) {
        if (key === "v") {
          event.preventDefault();
          updatePaneLayout("vertical");
          return;
        }
        if (key === "j") {
          event.preventDefault();
          updatePaneLayout("horizontal");
          return;
        }
        if (key === "s") {
          event.preventDefault();
          updatePaneLayout("single");
          return;
        }
        if ((key === "arrowleft" || key === "arrowright") && paneLayout !== "single") {
          event.preventDefault();
          focusOtherSplitPane();
          return;
        }
        if (key === "f" && activeTabId) {
          event.preventDefault();
          setSftpVisible((current) => !current);
          return;
        }
      }
      const macTabCycle = IS_MACOS && event.shiftKey && !event.altKey && (key === "[" || key === "]");
      const windowsTabCycle = !IS_MACOS && key === "tab" && !event.altKey;
      if ((!macTabCycle && !windowsTabCycle) || tabs.length < 2) return;
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      if (index < 0) return;
      const offset = IS_MACOS ? (key === "[" ? -1 : 1) : (event.shiftKey ? -1 : 1);
      const nextIndex = (index + offset + tabs.length) % tabs.length;
      focusTab(tabs[nextIndex].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, batchEditorSessions.length, commandCenterVisible, connectionManagerVisible, diagnosticSession, editorSession, groupEditor, historyVisible, paneLayout, portForwardVisible, preferences.terminalShortcutMode, settingsVisible, sshConfigVisible, tabs, workspaceManagerVisible]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark">X</div>
          <div><strong>XSH</strong><span>SSH Workspace</span></div>
        </div>
        <div className="header-actions">
          <button className="icon-button" title={`${sidebarVisible ? "隐藏" : "显示"}会话侧栏 · macOS ⌘B / Windows Ctrl+Shift+B`} onClick={toggleSidebar} aria-label={sidebarVisible ? "隐藏会话侧栏" : "显示会话侧栏"}>
            {sidebarVisible ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <button className="toolbar-button" onClick={importSessions}><Upload size={14} />导入</button>
          <button className="toolbar-button" onClick={exportSessions}><Download size={14} />导出</button>
          <button
            className="toolbar-button"
            onClick={() => {
              setSshConfigVisible(true);
              void refreshSshConfig();
            }}
            title="读取 ~/.ssh/config"
          >
            <FileKey size={14} />SSH 配置
          </button>
          <button className={`toolbar-button connection-manager-trigger ${tabs.length > 0 ? "has-connections" : ""}`} onClick={() => setConnectionManagerVisible(true)} title="查看和管理所有活动连接">
            <Activity size={14} />连接 {tabs.filter((tab) => tab.state === "connected").length}/{tabs.length}
          </button>
          <button className="toolbar-button command-center-trigger" onClick={() => setCommandCenterVisible(true)}><Command size={14} />命令中心</button>
          <button className="toolbar-button" onClick={() => setHistoryVisible(true)}><History size={14} />历史</button>
          <button className="toolbar-button" onClick={() => setEditorSession(null)}><Plus size={15} />新建会话</button>
          <button className="icon-button" title="设置" onClick={() => setSettingsVisible(true)}><Settings size={16} /></button>
          <button className="icon-button" title="工作区管理" onClick={() => setWorkspaceManagerVisible(true)}><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className={`workspace ${sidebarVisible ? "" : "sidebar-hidden"}`}>
        {sidebarVisible && <SessionSidebar
          groups={groups}
          sessions={sessions}
          activeSessionId={activeTab?.session.id}
          activityBySessionId={activityBySessionId}
          recentSessions={recentSessions}
          onOpen={openSession}
          onOpenGroup={openGroupSessions}
          onDiagnose={(session) => void runDiagnostic(session)}
          onEdit={(session) => setEditorSession(session)}
          onCreateGroup={createGroup}
          onDuplicate={duplicateSession}
          onToggleFavorite={toggleFavorite}
          onDeleteSession={deleteSession}
          onMoveSession={moveSessionToGroup}
          onMoveSessions={moveSessionsToGroup}
          onSetFavorite={setSessionsFavorite}
          onDeleteSessions={deleteSessions}
          onBatchEdit={(selected) => setBatchEditorSessions(selected)}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
        />}

        <section className="terminal-workspace">
          <div className="tab-strip">
            <div className="tabs-scroll">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`terminal-tab ${activeTabId === tab.id ? "active" : ""} ${draggedTabId === tab.id ? "dragging" : ""} ${tab.locked ? "locked" : ""} ${tab.color ? "has-custom-color" : ""}`}
                  style={tab.color ? { "--tab-accent": tab.color } as CSSProperties : undefined}
                  draggable
                  title={`${getTabLabel(tab)} · ${connectionStateLabel(tab.state)}${tab.locked ? " · 已锁定" : ""}\n${tab.session.username}@${tab.session.host}:${tab.session.port}\n拖拽标签可调整顺序，双击可重命名`}
                  onClick={() => focusTab(tab.id)}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    renameTab(tab);
                  }}
                  onDragStart={(event) => {
                    setDraggedTabId(tab.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", tab.id);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceId = event.dataTransfer.getData("text/plain") || draggedTabId;
                    if (sourceId) reorderTabs(sourceId, tab.id);
                    setDraggedTabId(null);
                  }}
                  onDragEnd={() => setDraggedTabId(null)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTabContextMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1 && !tab.locked) {
                      event.preventDefault();
                      closeTab(tab.id);
                    }
                  }}
                >
                  <span className={`connection-dot ${tab.state}`} />
                  <span>{getTabLabel(tab)}</span>
                  {tab.locked ? (
                    <span className="tab-lock" title="标签已锁定"><Lock size={11} /></span>
                  ) : (
                    <span
                      className="tab-close"
                      onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    ><X size={12} /></span>
                  )}
                </button>
              ))}
              <button className="tab-new-button" onClick={() => setEditorSession(null)} title="新建会话标签"><Plus size={15} /></button>
            </div>
            <div className="pane-controls" title="终端布局">
              <button className={paneLayout === "single" ? "active" : ""} onClick={() => updatePaneLayout("single")} title="单终端"><Square size={13} /></button>
              <button className={paneLayout === "vertical" ? "active" : ""} onClick={() => updatePaneLayout("vertical")} title="左右分屏"><Columns2 size={13} /></button>
              <button className={paneLayout === "horizontal" ? "active" : ""} onClick={() => updatePaneLayout("horizontal")} title="上下分屏 · macOS ⌘⌥J / Windows Ctrl+Alt+J"><Rows2 size={13} /></button>
              {paneLayout !== "single" && (
                <select value={secondaryTabId ?? ""} onChange={(event) => setSecondaryTabId(event.target.value || null)} title="选择分屏会话">
                  <option value="">选择第二个会话</option>
                  {tabs.filter((tab) => tab.id !== activeTabId).map((tab) => <option key={tab.id} value={tab.id}>{getTabLabel(tab)}</option>)}
                </select>
              )}
              <button className={broadcastEnabled ? "active" : ""} onClick={() => setBroadcastEnabled((value) => !value)} title={broadcastEnabled ? "关闭命令广播" : "开启命令广播"}>广播</button>
            </div>
            {activeTab && connectionIds[activeTab.id] && (
              <button className={`sftp-toggle ${portForwardVisible ? "active" : ""}`} onClick={() => setPortForwardVisible((value) => !value)} title="端口转发">
                <Globe2 size={14} />转发
              </button>
            )}
            {activeTab && (
              <button className={`sftp-toggle ${sftpVisible ? "active" : ""}`} onClick={() => setSftpVisible((value) => !value)}>
                <Files size={14} />SFTP
              </button>
            )}
          </div>

          <div
            ref={terminalStageRef}
            className={`terminal-stage ${paneLayout !== "single" ? `split-${paneLayout}` : ""}`}
            style={paneLayout === "vertical"
              ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) minmax(0, ${100 - splitRatio}fr)` }
              : paneLayout === "horizontal"
                ? { gridTemplateRows: `minmax(0, ${splitRatio}fr) minmax(0, ${100 - splitRatio}fr)` }
                : undefined}
          >
            <Suspense fallback={<div className="terminal-loading">正在加载终端引擎…</div>}>
              {tabs.map((tab) => {
                const paneVisible = paneLayout === "single"
                  ? tab.id === activeTabId
                  : tab.id === activeTabId || tab.id === secondaryTabId;
                return (
                <TerminalPane
                  key={`${tab.id}:${tab.connectionVersion}`}
                  session={tab.session}
                  preferences={preferences}
                  visible={paneVisible}
                  focused={tab.id === activeTabId}
                  command={pendingTerminalCommands[tab.id] ?? null}
                  onStateChange={(state) => handleTerminalStateChange(tab.id, tab.session.id, state)}
                  onConnectionChange={(connectionId) => setConnectionIds((current) => ({ ...current, [tab.id]: connectionId }))}
                  onFocus={() => focusTab(tab.id)}
                  onCommandResult={handleCommandResult}
                />
                );
              })}
            </Suspense>
            {paneLayout !== "single" && secondaryTabId && (
              <div
                className={`split-divider ${paneLayout}`}
                style={paneLayout === "vertical" ? { left: `${splitRatio}%` } : { top: `${splitRatio}%` }}
                role="separator"
                aria-orientation={paneLayout === "vertical" ? "vertical" : "horizontal"}
                aria-label="调整终端分屏比例"
                title="拖拽调整分屏比例，双击恢复 50%"
                onPointerDown={beginSplitResize}
                onDoubleClick={() => updateSplitRatio(50)}
              />
            )}
            {!activeTab && (
              <div className="welcome-panel">
                <div className="welcome-glyph">$_</div>
                <h1>选择一个会话开始连接</h1>
                <p>从左侧目录打开服务器，或创建一个新的 SSH 会话。</p>
                <button className="primary-button" onClick={() => setEditorSession(null)}><Plus size={15} />新建会话</button>
                <div className="welcome-shortcuts">
                  <span><kbd>⌘C / Ctrl⇧C</kbd>复制</span>
                  <span><kbd>右键</kbd>安全粘贴</span>
                  <span><kbd>⌘F / Ctrl⇧F</kbd>查找</span>
                  <span><kbd>⌘/Ctrl</kbd><kbd>⇧</kbd><kbd>P</kbd>命令中心</span>
                </div>
              </div>
            )}
          </div>
          <QuickCommandBar
            items={quickCommands}
            canSend={canExecuteCommand}
            unavailableReason={commandExecutionUnavailableReason}
            targetName={activeTab?.session.name ?? null}
            terminalShortcutMode={preferences.terminalShortcutMode}
            onChange={saveQuickCommands}
            onSend={sendQuickCommand}
            onToast={setToast}
          />
        </section>

        {sftpVisible && activeTab && (
          <Suspense fallback={<aside className="sftp-panel"><div className="panel-message">正在加载 SFTP…</div></aside>}>
            <SftpPanel key={activeTab.session.id} session={activeTab.session} onClose={() => setSftpVisible(false)} onToast={setToast} />
          </Suspense>
        )}
      </div>

      {tabContextMenu && (() => {
        const contextTab = tabs.find((tab) => tab.id === tabContextMenu.tabId);
        const contextIndex = tabs.findIndex((tab) => tab.id === tabContextMenu.tabId);
        if (!contextTab) return null;
        return (
          <ContextMenu
            x={tabContextMenu.x}
            y={tabContextMenu.y}
            onClose={() => setTabContextMenu(null)}
            items={[
              { label: "重新连接", onClick: () => reconnectTab(contextTab.id) },
              { label: "复制当前连接", onClick: () => duplicateTab(contextTab.id) },
              { label: "重命名标签", onClick: () => renameTab(contextTab) },
              { label: "设置标签颜色", onClick: () => setTabColor(contextTab) },
              { label: "编辑会话", onClick: () => setEditorSession(contextTab.session) },
              {
                label: contextTab.locked ? "解锁标签" : "锁定标签",
                onClick: () => toggleTabLocked(contextTab.id),
                separatorBefore: true,
              },
              { label: contextTab.locked ? "关闭当前标签（请先解锁）" : "关闭当前标签", onClick: () => closeTab(contextTab.id) },
              { label: "关闭左侧标签", onClick: () => closeTabsToLeft(contextTab.id), danger: contextIndex > 0 },
              { label: "关闭右侧标签", onClick: () => closeTabsToRight(contextTab.id), danger: contextIndex < tabs.length - 1 },
              { label: "关闭其他标签", onClick: () => closeOtherTabs(contextTab.id), danger: tabs.length > 1 },
              { label: "关闭已断开标签", onClick: closeDisconnectedTabs, danger: tabs.some((tab) => tab.state === "disconnected" || tab.state === "failed"), separatorBefore: true },
              {
                label: "关闭全部标签",
                onClick: () => {
                  if (tabs.length > 1 && !window.confirm(`确定关闭全部 ${tabs.length} 个标签？`)) return;
                  closeAllTabs();
                },
                danger: true,
                separatorBefore: true,
              },
            ]}
          />
        );
      })()}

      <footer className="status-bar">
        <span>{loading ? "加载会话…" : `${sessions.length} 个会话 · ${tabs.length} 个已打开标签`}</span>
        <span>{activeTab ? `${getTabLabel(activeTab)} · ${connectionStateLabel(activeTab.state)}` : "未选择会话"} · 本地优先 · SSH2</span>
      </footer>

      {connectionManagerVisible && (
        <ConnectionManagerModal
          items={tabs.map((tab) => ({
            id: tab.id,
            name: getTabLabel(tab),
            state: tab.state,
            locked: tab.locked,
            focused: tab.id === activeTabId,
          }))}
          onFocus={focusTab}
          onReconnect={reconnectTab}
          onCloseTab={closeTab}
          onReconnectDisconnected={reconnectDisconnectedTabs}
          onCloseDisconnected={closeDisconnectedTabs}
          onClose={() => setConnectionManagerVisible(false)}
        />
      )}

      {portForwardVisible && activeTab && connectionIds[activeTab.id] && (
        <PortForwardModal
          connectionId={connectionIds[activeTab.id]!}
          sessionName={activeTab.session.name}
          onClose={() => setPortForwardVisible(false)}
          onToast={setToast}
        />
      )}

      {commandCenterVisible && (
        <CommandCenterModal
          commands={commands}
          activeSessionName={activeTab?.session.name ?? null}
          canExecute={canExecuteCommand}
          executionUnavailableReason={commandExecutionUnavailableReason}
          onChange={saveCommands}
          onExecute={queueCommandForActiveTerminal}
          onClose={() => setCommandCenterVisible(false)}
          onToast={setToast}
        />
      )}

      {historyVisible && (
        <CommandHistoryModal
          entries={commandHistory}
          activeSessionId={activeTab?.session.id ?? null}
          canExecute={canExecuteCommand}
          executionUnavailableReason={commandExecutionUnavailableReason}
          onExecute={(entry) => {
            setHistoryVisible(false);
            queueTextForActiveTerminal("历史命令", entry.command, "命令历史");
          }}
          onClear={() => {
            saveCommandHistory([]);
            setCommandHistory([]);
            setToast("命令历史已清空。");
          }}
          onClose={() => setHistoryVisible(false)}
          onToast={setToast}
        />
      )}

      {sshConfigVisible && (
        <SshConfigModal
          entries={sshConfigEntries}
          loading={sshConfigLoading}
          onClose={() => setSshConfigVisible(false)}
          onRefresh={() => void refreshSshConfig()}
          onImport={importSshConfigEntries}
        />
      )}

      {diagnosticSession && (
        <DiagnosticModal
          session={diagnosticSession}
          report={diagnosticReport}
          loading={diagnosticLoading}
          error={diagnosticError}
          onRetry={() => void runDiagnostic(diagnosticSession)}
          onClose={() => {
            setDiagnosticSession(null);
            setDiagnosticReport(null);
            setDiagnosticError(null);
          }}
        />
      )}

      {settingsVisible && (
        <SettingsModal
          preferences={preferences}
          onSave={updatePreferences}
          onClose={() => setSettingsVisible(false)}
          onToast={setToast}
        />
      )}

      {batchEditorSessions.length > 0 && (
        <SessionBatchEditorModal
          sessions={batchEditorSessions}
          onApply={(updates) => applyBatchSessionUpdates(batchEditorSessions, updates)}
          onClose={() => setBatchEditorSessions([])}
        />
      )}

      {workspaceManagerVisible && (
        <WorkspaceManagerModal
          currentSnapshot={currentWorkspaceSnapshot}
          onOpen={openNamedWorkspace}
          onClose={() => setWorkspaceManagerVisible(false)}
          onToast={setToast}
        />
      )}

      {groupEditor && (
        <GroupEditorModal
          groups={groups}
          mode={groupEditor.mode}
          group={groupEditor.mode === "rename" ? groupEditor.group : undefined}
          parentId={groupEditor.mode === "create" ? groupEditor.parentId : undefined}
          onClose={() => setGroupEditor(null)}
          onSubmit={saveGroup}
        />
      )}

      {editorSession !== undefined && (
        <SessionEditor
          groups={groups}
          sessions={sessions}
          session={editorSession ?? undefined}
          onClose={() => setEditorSession(undefined)}
          onSaved={async (saved) => {
            // SessionEditor returns the fully persisted session, including the
            // new credentialRef. Replace the in-memory tab snapshot before
            // refreshing the sidebar; otherwise an already-open tab keeps the
            // old authentication object and reconnects without a password.
            setTabs((current) =>
              current.map((tab) =>
                tab.session.id === saved.id
                  ? {
                      ...tab,
                      session: saved,
                      state: "connecting",
                      connectionVersion: tab.connectionVersion + 1,
                    }
                  : tab,
              ),
            );
            setEditorSession(undefined);
            await refresh();
            setToast(`已保存会话：${saved.name}，正在使用新凭据重连。`);
          }}
          onDeleted={async (sessionId) => {
            const deletedTab = tabs.find((tab) => tab.session.id === sessionId);
            if (deletedTab) closeTab(deletedTab.id, true);
            setEditorSession(undefined);
            await refresh();
            setToast("会话已删除，关联的 XSH 本地凭据已清理。");
          }}
        />
      )}
      {toast && <button className="toast" onClick={() => setToast(null)}>{toast}<X size={13} /></button>}
    </main>
  );
}

export default App;
