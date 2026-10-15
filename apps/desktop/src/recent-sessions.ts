const STORAGE_KEY = "xsh.recent-sessions.v1";
const LEGACY_STORAGE_KEY = "xsh.session-sidebar.recent.v1";
const MAX_RECENT_SESSIONS = 12;

export interface RecentSession {
  sessionId: string;
  lastConnectedAt: string;
}

export function loadRecentSessions(): RecentSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeRecentSessions(parsed.filter(isRecentSession));
  } catch {
    return [];
  }
}

export function loadRecentlyOpenedSessions(): RecentSession[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const entries = Object.entries(parsed).flatMap(([sessionId, timestamp]) => {
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return [];
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return [];
      return [{ sessionId, lastConnectedAt: date.toISOString() }];
    });
    return normalizeRecentSessions(entries);
  } catch {
    return [];
  }
}

export function recordRecentSession(sessionId: string, now = new Date().toISOString()): RecentSession[] {
  const next = normalizeRecentSessions([
    { sessionId, lastConnectedAt: now },
    ...loadRecentSessions().filter((item) => item.sessionId !== sessionId),
  ]);
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENT_SESSIONS)));
  } catch {
    return;
  }
}

function isRecentSession(value: unknown): value is RecentSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentSession>;
  return typeof candidate.sessionId === "string" && candidate.sessionId.trim().length > 0
    && typeof candidate.lastConnectedAt === "string"
    && Number.isFinite(Date.parse(candidate.lastConnectedAt));
}

function normalizeRecentSessions(items: RecentSession[]): RecentSession[] {
  const sorted = items.filter(isRecentSession).sort((left, right) =>
    Date.parse(right.lastConnectedAt) - Date.parse(left.lastConnectedAt),
  );
  const seen = new Set<string>();
  return sorted.filter((item) => {
    if (seen.has(item.sessionId)) return false;
    seen.add(item.sessionId);
    return true;
  }).slice(0, MAX_RECENT_SESSIONS);
}
