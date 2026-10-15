import { MousePointer2, TerminalSquare } from "lucide-react";
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
  onModeChange: (mode: AiMode) => void;
  onPromptChange: (prompt: string) => void;
  onContextChange: (context: string) => void;
  onClearContext: () => void;
  onRequestSelection?: (mode: "explain" | "diagnose") => void;
  onRequestRecentOutput?: (mode: "explain" | "diagnose") => void;
}

export function AiTaskComposer({ mode, prompt, context, contextLabel, canClearContext, canReadSelection, busy, followUp = false, onModeChange, onPromptChange, onContextChange, onClearContext, onRequestSelection, onRequestRecentOutput }: AiTaskComposerProps) {
  const task = AI_TASKS[mode];
  return (
    <>
      <div className="ai-modes" role="group" aria-label="AI 任务">{(["command", "explain", "diagnose"] as const).map((taskMode) => <button key={taskMode} aria-pressed={mode === taskMode} className={mode === taskMode ? "active" : ""} disabled={busy} onClick={() => onModeChange(taskMode)}>{AI_TASKS[taskMode].label}</button>)}</div>
      {!followUp && <div className="ai-task-intro"><h3>{task.title}</h3><p>{task.description}</p></div>}
      {mode === "command" && !prompt && !followUp && <div className="ai-suggestions" aria-label="命令需求示例"><span className="ai-note">试试这些只读操作</span>{AI_COMMAND_SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" disabled={busy} onClick={() => onPromptChange(suggestion)}><TerminalSquare size={13} /><span>{suggestion}</span></button>)}</div>}
      {mode !== "command" && <div className="ai-selection-guide"><div><MousePointer2 size={15} /><strong>{followUp ? "需要时附加新的终端输出" : "先在终端拖选一段文字"}</strong></div>{!followUp && <p>拖选命令或输出后，点击终端上方的“解释 / 分析报错”或下面的按钮。按住 Shift 再右键可打开 AI 菜单；普通右键可能会粘贴。</p>}<button type="button" className="secondary-button" disabled={busy || !canReadSelection || !onRequestSelection} onClick={() => onRequestSelection?.(mode)}>使用终端当前选区</button>{onRequestRecentOutput && <><p className="ai-note">手动附加后仍需预览确认，不会后台读取终端。</p><button type="button" className="secondary-button" disabled={busy || !canReadSelection} onClick={() => onRequestRecentOutput(mode)}>附加最近50行输出（先预览）</button></>}{!canReadSelection && <p className="ai-note">请先打开一个终端会话，也可以直接粘贴文本到下方。</p>}</div>}
      <label className="ai-label" htmlFor="ai-prompt">{followUp ? "继续追问或说明下一步" : mode === "command" ? "你想完成的操作" : "补充问题（可选）"}</label>
      <textarea id="ai-prompt" rows={3} value={prompt} disabled={busy} placeholder={followUp ? "例如：为什么会这样？根据刚才的结果，下一步应该检查什么？" : task.placeholder} onChange={(event) => onPromptChange(event.target.value)} />
      <p className="ai-note">{task.example}</p>
      <div className="ai-label"><label htmlFor="ai-context">{mode === "command" ? "补充上下文（可选）" : "要分析的选区或报错"}</label><button className="ai-text-button" disabled={busy || !canClearContext} onClick={onClearContext}>清空</button></div>
      <textarea id="ai-context" rows={mode === "command" ? 3 : 5} value={context} disabled={busy} spellCheck={false} placeholder={mode === "command" ? "可填写系统版本、目录或相关输出；没有上下文也能生成草稿。" : "获取终端选区后会显示在这里；也可手动粘贴并编辑。"} onChange={(event) => onContextChange(event.target.value)} />
      <div className="ai-context-meta"><span>{contextLabel}</span><span>{byteLength(context)} / {AI_CONTEXT_BYTES} 字节</span></div>
      <p className="ai-note">仅发送本次可见内容及预览列出的已完成历史，不会读取完整终端缓冲区。</p>
    </>
  );
}
