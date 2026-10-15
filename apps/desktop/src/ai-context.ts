export const AI_CONTEXT_BYTES = 16 * 1024;
export const AI_PROMPT_BYTES = 4 * 1024;
export const AI_COMMAND_BYTES = 16 * 1024;
const AI_UNSAFE_CONTROL = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

export type AiMode = "explain" | "diagnose" | "command";

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function truncateUtf8(text: string, maximum: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maximum) return text;
  let end = maximum;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(encoded.slice(0, end));
}

export function redactAiText(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, "[已隐藏 PEM 内容]")
    .replace(/(authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+)[^\s"'`,;]+/gi, "$1[已隐藏]")
    .replace(/((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/gi, "$1[已隐藏]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, "[已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已隐藏]")
    .replace(/((?:["']?)(?:[A-Za-z0-9_]{0,64}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|token)[A-Za-z0-9_]{0,64})["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[已隐藏]")
    .replace(/(--(?:password|passwd|token|api-key|secret)(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi, "$1[已隐藏]");
}

export function prepareAiText(text: string, maximum = AI_CONTEXT_BYTES): { text: string; redacted: boolean; truncated: boolean } {
  const redacted = redactAiText(text);
  return {
    text: truncateUtf8(redacted, maximum),
    redacted: redacted !== text,
    truncated: byteLength(redacted) > maximum,
  };
}

export function extractCommandDraft(response: string): string | null {
  const block = /```(?:sh|bash|shell|zsh|powershell|ps1|cmd)?\s*\n([\s\S]*?)\n```/i.exec(response);
  const command = block?.[1]?.trim();
  if (!command || byteLength(command) > 8 * 1024 || AI_UNSAFE_CONTROL.test(command)) return null;
  return command;
}

export function normalizeAiTerminalCommand(text: string): string {
  if (!text.trim()) throw new Error("命令草稿不能为空");
  if (AI_UNSAFE_CONTROL.test(text)) {
    throw new Error("命令草稿包含不安全的控制字符，请使用普通文本和空格");
  }
  const normalized = text.replace(/\r?\n/g, "\r");
  const command = normalized.endsWith("\r") ? normalized : `${normalized}\r`;
  if (byteLength(command) > AI_COMMAND_BYTES) throw new Error("命令草稿不能超过 16 KiB");
  return command;
}
