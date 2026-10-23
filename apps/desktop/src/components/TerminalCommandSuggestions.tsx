import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { ArrowDownToLine, Check, Copy, History, LoaderCircle, Send, Sparkles, Square, TerminalSquare, X } from "lucide-react";
import { aiApi } from "../ai-api";
import { AI_PROMPT_BYTES, byteLength, prepareAiText } from "../ai-context";
import { loadCommandHistory } from "../command-history";
import { writeClipboardText } from "../clipboard";
import { IS_MACOS } from "../platform";
import {
  historySuggestions,
  parseAiSuggestions,
  sameTerminalPrompt,
  shellSetupPromptState,
  SHELL_INTEGRATION_COMMAND,
  type TerminalPromptSnapshot,
  type TerminalSuggestion,
} from "../terminal-completion";
import "./TerminalCommandSuggestions.css";

export interface TerminalCommandSuggestionsHandle {
  open(options?: { goal?: string; output?: string }): void;
  accept(): boolean;
  dismiss(): boolean;
}

interface Props {
  ref?: Ref<TerminalCommandSuggestionsHandle>;
  sessionId: string;
  sessionName: string;
  shortcutsEnabled: boolean;
  snapshot: TerminalPromptSnapshot;
  style: CSSProperties;
  getSnapshot(): TerminalPromptSnapshot;
  getContext(): string;
  onAccept(command: string, owner: TerminalPromptSnapshot): boolean;
  onSetup(owner: TerminalPromptSnapshot, isCurrent: () => boolean): Promise<boolean>;
  onFocusTerminal(): void;
}

interface ShellSetupAttempt {
  owner: TerminalPromptSnapshot;
  suggestions: TerminalSuggestion[];
  sent: boolean;
}

/**
 * Scoped to one live terminal. The shell remains the input editor; this popup
 * only appends a validated suffix, and never sends an execution key.
 */
