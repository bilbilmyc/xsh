import type { SftpTransferPolicy } from "./types";
import { getTheme, getThemeTokens, isAppTheme, type AppTheme } from "./themes.ts";

export type { AppTheme } from "./themes.ts";
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
  globalSftpTransferConcurrency: number;
  perHostSftpTransferConcurrency: number;
  sftpUploadBandwidthLimitBps: number;
  sftpDownloadBandwidthLimitBps: number;
}

const STORAGE_KEY = "xsh.preferences.v1";
const UI_FONT_BASELINE = 15;
const UI_FONT_MIN = 12;
const UI_FONT_MAX = 18;
const TERMINAL_FONT_MIN = 12;
const TERMINAL_FONT_MAX = 22;
const SFTP_MAX_CONCURRENCY = 32;
const SFTP_MIN_LIMIT_BYTES_PER_SECOND = 1024;
const SFTP_MAX_LIMIT_BYTES_PER_SECOND = 1024 * 1024 * 1024;
const LEGACY_DEFAULT_TERMINAL_FONT_FAMILY = '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace';
const LEGACY_MONACO_DEFAULT_TERMINAL_FONT_FAMILY = '"Monaco", "SFMono-Regular", Menlo, Consolas, monospace';
const LEGACY_DEFAULT_TERMINAL_LINE_HEIGHT = 1.22;
const LEGACY_DEFAULT_TERMINAL_FONT_SIZE = 14;
// v1.17 shipped a 15px UI baseline and 700-weight terminal bold; the defaults
// were slimmed to 14px / 400 in v1.18.
const LEGACY_DEFAULT_UI_FONT_SIZE = 15;
const LEGACY_DEFAULT_UI_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const LEGACY_DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 700;

export const defaultPreferences: AppPreferences = {
  theme: "midnight",
  accent: "cyan",
  uiFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  uiFontSize: 14,
  terminalFontFamily: '"Cascadia Mono", "Cascadia Code", "SFMono-Regular", "SF Mono", Menlo, Consolas, "Courier New", monospace',
  terminalFontSize: 15,
  terminalLineHeight: 1.22,
  terminalFontWeight: 400,
  terminalFontWeightBold: 400,
  terminalScrollbackLines: 10_000,
  useSessionTerminalFont: false,
  useSessionTerminalScrollback: false,
  rightClickAction: "paste",
  copyOnSelect: true,
  confirmMultiLinePaste: false,
  terminalShortcutMode: "platform-safe",
  globalSftpTransferConcurrency: 4,
  perHostSftpTransferConcurrency: 2,
  sftpUploadBandwidthLimitBps: 0,
  sftpDownloadBandwidthLimitBps: 0,
};

export function loadPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultPreferences;
    const parsed = JSON.parse(stored) as Partial<AppPreferences>;
    const merged = { ...defaultPreferences, ...parsed };
    if (parsed.uiFontFamily === LEGACY_DEFAULT_UI_FONT_FAMILY) {
      merged.uiFontFamily = defaultPreferences.uiFontFamily;
    }
    const hasFontWeightPreferences =
      parsed.terminalFontWeight !== undefined || parsed.terminalFontWeightBold !== undefined;
    const hasLegacyTerminalDefaults =
      parsed.terminalFontFamily === LEGACY_DEFAULT_TERMINAL_FONT_FAMILY
      || parsed.terminalLineHeight === LEGACY_DEFAULT_TERMINAL_LINE_HEIGHT;
    const hasDenseReadabilityDefaults =
      parsed.terminalFontFamily === defaultPreferences.terminalFontFamily
      && parsed.terminalFontSize === LEGACY_DEFAULT_TERMINAL_FONT_SIZE
      && parsed.terminalLineHeight === 1
      && (parsed.terminalFontWeight === undefined || parsed.terminalFontWeight === defaultPreferences.terminalFontWeight)
      && (parsed.terminalFontWeightBold === undefined || parsed.terminalFontWeightBold === defaultPreferences.terminalFontWeightBold);
    if (parsed.terminalFontFamily === LEGACY_DEFAULT_TERMINAL_FONT_FAMILY
      || parsed.terminalFontFamily === LEGACY_MONACO_DEFAULT_TERMINAL_FONT_FAMILY) {
      merged.terminalFontFamily = defaultPreferences.terminalFontFamily;
    }
    if (parsed.terminalLineHeight === LEGACY_DEFAULT_TERMINAL_LINE_HEIGHT) {
      merged.terminalLineHeight = defaultPreferences.terminalLineHeight;
    }
    // v1 shipped a dense 14px/1.22 terminal before the readability defaults
    // were introduced. Migrate only that untouched legacy combination; a user
    // who has already edited terminal typography keeps their explicit choice.
    if ((!hasFontWeightPreferences && hasLegacyTerminalDefaults
      && parsed.terminalFontSize === LEGACY_DEFAULT_TERMINAL_FONT_SIZE)
      || hasDenseReadabilityDefaults) {
      merged.terminalFontSize = defaultPreferences.terminalFontSize;
      merged.terminalLineHeight = defaultPreferences.terminalLineHeight;
    }
    // Same policy for the slimmer UI defaults: only migrate stored values that
    // still equal the old defaults, so explicit choices survive upgrades.
    if (parsed.uiFontSize === LEGACY_DEFAULT_UI_FONT_SIZE) {
      merged.uiFontSize = defaultPreferences.uiFontSize;
    }
    if (parsed.terminalFontWeightBold === LEGACY_DEFAULT_TERMINAL_FONT_WEIGHT_BOLD
      && (parsed.terminalFontWeight === undefined
        || parsed.terminalFontWeight === defaultPreferences.terminalFontWeight)) {
      merged.terminalFontWeightBold = defaultPreferences.terminalFontWeightBold;
    }
    return normalizePreferences(merged);
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(preferences: AppPreferences): AppPreferences {
  const normalized = normalizePreferences(preferences);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  applyPreferences(normalized);
  return normalized;
}

