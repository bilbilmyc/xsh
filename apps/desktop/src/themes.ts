export const THEME_IDS = ["light", "midnight", "graphite", "dusk", "nord", "forest", "sand", "ivory"] as const;
export type AppTheme = typeof THEME_IDS[number];
export type ThemeAccent = "cyan" | "blue" | "green" | "orange" | "purple";

interface ThemeColors {
  deep: string;
  background: string;
  panel: string;
  raised: string;
  hover: string;
  active: string;
  line: string;
  lineSoft: string;
  text: string;
  strong: string;
  muted: string;
  faint: string;
  chrome: string;
  chromeRaised: string;
}

type AnsiColors = readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];

function terminalPalette(background: string, foreground: string, cursor: string, selectionBackground: string, colors: AnsiColors) {
  return {
    background, foreground, cursor, cursorAccent: background, selectionBackground,
    black: colors[0], red: colors[1], green: colors[2], yellow: colors[3],
    blue: colors[4], magenta: colors[5], cyan: colors[6], white: colors[7],
    brightBlack: colors[8], brightRed: colors[9], brightGreen: colors[10], brightYellow: colors[11],
    brightBlue: colors[12], brightMagenta: colors[13], brightCyan: colors[14], brightWhite: colors[15],
  };
}

const LEGACY_DARK_ANSI: AnsiColors = ["#171d24", "#ff5f56", "#39d353", "#f2c94c", "#3d9bff", "#c678dd", "#22c7d6", "#e6edf3", "#8b949e", "#ff7b72", "#56d364", "#f0d264", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"];
const LIGHT_ANSI: AnsiColors = ["#263746", "#c43d3d", "#167a55", "#946600", "#1769aa", "#7b3fb2", "#087ea4", "#edf2f5", "#71808b", "#a92f36", "#0f6848", "#7d5400", "#125a91", "#642f92", "#05657f", "#15232e"];

export interface ThemeDefinition {
  value: AppTheme;
  label: string;
  description: string;
  scheme: "light" | "dark";
  extended: boolean;
  colors: ThemeColors;
  terminal: ReturnType<typeof terminalPalette>;
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    value: "light", label: "浅色", description: "浅色 · 经典白底与中性灰边栏", scheme: "light", extended: false,
    colors: { deep: "#eef2f5", background: "#ffffff", panel: "#f7f9fb", raised: "#ffffff", hover: "#edf4f7", active: "#dff1f6", line: "#d5dee5", lineSoft: "#e8eef2", text: "#273746", strong: "#15232e", muted: "#667786", faint: "#84929d", chrome: "#f0f0f0", chromeRaised: "#ececec" },
    terminal: terminalPalette("#fbfcfe", "#263746", "#087ea4", "#b8e1ee", LIGHT_ANSI),
  },
  {
    value: "midnight", label: "深海", description: "深色 · 原有蓝黑高对比工作区", scheme: "dark", extended: false,
    colors: { deep: "#080b10", background: "#0c1118", panel: "#101720", raised: "#151e29", hover: "#192431", active: "#1b2c3d", line: "#22303e", lineSoft: "#192430", text: "#dbe4ed", strong: "#f4f7fa", muted: "#8090a2", faint: "#59697a", chrome: "#121a24", chromeRaised: "#16202c" },
    terminal: terminalPalette("#0b0f14", "#f0f4f8", "#7dd3fc", "#2f6685", LEGACY_DARK_ANSI),
  },
  {
    value: "graphite", label: "石墨", description: "深色 · 中性灰黑，减少色彩干扰", scheme: "dark", extended: false,
    colors: { deep: "#0d0f11", background: "#111315", panel: "#16191c", raised: "#1c2024", hover: "#23282d", active: "#293139", line: "#30363c", lineSoft: "#24292e", text: "#e2e5e8", strong: "#ffffff", muted: "#9aa3ab", faint: "#707981", chrome: "#16191c", chromeRaised: "#1b1f23" },
    terminal: terminalPalette("#111315", "#f0f4f8", "#7dd3fc", "#2f6685", LEGACY_DARK_ANSI),
  },
  {
    value: "dusk", label: "暮色", description: "深色 · 原有暗紫背景与柔和层次", scheme: "dark", extended: false,
    colors: { deep: "#0c0b12", background: "#100f18", panel: "#161522", raised: "#1d1b2a", hover: "#262337", active: "#302b47", line: "#373249", lineSoft: "#282438", text: "#e6e1f0", strong: "#fffaff", muted: "#a39ab5", faint: "#746d85", chrome: "#161522", chromeRaised: "#1b1928" },
    terminal: terminalPalette("#100f18", "#f0f4f8", "#7dd3fc", "#2f6685", LEGACY_DARK_ANSI),
  },
  {
    value: "nord", label: "北境", description: "深色 · 冷灰蓝底，冰川色终端输出", scheme: "dark", extended: true,
    colors: { deep: "#202630", background: "#242c38", panel: "#2b3442", raised: "#333e4e", hover: "#3a4758", active: "#3f5266", line: "#536174", lineSoft: "#3e4b5d", text: "#e5eaf1", strong: "#f4f7fb", muted: "#bac6d5", faint: "#aab9cb", chrome: "#2b3442", chromeRaised: "#303b4b" },
    terminal: terminalPalette("#242c38", "#e5eaf1", "#88c0d0", "#41566f", ["#303b4b", "#ed9da8", "#b4d59b", "#ebcf9a", "#9ab7df", "#c5a3ce", "#8fced7", "#e5e9f0", "#9aa9bd", "#f5b2bb", "#c6e4ae", "#f4dcaf", "#b4cdf0", "#d9b9e2", "#b0e4e9", "#ffffff"]),
  },
  {
    value: "forest", label: "松林", description: "深色 · 苔绿灰底，柔和草木色输出", scheme: "dark", extended: true,
    colors: { deep: "#18231e", background: "#1d2a23", panel: "#24332b", raised: "#2c3d33", hover: "#35483c", active: "#3c5544", line: "#566e5d", lineSoft: "#3b5142", text: "#e1eadd", strong: "#f4f8ee", muted: "#b6c8b1", faint: "#a6bea1", chrome: "#24332b", chromeRaised: "#293a30" },
    terminal: terminalPalette("#1d2a23", "#e1eadd", "#a8ce9c", "#425d43", ["#2c3d33", "#e8a297", "#a8ce9c", "#e6cd91", "#9dbed5", "#cbb1cf", "#96cec2", "#dfe8d7", "#9db59b", "#f3b9ac", "#c1e2b3", "#f1ddac", "#bad5e6", "#dfc5e1", "#b3e1d4", "#f6faef"]),
  },
  {
    value: "sand", label: "暖砂", description: "浅色 · 暖纸底与棕墨字，适合明亮环境", scheme: "light", extended: true,
    colors: { deep: "#e8e0d2", background: "#fbf6eb", panel: "#f3ecdf", raised: "#fffbf3", hover: "#e9dfcc", active: "#e4d8be", line: "#a89a82", lineSoft: "#d6cab6", text: "#493e2f", strong: "#2f291f", muted: "#6a5d49", faint: "#6f5e4b", chrome: "#eee5d5", chromeRaised: "#e9dfce" },
    terminal: terminalPalette("#fbf6eb", "#493e2f", "#8a4b19", "#dfcdab", ["#493e2f", "#aa3b34", "#376336", "#805b16", "#315f8c", "#835081", "#28646a", "#e8deca", "#77664d", "#91332d", "#2d552c", "#714e11", "#285079", "#70406e", "#20585e", "#2f291f"]),
  },
  {
    value: "ivory", label: "清瓷", description: "浅色 · 冷白蓝灰，清晰区分工具与终端", scheme: "light", extended: true,
    colors: { deep: "#e1e9ef", background: "#f7fbfe", panel: "#eaf2f7", raised: "#ffffff", hover: "#dce9f2", active: "#ccdfed", line: "#98adbd", lineSoft: "#c7d7e3", text: "#2e4559", strong: "#193044", muted: "#4d6579", faint: "#536b7d", chrome: "#e5eef5", chromeRaised: "#dfeaf2" },
    terminal: terminalPalette("#f7fbfe", "#2e4559", "#285daa", "#ccdfed", ["#2e4559", "#b13d46", "#286346", "#815c11", "#285daa", "#744596", "#176477", "#dfebf3", "#60788b", "#97313b", "#205637", "#704e0b", "#204c90", "#623781", "#115365", "#193044"]),
  },
];

