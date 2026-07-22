import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Search,
  Server,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { SavedSession, SessionGroup } from "../types";

export interface SessionActivitySummary {
  openTabs: number;
  connected: number;
  connecting: number;
  reconnecting: number;
  waitingNetwork: number;
  failed: number;
  disconnected: number;
}

interface SessionSidebarProps {
  groups: SessionGroup[];
  sessions: SavedSession[];
  activeSessionId?: string;
  activityBySessionId: Record<string, SessionActivitySummary>;
  onOpen: (session: SavedSession, options?: { forceNew?: boolean }) => void;
  onOpenGroup: (group: SessionGroup) => void;
  onDiagnose: (session: SavedSession) => void;
  onEdit: (session: SavedSession) => void;
  onCreateSession: () => void;
  onCreateGroup: (parentId: string | null) => void;
  onDuplicate: (session: SavedSession) => void;
  onToggleFavorite: (session: SavedSession) => void;
  onDeleteSession: (session: SavedSession) => void;
  onMoveSession: (session: SavedSession, groupId: string | null) => void | Promise<void>;
  onMoveSessions: (sessions: SavedSession[], groupId: string | null) => void | Promise<void>;
  onSetFavorite: (sessions: SavedSession[], favorite: boolean) => void | Promise<void>;
  onDeleteSessions: (sessions: SavedSession[]) => void | Promise<void>;
  onBatchEdit: (sessions: SavedSession[]) => void;
  onRenameGroup: (group: SessionGroup) => void;
  onDeleteGroup: (group: SessionGroup) => void;
}

type ContextTarget =
  | { type: "sidebar"; x: number; y: number }
  | { type: "session"; session: SavedSession; x: number; y: number }
  | { type: "group"; group: SessionGroup; x: number; y: number };

const SESSION_DRAG_TYPE = "application/x-xsh-session";
const SIDEBAR_WIDTH_STORAGE_KEY = "xsh.session-sidebar.width";
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 360;
const RECENT_SESSIONS_STORAGE_KEY = "xsh.session-sidebar.recent.v1";
type SessionFilter = "all" | "favorite" | "open" | "failed";
type SessionSort = "recent" | "name" | "status";

