import { useEffect, useRef, useState } from "react";
import { Clipboard, Copy, Expand, Keyboard, Monitor, RefreshCw, X } from "lucide-react";
import { Channel } from "@tauri-apps/api/core";
import RFB from "@novnc/novnc";
import { api } from "../api";
import { decodeDesktopPacket, desktopKey, desktopPoint, desktopSize, desktopWheel } from "../desktop-protocol";
import type { DesktopCursor } from "../desktop-protocol";
import { promptDialog } from "./DialogHost";
import type { RdpCertificateChallenge, RdpEvent, RdpInput, RemoteDesktopProfile } from "../types";
import "./embedded-desktop.css";

interface Props {
  profile: RemoteDesktopProfile;
  host: string;
  port: number;
  connectionId?: string | null;
  visible?: boolean;
  autoReconnect?: boolean;
  onStateChange?: (state: string) => void;
  onClose: () => void;
}

export function EmbeddedDesktop({ profile, host, port, connectionId = null, visible = true, autoReconnect = false, onStateChange, onClose }: Props) {
  const [state, setState] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fit, setFit] = useState(true);
  const [autoResize, setAutoResize] = useState(false);
  const [remoteSize, setRemoteSize] = useState({ width: 1280, height: 720 });
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });
  const [credentials, setCredentials] = useState<"vnc" | "rdp" | null>(null);
  const [username, setUsername] = useState(profile.username ?? "");
  const [password, setPassword] = useState("");
  const [certificate, setCertificate] = useState<RdpCertificateChallenge | null>(null);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState({ clipboard: false, resize: false, maxPixels: 4096 * 2160 });
  const [cursor, setCursor] = useState<DesktopCursor>({ kind: "default" });
  const rootRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const rdpRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  const stateCallback = useRef(onStateChange);
  const startRdpRef = useRef<(username: string, password: string | null) => void>(() => undefined);
  const pressed = useRef(new Map<string, { scan: number; extended: boolean }>());
  const mouseButtons = useRef(new Set<number>());
  const lastPoint = useRef({ x: 0, y: 0 });
  const pointerPaint = useRef<number | undefined>(undefined);
  const hadConnected = useRef(false);
  stateRef.current = state;
  stateCallback.current = onStateChange;

  const report = (value: string, message?: string | null) => {
    setState(value);
    if (value === "connected") hadConnected.current = true;
    stateRef.current = value;
    stateCallback.current?.(value);
    if (message) setError(message);
  };

  const send = (input: RdpInput) => {
    const id = rdpRef.current;
    if (id && stateRef.current === "connected") {
      void api.rdpDesktopInput(id, input).catch((caught) => {
        if (rdpRef.current !== id || stateRef.current !== "connected") return;
        if (input.type === "resize" || input.type === "clipboard" || input.type === "text") {
          setNotice(`操作未发送：${String(caught)}`);
          return;
        }
        // A rejected key-up must not leave a modifier stuck on the server.
        report("failed", `桌面输入中断，请重新连接：${String(caught)}`);
        void api.closeRdpDesktop(id).catch(() => undefined);
      });
    }
  };

  const releaseInput = () => {
    if (pointerPaint.current !== undefined) cancelAnimationFrame(pointerPaint.current);
    pointerPaint.current = undefined;
    for (const key of pressed.current.values()) send({ type: "key", ...key, down: false });
    pressed.current.clear();
    for (const flag of mouseButtons.current) send({ type: "mouse", flags: flag, ...lastPoint.current });
    mouseButtons.current.clear();
  };

  useEffect(() => {
    let disposed = false;
    let bridgePort: number | null = null;
    let nativeId: string | null = null;
    let paint: number | undefined;
    let pendingAck: number | null = null;
    let starting = false;
    let protocolFailed = false;
    const failProtocol = (message: string) => {
      protocolFailed = true;
      report("failed", message);
      if (nativeId) void api.closeRdpDesktop(nativeId).catch(() => undefined);
    };
    setError(null);
    setCertificate(null);
    setCredentials(null);
    setRemoteClipboard(null);
    setNotice(null);
    setCapabilities({ clipboard: false, resize: false, maxPixels: 4096 * 2160 });
    setCursor({ kind: "default" });
    report("connecting");
    const initial = desktopSize(hostRef.current?.clientWidth ?? 1280, hostRef.current?.clientHeight ?? 720);

    const startRdp = async (login: string, secret: string | null) => {
      if (disposed || starting || nativeId) return;
      starting = true;
      setCredentials(null);
      setPassword("");
      report("connecting");
      const channel = new Channel<RdpEvent | ArrayBuffer>();
      channel.onmessage = (message) => {
        if (disposed || protocolFailed) return;
        if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
          try {
            const packet = decodeDesktopPacket(message);
            if (packet.type === "cursor") { setCursor(packet.cursor); return; }
            const frame = packet.frame;
            const render = () => {
              paint = undefined;
              if (disposed) return;
              try {
                const canvas = canvasRef.current;
                if (!canvas) throw new Error("远程桌面画布已关闭。");
                if (canvas.width !== frame.width || canvas.height !== frame.height) {
                  canvas.width = frame.width;
                  canvas.height = frame.height;
                  setRemoteSize({ width: frame.width, height: frame.height });
                  setNotice((current) => current?.startsWith("已请求 ") ? `桌面已调整为 ${frame.width} × ${frame.height}` : current);
                }
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("无法创建远程桌面画布。");
                context.putImageData(new ImageData(frame.pixels, frame.dirtyWidth, frame.dirtyHeight), frame.x, frame.y);
                if (nativeId) void api.acknowledgeRdpFrame(nativeId, frame.sequence).catch(() => undefined);
                else pendingAck = frame.sequence;
              } catch (caught) {
                failProtocol(String(caught));
              }
            };
            paint = requestAnimationFrame(render);
          } catch (caught) {
            failProtocol(String(caught));
          }
          return;
        }
        if (message.type === "stateChanged") {
          report(message.payload.state, message.payload.message);
          if (message.payload.state !== "connected") {
            setCursor({ kind: "default" });
            pressed.current.clear();
            mouseButtons.current.clear();
          }
        } else if (message.type === "certificate") {
          setCertificate(message.payload);
          report("authenticating");
        } else if (message.type === "clipboard") {
          setRemoteClipboard(message.payload.text);
        } else if (message.type === "capabilities") {
          setCapabilities(message.payload);
        } else if (message.type === "warning") {
          setNotice(message.payload.message);
        }
      };
      try {
        const id = await api.startRdpDesktop(profile, connectionId, login, secret, initial.width, initial.height, channel);
        if (disposed || protocolFailed) { void api.closeRdpDesktop(id).catch(() => undefined); return; }
        nativeId = id;
        rdpRef.current = id;
        if (pendingAck !== null) void api.acknowledgeRdpFrame(id, pendingAck).catch(() => undefined);
      } catch (caught) {
        if (!disposed) report("failed", String(caught));
      } finally {
        starting = false;
      }
    };
    startRdpRef.current = (login, secret) => { void startRdp(login, secret); };

    if (profile.kind === "rdp") {
      if (!profile.username || !profile.credentialRef) {
        setCredentials("rdp");
        report("authenticating");
      } else {
        void startRdp(profile.username, null);
      }
    } else {
      void (async () => {
        try {
          const bridge = await api.openRemoteDesktopWsBridge(host, port);
          if (disposed) { void api.closeRemoteDesktopWsBridge(bridge.port).catch(() => undefined); return; }
          bridgePort = bridge.port;
          const savedPassword = profile.credentialRef ? await api.getRemoteDesktopPassword(profile.credentialRef) : undefined;
          if (disposed || !hostRef.current) return;
          const rfb = new RFB(hostRef.current, `ws://127.0.0.1:${bridge.port}/${bridge.token}`, {
            credentials: { username: profile.username ?? undefined, password: savedPassword },
          });
          rfbRef.current = rfb;
          rfb.scaleViewport = true;
          rfb.resizeSession = false;
          rfb.background = "#0b0f14";
          rfb.addEventListener("connect", () => { if (!disposed) report("connected"); });
          rfb.addEventListener("disconnect", () => {
            if (!disposed && stateRef.current !== "failed") report("disconnected");
          });
          rfb.addEventListener("credentialsrequired", () => {
            if (!disposed) { setCredentials("vnc"); report("authenticating"); }
          });
          rfb.addEventListener("securityfailure", (event) => {
            const detail = (event as CustomEvent<{ reason?: string }>).detail;
            if (!disposed) report("failed", `VNC 认证失败：${detail?.reason ?? "服务器拒绝了登录信息"}。`);
          });
          rfb.addEventListener("clipboard", (event) => {
            const text = (event as CustomEvent<{ text: string }>).detail.text;
            if (!disposed && text.length <= 1024 * 1024 && new TextEncoder().encode(text).length <= 1024 * 1024) setRemoteClipboard(text);
          });
        } catch (caught) {
          if (!disposed) report("failed", String(caught));
          if (bridgePort !== null) void api.closeRemoteDesktopWsBridge(bridgePort).catch(() => undefined);
          bridgePort = null;
        }
      })();
    }
    return () => {
      releaseInput();
      disposed = true;
      if (paint !== undefined) cancelAnimationFrame(paint);
      rfbRef.current?.disconnect();
      rfbRef.current = null;
      rdpRef.current = null;
      if (bridgePort !== null) void api.closeRemoteDesktopWsBridge(bridgePort).catch(() => undefined);
      if (nativeId) void api.closeRdpDesktop(nativeId).catch(() => undefined);
      startRdpRef.current = () => undefined;
    };
    // Protocol identity changes create a new connection; visibility does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.kind, profile.transport, profile.targetHost, profile.targetPort, profile.credentialRef, profile.username, host, port, connectionId, attempt]);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      const size = { width: hostElement.clientWidth, height: hostElement.clientHeight };
      setViewportSize(size);
      if (timer !== undefined) window.clearTimeout(timer);
      if (autoResize && profile.kind === "rdp" && capabilities.resize && state === "connected" && size.width >= 200 && size.height >= 200) {
        timer = window.setTimeout(() => send({ type: "resize", ...desktopSize(size.width, size.height, capabilities.maxPixels) }), 250);
      }
    });
    observer.observe(hostElement);
    return () => { observer.disconnect(); if (timer !== undefined) window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResize, profile.kind, state, capabilities.resize, capabilities.maxPixels]);

  useEffect(() => {
    if (rfbRef.current) { rfbRef.current.scaleViewport = fit; rfbRef.current.resizeSession = autoResize; }
  }, [fit, autoResize, state]);
  useEffect(() => {
    window.addEventListener("blur", releaseInput);
    return () => window.removeEventListener("blur", releaseInput);
  });
  useEffect(() => { if (!visible) releaseInput(); }, [visible]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || profile.kind !== "rdp") return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const point = desktopPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), remoteSize.width, remoteSize.height);
      lastPoint.current = point;
      send({ type: "mouse", flags: desktopWheel(delta, Math.abs(event.deltaX) > Math.abs(event.deltaY)), ...point });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
    // The sender reads the live session and state refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.kind, remoteSize.width, remoteSize.height]);
  useEffect(() => {
    if (!autoReconnect || !hadConnected.current || state !== "disconnected") return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), 5000);
    return () => window.clearTimeout(timer);
  }, [autoReconnect, state]);

  const submitCredentials = () => {
    if (credentials === "vnc") {
      rfbRef.current?.sendCredentials({ username: username || undefined, password, target: profile.targetHost });
      setCredentials(null);
      setPassword("");
      report("connecting");
    } else if (username.trim()) {
      startRdpRef.current(username.trim(), password || (profile.credentialRef ? null : ""));
    }
  };

  const acceptCertificate = async (accepted: boolean) => {
    if (!rdpRef.current || !certificate) return;
    const challengeId = certificate.challengeId;
    report(accepted ? "connecting" : "failed", accepted ? null : "已拒绝服务器证书。");
    try {
      await api.answerRdpCertificate(rdpRef.current, challengeId, accepted);
      setCertificate((current) => current?.challengeId === challengeId ? null : current);
    } catch (caught) { setError(String(caught)); }
  };

  const clipboardAction = async (direction: "send" | "receive") => {
    const nativeId = rdpRef.current;
    const rfb = rfbRef.current;
    const current = () => stateRef.current === "connected" && rdpRef.current === nativeId && rfbRef.current === rfb;
    try {
      if (direction === "receive" && remoteClipboard !== null) {
        await api.clipboardWrite(remoteClipboard);
        if (current()) setNotice("已复制远端剪贴板");
      } else {
        const text = await api.clipboardRead();
        if (!current()) return;
        if (text === null) { setNotice("本地剪贴板没有文本"); return; }
        if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("剪贴板文本不能超过 1 MiB。");
        if (text.includes("\0")) throw new Error("剪贴板文本不能含空字符。");
        if (profile.kind === "vnc") rfb?.clipboardPasteFrom(text);
        else send({ type: "clipboard", text });
        setNotice("已同步本地剪贴板，可在远端粘贴");
      }
    } catch (caught) { if (current()) setError(String(caught)); }
  };

  const ctrlAltDel = () => {
    if (profile.kind === "vnc") { rfbRef.current?.sendCtrlAltDel(); return; }
    releaseInput();
    send({ type: "ctrlAltDel" });
    keyboardRef.current?.focus({ preventScroll: true });
  };

  const textInput = async () => {
    const id = rdpRef.current;
    const text = await promptDialog({ title: "发送文本到远程桌面", message: "文本会输入到远端当前光标位置。", confirmLabel: "发送" });
    if (rdpRef.current !== id || stateRef.current !== "connected") return;
    if (text && (text.includes("\0") || new TextEncoder().encode(text).length > 64 * 1024)) {
      setError("单次输入文本不能超过 64 KiB 或含空字符。");
      return;
    }
    if (text) send({ type: "text", text });
    keyboardRef.current?.focus({ preventScroll: true });
  };

  const mouse = (event: React.PointerEvent<HTMLCanvasElement>, down?: boolean) => {
    const point = desktopPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), remoteSize.width, remoteSize.height);
    lastPoint.current = point;
    if (down === undefined) {
      if (pointerPaint.current === undefined) pointerPaint.current = requestAnimationFrame(() => {
        pointerPaint.current = undefined;
        send({ type: "mouse", flags: 0x0800, ...lastPoint.current });
      });
      return;
    }
    if (pointerPaint.current !== undefined) cancelAnimationFrame(pointerPaint.current);
    pointerPaint.current = undefined;
    keyboardRef.current?.focus({ preventScroll: true });
    const flag = [0x1000, 0x4000, 0x2000][event.button];
    if (!flag) return;
    if (down) { mouseButtons.current.add(flag); event.currentTarget.setPointerCapture(event.pointerId); }
    else mouseButtons.current.delete(flag);
    send({ type: "mouse", flags: flag | (down ? 0x8000 : 0), ...point });
    event.preventDefault();
  };

  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>, down: boolean) => {
    event.stopPropagation();
    const known = pressed.current.get(event.code);
    if (!down && known) {
      pressed.current.delete(event.code);
      send({ type: "key", ...known, down: false });
      event.preventDefault();
      return;
    }
    if (event.nativeEvent.isComposing || event.key === "Process" || event.keyCode === 229) return;
    const scan = desktopKey(event.code);
    if (!scan) return;
    event.preventDefault();
    if (down) pressed.current.set(event.code, scan);
    send({ type: "key", ...scan, down });
  };

  const scale = fit ? Math.min(viewportSize.width / remoteSize.width, viewportSize.height / remoteSize.height, 1) : 1;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || profile.kind !== "rdp") return;
    if (cursor.kind !== "shape") {
      canvas.style.cursor = cursor.kind === "hidden" ? "none" : "default";
      return;
    }
    // Native cursors stay within the browser's 128px limit, including large RDP pointers.
    const ratio = Math.max(0.01, Math.min(scale, 128 / cursor.width, 128 / cursor.height));
    const source = document.createElement("canvas");
    source.width = cursor.width;
    source.height = cursor.height;
    source.getContext("2d")?.putImageData(new ImageData(cursor.pixels, cursor.width, cursor.height), 0, 0);
    const image = document.createElement("canvas");
    image.width = Math.max(1, Math.round(cursor.width * ratio));
    image.height = Math.max(1, Math.round(cursor.height * ratio));
    image.getContext("2d")?.drawImage(source, 0, 0, image.width, image.height);
    const x = Math.min(image.width - 1, Math.floor(cursor.hotspotX * ratio));
    const y = Math.min(image.height - 1, Math.floor(cursor.hotspotY * ratio));
    canvas.style.cursor = `url("${image.toDataURL("image/png")}") ${x} ${y}, default`;
  }, [cursor, scale, profile.kind]);
  const clipboardReady = state === "connected" && (profile.kind === "vnc" || capabilities.clipboard);
  const resizeReady = state === "connected" && (profile.kind === "vnc" || capabilities.resize);
  const resolutions = [[1280, 720], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]];
  const selectedSize = `${remoteSize.width}×${remoteSize.height}`;
  return (
    <section className="embedded-desktop" ref={rootRef} aria-label={`${profile.kind.toUpperCase()} 内置远程桌面`}>
      <div className="rd-viewer-toolbar">
        <span className={`connection-dot ${state}`} />
        <span className="rd-viewer-status">{labels[state] ?? state} · {profile.kind.toUpperCase()}</span>
        <button className={`secondary-button ${fit ? "active" : ""}`} onClick={() => setFit((value) => !value)} title="切换窗口缩放"><Monitor size={13} />{fit ? "适应窗口" : "100%"}</button>
        <label className="desktop-resize-option" title={resizeReady ? "窗口变化时调整远端桌面尺寸" : "等待服务器提供动态分辨率支持"}><input type="checkbox" checked={autoResize} disabled={!resizeReady} onChange={(event) => setAutoResize(event.target.checked)} />调整远端分辨率</label>
        {profile.kind === "rdp" && <select className="desktop-resolution" aria-label="远端分辨率" value={selectedSize} disabled={!resizeReady || autoResize} onChange={(event) => {
          const [width, height] = event.target.value.split("×").map(Number);
          send({ type: "resize", width, height });
          setNotice(`已请求 ${width} × ${height}，等待服务器确认`);
        }}>
          {!resolutions.some(([w, h]) => `${w}×${h}` === selectedSize) && <option value={selectedSize}>{selectedSize}</option>}
          {resolutions.map(([w, h]) => <option key={w} value={`${w}×${h}`} disabled={w * h > capabilities.maxPixels}>{w}×{h}</option>)}
        </select>}
        <button className="icon-button" disabled={state !== "connected"} onClick={ctrlAltDel} title="发送 Ctrl+Alt+Delete"><Keyboard size={15} /></button>
        {profile.kind === "rdp" && <button className="secondary-button" disabled={state !== "connected"} onClick={() => void textInput()}>发送文本</button>}
        <button className="icon-button" disabled={!clipboardReady} onClick={() => void clipboardAction("send")} title={clipboardReady ? "同步本地文本剪贴板到远端" : "等待服务器提供剪贴板支持"}><Clipboard size={15} /></button>
        <button className="icon-button" disabled={!clipboardReady || remoteClipboard === null} onClick={() => void clipboardAction("receive")} title="复制远端文本剪贴板"><Copy size={15} /></button>
        <button className="icon-button" onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen())?.catch((caught) => setError(String(caught))); }} title="全屏"><Expand size={15} /></button>
        <button className="icon-button" onClick={() => setAttempt((value) => value + 1)} title="重新连接桌面"><RefreshCw size={15} /></button>
        <button className="icon-button" onClick={onClose} title="断开桌面"><X size={15} /></button>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="desktop-notice" role="status">{notice}</div>}
      {credentials && <form className="desktop-auth" onSubmit={(event) => { event.preventDefault(); submitCredentials(); }}>
        <strong>{credentials.toUpperCase()} 登录</strong>
        <label className="field"><span>用户名{credentials === "vnc" ? "（如需要）" : ""}</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus /></label>
        <label className="field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
        <button className="primary-button" type="submit" disabled={credentials === "rdp" && !username.trim()}>连接桌面</button>
      </form>}
      {certificate && <div className="desktop-certificate" role="alert">
        <strong>确认 RDP 服务器证书</strong>
        <p>服务器证书需要确认。请核对目标和指纹后决定是否信任本次连接。</p>
        {!!(certificate.flags & 0x80) && <p className="form-error">证书名称与连接目标不匹配，请确认服务器身份。</p>}
        {!!(certificate.flags & 0x40) && <p className="form-error">服务器证书已发生变化，请核对新的指纹。</p>}
        <dl><dt>目标</dt><dd>{certificate.host}:{certificate.port}</dd><dt>主体</dt><dd>{certificate.subject}</dd><dt>颁发者</dt><dd>{certificate.issuer}</dd><dt>{certificate.flags & 0x200 ? "证书 PEM" : "SHA-256 指纹"}</dt><dd>{certificate.fingerprint}</dd>
          {certificate.previousFingerprint && <><dt>上次指纹</dt><dd>{certificate.previousFingerprint}</dd></>}
        </dl>
        <div className="check-row"><button className="secondary-button" onClick={() => void acceptCertificate(false)}>拒绝连接</button><button className="primary-button" onClick={() => void acceptCertificate(true)}>仅本次信任</button></div>
      </div>}
      <div className={`desktop-viewport ${profile.kind}`} ref={hostRef}>
        {profile.kind === "rdp" && <>
          <canvas ref={canvasRef} width={1280} height={720} style={{ width: remoteSize.width * Math.max(scale, 0.01), height: remoteSize.height * Math.max(scale, 0.01) }}
            onPointerDown={(event) => mouse(event, true)} onPointerUp={(event) => mouse(event, false)}
            onPointerMove={(event) => mouse(event)} onPointerCancel={releaseInput} onContextMenu={(event) => event.preventDefault()}
            aria-label="远程桌面画面" />
          <textarea ref={keyboardRef} className="desktop-keyboard-input" aria-label="远程桌面键盘输入" spellCheck={false} autoCapitalize="off" autoComplete="off"
            onKeyDown={(event) => key(event, true)} onKeyUp={(event) => key(event, false)} onBlur={releaseInput}
            onCompositionEnd={(event) => { if (event.data) send({ type: "text", text: event.data }); event.currentTarget.value = ""; }}
          />
        </>}
      </div>
      <div className="desktop-footer"><span>{profile.transport === "direct" ? "直连" : "SSH 加密隧道"}</span><span>{profile.kind === "rdp" ? `${remoteSize.width} × ${remoteSize.height}` : "VNC"}</span><span>{profile.kind === "rdp" && state === "connected" && (!capabilities.clipboard || !capabilities.resize) ? `服务器尚未提供${[!capabilities.clipboard && "剪贴板", !capabilities.resize && "动态分辨率"].filter(Boolean).join("、")}` : "点击桌面输入 · 工具栏可发送组合键和剪贴板"}</span></div>
    </section>
  );
}

const labels: Record<string, string> = { connecting: "正在连接", authenticating: "等待认证", connected: "已连接", disconnected: "已断开", failed: "连接失败" };
