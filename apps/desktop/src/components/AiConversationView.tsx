import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { AI_TASKS } from "../ai-ui";
import { writeClipboardText } from "../clipboard";
import type { AiConversationTurn } from "./useAiConversation";

interface AiConversationViewProps {
  turns: AiConversationTurn[];
  onError: (message: string) => void;
}

export function AiConversationView({ turns, onError }: AiConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const latestTurnIdRef = useRef<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    const latest = turns[turns.length - 1];
    if (latest?.id !== latestTurnIdRef.current) {
      latestTurnIdRef.current = latest?.id ?? null;
      followRef.current = true;
      if (latest?.status === "streaming") element?.scrollIntoView({ block: "nearest" });
    }
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [turns]);

  if (!turns.length) return null;

  return (
    <section className="ai-conversation" aria-label="当前终端的 AI 对话">
      <h3>对话记录</h3>
      <div ref={scrollRef} className="ai-transcript" onScroll={() => {
        const element = scrollRef.current;
        if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      }}>
        {turns.map((turn, index) => (
          <article className="ai-turn" key={turn.id} aria-label={`第 ${index + 1} 轮对话`}>
            <div className="ai-turn-question">
              <div className="ai-label"><strong>你 · {AI_TASKS[turn.mode].label}</strong><span>{index + 1}</span></div>
              <p>{turn.prompt || "请分析附加的终端内容。"}</p>
              {turn.context && <details><summary>{turn.contextLabel}</summary><pre>{turn.context}</pre></details>}
            </div>
            <section className="ai-response" aria-label="AI 回复" aria-busy={turn.status === "streaming"}>
              <div className="ai-label"><h3>AI 回复</h3><button className="icon-button" aria-label="复制 AI 回复" title="复制 AI 回复" disabled={!turn.text} onClick={() => {
                void writeClipboardText(turn.text).then(() => setCopiedId(turn.id)).catch(() => onError("复制失败，请手动选择文本复制"));
              }}>{copiedId === turn.id ? <Check size={14} /> : <Copy size={14} />}</button></div>
              <p className="ai-note">{turn.model} · {turn.target?.name ?? "未绑定终端"}</p>
              {turn.text && <pre>{turn.text}</pre>}
              {turn.status === "streaming" && <p className="ai-stream-status" role="status"><span className="ai-stream-dot" />{turn.text ? "正在流式输出…" : "请求已发送，等待首段回复…"}</p>}
              {turn.status === "stopped" && <p className="ai-warning">已停止。以上是不完整回复，不会加入后续历史，也不能生成执行草稿。</p>}
              {turn.status === "error" && <p className="ai-error" role="alert">{turn.error || "本轮回复失败"}。不完整回复不会加入后续历史。</p>}
            </section>
          </article>
        ))}
      </div>
      <p className="ai-note">对话仅保留在本次运行的内存中，按终端标签隔离。AI 建议不会自动执行。</p>
    </section>
  );
}
