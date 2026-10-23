import { Activity, ArrowRight, Sparkles } from "lucide-react";
import { executionAiContext, executionStatus, type TerminalExecution } from "../terminal-execution";
import "./TerminalExecutionList.css";

interface Props {
  records: readonly TerminalExecution[];
  connectionId: string | null;
  onAnalyze?: (record: TerminalExecution) => void;
  onSuggestNext?: (record: TerminalExecution) => void;
}

export function TerminalExecutionList({ records, connectionId, onAnalyze, onSuggestNext }: Props) {
  if (!records.length) return <p className="execution-empty">启用 Shell 提示符识别后，这里会记录命令、实际输出和退出状态。记录仅保留在当前窗口。</p>;
  return <div className="execution-list" aria-label="命令执行记录">
    {records.map((record) => {
      const current = record.connectionId === connectionId;
      const canAnalyze = current && executionAiContext(record) !== null;
      return <article className={`execution-record ${record.status}`} key={record.id}>
        <div className="execution-meta"><span><Activity size={12} />{executionStatus(record)}</span><time dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>
        <code className="execution-command">{record.command}</code>
        {!current && <span className="execution-note">之前的连接 · 仅供回看</span>}
        {record.output !== null ? <details className="execution-output"><summary>查看本次输出{record.truncated ? " · 已截短" : ""}</summary><pre>{record.output || "（没有文本输出）"}</pre></details> : <p className="execution-note">{record.status === "sent" || record.status === "running" ? "等待 Shell 返回执行结果…" : "未取得可靠的输出范围，可手动选择终端内容分析。"}</p>}
        {(onAnalyze || onSuggestNext) && <div className="execution-actions">
          {onAnalyze && <button type="button" disabled={!canAnalyze} onClick={() => onAnalyze(record)}><Activity size={12} />分析这次结果<ArrowRight size={12} /></button>}
          {onSuggestNext && <button type="button" disabled={!canAnalyze} onClick={() => onSuggestNext(record)}><Sparkles size={12} />下一步命令</button>}
        </div>}
      </article>;
    })}
  </div>;
}
