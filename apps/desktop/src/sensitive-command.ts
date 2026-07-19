const ASSIGNMENT_PATTERN = /\b(password|passwd|token|api[_-]?key|client[_-]?secret|access[_-]?key|secret[_-]?access[_-]?key)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const SSH_PASS_PATTERN = /\bsshpass\b[^\r\n]*?\s-p\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const MYSQL_PASSWORD_PATTERN = /\bmysql\b[^\r\n]*?\s-p([^\s;&|]+)/gi;
const CURL_USER_PATTERN = /\bcurl\b[^\r\n]*?(?:-u|--user)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const BEARER_PATTERN = /authorization\s*:\s*bearer\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i;

/**
 * Reject only high-confidence plaintext credentials. Variable references such
 * as $TOKEN, ${PASSWORD}, %API_KEY% and template placeholders remain allowed.
 */
export function containsSensitiveCommand(command: string): boolean {
  if (PRIVATE_KEY_PATTERN.test(command)) return true;
  return hasLiteralCapture(command, ASSIGNMENT_PATTERN, 2) ||
    hasLiteralCapture(command, SSH_PASS_PATTERN, 1) ||
    hasLiteralCapture(command, MYSQL_PASSWORD_PATTERN, 1) ||
    hasCredentialInUserInfo(command) ||
    hasLiteralCapture(command, BEARER_PATTERN, 1);
}

export const SENSITIVE_COMMAND_ERROR = "检测到疑似明文密码、Token 或私钥。快捷命令只保存命令模板，请改用环境变量引用敏感值。";

function hasCredentialInUserInfo(command: string): boolean {
  CURL_USER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CURL_USER_PATTERN.exec(command))) {
    const value = normalizeValue(match[1]);
    const separator = value.indexOf(":");
    if (separator >= 0 && isLiteralSecret(value.slice(separator + 1))) return true;
  }
  return false;
}

function hasLiteralCapture(command: string, pattern: RegExp, captureIndex: number): boolean {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    if (isLiteralSecret(match[captureIndex] ?? "")) return true;
  }
  return false;
}

function isLiteralSecret(value: string): boolean {
  const normalized = normalizeValue(value);
  if (normalized.length < 3) return false;
  return !(
    normalized.startsWith("$") ||
    normalized.startsWith("%") ||
    normalized.startsWith("<") ||
    normalized.includes("{{") ||
    normalized.includes("${") ||
    /^(?:redacted|hidden|secret|password|token|changeme|xxx+|\*+)$/i.test(normalized)
  );
}

function normalizeValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
