import type { TerminalTrigger } from "./types";

const MAX_MATCH_BUFFER = 8_192;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const REGEX_CACHE_LIMIT = 256;
const compiledRegexCache = new Map<string, RegExp>();

/**
 * Compiling a trigger regex on every output chunk is the dominant cost of
 * trigger matching when large output streams past, so compiled expressions
 * are cached by pattern+flags. `lastIndex` is reset because the exec loop in
 * `findMatch` leaves it wherever the last scan ended.
 */
function compiledTriggerRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  const flags = caseSensitive ? "g" : "gi";
  const key = `${flags}:${pattern}`;
  const cached = compiledRegexCache.get(key);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  try {
    const expression = new RegExp(pattern, flags);
    if (compiledRegexCache.size >= REGEX_CACHE_LIMIT) compiledRegexCache.clear();
    compiledRegexCache.set(key, expression);
    return expression;
  } catch {
    return null;
  }
}

export interface TerminalTriggerMatch {
  trigger: TerminalTrigger;
  matchedText: string;
}

/**
 * Keeps enough clean output to match terms that are split across transport
 * chunks. Matching stays in the renderer, so a trigger cannot execute code.
 */
export class TerminalTriggerMatcher {
  private tail = "";
  private readonly lastFiredAt = new Map<string, number>();

  reset() {
    this.tail = "";
    this.lastFiredAt.clear();
  }

  match(output: string, triggers: TerminalTrigger[], now = Date.now()): TerminalTriggerMatch[] {
    const cleaned = output.replace(ANSI_ESCAPE, "");
    const source = `${this.tail}${cleaned}`;
    const appendedAt = this.tail.length;
    const matches: TerminalTriggerMatch[] = [];

    for (const trigger of triggers) {
      if (!trigger.enabled || !trigger.pattern.trim()) continue;
      const cooldownMilliseconds = Math.max(0, trigger.cooldownSeconds) * 1_000;
      const lastFiredAt = this.lastFiredAt.get(trigger.id) ?? Number.NEGATIVE_INFINITY;
      if (now - lastFiredAt < cooldownMilliseconds) continue;

      const match = findMatch(source, trigger, appendedAt);
      if (!match) continue;
      this.lastFiredAt.set(trigger.id, now);
      matches.push({ trigger, matchedText: match });
    }

    this.tail = source.slice(-MAX_MATCH_BUFFER);
    return matches;
  }
}

export function matchesTerminalShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const expected = normalizeShortcut(shortcut);
  if (!expected) return false;
  return normalizeShortcutFromEvent(event) === expected;
}

function findMatch(source: string, trigger: TerminalTrigger, appendedAt: number): string | null {
  if (trigger.matchMode === "regex") {
    const expression = compiledTriggerRegex(trigger.pattern, trigger.caseSensitive);
    if (!expression) return null;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(source)) !== null) {
      if (match.index + match[0].length > appendedAt) return match[0];
      if (match[0].length === 0) expression.lastIndex += 1;
    }
    return null;
  }
  const expected = trigger.caseSensitive ? trigger.pattern : trigger.pattern.toLocaleLowerCase();
  const haystack = trigger.caseSensitive ? source : source.toLocaleLowerCase();
  const index = haystack.indexOf(expected, Math.max(0, appendedAt - expected.length + 1));
  return index < 0 ? null : source.slice(index, index + trigger.pattern.length);
}

function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const key = parts.pop();
  if (!key) return "";
  const modifiers = new Set(parts.map(normalizeModifier));
  if (modifiers.has("")) return "";
  return [
    modifiers.has("ctrl") ? "ctrl" : "",
    modifiers.has("alt") ? "alt" : "",
    modifiers.has("shift") ? "shift" : "",
    modifiers.has("meta") ? "meta" : "",
    normalizeKey(key),
  ].filter(Boolean).join("+");
}

function normalizeShortcutFromEvent(event: KeyboardEvent): string {
  return [
    event.ctrlKey ? "ctrl" : "",
    event.altKey ? "alt" : "",
    event.shiftKey ? "shift" : "",
    event.metaKey ? "meta" : "",
    normalizeKey(event.key),
  ].filter(Boolean).join("+");
}

function normalizeModifier(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "ctrl" || normalized === "control") return "ctrl";
  if (normalized === "alt" || normalized === "option") return "alt";
  if (normalized === "shift") return "shift";
  if (normalized === "meta" || normalized === "cmd" || normalized === "command" || normalized === "win") return "meta";
  return "";
}

function normalizeKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "esc") return "escape";
  if (normalized === "return") return "enter";
  if (normalized === "space") return " ";
  return normalized;
}
