import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy } from "lucide-react";
import { AI_TASKS } from "../ai-ui";
import { writeClipboardText } from "../clipboard";
import { AiResponse } from "./AiResponse";
import type { AiConversationTurn } from "./useAiConversation";
import { parseDiagnosticPlan, type DiagnosticProposal } from "../ai-diagnostic";

interface AiConversationViewProps {
  turns: AiConversationTurn[];
  commandBusy: boolean;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onUseCommand: (turn: AiConversationTurn, command: string) => void;
  onError: (message: string) => void;
  onReviewPlan?: (turn: AiConversationTurn, steps: DiagnosticProposal[]) => void;
}

const ConversationTurn = memo(function ConversationTurn({ turn, index, commandBusy, onUseCommand, onError, onReviewPlan }: Omit<AiConversationViewProps, "turns" | "scrollContainerRef"> & { turn: AiConversationTurn; index: number }) {
  const [copied, setCopied] = useState(false);
  const plan = turn.mode === "diagnose" && turn.status === "complete" ? parseDiagnosticPlan(turn.text) : null;
  const response = plan ? turn.text.replace(/(?:^|\n)```xsh-plan\s*\r?\n[\s\S]*?\r?\n```/, "") : turn.text;
  return (
    <article className="ai-turn" aria-label={`第 ${index + 1} 轮对话`}>
      <div className="ai-turn-question">
        <div className="ai-label"><strong>你<span>{AI_TASKS[turn.mode].label}</span></strong><span>{index + 1}</span></div>
        <p>{turn.prompt || "请分析附加的终端内容。"}</p>
        {turn.context && <details><summary>{turn.contextLabel}</summary><pre>{turn.context}</pre></details>}
      </div>
      <section className="ai-response" aria-label="AI 回复" aria-busy={turn.status === "streaming"}>
        <div className="ai-label"><div><h3>XSH 助手</h3><span className="ai-note">{turn.model}</span></div><button className="icon-button" aria-label="复制 AI 回复" title="复制 AI 回复" disabled={!turn.text} onClick={() => {
          void writeClipboardText(turn.text).then(() => setCopied(true)).catch(() => onError("复制失败，请手动选择文本复制"));
        }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
        {response && <AiResponse text={response} complete={turn.status === "complete" && !commandBusy} onUseCommand={(command) => onUseCommand(turn, command)} onError={onError} />}
        {plan && onReviewPlan && <button type="button" className="secondary-button ai-full" disabled={commandBusy} onClick={() => onReviewPlan(turn, plan)}>审阅 {plan.length} 步诊断计划</button>}
        {turn.status === "streaming" && <p className="ai-stream-status" role="status"><span className="ai-stream-dot" />{turn.text ? "正在分析…" : "正在等待 AI 回复…"}</p>}
        {turn.status === "stopped" && <p className="ai-warning">生成已停止；本轮不完整回复不会加入后续对话。</p>}
        {turn.status === "error" && <p className="ai-error" role="alert">{turn.error || "本轮回复失败"}。可修改问题后重试。</p>}
      </section>
    </article>
  );
});

export function AiConversationView({ turns, commandBusy, scrollContainerRef, onUseCommand, onError, onReviewPlan }: AiConversationViewProps) {
  const followRef = useRef(true);
  const latestTurnIdRef = useRef<string | null>(null);

  useEffect(() => {
    const element = scrollContainerRef.current;
    const latest = turns[turns.length - 1];
    if (latest?.id !== latestTurnIdRef.current) {
      latestTurnIdRef.current = latest?.id ?? null;
      followRef.current = true;
    }
    if (element && followRef.current) element.scrollTop = element.scrollHeight;
  }, [turns, scrollContainerRef]);

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;
    const trackScroll = () => { followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; };
    element.addEventListener("scroll", trackScroll, { passive: true });
    return () => element.removeEventListener("scroll", trackScroll);
  }, [scrollContainerRef]);

  if (!turns.length) return null;

  return (
    <section className="ai-conversation" aria-label="当前终端的 AI 对话">
      <div className="ai-transcript">
        {turns.map((turn, index) => <ConversationTurn key={turn.id} turn={turn} index={index} commandBusy={commandBusy} onUseCommand={onUseCommand} onError={onError} onReviewPlan={onReviewPlan} />)}
      </div>
    </section>
  );
}
