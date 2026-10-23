import { useState } from "react";
import { FileText, Plus, X } from "lucide-react";
import { byteLength } from "../ai-context";
import { CONTEXT_SOURCE_LABELS, MAX_CONTEXT_ITEMS, contextTargetMatches, type AiContextItem, type AiContextTarget } from "../ai-context-inventory";

export function AiContextInventory({ items, target, busy, onChange, onAddFile }: {
  items: readonly AiContextItem[];
  target: AiContextTarget | null;
  busy: boolean;
  onChange: (items: AiContextItem[]) => void;
  onAddFile: (name: string, text: string) => void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  return <section className="ai-context-inventory" aria-label="上下文来源清单">
    {items.length > 0 && <div className="ai-context-inventory-title"><strong>本次上下文 · {items.filter((item) => item.included).length} 项</strong><span>可逐项取消或移除</span></div>}
    {items.map((item) => {
      const stale = !!item.target && !contextTargetMatches(item.target, target);
      return <div className={`ai-context-item ${stale ? "stale" : ""}`} key={item.id}>
        <div className="ai-context-item-heading">
          <input type="checkbox" aria-label={`附加 ${item.title}`} checked={item.included} disabled={busy} onChange={(event) => onChange(items.map((entry) => entry.id === item.id ? { ...entry, included: event.target.checked } : entry))} />
          <details><summary><FileText size={12} /><strong>{item.title}</strong><span>{item.bytes} B</span></summary><pre>{item.text}</pre></details>
          <button type="button" className="icon-button" disabled={busy} aria-label={`移除上下文 ${item.title}`} onClick={() => onChange(items.filter((entry) => entry.id !== item.id))}><X size={12} /></button>
        </div>
        <p>{CONTEXT_SOURCE_LABELS[item.source]} · {item.target?.host || item.target?.name || "手动附加"} · {new Date(item.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p>
        <p title={item.target?.directory ?? undefined}>目录：{item.target?.directory ?? "Shell 尚未报告"}</p>
        {(stale || item.redacted || item.truncated) && <p className={stale ? "ai-warning" : "ai-note"}>{[stale && "来自旧连接，请取消附加或重新采集", item.redacted && "已脱敏", item.truncated && "已截短"].filter(Boolean).join(" · ")}</p>}
      </div>;
    })}
    <details className="ai-file-snippet">
      <summary><Plus size={12} />附加文件片段</summary>
      <div><label>文件路径或名称<input aria-label="文件片段名称" value={name} maxLength={512} disabled={busy} placeholder="例如 /etc/nginx/nginx.conf:12-30" onChange={(event) => setName(event.target.value)} /></label>
        <textarea aria-label="文件片段内容" rows={3} value={text} maxLength={32 * 1024} disabled={busy} placeholder="粘贴需要分析的片段，发送前可查看脱敏结果。" onChange={(event) => setText(event.target.value)} />
        <button type="button" className="secondary-button" disabled={busy || !text.trim() || items.length >= MAX_CONTEXT_ITEMS} onClick={() => { onAddFile(name.trim() || "手动文件片段", text); setName(""); setText(""); }}>附加片段 <span>{byteLength(text)} B</span></button>
      </div>
    </details>
    {items.length >= MAX_CONTEXT_ITEMS && <p className="ai-note">最多附加 {MAX_CONTEXT_ITEMS} 项，请移除不再需要的来源。</p>}
  </section>;
}
