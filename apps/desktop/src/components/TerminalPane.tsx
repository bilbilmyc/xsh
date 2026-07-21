import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { Activity, ChevronDown, Copy, Eraser, FileText, Minus, Plus, RefreshCw, Search, X } from "lucide-react";
import { api } from "../api";
import { ContextMenu } from "./ContextMenu";
import type { AppPreferences } from "../preferences";
import type { SavedSession, TerminalEvent } from "../types";
import { normalizeTerminalCommand } from "../terminal-command";
import "@xterm/xterm/css/xterm.css";

export interface TerminalCommandRequest {
  id: string;
  text: string;
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
  onCommandResult: (result: { id: string; ok: boolean; error?: string }) => void;
  onEditSession?: (session: SavedSession) => void;
  onDiagnose?: (session: SavedSession) => void;
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
  onEditSession,
  onDiagnose,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connectionIdRef = useRef<string | null>(null);
  const connectionEnabledRef = useRef(connectionEnabled);
  connectionEnabledRef.current = connectionEnabled;
  const reconnectRef = useRef<(() => void) | null>(null);
  const lastCommandIdRef = useRef<string | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [authChallenge, setAuthChallenge] = useState<{ challengeId: string; prompts: Array<{ prompt: string; echo: boolean }> } | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const logRef = useRef<string[]>([]);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const sessionFontEnabled = preferences.useSessionTerminalFont;
  const baseFontSize = sessionFontEnabled ? session.terminal.fontSize || preferences.terminalFontSize : preferences.terminalFontSize;
  const [currentFontSize, setCurrentFontSize] = useState(baseFontSize);
  const currentFontSizeRef = useRef(baseFontSize);

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
    let pendingOutput: Uint8Array[] = [];
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
    let pendingInput: number[] = [];
    let connectGeneration = 0;
    let reconnectAttempt = 0;
    let wasConnected = false;
    let reconnectAllowed = true;
    let networkOnline = navigator.onLine !== false;
    let connectPendingForNetwork = false;
    let currentState = "connecting";
    let lastWakeCheckAt = Date.now();
    setConnectionError(null);
    setConnectionNotice(null);
    logRef.current = [[
      "XSH Session Log",
      `Session: ${session.name}`,
      `Host: ${session.username}@${session.host}:${session.port}`,
      `Started: ${new Date().toISOString()}`,
      "",
    ].join("\n")];

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
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(host);

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
    const flushOutput = (drainAll = false) => {
      outputFlushFrame = undefined;
      if (disposed) return;
      const startedAt = performance.now();
      const budget = drainAll ? Number.MAX_SAFE_INTEGER : outputFrameBudgetBytes;
      let bytesToWrite = Math.min(pendingOutputBytes, budget);
      if (bytesToWrite <= 0) {
        reportOutputStats();
        return;
      }

      const firstChunk = pendingOutput[pendingOutputHead];
      if (firstChunk && firstChunk.length <= bytesToWrite && pendingOutputHead === pendingOutput.length - 1) {
        terminal.write(firstChunk);
        pendingOutputHead += 1;
        pendingOutputBytes -= firstChunk.length;
        bytesToWrite = firstChunk.length;
      } else {
        const merged = new Uint8Array(bytesToWrite);
        let offset = 0;
        while (offset < bytesToWrite) {
          const chunk = pendingOutput[pendingOutputHead];
          if (!chunk) break;
          const chunkBytes = Math.min(chunk.length, bytesToWrite - offset);
          merged.set(chunk.subarray(0, chunkBytes), offset);
          offset += chunkBytes;
          pendingOutputBytes -= chunkBytes;
          if (chunkBytes === chunk.length) {
            pendingOutputHead += 1;
          } else {
            pendingOutput[pendingOutputHead] = chunk.subarray(chunkBytes);
          }
        }
        bytesToWrite = offset;
        if (bytesToWrite > 0) terminal.write(merged.subarray(0, bytesToWrite));
      }

      compactPendingOutput();
      flushCountSinceSample += 1;
      flushBytesSinceSample += bytesToWrite;
      flushDurationSinceSample += performance.now() - startedAt;
      reportOutputStats();
      if (!disposed && pendingOutputBytes > 0 && !drainAll) {
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
    const queueOutput = (payload: number[]) => {
      const chunk = Uint8Array.from(payload);
      if (chunk.length === 0) return;
      pendingOutput.push(chunk);
      pendingOutputBytes += chunk.length;
      outputBytesSinceSample += chunk.length;
      outputChunksSinceSample += 1;
      reportOutputStats();
      if (outputFlushFrame === undefined) {
        outputFlushFrame = window.requestAnimationFrame(() => flushOutput(false));
      }
    };

    const flushInput = () => {
      inputTimer = undefined;
      const connectionId = connectionIdRef.current;
      if (!connectionId || pendingInput.length === 0) return;
      const data = pendingInput;
      pendingInput = [];
      void api.terminalWrite(connectionId, data).catch((error) => {
        terminal.writeln(`\r\n\x1b[31m输入发送失败：${String(error)}\x1b[0m`);
      });
    };
    const queueBytes = (bytes: Uint8Array) => {
      pendingInput.push(...bytes);
      if (pendingInput.length >= 4096) flushInput();
      else if (inputTimer === undefined) inputTimer = window.setTimeout(flushInput, 8);
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

    const pasteText = (text: string) => {
      if (!text) return;
      const lineCount = text.split(/\r?\n/).length;
      if (preferencesRef.current.confirmMultiLinePaste && lineCount > 3 && !window.confirm(`即将粘贴 ${lineCount} 行内容到 ${session.name}，是否继续？`)) return;
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
        if (text) pasteText(text);
      } finally {
        pasteInFlight = false;
      }
    };

    const isMac = /mac|iphone|ipad/i.test(`${navigator.platform} ${navigator.userAgent}`);
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
      const copy = isCopyShortcut(event);
      const paste = isPasteShortcut(event);
      const search = isSearchShortcut(event);
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
      if (preferencesRef.current.rightClickAction === "paste") {
        setContextMenu(null);
        void safePaste().catch((error) => {
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
        pasteText(text);
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
      if (!preferencesRef.current.copyOnSelect || !terminal.hasSelection()) return;
      if (selectionCopyTimer !== undefined) window.clearTimeout(selectionCopyTimer);
      selectionCopyTimer = window.setTimeout(() => {
        selectionCopyTimer = undefined;
        const selection = terminal.getSelection();
        if (selection) void writeClipboardText(selection).catch(() => undefined);
      }, 120);
    });
    const dataDisposable = terminal.onData((data) => {
      queueBytes(new TextEncoder().encode(data));
    });
    const binaryDisposable = terminal.onBinary((data) => {
      queueBytes(Uint8Array.from(data, (character) => character.charCodeAt(0)));
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
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
        void connect(false);
      }, delay);
      return true;
    };

    const connect = async (trustUnknownHost: boolean) => {
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
      connectionIdRef.current = null;
      onConnectionChange?.(null);
      if (previousConnectionId) {
        void api.disconnectTerminal(previousConnectionId).catch(() => undefined);
      }

      const channel = new Channel<TerminalEvent>();
      channel.onmessage = (event) => {
        if (disposed || generation !== connectGeneration) return;
        switch (event.type) {
          case "output": {
            const output = outputDecoder.decode(new Uint8Array(event.payload), { stream: true });
            logRef.current.push(output);
            queueOutput(event.payload);
            break;
          }
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
              connectionIdRef.current = null;
              onConnectionChange?.(null);
              if (scheduleReconnect()) break;
            }
            reportState(state);
            break;
          }
          case "hostKeyUnknown": {
            const key = event.payload;
            if (!trustUnknownHost) {
              reconnectAllowed = false;
              const accepted = window.confirm(
                `首次连接 ${key.host}:${key.port}\n\n${key.keyType}\n${key.fingerprint}\n\n是否信任并保存此服务器密钥？`,
              );
              if (accepted) void connect(true);
            }
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
          trustUnknownHost,
          channel,
        );
        if (disposed || generation !== connectGeneration) {
          await api.disconnectTerminal(id).catch(() => undefined);
          return;
        }
        connectionIdRef.current = id;
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
        void connect(false);
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
        void connect(false);
        return;
      }
      if (connectionId) {
        void api.terminalResize(connectionId, Math.max(terminal.cols, 1), Math.max(terminal.rows, 1))
          .catch(() => {
            if (!disposed && session.autoReconnect && reconnectAllowed) void connect(false);
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
        void connect(false);
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
      void connect(false);
    };
    if (connectionEnabledRef.current) void connect(false);
    else {
      setConnectionNotice("等待连接资源…");
      reportState("queued");
    }

    return () => {
      disposed = true;
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
      resizeObserver.disconnect();
      setContextMenu(null);
      host.removeEventListener("contextmenu", nativeContextMenu, true);
      host.removeEventListener("keydown", nativeKeydown, true);
      host.removeEventListener("copy", nativeCopy, true);
      host.removeEventListener("paste", nativePaste, true);
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
    void api.terminalWrite(connectionId, Array.from(new TextEncoder().encode(text)))
      .then(() => {
        terminal?.focus();
        onCommandResult({ id: command.id, ok: true });
      })
      .catch((error) => {
        terminal?.writeln(`\r\n\x1b[31m命令发送失败：${String(error)}\x1b[0m`);
        onCommandResult({ id: command.id, ok: false, error: String(error) });
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

  const saveLog = async () => {
    const targetPath = await save({
      title: "保存终端日志",
      defaultPath: `${session.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: "Log file", extensions: ["log", "txt"] }],
    });
    if (!targetPath) return;
    try {
      await api.writeTextFile(targetPath, logRef.current.join(""));
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
      onPointerDownCapture={() => onFocus?.()}
    >
      <div className="terminal-toolbar" role="toolbar" aria-label="终端工具栏">
        <button type="button" onClick={() => applyTerminalFontSize(currentFontSize - 1)} title="缩小当前终端字号（macOS ⌘- / Windows Ctrl+Shift+-）" aria-label="缩小当前终端字号"><Minus size={14} /></button>
        <button type="button" className="terminal-font-size-reset" onClick={() => applyTerminalFontSize(preferences.useSessionTerminalFont ? session.terminal.fontSize || preferences.terminalFontSize : preferences.terminalFontSize)} title="恢复当前终端字号（macOS ⌘0 / Windows Ctrl+Shift+0）" aria-label="恢复当前终端字号">{currentFontSize}</button>
        <button type="button" onClick={() => applyTerminalFontSize(currentFontSize + 1)} title="放大当前终端字号（macOS ⌘+ / Windows Ctrl+Shift++）" aria-label="放大当前终端字号"><Plus size={14} /></button>
        <button type="button" onClick={openTerminalSearch} title="查找终端内容（macOS ⌘F / Windows Ctrl+Shift+F）" aria-label="查找终端内容"><Search size={14} /></button>
        <button type="button" onClick={() => void copyAllTerminal()} title="复制全部终端内容" aria-label="复制全部终端内容"><Copy size={14} /></button>
        <button type="button" onClick={() => void saveLog()} title="保存终端日志" aria-label="保存终端日志"><FileText size={14} /></button>
        <button type="button" onClick={clearTerminal} title="清空本地终端屏幕" aria-label="清空本地终端屏幕"><Eraser size={14} /></button>
        <button type="button" onClick={() => terminalRef.current?.scrollToBottom()} title="滚动到底部" aria-label="滚动到底部"><ChevronDown size={14} /></button>
        <button type="button" onClick={() => reconnectRef.current?.()} title="重新连接" aria-label="重新连接"><RefreshCw size={14} /></button>
      </div>
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
              searchAddonRef.current?.findNext(event.target.value, { incremental: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") searchAddonRef.current?.findNext(searchValue);
              if (event.key === "Escape") setSearchVisible(false);
            }}
            placeholder="查找终端内容"
            autoFocus
          />
          <button onClick={() => setSearchVisible(false)}><X size={14} /></button>
        </div>
      )}
      <div className="xterm-host" ref={hostRef} />
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
                void pasteIntoTerminal(terminalRef.current, preferencesRef.current.confirmMultiLinePaste, session.name).catch((error) => {
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

async function pasteIntoTerminal(terminal: Terminal | null, confirmMultiLine: boolean, sessionName: string) {
  if (!terminal) return;
  const text = await readClipboardText();
  if (!text) return;
  const lineCount = text.split(/\r?\n/).length;
  if (confirmMultiLine && lineCount > 3 && !window.confirm(`即将粘贴 ${lineCount} 行内容到 ${sessionName}，是否继续？`)) return;
  terminal.paste(text);
  terminal.focus();
}

async function writeClipboardText(text: string) {
  try {
    await api.clipboardWrite(text);
    return;
  } catch {
    // Keep a browser fallback for development mode and non-desktop hosts.
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the user-gesture based DOM fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("系统剪贴板不可用");
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
  const theme = profileTheme === "xsh-dark" ? appTheme : profileTheme.replace(/^xsh-/, "");
  if (theme === "green") {
    return {
      background: "#07130b", foreground: "#b7f3c5", cursor: "#7ee787", cursorAccent: "#07130b",
      selectionBackground: "#1f5d35", black: "#07130b", red: "#ff8278", green: "#7ee787",
      yellow: "#d7e88b", blue: "#83b8ff", magenta: "#d2a8ff", cyan: "#72e0c3", white: "#d9f7df",
      brightBlack: "#52735b", brightRed: "#ffa198", brightGreen: "#aff5b4", brightYellow: "#f2cc60",
      brightBlue: "#a5c8ff", brightMagenta: "#e2c5ff", brightCyan: "#a5f3d5", brightWhite: "#ffffff",
    };
  }
  if (theme === "blue") {
    return {
      background: "#07111f", foreground: "#dbeafe", cursor: "#7dd3fc", cursorAccent: "#07111f",
      selectionBackground: "#1d4e73", black: "#07111f", red: "#ff8b80", green: "#8be9a3",
      yellow: "#f0d58a", blue: "#7db7ff", magenta: "#d0b2ff", cyan: "#70e0ee", white: "#e2efff",
      brightBlack: "#62758e", brightRed: "#ffb0a8", brightGreen: "#b6f5c3", brightYellow: "#ffe3a3",
      brightBlue: "#b0d4ff", brightMagenta: "#e4d2ff", brightCyan: "#b4f4ff", brightWhite: "#ffffff",
    };
  }
  if (theme === "light") {
    return {
      background: "#ffffff", foreground: "#17212b", cursor: "#087ea4", cursorAccent: "#ffffff",
      selectionBackground: "#b9e4f2", black: "#17212b", red: "#c62828", green: "#16794c",
      yellow: "#8a5a00", blue: "#1769aa", magenta: "#7b3fb2", cyan: "#087ea4", white: "#eef2f5",
      brightBlack: "#687784", brightRed: "#b71c1c", brightGreen: "#11663f", brightYellow: "#795000",
      brightBlue: "#125a91", brightMagenta: "#642f92", brightCyan: "#05657f", brightWhite: "#17212b",
    };
  }
  const background = theme === "graphite" ? "#111315" : theme === "dusk" ? "#100f18" : "#0b0f14";
  return {
    background, foreground: "#e5ebf1", cursor: "#7dd3fc", cursorAccent: background,
    selectionBackground: "#285b78", black: "#111820", red: "#ff7b72", green: "#7ee787",
    yellow: "#e3b341", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#56d4dd", white: "#d7dde5",
    brightBlack: "#7d8590", brightRed: "#ffa198", brightGreen: "#aff5b4", brightYellow: "#f2cc60",
    brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#a5d6ff", brightWhite: "#ffffff",
  };
}
