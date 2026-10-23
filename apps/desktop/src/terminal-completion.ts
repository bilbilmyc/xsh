import { byteLength } from "./ai-context.ts";
import type { CommandHistoryEntry } from "./command-history.ts";
import { containsSensitiveCommand } from "./sensitive-command.ts";

export const TERMINAL_COMPLETION_BYTES = 4096;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const KNOWN_CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/;

export interface TerminalSuggestion {
  command: string;
  description: string;
  source: "history" | "ai";
}

export interface TerminalPromptSnapshot {
  connectionId: string | null;
  promptId: number;
  revision: number;
  integrated: boolean;
  phase: "unknown" | "prompt" | "running";
  command: string | null;
  ready: boolean;
}

interface PromptMarker {
  line: number;
  isDisposed: boolean;
  dispose(): void;
}

interface PromptBuffer {
  type: "normal" | "alternate";
  baseY: number;
  cursorY: number;
  cursorX: number;
  getLine(index: number): {
    isWrapped: boolean;
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  } | undefined;
}

/**
 * Trust an editable line only after a shell's OSC 133 prompt-end marker, and
 * after its visible echo agrees with the input we sent. Unknown readline
 * operations deliberately suspend suggestions until a new prompt or Ctrl+U.
 * No prompt guessing, terminal rewrites, or interception of native Tab.
 */
export class TerminalPromptTracker {
  private marker: PromptMarker | undefined;
  private column = 0;
  private integrated = false;
  private phase: TerminalPromptSnapshot["phase"] = "unknown";
  private command: string | null = null;
  private promptId = 0;
  private revision = 0;

  reset() {
    this.marker?.dispose();
    this.marker = undefined;
    this.integrated = false;
    this.phase = "unknown";
    this.command = null;
    this.promptId += 1;
    this.revision += 1;
  }

  osc(data: string, column: number, makeMarker: () => PromptMarker | undefined) {
    const kind = data.split(";", 1)[0];
    if (!["A", "B", "C", "D"].includes(kind)) return;
    this.revision += 1;
    if (kind === "B") {
      this.integrated = true;
      this.marker?.dispose();
      this.marker = makeMarker();
      this.column = column;
      this.phase = "prompt";
      this.command = "";
      this.promptId += 1;
    } else {
      this.phase = kind === "A" ? "unknown" : "running";
      this.command = null;
    }
  }

  input(data: string): string | null {
    this.revision += 1;
    if (this.phase !== "prompt") return null;
    // xterm wraps paste when the remote shell enables bracketed-paste mode.
    const text = data.replace(/^\x1b\[200~([\s\S]*)\x1b\[201~$/, "$1");
    if (/[\r\n]/.test(text)) {
      const submitted = text === "\r" || text === "\n" ? this.command : null;
      this.phase = "running";
      this.command = null;
      return submitted;
    }
    if (text === "\x03" || text === "\x04") {
      this.phase = "running";
      this.command = null;
    } else if (text === "\x15") {
      this.command = "";
    } else if (this.command !== null && (text === "\x7f" || text === "\b")) {
      this.command = Array.from(this.command).slice(0, -1).join("");
    } else if (!CONTROL_CHARACTERS.test(text) && this.command !== null) {
      this.command += text;
      if (byteLength(this.command) > TERMINAL_COMPLETION_BYTES) this.command = null;
    } else {
      this.command = null;
    }
    return null;
  }

  snapshot(connectionId: string | null, buffer: PromptBuffer): TerminalPromptSnapshot {
    return {
      connectionId,
      promptId: this.promptId,
      revision: this.revision,
      integrated: this.integrated,
      phase: this.phase,
      command: this.command,
      ready: !!connectionId && this.matchesEcho(buffer),
    };
  }

  private matchesEcho(buffer: PromptBuffer): boolean {
    if (buffer.type !== "normal" || this.phase !== "prompt" || this.command === null || !this.marker || this.marker.isDisposed) return false;
    const row = buffer.baseY + buffer.cursorY;
    const start = this.marker.line;
    if (row < start || row - start > 16 || (row === start && buffer.cursorX < this.column)) return false;
    let echo = "";
    for (let index = start; index <= row; index += 1) {
      const line = buffer.getLine(index);
      if (!line || (index > start && !line.isWrapped)) return false;
      echo += line.translateToString(index !== row, index === start ? this.column : 0, index === row ? buffer.cursorX : undefined);
    }
    if (echo !== this.command) return false;
    // Never append while a cursor is in the middle of an existing command.
    if (buffer.getLine(row)?.translateToString(true, buffer.cursorX).trim()) return false;
    for (let index = row + 1; index <= start + 16; index += 1) {
      const line = buffer.getLine(index);
      if (!line?.isWrapped) break;
      if (line.translateToString(true).trim()) return false;
    }
    return true;
  }
}

export function sameTerminalPrompt(left: TerminalPromptSnapshot, right: TerminalPromptSnapshot): boolean {
  return left.connectionId !== null
    && left.connectionId === right.connectionId
    && left.promptId === right.promptId
    && left.revision === right.revision
    && left.command === right.command;
}

/** Only the first blank prompt on the original connection can finish setup. */
export function shellSetupPromptState(
  original: TerminalPromptSnapshot,
  current: TerminalPromptSnapshot,
): "waiting" | "ready" | "changed" {
  if (!original.connectionId || original.connectionId !== current.connectionId
    || current.promptId < original.promptId || current.promptId > original.promptId + 1) return "changed";
  if (current.promptId === original.promptId + 1) {
    if (current.phase === "running" || current.command !== "") return "changed";
    if (current.integrated && current.phase === "prompt" && current.ready) return "ready";
  }
  return "waiting";
}

export function safeCompletionCommand(command: string): boolean {
  return !!command.trim()
    && byteLength(command) <= TERMINAL_COMPLETION_BYTES
    && !CONTROL_CHARACTERS.test(command)
    && !containsSensitiveCommand(command)
    && !KNOWN_CREDENTIAL.test(command);
}

export function completionSuffix(suggestion: string, expected: TerminalPromptSnapshot, current: TerminalPromptSnapshot): string | null {
  if (!current.ready || !sameTerminalPrompt(expected, current) || current.command === null || !safeCompletionCommand(suggestion)) return null;
  if (!suggestion.startsWith(current.command) || suggestion.length <= current.command.length) return null;
  return suggestion.slice(current.command.length);
}

export function historySuggestions(entries: CommandHistoryEntry[], sessionId: string, prefix: string): TerminalSuggestion[] {
  if (prefix.trim().length < 2 || containsSensitiveCommand(prefix)) return [];
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.sessionId !== sessionId || !entry.command.startsWith(prefix) || entry.command === prefix || seen.has(entry.command) || !safeCompletionCommand(entry.command)) return false;
    seen.add(entry.command);
    return true;
  }).slice(0, 4).map((entry) => ({ command: entry.command, description: "此主机的命令历史", source: "history" }));
}

