import { AI_CONTEXT_BYTES, byteLength, prepareAiText, truncateUtf8 } from "./ai-context.ts";

export interface AiContextTarget {
  tabId: string;
  name: string;
  connectionVersion: number;
  connectionId: string | null;
  host?: string;
  directory?: string | null;
}

export type AiContextSource = "selection" | "recent-output" | "execution" | "file";

export interface AiContextItem {
  id: string;
  source: AiContextSource;
  title: string;
  target: AiContextTarget | null;
  capturedAt: string;
  text: string;
  bytes: number;
  redacted: boolean;
  truncated: boolean;
  included: boolean;
}

export const CONTEXT_SOURCE_LABELS: Record<AiContextSource, string> = {
  selection: "终端选区", "recent-output": "最近输出", execution: "执行结果", file: "文件片段",
};
export const MAX_CONTEXT_ITEMS = 6;
const ITEM_BYTES = 8 * 1024;

export function createContextItem(source: AiContextSource, text: string, target: AiContextTarget | null, title = CONTEXT_SOURCE_LABELS[source]): AiContextItem {
  const safe = prepareAiText(text, ITEM_BYTES);
  return {
    id: crypto.randomUUID(), source, title: prepareAiText(title, 512).text, target,
    capturedAt: new Date().toISOString(), text: safe.text, bytes: byteLength(safe.text),
    redacted: safe.redacted, truncated: safe.truncated, included: true,
  };
}

export function contextTargetMatches(first: AiContextTarget | null, second: AiContextTarget | null): boolean {
  return first?.tabId === second?.tabId && first?.connectionVersion === second?.connectionVersion && first?.connectionId === second?.connectionId;
}

/** Freeze exactly what the request preview will show, including provenance and omissions. */
export function assembleAiContext(items: readonly AiContextItem[], manual: string): { text: string; truncated: boolean; omitted: number } {
  const blocks: string[] = [];
  let remaining = AI_CONTEXT_BYTES;
  let truncated = false;
  let omitted = 0;
  const append = (header: string, text: string) => {
    const separator = blocks.length ? "\n\n" : "";
    const prefix = `${separator}${header}\n`;
    const available = remaining - byteLength(prefix);
    if (available < 96) { omitted += 1; return; }
    const safe = prepareAiText(text, available);
    const marker = "\n[此来源已截短]";
    const content = safe.truncated ? truncateUtf8(safe.text, Math.max(0, available - byteLength(marker))) + marker : safe.text;
    const block = prefix + content;
    blocks.push(block);
    remaining -= byteLength(block);
    truncated ||= safe.truncated;
  };
  // An explicit user note should not disappear behind a long terminal result.
  if (manual.trim()) append("手动补充：", manual);
  for (const item of items.filter((entry) => entry.included)) {
    const origin = item.target ? `${item.target.name}${item.target.host ? ` · ${item.target.host}` : ""}` : "未绑定终端";
    const header = `[${CONTEXT_SOURCE_LABELS[item.source]} · ${item.title}]\n来源：${origin}\n目录：${item.target?.directory ?? "未报告"}\n采集：${item.capturedAt}${item.truncated ? "\n原始内容已截短" : ""}`;
    append(header, item.text);
  }
  return { text: blocks.join(""), truncated, omitted };
}
