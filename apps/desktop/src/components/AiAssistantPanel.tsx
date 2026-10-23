import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, Check, Plus, RefreshCw, Settings2, Square, X } from "lucide-react";
import { aiApi, type AiSettings } from "../ai-api";
import { buildAiHistory } from "../ai-conversation";
import { AI_PROMPT_BYTES, prepareAiText, type AiMode } from "../ai-context";
import { AI_SETTINGS_CHANGED_EVENT, AI_TASKS, aiServiceHost } from "../ai-ui";
import { AiConversationView } from "./AiConversationView";
import { AiConversationArchives } from "./AiConversationArchives";
import { AiTaskComposer } from "./AiTaskComposer";
import { sameAiTarget, useAiConversation, type AiConversationTurn } from "./useAiConversation";
import type { TerminalExecution } from "../terminal-execution";
import { TerminalExecutionList } from "./TerminalExecutionList";
import { AiContextInventory } from "./AiContextInventory";
import { assembleAiContext, createContextItem, contextTargetMatches, MAX_CONTEXT_ITEMS } from "../ai-context-inventory";
import { createDiagnosticPlan, reconcileDiagnosticPlan, type DiagnosticStep } from "../ai-diagnostic";
import { AiDiagnosticPlanView } from "./AiDiagnosticPlan";
import { executionAiContext } from "../terminal-execution";
import "./AiAssistantPanel.css";

export interface AiTarget {
  tabId: string;
  name: string;
  connected: boolean;
  connectionVersion: number;
  connectionId: string | null;
  host?: string;
  directory?: string | null;
}

export interface AiContextRequest {
  id: number;
  tabId: string;
  sessionName: string;
  connectionVersion: number;
  connectionId: string | null;
  mode: AiMode;
  text: string;
  source?: "selection" | "recent-output" | "execution";
  host?: string;
  directory?: string | null;
}

interface AiAssistantPanelProps {
  target: AiTarget | null;
  openTabIds: string[];
  contextRequest: AiContextRequest | null;
  onContextConsumed: (requestId: number) => void;
  onOpenSettings?: () => void;
  onRequestSelection?: (mode: AiMode) => void;
  onRequestRecentOutput?: (mode: AiMode) => void;
  onClose: () => void;
  onSendDraft: (command: string, tabId: string, connectionVersion: number, connectionId: string | null, executionId?: string) => Promise<boolean>;
  executions?: readonly TerminalExecution[];
  onAnalyzeExecution?: (record: TerminalExecution) => void;
  onSuggestNextExecution?: (record: TerminalExecution) => void;
}

