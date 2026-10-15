import { AI_CONTEXT_BYTES, byteLength } from "./ai-context.ts";

interface TerminalContextBuffer {
  baseY: number;
  cursorY: number;
  length: number;
  getLine: (index: number) => { isWrapped?: boolean; translateToString: (trimRight: boolean) => string } | undefined;
}

export function readRecentTerminalOutput(buffer: TerminalContextBuffer, maximumLines = 50): string {
  const end = Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
  const start = Math.max(0, end - Math.min(50, Math.max(1, maximumLines)) + 1);
  const logicalLines: string[] = [];
  let skipPartial = !!buffer.getLine(start)?.isWrapped;
  let oversized = false;
  let logicalBytes = 0;
  for (let index = start; index <= end; index += 1) {
    const line = buffer.getLine(index);
    if (skipPartial && line?.isWrapped) continue;
    skipPartial = false;
    const continues = index < end && !!buffer.getLine(index + 1)?.isWrapped;
    const text = line?.translateToString(!continues) ?? "";
    if (!line?.isWrapped || !logicalLines.length) {
      logicalLines.push("");
      logicalBytes = 0;
      oversized = false;
    }
    logicalBytes += byteLength(text);
    if (logicalBytes > AI_CONTEXT_BYTES) oversized = true;
    const last = logicalLines.length - 1;
    logicalLines[last] = oversized ? "[已省略超过16 KiB的完整输出行]" : logicalLines[last] + text;
  }
  const lines: string[] = [];
  let remainingBytes = AI_CONTEXT_BYTES;
  for (const line of logicalLines.reverse()) {
    const lineBytes = byteLength(line) + (lines.length ? 1 : 0);
    if (lineBytes > remainingBytes) break;
    lines.unshift(line);
    remainingBytes -= lineBytes;
  }
  return lines.join("\n").trim();
}