export function TerminalCommandSuggestions({
  ref, sessionId, sessionName, shortcutsEnabled, snapshot, style, getSnapshot, getContext, onAccept, onSetup, onFocusTerminal,
}: Props) {
  const [manual, setManual] = useState(false);
  const [goal, setGoal] = useState("");
  const [includeOutput, setIncludeOutput] = useState(false);
  const [contextPreview, setContextPreview] = useState("");
  const [executionContext, setExecutionContext] = useState(false);
  const [history, setHistory] = useState(loadCommandHistory);
  const [result, setResult] = useState<{ owner: TerminalPromptSnapshot; suggestions: TerminalSuggestion[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [setupPhase, setSetupPhase] = useState<"idle" | "confirming" | "waiting" | "timeout" | "success">("idle");
  const setupRef = useRef<ShellSetupAttempt | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<{ id: string; owner: TerminalPromptSnapshot } | null>(null);
  const liveRef = useRef({ getSnapshot });
  liveRef.current = { getSnapshot };
  const prefix = snapshot.command ?? "";
  const local = snapshot.phase === "prompt" ? historySuggestions(history, sessionId, prefix) : [];
  const setup = setupRef.current?.owner.connectionId === snapshot.connectionId ? setupRef.current : null;
  const setupBusy = setupPhase === "confirming" || setupPhase === "waiting";
  const suggestions = setup ? setup.suggestions : result && sameTerminalPrompt(result.owner, snapshot) ? result.suggestions : local;
  const owner = result && sameTerminalPrompt(result.owner, snapshot) ? result.owner : snapshot;
  const dismissKey = `${snapshot.connectionId}:${snapshot.promptId}:${prefix}`;
  const shown = manual || (suggestions.length > 0 && dismissed !== dismissKey);

  const cancel = () => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active) void aiApi.cancel(active.id).catch(() => undefined);
    setLoading(false);
  };

  const settleSetup = (attempt: ShellSetupAttempt, current: TerminalPromptSnapshot) => {
    const state = shellSetupPromptState(attempt.owner, current);
    if (state === "changed") {
      setupRef.current = null;
      setSetupPhase("idle");
      setResult(null);
      setError("终端连接或输入已变化，已停止启用。请在当前终端重新请求建议。");
    } else if (attempt.sent && state === "ready") {
      setupRef.current = null;
      setSetupPhase("success");
      setResult(attempt.suggestions.length ? { owner: current, suggestions: attempt.suggestions } : null);
      setManual(true);
      setError("");
    }
  };

  useEffect(() => {
    const active = activeRef.current;
    if (active && !sameTerminalPrompt(active.owner, snapshot)) {
      activeRef.current = null;
      void aiApi.cancel(active.id).catch(() => undefined);
      setLoading(false);
    }
    const attempt = setupRef.current;
    if (attempt) {
      settleSetup(attempt, snapshot);
      // Keep the original suggestions visible but disabled while our fixed
      // initializer runs. Only its first confirmed blank prompt can rebind them.
      return;
    }
    setResult((current) => current && sameTerminalPrompt(current.owner, snapshot) ? current : null);
    setError("");
    setSelected(0);
    if (snapshot.phase === "running") setManual(false);
  }, [snapshot.connectionId, snapshot.promptId, snapshot.revision, snapshot.phase, snapshot.ready]);

  useEffect(() => {
    if (setupPhase !== "waiting") return;
    const attempt = setupRef.current;
    const timer = window.setTimeout(() => {
      if (setupRef.current === attempt) setSetupPhase("timeout");
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [setupPhase]);

  useEffect(() => {
    const refresh = () => setHistory(loadCommandHistory());
    window.addEventListener("xsh:command-history-changed", refresh);
    return () => window.removeEventListener("xsh:command-history-changed", refresh);
  }, []);

  useEffect(() => {
    setIncludeOutput(false);
    setContextPreview("");
    setExecutionContext(false);
    setGoal("");
    setupRef.current = null;
    setSetupPhase("idle");
  }, [snapshot.connectionId]);

  useEffect(() => () => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active) void aiApi.cancel(active.id).catch(() => undefined);
    setupRef.current = null;
  }, []);

  useEffect(() => {
    if (manual) inputRef.current?.focus();
  }, [manual]);

  const dismiss = () => {
    if (!shown) return false;
    cancel();
    setupRef.current = null;
    setSetupPhase("idle");
    setManual(false);
    setDismissed(dismissKey);
    onFocusTerminal();
    return true;
  };
  const accept = () => {
    const suggestion = suggestions[selected] ?? suggestions[0];
    if (!shown || !suggestion) return false;
    if (setupRef.current) return true;
    // Consume the shortcut even if the prompt changed. Letting Alt+Enter fall
    // through could execute the user's existing command instead.
    if (!onAccept(suggestion.command, owner)) return true;
    cancel();
    setManual(false);
    setResult(null);
    setGoal("");
    setDismissed(dismissKey);
    return true;
  };
  const open = (options?: { goal?: string; output?: string }) => {
    if (options) {
      cancel();
      setupRef.current = null;
      setSetupPhase("idle");
      setResult(null);
      setGoal(options.goal ?? "");
      setIncludeOutput(options.output !== undefined);
      setExecutionContext(options.output !== undefined);
      setContextPreview(options.output !== undefined ? prepareContext(options.output) : "");
    }
    setHistory(loadCommandHistory());
    setDismissed(null);
    setManual(true);
    inputRef.current?.focus();
  };
  useImperativeHandle(ref, () => ({ open, accept, dismiss }));

  const copy = async (text: string) => {
    try {
      await writeClipboardText(text);
      setCopied(text);
    } catch {
      setError("复制失败，请重试。");
    }
  };

  const prepareContext = (output?: string) => prepareAiText(`会话：${sessionName}\n系统、Shell 类型及当前目录尚未确认，不推断发行版或路径。${output !== undefined ? `\n附加的终端结果快照：\n${output}` : ""}`).text;

  const request = async () => {
    if (setupBusy) return;
    setupRef.current = null;
    setSetupPhase("idle");
    const target = getSnapshot();
    if (!target.connectionId) { setError("连接服务器后再请求命令建议。"); return; }
    if (target.integrated && !target.ready) { setError("请回到 Shell 提示符末尾。若已用方向键或 Tab 编辑，可用 Ctrl+U 清空后重新输入。"); return; }
    const commandPrefix = target.command ?? "";
    if (!goal.trim() && !commandPrefix.trim()) { inputRef.current?.focus(); return; }
    const preparedPrefix = prepareAiText(commandPrefix, AI_PROMPT_BYTES);
    if (preparedPrefix.redacted || preparedPrefix.truncated) { setError("当前命令含敏感内容或过长，请先清空，再用不含凭据的描述请求建议。"); return; }
    const preparedGoal = prepareAiText(goal, 2048);
    if (preparedGoal.truncated) { setError("目标描述过长，请缩短后再请求建议。"); return; }
    const prompt = JSON.stringify({ goal: preparedGoal.text, prefix: commandPrefix });
    if (byteLength(prompt) > AI_PROMPT_BYTES) { setError("当前命令和目标合计过长，请缩短后再请求补全。"); return; }
    cancel();
    setResult(null);
    setError("");
    const active = { id: crypto.randomUUID(), owner: target };
    activeRef.current = active;
    setLoading(true);
    const current = () => activeRef.current === active && sameTerminalPrompt(target, liveRef.current.getSnapshot());
    try {
      const settings = await aiApi.getSettings();
      if (!current()) return;
      if (!settings.enabled || !settings.model.trim()) throw new Error("请先在设置 → AI 中启用模型并保存配置。");
      const context = includeOutput ? contextPreview : prepareContext();
      const text = await aiApi.stream({
        mode: "complete",
        prompt,
        context,
      }, active.id, () => undefined);
      if (!current()) return;
      setResult({ owner: target, suggestions: parseAiSuggestions(text, commandPrefix) });
      setSelected(0);
    } catch (caught) {
      if (current()) setError(String(caught).replace(/^Error:\s*/, ""));
    } finally {
      if (activeRef.current === active) {
        activeRef.current = null;
        setLoading(false);
      }
    }
  };

  const enableShell = async () => {
    if (setupBusy) return;
    const target = getSnapshot();
    if (!target.connectionId) { setError("连接服务器后再启用 Shell 集成。"); return; }
    const attempt: ShellSetupAttempt = {
      owner: target,
      suggestions: setupRef.current?.owner.connectionId === target.connectionId
        ? setupRef.current.suggestions
        : sameTerminalPrompt(owner, target) ? suggestions : [],
      sent: false,
    };
    cancel();
    setError("");
    setupRef.current = attempt;
    setSetupPhase("confirming");
    try {
      const started = await onSetup(target, () => setupRef.current === attempt);
      if (setupRef.current !== attempt) return;
      if (!started) {
        setupRef.current = null;
        setSetupPhase("idle");
        return;
      }
      attempt.sent = true;
      settleSetup(attempt, getSnapshot());
      if (setupRef.current === attempt) setSetupPhase("waiting");
    } catch (caught) {
      if (setupRef.current !== attempt) return;
      setSetupPhase("timeout");
      setError(String(caught).replace(/^Error:\s*/, ""));
    }
  };

  if (!shown) return null;
  const disabledReason = setup ? setupPhase === "confirming" ? "请确认当前终端可启用集成" : setupPhase === "timeout" ? "尚未确认 Shell 集成，请重试或查看手动启用说明" : "正在等待 Shell 确认"
    : !snapshot.connectionId ? "终端未连接"
    : !snapshot.integrated ? "启用 Shell 集成后可填入"
      : snapshot.phase !== "prompt" ? "等待 Shell 提示符"
        : snapshot.command === null ? "清空命令行后可继续补全"
          : !snapshot.ready ? "等待终端回显" : "";
  return (
    <section className="terminal-command-suggestions" style={style} aria-label="终端命令建议">
      <header>
        <span><Sparkles size={13} /><strong>命令建议</strong><small title={sessionName}>{sessionName}</small></span>
        <button type="button" className="terminal-suggestion-icon" onClick={dismiss} aria-label="关闭命令建议" title={shortcutsEnabled ? "关闭 · Esc" : "关闭命令建议"}><X size={13} /></button>
      </header>
      {manual ? (
        <form onSubmit={(event) => { event.preventDefault(); void request(); }}>
          <div className="terminal-suggestion-goal">
            <span aria-hidden="true">›</span>
            <input
              ref={inputRef}
              aria-label="描述命令目标"
              placeholder={prefix.trim() ? "补全当前命令，或补充你想做什么…" : "用一句话描述，例如：找出占用 8080 端口的进程"}
              maxLength={1200}
              value={goal}
              disabled={setupBusy}
              onChange={(event) => { cancel(); setupRef.current = null; setSetupPhase("idle"); setResult(null); setError(""); setGoal(event.target.value); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                  if (event.key === "Enter") event.preventDefault();
                  return;
                }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
                else if (event.altKey && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); accept(); }
                else if (suggestions.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  setSelected((value) => (value + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                }
              }}
            />
            {loading
              ? <button type="button" onClick={cancel} aria-label="停止生成命令建议"><Square size={12} /></button>
              : <button type="submit" disabled={setupBusy || !snapshot.connectionId || (!goal.trim() && !prefix.trim())} title="请求 AI 命令建议 · Enter" aria-label="请求 AI 命令建议"><Send size={14} /></button>}
          </div>
          {prefix && <div className="terminal-suggestion-prefix"><span>接着补全</span><code>{prefix}</code></div>}
          <div className="terminal-suggestion-context">
            <label><input type="checkbox" checked={includeOutput} disabled={setupBusy} onChange={(event) => { cancel(); setupRef.current = null; setSetupPhase("idle"); setResult(null); setIncludeOutput(event.target.checked); setExecutionContext(false); setContextPreview(event.target.checked ? prepareContext(getContext()) : ""); }} />{executionContext ? "附加这次命令结果" : "附加最近输出"}</label>
            {includeOutput && !executionContext && <button type="button" className="terminal-suggestion-refresh-context" disabled={setupBusy} onClick={() => { cancel(); setupRef.current = null; setSetupPhase("idle"); setResult(null); setContextPreview(prepareContext(getContext())); }}>更新输出快照</button>}
            <span>按 Enter 发送到已配置的 AI</span>
          </div>
          {contextPreview && <details className="terminal-suggestion-preview"><summary>查看发送的上下文（已脱敏）</summary><pre>{contextPreview}</pre></details>}
        </form>
      ) : (
        <button type="button" className="terminal-suggestion-ask" onClick={() => open()}><Sparkles size={13} />用 AI 补全 / 描述目标{shortcutsEnabled && <kbd>{IS_MACOS ? "⌘⇧Space" : "Ctrl+Shift+Space"}</kbd>}</button>
      )}
      {loading && <div className="terminal-suggestion-status" role="status"><LoaderCircle size={13} className="terminal-suggestion-spinner" />正在生成建议，可随时返回终端输入…</div>}
      {error && <div className="terminal-suggestion-error" role="alert">{error}</div>}
      {!loading && suggestions.length > 0 && (
        <div className="terminal-suggestion-list" role="list" aria-label="可用命令">
          {suggestions.map((suggestion, index) => (
            <div className={`terminal-suggestion-item ${index === selected ? "selected" : ""}`} key={suggestion.command} role="listitem" onPointerEnter={() => setSelected(index)}>
              <span className="terminal-suggestion-source" title={suggestion.source === "ai" ? "AI 建议" : "本机历史"}>{suggestion.source === "ai" ? <Sparkles size={13} /> : <History size={13} />}</span>
              <div className="terminal-suggestion-command">
                <code>{prefix && suggestion.command.startsWith(prefix) ? <><span>{prefix}</span><b>{suggestion.command.slice(prefix.length)}</b></> : suggestion.command}</code>
                <small>{suggestion.description}</small>
              </div>
              <button type="button" className="terminal-suggestion-icon" onClick={() => void copy(suggestion.command)} aria-label={`复制命令 ${index + 1}`} title="复制命令">{copied === suggestion.command ? <Check size={13} /> : <Copy size={13} />}</button>
              <button type="button" className="terminal-suggestion-fill" disabled={!!disabledReason} title={disabledReason || "填入当前命令行，回车执行"} onClick={() => { if (onAccept(suggestion.command, owner)) { cancel(); setManual(false); setResult(null); setGoal(""); setDismissed(dismissKey); } }} aria-label={`填入命令 ${index + 1}`}><ArrowDownToLine size={13} /><span>填入</span></button>
            </div>
          ))}
        </div>
      )}
      {manual && (
        <>
          {(!snapshot.integrated || setup || setupPhase === "success") && (
            <div className={`terminal-suggestion-integration${setupPhase === "success" ? " enabled" : ""}`}>
              <span className="terminal-suggestion-integration-icon" aria-hidden="true">{setupPhase === "success" ? <Check size={17} /> : <TerminalSquare size={17} />}</span>
              <div className="terminal-suggestion-integration-copy">
                <strong>{setupPhase === "success" ? "Shell 集成已启用" : "连接命令建议与当前终端"}</strong>
                <p role="status">{setupPhase === "confirming" ? "确认当前终端停在空白的 Bash / Zsh 提示符。"
                  : setupPhase === "waiting" ? "初始化已发送，正在等待 Shell 返回提示符。"
                    : setupPhase === "timeout" ? "尚未收到 Shell 确认。请检查是否使用 Bash / Zsh，或查看手动启用说明。"
                      : setupPhase === "success" ? "建议已保留，点击「填入」即可编辑，回车执行。"
                        : "启用后可填入建议、识别执行结果并跟随目录。仅本次连接生效。支持 Bash / Zsh。"}</p>
              </div>
              {setupPhase !== "success" && (
                <button type="button" className="terminal-suggestion-enable-shell" disabled={!snapshot.connectionId || setupBusy} onClick={() => void enableShell()}>
                  {setupBusy && <LoaderCircle size={13} className="terminal-suggestion-spinner" />}
                  {setupPhase === "confirming" ? "等待确认" : setupPhase === "waiting" ? "正在启用" : setupPhase === "timeout" ? "重试启用" : "启用 Shell 集成"}
                </button>
              )}
            </div>
          )}
          <details className="terminal-suggestion-setup">
            <summary>{snapshot.integrated ? "增强执行结果识别 · Bash / Zsh" : "手动启用与兼容说明"}</summary>
            <p>仅当前 Bash / Zsh 生效，不修改远端配置文件，保留已有提示符与钩子。手动启用时，复制下面的命令到空白提示符并回车。重连或新开 Shell 后需重新启用。</p>
            <code>{SHELL_INTEGRATION_COMMAND}</code>
            <div>
              <button type="button" onClick={() => void copy(SHELL_INTEGRATION_COMMAND)}>{copied === SHELL_INTEGRATION_COMMAND ? "已复制" : "复制集成命令"}</button>
              {snapshot.integrated && <button type="button" disabled={setupBusy || !snapshot.connectionId || !snapshot.ready || snapshot.command !== ""} onClick={() => void enableShell()}>重新启用集成</button>}
            </div>
          </details>
        </>
      )}
      <footer><span>{disabledReason || (suggestions.length ? "填入后可编辑，回车执行" : "输入命令获取历史建议，或描述目标")}</span>{shortcutsEnabled && suggestions.length > 0 && !disabledReason && <kbd>Alt+Enter 填入</kbd>}<span className="terminal-suggestion-escape">{shortcutsEnabled ? "Esc 关闭" : "远端优先 · 点击填入"}</span></footer>
    </section>
  );
}
