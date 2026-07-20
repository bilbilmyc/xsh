export type AppTheme = "light" | "midnight" | "graphite" | "dusk";
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
  terminalFontWeight: number;
  terminalFontWeightBold: number;
  terminalScrollbackLines: number;
  useSessionTerminalFont: boolean;
  useSessionTerminalScrollback: boolean;
  rightClickAction: RightClickAction;
  copyOnSelect: boolean;
  confirmMultiLinePaste: boolean;
  terminalShortcutMode: TerminalShortcutMode;
}

const STORAGE_KEY = "xsh.preferences.v1";
const UI_FONT_BASELINE = 15;
const UI_FONT_MIN = 12;
const UI_FONT_MAX = 16;
const TERMINAL_FONT_MIN = 12;
const TERMINAL_FONT_MAX = 22;
const LEGACY_DEFAULT_TERMINAL_FONT_FAMILY = '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace';
const LEGACY_DEFAULT_TERMINAL_LINE_HEIGHT = 1.22;

export const defaultPreferences: AppPreferences = {
  theme: "midnight",
  accent: "cyan",
  uiFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  uiFontSize: 15,
  terminalFontFamily: '"Monaco", "SFMono-Regular", Menlo, Consolas, monospace',
  terminalFontSize: 14,
  terminalLineHeight: 1,
  terminalFontWeight: 400,
  terminalFontWeightBold: 700,
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
    const merged = { ...defaultPreferences, ...parsed };
    if (parsed.terminalFontFamily === LEGACY_DEFAULT_TERMINAL_FONT_FAMILY) {
      merged.terminalFontFamily = defaultPreferences.terminalFontFamily;
    }
    if (parsed.terminalLineHeight === LEGACY_DEFAULT_TERMINAL_LINE_HEIGHT) {
      merged.terminalLineHeight = defaultPreferences.terminalLineHeight;
    }
    return normalizePreferences(merged);
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
    terminalFontWeight: clamp(Number(preferences.terminalFontWeight), 100, 900, defaultPreferences.terminalFontWeight),
    terminalFontWeightBold: clamp(Number(preferences.terminalFontWeightBold), 100, 900, defaultPreferences.terminalFontWeightBold),
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
