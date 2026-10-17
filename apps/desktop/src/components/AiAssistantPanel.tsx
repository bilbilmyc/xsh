import { useEffect, useRef, useState } from "react";
import { Bot, Plus, RefreshCw, Settings2, Square, X } from "lucide-react";
import { aiApi, type AiSettings } from "../ai-api";
import { buildAiHistory } from "../ai-conversation";
import { AI_PROMPT_BYTES, prepareAiText } from "../ai-context";
import { AI_SETTINGS_CHANGED_EVENT, AI_TASKS, aiServiceHost } from "../ai-ui";
import { AiConversationView } from "./AiConversationView";
import { AiTaskComposer } from "./AiTaskComposer";
import { sameAiTarget, useAiConversation } from "./useAiConversation";
import "./AiAssistantPanel.css";

export interface AiTarget {
  tabId: string;
  name: string;
  connected: boolean;
  connectionVersion: number;
  connectionId: string | null;
}

export interface AiContextRequest {
  id: number;
  tabId: string;
  sessionName: string;
  connectionVersion: number;
  connectionId: string | null;
  mode: "explain" | "diagnose";
  text: string;
  source?: "selection" | "recent-output";
}

interface AiAssistantPanelProps {
  target: AiTarget | null;
  openTabIds: string[];
  contextRequest: AiContextRequest | null;
  onContextConsumed: (requestId: number) => void;
  onOpenSettings?: () => void;
  onRequestSelection?: (mode: "explain" | "diagnose") => void;
  onRequestRecentOutput?: (mode: "explain" | "diagnose") => void;
  onClose: () => void;
  onSendDraft: (command: string, tabId: string, connectionVersion: number, connectionId: string | null) => Promise<void>;
}

