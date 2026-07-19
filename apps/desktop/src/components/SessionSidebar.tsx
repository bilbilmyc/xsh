import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Search,
  Server,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { SavedSession, SessionGroup } from "../types";
import type { RecentSession } from "../recent-sessions";

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
  recentSessions: RecentSession[];
  onOpen: (session: SavedSession) => void;
  onOpenGroup: (group: SessionGroup) => void;
  onDiagnose: (session: SavedSession) => void;
  onEdit: (session: SavedSession) => void;
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
  | { type: "session"; session: SavedSession; x: number; y: number }
  | { type: "group"; group: SessionGroup; x: number; y: number };

export function SessionSidebar({
  groups,
  sessions,
  activeSessionId,
  activityBySessionId,
  recentSessions,
  onOpen,
  onOpenGroup,
  onDiagnose,
  onEdit,
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
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null);
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [batchGroupId, setBatchGroupId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.map((group) => group.id)),
  );

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

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = useMemo(
    () =>
      sessions.filter((session) => {
        if (!normalizedQuery) return true;
        return [session.name, session.host, session.username, ...session.tags].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        );
      }),
    [normalizedQuery, sessions],
  );

  const toggleGroup = (groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const showSessionMenu = (event: React.MouseEvent, session: SavedSession) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedSessionIds.has(session.id)) {
      setSelectedSessionIds(new Set([session.id]));
      setSelectionAnchorId(session.id);
    }
    setContextTarget({ type: "session", session, x: event.clientX, y: event.clientY });
  };

  const showGroupMenu = (event: React.MouseEvent, group: SessionGroup) => {
    event.preventDefault();
    event.stopPropagation();
    setContextTarget({ type: "group", group, x: event.clientX, y: event.clientY });
  };

  const moveDraggedSession = (event: React.DragEvent, groupId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const sessionId = event.dataTransfer.getData("text/plain");
    const dragged = sessions.find((candidate) => candidate.id === sessionId);
    const moving = dragged && selectedSessionIds.has(dragged.id)
      ? sessions.filter((candidate) => selectedSessionIds.has(candidate.id))
      : dragged ? [dragged] : [];
    const changed = moving.filter((session) => session.groupId !== groupId);
    if (changed.length === 1) {
      void onMoveSession(changed[0], groupId);
    } else if (changed.length > 1) {
      void onMoveSessions(changed, groupId);
    }
    setDraggedSessionId(null);
    setDragOverGroupId(null);
  };

  const selectedSessions = sessions.filter((session) => selectedSessionIds.has(session.id));

  const clearSelection = () => {
    setSelectedSessionIds(new Set());
    setSelectionAnchorId(null);
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
    onOpen(session);
  };

  const sessionRow = (session: SavedSession, recentLabel?: string) => {
    const activity = activityBySessionId[session.id];
    const activityState = primaryActivityState(activity);
    const activityDescription = formatActivitySummary(activity);
    return (
    <button
      key={session.id}
      className={`session-row ${activeSessionId === session.id ? "active" : ""} ${selectedSessionIds.has(session.id) ? "selected" : ""} ${draggedSessionId === session.id ? "dragging" : ""}`}
      draggable
      onDragStart={(event) => {
        setDraggedSessionId(session.id);
        if (!selectedSessionIds.has(session.id)) {
          setSelectedSessionIds(new Set([session.id]));
          setSelectionAnchorId(session.id);
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", session.id);
      }}
      onDragEnd={() => {
        setDraggedSessionId(null);
        setDragOverGroupId(null);
      }}
      onDoubleClick={() => onOpen(session)}
      onClick={(event) => handleSessionClick(event, session)}
      onContextMenu={(event) => showSessionMenu(event, session)}
      aria-pressed={selectedSessionIds.has(session.id)}
      aria-label={`${session.name}，${session.username}@${session.host}:${session.port}${activityDescription ? `，${activityDescription}` : ""}`}
      title={`${session.username}@${session.host}:${session.port}${activityDescription ? `\n${activityDescription}` : ""}\nCommand/Ctrl 多选 · Shift 范围选择 · 拖拽到目录可批量移动`}
    >
      <span className={`environment-dot ${session.environment ?? "development"}`} />
      <Server size={14} />
      <span className="session-row-copy">
        <strong>{session.name}</strong>
        <small>{recentLabel ? `${session.username}@${session.host} · ${recentLabel}` : `${session.username}@${session.host}`}</small>
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
          className={`group-row ${dragOverGroupId === group.id ? "drag-over" : ""}`}
          style={{ paddingLeft: 10 + depth * 12 }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            setDragOverGroupId(group.id);
          }}
          onDragLeave={() => setDragOverGroupId((current) => current === group.id ? null : current)}
          onDrop={(event) => moveDraggedSession(event, group.id)}
          onContextMenu={(event) => showGroupMenu(event, group)}
        >
          <button
            className="group-toggle"
            onClick={() => toggleGroup(group.id)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "折叠" : "展开"}目录 ${group.name}`}
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
          <div className="group-children" style={{ paddingLeft: depth * 12 }}>
            {children.map((child) => renderGroup(child, depth + 1))}
            {groupSessions.map((session) => sessionRow(session))}
          </div>
        )}
      </div>
    );
  };

  const favorites = visibleSessions.filter((session) => session.favorite);
  const recentlyConnected = recentSessions
    .map((recent) => {
      const session = visibleSessions.find((candidate) => candidate.id === recent.sessionId);
      return session ? { session, label: formatRecentTime(recent.lastConnectedAt) } : null;
    })
    .filter((item): item is { session: SavedSession; label: string } => item !== null);
  const roots = groups.filter((group) => !group.parentId);
  const ungrouped = visibleSessions.filter((session) => !session.groupId);

  let contextItems: ContextMenuItem[] = [];
  if (contextTarget?.type === "session") {
    const session = contextTarget.session;
    contextItems = selectedSessions.length > 1
      ? [
          { label: `批量编辑选中的 ${selectedSessions.length} 个会话`, onClick: () => onBatchEdit(selectedSessions) },
          { label: `收藏选中的 ${selectedSessions.length} 个会话`, onClick: () => void onSetFavorite(selectedSessions, true) },
          { label: `取消收藏选中的 ${selectedSessions.length} 个会话`, onClick: () => void onSetFavorite(selectedSessions, false) },
          { label: `删除选中的 ${selectedSessions.length} 个会话`, onClick: () => void onDeleteSessions(selectedSessions), danger: true, separatorBefore: true },
        ]
      : [
          { label: "连接", onClick: () => onOpen(session) },
          { label: "连接诊断", onClick: () => onDiagnose(session) },
          { label: "编辑", onClick: () => onEdit(session) },
          { label: "复制会话", onClick: () => onDuplicate(session) },
          { label: session.favorite ? "取消收藏" : "加入收藏", onClick: () => onToggleFavorite(session) },
          { label: "删除会话", onClick: () => onDeleteSession(session), danger: true, separatorBefore: true },
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
    <aside className="session-sidebar" onKeyDown={handleSidebarKeyDown}>
      <div className="sidebar-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话、主机或标签"
          aria-label="搜索会话、主机或标签"
        />
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
      <div className="session-tree" tabIndex={0} aria-label="会话列表">
        {favorites.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-section-title"><Star size={13} />收藏</div>
            {favorites.map((session) => sessionRow(session))}
          </section>
        )}
        {recentlyConnected.length > 0 && (
          <section className="sidebar-section recent-sessions-section">
            <div className="sidebar-section-title"><Clock3 size={13} />最近连接</div>
            {recentlyConnected.map(({ session, label }) => sessionRow(session, label))}
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
              className={`ungrouped-block ${dragOverGroupId === "ungrouped" ? "drag-over" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setDragOverGroupId("ungrouped");
              }}
              onDragLeave={() => setDragOverGroupId((current) => current === "ungrouped" ? null : current)}
              onDrop={(event) => moveDraggedSession(event, null)}
            >
              <div className="ungrouped-title">未分类</div>
              {ungrouped.map((session) => sessionRow(session))}
            </div>
          )}
          {visibleSessions.length === 0 && <div className="sidebar-empty">没有匹配的会话</div>}
        </section>
      </div>
      <div className="sidebar-hint">单击连接 · Command/Ctrl 多选 · Shift 连选 · Command/Ctrl+A 全选 · Esc 清除</div>
      {contextTarget && (
        <ContextMenu
          x={contextTarget.x}
          y={contextTarget.y}
          items={contextItems}
          onClose={() => setContextTarget(null)}
        />
      )}
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

function formatRecentTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "最近";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1_000));
  if (seconds < 60) return "刚刚连接";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  if (seconds < 172_800) return "昨天连接";
  return `${Math.floor(seconds / 86_400)} 天前`;
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
