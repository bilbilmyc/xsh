export type AppTheme = "midnight" | "graphite" | "dusk";
export type AccentColor = "cyan" | "blue" | "green" | "orange" | "purple";
export type RightClickAction = "paste" | "menu";
export type TerminalShortcutMode = "platform-safe" | "remote-first";

export interface AppPreferences {
  theme: AppTheme;
  accent: AccentColor;
  uiFontFamily: string;
  uiFontSize: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalScrollbackLines: number;
  useSessionTerminalFont: boolean;
  useSessionTerminalScrollback: boolean;
  rightClickAction: RightClickAction;
  copyOnSelect: boolean;
  confirmMultiLinePaste: boolean;
  terminalShortcutMode: TerminalShortcutMode;
}

const STORAGE_KEY = "xsh.preferences.v1";
const UI_FONT_BASELINE = 14;
const UI_FONT_MIN = 12;
const UI_FONT_MAX = 16;
const TERMINAL_FONT_MIN = 12;
const TERMINAL_FONT_MAX = 22;

export const defaultPreferences: AppPreferences = {
  theme: "midnight",
  accent: "cyan",
  uiFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  uiFontSize: 14,
  terminalFontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
  terminalFontSize: 14,
  terminalLineHeight: 1.22,
  terminalScrollbackLines: 10_000,
  useSessionTerminalFont: false,
  useSessionTerminalScrollback: false,
  rightClickAction: "paste",
  copyOnSelect: false,
  confirmMultiLinePaste: false,
  terminalShortcutMode: "platform-safe",
};

export function loadPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultPreferences;
    const parsed = JSON.parse(stored) as Partial<AppPreferences>;
    return normalizePreferences({ ...defaultPreferences, ...parsed });
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: AppPreferences) {
  const normalized = normalizePreferences(preferences);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  applyPreferences(normalized);
}

export function applyPreferences(preferences: AppPreferences) {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.accent = preferences.accent;
  root.style.setProperty("--ui-font-family", preferences.uiFontFamily);
  root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
  root.style.setProperty("--ui-font-adjust", `${preferences.uiFontSize - UI_FONT_BASELINE}px`);
}

function normalizePreferences(preferences: AppPreferences): AppPreferences {
  return {
    ...preferences,
    uiFontSize: clamp(Number(preferences.uiFontSize), UI_FONT_MIN, UI_FONT_MAX, defaultPreferences.uiFontSize),
    terminalFontSize: clamp(Number(preferences.terminalFontSize), TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, defaultPreferences.terminalFontSize),
    terminalLineHeight: clamp(Number(preferences.terminalLineHeight), 1, 1.6, defaultPreferences.terminalLineHeight),
    terminalScrollbackLines: clamp(Math.round(Number(preferences.terminalScrollbackLines)), 100, 1_000_000, defaultPreferences.terminalScrollbackLines),
    uiFontFamily: preferences.uiFontFamily?.trim() || defaultPreferences.uiFontFamily,
    terminalFontFamily: preferences.terminalFontFamily?.trim() || defaultPreferences.terminalFontFamily,
    useSessionTerminalFont: preferences.useSessionTerminalFont === true,
    useSessionTerminalScrollback: preferences.useSessionTerminalScrollback === true,
    rightClickAction: preferences.rightClickAction === "menu" ? "menu" : "paste",
    copyOnSelect: preferences.copyOnSelect === true,
    confirmMultiLinePaste: preferences.confirmMultiLinePaste === true,
    terminalShortcutMode: preferences.terminalShortcutMode === "remote-first" ? "remote-first" : "platform-safe",
  };
}

function clamp(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
