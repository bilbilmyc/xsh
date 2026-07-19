export type WorkspacePaneLayout = "single" | "vertical" | "horizontal";

export interface WorkspaceTabSnapshot {
  id: string;
  sessionId: string;
  locked: boolean;
  color: string | null;
}

export interface WorkspaceSnapshot {
  version: 1;
  tabs: WorkspaceTabSnapshot[];
  activeTabId: string | null;
  secondaryTabId: string | null;
  paneLayout: WorkspacePaneLayout;
}

export interface NamedWorkspace {
  id: string;
  name: string;
  snapshot: WorkspaceSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceExportBundle {
  format: "xsh-named-workspaces";
  version: 1;
  exportedAt: string;
  workspaces: NamedWorkspace[];
}

const STORAGE_KEY = "xsh.workspace.v1";
const NAMED_STORAGE_KEY = "xsh.named-workspaces.v1";
const MAX_RESTORED_TABS = 64;
const MAX_NAMED_WORKSPACES = 24;

export function loadWorkspaceSnapshot(): WorkspaceSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeWorkspaceSnapshot(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceSnapshot(snapshot: Omit<WorkspaceSnapshot, "version">): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(createSafeSnapshot(snapshot)));
}

export function loadNamedWorkspaces(): NamedWorkspace[] {
  try {
    const raw = window.localStorage.getItem(NAMED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeNamedWorkspace)
      .filter((workspace): workspace is NamedWorkspace => workspace !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_NAMED_WORKSPACES);
  } catch {
    return [];
  }
}

export function saveNamedWorkspaces(workspaces: NamedWorkspace[]): void {
  const safe = workspaces
    .slice(0, MAX_NAMED_WORKSPACES)
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name.trim().slice(0, 64),
      snapshot: createSafeSnapshot(workspace.snapshot),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    }))
    .filter((workspace) => workspace.id && workspace.name);
  window.localStorage.setItem(NAMED_STORAGE_KEY, JSON.stringify(safe));
}

export function serializeNamedWorkspaces(workspaces: NamedWorkspace[]): string {
  const bundle: WorkspaceExportBundle = {
    format: "xsh-named-workspaces",
    version: 1,
    exportedAt: new Date().toISOString(),
    workspaces: workspaces
      .map(normalizeNamedWorkspace)
      .filter((workspace): workspace is NamedWorkspace => workspace !== null)
      .slice(0, MAX_NAMED_WORKSPACES),
  };
  return JSON.stringify(bundle, null, 2);
}

export function parseNamedWorkspaces(contents: string): NamedWorkspace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("工作区文件不是有效的 JSON。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("工作区文件格式不正确。");
  }
  const bundle = parsed as Partial<WorkspaceExportBundle>;
  if (bundle.format !== "xsh-named-workspaces" || bundle.version !== 1 || !Array.isArray(bundle.workspaces)) {
    throw new Error("不是受支持的 XSH 工作区文件。");
  }
  const normalized = bundle.workspaces
    .map(normalizeNamedWorkspace)
    .filter((workspace): workspace is NamedWorkspace => workspace !== null)
    .slice(0, MAX_NAMED_WORKSPACES);
  if (normalized.length === 0 && bundle.workspaces.length > 0) {
    throw new Error("文件中没有可用的工作区记录。");
  }
  return normalized;
}

export function createNamedWorkspace(name: string, snapshot: Omit<WorkspaceSnapshot, "version">): NamedWorkspace {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 64),
    snapshot: createSafeSnapshot(snapshot),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateNamedWorkspace(
  workspace: NamedWorkspace,
  updates: { name?: string; snapshot?: Omit<WorkspaceSnapshot, "version"> },
): NamedWorkspace {
  return {
    ...workspace,
    name: updates.name === undefined ? workspace.name : updates.name.trim().slice(0, 64),
    snapshot: updates.snapshot === undefined ? workspace.snapshot : createSafeSnapshot(updates.snapshot),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeNamedWorkspace(value: unknown): NamedWorkspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<NamedWorkspace>;
  const snapshot = normalizeWorkspaceSnapshot(candidate.snapshot);
  if (
    typeof candidate.id !== "string" || !candidate.id.trim() ||
    typeof candidate.name !== "string" || !candidate.name.trim() ||
    !snapshot
  ) return null;
  return {
    id: candidate.id,
    name: candidate.name.trim().slice(0, 64),
    snapshot,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  };
}

function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<WorkspaceSnapshot>;
  if (candidate.version !== 1 || !Array.isArray(candidate.tabs)) return null;

  const seenTabIds = new Set<string>();
  const tabs = candidate.tabs
    .filter((tab): tab is WorkspaceTabSnapshot => {
      if (!tab || typeof tab !== "object") return false;
      const item = tab as Partial<WorkspaceTabSnapshot>;
      if (typeof item.id !== "string" || typeof item.sessionId !== "string") return false;
      const id = item.id.trim();
      const sessionId = item.sessionId.trim();
      if (!id || !sessionId || seenTabIds.has(id)) return false;
      seenTabIds.add(id);
      return true;
    })
    .slice(0, MAX_RESTORED_TABS)
    .map((tab) => ({
      id: tab.id.trim(),
      sessionId: tab.sessionId.trim(),
      locked: tab.locked === true,
      color: normalizeTabColor(tab.color),
    }));

  const paneLayout = candidate.paneLayout === "vertical" || candidate.paneLayout === "horizontal"
    ? candidate.paneLayout
    : "single";

  return {
    version: 1,
    tabs,
    activeTabId: typeof candidate.activeTabId === "string" ? candidate.activeTabId : null,
    secondaryTabId: typeof candidate.secondaryTabId === "string" ? candidate.secondaryTabId : null,
    paneLayout,
  };
}

function createSafeSnapshot(snapshot: Omit<WorkspaceSnapshot, "version"> | WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    version: 1,
    tabs: snapshot.tabs.slice(0, MAX_RESTORED_TABS).map((tab) => ({
      id: tab.id,
      sessionId: tab.sessionId,
      locked: tab.locked === true,
      color: normalizeTabColor(tab.color),
    })),
    activeTabId: snapshot.activeTabId,
    secondaryTabId: snapshot.secondaryTabId,
    paneLayout: snapshot.paneLayout,
  };
}

function normalizeTabColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}
