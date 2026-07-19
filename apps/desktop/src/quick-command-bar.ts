import { containsSensitiveCommand } from "./sensitive-command";

const STORAGE_KEY = "xsh.quick-command-bar.v1";
export const QUICK_COMMAND_SLOT_COUNT = 10;

export interface QuickCommandItem {
  id: string;
  label: string;
  command: string;
  group: string;
  shortcut: string | null;
  requiresConfirmation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuickCommandDraft {
  label: string;
  command: string;
  group: string;
  shortcut: string | null;
  requiresConfirmation: boolean;
}

export const emptyQuickCommand = (): QuickCommandDraft => ({
  label: "",
  command: "",
  group: "默认",
  shortcut: null,
  requiresConfirmation: false,
});

export function loadQuickCommandBar(): Array<QuickCommandItem | null> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySlots();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return emptySlots();
    const normalized = Array.from({ length: QUICK_COMMAND_SLOT_COUNT }, (_, index) => normalizeItem(parsed[index]));
    if (normalized.some((item, index) => item === null && parsed[index] != null)) saveQuickCommandBar(normalized);
    return normalized;
  } catch {
    return emptySlots();
  }
}

export function saveQuickCommandBar(items: Array<QuickCommandItem | null>): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(Array.from({ length: QUICK_COMMAND_SLOT_COUNT }, (_, index) => {
      const item = items[index] ?? null;
      return item && !containsSensitiveCommand(item.command) ? item : null;
    })),
  );
}

export function createQuickCommand(draft: QuickCommandDraft): QuickCommandItem {
  const now = new Date().toISOString();
  return normalizeDraft({
    id: crypto.randomUUID(),
    ...draft,
    createdAt: now,
    updatedAt: now,
  });
}

export function updateQuickCommand(existing: QuickCommandItem, draft: QuickCommandDraft): QuickCommandItem {
  return normalizeDraft({
    id: existing.id,
    ...draft,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

function emptySlots(): Array<null> {
  return Array.from({ length: QUICK_COMMAND_SLOT_COUNT }, () => null);
}

function normalizeItem(value: unknown): QuickCommandItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QuickCommandItem> & { kind?: string };
  // Password quick actions from the previous version are intentionally not loaded.
  if (candidate.kind === "password" || containsSensitiveCommand(candidate.command ?? "")) return null;
  if (typeof candidate.id !== "string" || typeof candidate.label !== "string" || typeof candidate.command !== "string") {
    return null;
  }
  return normalizeDraft({
    id: candidate.id,
    label: candidate.label,
    command: candidate.command,
    group: typeof candidate.group === "string" ? candidate.group : "默认",
    shortcut: normalizeShortcut(candidate.shortcut),
    requiresConfirmation: candidate.requiresConfirmation === true,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
  });
}

function normalizeDraft(item: QuickCommandItem): QuickCommandItem {
  return {
    ...item,
    label: item.label.trim().slice(0, 32),
    group: item.group.trim().slice(0, 32) || "默认",
    shortcut: normalizeShortcut(item.shortcut),
    // Keep literal escape sequences such as \\r and \\t in storage. They are
    // interpreted only at send time, so the editor remains easy to read/edit.
    command: item.command.replace(/\r\n/g, "\n").slice(0, 8_000),
  };
}

function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^mod-[1-9]$/.test(normalized) ? normalized : null;
}