export function SessionSidebar({
  groups,
  sessions,
  activeSessionId,
  activityBySessionId,
  onOpen,
  onOpenGroup,
  onDiagnose,
  onEdit,
  onCreateSession,
  onCreateGroup,
  onDuplicate,
  onToggleFavorite,
  onDeleteSession,
  onMoveSession,
  onMoveSessions,
  onSetFavorite,
  onDeleteSessions,
  onBatchEdit,
  onRenameGroup,
  onDeleteGroup,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [sessionSort, setSessionSort] = useState<SessionSort>("recent");
  const [recentSessions, setRecentSessions] = useState<Record<string, number>>(loadRecentSessions);
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [draggedSessionIds, setDraggedSessionIds] = useState<Set<string>>(new Set());
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [batchGroupId, setBatchGroupId] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [dragFeedback, setDragFeedback] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.map((group) => group.id)),
  );
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerDraggedSessionIdsRef = useRef<string[]>([]);
  const pointerDragActiveRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const suppressNextGroupClickRef = useRef(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const dragFeedbackTimerRef = useRef<number | null>(null);
  const recentUpdateTimersRef = useRef<Map<string, number>>(new Map());
  const doubleClickStateRef = useRef<{ sessionId: string; wasOpen: boolean; timer: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => () => {
    for (const timer of recentUpdateTimersRef.current.values()) window.clearTimeout(timer);
    recentUpdateTimersRef.current.clear();
    if (doubleClickStateRef.current) window.clearTimeout(doubleClickStateRef.current.timer);
    doubleClickStateRef.current = null;
  }, []);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      groups.forEach((group) => next.add(group.id));
      return next;
    });
  }, [groups]);

  useEffect(() => {
    const validIds = new Set(sessions.map((session) => session.id));
    setSelectedSessionIds((current) => new Set([...current].filter((id) => validIds.has(id))));
  }, [sessions]);

  useEffect(() => {
    const cancelPointerDrag = () => {
      if (!pointerStartRef.current && !pointerDragActiveRef.current) return;
      pointerStartRef.current = null;
      pointerDraggedSessionIdsRef.current = [];
      pointerDragActiveRef.current = false;
      suppressNextClickRef.current = false;
      suppressNextGroupClickRef.current = false;
      setDraggedSessionId(null);
      setDraggedSessionIds(new Set());
      setDragOverGroupId(null);
    };
    window.addEventListener("pointercancel", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointercancel", cancelPointerDrag);
    };
  }, []);

  useEffect(() => () => {
    if (dragFeedbackTimerRef.current !== null) {
      window.clearTimeout(dragFeedbackTimerRef.current);
    }
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = useMemo(() => {
    const filtered = sessions.filter((session) => {
      if (normalizedQuery && ![session.name, session.host, session.username, ...session.tags].some((value) =>
        value.toLowerCase().includes(normalizedQuery),
      )) return false;
      const activity = activityBySessionId[session.id];
      if (sessionFilter === "favorite" && !session.favorite) return false;
      if (sessionFilter === "open" && !(activity?.openTabs > 0)) return false;
      if (sessionFilter === "failed" && !(activity?.failed > 0 || activity?.disconnected > 0)) return false;
      return true;
    });
    return filtered.sort((left, right) => {
      if (sessionSort === "name") return left.name.localeCompare(right.name, "zh-CN");
      if (sessionSort === "status") {
        const stateRank = (session: SavedSession) => {
          const activity = activityBySessionId[session.id];
          if (activity?.failed) return 0;
          if (activity?.connecting || activity?.reconnecting) return 1;
          if (activity?.connected) return 2;
          if (activity?.openTabs) return 3;
          return 4;
        };
        return stateRank(left) - stateRank(right) || left.name.localeCompare(right.name, "zh-CN");
      }
      return (recentSessions[right.id] ?? 0) - (recentSessions[left.id] ?? 0)
        || Number(right.favorite) - Number(left.favorite)
        || left.name.localeCompare(right.name, "zh-CN");
    });
  }, [activityBySessionId, normalizedQuery, recentSessions, sessionFilter, sessionSort, sessions]);

  const markSessionOpened = (session: SavedSession, options?: { forceNew?: boolean }) => {
    // Keep the row in place during the native double-click interval. Updating
    // the "recent" sort immediately can move the row between the first and
    // second click, making the second click land on the neighboring session.
    onOpen(session, options);
    const previousTimer = recentUpdateTimersRef.current.get(session.id);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      recentUpdateTimersRef.current.delete(session.id);
      setRecentSessions((current) => {
        const next = { ...current, [session.id]: Date.now() };
        window.localStorage.setItem(RECENT_SESSIONS_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    }, 400);
    recentUpdateTimersRef.current.set(session.id, timer);
  };

  const toggleGroup = (groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const showSidebarMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextTarget({ type: "sidebar", x: event.clientX, y: event.clientY });
  };

  const showSessionMenu = (event: React.MouseEvent, session: SavedSession) => {
    event.preventDefault();
    event.stopPropagation();
    setContextTarget({ type: "session", session, x: event.clientX, y: event.clientY });
  };

  const showGroupMenu = (event: React.MouseEvent, group: SessionGroup) => {
    event.preventDefault();
    event.stopPropagation();
    setContextTarget({ type: "group", group, x: event.clientX, y: event.clientY });
  };

  const readDraggedSessionIds = (event: React.DragEvent) => {
    const customRaw = event.dataTransfer.getData(SESSION_DRAG_TYPE);
    const plainRaw = event.dataTransfer.getData("text/plain");
    const raw = customRaw || (plainRaw.startsWith("xsh-session:") ? plainRaw.slice("xsh-session:".length) : "");
    if (!raw) return [];
    try {
      const ids = JSON.parse(raw);
      return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : [];
    } catch {
      return raw ? [raw] : [];
    }
  };

  const isSessionDrag = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(SESSION_DRAG_TYPE)
    || event.dataTransfer.types.includes("text/plain")
    && event.dataTransfer.getData("text/plain").startsWith("xsh-session:");

  const resetDragState = () => {
    setDraggedSessionId(null);
    setDraggedSessionIds(new Set());
    setDragOverGroupId(null);
  };

  const setDropFeedback = (message: string) => {
    if (dragFeedbackTimerRef.current !== null) {
      window.clearTimeout(dragFeedbackTimerRef.current);
    }
    setDragFeedback(message);
    dragFeedbackTimerRef.current = window.setTimeout(() => {
      setDragFeedback(null);
      dragFeedbackTimerRef.current = null;
    }, 1800);
  };

  const dropGroupIdAtPoint = (x: number, y: number): string | undefined => {
    const element = document.elementFromPoint(x, y);
    const target = element?.closest<HTMLElement>("[data-xsh-drop-group]");
    if (!target) return undefined;
    return target.dataset.xshDropGroup;
  };

  const moveSessionIds = (draggedIds: string[], groupId: string | null) => {
    const movingIds = draggedIds.length > 0 ? draggedIds : [...draggedSessionIds];
    const moving = sessions.filter((candidate) => movingIds.includes(candidate.id));
    const changed = moving.filter((session) => session.groupId !== groupId);
    if (changed.length === 1) {
      void onMoveSession(changed[0], groupId);
    } else if (changed.length > 1) {
      void onMoveSessions(changed, groupId);
    }
    if (changed.length > 0) {
      const destination = groupId
        ? groups.find((group) => group.id === groupId)?.name ?? "目录"
        : "未分类";
      setDropFeedback(`${changed.length} 个会话已移动到「${destination}」`);
    }
    resetDragState();
  };

  useEffect(() => {
    const handleWindowPointerMove = (event: PointerEvent) => {
      const start = pointerStartRef.current;
      if (!start) return;
      if (!pointerDragActiveRef.current) {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return;
        pointerDragActiveRef.current = true;
        suppressNextClickRef.current = true;
        const movingIds = pointerDraggedSessionIdsRef.current;
        setDraggedSessionId(movingIds[0] ?? null);
        setDraggedSessionIds(new Set(movingIds));
      }
      const targetGroupId = dropGroupIdAtPoint(event.clientX, event.clientY);
      if (targetGroupId !== undefined) setDragOverGroupId(targetGroupId);
      else setDragOverGroupId(null);
    };

    const handleWindowPointerUp = (event: PointerEvent) => {
      if (!pointerDragActiveRef.current) {
        finishPointerDrag();
        return;
      }
      const targetGroupKey = dropGroupIdAtPoint(event.clientX, event.clientY);
      if (targetGroupKey !== undefined) {
        suppressNextGroupClickRef.current = Boolean(
          (event.target as HTMLElement | null)?.closest?.(".group-toggle"),
        );
        suppressNextClickRef.current = false;
        moveSessionIds(
          pointerDraggedSessionIdsRef.current,
          targetGroupKey === "__ungrouped__" ? null : targetGroupKey,
        );
      } else {
        resetDragState();
      }
      finishPointerDrag();
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
    };
  }, [groups, onMoveSession, onMoveSessions, sessions]);

  const moveDraggedSession = (event: React.DragEvent, groupId: string | null) => {
    if (!isSessionDrag(event) && draggedSessionId === null) return;
    event.preventDefault();
    event.stopPropagation();
    moveSessionIds(readDraggedSessionIds(event), groupId);
  };

  const handleGroupDragOver = (event: React.DragEvent, groupId: string) => {
    if (!isSessionDrag(event) && draggedSessionId === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragOverGroupId(groupId);
  };

  const handleGroupDragEnter = (event: React.DragEvent, groupId: string) => {
    if (!isSessionDrag(event) && draggedSessionId === null) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOverGroupId(groupId);
  };

  const beginPointerDrag = (event: React.PointerEvent, session: SavedSession) => {
    if (event.button !== 0) return;
    const movingIds = selectedSessionIds.has(session.id) && selectedSessionIds.size > 0
      ? [...selectedSessionIds]
      : [session.id];
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    pointerDraggedSessionIdsRef.current = movingIds;
    pointerDragActiveRef.current = false;
    suppressNextClickRef.current = false;
    event.preventDefault();
  };

  const finishPointerDrag = () => {
    pointerStartRef.current = null;
    pointerDraggedSessionIdsRef.current = [];
    pointerDragActiveRef.current = false;
  };

  const handlePointerDragEnter = (event: React.PointerEvent, groupId: string) => {
    if (!pointerDragActiveRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOverGroupId(groupId);
  };

  const selectedSessions = sessions.filter((session) => selectedSessionIds.has(session.id));

  const clearSelection = () => {
    setSelectedSessionIds(new Set());
    setSelectionAnchorId(null);
  };

  const handleGroupClick = (event: React.MouseEvent, groupId: string) => {
    if (suppressNextGroupClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextGroupClickRef.current = false;
      return;
    }
    toggleGroup(groupId);
  };

  const handleSidebarResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeStartRef.current = { x: event.clientX, width: sidebarWidth };
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSidebarResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.x));
  };

  const finishSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleSidebarResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((current) => clampSidebarWidth(current - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((current) => clampSidebarWidth(current + step));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(MAX_SIDEBAR_WIDTH);
    }
  };

  const handleSidebarKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selectedSessionIds.size > 0) {
      event.preventDefault();
      clearSelection();
      return;
    }
    const target = event.target as HTMLElement;
    const isTextInput = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !isTextInput) {
      event.preventDefault();
      const visibleIds = visibleSessions.map((candidate) => candidate.id);
      setSelectedSessionIds(new Set(visibleIds));
      setSelectionAnchorId(visibleIds.length > 0 ? visibleIds[visibleIds.length - 1] : null);
    }
  };

  const handleSessionClick = (event: React.MouseEvent, session: SavedSession) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      event.preventDefault();
      return;
    }
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchorIndex = visibleSessions.findIndex((candidate) => candidate.id === selectionAnchorId);
      const targetIndex = visibleSessions.findIndex((candidate) => candidate.id === session.id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const range = visibleSessions.slice(start, end + 1).map((candidate) => candidate.id);
        setSelectedSessionIds((current) => new Set(additive ? [...current, ...range] : range));
      } else {
        setSelectedSessionIds(new Set([session.id]));
      }
      setSelectionAnchorId(session.id);
      return;
    }
    if (additive) {
      setSelectedSessionIds((current) => {
        const next = new Set(current);
        if (next.has(session.id)) next.delete(session.id);
        else next.add(session.id);
        return next;
      });
      setSelectionAnchorId(session.id);
      return;
    }
    if (selectedSessionIds.size > 0) {
      setSelectedSessionIds(new Set([session.id]));
      setSelectionAnchorId(session.id);
      return;
    }
    // The first click opens/focuses immediately. The native double-click
    // handler below decides whether this gesture should create another tab.
    // Ignore the second click itself so it cannot create a duplicate tab.
    if (event.detail > 1) return;
    if (doubleClickStateRef.current) {
      window.clearTimeout(doubleClickStateRef.current.timer);
      doubleClickStateRef.current = null;
    }
    const timer = window.setTimeout(() => {
      if (doubleClickStateRef.current?.sessionId === session.id) {
        doubleClickStateRef.current = null;
      }
    }, 500);
    doubleClickStateRef.current = {
      sessionId: session.id,
      wasOpen: (activityBySessionId[session.id]?.openTabs ?? 0) > 0,
      timer,
    };
    markSessionOpened(session);
  };

  const handleSessionDoubleClick = (event: React.MouseEvent, session: SavedSession) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || selectedSessionIds.size > 0) return;
    event.preventDefault();
    const pending = doubleClickStateRef.current;
    const wasOpen = pending?.sessionId === session.id
      ? pending.wasOpen
      : (activityBySessionId[session.id]?.openTabs ?? 0) > 0;
    if (pending) window.clearTimeout(pending.timer);
    doubleClickStateRef.current = null;
    // A double-click on an already-open saved session creates a fresh SSH tab;
    // the first double-click on a closed session keeps the tab it just opened.
    if (wasOpen) markSessionOpened(session, { forceNew: true });
  };

  const sessionRow = (session: SavedSession) => {
    const activity = activityBySessionId[session.id];
    const activityState = primaryActivityState(activity);
    const activityDescription = formatActivitySummary(activity);
    return (
    <button
      key={session.id}
      className={`session-row ${activeSessionId === session.id ? "active" : ""} ${selectedSessionIds.has(session.id) ? "selected" : ""} ${draggedSessionIds.has(session.id) ? "dragging" : ""}`}
      onPointerDown={(event) => beginPointerDrag(event, session)}
      onClick={(event) => handleSessionClick(event, session)}
      onDoubleClick={(event) => handleSessionDoubleClick(event, session)}
      onContextMenu={(event) => showSessionMenu(event, session)}
      aria-pressed={selectedSessionIds.has(session.id)}
      aria-label={`${session.name}，${session.username}@${session.host}:${session.port}${activityDescription ? `，${activityDescription}` : ""}`}
      title={`${session.username}@${session.host}:${session.port}${activityDescription ? `\n${activityDescription}` : ""}\nCommand/Ctrl 多选 · Shift 范围选择 · 拖拽到目录可批量移动`}
    >
      <span className={`environment-dot ${session.environment ?? "development"}`} />
      <Server size={14} />
      <span className="session-row-copy">
        <strong>{session.name}</strong>
      </span>
      <span className="session-row-indicators" aria-hidden="true">
        {activity && (
          <span className={`session-activity-dot ${activityState}`} />
        )}
        {activity?.openTabs > 1 && <span className="session-tab-count">{activity.openTabs}</span>}
        {session.favorite && <Star size={12} className="favorite-icon" fill="currentColor" />}
      </span>
    </button>
    );
  };

  const renderGroup = (group: SessionGroup, depth = 0): React.ReactNode => {
    const children = groups.filter((candidate) => candidate.parentId === group.id);
    const groupSessions = visibleSessions.filter((session) => session.groupId === group.id);
    const isExpanded = expanded.has(group.id) || Boolean(normalizedQuery);
    if (normalizedQuery && groupSessions.length === 0 && children.length === 0) return null;
    return (
      <div key={group.id} className="group-block">
        <div
          className={`group-row xsh-group-drop-target ${dragOverGroupId === group.id ? "drag-over" : ""}`}
          data-xsh-drop-group={group.id}
          style={{ paddingLeft: 10 + depth * 12 }}
          onDragOver={(event) => handleGroupDragOver(event, group.id)}
          onDragEnter={(event) => handleGroupDragEnter(event, group.id)}
          onPointerEnter={(event) => handlePointerDragEnter(event, group.id)}
          onDragLeave={() => setDragOverGroupId((current) => current === group.id ? null : current)}
          onDrop={(event) => moveDraggedSession(event, group.id)}
          onContextMenu={(event) => showGroupMenu(event, group)}
        >
          <button
            className="group-toggle"
            onClick={(event) => handleGroupClick(event, group.id)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "折叠" : "展开"}目录 ${group.name}`}
            onDragOver={(event) => handleGroupDragOver(event, group.id)}
            onDragEnter={(event) => handleGroupDragEnter(event, group.id)}
            onPointerEnter={(event) => handlePointerDragEnter(event, group.id)}
            onDrop={(event) => moveDraggedSession(event, group.id)}
          >
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Folder size={14} style={{ color: group.color ?? undefined }} />
            <span>{group.name}</span>
          </button>
          <button className="group-add" onClick={() => onCreateGroup(group.id)} title="新建子目录">
            <FolderPlus size={13} />
          </button>
          <button className="group-more" onClick={(event) => showGroupMenu(event, group)} title="目录操作">
            <MoreHorizontal size={13} />
          </button>
        </div>
        {isExpanded && (
          <div
            className={`group-children xsh-group-drop-target ${dragOverGroupId === group.id ? "drag-over" : ""}`}
            data-xsh-drop-group={group.id}
            style={{ paddingLeft: `${Math.min(30, (depth + 1) * 8)}px` }}
            onDragOver={(event) => handleGroupDragOver(event, group.id)}
            onDragEnter={(event) => handleGroupDragEnter(event, group.id)}
            onPointerEnter={(event) => handlePointerDragEnter(event, group.id)}
            onDragLeave={() => setDragOverGroupId((current) => current === group.id ? null : current)}
            onDrop={(event) => moveDraggedSession(event, group.id)}
          >
            {children.map((child) => renderGroup(child, depth + 1))}
            {groupSessions.map((session) => sessionRow(session))}
          </div>
        )}
      </div>
    );
  };

  const favorites = visibleSessions.filter((session) => session.favorite);
  const roots = groups.filter((group) => !group.parentId);
  const ungrouped = visibleSessions.filter((session) => !session.groupId);

  let contextItems: ContextMenuItem[] = [];
  if (contextTarget?.type === "sidebar") {
    contextItems = [
      { label: "新建会话主机", onClick: onCreateSession },
      { label: "新建目录", onClick: () => onCreateGroup(null) },
    ];
  } else if (contextTarget?.type === "session") {
    const session = contextTarget.session;
    const contextSelection = selectedSessionIds.has(session.id) ? selectedSessions : [session];
    contextItems = contextSelection.length > 1
      ? [
          { label: `批量编辑选中的 ${contextSelection.length} 个会话`, onClick: () => { setContextTarget(null); onBatchEdit(contextSelection); } },
          { label: `收藏选中的 ${contextSelection.length} 个会话`, onClick: () => { setContextTarget(null); void onSetFavorite(contextSelection, true); } },
          { label: `取消收藏选中的 ${contextSelection.length} 个会话`, onClick: () => { setContextTarget(null); void onSetFavorite(contextSelection, false); } },
          { label: `删除选中的 ${contextSelection.length} 个会话`, onClick: () => { setContextTarget(null); void onDeleteSessions(contextSelection); }, danger: true, separatorBefore: true },
        ]
      : [
          { label: "连接", onClick: () => { setContextTarget(null); onOpen(session); } },
          { label: "连接诊断", onClick: () => { setContextTarget(null); onDiagnose(session); } },
          { label: "编辑", onClick: () => { setContextTarget(null); onEdit(session); } },
          { label: "复制会话", onClick: () => { setContextTarget(null); onDuplicate(session); } },
          { label: session.favorite ? "取消收藏" : "加入收藏", onClick: () => { setContextTarget(null); onToggleFavorite(session); } },
          { label: "删除会话", onClick: () => { setContextTarget(null); onDeleteSession(session); }, danger: true, separatorBefore: true },
        ];
  } else if (contextTarget?.type === "group") {
    const group = contextTarget.group;
    const sessionCount = countGroupSessions(group.id, groups, sessions);
    contextItems = [
      ...(sessionCount > 0
        ? [{ label: `打开目录内全部会话（${sessionCount}）`, onClick: () => onOpenGroup(group) }]
        : []),
      { label: "新建子目录", onClick: () => onCreateGroup(group.id) },
      { label: "重命名目录", onClick: () => onRenameGroup(group) },
      { label: "删除目录", onClick: () => onDeleteGroup(group), danger: true, separatorBefore: true },
    ];
  }

  return (
    <aside
      className={`session-sidebar ${isResizing ? "resizing" : ""}`}
      style={{ width: `${sidebarWidth}px` }}
      onKeyDown={handleSidebarKeyDown}
    >
      <div className="sidebar-controls">
        <div className="sidebar-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话、主机或标签"
            aria-label="搜索会话、主机或标签"
          />
        </div>
        <div className="sidebar-view-tools" aria-label="会话筛选和排序">
          <SlidersHorizontal size={13} />
          <select value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value as SessionFilter)} aria-label="筛选会话">
            <option value="all">全部会话</option>
            <option value="favorite">仅收藏</option>
            <option value="open">已打开</option>
            <option value="failed">需关注</option>
          </select>
          <select value={sessionSort} onChange={(event) => setSessionSort(event.target.value as SessionSort)} aria-label="排序会话">
            <option value="recent">最近使用</option>
            <option value="status">连接状态</option>
            <option value="name">名称</option>
          </select>
        </div>
        {selectedSessions.length > 0 && (
          <div className="session-batch-toolbar" aria-label="会话批量操作">
            <strong role="status">{selectedSessions.length} 已选</strong>
            <select
              value={batchGroupId}
              title="批量移动到目录"
              aria-label="批量移动到目录"
              onChange={(event) => {
                const value = event.target.value;
                setBatchGroupId("");
                if (!value) return;
                void onMoveSessions(selectedSessions, value === "__ungrouped__" ? null : value);
              }}
            >
              <option value="">移动到…</option>
              <option value="__ungrouped__">未分类</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{groupPathLabel(group, groups)}</option>)}
            </select>
            <button onClick={() => onBatchEdit(selectedSessions)} title="批量编辑" aria-label="批量编辑"><Pencil size={13} /></button>
            <button onClick={() => void onSetFavorite(selectedSessions, true)} title="批量收藏" aria-label="批量收藏"><Star size={13} /></button>
            <button onClick={() => void onSetFavorite(selectedSessions, false)} title="批量取消收藏" aria-label="批量取消收藏"><Star size={13} fill="currentColor" /></button>
            <button className="danger" onClick={() => void onDeleteSessions(selectedSessions)} title="批量删除" aria-label="批量删除"><Trash2 size={13} /></button>
            <button onClick={clearSelection} title="清除选择" aria-label="清除选择"><X size={13} /></button>
          </div>
        )}
      </div>
      <div className="session-tree" tabIndex={0} aria-label="会话列表" onContextMenu={showSidebarMenu}>
        {favorites.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-section-title"><Star size={13} />收藏</div>
            {favorites.map((session) => sessionRow(session))}
          </section>
        )}
        <section className="sidebar-section">
          <div className="sidebar-section-title">
            <span>会话目录</span>
            <button onClick={() => onCreateGroup(null)} title="新建目录"><FolderPlus size={14} /></button>
          </div>
          {roots.map((group) => renderGroup(group))}
          {(ungrouped.length > 0 || draggedSessionId !== null) && (
            <div
              className={`ungrouped-block xsh-group-drop-target ${dragOverGroupId === "__ungrouped__" ? "drag-over" : ""}`}
              data-xsh-drop-group="__ungrouped__"
              onDragOver={(event) => {
                if (!isSessionDrag(event) && draggedSessionId === null) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setDragOverGroupId("__ungrouped__");
              }}
              onDragEnter={(event) => {
                if (!isSessionDrag(event) && draggedSessionId === null) return;
                event.preventDefault();
                setDragOverGroupId("__ungrouped__");
              }}
              onPointerEnter={(event) => handlePointerDragEnter(event, "__ungrouped__")}
              onDragLeave={() => setDragOverGroupId((current) => current === "__ungrouped__" ? null : current)}
              onDrop={(event) => moveDraggedSession(event, null)}
            >
              <div
                className="ungrouped-title"
                onDragOver={(event) => handleGroupDragOver(event, "__ungrouped__")}
                onDragEnter={(event) => handleGroupDragEnter(event, "__ungrouped__")}
                onPointerEnter={(event) => handlePointerDragEnter(event, "__ungrouped__")}
                onDrop={(event) => moveDraggedSession(event, null)}
              >
                未分类
              </div>
              {ungrouped.map((session) => sessionRow(session))}
            </div>
          )}
          {visibleSessions.length === 0 && <div className="sidebar-empty">没有匹配的会话</div>}
        </section>
      </div>
      <div className={`sidebar-hint ${dragFeedback ? "drag-feedback" : ""}`} role="status">
        {dragFeedback ?? `${visibleSessions.length}/${sessions.length} 个会话 · Command/Ctrl 多选 · Shift 连选 · Esc 清除`}
      </div>
      {contextTarget && (
        <ContextMenu
          x={contextTarget.x}
          y={contextTarget.y}
          items={contextItems}
          onClose={() => setContextTarget(null)}
        />
      )}
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整会话侧栏宽度"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={handleSidebarResizePointerDown}
        onPointerMove={handleSidebarResizePointerMove}
        onPointerUp={finishSidebarResize}
        onPointerCancel={finishSidebarResize}
        onKeyDown={handleSidebarResizeKeyDown}
      />
    </aside>
  );
}

function groupPathLabel(group: SessionGroup, groups: SessionGroup[]): string {
  const names = [group.name];
  let parentId = group.parentId;
  const visited = new Set<string>([group.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = groups.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}

function primaryActivityState(activity?: SessionActivitySummary): string {
  if (!activity) return "idle";
  if (activity.connected > 0) return "connected";
  if (activity.waitingNetwork > 0) return "waiting-network";
  if (activity.reconnecting > 0) return "reconnecting";
  if (activity.connecting > 0) return "connecting";
  if (activity.failed > 0) return "failed";
  return "disconnected";
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function loadSidebarWidth(): number {
  const storedValue = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (!storedValue) return 244;
  const stored = Number(storedValue);
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : 244;
}

function formatActivitySummary(activity?: SessionActivitySummary): string {
  if (!activity) return "";
  const parts = [`${activity.openTabs} 个标签`];
  if (activity.connected > 0) parts.push(`${activity.connected} 个已连接`);
  if (activity.connecting > 0) parts.push(`${activity.connecting} 个连接中`);
  if (activity.reconnecting > 0) parts.push(`${activity.reconnecting} 个重连中`);
  if (activity.waitingNetwork > 0) parts.push(`${activity.waitingNetwork} 个等待网络`);
  if (activity.failed > 0) parts.push(`${activity.failed} 个失败`);
  if (activity.disconnected > 0) parts.push(`${activity.disconnected} 个已断开`);
  return parts.join("，");
}

function countGroupSessions(groupId: string, groups: SessionGroup[], sessions: SavedSession[]): number {
  const included = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    groups.forEach((group) => {
      if (group.parentId && included.has(group.parentId) && !included.has(group.id)) {
        included.add(group.id);
        changed = true;
      }
    });
  }
  return sessions.filter((session) => session.groupId && included.has(session.groupId)).length;
}

function loadRecentSessions(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(RECENT_SESSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}
