export interface CommandHistoryEntry {
  id: string;
  sessionId: string;
  sessionName: string;
  command: string;
  source: "terminal" | "command-center" | "quick-command";
  createdAt: string;
}

const STORAGE_KEY = "xsh.command-history.v1";
const MAX_ENTRIES = 300;

export function loadCommandHistory(): CommandHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function recordCommandHistory(
  current: CommandHistoryEntry[],
  entry: Omit<CommandHistoryEntry, "id" | "createdAt">,
): CommandHistoryEntry[] {
  const command = entry.command.trim();
  if (!command) return current;
  const next: CommandHistoryEntry = {
    ...entry,
    command,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const deduped = current.filter(
    (candidate) => !(candidate.sessionId === entry.sessionId && candidate.command === command),
  );
  const result = [next, ...deduped].slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  return result;
}

export function saveCommandHistory(entries: CommandHistoryEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

function isEntry(value: unknown): value is CommandHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommandHistoryEntry>;
  return typeof candidate.id === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.sessionName === "string"
    && typeof candidate.command === "string"
    && (candidate.source === "terminal" || candidate.source === "command-center" || candidate.source === "quick-command")
    && typeof candidate.createdAt === "string";
}
