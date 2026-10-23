import { useEffect, useRef, useState, type CSSProperties } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { Activity, Bot, ChevronDown, ChevronUp, Copy, Minus, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { writeClipboardText } from "../clipboard";
import { ContextMenu } from "./ContextMenu";
import type { AppPreferences } from "../preferences";
import { isTerminalEvent, type SavedSession, type TerminalEvent } from "../types";
import { decodeTerminalKeyMapping, normalizeTerminalCommand } from "../terminal-command";
import { matchesTerminalShortcut, TerminalTriggerMatcher } from "../terminal-trigger";
import { IS_MACOS } from "../platform";
import { confirmDialog, hostKeyDialog } from "./DialogHost";
import { BoundedSessionLogBuffer } from "../session-log-buffer";
import { CumulativeTerminalOutputAcknowledger } from "../terminal-output-ack";
import { readRecentTerminalOutput } from "../terminal-context";
import { loadCommandHistory, recordCommandHistory } from "../command-history";
import { completionSuffix, safeCompletionCommand, sameTerminalPrompt, SHELL_INTEGRATION_COMMAND, TerminalPromptTracker, type TerminalPromptSnapshot } from "../terminal-completion";
import { TerminalCommandSuggestions, type TerminalCommandSuggestionsHandle } from "./TerminalCommandSuggestions";
import { TerminalExecutionLedger, executionAiContext, type TerminalExecution, type TerminalExecutionRequest } from "../terminal-execution";
import { TerminalExecutionList } from "./TerminalExecutionList";
import "@xterm/xterm/css/xterm.css";
import "./terminal-pane-layout.css";
import { resolveTerminalTheme } from "../themes";
import { parseTerminalDirectory } from "../directory-workspace";

export interface TerminalCommandRequest {
  id: string;
  text: string;
  batchRunId?: string;
  targetTabId?: string;
}

interface TerminalPaneProps {
  session: SavedSession;
  preferences: AppPreferences;
  visible: boolean;
  focused: boolean;
  connectionEnabled: boolean;
  command: TerminalCommandRequest | null;
  onStateChange: (state: string) => void;
  onConnectionChange?: (connectionId: string | null) => void;
  onFocus?: () => void;
  onCommandResult: (result: { id: string; ok: boolean; error?: string; batchRunId?: string; targetTabId?: string }) => void;
  onTrigger?: (event: { triggerId: string; label: string; matchedText: string }) => void;
  onEditSession?: (session: SavedSession) => void;
  onDiagnose?: (session: SavedSession) => void;
  onAiRequest?: (mode: "explain" | "diagnose" | "command", text: string, source?: "selection" | "recent-output" | "execution") => void;
  initialExecutions?: readonly TerminalExecution[];
  onExecutionsChange?: (records: readonly TerminalExecution[]) => void;
  onDirectoryChange?: (connectionId: string | null, directory: string | null) => void;
}

type OutputAcknowledge = (bytes: number) => void;

interface PendingTerminalOutput {
  text: string;
  bytes: number;
  acknowledge: OutputAcknowledge;
}

export function TerminalPane({
  session,
  preferences,
  visible,
  focused,
  connectionEnabled,
  command,
  onStateChange,
  onConnectionChange,
  onFocus,
  onCommandResult,
  onTrigger,
  onEditSession,
  onDiagnose,
  onAiRequest,
  initialExecutions,
  onExecutionsChange,
  onDirectoryChange,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const connectionEnabledRef = useRef(connectionEnabled);
  connectionEnabledRef.current = connectionEnabled;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Resumes deferred terminal writes when the pane becomes visible again.
  const resumeOutputRef = useRef<(() => void) | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const lastCommandIdRef = useRef<string | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchResults, setSearchResults] = useState<{ index: number; count: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectedCharacters, setSelectedCharacters] = useState(0);
  const [authChallenge, setAuthChallenge] = useState<{ challengeId: string; prompts: Array<{ prompt: string; echo: boolean }> } | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [sessionLog] = useState(() => new BoundedSessionLogBuffer());
  const preferencesRef = useRef(preferences);
  const onAiRequestRef = useRef(onAiRequest);
  onAiRequestRef.current = onAiRequest;
  const onDirectoryChangeRef = useRef(onDirectoryChange);
  onDirectoryChangeRef.current = onDirectoryChange;
  preferencesRef.current = preferences;
  const sessionFontEnabled = preferences.useSessionTerminalFont;
  const baseFontSize = sessionFontEnabled ? session.terminal.fontSize || preferences.terminalFontSize : preferences.terminalFontSize;
  const [currentFontSize, setCurrentFontSize] = useState(baseFontSize);
  const currentFontSizeRef = useRef(baseFontSize);
  const [promptTracker] = useState(() => new TerminalPromptTracker());
  const [executionLedger] = useState(() => new TerminalExecutionLedger(initialExecutions));
  const [executions, setExecutions] = useState(() => executionLedger.getSnapshot());
  const [executionsVisible, setExecutionsVisible] = useState(false);
  const onExecutionsChangeRef = useRef(onExecutionsChange);
  onExecutionsChangeRef.current = onExecutionsChange;
  const publishExecutions = () => {
    const records = executionLedger.getSnapshot();
    setExecutions(records);
    onExecutionsChangeRef.current?.(records);
  };
  const [promptSnapshot, setPromptSnapshot] = useState<TerminalPromptSnapshot>({
    connectionId: null, promptId: 0, revision: 0, integrated: false, phase: "unknown", command: null, ready: false,
  });
  const [suggestionStyle, setSuggestionStyle] = useState<CSSProperties>({ left: 10, bottom: 12 });
  const suggestionsRef = useRef<TerminalCommandSuggestionsHandle>(null);
  const publishPromptRef = useRef<(() => void) | null>(null);
  const sendCommandRef = useRef<((text: string, source: "ai" | "command", executionId?: string) => Promise<void>) | null>(null);
  const setupShellRef = useRef<((owner: TerminalPromptSnapshot) => Promise<void>) | null>(null);

  const readPromptSnapshot = (): TerminalPromptSnapshot => {
    const terminal = terminalRef.current;
    return terminal
      ? promptTracker.snapshot(connectionIdRef.current, terminal.buffer.active)
      : { ...promptSnapshot, connectionId: null, ready: false };
  };

  const openCommandSuggestions = () => {
    terminalRef.current?.scrollToBottom();
    publishPromptRef.current?.();
    suggestionsRef.current?.open();
  };

  const acceptCommandSuggestion = (text: string, owner: TerminalPromptSnapshot): boolean => {
    if (!visible || !focused || authChallenge) return false;
    const suffix = completionSuffix(text, owner, readPromptSnapshot());
    const terminal = terminalRef.current;
    if (!suffix || !terminal) return false;
    terminal.scrollToBottom();
    terminal.paste(suffix);
    terminal.focus();
    return true;
  };

  const applyTerminalFontSize = (value: number) => {
    const next = Math.min(32, Math.max(10, Math.round(value)));
    currentFontSizeRef.current = next;
    setCurrentFontSize(next);
    const terminal = terminalRef.current;
    if (terminal) terminal.options.fontSize = next;
    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let resizeTimer: number | undefined;
    let fitFrame: number | undefined;
    let fitTimer: number | undefined;
    let inputTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let noticeTimer: number | undefined;
    let wakeCheckTimer: number | undefined;
    let selectionCopyTimer: number | undefined;
    let outputFlushFrame: number | undefined;
    let promptFrame: number | undefined;
    let pendingOutput: PendingTerminalOutput[] = [];
    let pendingOutputHead = 0;
    let pendingOutputBytes = 0;
    const outputFrameBudgetBytes = 512 * 1024;
    const outputStatsEnabled = import.meta.env.DEV;
    let outputBytesSinceSample = 0;
    let outputChunksSinceSample = 0;
    let flushCountSinceSample = 0;
    let flushBytesSinceSample = 0;
    let flushDurationSinceSample = 0;
    let lastOutputSampleAt = performance.now();
    let pendingInput = "";
    let pendingExecutionIds: string[] = [];
    let inputWrites = 0;
    let connectGeneration = 0;
    let reconnectAttempt = 0;
    let wasConnected = false;
    let reconnectAllowed = true;
    let networkOnline = navigator.onLine !== false;
    let connectPendingForNetwork = false;
    let currentState = "connecting";
    promptTracker.reset();
    let lastWakeCheckAt = Date.now();
    const triggerMatcher = new TerminalTriggerMatcher();
    setConnectionError(null);
    setConnectionNotice(null);
    sessionLog.reset([
      "XSH 会话日志 (XSH Session Log)",
      `会话 (Session): ${session.name}`,
      `主机 (Host): ${session.username}@${session.host}:${session.port}`,
      `开始时间 (Started): ${new Date().toISOString()}`,
      "",
    ].join("\n"));

    const outputDecoder = createTextDecoder(session.terminal.encoding);
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: preferencesRef.current.useSessionTerminalFont
        ? session.terminal.fontFamily?.trim() || preferencesRef.current.terminalFontFamily
        : preferencesRef.current.terminalFontFamily,
      fontSize: currentFontSizeRef.current,
      lineHeight: preferences.terminalLineHeight,
      letterSpacing: 0,
      fontWeight: preferences.terminalFontWeight,
      fontWeightBold: preferences.terminalFontWeightBold,
      scrollback: preferencesRef.current.useSessionTerminalScrollback
        ? session.terminal.scrollbackLines
        : preferencesRef.current.terminalScrollbackLines,
      allowProposedApi: false,
      theme: terminalTheme(session.terminal.theme, preferences.theme),
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();
    const webglAddon = new WebglAddon();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    const publishPrompt = () => {
      if (disposed || promptFrame !== undefined) return;
      promptFrame = window.requestAnimationFrame(() => {
        promptFrame = undefined;
        if (disposed) return;
        const next = promptTracker.snapshot(connectionIdRef.current, terminal.buffer.active);
        setPromptSnapshot((previous) => Object.keys(next).every((key) => next[key as keyof TerminalPromptSnapshot] === previous[key as keyof TerminalPromptSnapshot]) ? previous : next);
        const screen = host.querySelector(".xterm-screen")?.getBoundingClientRect();
        const pane = host.parentElement?.getBoundingClientRect();
        let position: CSSProperties = { left: 10, bottom: 12 };
        if (screen && pane && screen.height > 0 && next.phase === "prompt") {
          const buffer = terminal.buffer.active;
          const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
          const cellHeight = screen.height / terminal.rows;
          const cursorTop = screen.top - pane.top + cursorRow * cellHeight;
          if (cursorRow >= 0 && cursorRow < terminal.rows) {
            const spaceBelow = Math.max(0, pane.height - cursorTop - cellHeight - 14);
            const spaceAbove = Math.max(0, cursorTop - 38);
            const showBelow = spaceBelow >= 300 || spaceBelow >= spaceAbove;
            position = {
              left: Math.max(10, Math.min(pane.width - Math.min(570, pane.width - 20) - 10, screen.left - pane.left + buffer.cursorX * screen.width / terminal.cols)),
              ...(showBelow
                ? { top: cursorTop + cellHeight + 4, maxHeight: spaceBelow }
                : { bottom: Math.max(10, pane.height - cursorTop + 4), maxHeight: spaceAbove }),
            };
          }
        }
        setSuggestionStyle((previous) => JSON.stringify(previous) === JSON.stringify(position) ? previous : position);
      });
    };
    publishPromptRef.current = publishPrompt;
    const executionCursor = () => ({ buffer: terminal.buffer.active, marker: () => terminal.registerMarker(0) });
    const promptDisposable = terminal.parser.registerOscHandler(133, (data) => {
      const previous = executionLedger.getSnapshot();
      executionLedger.osc(data, executionCursor());
      if (previous !== executionLedger.getSnapshot()) publishExecutions();
      promptTracker.osc(data, terminal.buffer.active.cursorX, () => terminal.registerMarker(0));
      publishPrompt();
      return true;
    });
    const directoryDisposable = terminal.parser.registerOscHandler(7, (data) => {
      const directory = parseTerminalDirectory(data);
      if (directory && connectionIdRef.current) onDirectoryChangeRef.current?.(connectionIdRef.current, directory);
      return true;
    });
    const promptOutputDisposable = terminal.onWriteParsed(publishPrompt);
    const promptBufferDisposable = terminal.buffer.onBufferChange(() => {
      // A full-screen app can restore a buffer containing an old prompt. Its
      // input state must not be reused after the app exits.
      promptTracker.input("\x1b");
      publishPrompt();
    });
    const promptScrollDisposable = terminal.onScroll(publishPrompt);
    const searchResultsDisposable = searchAddon.onDidChangeResults((result) => {
      setSearchResults(result.resultCount > 0
        ? { index: result.resultIndex, count: result.resultCount }
        : null);
    });
    try {
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL may be unavailable (disabled GPU, locked-down webview); the DOM
      // renderer keeps working, just slower under heavy scroll.
      webglAddon.dispose();
    }

    // The quick-command bar is a sibling grid row. Wait for that row and the
    // native window scale to settle before measuring cells; fitting immediately
    // after open can leave one fractional, visibly black strip at the bottom.
    const fitTerminal = () => {
      if (disposed) return;
      fitAddon.fit();
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!disposed) fitAddon.fit();
      });
    };
    fitTerminal();
    fitTimer = window.setTimeout(() => {
      fitTimer = undefined;
      fitTerminal();
    }, 80);
    if (visible) terminal.focus();

    const reportOutputStats = (force = false) => {
      if (!outputStatsEnabled) return;
      const now = performance.now();
      const elapsed = now - lastOutputSampleAt;
      if (!force && elapsed < 1_000) return;
      if (outputBytesSinceSample > 0 || flushCountSinceSample > 0) {
        const outputRate = elapsed > 0 ? Math.round((outputBytesSinceSample * 1_000) / elapsed) : 0;
        const averageFlushDuration = flushCountSinceSample > 0
          ? (flushDurationSinceSample / flushCountSinceSample).toFixed(1)
          : "0.0";
        console.debug(
          `[XSH] terminal output: ${outputRate} B/s, ${outputChunksSinceSample} chunks, ` +
          `${flushCountSinceSample} frame flushes, ${flushBytesSinceSample} B flushed, ` +
          `${averageFlushDuration} ms/flush`,
        );
      }
      outputBytesSinceSample = 0;
      outputChunksSinceSample = 0;
      flushCountSinceSample = 0;
      flushBytesSinceSample = 0;
      flushDurationSinceSample = 0;
      lastOutputSampleAt = now;
    };
    const compactPendingOutput = () => {
      if (pendingOutputHead === 0) return;
      if (pendingOutputHead >= pendingOutput.length) {
        pendingOutput = [];
        pendingOutputHead = 0;
        return;
      }
      if (pendingOutputHead < 64 && pendingOutputHead * 2 < pendingOutput.length) return;
      pendingOutput = pendingOutput.slice(pendingOutputHead);
      pendingOutputHead = 0;
    };
    const writeOutput = (
      text: string,
      acknowledgements: Map<OutputAcknowledge, number>,
    ) => {
      // Writing the already-decoded text skips xterm's own UTF-8 pass over
      // the same bytes; acknowledgements stay byte-based via chunk records.
      terminal.write(text, () => {
        for (const [acknowledge, bytes] of acknowledgements) acknowledge(bytes);
      });
    };
    const flushOutput = (drainAll = false) => {
      outputFlushFrame = undefined;
      if (disposed) return;
      const startedAt = performance.now();
      const budget = drainAll ? Number.MAX_SAFE_INTEGER : outputFrameBudgetBytes;
      if (pendingOutputBytes <= 0) {
        reportOutputStats();
        return;
      }

      // Whole chunks only: backend chunks sit far below the frame budget, so
      // a frame overshoots by at most one chunk, and byte accounting stays
      // exactly aligned with chunk boundaries (what the flow window counts).
      const acknowledgements = new Map<OutputAcknowledge, number>();
      const parts: string[] = [];
      let flushedBytes = 0;
      while (pendingOutputHead < pendingOutput.length) {
        const chunk = pendingOutput[pendingOutputHead];
        if (!drainAll && flushedBytes > 0 && flushedBytes + chunk.bytes > budget) break;
        parts.push(chunk.text);
        acknowledgements.set(
          chunk.acknowledge,
          (acknowledgements.get(chunk.acknowledge) ?? 0) + chunk.bytes,
        );
        flushedBytes += chunk.bytes;
        pendingOutputHead += 1;
      }
      pendingOutputBytes -= flushedBytes;
      if (parts.length > 0) {
        writeOutput(parts.length === 1 ? parts[0] : parts.join(""), acknowledgements);
      }

      compactPendingOutput();
      flushCountSinceSample += 1;
      flushBytesSinceSample += flushedBytes;
      flushDurationSinceSample += performance.now() - startedAt;
      reportOutputStats();
      if (!disposed && pendingOutputBytes > 0 && !drainAll && visibleRef.current) {
        outputFlushFrame = window.requestAnimationFrame(() => flushOutput(false));
      }
    };
    const flushPendingOutput = () => {
      if (outputFlushFrame !== undefined) {
        window.cancelAnimationFrame(outputFlushFrame);
        outputFlushFrame = undefined;
      }
      while (!disposed && pendingOutputBytes > 0) flushOutput(true);
      reportOutputStats(true);
    };
    const scheduleOutputFlush = () => {
      if (outputFlushFrame === undefined) {
        outputFlushFrame = window.requestAnimationFrame(() => flushOutput(false));
      }
    };
    resumeOutputRef.current = () => {
      if (!disposed && pendingOutputBytes > 0) scheduleOutputFlush();
    };
    // While the pane is hidden, output is only logged (session log + triggers
    // still run) and NOT acknowledged, so the backend's flow window pauses the
    // stream; switching back to the pane drains what accumulated.
    const queueOutput = (text: string, bytes: number, acknowledge: OutputAcknowledge) => {
      if (bytes === 0) return;
      pendingOutput.push({ text, bytes, acknowledge });
      pendingOutputBytes += bytes;
      outputBytesSinceSample += bytes;
      outputChunksSinceSample += 1;
      reportOutputStats();
      if (visibleRef.current) scheduleOutputFlush();
    };

    // Input rides JSON as a plain string (≈1x size); the legacy number[]
    // form cost ~4x per byte on every keystroke and paste. Coalescing keeps
    // the per-keystroke invoke rate bounded.
    const flushInput = () => {
      inputTimer = undefined;
      const connectionId = connectionIdRef.current;
      if (!connectionId || pendingInput.length === 0) {
        pendingInput = "";
        pendingExecutionIds = [];
        return;
      }
      const data = pendingInput;
      const recordIds = pendingExecutionIds;
      pendingInput = "";
      pendingExecutionIds = [];
      inputWrites += 1;
      void api.terminalWrite(connectionId, data).catch((error) => {
        recordIds.forEach((id) => executionLedger.failed(id));
        if (recordIds.length) publishExecutions();
        terminal.writeln(`\r\n\x1b[31m输入发送失败：${String(error)}\x1b[0m`);
      }).finally(() => { inputWrites -= 1; });
    };
    const queueText = (text: string) => {
      const before = promptTracker.snapshot(connectionIdRef.current, terminal.buffer.active);
      const submitted = promptTracker.input(text);
      if (submitted && !/^\s/.test(submitted) && safeCompletionCommand(submitted)) {
        if (connectionIdRef.current) {
          pendingExecutionIds.push(executionLedger.sent(submitted, connectionIdRef.current, "terminal", executionCursor(), before.integrated && before.command === submitted, before.ready));
          publishExecutions();
        }
        try {
          recordCommandHistory(loadCommandHistory(), { sessionId: session.id, sessionName: session.name, command: submitted, source: "terminal" });
        } catch {
          // Storage failure must never interrupt terminal input.
        }
      }
      publishPrompt();
      pendingInput += text;
      if (pendingInput.length >= 4096) flushInput();
      else if (inputTimer === undefined) inputTimer = window.setTimeout(flushInput, 8);
    };
    setupShellRef.current = async (owner) => {
      const connectionId = connectionIdRef.current;
      const current = promptTracker.snapshot(connectionId, terminal.buffer.active);
      if (disposed || !connectionId || !sameTerminalPrompt(owner, current)
        || pendingInput || inputWrites > 0 || terminal.buffer.active.type !== "normal"
        || (current.integrated && (!current.ready || current.command !== ""))) {
        throw new Error("终端连接或输入已变化，请回到空白的 Shell 提示符后重试。");
      }
      // This path sends only our fixed per-shell initializer, after explicit
      // confirmation. It never executes the generated AI suggestion.
      const text = `${SHELL_INTEGRATION_COMMAND}\r`;
      promptTracker.input(text);
      publishPrompt();
      inputWrites += 1;
      try {
        await api.terminalWrite(connectionId, text);
      } finally {
        inputWrites -= 1;
      }
    };
    sendCommandRef.current = async (text, source, executionId) => {
      const connectionId = connectionIdRef.current;
      if (!connectionId || disposed) throw new Error("目标终端尚未连接。");
      const before = promptTracker.snapshot(connectionId, terminal.buffer.active);
      if (source === "ai" && (pendingInput || inputWrites > 0 || (before.integrated && (!before.ready || before.command !== "")))) {
        throw new Error("请先回到空白的 Shell 提示符，再发送 AI 命令；当前命令尚未结束或输入行有内容。");
      }
      const id = executionLedger.sent(text, connectionId, source, executionCursor(), before.ready && before.command === "", false, executionId);
      publishExecutions();
      promptTracker.input(text);
      publishPrompt();
      inputWrites += 1;
      try {
        await api.terminalWrite(connectionId, text);
      } catch (error) {
        executionLedger.failed(id);
        publishExecutions();
        throw error;
      } finally {
        inputWrites -= 1;
      }
    };
    const executeAiCommand = (event: Event) => {
      const request = (event as CustomEvent<TerminalExecutionRequest>).detail;
      if (request.connectionId === connectionIdRef.current) request.accept(sendCommandRef.current!(request.text, "ai", request.executionId));
    };
    window.addEventListener("xsh:execute-ai-command", executeAiCommand);
    const suggestAfterExecution = (event: Event) => {
      const request = (event as CustomEvent<{ connectionId: string; context: string }>).detail;
      if (request.connectionId !== connectionIdRef.current || !visibleRef.current) return;
      setExecutionsVisible(false);
      terminal.scrollToBottom();
      publishPrompt();
      suggestionsRef.current?.open({ goal: "根据这次命令的实际结果，给出下一步检查命令", output: request.context });
    };
    window.addEventListener("xsh:execution-next-command", suggestAfterExecution);
    const queueBinary = (bytes: Uint8Array) => {
      flushInput();
      const connectionId = connectionIdRef.current;
      if (!connectionId) return;
      void api.terminalWriteBinary(connectionId, Array.from(bytes)).catch((error) => {
        terminal.writeln(`\r\n\x1b[31m输入发送失败：${String(error)}\x1b[0m`);
      });
    };

    let lastCopyAt = 0;
    let lastPasteAt = 0;
    let pasteInFlight = false;
    let suppressNativeCopyUntil = 0;
    let suppressNativePasteUntil = 0;

    const copySelection = async () => {
      const selection = terminal.getSelection();
      if (!selection) return false;
      await writeClipboardText(selection);
      lastCopyAt = performance.now();
      return true;
    };

    const pasteText = async (text: string) => {
      if (!text) return;
      const lineCount = text.split(/\r?\n/).length;
      if (preferencesRef.current.confirmMultiLinePaste && lineCount > 3
        && !(await confirmDialog({
          title: "多行粘贴确认",
          message: `即将粘贴 ${lineCount} 行内容到 ${session.name}，是否继续？`,
          confirmLabel: "粘贴",
        }))) return;
      lastPasteAt = performance.now();
      terminal.paste(text);
      terminal.focus();
    };

    const safePaste = async () => {
      // A single app paste shortcut can produce both a keydown and a native
      // paste event in WebKit. The first path wins so the command is never
      // sent to the remote shell twice.
      if (pasteInFlight || performance.now() - lastPasteAt < 250) return;
      pasteInFlight = true;
      try {
        const text = await readClipboardText();
        // A native paste event may have supplied the text while the async
        // clipboard read was pending. Re-check after awaiting to avoid a
        // duplicate paste in WebKit/Tauri.
        if (performance.now() - lastPasteAt < 250) return;
        if (text) void pasteText(text);
      } finally {
        pasteInFlight = false;
      }
    };

    const pasteFromRightClick = async () => {
      // xterm emits selectionchange asynchronously. If the user selects text
      // and immediately right-clicks, the delayed copy-on-select callback may
      // not have run yet, leaving the system clipboard with stale contents.
      // Flush that selection synchronously before reading the clipboard.
      if (selectionCopyTimer !== undefined) {
        window.clearTimeout(selectionCopyTimer);
        selectionCopyTimer = undefined;
      }
      if (terminal.hasSelection()) {
        await copySelection();
      }
      await safePaste();
    };

    const isMac = IS_MACOS;
    const isCopyShortcut = (event: KeyboardEvent) => isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c"
      : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "c";
    const isPasteShortcut = (event: KeyboardEvent) => isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v"
      : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "v";
    const isSearchShortcut = (event: KeyboardEvent) => isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f"
      : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "f";
    const getZoomAction = (event: KeyboardEvent): "increase" | "decrease" | "reset" | null => {
      const modifier = isMac
        ? event.metaKey && !event.ctrlKey && !event.altKey
        : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
      if (!modifier) return null;
      if (event.code === "Digit0" || event.code === "Numpad0") return "reset";
      if (event.code === "Minus" || event.code === "NumpadSubtract") return "decrease";
      if (event.code === "Equal" || event.code === "NumpadAdd") return "increase";
      return null;
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.isComposing) return true;
      const mapping = (session.terminal.keyMappings ?? []).find((candidate) =>
        candidate.enabled && candidate.text && matchesTerminalShortcut(event, candidate.shortcut),
      );
      if (mapping && event.type === "keydown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        queueText(decodeTerminalKeyMapping(mapping.text));
        return false;
      }
      const appShortcuts = isMac || preferencesRef.current.terminalShortcutMode !== "remote-first";
      const completionShortcut = event.code === "Space" && event.shiftKey && !event.altKey
        && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
      if (appShortcuts && completionShortcut) {
        if (event.type === "keydown") {
          event.preventDefault();
          event.stopImmediatePropagation();
          terminal.scrollToBottom();
          publishPrompt();
          suggestionsRef.current?.open();
        }
        return false;
      }
      if (appShortcuts && event.type === "keydown" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "Enter" && suggestionsRef.current?.accept()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return false;
      }
      if (appShortcuts && event.type === "keydown" && event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && suggestionsRef.current?.dismiss()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return false;
      }
      const copy = isCopyShortcut(event);
      const paste = isPasteShortcut(event);
      const search = isSearchShortcut(event);
      const aiShortcut = event.shiftKey && !event.altKey && event.key.toLowerCase() === "i"
        && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
      if (aiShortcut && (isMac || preferencesRef.current.terminalShortcutMode !== "remote-first")) return false;
      if (event.key === "F1" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && preferencesRef.current.terminalShortcutMode !== "remote-first") return false;
      const zoomAction = getZoomAction(event);
      if (zoomAction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (zoomAction === "reset") applyTerminalFontSize(
          preferencesRef.current.useSessionTerminalFont
            ? session.terminal.fontSize || preferencesRef.current.terminalFontSize
            : preferencesRef.current.terminalFontSize,
        );
        else applyTerminalFontSize(currentFontSizeRef.current + (zoomAction === "decrease" ? -1 : 1));
        return false;
      }
      if (copy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!terminal.hasSelection()) return false;
        void copySelection().catch((error) => {
          terminal.writeln(`\r\n\x1b[31m复制失败：${String(error)}\x1b[0m`);
        });
        return false;
      }
      if (paste) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void safePaste().catch((error) => {
          terminal.writeln(`\r\n\x1b[31m粘贴失败：${String(error)}\x1b[0m`);
        });
        return false;
      }
      if (search) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSearchVisible(true);
        return false;
      }
      return true;
    });

    // WebKit can dispatch native clipboard events without passing through
    // xterm's custom handler. Capture the app shortcuts, but explicitly suppress
    // native clipboard events produced by Ctrl+C/Ctrl+V so those control bytes
    // still reach the remote shell unchanged.
    const nativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      terminal.focus();
      if (preferencesRef.current.rightClickAction === "paste" && !event.shiftKey) {
        setContextMenu(null);
        void pasteFromRightClick().catch((error) => {
          terminal.writeln(`\r\n\x1b[31m粘贴失败：${String(error)}\x1b[0m`);
        });
      } else {
        setContextMenu({ x: event.clientX, y: event.clientY });
      }
    };
    host.addEventListener("contextmenu", nativeContextMenu, true);

    const nativeKeydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const key = event.key.toLowerCase();
      const copy = isCopyShortcut(event);
      const paste = isPasteShortcut(event);

      if (!copy && event.ctrlKey && !event.metaKey && key === "c") {
        suppressNativeCopyUntil = performance.now() + 500;
      }
      if (!paste && event.ctrlKey && !event.metaKey && key === "v") {
        suppressNativePasteUntil = performance.now() + 500;
      }

      if (copy) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!terminal.hasSelection() || performance.now() - lastCopyAt < 250) return;
        void copySelection().catch((error) => {
          terminal.writeln(`\r\n\x1b[31m复制失败：${String(error)}\x1b[0m`);
        });
      } else if (paste) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void safePaste().catch((error) => {
          terminal.writeln(`\r\n\x1b[31m粘贴失败：${String(error)}\x1b[0m`);
        });
      }
    };
    const nativeCopy = (event: ClipboardEvent) => {
      if (performance.now() < suppressNativeCopyUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const selection = terminal.getSelection();
      if (!selection) return;
      event.preventDefault();
      if (performance.now() - lastCopyAt < 250) return;
      event.clipboardData?.setData("text/plain", selection);
      lastCopyAt = performance.now();
      void writeClipboardText(selection).catch(() => undefined);
    };
    const nativePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (performance.now() < suppressNativePasteUntil || performance.now() - lastPasteAt < 250) return;
      const text = event.clipboardData?.getData("text/plain");
      if (text) {
        void pasteText(text);
      } else {
        void safePaste().catch((error) => {
          terminal.writeln(`\r\n\x1b[31m粘贴失败：${String(error)}\x1b[0m`);
        });
      }
    };
    host.addEventListener("keydown", nativeKeydown, true);
    host.addEventListener("copy", nativeCopy, true);
    host.addEventListener("paste", nativePaste, true);

    const selectionDisposable = terminal.onSelectionChange(() => {
      setSelectedCharacters(terminal.getSelection().length);
      if (!preferencesRef.current.copyOnSelect || !terminal.hasSelection()) return;
      if (selectionCopyTimer !== undefined) window.clearTimeout(selectionCopyTimer);
      selectionCopyTimer = window.setTimeout(() => {
        selectionCopyTimer = undefined;
        const selection = terminal.getSelection();
        if (selection) void writeClipboardText(selection).catch(() => undefined);
      }, 120);
    });
    const dataDisposable = terminal.onData((data) => {
      queueText(data);
    });
    const binaryDisposable = terminal.onBinary((data) => {
      queueBinary(Uint8Array.from(data, (character) => character.charCodeAt(0)));
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      publishPrompt();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const connectionId = connectionIdRef.current;
        if (connectionId) void api.terminalResize(connectionId, cols, rows);
      }, 50);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!disposed) fitAddon.fit();
      });
    });
    resizeObserver.observe(host);

    // Ctrl/Cmd + wheel adjusts the font size, matching what every native
    // terminal offers; without preventDefault the browser would zoom the page.
    const onWheel = (event: WheelEvent) => {
      if (disposed) return;
      const zoomModifier = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (!zoomModifier) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      applyTerminalFontSize(currentFontSizeRef.current + (event.deltaY < 0 ? 1 : -1));
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });

    const reportState = (state: string) => {
      currentState = state;
      onStateChange(state);
    };

    const showTransientNotice = (message: string, duration = 3_000) => {
      setConnectionNotice(message);
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        noticeTimer = undefined;
        setConnectionNotice(null);
      }, duration);
    };

    const waitForNetwork = () => {
      connectPendingForNetwork = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      setConnectionError(null);
      setConnectionNotice("网络不可用，恢复后将自动继续连接");
      reportState("waiting-network");
    };

    const scheduleReconnect = (): boolean => {
      if (!connectionEnabledRef.current) {
        setConnectionNotice("等待连接资源…");
        reportState("queued");
        return true;
      }
      if (
        disposed ||
        !session.autoReconnect ||
        !reconnectAllowed ||
        !wasConnected
      ) return false;
      if (!networkOnline) {
        waitForNetwork();
        return true;
      }
      if (reconnectTimer !== undefined) return true;
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
      reconnectAttempt += 1;
      reportState("reconnecting");
      terminal.writeln(`\r\n\x1b[90m连接中断，${Math.ceil(delay / 1_000)} 秒后重连…\x1b[0m`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
      return true;
    };

    const connect = async () => {
      if (!connectionEnabledRef.current) {
        setConnectionNotice("等待连接资源…");
        reportState("queued");
        return;
      }
      if (!networkOnline) {
        waitForNetwork();
        return;
      }
      connectPendingForNetwork = false;
      const generation = ++connectGeneration;
      reconnectAllowed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const previousConnectionId = connectionIdRef.current;
      executionLedger.disconnected(terminal.buffer.active);
      publishExecutions();
      connectionIdRef.current = null;
      pendingInput = "";
      pendingExecutionIds = [];
      promptTracker.reset();
      publishPrompt();
      onConnectionChange?.(null);
      onDirectoryChangeRef.current?.(null, null);
      if (previousConnectionId) {
        void api.disconnectTerminal(previousConnectionId).catch(() => undefined);
      }

      const channel = new Channel<TerminalEvent | ArrayBuffer>();
      const outputAcknowledger = new CumulativeTerminalOutputAcknowledger();
      let connectionEnded = false;
      const acknowledgeOutput: OutputAcknowledge = (bytes) => {
        if (disposed || generation !== connectGeneration) {
          outputAcknowledger.stop();
          return;
        }
        outputAcknowledger.consume(bytes);
      };
      channel.onmessage = (message) => {
        if (disposed || generation !== connectGeneration) return;
        // Raw output chunks arrive as ArrayBuffer from the binary IPC path;
        // control events stay JSON objects.
        if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
          const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
          const output = outputDecoder.decode(bytes, { stream: true });
          sessionLog.append(output, bytes.length);
          const triggers = session.terminal.triggers ?? [];
          if (triggers.length > 0) {
            for (const match of triggerMatcher.match(output, triggers)) {
              const timestamp = new Date().toISOString();
              sessionLog.append(`\n[XSH Trigger ${timestamp}] ${match.trigger.label}: ${match.matchedText}\n`);
              onTrigger?.({
                triggerId: match.trigger.id,
                label: match.trigger.label,
                matchedText: match.matchedText,
              });
            }
          }
          queueOutput(output, bytes.length, acknowledgeOutput);
          return;
        }
        if (!isTerminalEvent(message)) return;
        const event = message;
        switch (event.type) {
          case "authChallenge":
            setAuthChallenge(event.payload);
            setAuthResponses(event.payload.prompts.map(() => ""));
            reportState("authenticating");
            break;
          case "stateChanged": {
            const state = typeof event.payload === "string" ? event.payload : "reconnecting";
            if (state === "connected") {
              wasConnected = true;
              reconnectAttempt = 0;
              connectPendingForNetwork = false;
              setConnectionNotice(null);
            } else if (state === "disconnected") {
              connectionEnded = true;
              outputAcknowledger.stop();
              executionLedger.disconnected(terminal.buffer.active);
              publishExecutions();
              connectionIdRef.current = null;
              pendingInput = "";
              pendingExecutionIds = [];
              promptTracker.reset();
              publishPrompt();
              onConnectionChange?.(null);
              onDirectoryChangeRef.current?.(null, null);
              if (scheduleReconnect()) break;
            }
            reportState(state);
            break;
          }
          case "hostKeyUnknown": {
            const key = event.payload;
            reconnectAllowed = false;
            void hostKeyDialog(key, "SSH").then((accepted) => {
              if (!accepted) return;
              void api.trustSessionHostKey(session.id, key)
                .then(() => {
                  if (!disposed && generation === connectGeneration) void connect();
                })
                .catch((error) => {
                  if (disposed || generation !== connectGeneration) return;
                  setConnectionError(`Host Key 保存失败：${String(error)}`);
                  reportState("failed");
                });
            });
            break;
          }
          case "hostKeyChanged":
            reconnectAllowed = false;
            setConnectionError(
              `安全警告：${event.payload.host}:${event.payload.port} 的服务器密钥已变化，连接已阻止`,
            );
            reportState("failed");
            break;
          case "exitStatus":
            flushPendingOutput();
            terminal.writeln(`\r\n\x1b[90m远程进程退出：${event.payload}\x1b[0m`);
            break;
          case "error":
            setAuthChallenge(null);
            setAuthResponses([]);
            setConnectionError(event.payload);
            reportState("failed");
            scheduleReconnect();
            break;
        }
      };
      try {
        setConnectionError(null);
        setConnectionNotice(null);
        reportState(reconnectAttempt > 0 ? "reconnecting" : "connecting");
        const id = await api.connectTerminal(
          session.id,
          Math.max(terminal.cols, 1),
          Math.max(terminal.rows, 1),
          channel,
        );
        if (disposed || generation !== connectGeneration || connectionEnded) {
          outputAcknowledger.stop();
          await api.disconnectTerminal(id).catch(() => undefined);
          return;
        }
        outputAcknowledger.setSender(async (consumedBytes) => {
          if (disposed || generation !== connectGeneration) {
            outputAcknowledger.stop();
            return;
          }
          await api.terminalAcknowledgeOutput(id, consumedBytes);
        });
        connectionIdRef.current = id;
        publishPrompt();
        onConnectionChange?.(id);
        setConnectionError(null);
        setConnectionEpoch((current) => current + 1);
      } catch (error) {
        if (disposed || generation !== connectGeneration) return;
        setConnectionError(`连接失败：${String(error)}`);
        reportState("failed");
        scheduleReconnect();
      }
    };

    const handleOffline = () => {
      networkOnline = false;
      const shouldResume = currentState === "connecting" ||
        currentState === "authenticating" ||
        currentState === "reconnecting" ||
        currentState === "waiting-network" ||
        (currentState === "connected" && session.autoReconnect);
      if (shouldResume) waitForNetwork();
      else setConnectionNotice("网络已断开，当前 SSH 连接可能不可用");
    };

    const handleOnline = () => {
      networkOnline = true;
      fitTerminal();
      if (connectPendingForNetwork && reconnectAllowed) {
        terminal.writeln("\r\n\x1b[90m网络已恢复，正在重新连接…\x1b[0m");
        void connect();
      } else {
        showTransientNotice("网络已恢复");
      }
    };

    const checkConnectionAfterWake = () => {
      fitTerminal();
      if (!networkOnline) {
        if (connectPendingForNetwork || (wasConnected && session.autoReconnect)) waitForNetwork();
        return;
      }
      showTransientNotice("设备已唤醒，正在检查 SSH 连接…", 2_500);
      const connectionId = connectionIdRef.current;
      if (!connectionId && reconnectAllowed && (connectPendingForNetwork || (wasConnected && session.autoReconnect))) {
        void connect();
        return;
      }
      if (connectionId) {
        void api.terminalResize(connectionId, Math.max(terminal.cols, 1), Math.max(terminal.rows, 1))
          .catch(() => {
            if (!disposed && session.autoReconnect && reconnectAllowed) void connect();
          });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      fitTerminal();
      if (navigator.onLine === false && networkOnline) {
        handleOffline();
        return;
      }
      if (navigator.onLine !== false && !networkOnline) handleOnline();
      else if (networkOnline && !connectionIdRef.current && reconnectAllowed && (connectPendingForNetwork || (wasConnected && session.autoReconnect))) {
        void connect();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    wakeCheckTimer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastWakeCheckAt;
      lastWakeCheckAt = now;
      if (elapsed > 20_000) checkConnectionAfterWake();
    }, 5_000);

    reconnectRef.current = () => {
      setConnectionError(null);
      connectPendingForNetwork = true;
      void connect();
    };
    if (connectionEnabledRef.current) void connect();
    else {
      setConnectionNotice("等待连接资源…");
      reportState("queued");
    }

    return () => {
      disposed = true;
      resumeOutputRef.current = null;
      connectGeneration += 1;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      if (fitTimer) window.clearTimeout(fitTimer);
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      if (inputTimer) window.clearTimeout(inputTimer);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (noticeTimer) window.clearTimeout(noticeTimer);
      if (wakeCheckTimer) window.clearInterval(wakeCheckTimer);
      if (selectionCopyTimer) window.clearTimeout(selectionCopyTimer);
      if (outputFlushFrame !== undefined) window.cancelAnimationFrame(outputFlushFrame);
      if (promptFrame !== undefined) window.cancelAnimationFrame(promptFrame);
      publishPromptRef.current = null;
      sendCommandRef.current = null;
      setupShellRef.current = null;
      window.removeEventListener("xsh:execute-ai-command", executeAiCommand);
      window.removeEventListener("xsh:execution-next-command", suggestAfterExecution);
      executionLedger.disconnected(terminal.buffer.active);
      publishExecutions();
      promptTracker.reset();
      pendingOutput = [];
      pendingOutputHead = 0;
      pendingOutputBytes = 0;
      const connectionId = connectionIdRef.current;
      if (connectionId) void api.disconnectTerminal(connectionId).catch(() => undefined);
      onConnectionChange?.(null);
      selectionDisposable.dispose();
      dataDisposable.dispose();
      binaryDisposable.dispose();
      resizeDisposable.dispose();
      searchResultsDisposable.dispose();
      promptDisposable.dispose();
      directoryDisposable.dispose();
      promptOutputDisposable.dispose();
      promptBufferDisposable.dispose();
      promptScrollDisposable.dispose();
      resizeObserver.disconnect();
      setContextMenu(null);
      host.removeEventListener("contextmenu", nativeContextMenu, true);
      host.removeEventListener("keydown", nativeKeydown, true);
      host.removeEventListener("copy", nativeCopy, true);
      host.removeEventListener("paste", nativePaste, true);
      host.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      reconnectRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [session.id, session.updatedAt]);

  useEffect(() => {
    if (!connectionEnabled || connectionIdRef.current) return;
    reconnectRef.current?.();
  }, [connectionEnabled]);

  useEffect(() => {
    if (!command || command.id === lastCommandIdRef.current) return;
    const connectionId = connectionIdRef.current;
    if (!connectionId) return;
    lastCommandIdRef.current = command.id;
    const terminal = terminalRef.current;
    const text = normalizeTerminalCommand(command.text);
    void (sendCommandRef.current?.(text, "command") ?? Promise.reject(new Error("终端尚未就绪")))
      .then(() => {
        terminal?.focus();
        onCommandResult({ id: command.id, ok: true, batchRunId: command.batchRunId, targetTabId: command.targetTabId });
      })
      .catch((error) => {
        terminal?.writeln(`\r\n\x1b[31m命令发送失败：${String(error)}\x1b[0m`);
        onCommandResult({ id: command.id, ok: false, error: String(error), batchRunId: command.batchRunId, targetTabId: command.targetTabId });
      });
  }, [command, connectionEpoch, onCommandResult]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = preferences.useSessionTerminalFont
      ? session.terminal.fontFamily?.trim() || preferences.terminalFontFamily
      : preferences.terminalFontFamily;
    const nextFontSize = preferences.useSessionTerminalFont
      ? session.terminal.fontSize || preferences.terminalFontSize
      : preferences.terminalFontSize;
    currentFontSizeRef.current = nextFontSize;
    setCurrentFontSize(nextFontSize);
    terminal.options.fontSize = nextFontSize;
    terminal.options.lineHeight = preferences.terminalLineHeight;
    terminal.options.fontWeight = preferences.terminalFontWeight;
    terminal.options.fontWeightBold = preferences.terminalFontWeightBold;
    terminal.options.scrollback = preferences.useSessionTerminalScrollback
      ? session.terminal.scrollbackLines
      : preferences.terminalScrollbackLines;
    terminal.options.theme = terminalTheme(session.terminal.theme, preferences.theme);
    window.requestAnimationFrame(() => fitAddonRef.current?.fit());
  }, [preferences.terminalFontFamily, preferences.terminalFontSize, preferences.terminalLineHeight, preferences.terminalFontWeight, preferences.terminalFontWeightBold, preferences.terminalScrollbackLines, preferences.theme, preferences.useSessionTerminalFont, preferences.useSessionTerminalScrollback, session.terminal.fontFamily, session.terminal.fontSize, session.terminal.scrollbackLines, session.terminal.theme]);

  useEffect(() => {
    if (!visible) {
      setContextMenu(null);
      return;
    }
    resumeOutputRef.current?.();
    const timer = window.setTimeout(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const clearTerminal = () => {
    terminalRef.current?.clear();
    terminalRef.current?.scrollToBottom();
    terminalRef.current?.focus();
  };

  const requestAiContext = (mode: "explain" | "diagnose" | "command") => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection.trim()) { setConnectionNotice("请先在终端选择文本，再使用 AI 解释或分析报错。"); return; }
    onAiRequestRef.current?.(mode, selection, "selection");
  };

  const requestRecentAiContext = (mode: "explain" | "diagnose" | "command") => {
    const terminal = terminalRef.current;
    const text = terminal ? readRecentTerminalOutput(terminal.buffer.active) : "";
    if (!text) { setConnectionNotice("终端还没有可用输出。连接服务器后再附加，或在 AI 面板手动粘贴。"); return; }
    onAiRequestRef.current?.(mode, text, "recent-output");
  };

  const saveLog = async () => {
    const targetPath = await save({
      title: "保存终端日志",
      defaultPath: `${session.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: "Log file", extensions: ["log", "txt"] }],
    });
    if (!targetPath) return;
    try {
      await api.writeTextFile(targetPath, sessionLog.toString());
    } catch (error) {
      setConnectionError(`日志保存失败：${String(error)}`);
    }
  };

  const copyAllTerminal = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.selectAll();
    const selection = terminal.getSelection();
    terminal.clearSelection();
    if (selection) await writeClipboardText(selection);
    terminal.focus();
  };

  const openTerminalSearch = () => {
    setSearchVisible(true);
    window.setTimeout(() => document.querySelector<HTMLInputElement>(".terminal-search input")?.focus(), 0);
  };

  // Result counting only works when decorations are enabled in the search
  // options; the gray overview-ruler marks are the cheapest way to opt in.
  const TERMINAL_SEARCH_DECORATIONS = {
    matchOverviewRuler: "#6b7280",
    activeMatchColorOverviewRuler: "#eab308",
  } as const;
  const closeTerminalSearch = () => {
    setSearchVisible(false);
    setSearchResults(null);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };
  const runTerminalSearch = (direction: "next" | "previous", term: string, incremental = false) => {
    if (!term) return;
    const options = { incremental, decorations: TERMINAL_SEARCH_DECORATIONS };
    if (direction === "next") searchAddonRef.current?.findNext(term, options);
    else searchAddonRef.current?.findPrevious(term, options);
  };

  // The menu bar and toolbar live in the shell and have no refs into these
  // lazily mounted panes, so commands travel on a window event bus and only
  // the focused pane reacts.
  useEffect(() => {
    if (!focused) return;
    const onShellCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; mode?: string }>).detail;
      const kind = detail?.kind;
      if (kind === "aiSelection" || kind === "aiRecentOutput") {
        const mode = detail.mode;
        if (mode === "command" || mode === "explain" || mode === "diagnose") {
          if (kind === "aiSelection") requestAiContext(mode);
          else requestRecentAiContext(mode);
        }
      } else if (kind === "aiComplete") {
        openCommandSuggestions();
      } else if (kind === "aiExplain" || kind === "aiDiagnose") {
        requestAiContext(kind === "aiExplain" ? "explain" : "diagnose");
      } else if (kind === "aiRecentExplain" || kind === "aiRecentDiagnose") {
        requestRecentAiContext(kind === "aiRecentExplain" ? "explain" : "diagnose");
      } else if (kind === "copy") {
        const selection = terminalRef.current?.getSelection();
        if (selection) void writeClipboardText(selection).catch(() => undefined);
      } else if (kind === "copyAll") {
        void copyAllTerminal();
      } else if (kind === "paste") {
        void pasteIntoTerminal(terminalRef.current, preferences.confirmMultiLinePaste, session.name);
      } else if (kind === "find") {
        openTerminalSearch();
      } else if (kind === "clear") {
        clearTerminal();
      } else if (kind === "saveLog") {
        void saveLog();
      } else if (kind === "reconnect") {
        reconnectRef.current?.();
      } else if (kind === "resetFont") {
        applyTerminalFontSize(preferences.useSessionTerminalFont ? session.terminal.fontSize || preferences.terminalFontSize : preferences.terminalFontSize);
      }
    };
    window.addEventListener("xsh:terminal-action", onShellCommand);
    return () => window.removeEventListener("xsh:terminal-action", onShellCommand);
    // The handlers above read live state through refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, preferences.confirmMultiLinePaste, preferences.terminalFontSize, preferences.useSessionTerminalFont, session.name, session.terminal.fontSize]);

  const submitAuthChallenge = async () => {
    if (!authChallenge || !connectionIdRef.current) return;
    try {
      await api.terminalRespondAuth(connectionIdRef.current, authChallenge.challengeId, authResponses);
      setAuthChallenge(null);
      setAuthResponses([]);
    } catch (error) {
      setConnectionError(`认证响应发送失败：${String(error)}`);
    }
  };

  return (
    <div
      className={`terminal-pane ${visible ? "visible" : "hidden"} ${focused ? "focused" : ""}`}
      style={{ "--xsh-terminal-background": terminalTheme(session.terminal.theme, preferences.theme).background } as CSSProperties}
      onPointerDownCapture={() => onFocus?.()}
    >
      <div className="terminal-toolbar" role="toolbar" aria-label="终端工具栏">
        <span className="terminal-toolbar-session" title={session.name}>{selectedCharacters > 0 ? `已选 ${selectedCharacters.toLocaleString()} 字符` : session.name}</span>
        {selectedCharacters > 0 ? <>
          <button type="button" className="terminal-selection-action" onMouseDown={(event) => event.preventDefault()} onClick={() => requestAiContext("explain")} title="仅把当前选区送到 AI 预览，不会自动联网" aria-label="AI 解释选区"><Bot size={13} /><span>解释</span></button>
          <button type="button" className="terminal-selection-action" onMouseDown={(event) => event.preventDefault()} onClick={() => requestAiContext("diagnose")} title="用 AI 分析选中的报错，先预览再发送" aria-label="AI 分析选中的报错"><Activity size={13} /><span>分析报错</span></button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => void copyFromTerminal(terminalRef.current).catch(() => setConnectionNotice("复制失败，请重试。"))} title="复制当前选区" aria-label="复制当前选区"><Copy size={14} /></button>
        </> : <>
        <button type="button" onClick={() => applyTerminalFontSize(currentFontSize - 1)} title={`缩小当前终端字号 · ${IS_MACOS ? "⌘-" : "Ctrl+Shift+-"}`} aria-label="缩小当前终端字号"><Minus size={14} /></button>
        <button type="button" className="terminal-font-size-reset" onClick={() => applyTerminalFontSize(preferences.useSessionTerminalFont ? session.terminal.fontSize || preferences.terminalFontSize : preferences.terminalFontSize)} title={`恢复当前终端字号 · ${IS_MACOS ? "⌘0" : "Ctrl+Shift+0"}`} aria-label="恢复当前终端字号">{currentFontSize}</button>
        <button type="button" onClick={() => applyTerminalFontSize(currentFontSize + 1)} title={`放大当前终端字号 · ${IS_MACOS ? "⌘+" : "Ctrl+Shift++"}`} aria-label="放大当前终端字号"><Plus size={14} /></button>
        <button type="button" className="terminal-command-suggestion-toggle" onMouseDown={(event) => event.preventDefault()} onClick={openCommandSuggestions} title={`终端内命令建议 · ${IS_MACOS ? "⌘⇧Space" : preferences.terminalShortcutMode === "remote-first" ? "点击打开，快捷键交给远端" : "Ctrl+Shift+Space"}`} aria-label="终端内命令建议"><Sparkles size={13} /><span>命令建议</span></button>
        <button type="button" className="terminal-selection-action" aria-label="命令执行记录" aria-expanded={executionsVisible} onClick={() => setExecutionsVisible((value) => !value)}><Activity size={13} /><span>执行记录{executions.length ? ` ${executions.length}` : ""}</span></button>
        <button type="button" onClick={() => terminalRef.current?.scrollToBottom()} title="滚动到底部" aria-label="滚动到底部"><ChevronDown size={14} /></button>
        <button type="button" onClick={() => reconnectRef.current?.()} title="重新连接" aria-label="重新连接"><RefreshCw size={14} /></button>
        </>}
      </div>
      {executionsVisible && <section className="terminal-execution-popover" aria-label="本标签执行记录">
        <header><strong>本标签执行记录</strong><button type="button" className="icon-button" aria-label="关闭执行记录" onClick={() => setExecutionsVisible(false)}><X size={14} /></button></header>
        <TerminalExecutionList records={executions} connectionId={connectionIdRef.current}
          onAnalyze={(record) => { const context = executionAiContext(record); if (context !== null) { onAiRequestRef.current?.("diagnose", context, "execution"); setExecutionsVisible(false); } }}
          onSuggestNext={(record) => { const context = executionAiContext(record); if (context !== null) { setExecutionsVisible(false); terminalRef.current?.scrollToBottom(); suggestionsRef.current?.open({ goal: "根据这次命令的实际结果，给出下一步检查命令", output: context }); } }} />
      </section>}
      {connectionError && (
        <div className="terminal-connection-error" role="alert">
          <div className="connection-error-copy">
            <strong title={connectionError}>{connectionError}</strong>
          </div>
          <div className="connection-error-actions">
            <button type="button" className="connection-error-retry" onClick={() => reconnectRef.current?.()} title="重试连接"><RefreshCw size={13} />重试</button>
            {onDiagnose && <button type="button" onClick={() => onDiagnose(session)}>打开诊断</button>}
            {onEditSession && <button type="button" onClick={() => onEditSession(session)}>编辑会话</button>}
            <button type="button" onClick={() => setConnectionError(null)} aria-label="关闭连接错误"><X size={13} /></button>
          </div>
        </div>
      )}
      {!connectionError && connectionNotice && (
        <div className="terminal-connection-notice" role="status">
          <Activity size={13} />
          <span title={connectionNotice}>{connectionNotice}</span>
        </div>
      )}
      {authChallenge && (
        <div className="auth-challenge" role="dialog" aria-modal="true">
          <div className="auth-challenge-card">
            <strong>SSH 认证验证</strong>
            <span>服务器需要额外的交互式认证，请输入后继续。</span>
            {authChallenge.prompts.map((prompt, index) => (
              <label key={`${authChallenge.challengeId}:${index}`}>
                <span>{prompt.prompt || `验证项 ${index + 1}`}</span>
                <input
                  autoFocus={index === 0}
                  type={prompt.echo ? "text" : "password"}
                  value={authResponses[index] ?? ""}
                  onChange={(event) => setAuthResponses((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}
                  onKeyDown={(event) => { if (event.key === "Enter") void submitAuthChallenge(); }}
                />
              </label>
            ))}
            <div className="auth-challenge-actions">
              <button className="secondary-button" onClick={() => { setAuthChallenge(null); setAuthResponses([]); }}>取消</button>
              <button className="primary-button" onClick={() => void submitAuthChallenge()}>继续认证</button>
            </div>
          </div>
        </div>
      )}
      {searchVisible && (
        <div className="terminal-search">
          <Search size={14} />
          <input
            value={searchValue}
            onChange={(event) => {
              setSearchValue(event.target.value);
              runTerminalSearch("next", event.target.value, true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runTerminalSearch(event.shiftKey ? "previous" : "next", searchValue);
              }
              if (event.key === "Escape") closeTerminalSearch();
            }}
            placeholder="查找终端内容（Enter 下一个，Shift+Enter 上一个）"
            autoFocus
          />
          <span className="terminal-search-count">{searchResults ? `${searchResults.index + 1}/${searchResults.count}` : "0/0"}</span>
          <button onClick={() => runTerminalSearch("previous", searchValue)} title="上一个匹配（Shift+Enter）" aria-label="上一个匹配"><ChevronUp size={14} /></button>
          <button onClick={() => runTerminalSearch("next", searchValue)} title="下一个匹配（Enter）" aria-label="下一个匹配"><ChevronDown size={14} /></button>
          <button onClick={closeTerminalSearch} title="关闭搜索（Esc）" aria-label="关闭搜索"><X size={14} /></button>
        </div>
      )}
      <div className="xterm-host" ref={hostRef} />
      {visible && focused && !authChallenge && (
        <TerminalCommandSuggestions
          ref={suggestionsRef}
          sessionId={session.id}
          sessionName={session.name}
          shortcutsEnabled={IS_MACOS || preferences.terminalShortcutMode !== "remote-first"}
          snapshot={promptSnapshot}
          style={suggestionStyle}
          getSnapshot={readPromptSnapshot}
          getContext={() => terminalRef.current ? readRecentTerminalOutput(terminalRef.current.buffer.active) : ""}
          onAccept={acceptCommandSuggestion}
          onSetup={async (owner, isCurrent) => {
            const terminal = terminalRef.current;
            const prompt = readPromptSnapshot();
            if (!isCurrent() || !terminal || terminal.buffer.active.type !== "normal"
              || !sameTerminalPrompt(owner, prompt)
              || (prompt.integrated && (!prompt.ready || prompt.command !== ""))) {
              throw new Error("请先回到空白的 Bash / Zsh 提示符，再启用 Shell 集成。");
            }
            const confirmed = await confirmDialog({
              title: "启用 Shell 集成",
              message: <div className="shell-setup-confirm">
                <p>将在「{session.name}」的当前连接启用命令填入、执行结果识别和目录跟随。仅本次 Shell 生效，不修改远端配置文件。</p>
                <p>请确认终端正停在空白的 Bash / Zsh 提示符，当前没有程序正在运行或等待密码。</p>
                <details><summary>查看将执行的集成命令</summary><code>{SHELL_INTEGRATION_COMMAND}</code></details>
              </div>,
              confirmLabel: "确认启用",
            });
            if (!confirmed || !isCurrent()) return false;
            if (terminal !== terminalRef.current || !visibleRef.current || !setupShellRef.current) {
              throw new Error("原终端已关闭或切换，请回到目标终端后重试。");
            }
            terminal.scrollToBottom();
            await setupShellRef.current(owner);
            terminal.focus();
            return true;
          }}
          onFocusTerminal={() => terminalRef.current?.focus()}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              label: "复制",
              onClick: () =>
                void copyFromTerminal(terminalRef.current).catch((error) => {
                  terminalRef.current?.writeln(`\r\n\x1b[31m复制失败：${String(error)}\x1b[0m`);
                }),
            },
            {
              label: "粘贴",
              onClick: () =>
                void pasteIntoTerminal(terminalRef.current, preferencesRef.current.confirmMultiLinePaste, session.name, preferencesRef.current.copyOnSelect).catch((error) => {
                  terminalRef.current?.writeln(`\r\n\x1b[31m粘贴失败：${String(error)}\x1b[0m`);
                }),
            },
            {
              label: "复制全部",
              onClick: () => void copyAllTerminal().catch((error) => {
                terminalRef.current?.writeln(`\r\n\x1b[31m复制失败：${String(error)}\x1b[0m`);
              }),
            },
            { label: "查找", onClick: openTerminalSearch },
            { label: "AI 解释选区…", onClick: () => requestAiContext("explain"), separatorBefore: true },
            { label: "AI 分析选中的报错…", onClick: () => requestAiContext("diagnose") },
            { label: "清空屏幕", onClick: clearTerminal },
            { label: "滚到底部", onClick: () => terminalRef.current?.scrollToBottom() },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

async function copyFromTerminal(terminal: Terminal | null) {
  const selection = terminal?.getSelection();
  if (!selection) return;
  await writeClipboardText(selection);
}

async function pasteIntoTerminal(terminal: Terminal | null, confirmMultiLine: boolean, sessionName: string, copySelectionFirst = false) {
  if (!terminal) return;
  if (copySelectionFirst && terminal.hasSelection()) {
    const selection = terminal.getSelection();
    if (selection) await writeClipboardText(selection);
  }
  const text = await readClipboardText();
  if (!text) return;
  const lineCount = text.split(/\r?\n/).length;
  if (confirmMultiLine && lineCount > 3
    && !(await confirmDialog({
      title: "多行粘贴确认",
      message: `即将粘贴 ${lineCount} 行内容到 ${sessionName}，是否继续？`,
      confirmLabel: "粘贴",
    }))) return;
  terminal.paste(text);
  terminal.focus();
}

async function readClipboardText() {
  try {
    return await api.clipboardRead();
  } catch {
    // Keep a browser fallback for development mode and non-desktop hosts.
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Some WebKit builds only allow paste through the native DOM command.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  const pasted = document.execCommand("paste");
  const text = textarea.value;
  textarea.remove();
  if (!pasted && !text) throw new Error("系统剪贴板不可读");
  return text;
}

function createTextDecoder(encoding: string) {
  try {
    return new TextDecoder(encoding || "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

function terminalTheme(profileTheme: string, appTheme: AppPreferences["theme"]) {
  return resolveTerminalTheme(profileTheme, appTheme);
}