const DARK_ACCENTS: Record<ThemeAccent, string> = { cyan: "#8fced7", blue: "#a9c9ef", green: "#b4d59b", orange: "#edbb8e", purple: "#d2b5df" };
const LIGHT_ACCENTS: Record<ThemeAccent, string> = { cyan: "#176477", blue: "#285daa", green: "#286346", orange: "#8a4b19", purple: "#744596" };

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === "string" && THEME_IDS.includes(value as AppTheme);
}

export function getTheme(theme: AppTheme): ThemeDefinition {
  return THEMES.find((entry) => entry.value === theme) ?? THEMES[1];
}

export function getThemeTokens(theme: AppTheme, accent: ThemeAccent = "cyan"): Record<string, string> {
  const definition = getTheme(theme);
  const colors = definition.colors;
  const dark = definition.scheme === "dark";
  const accentColor = (dark ? DARK_ACCENTS : LIGHT_ACCENTS)[accent];
  return {
    "--bg-deep": colors.deep, "--bg": colors.background, "--panel": colors.panel, "--panel-raised": colors.raised,
    "--panel-hover": colors.hover, "--panel-active": colors.active, "--line": colors.line, "--line-soft": colors.lineSoft,
    "--text": colors.text, "--text-strong": colors.strong, "--muted": colors.muted, "--faint": colors.faint,
    "--chrome": colors.chrome, "--chrome-raised": colors.chromeRaised, "--tab-active-bg": definition.terminal.background,
    "--accent": accentColor, "--accent-strong": accentColor, "--accent-bg": `${accentColor}20`, "--accent-contrast": dark ? "#14212a" : "#ffffff",
    "--green": definition.terminal.green, "--yellow": definition.terminal.yellow, "--red": definition.terminal.red, "--purple": definition.terminal.magenta,
    "--control-bg": colors.raised, "--control-bg-soft": colors.panel, "--control-bg-hover": colors.hover,
    "--control-border": colors.line, "--control-border-hover": accentColor, "--control-text": colors.text, "--control-text-strong": colors.strong,
    "--danger-bg": `${definition.terminal.red}14`, "--danger-bg-hover": `${definition.terminal.red}24`, "--danger-border": definition.terminal.red, "--danger-text": definition.terminal.red,
    "--theme-terminal-background": definition.terminal.background, "--theme-terminal-foreground": definition.terminal.foreground,
    "--theme-terminal-green": definition.terminal.green, "--theme-terminal-blue": definition.terminal.blue,
  };
}

