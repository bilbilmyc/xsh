import { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, Pencil, RefreshCw, Square } from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import { EmbeddedDesktop } from "./EmbeddedDesktop";
import { api } from "../api";
import { hostKeyDialog } from "./DialogHost";
import { isTerminalEvent, remoteDesktopDefaultPort, type ForwardHealth, type ForwardInfo, type SavedSession, type TerminalEvent } from "../types";

interface RemoteDesktopPaneProps {
  session: SavedSession;
  visible: boolean;
  focused: boolean;
  connectionEnabled: boolean;
  onStateChange: (state: string) => void;
  onConnectionChange: (connectionId: string | null) => void;
  onFocus: () => void;
  onEditSession: (session: SavedSession) => void;
}

/** Owns the optional SSH transport and the application-embedded desktop. */
export function RemoteDesktopPane({
  session,
  visible,
  focused,
  connectionEnabled,
  onStateChange,
  onConnectionChange,
  onFocus,
  onEditSession,
}: RemoteDesktopPaneProps) {
  const profile = session.remoteDesktop ?? null;
  const profileIdentity = JSON.stringify([
    session.id, profile?.kind, profile?.transport, profile?.targetHost,
    profile?.targetPort, profile?.username, profile?.credentialRef, profile?.forwardProfileId,
  ]);
  const isDirect = profile?.transport === "direct";
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [currentState, setCurrentState] = useState<string>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [authChallenge, setAuthChallenge] = useState<{ challengeId: string; prompts: Array<{ prompt: string; echo: boolean }> } | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);
  const [forward, setForward] = useState<ForwardInfo | null>(null);
  const [forwardHealth, setForwardHealth] = useState<ForwardHealth | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [desktopEndpoint, setDesktopEndpoint] = useState<{ host: string; port: number } | null>(null);
  const [desktopState, setDesktopState] = useState("connecting");
  const desktopGeneration = useRef(0);
  const automaticDesktop = useRef<string | null>(null);

  const disposedRef = useRef(false);
  const generationRef = useRef(0);
  const connectionIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const reconnectAllowedRef = useRef(true);
  const wasConnectedRef = useRef(false);
  const stateRef = useRef(onStateChange);
  const connectionChangeRef = useRef(onConnectionChange);
  stateRef.current = onStateChange;
  connectionChangeRef.current = onConnectionChange;

  const reportState = useCallback((state: string) => {
    setCurrentState(state);
    stateRef.current(state);
  }, []);

  // The embedded protocol reports direct-session readiness after handshake.
  useEffect(() => {
    desktopGeneration.current++;
    setDesktopEndpoint(null);
    setViewerBusy(false);
    automaticDesktop.current = null;
  }, [profileIdentity]);

  useEffect(() => {
    if (!isDirect) return;
    reportState("connecting");
    connectionChangeRef.current(null);
    return () => {
      if (!disposedRef.current) reportState("disconnected");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, session.id]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      generationRef.current += 1;
      if (reconnectTimerRef.current !== undefined) window.clearTimeout(reconnectTimerRef.current);
      const id = connectionIdRef.current;
      if (id) void api.disconnectTerminal(id).catch(() => undefined);
    };
  }, [session.id]);

  useEffect(() => {
    if (connectionEnabled || !disposedRef.current) return;
    reportState("queued");
  }, [connectionEnabled, reportState]);

  const scheduleReconnect = useCallback((): boolean => {
    if (disposedRef.current || !session.autoReconnect || !reconnectAllowedRef.current || !wasConnectedRef.current) {
      return false;
    }
    if (reconnectTimerRef.current !== undefined) return true;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined;
      void connectRef.current?.();
    }, 5_000);
    reportState("reconnecting");
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.autoReconnect]);

  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const connect = useCallback(async () => {
    if (disposedRef.current || !connectionEnabledRef.current) {
      if (!connectionEnabledRef.current) reportState("queued");
      return;
    }
    const generation = ++generationRef.current;
    reconnectAllowedRef.current = true;
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    const previous = connectionIdRef.current;
    connectionIdRef.current = null;
    connectionChangeRef.current(null);
    setConnectionId(null);
    if (previous) void api.disconnectTerminal(previous).catch(() => undefined);

    const channel = new Channel<TerminalEvent | ArrayBuffer>();
    let pendingOutputBytes = 0;
    let acknowledgeTimer: number | undefined;
    const acknowledge = (bytes: number) => {
      // The hidden PTY emits only a banner and prompt; acknowledge in small
      // batches so the credit window can never stall the connection.
      pendingOutputBytes += bytes;
      if (acknowledgeTimer !== undefined || pendingOutputBytes < 256) return;
      acknowledgeTimer = window.setTimeout(() => {
        acknowledgeTimer = undefined;
        const id = connectionIdRef.current;
        const amount = pendingOutputBytes;
        pendingOutputBytes = 0;
        if (id && amount > 0) void api.terminalAcknowledgeOutput(id, amount).catch(() => undefined);
      }, 500);
    };
    channel.onmessage = (message) => {
      if (disposedRef.current || generation !== generationRef.current) return;
      if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
        acknowledge(message.byteLength);
        return;
      }
      if (!isTerminalEvent(message)) return;
      switch (message.type) {
        case "authChallenge":
          setAuthChallenge(message.payload);
          setAuthResponses(message.payload.prompts.map(() => ""));
          reportState("authenticating");
          break;
        case "stateChanged": {
          const state = typeof message.payload === "string" ? message.payload : "reconnecting";
          if (state === "connected") {
            wasConnectedRef.current = true;
            setConnectionError(null);
            setAuthChallenge(null);
          } else if (state === "disconnected") {
            connectionIdRef.current = null;
            connectionChangeRef.current(null);
            setConnectionId(null);
            setForward(null);
            setForwardHealth(null);
            if (scheduleReconnect()) break;
          }
          reportState(state);
          break;
        }
        case "hostKeyUnknown": {
          const key = message.payload;
          reconnectAllowedRef.current = false;
          void hostKeyDialog(key, "SSH").then((accepted) => {
            if (!accepted) return;
            void api.trustSessionHostKey(session.id, key)
              .then(() => {
                if (!disposedRef.current && generation === generationRef.current) void connect();
              })
              .catch((error) => {
                if (disposedRef.current || generation !== generationRef.current) return;
                setConnectionError(`Host Key 保存失败：${String(error)}`);
                reportState("failed");
              });
          });
          break;
        }
        case "hostKeyChanged":
          reconnectAllowedRef.current = false;
          setConnectionError(
            `安全警告：${message.payload.host}:${message.payload.port} 的服务器密钥已变化，连接已阻止`,
          );
          reportState("failed");
          break;
        case "error":
          setAuthChallenge(null);
          setConnectionError(message.payload);
          reportState("failed");
          scheduleReconnect();
          break;
        default:
          break;
      }
    };
    try {
      setConnectionError(null);
      reportState(wasConnectedRef.current ? "reconnecting" : "connecting");
      const id = await api.connectTerminal(session.id, 80, 24, channel);
      if (disposedRef.current || generation !== generationRef.current) {
        await api.disconnectTerminal(id).catch(() => undefined);
        return;
      }
      connectionIdRef.current = id;
      connectionChangeRef.current(id);
      setConnectionId(id);
    } catch (error) {
      if (disposedRef.current || generation !== generationRef.current) return;
      setConnectionError(`连接失败：${String(error)}`);
      reportState("failed");
      scheduleReconnect();
    }
  }, [session.id, reportState, scheduleReconnect]);

  connectRef.current = connect;
  const connectionEnabledRef = useRef(connectionEnabled);
  connectionEnabledRef.current = connectionEnabled;

  useEffect(() => {
    if (!isDirect && connectionEnabled) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionEnabled, session.id, isDirect]);

  const refreshForward = useCallback(async () => {
    const id = connectionIdRef.current;
    const forwardProfileId = profile?.forwardProfileId ?? null;
    if (!id || !forwardProfileId) return;
    try {
      const running = (await api.listForwards(id)).find((item) => item.profileId === forwardProfileId) ?? null;
      setForward(running);
      setForwardHealth(running ? await api.getForwardHealth(id, running.forwardId).catch(() => null) : null);
    } catch {
      // Connection dropped mid-poll; the state events drive the UI instead.
    }
  }, [profile?.forwardProfileId]);

  useEffect(() => {
    if (!connectionId) return;
    void refreshForward();
    const interval = window.setInterval(() => void refreshForward(), 10_000);
    return () => window.clearInterval(interval);
  }, [connectionId, refreshForward]);

  const openInAppViewer = async () => {
    if (!profile) return;
    const generation = ++desktopGeneration.current;
    setViewerBusy(true);
    setViewerError(null);
    try {
      let host = profile.targetHost;
      let port = profile.targetPort ?? remoteDesktopDefaultPort(profile.kind);
      if (!isDirect) {
        const id = connectionIdRef.current;
        if (!id) throw new Error("SSH 加密通道尚未就绪。");
        const launch = await api.startRemoteDesktop(id, profile);
        if (disposedRef.current || generation !== desktopGeneration.current) return;
        setForward(launch.forward);
        host = launch.forward.bindHost;
        port = launch.forward.bindPort;
        void refreshForward();
      }
      if (disposedRef.current || generation !== desktopGeneration.current) return;
      setDesktopState("connecting");
      setDesktopEndpoint({ host, port });
    } catch (caught) {
      if (!disposedRef.current && generation === desktopGeneration.current) {
        setViewerError(String(caught));
        if (isDirect) reportState("failed");
      }
    } finally {
      if (!disposedRef.current && generation === desktopGeneration.current) setViewerBusy(false);
    }
  };

  const detachInAppViewer = () => {
    desktopGeneration.current++;
    setDesktopEndpoint(null);
    setViewerBusy(false);
    setDesktopState("disconnected");
    if (isDirect) reportState("disconnected");
  };

  useEffect(() => {
    if (!isDirect && currentState !== "connected") {
      desktopGeneration.current++;
      setDesktopEndpoint(null);
      setViewerBusy(false);
    }
  }, [isDirect, currentState]);

  useEffect(() => {
    const identity = isDirect ? profileIdentity : `${connectionId ?? ""}:${profileIdentity}`;
    if (!isDirect && !connectionId) return;
    if (!connectionEnabled || !identity || (!isDirect && currentState !== "connected") || automaticDesktop.current === identity) return;
    automaticDesktop.current = identity;
    void openInAppViewer();
    // The desktop connects once per transport connection. Manual close stays closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirect, profileIdentity, connectionId, currentState, connectionEnabled]);

  const stopTunnel = async () => {
    if (!connectionId || !forward) return;
    detachInAppViewer();
    setViewerBusy(true);
    setViewerError(null);
    try {
      await api.stopForward(connectionId, forward.forwardId);
      setForward(null);
      setForwardHealth(null);
    } catch (caught) {
      setViewerError(String(caught));
    } finally {
      setViewerBusy(false);
    }
  };

  const submitAuth = async () => {
    if (!connectionId || !authChallenge) return;
    const responses = authResponses;
    setAuthChallenge(null);
    setAuthResponses([]);
    try {
      await api.terminalRespondAuth(connectionId, authChallenge.challengeId, responses);
    } catch (caught) {
      setConnectionError(`认证响应发送失败：${String(caught)}`);
      reportState("failed");
    }
  };

  const displayedState = desktopEndpoint ? desktopState : currentState;
  const stateLabel = stateLabels[displayedState] ?? displayedState;
  const defaultPort = profile ? remoteDesktopDefaultPort(profile.kind) : 5900;
  const targetLine = profile
    ? `${profile.kind === "vnc" ? "VNC" : "RDP"} → ${profile.targetHost}:${profile.targetPort ?? defaultPort}`
    : null;

  return (
    <section
      className={`rd-pane ${visible ? "" : "pane-hidden"} ${focused ? "focused" : ""} ${desktopEndpoint ? "viewer-active" : ""}`}
      onMouseDown={onFocus}
      aria-label={`远程桌面 ${session.name}`}
    >
      <header className="rd-pane-header">
        <span className={`connection-dot ${displayedState}`} />
        <Monitor size={16} />
        <div className="rd-pane-title">
          <strong>{session.name}</strong>
          <small>{stateLabel}{targetLine ? ` · ${targetLine}` : ""}</small>
        </div>
        <div className="rd-pane-actions">
          <button className="icon-button" onClick={() => onEditSession(session)} title="编辑远程桌面配置"><Pencil size={14} /></button>
          {!isDirect && (currentState === "connected"
            ? <button className="secondary-button" onClick={() => { if (connectionIdRef.current) void api.disconnectTerminal(connectionIdRef.current).catch(() => undefined); }}><Square size={13} />断开</button>
            : <button className="secondary-button" onClick={() => void connect()} disabled={currentState === "connecting" || currentState === "reconnecting"}><RefreshCw size={13} />{currentState === "failed" || currentState === "disconnected" ? "重新连接" : "连接"}</button>)}
        </div>
      </header>

      <div className="rd-pane-body">
        <section className="rd-card">
          <div className="rd-card-heading">
            <strong>{isDirect ? "直连" : "SSH 加密通道"}</strong>
            <span>{isDirect
              ? "查看器直接连接目标地址，不经过 SSH。"
              : `远程桌面流量全部经由 ${session.username}@${session.host}${session.port === 22 ? "" : `:${session.port}`} 转发。`}</span>
          </div>
          {authChallenge && (
            <div className="rd-auth-form">
              {authChallenge.prompts.map((prompt, index) => (
                <label className="field" key={index}>
                  <span>{prompt.prompt || "认证响应"}</span>
                  <input
                    type={prompt.echo ? "text" : "password"}
                    value={authResponses[index] ?? ""}
                    onChange={(event) => setAuthResponses((current) => current.map((value, position) => position === index ? event.target.value : value))}
                    onKeyDown={(event) => { if (event.key === "Enter") void submitAuth(); }}
                    autoFocus={index === 0}
                  />
                </label>
              ))}
              <button className="primary-button" onClick={() => void submitAuth()}>提交</button>
            </div>
          )}
          {connectionError && <div className="form-error" role="alert">{connectionError}</div>}
          {!authChallenge && !connectionError && (
            <p className="rd-hint">{isDirect
              ? "点击下方按钮连接内置远程桌面。"
              : stateHints[currentState] ?? ""}</p>
          )}
        </section>

        {profile && !desktopEndpoint && (
          <section className="rd-card">
            <div className="rd-card-heading"><strong>内置远程桌面</strong><span>VNC 和 RDP 均在 XSH 内连接和操作。</span></div>
            {!isDirect && <div className="rd-tunnel-status">{forward
              ? <><span className="rd-tunnel-address">{forward.bindHost}:{forward.bindPort} → {forward.targetHost ?? profile.targetHost}:{forward.targetPort ?? defaultPort}</span><small className="forward-health" title={forwardHealth?.detail}>{forwardHealth?.status === "running" ? "隧道监听中" : "状态未知"}</small></>
              : <span className="rd-tunnel-idle">隧道未运行</span>}
            </div>}
            {viewerError && <div className="form-error" role="alert">{viewerError}</div>}
            <div className="rd-viewer-actions">
              <button className="primary-button" disabled={viewerBusy || (!isDirect && !connectionId)} onClick={() => void openInAppViewer()}><Monitor size={14} />连接桌面</button>
              {!isDirect && forward && <button className="secondary-button" disabled={viewerBusy} onClick={() => void stopTunnel()}>停止隧道</button>}
            </div>
          </section>
        )}
        {profile && desktopEndpoint && <section className="rd-viewer-card">
          <EmbeddedDesktop profile={profile} host={desktopEndpoint.host} port={desktopEndpoint.port} connectionId={connectionId} visible={visible} autoReconnect={session.autoReconnect}
            onStateChange={(state) => { setDesktopState(state); if (isDirect) reportState(state); else stateRef.current(state); }}
            onClose={detachInAppViewer} />
        </section>}

      </div>
    </section>
  );
}

const stateLabels: Record<string, string> = {
  connecting: "正在建立加密通道",
  authenticating: "等待认证",
  connected: "已连接",
  reconnecting: "连接中断，正在重连",
  disconnected: "已断开",
  failed: "连接失败",
  queued: "排队等待连接",
  "waiting-network": "等待网络恢复",
};

const stateHints: Record<string, string> = {
  connecting: "正在连接 SSH 服务器并建立 VNC/RDP 加密隧道…",
  authenticating: "请在上方输入认证信息。",
  connected: "加密通道已就绪。",
  reconnecting: "5 秒后自动重连，恢复加密通道和内置桌面。",
  disconnected: "连接已断开。",
  failed: "连接失败，可点击右上角重新连接。",
  queued: "等待可用连接名额…",
  "waiting-network": "网络不可用，恢复后自动继续。",
};
