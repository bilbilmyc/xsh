import { containsSensitiveCommand } from "./sensitive-command.ts";

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
    const entries = parsed.filter(isEntry).slice(0, MAX_ENTRIES);
    const safeEntries = entries.filter((entry) => !containsSensitiveCommand(entry.command));
    if (safeEntries.length !== parsed.length) saveCommandHistory(safeEntries);
    return safeEntries;
  } catch {
    return [];
  }
}

export function recordCommandHistory(
  current: CommandHistoryEntry[],
  entry: Omit<CommandHistoryEntry, "id" | "createdAt">,
): CommandHistoryEntry[] {
  const safeCurrent = current.filter((candidate) => !containsSensitiveCommand(candidate.command));
  const command = entry.command.trim();
  if (!command || containsSensitiveCommand(command)) {
    if (safeCurrent.length !== current.length) saveCommandHistory(safeCurrent);
    return safeCurrent;
  }
  const next: CommandHistoryEntry = {
    ...entry,
    command,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const deduped = safeCurrent.filter(
    (candidate) => !(candidate.sessionId === entry.sessionId && candidate.command === command),
  );
  const result = [next, ...deduped].slice(0, MAX_ENTRIES);
  saveCommandHistory(result);
  return result;
}

export function saveCommandHistory(entries: CommandHistoryEntry[]) {
  const safeEntries = entries
    .filter(isEntry)
    .filter((entry) => !containsSensitiveCommand(entry.command))
    .slice(0, MAX_ENTRIES);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safeEntries));
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