export function AiAssistantPanel({ target, openTabIds, contextRequest, onContextConsumed, onOpenSettings, onRequestSelection, onRequestRecentOutput, onClose, onSendDraft }: AiAssistantPanelProps) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState("");
  const [sendingTurnId, setSendingTurnId] = useState<string | null>(null);
  const settingsEpoch = useRef(0);
  const { conversation, busy, updateCurrent, updateForTab, stop, resetAll, startNew, submit } = useAiConversation(target, openTabIds);
  const { mode, prompt, context, contextSource, contextTarget, turns, prepared, draft, notice, error } = conversation;

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
      resetAll();
      setServiceNotice("AI 服务配置已更新，旧对话已清除。新请求不会向新服务发送旧历史。");
      loadSettings();
    };
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
    return () => { settingsEpoch.current += 1; window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, refresh); };
  }, [resetAll]);

  useEffect(() => {
    if (!contextRequest) return;
    stop();
    const safeContext = prepareAiText(contextRequest.text);
    const sourceName = contextRequest.source === "recent-output" ? "最近50行输出" : "选区";
    updateForTab(contextRequest.tabId, (previous) => ({
      ...previous,
      mode: contextRequest.mode,
      context: safeContext.text,
      contextSource: contextRequest.source ?? "selection",
      contextTarget: { tabId: contextRequest.tabId, name: contextRequest.sessionName, connectionVersion: contextRequest.connectionVersion, connectionId: contextRequest.connectionId },
      prepared: null,
      error: null,
      notice: safeContext.truncated ? `${sourceName}已截取至 16 KiB，请检查预览内容。` : safeContext.redacted ? `${sourceName}中的常见密钥和密码已隐藏，请继续检查。` : `已载入${sourceName}，请检查后发送。`,
    }));
    onContextConsumed(contextRequest.id);
  }, [contextRequest?.id]);

  const contextLabel = context ? `${contextSource === "selection" ? "终端选区" : contextSource === "recent-output" ? "最近50行输出" : "手动输入"}${contextTarget ? ` · ${contextTarget.name}` : ""}` : "未附加终端内容";
  const staleContext = !!context && !!contextTarget && !sameAiTarget(contextTarget, target);
  const stalePreview = !!prepared && !sameAiTarget(prepared.target, target);

  const prepare = () => {
    if (!settings || loadingSettings || staleContext) return;
    const safePrompt = prepareAiText(prompt, AI_PROMPT_BYTES);
    const safeContext = prepareAiText(context);
    const history = buildAiHistory(turns);
    updateCurrent((previous) => ({ ...previous, error: null, prepared: {
      mode,
      prompt: safePrompt.text,
      context: safeContext.text,
      contextLabel,
      target: target ? { tabId: target.tabId, name: target.name, connectionVersion: target.connectionVersion, connectionId: target.connectionId } : null,
      notice: safePrompt.truncated || safeContext.truncated ? "已按 4 KiB 问题 / 16 KiB 上下文上限截取。" : "已隐藏常见凭据；请人工确认没有其他敏感信息。",
      model: settings.model,
      baseUrl: settings.baseUrl,
      history: history.history,
      includedTurns: history.includedTurns,
      omittedTurns: history.omittedTurns,
      truncatedMessages: history.truncatedMessages,
    } }));
  };

  const useDraft = async () => {
    if (!draft?.target || !draft.text.trim() || sendingTurnId || busy) return;
    const snapshot = draft;
    const destination = draft.target;
    setSendingTurnId(snapshot.turnId);
    updateCurrent((previous) => ({ ...previous, error: null }));
    try {
      await onSendDraft(snapshot.text, destination.tabId, destination.connectionVersion, destination.connectionId);
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
        {!configured && !loadingSettings && <div className="ai-empty"><Bot size={24} /><h3>准备好你的终端助手</h3><p>生成命令草稿、看懂终端输出，或一起排查报错。</p><button className="primary-button" disabled={!onOpenSettings} onClick={onOpenSettings}>前往设置 · AI 服务</button><p className="ai-note">启用后也只会发送你预览并确认的内容。</p></div>}
        {!settings && !loadingSettings && <button className="secondary-button ai-full" onClick={loadSettings}><RefreshCw size={14} />重新读取 AI 配置</button>}
        {configured && <>
          <div className="ai-conversation-tools"><span>{turns.length ? `${turns.length} 轮 · 仅当前标签` : "新对话 · 不自动读取终端"}</span><button className="secondary-button" disabled={!turns.length && !prompt && !context} onClick={() => { startNew(); setServiceNotice(""); }}><Plus size={13} />新对话</button></div>
          {serviceNotice && <p className="ai-note" role="status">{serviceNotice}</p>}
          <AiConversationView turns={turns} onError={(message) => updateCurrent((previous) => ({ ...previous, error: message }))} />
          {busy && <button className="secondary-button ai-full ai-stop" onClick={stop}><Square size={13} />停止生成</button>}
          {draft && <section className="ai-draft"><label className="ai-label" htmlFor="ai-command-draft">可编辑的命令草稿</label><div className="ai-draft-target"><span>发送目标</span><strong>{draft.target?.name ?? "未绑定终端"}</strong></div><textarea id="ai-command-draft" rows={4} value={draft.text} disabled={!!sendingTurnId || busy} spellCheck={false} onChange={(event) => { const text = event.target.value; updateCurrent((previous) => ({ ...previous, draft: previous.draft ? { ...previous.draft, text } : null })); }} /><p className="ai-note">还需在下一步确认执行。仅发送到生成时关联的会话，不使用广播。</p>{!canSendDraft && <p className="ai-warning">{draft.target ? "这份草稿关联的连接已断开或重新建立。请在当前连接重新生成，不会复用旧草稿执行。" : "这份草稿未绑定终端。可以复制参考，或打开会话后重新生成。"}</p>}<button className="secondary-button ai-full" disabled={!canSendDraft || !draft.text.trim() || !!sendingTurnId || busy} onClick={() => void useDraft()}>{sendingTurnId === draft.turnId ? "处理中…" : `检查并发送到 ${draft.target?.name ?? "此会话"}…`}</button></section>}
          <div className="ai-composer-heading"><h3>{turns.length ? "继续追问" : "开始分析"}</h3>{turns.length > 0 && <p className="ai-note">可围绕已完成的回复继续提问。需要新输出时，请手动附加；发送前仍会预览。</p>}</div>
          <AiTaskComposer mode={mode} prompt={prompt} context={context} contextLabel={contextLabel} canClearContext={!!context} canReadSelection={!!target} busy={busy} followUp={turns.length > 0} onModeChange={(next) => updateCurrent((previous) => ({ ...previous, mode: next, prepared: null }))} onPromptChange={(text) => updateCurrent((previous) => ({ ...previous, prompt: text, prepared: null }))} onContextChange={(text) => updateCurrent((previous) => ({ ...previous, context: text, contextSource: !previous.context || !text ? "manual" : previous.contextSource, contextTarget: !text ? null : previous.contextTarget ?? (target ? { tabId: target.tabId, name: target.name, connectionVersion: target.connectionVersion, connectionId: target.connectionId } : null), prepared: null }))} onClearContext={() => updateCurrent((previous) => ({ ...previous, context: "", contextSource: "manual", contextTarget: null, prepared: null }))} onRequestSelection={onRequestSelection} onRequestRecentOutput={onRequestRecentOutput} />
          {staleContext && <p className="ai-warning">此上下文来自重新连接之前。请重新附加输出，或清空后为当前连接发起新请求。</p>}
          {notice && <p className="ai-note" role="status">{notice}</p>}
          {!prepared && <button className="primary-button ai-full" disabled={busy || loadingSettings || staleContext || (!prompt.trim() && !context.trim())} onClick={prepare}>{busy ? "正在流式输出…" : "预览将发送给 AI 的内容"}</button>}
          {prepared && <section className="ai-preview" aria-label="发送前确认"><h3>检查后发送给 AI</h3><p className="ai-note">{prepared.notice}</p><dl className="ai-preview-meta"><div><dt>任务</dt><dd>{AI_TASKS[prepared.mode].label}</dd></div><div><dt>关联会话</dt><dd>{prepared.target?.name ?? "未绑定终端，仅生成建议"}</dd></div><div><dt>AI 服务</dt><dd>{aiServiceHost(prepared.baseUrl)} · {prepared.model}</dd></div></dl><pre>{prepared.prompt || "（无补充问题）"}{prepared.context ? `\n\n上下文：\n${prepared.context}` : "\n\n（不附加新终端内容）"}</pre><details className="ai-history-preview"><summary>将发送的历史：{prepared.includedTurns} 轮</summary><p className="ai-note">仅携带此标签最近 6 轮已完成对话，合计不超过 32 KiB。停止或失败的回复不会发送。{prepared.omittedTurns > 0 ? `本次省略了 ${prepared.omittedTurns} 轮。` : ""}{prepared.truncatedMessages > 0 ? `${prepared.truncatedMessages} 条过长历史已截短。` : ""}</p>{prepared.history.length ? prepared.history.map((message, index) => <div key={index}><strong>{message.role === "user" ? "你" : "AI"}</strong><pre>{message.content}</pre></div>) : <p className="ai-note">本次不发送历史。</p>}</details>{stalePreview && <p className="ai-warning">连接已变化，请返回编辑并重新预览。</p>}<div className="ai-actions"><button className="secondary-button" disabled={busy} onClick={() => updateCurrent((previous) => ({ ...previous, prepared: null }))}>返回编辑</button><button className="primary-button" disabled={busy || loadingSettings || stalePreview} onClick={() => { setServiceNotice(""); void submit(prepared); }}>确认发送给 AI</button></div></section>}
        </>}
        {(settingsError || error) && <p className="ai-error" role="alert">{settingsError || error}</p>}
      </div>
      <footer className="ai-footer">发送前可预览历史 · 执行命令需另行确认</footer>
    </aside>
  );
}
