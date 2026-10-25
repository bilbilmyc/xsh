export const DEFAULT_TERMINAL_FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", "SFMono-Regular", "SF Mono", Menlo, Consolas, "Courier New", monospace';

export const TERMINAL_FONTS = [
  { label: "系统等宽字体（推荐）", value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: "Cascadia Mono", value: '"Cascadia Mono", Consolas, monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", Consolas, monospace' },
  { label: "Consolas", value: 'Consolas, "Courier New", monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Menlo, monospace' },
  { label: "Fira Code", value: '"Fira Code", Consolas, monospace' },
  { label: "Source Code Pro", value: '"Source Code Pro", Consolas, monospace' },
  { label: "IBM Plex Mono", value: '"IBM Plex Mono", Consolas, monospace' },
  { label: "Hack", value: 'Hack, Menlo, Consolas, monospace' },
  { label: "Inconsolata", value: 'Inconsolata, Consolas, monospace' },
  { label: "Ubuntu Mono", value: '"Ubuntu Mono", Consolas, monospace' },
  { label: "DejaVu Sans Mono", value: '"DejaVu Sans Mono", Consolas, monospace' },
  { label: "SF Mono", value: '"SFMono-Regular", Menlo, monospace' },
  { label: "Menlo", value: 'Menlo, Monaco, monospace' },
  { label: "Monaco", value: '"Monaco", "SFMono-Regular", Menlo, Consolas, monospace' },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
] as const;

export const TERMINAL_FONT_WEIGHTS = [
  { value: 100, label: "极细 · Thin" },
  { value: 200, label: "纤细 · Extra Light" },
  { value: 300, label: "偏细 · Light" },
  { value: 400, label: "正常 · Regular" },
  { value: 500, label: "适中 · Medium" },
  { value: 600, label: "半粗 · Semi Bold" },
  { value: 700, label: "加粗 · Bold" },
  { value: 800, label: "特粗 · Extra Bold" },
  { value: 900, label: "极粗 · Black" },
] as const;
