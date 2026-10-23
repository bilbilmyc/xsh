import type { SavedSession } from "./types";

export interface DirectoryWorkspace {
  recent: string[];
  bookmarks: string[];
  localDirectory: string;
}
const EMPTY: DirectoryWorkspace = { recent: [], bookmarks: [], localDirectory: "" };
const PREFIX = "xsh.directory-workspace.v1:";
export function directoryWorkspaceKey(session: Pick<SavedSession, "host" | "port" | "username">): string {
  return PREFIX + JSON.stringify([session.host.toLowerCase(), session.port, session.username]);
}
export function safeDirectory(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(path);
}
export function parseDirectoryWorkspace(raw: string | null): DirectoryWorkspace {
  try {
    const value = JSON.parse(raw ?? "{}");
    const paths = (items: unknown, limit: number) => Array.isArray(items) ? [...new Set(items.filter(safeDirectory))].slice(0, limit) : [];
    return { recent: paths(value.recent, 12), bookmarks: paths(value.bookmarks, 24), localDirectory: safeDirectory(value.localDirectory) ? value.localDirectory : "" };
  } catch { return { ...EMPTY }; }
}
export function loadDirectoryWorkspace(key: string): DirectoryWorkspace {
  try { return parseDirectoryWorkspace(localStorage.getItem(key)); } catch { return { ...EMPTY }; }
}
export function saveDirectoryWorkspace(key: string, workspace: DirectoryWorkspace): boolean {
  try { localStorage.setItem(key, JSON.stringify(workspace)); return true; } catch { return false; }
}
export function rememberDirectory(workspace: DirectoryWorkspace, path: string): DirectoryWorkspace {
  if (!safeDirectory(path)) return workspace;
  return { ...workspace, recent: [path, ...workspace.recent.filter((previous) => previous !== path)].slice(0, 12) };
}
export function toggleDirectoryBookmark(workspace: DirectoryWorkspace, path: string): DirectoryWorkspace {
  if (!safeDirectory(path)) return workspace;
  return { ...workspace, bookmarks: workspace.bookmarks.includes(path) ? workspace.bookmarks.filter((item) => item !== path) : [...workspace.bookmarks, path].slice(-24) };
}
export function parseTerminalDirectory(uri: string): string | null {
  try {
    if (!uri.startsWith("file://") || uri.length > 12 * 1024) return null;
    const value = new URL(uri);
    if (value.username || value.password || value.search || value.hash || value.port) return null;
    const path = decodeURIComponent(value.pathname);
    return path.startsWith("/") && safeDirectory(path) ? path : null;
  } catch { return null; }
}
export function directoryCommand(path: string): string | null {
  if (!path.startsWith("/") || !safeDirectory(path)) return null;
  return `cd -- '${path.replace(/'/g, "'\\''")}'`;
}
