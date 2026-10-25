import { useState } from "react";
import { TERMINAL_FONTS } from "../terminal-fonts";

interface TerminalFontPickerProps {
  value: string;
  onChange: (value: string) => void;
  allowInherit?: boolean;
  className?: string;
}

export function TerminalFontPicker({ value, onChange, allowInherit = false, className = "" }: TerminalFontPickerProps) {
  const [customValue, setCustomValue] = useState<string | null>(null);
  const isPreset = TERMINAL_FONTS.some((font) => font.value === value) || (allowInherit && value === "");
  const selection = customValue === value || !isPreset ? "custom" : value;

  return (
    <div className={`field ${className}`}>
      <label className="field">
        <span>等宽字体</span>
        <select value={selection} onChange={(event) => {
          const next = event.target.value;
          setCustomValue(next === "custom" ? value : null);
          if (next !== "custom") onChange(next);
        }}>
          {allowInherit && <option value="">跟随全局字体</option>}
          {TERMINAL_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
          <option value="custom">自定义字体…</option>
        </select>
      </label>
      {selection === "custom" && (
        <label className="field">
          <span>自定义字体名称</span>
          <input value={value} onChange={(event) => { setCustomValue(event.target.value); onChange(event.target.value); }} placeholder={'例如 "Maple Mono", Consolas, monospace'} spellCheck={false} />
        </label>
      )}
      <small className="field-help">使用本机已安装的字体；未安装时自动回退到系统等宽字体。</small>
    </div>
  );
}
