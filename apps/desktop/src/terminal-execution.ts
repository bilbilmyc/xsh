import { AI_CONTEXT_BYTES, byteLength, prepareAiText } from "./ai-context.ts";

export interface TerminalExecution {
  id: string;
  connectionId: string;
  command: string;
  source: "terminal" | "ai" | "command";
  startedAt: string;
  endedAt: string | null;
  status: "sent" | "running" | "finished" | "unknown" | "interrupted" | "send-failed";
  exitCode: number | null;
  output: string | null;
  truncated: boolean;
  boundary: "shell" | "prompt" | "unavailable";
}

interface Marker {
  line: number;
  isDisposed: boolean;
  dispose(): void;
}

interface ExecutionBuffer {
  type: "normal" | "alternate";
  baseY: number;
  cursorY: number;
  cursorX: number;
  getLine(index: number): { isWrapped: boolean; translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string } | undefined;
}

export interface ExecutionCursor {
  buffer: ExecutionBuffer;
  marker(): Marker | undefined;
}

const MAX_RECORDS = 40;
const MAX_OUTPUT_BYTES = 256 * 1024;

function boundRecords(records: readonly TerminalExecution[]): TerminalExecution[] {
  let bytes = 0;
  return records.slice(0, MAX_RECORDS).map((record) => {
    bytes += byteLength(record.output ?? "");
    return bytes > MAX_OUTPUT_BYTES && record.output !== null ? { ...record, output: null, truncated: true } : record;
  });
}

function readOutput(start: { marker: Marker; column: number }, buffer: ExecutionBuffer): { output: string | null; truncated: boolean } {
  if (buffer.type !== "normal" || start.marker.isDisposed) return { output: null, truncated: true };
  const endRow = buffer.baseY + buffer.cursorY;
  if (endRow < start.marker.line) return { output: null, truncated: true };
  const rows: Array<{ row: number; text: string }> = [];
  let bytes = 0;
  let truncated = false;
  // Read backwards so long outputs retain their most recent evidence.
  for (let row = endRow; row >= start.marker.line; row -= 1) {
    const line = buffer.getLine(row);
    if (!line) { truncated = true; break; }
    const wrapped = row < endRow && !!buffer.getLine(row + 1)?.isWrapped;
    const text = line.translateToString(!wrapped, row === start.marker.line ? start.column : 0, row === endRow ? buffer.cursorX : undefined);
    const separator = row < endRow && !wrapped ? "\n" : "";
    bytes += byteLength(text + separator);
    if (bytes > AI_CONTEXT_BYTES) { truncated = true; break; }
    rows.unshift({ row, text: text + separator });
  }
  // A tail cut inside a soft-wrapped credential has lost its identifying
  // prefix. Drop that incomplete logical line before attempting redaction.
  if (truncated) {
    while (rows.length && buffer.getLine(rows[0].row)?.isWrapped) rows.shift();
  }
  const safe = prepareAiText(rows.map((line) => line.text).join("").replace(/^\n/, "").replace(/\n$/, ""));
  return { output: safe.text, truncated: truncated || safe.truncated };
}

/**
 * A bounded, memory-only ledger. OSC 133 C/D define execution/output bounds;
 * a verified submitted line can fall back to the next A marker, with an
 * explicitly unknown exit code. Silence and transport ACKs never finish work.
 */
export class TerminalExecutionLedger {
  private records: TerminalExecution[];
  private active: { id: string; start: { marker: Marker; column: number } | null } | null = null;

  constructor(records: readonly TerminalExecution[] = []) {
    this.records = boundRecords(records.map((record) => record.status === "sent" || record.status === "running"
      ? { ...record, status: "interrupted", exitCode: null, boundary: "unavailable", endedAt: new Date().toISOString() }
      : record));
  }

  getSnapshot(): readonly TerminalExecution[] {
    return this.records;
  }

  sent(command: string, connectionId: string, source: TerminalExecution["source"], cursor: ExecutionCursor, trustedCommand: boolean, verifiedEcho: boolean, executionId?: string): string {
    const singleLine = !/[\r\n]/.test(command.replace(/\r?\n?$/, ""));
    const canCapture = trustedCommand && singleLine && !this.active;
    const record: TerminalExecution = {
      id: executionId ?? crypto.randomUUID(), connectionId, command: prepareAiText(command.trim(), 4096).text, source,
      startedAt: new Date().toISOString(), endedAt: null,
      status: canCapture ? "sent" : "unknown", exitCode: null, output: null, truncated: false, boundary: "unavailable",
    };
    this.records = [record, ...this.records].slice(0, MAX_RECORDS);
    if (canCapture) {
      const marker = verifiedEcho && cursor.buffer.type === "normal" ? cursor.marker() : undefined;
      this.active = { id: record.id, start: marker ? { marker, column: cursor.buffer.cursorX } : null };
    }
    this.boundMemory();
    return record.id;
  }

