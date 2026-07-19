const STORAGE_KEY = "xsh.recent-sessions.v1";
const MAX_RECENT_SESSIONS = 12;

export interface RecentSession {
  sessionId: string;
  lastConnectedAt: string;
}

export function loadRecentSessions(): RecentSession[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentSession)
      .sort((a, b) => b.lastConnectedAt.localeCompare(a.lastConnectedAt))
      .slice(0, MAX_RECENT_SESSIONS);
  } catch {
    return [];
  }
}

export function recordRecentSession(sessionId: string, now = new Date().toISOString()): RecentSession[] {
  const next = [
    { sessionId, lastConnectedAt: now },
    ...loadRecentSessions().filter((item) => item.sessionId !== sessionId),
  ].slice(0, MAX_RECENT_SESSIONS);
  saveRecentSessions(next);
  return next;
}

export function pruneRecentSessions(validSessionIds: Iterable<string>): RecentSession[] {
  const valid = new Set(validSessionIds);
  const next = loadRecentSessions().filter((item) => valid.has(item.sessionId));
  saveRecentSessions(next);
  return next;
}

function saveRecentSessions(items: RecentSession[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENT_SESSIONS)));
}

function isRecentSession(value: unknown): value is RecentSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentSession>;
  return typeof candidate.sessionId === "string" && typeof candidate.lastConnectedAt === "string";
}