export function AiAssistantPanel({ target, openTabIds, contextRequest, onContextConsumed, onOpenSettings, onRequestSelection, onRequestRecentOutput, onClose, onSendDraft, executions = [], onAnalyzeExecution, onSuggestNextExecution }: AiAssistantPanelProps) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState("");
  const [sendingTurnId, setSendingTurnId] = useState<string | null>(null);
  const settingsEpoch = useRef(0);
  const draftInputRef = useRef<HTMLTextAreaElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const { conversation, busy, updateCurrent, updateForTab, stop, archiveAll, startNew, submit } = useAiConversation(target, openTabIds);
  const { mode, prompt, context, contextItems, diagnosticPlan, turns, prepared, draft, lastExecution, notice, error } = conversation;
  const showError = useCallback((message: string) => updateCurrent((previous) => ({ ...previous, error: message })), [updateCurrent]);
  const stageCommand = useCallback((turn: AiConversationTurn, command: string) => {
    if (turn.status !== "complete" || busy || sendingTurnId) return;
    updateCurrent((previous) => ({
      ...previous,
      draft: { turnId: turn.id, text: command, target: turn.target },
      error: null,
      notice: "命令已放入下方草稿，可编辑后检查执行目标。",
    }));
    requestAnimationFrame(() => {
      draftInputRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
      draftInputRef.current?.focus({ preventScroll: true });
    });
  }, [busy, sendingTurnId, updateCurrent]);

  const loadSettings = () => {
    const epoch = ++settingsEpoch.current;
    setLoadingSettings(true);
    setSettingsError(null);
    void aiApi.getSettings().then((saved) => { if (epoch === settingsEpoch.current) setSettings(saved); })
      .catch((caught) => { if (epoch === settingsEpoch.current) { setSettings(null); setSettingsError(String(caught)); } })
      .finally(() => { if (epoch === settingsEpoch.current) setLoadingSettings(false); });
  };

  useEffect(() => {
    loadSettings();
    const refresh = () => {
      archiveAll();
      setServiceNotice("AI 服务配置已更新，先前内容可在旧对话中查看。");
      loadSettings();
    };
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
    return () => { settingsEpoch.current += 1; window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, refresh); };
  }, [archiveAll]);

  useEffect(() => {
    if (!contextRequest) return;
    stop();
    const item = createContextItem(contextRequest.source ?? "selection", contextRequest.text, { tabId: contextRequest.tabId, name: contextRequest.sessionName, connectionVersion: contextRequest.connectionVersion, connectionId: contextRequest.connectionId, host: contextRequest.host, directory: contextRequest.directory });
    updateForTab(contextRequest.tabId, (previous) => ({
      ...previous,
      mode: contextRequest.mode,
      contextItems: previous.contextItems.length < MAX_CONTEXT_ITEMS ? [...previous.contextItems, item] : previous.contextItems,
      prompt: contextRequest.source === "execution" ? "请根据这次命令及其实际输出判断结果，区分已确认的结论与尚待验证的推测，并给出下一步检查命令。" : previous.prompt,
      prepared: null,
      error: null,
      notice: previous.contextItems.length >= MAX_CONTEXT_ITEMS ? "上下文已达 6 项，请移除不再需要的来源后重新附加。" : "已附加上下文快照，请在来源清单中查看后发送。",
    }));
    onContextConsumed(contextRequest.id);
  }, [contextRequest?.id]);

  useEffect(() => {
    updateCurrent((previous) => {
      if (!previous.diagnosticPlan) return previous;
      const next = reconcileDiagnosticPlan(previous.diagnosticPlan, executions);
      return next === previous.diagnosticPlan ? previous : { ...previous, diagnosticPlan: next };
    });
  }, [executions, updateCurrent]);

  const assembled = assembleAiContext(contextItems, context);
  const hasContext = !!assembled.text;
  const contextLabel = contextItems.some((item) => item.included) ? `${contextItems.filter((item) => item.included).length} 项上下文来源${context.trim() ? "及手动补充" : ""}` : context ? "手动补充" : "未附加终端内容";
  const staleContext = contextItems.some((item) => item.included && item.target && !contextTargetMatches(item.target, target));
  const stalePreview = !!prepared && !sameAiTarget(prepared.target, target);

  const prepare = () => {
    if (!settings || loadingSettings || staleContext || busy || sendingTurnId) return;
    const safePrompt = prepareAiText(prompt, AI_PROMPT_BYTES);
    const safeContext = prepareAiText(assembled.text);
    const history = buildAiHistory(turns);
    updateCurrent((previous) => ({ ...previous, error: null, prepared: {
      mode,
      prompt: safePrompt.text,
      context: safeContext.text,
      contextLabel,
      target: target ? { ...target } : null,
      notice: safePrompt.truncated || safeContext.truncated || assembled.truncated || assembled.omitted ? `已按 4 KiB 问题 / 16 KiB 上下文上限截取。${assembled.omitted ? `本次有 ${assembled.omitted} 项来源未包含，请减少来源后重试。` : ""}` : "已隐藏常见凭据；请人工确认没有其他敏感信息。",
      model: settings.model,
      baseUrl: settings.baseUrl,
      history: history.history,
      includedTurns: history.includedTurns,
      omittedTurns: history.omittedTurns,
      truncatedMessages: history.truncatedMessages,
    } }));
  };

  const addFileContext = (name: string, text: string) => {
    const item = createContextItem("file", text, target, name);
    updateCurrent((previous) => ({ ...previous, contextItems: previous.contextItems.length < MAX_CONTEXT_ITEMS ? [...previous.contextItems, item] : previous.contextItems, prepared: null }));
  };
  const executeStep = async (step: DiagnosticStep) => {
    const plan = diagnosticPlan;
    const destination = plan?.target;
    if (!plan || !destination || !target?.connected || !contextTargetMatches(destination, target) || sendingTurnId || busy || plan.stopped || plan.steps.some((entry) => entry.status === "sending" || entry.status === "awaiting")) return;
    const executionId = crypto.randomUUID();
    const updateStep = (patch: Partial<DiagnosticStep>) => updateForTab(destination.tabId, (previous) => previous.diagnosticPlan?.id === plan.id ? { ...previous, diagnosticPlan: { ...previous.diagnosticPlan, steps: previous.diagnosticPlan.steps.map((entry) => entry.id === step.id ? { ...entry, ...patch } : entry) } } : previous);
    setSendingTurnId(step.id);
    updateStep({ status: "sending", executionId });
    try {
      const sent = await onSendDraft(step.command, destination.tabId, destination.connectionVersion, destination.connectionId, executionId);
      if (sent) updateForTab(destination.tabId, (previous) => {
        if (previous.diagnosticPlan?.id !== plan.id) return previous;
        return { ...previous, diagnosticPlan: { ...previous.diagnosticPlan, steps: previous.diagnosticPlan.steps.map((entry) => entry.id === step.id && entry.status === "sending" ? { ...entry, status: "awaiting" } : entry) } };
      });
      else updateStep({ status: "proposed", executionId: null });
    } catch (caught) {
      updateStep({ status: "proposed" });
      updateForTab(destination.tabId, (previous) => ({ ...previous, error: String(caught) }));
    } finally { setSendingTurnId(null); }
  };

  const useDraft = async () => {
    if (!draft?.target || !draft.text.trim() || sendingTurnId || busy) return;
    const snapshot = draft;
    const destination = draft.target;
    setSendingTurnId(snapshot.turnId);
    updateCurrent((previous) => ({ ...previous, error: null }));
    try {
      const sent = await onSendDraft(snapshot.text, destination.tabId, destination.connectionVersion, destination.connectionId);
      if (sent) updateForTab(destination.tabId, (previous) => ({
        ...previous,
        draft: null,
        lastExecution: snapshot,
        notice: "",
      }));
    } catch (caught) {
      updateForTab(destination.tabId, (previous) => ({ ...previous, error: String(caught) }));
    } finally {
      setSendingTurnId(null);
    }
  };

  const configured = !!settings?.enabled && !!settings.baseUrl && !!settings.model;
  const canSendDraft = !!draft?.target && !!target?.connected && sameAiTarget(draft.target, target) && turns.some((turn) => turn.id === draft.turnId && turn.status === "complete");

  return (
    <aside className="ai-panel" aria-label="AI 助手">
      <header className="ai-header"><h2><Bot size={16} />AI 助手</h2><div className="ai-actions"><button className="icon-button" aria-label="打开全局 AI 服务设置" title="设置 · AI 服务" disabled={!onOpenSettings} onClick={onOpenSettings}><Settings2 size={15} /></button><button className="icon-button" aria-label="关闭 AI 助手" title="关闭 AI 助手" onClick={onClose}><X size={16} /></button></div></header>
      <div className="ai-target"><span>当前会话</span><strong title={target?.name}>{target?.name ?? "未选择会话 · 独立临时对话"}</strong><span>{target?.connected ? "已连接" : "未连接"}</span></div>
      <div className="ai-service-summary"><div><strong>{loadingSettings ? "正在读取 AI 配置…" : configured ? settings.model : "AI 尚未启用"}</strong><span>{configured ? `${aiServiceHost(settings.baseUrl)} · ${settings.hasApiKey ? "密钥已保存" : "无密钥连接"}` : "服务配置在全局设置中统一管理"}</span></div><button type="button" className="ai-text-button" disabled={!onOpenSettings} onClick={onOpenSettings}>服务设置</button></div>
      <div className="ai-scroll">
        <AiConversationArchives archives={conversation.archives} onError={showError} />
        {executions.length > 0 && <details className="ai-execution-history"><summary>本标签的执行记录 · {executions.length}</summary><TerminalExecutionList records={executions} connectionId={target?.connectionId ?? null} onAnalyze={onAnalyzeExecution} onSuggestNext={onSuggestNextExecution} /></details>}
        {!configured && !loadingSettings && <div className="ai-empty"><Bot size={24} /><h3>准备好你的终端助手</h3><p>生成命令草稿、看懂终端输出，或一起排查报错。</p><button className="primary-button" disabled={!onOpenSettings} onClick={onOpenSettings}>前往设置 · AI 服务</button><p className="ai-note">启用后也只会发送你预览并确认的内容。</p></div>}
        {!settings && !loadingSettings && <button className="secondary-button ai-full" onClick={loadSettings}><RefreshCw size={14} />重新读取 AI 配置</button>}
        {configured && <div className={`ai-layout ${turns.length ? "with-turns" : "new-conversation"}`}>
          <div className="ai-conversation-tools"><span>{turns.length ? `${turns.length} 轮 · 仅当前标签` : "新对话 · 不自动读取终端"}</span><button className="secondary-button" disabled={!!sendingTurnId || (!turns.length && !prompt && !hasContext)} onClick={() => { startNew(); setServiceNotice(""); }}><Plus size={13} />新对话</button></div>
          {serviceNotice && <p className="ai-note" role="status">{serviceNotice}</p>}
          <div className="ai-message-area" ref={messageAreaRef}>
          <AiConversationView turns={turns} onError={showError} onUseCommand={stageCommand} commandBusy={busy || !!sendingTurnId} scrollContainerRef={messageAreaRef} onReviewPlan={(turn, steps) => updateCurrent((previous) => previous.diagnosticPlan?.steps.some((step) => step.status === "sending" || step.status === "awaiting") ? { ...previous, notice: "当前步骤仍在等待终端结果，请先检查这一步。" } : { ...previous, diagnosticPlan: createDiagnosticPlan(turn.id, turn.target, steps), error: null })} />
          {diagnosticPlan && <AiDiagnosticPlanView plan={diagnosticPlan} target={target} busy={busy || !!sendingTurnId} onChange={(plan) => updateCurrent((previous) => ({ ...previous, diagnosticPlan: plan }))} onExecute={(step) => void executeStep(step)} onAttachResult={(step) => {
            const result = step.result && executionAiContext(step.result);
            if (!result) return;
            const item = createContextItem("execution", result, diagnosticPlan.target, step.title);
            updateCurrent((previous) => ({ ...previous, mode: "diagnose", prompt: `请结合“${step.title}”的实际结果更新判断，指出哪些假设已得到支持、哪些仍需检查。`, contextItems: previous.contextItems.length < MAX_CONTEXT_ITEMS ? [...previous.contextItems, item] : previous.contextItems, prepared: null, notice: previous.contextItems.length >= MAX_CONTEXT_ITEMS ? "上下文已达 6 项，请先移除一项后重新附加。" : "本步结果已附加，预览后可发送。" }));
          }} />}
          {busy && <button className="secondary-button ai-full ai-stop" onClick={stop}><Square size={13} />停止生成</button>}
          {draft && <section className="ai-draft"><label className="ai-label" htmlFor="ai-command-draft">可编辑的命令草稿</label><div className="ai-draft-target"><span>发送目标</span><strong>{draft.target?.name ?? "未绑定终端"}</strong></div><textarea ref={draftInputRef} id="ai-command-draft" rows={4} value={draft.text} disabled={!!sendingTurnId || busy} spellCheck={false} onChange={(event) => { const text = event.target.value; updateCurrent((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, text } : null })); }} /><p className="ai-note">还需在下一步确认执行。仅发送到生成时关联的会话，不使用广播。</p>{!canSendDraft && <p className="ai-warning">{draft.target ? "这份草稿关联的连接已断开或重新建立。请在当前连接重新生成，不会复用旧草稿执行。" : "这份草稿未绑定终端。可以复制参考，或打开会话后重新生成。"}</p>}<button className="secondary-button ai-full" disabled={!canSendDraft || !draft.text.trim() || !!sendingTurnId || busy} onClick={() => void useDraft()}>{sendingTurnId === draft.turnId ? "处理中…" : `检查并发送到 ${draft.target?.name ?? "此会话"}…`}</button></section>}
          {lastExecution && !executions.some((record) => record.source === "ai" && record.connectionId === lastExecution.target?.connectionId) && <section className="ai-execution-feedback" aria-label="检查命令结果">
            <div><Check size={14} /><strong>命令已发送到 {lastExecution.target?.name}</strong></div>
            <code>{lastExecution.text}</code>
            <p>等待终端返回结果后，附加输出，让 AI 判断下一步。</p>
            <button type="button" className="secondary-button ai-full" disabled={busy || !target?.connected || !sameAiTarget(lastExecution.target, target) || !onRequestRecentOutput} onClick={() => {
              updateCurrent((previous) => ({ ...previous, mode: "diagnose", prompt: `我已在终端执行以下命令，请结合这次附加的实际输出判断结果，说明已确认的结论和下一步检查：\n\`\`\`shell\n${lastExecution.text}\n\`\`\``, prepared: null }));
              onRequestRecentOutput?.("diagnose");
            }}>附加最近输出，继续诊断<ArrowRight size={13} /></button>
          </section>}
          </div>
          <div className="ai-compose-area">
          <div className="ai-composer-heading"><h3>{turns.length ? "继续追问" : "开始分析"}</h3>{turns.length > 0 && <span className="ai-note">将结合最近的已完成对话</span>}</div>
          <AiTaskComposer mode={mode} prompt={prompt} context={context} contextLabel="手动补充" hasAttachedContext={hasContext} canClearContext={!!context} canReadSelection={!!target} busy={busy} followUp={turns.length > 0} onModeChange={(next) => updateCurrent((previous) => ({ ...previous, mode: next, prepared: null }))} onPromptChange={(text) => updateCurrent((previous) => ({ ...previous, prompt: text, prepared: null }))} onContextChange={(text) => updateCurrent((previous) => ({ ...previous, context: text, contextSource: "manual", contextTarget: null, prepared: null }))} onClearContext={() => updateCurrent((previous) => ({ ...previous, context: "", contextSource: "manual", contextTarget: null, prepared: null }))} onRequestSelection={onRequestSelection} onRequestRecentOutput={onRequestRecentOutput} onPreview={prepare} />
          <AiContextInventory items={contextItems} target={target} busy={busy} onChange={(items) => updateCurrent((previous) => ({ ...previous, contextItems: items, prepared: null }))} onAddFile={addFileContext} />
          {staleContext && <p className="ai-warning">此上下文来自重新连接之前。请重新附加输出，或清空后为当前连接发起新请求。</p>}
          {notice && <p className="ai-note" role="status">{notice}</p>}
          {!prepared && <div className="ai-send-actions"><button className="primary-button ai-full" disabled={busy || loadingSettings || staleContext || (!prompt.trim() && !hasContext)} onClick={prepare}>{busy ? "正在分析…" : "预览并发送"}<span className="ai-key-hint">Ctrl / ⌘ ↵</span></button></div>}
          {prepared && <section className="ai-preview" aria-label="发送前确认"><h3>检查后发送给 AI</h3><p className="ai-note">{prepared.notice}</p><dl className="ai-preview-meta"><div><dt>任务</dt><dd>{AI_TASKS[prepared.mode].label}</dd></div><div><dt>关联会话</dt><dd>{prepared.target?.name ?? "未绑定终端，仅生成建议"}</dd></div><div><dt>AI 服务</dt><dd>{aiServiceHost(prepared.baseUrl)} · {prepared.model}</dd></div></dl><pre>{prepared.prompt || "（无补充问题）"}{prepared.context ? `\n\n上下文：\n${prepared.context}` : "\n\n（不附加新终端内容）"}</pre><details className="ai-history-preview"><summary>将发送的历史：{prepared.includedTurns} 轮</summary><p className="ai-note">仅携带此标签最近 6 轮已完成对话，合计不超过 32 KiB。停止或失败的回复不会发送。{prepared.omittedTurns > 0 ? `本次省略了 ${prepared.omittedTurns} 轮。` : ""}{prepared.truncatedMessages > 0 ? `${prepared.truncatedMessages} 条过长历史已截短。` : ""}</p>{prepared.history.length ? prepared.history.map((message, index) => <div key={index}><strong>{message.role === "user" ? "你" : "AI"}</strong><pre>{message.content}</pre></div>) : <p className="ai-note">本次不发送历史。</p>}</details>{stalePreview && <p className="ai-warning">连接已变化，请返回编辑并重新预览。</p>}<div className="ai-actions"><button className="secondary-button" disabled={busy} onClick={() => updateCurrent((previous) => ({ ...previous, prepared: null }))}>返回编辑</button><button className="primary-button" disabled={busy || loadingSettings || stalePreview} onClick={() => { setServiceNotice(""); void submit(prepared); }}>确认发送给 AI</button></div></section>}
          </div>
        </div>}
        {(settingsError || error) && <p className="ai-error" role="alert">{settingsError || error}</p>}
      </div>
      <footer className="ai-footer">发送前可预览历史 · 执行命令需另行确认</footer>
    </aside>
  );
}
