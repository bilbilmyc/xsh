import { containsSensitiveCommand } from "./sensitive-command";

const STORAGE_KEY = "xsh.command-library.v1";
const MAX_COMMANDS = 250;

export interface CommandSnippet {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  command: string;
  requiresConfirmation: boolean;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CommandSnippetDraft = Omit<CommandSnippet, "id" | "createdAt" | "updatedAt">;

export const emptyCommandSnippet = (): CommandSnippetDraft => ({
  name: "",
  description: "",
  category: "常用",
  tags: [],
  command: "",
  requiresConfirmation: false,
  favorite: false,
});

export function loadCommandLibrary(): CommandSnippet[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .map(normalizeCommand)
      .filter((command): command is CommandSnippet => command !== null)
      .sort(sortCommands);
    if (normalized.length !== parsed.length) saveCommandLibrary(normalized);
    return normalized;
  } catch {
    return [];
  }
}

export function saveCommandLibrary(commands: CommandSnippet[]): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(commands.filter((command) => !containsSensitiveCommand(command.command)).slice(0, MAX_COMMANDS)),
  );
}

export function createCommandSnippet(draft: CommandSnippetDraft): CommandSnippet {
  const now = new Date().toISOString();
  return normalizeDraft({
    ...draft,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
}

export function updateCommandSnippet(existing: CommandSnippet, draft: CommandSnippetDraft): CommandSnippet {
  return normalizeDraft({
    ...draft,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

function normalizeCommand(value: unknown): CommandSnippet | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CommandSnippet>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.command !== "string" ||
    containsSensitiveCommand(candidate.command)
  ) {
    return null;
  }
  try {
    return normalizeDraft({
      id: candidate.id,
      name: candidate.name,
      description: typeof candidate.description === "string" ? candidate.description : "",
      category: typeof candidate.category === "string" ? candidate.category : "常用",
      tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === "string") : [],
      command: candidate.command,
      requiresConfirmation: candidate.requiresConfirmation === true,
      favorite: candidate.favorite === true,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

function normalizeDraft(command: CommandSnippet): CommandSnippet {
  return {
    ...command,
    name: command.name.trim().slice(0, 80),
    description: command.description.trim().slice(0, 240),
    category: command.category.trim().slice(0, 40) || "常用",
    tags: [...new Set(command.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12),
    command: command.command.replace(/\r\n/g, "\n").slice(0, 20_000),
  };
}

function sortCommands(a: CommandSnippet, b: CommandSnippet): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}