  osc(data: string, cursor: ExecutionCursor) {
    if (!this.active) return;
    const [kind, code] = data.split(";");
    if (kind === "C") {
      if (this.records.find((record) => record.id === this.active?.id)?.status === "running") return;
      this.active.start?.marker.dispose();
      const marker = cursor.buffer.type === "normal" ? cursor.marker() : undefined;
      this.active.start = marker ? { marker, column: cursor.buffer.cursorX } : null;
      this.update(this.active.id, { status: "running", boundary: "shell" });
    } else if (kind === "D" || kind === "A") {
      const numeric = kind === "D" && /^(?:0|[1-9]\d{0,2})$/.test(code ?? "") ? Number(code) : null;
      this.finish(cursor.buffer, "finished", numeric !== null && numeric <= 255 ? numeric : null, kind === "D" ? "shell" : "prompt");
    }
  }

  failed(id: string) {
    if (this.active?.id === id) {
      this.active.start?.marker.dispose();
      this.active = null;
    }
    this.update(id, { status: "send-failed", endedAt: new Date().toISOString(), exitCode: null, output: null, boundary: "unavailable" });
  }

  disconnected(buffer: ExecutionBuffer) {
    if (this.active) this.finish(buffer, "interrupted", null, "unavailable");
  }

  private finish(buffer: ExecutionBuffer, status: TerminalExecution["status"], exitCode: number | null, boundary: TerminalExecution["boundary"]) {
    const active = this.active;
    if (!active) return;
    const captured = active.start ? readOutput(active.start, buffer) : { output: null, truncated: false };
    active.start?.marker.dispose();
    this.active = null;
    this.update(active.id, { ...captured, status, exitCode, boundary, endedAt: new Date().toISOString() });
    this.boundMemory();
  }

  private update(id: string, patch: Partial<TerminalExecution>) {
    this.records = this.records.map((record) => record.id === id ? { ...record, ...patch } : record);
  }

  private boundMemory() {
    this.records = boundRecords(this.records);
  }
}

export function executionStatus(record: TerminalExecution): string {
  if (record.status === "send-failed") return "发送失败";
  if (record.status === "interrupted") return "连接已中断";
  if (record.status === "running") return "执行中";
  if (record.status === "sent") return "已发送，等待执行边界";
  if (record.status === "unknown") return "已发送，结果范围未知";
  if (record.exitCode === null) return "已返回提示符，退出码未知";
  return record.exitCode === 0 ? "已结束 · 退出码 0" : `已结束 · 退出码 ${record.exitCode}`;
}

export function executionAiContext(record: TerminalExecution): string | null {
  if (record.output === null || record.status !== "finished") return null;
  return prepareAiText([
    `命令：${record.command}`,
    `开始：${record.startedAt}`,
    `结束：${record.endedAt}`,
    `状态：${executionStatus(record)}`,
    "以下为这条命令执行期间的终端输出，可能混有同一 PTY 的后台消息。不能据此推断未展示的状态。",
    record.truncated ? "输出已截短或丢失部分内容。" : "",
    "输出：", record.output,
  ].filter(Boolean).join("\n")).text;
}

export function mergeTerminalExecutions(previous: readonly TerminalExecution[], updates: readonly TerminalExecution[]): readonly TerminalExecution[] {
  const replaced = new Set(updates.map((record) => record.id));
  return boundRecords([...updates, ...previous.filter((record) => !replaced.has(record.id))]);
}

export interface TerminalExecutionRequest {
  connectionId: string;
  text: string;
  executionId?: string;
  accept: (result: Promise<void>) => void;
}

export function executeAiTerminalCommand(connectionId: string, text: string, executionId?: string): Promise<void> {
  let result: Promise<void> | undefined;
  window.dispatchEvent(new CustomEvent<TerminalExecutionRequest>("xsh:execute-ai-command", {
    detail: { connectionId, text, executionId, accept: (operation) => { result = operation; } },
  }));
  return result ?? Promise.reject(new Error("目标终端尚未就绪，请重新检查连接。"));
}
