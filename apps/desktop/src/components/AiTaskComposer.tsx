import { Bug, ChevronDown, FileText, MousePointer2, Paperclip, TerminalSquare, X } from "lucide-react";
import { AI_CONTEXT_BYTES, byteLength, type AiMode } from "../ai-context";
import { AI_COMMAND_SUGGESTIONS, AI_TASKS } from "../ai-ui";

interface AiTaskComposerProps {
  mode: AiMode;
  prompt: string;
  context: string;
  contextLabel: string;
  canClearContext: boolean;
  canReadSelection: boolean;
  busy: boolean;
  followUp?: boolean;
  hasAttachedContext?: boolean;
  onModeChange: (mode: AiMode) => void;
  onPromptChange: (prompt: string) => void;
  onContextChange: (context: string) => void;
  onClearContext: () => void;
  onRequestSelection?: (mode: AiMode) => void;
  onRequestRecentOutput?: (mode: AiMode) => void;
  onPreview: () => void;
}

const taskIcons = { command: TerminalSquare, explain: FileText, diagnose: Bug };

export function AiTaskComposer({ mode, prompt, context, contextLabel, canClearContext, canReadSelection, busy, followUp = false, hasAttachedContext = false, onModeChange, onPromptChange, onContextChange, onClearContext, onRequestSelection, onRequestRecentOutput, onPreview }: AiTaskComposerProps) {
  const task = AI_TASKS[mode];
  return (
    <div className="ai-task-composer">
      <div className="ai-modes" role="group" aria-label="AI 任务">{(["command", "explain", "diagnose"] as const).map((taskMode) => {
        const Icon = taskIcons[taskMode];
        return <button type="button" key={taskMode} aria-pressed={mode === taskMode} className={mode === taskMode ? "active" : ""} disabled={busy} onClick={() => onModeChange(taskMode)}><Icon size={13} />{AI_TASKS[taskMode].label}</button>;
      })}</div>
      {!followUp && <p className="ai-task-description">{task.description}</p>}
      <label className="ai-label" htmlFor="ai-prompt">{followUp ? "继续提问" : mode === "command" ? "你想完成什么？" : "问题或补充说明"}</label>
      <textarea id="ai-prompt" rows={3} value={prompt} disabled={busy} placeholder={followUp ? "结合上面的结果继续提问，或附加新的终端输出…" : task.placeholder} onChange={(event) => onPromptChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && (prompt.trim() || context.trim() || hasAttachedContext)) { event.preventDefault(); onPreview(); }
      }} />
      {mode === "command" && !prompt && !followUp && <details className="ai-suggestion-examples"><summary>查看命令需求示例</summary><div className="ai-suggestions" aria-label="命令需求示例">{AI_COMMAND_SUGGESTIONS.map((suggestion) => (
        <button key={suggestion} type="button" disabled={busy} onClick={() => onPromptChange(suggestion)}><TerminalSquare size={13} /><span>{suggestion}</span></button>
      ))}</div></details>}
      <div className="ai-attach-toolbar">
        <span><Paperclip size={12} />附加上下文</span>
        <button type="button" disabled={busy || !canReadSelection || !onRequestSelection} onClick={() => onRequestSelection?.(mode)}><MousePointer2 size={12} />终端选区</button>
        <button type="button" disabled={busy || !canReadSelection || !onRequestRecentOutput} onClick={() => onRequestRecentOutput?.(mode)}><TerminalSquare size={12} />最近输出</button>
      </div>
      <details className={`ai-context-editor ${context ? "has-context" : ""}`}>
        <summary><span><FileText size={13} />{context ? contextLabel : "粘贴或编辑上下文"}</span><span>{context ? `${byteLength(context)} 字节` : "可选"}<ChevronDown size={12} /></span></summary>
        <div className="ai-context-editor-body">
          <textarea id="ai-context" aria-label="补充上下文" rows={4} value={context} disabled={busy} spellCheck={false} placeholder="粘贴命令输出、日志或环境信息。也可用上方按钮附加当前终端内容。" onChange={(event) => onContextChange(event.target.value)} />
          <div className="ai-context-meta"><span>{byteLength(context)} / {AI_CONTEXT_BYTES} 字节</span>{canClearContext && <button type="button" className="ai-text-button" disabled={busy} onClick={onClearContext}><X size={11} />移除</button>}</div>
        </div>
      </details>
      {mode !== "command" && !context && !hasAttachedContext && !followUp && <p className="ai-note ai-context-tip">附加报错或命令输出，AI 才能根据实际信息分析。可先在终端拖选文字。</p>}
    </div>
  );
}
