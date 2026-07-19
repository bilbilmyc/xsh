/** Convert a saved quick-command string into bytes-friendly terminal input. */
export function normalizeTerminalCommand(text: string): string {
  // Keep command text readable in the editor and decode common terminal
  // escapes only when sending. For example, `ls\\r-t` sends `ls`, Enter,
  // then `-t`. Real newlines have the same Enter semantics.
  const decoded = text.replace(/\\\\([rnt\\\\])/g, (_, escape: string) => {
    if (escape === "r") return "\r";
    if (escape === "n") return "\n";
    if (escape === "t") return "\t";
    return "\\";
  });
  const normalized = decoded.replace(/\r?\n/g, "\r");
  return normalized.endsWith("\r") ? normalized : `${normalized}\r`;
}