export function parseAiSuggestions(response: string, prefix: string): TerminalSuggestion[] {
  const text = response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI 没有返回有效的命令建议，请重试或换一种描述。");
  }
  if (!Array.isArray(parsed)) throw new Error("AI 返回的命令建议格式不正确，请重试。");
  const seen = new Set<string>();
  const suggestions: TerminalSuggestion[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const { command, description } = candidate as Record<string, unknown>;
    if (typeof command !== "string" || !safeCompletionCommand(command) || !command.startsWith(prefix) || command === prefix || seen.has(command)) continue;
    seen.add(command);
    suggestions.push({
      command,
      description: typeof description === "string" ? description.replace(CONTROL_CHARACTERS, "").slice(0, 180) : "",
      source: "ai",
    });
    if (suggestions.length === 3) break;
  }
  if (!suggestions.length) throw new Error("没有可填入的命令建议。可尝试补充目标，或清空当前命令后重新描述。");
  return suggestions;
}

// Session-local prompt hooks. Preserve existing prompt hooks and PS0/PS1,
// never replace DEBUG traps or write startup files. Bash <4.4 has no PS0 and
// therefore falls back to verified echo bounds instead of inventing C.
export const SHELL_INTEGRATION_COMMAND = [
  String.raw`__xsh_report_cwd_v1() { local xsh_path="$PWD"; xsh_path="\${xsh_path//%/%25}"; xsh_path="\${xsh_path// /%20}"; xsh_path="\${xsh_path//#/%23}"; xsh_path="\${xsh_path//\?/%3F}"; xsh_path="\${xsh_path//$'\n'/%0A}"; xsh_path="\${xsh_path//$'\r'/%0D}"; printf '\033]7;file://localhost%s\007' "$xsh_path"; };`,
  'if [ -n "\${BASH_VERSION-}" ]; then',
  String.raw`case "$PS1" in *'133;B'*) ;; *) PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]';; esac;`,
  String.raw`if ! declare -F __xsh_prompt_status_v2 >/dev/null; then __xsh_prompt_status_v2() { local xsh_status=$?; printf '\033]133;D;%s\007' "$xsh_status"; return "$xsh_status"; };`,
  String.raw`case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in 'declare -a'*) PROMPT_COMMAND[0]="__xsh_prompt_status_v2\${PROMPT_COMMAND[0]:+; \${PROMPT_COMMAND[0]}}";; *) PROMPT_COMMAND="__xsh_prompt_status_v2\${PROMPT_COMMAND:+; $PROMPT_COMMAND}";; esac; fi;`,
  String.raw`__xsh_prompt_status_v2() { local xsh_status=$?; printf '\033]133;D;%s\007' "$xsh_status"; __xsh_report_cwd_v1; return "$xsh_status"; };`,
  String.raw`if [ "\${BASH_VERSINFO[0]}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]}" -eq 4 ] && [ "\${BASH_VERSINFO[1]}" -ge 4 ]; }; then case "\${PS0-}" in *'133;C'*) ;; *) PS0='\e]133;C\a'"\${PS0-}";; esac; fi;`,
  'elif [ -n "\${ZSH_VERSION-}" ]; then',
  String.raw`case "$PS1" in *'133;B'*) ;; *) PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}';; esac;`,
  String.raw`if (( ! $+functions[__xsh_precmd_v2] )); then __xsh_preexec_v2() { printf '\033]133;C\007'; }; __xsh_precmd_v2() { local xsh_status=$?; printf '\033]133;D;%s\007' "$xsh_status"; return 0; }; preexec_functions=(__xsh_preexec_v2 "\${preexec_functions[@]}"); precmd_functions=(__xsh_precmd_v2 "\${precmd_functions[@]}"); fi;`,
  String.raw`__xsh_precmd_v2() { local xsh_status=$?; printf '\033]133;D;%s\007' "$xsh_status"; __xsh_report_cwd_v1; return 0; };`,
  String.raw`else printf '%s\n' 'XSH: 当前集成仅支持 Bash / Zsh'; fi`,
].join(" ").replace(/\\\$\{/g, "${");