export function applyPreferences(preferences: AppPreferences) {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.accent = preferences.accent;
  const theme = getTheme(preferences.theme);
  root.dataset.palette = theme.extended ? "extended" : "classic";
  root.dataset.scheme = theme.scheme;
  for (const [property, value] of Object.entries(getThemeTokens(preferences.theme, preferences.accent))) {
    root.style.setProperty(property, theme.extended ? value : "");
  }
  root.style.setProperty("--ui-font-family", preferences.uiFontFamily);
  root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
  root.style.setProperty("--ui-font-adjust", `${preferences.uiFontSize - UI_FONT_BASELINE}px`);
}

export function normalizePreferences(preferences: AppPreferences): AppPreferences {
  const globalConcurrency = clampInteger(
    Number(preferences.globalSftpTransferConcurrency),
    1,
    SFTP_MAX_CONCURRENCY,
    defaultPreferences.globalSftpTransferConcurrency,
  );
  const perHostConcurrency = clampInteger(
    Number(preferences.perHostSftpTransferConcurrency),
    1,
    globalConcurrency,
    Math.min(defaultPreferences.perHostSftpTransferConcurrency, globalConcurrency),
  );
  return {
    ...preferences,
    theme: isAppTheme(preferences.theme) ? preferences.theme : defaultPreferences.theme,
    accent: ["cyan", "blue", "green", "orange", "purple"].includes(preferences.accent) ? preferences.accent : defaultPreferences.accent,
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
    globalSftpTransferConcurrency: globalConcurrency,
    perHostSftpTransferConcurrency: perHostConcurrency,
    sftpUploadBandwidthLimitBps: normalizeBandwidthLimit(preferences.sftpUploadBandwidthLimitBps),
    sftpDownloadBandwidthLimitBps: normalizeBandwidthLimit(preferences.sftpDownloadBandwidthLimitBps),
  };
}

export function toSftpTransferPolicy(preferences: AppPreferences): SftpTransferPolicy {
  const normalized = normalizePreferences(preferences);
  return {
    globalConcurrency: normalized.globalSftpTransferConcurrency,
    perHostConcurrency: normalized.perHostSftpTransferConcurrency,
    uploadLimitBytesPerSecond: normalized.sftpUploadBandwidthLimitBps,
    downloadLimitBytesPerSecond: normalized.sftpDownloadBandwidthLimitBps,
  };
}

function normalizeBandwidthLimit(value: number): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded) || rounded <= 0) return 0;
  return Math.min(
    SFTP_MAX_LIMIT_BYTES_PER_SECOND,
    Math.max(SFTP_MIN_LIMIT_BYTES_PER_SECOND, rounded),
  );
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clamp(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