export const TERMINAL_THEMES = [
  { value: "xsh-black", label: "经典黑", palette: terminalPalette("#000000", "#e6edf3", "#e6edf3", "#264f78", LEGACY_DARK_ANSI) },
  { value: "xsh-midnight", label: "午夜", palette: getTheme("midnight").terminal },
  { value: "xsh-graphite", label: "石墨", palette: getTheme("graphite").terminal },
  { value: "xsh-blue", label: "深蓝", palette: terminalPalette("#07111f", "#dbeafe", "#7dd3fc", "#1d4e73", ["#07111f", "#ff8b80", "#8be9a3", "#f0d58a", "#7db7ff", "#d0b2ff", "#70e0ee", "#e2efff", "#62758e", "#ffb0a8", "#b6f5c3", "#ffe3a3", "#b0d4ff", "#e4d2ff", "#b4f4ff", "#ffffff"]) },
  { value: "xsh-green", label: "绿幕", palette: terminalPalette("#07130b", "#b7f3c5", "#7ee787", "#1f5d35", ["#07130b", "#ff8278", "#7ee787", "#d7e88b", "#83b8ff", "#d2a8ff", "#72e0c3", "#d9f7df", "#52735b", "#ffa198", "#aff5b4", "#f2cc60", "#a5c8ff", "#e2c5ff", "#a5f3d5", "#ffffff"]) },
  { value: "xsh-amber", label: "琥珀", palette: terminalPalette("#191207", "#f4dfb5", "#ffd580", "#634a24", ["#191207", "#f28b82", "#b4d58b", "#f0c674", "#94bde5", "#d2a8d9", "#8fd2c3", "#e8d8b8", "#9f8b6d", "#ffaaa2", "#cceba3", "#ffdf9b", "#b5d6f5", "#e9c5f0", "#b4e8dc", "#fff4df"]) },
  { value: "xsh-purple", label: "紫夜", palette: terminalPalette("#171021", "#e8dff5", "#c9a7f5", "#50376e", ["#171021", "#f28b9c", "#a4d69a", "#e9d38c", "#9dbcf5", "#d0a0ed", "#90d9db", "#e8dff5", "#9885ac", "#ffadba", "#c0edb5", "#f6e4a6", "#bfd4ff", "#e5c0ff", "#b4eff0", "#fbf5ff"]) },
  { value: "xsh-dusk", label: "暮紫", palette: getTheme("dusk").terminal },
  { value: "xsh-nord", label: "北境", palette: getTheme("nord").terminal },
  { value: "xsh-forest", label: "松林", palette: getTheme("forest").terminal },
  { value: "xsh-sand", label: "暖砂", palette: getTheme("sand").terminal },
  { value: "xsh-ivory", label: "清瓷", palette: getTheme("ivory").terminal },
] as const;

export type TerminalTheme = "xsh-dark" | typeof TERMINAL_THEMES[number]["value"];

export function isTerminalTheme(value: unknown): value is TerminalTheme {
  return value === "xsh-dark" || TERMINAL_THEMES.some((theme) => theme.value === value);
}

export function resolveTerminalTheme(profileTheme: string, appTheme: AppTheme, globalTheme: TerminalTheme = "xsh-dark") {
  const profile = TERMINAL_THEMES.find((theme) => theme.value === profileTheme);
  const global = TERMINAL_THEMES.find((theme) => theme.value === globalTheme);
  // xterm keeps its standard 6×6×6 color cube and grayscale (indices 16–255).
  // Only the default colors and the first 16 ANSI colors vary with the theme.
  return { ...(profile?.palette ?? global?.palette ?? getTheme(appTheme).terminal) };
}

const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const XTERM_EXTENDED_COLORS = Array.from({ length: 240 }, (_, offset) => {
  const channels = offset < 216
    ? [Math.floor(offset / 36), Math.floor(offset / 6) % 6, offset % 6].map((index) => XTERM_CUBE_LEVELS[index])
    : Array<number>(3).fill(8 + (offset - 216) * 10);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
});

export function terminal256ColorPalette(theme: ReturnType<typeof terminalPalette>): string[] {
  return [
    theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
    ...XTERM_EXTENDED_COLORS,
  ];
}
