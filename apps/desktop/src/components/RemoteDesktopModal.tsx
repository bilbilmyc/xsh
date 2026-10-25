import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Monitor, Play, RefreshCw, Save, Trash2, X } from "lucide-react";
import { api } from "../api";
import { EmbeddedDesktop } from "./EmbeddedDesktop";
import { confirmDialog } from "./DialogHost";
import { remoteDesktopDefaultPort, type ForwardHealth, type ForwardInfo, type RemoteDesktopKind, type RemoteDesktopProfile, type SavedSession } from "../types";

interface RemoteDesktopModalProps {
  connectionId: string;
  session: SavedSession;
  onClose: () => void;
  onToast: (message: string) => void;
  onUpdateSession: (session: SavedSession, remoteDesktop: RemoteDesktopProfile | null) => Promise<void>;
}

export function RemoteDesktopModal({
  connectionId,
  session,
  onClose,
  onToast,
  onUpdateSession,
}: RemoteDesktopModalProps) {
  const saved = session.remoteDesktop ?? null;
  const [kind, setKind] = useState<RemoteDesktopKind>(saved?.kind ?? "vnc");
  const [targetHost, setTargetHost] = useState(saved?.targetHost ?? "127.0.0.1");
  const [targetPort, setTargetPort] = useState(saved?.targetPort === null || saved?.targetPort === undefined ? "" : String(saved.targetPort));
  const [desktop, setDesktop] = useState<{ profile: RemoteDesktopProfile; host: string; port: number } | null>(null);
  const autoConnected = useRef(false);
  const active = useRef(true);
  const starting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const [saveToSession, setSaveToSession] = useState(Boolean(saved));
  const [autoStart, setAutoStart] = useState(saved?.autoStart ?? false);
  const [launchViewer, setLaunchViewer] = useState(saved?.launchViewer ?? true);
  const [forward, setForward] = useState<ForwardInfo | null>(null);
  const [forwardHealth, setForwardHealth] = useState<ForwardHealth | null>(null);
  // Stable across modal lifetime so repeated starts reconcile the same tunnel
  // instead of stacking listeners when the profile is not saved to the session.
  const [forwardProfileId, setForwardProfileId] = useState<string | null>(saved?.forwardProfileId ?? null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshForward = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.listForwards(connectionId);
      const running = forwardProfileId
        ? items.find((item) => item.profileId === forwardProfileId) ?? null
        : null;
      setForward(running);
      if (running) {
        try {
          setForwardHealth(await api.getForwardHealth(connectionId, running.forwardId));
        } catch {
          setForwardHealth({ forwardId: running.forwardId, status: "unknown", detail: "无法读取当前健康状态" });
        }
      } else {
        setForwardHealth(null);
      }
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, [connectionId, forwardProfileId]);

  useEffect(() => {
    void refreshForward();
    const interval = window.setInterval(() => void refreshForward(), 10_000);
    return () => window.clearInterval(interval);
  }, [refreshForward]);

  const buildProfile = (): RemoteDesktopProfile => {
    const normalizedTargetHost = targetHost.trim();
    if (!normalizedTargetHost) throw new Error("远程桌面目标主机不能为空。");
    const trimmedPort = targetPort.trim();
    const parsedTargetPort = trimmedPort === "" ? null : parsePort(trimmedPort);
    return {
      kind,
      transport: "sshTunnel",
      targetHost: normalizedTargetHost,
      targetPort: parsedTargetPort,
      autoStart,
      launchViewer,
      viewerCommand: null,
      username: saved?.username ?? null,
      credentialRef: saved?.credentialRef ?? null,
      forwardProfileId: forwardProfileId ?? crypto.randomUUID(),
    };
  };

  const start = async () => {
    if (!active.current || starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      const profile = buildProfile();
      setForwardProfileId(profile.forwardProfileId);
      if (saveToSession) await onUpdateSession(session, profile);
      if (!active.current) return;
      const launch = await api.startRemoteDesktop(connectionId, profile);
      if (!active.current) return;
      setForward(launch.forward);
      setDesktop({ profile, host: launch.forward.bindHost, port: launch.forward.bindPort });
      setDirty(false);
      onToast("正在连接内置远程桌面。");
      void refreshForward();
    } catch (caught) {
      if (active.current) setError(String(caught));
    } finally {
      starting.current = false;
      if (active.current) setBusy(false);
    }
  };

  const reopenViewer = start;
  useEffect(() => {
    if (saved?.launchViewer && !autoConnected.current) {
      autoConnected.current = true;
      void start();
    }
    // Connect the saved desktop once when this SSH panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const saveOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      const profile = buildProfile();
      await onUpdateSession(session, profile);
      setDirty(false);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!forward) return;
    setDesktop(null);
    setBusy(true);
    setError(null);
    try {
      await api.stopForward(connectionId, forward.forwardId);
      setForward(null);
      setForwardHealth(null);
      onToast("已停止远程桌面隧道。");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (forward && !(await confirmDialog({
      title: "停用远程桌面",
      message: "停用后已保存的配置会被清除，运行中的隧道也会停止。确定继续吗？",
      danger: true,
      confirmLabel: "停用",
    }))) return;
    setBusy(true);
    setError(null);
    try {
      setDesktop(null);
      if (forward) await api.stopForward(connectionId, forward.forwardId).catch(() => undefined);
      setForward(null);
      setForwardHealth(null);
      await onUpdateSession(session, null);
      onToast("已停用此会话的远程桌面配置。");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const [dirty, setDirty] = useState(false);
  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirmDialog({
      title: "未保存的修改",
      message: "远程桌面配置有未保存的修改，关闭后将丢失，确定关闭吗？",
    }).then((confirmed) => {
      if (confirmed) onClose();
    });
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const defaultPort = remoteDesktopDefaultPort(kind);
  const platformHint = "VNC 和 RDP 均使用 XSH 内置客户端，在当前应用内显示和操作。";

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <section
        className="modal-card port-forward-modal remote-desktop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-desktop-title"
        onMouseDown={(event) => event.stopPropagation()}
        onChange={(event) => { if ((event.target as HTMLElement).closest(".forward-config-card")) setDirty(true); }}
      >
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Monitor size={18} /></span>
            <div><h2 id="remote-desktop-title">远程桌面</h2><p>{session.name} · VNC / RDP over SSH · 断线后可自动恢复</p></div>
          </div>
          <button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="port-forward-body">
          <section className="forward-config-card">
            <div className="forward-section-heading">
              <div><strong>{saved ? "编辑远程桌面配置" : "创建远程桌面连接"}</strong><span>通过当前 SSH 会话建立加密隧道，在 XSH 内操作远程桌面。</span></div>
              <span className="forward-kind-badge">{kindLabel(kind)}</span>
            </div>

            <div className="forward-guide-card">
              <strong>怎么使用</strong>
              <p>XSH 经当前 SSH 连接访问服务器上的 VNC/RDP 服务，桌面直接显示在应用内。</p>
              <code>{`本地 127.0.0.1:随机端口 → SSH → ${targetHost || "127.0.0.1"}:${targetPort.trim() || defaultPort}`}</code>
              <small>{platformHint}</small>
            </div>

            <div className="segmented-control forward-kind-tabs" aria-label="远程桌面协议">
              <button className={kind === "vnc" ? "active" : ""} onClick={() => setKind("vnc")}><Monitor size={14} />VNC</button>
              <button className={kind === "rdp" ? "active" : ""} onClick={() => setKind("rdp")}><Monitor size={14} />RDP</button>
            </div>

            <div className="forward-form-grid">
              <label className="field"><span>远程目标主机（服务器视角）</span><input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} placeholder="127.0.0.1" /></label>
              <label className="field"><span>远程目标端口</span><input type="number" min="1" max="65535" value={targetPort} onChange={(event) => setTargetPort(event.target.value)} placeholder={String(defaultPort)} /><small className="field-help">留空使用默认端口 {defaultPort}</small></label>
            </div>

            <div className="forward-profile-options">
              <label className="check-row"><input type="checkbox" checked={saveToSession} onChange={(event) => setSaveToSession(event.target.checked)} />保存到当前会话</label>
              <label className="check-row"><input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} disabled={!saveToSession} />连接成功后自动启动隧道</label>
              <label className="check-row"><input type="checkbox" checked={launchViewer} onChange={(event) => setLaunchViewer(event.target.checked)} disabled={!saveToSession || !autoStart} />自动启动时同时打开查看器</label>
            </div>

            {error && <div className="form-error forward-error" role="alert">{error}</div>}
            <div className="forward-form-actions">
              {saveToSession && <button className="secondary-button" disabled={busy} onClick={() => void saveOnly()}><Save size={14} />保存配置</button>}
              <button className="primary-button" disabled={busy} onClick={() => void start()}><Play size={14} />{busy ? "处理中…" : "启动并打开查看器"}</button>
              {saved && <button className="link-button" disabled={busy} onClick={() => void disable()}>停用远程桌面</button>}
            </div>
          </section>

          <section className="forward-running-card">
            <div className="forward-list-heading">
              <div><strong>当前隧道状态</strong><span>远程桌面隧道就是一条本地端口转发；状态每 10 秒刷新一次。</span></div>
              <button className="icon-button" disabled={loading} onClick={() => void refreshForward()} title="刷新状态"><RefreshCw size={14} /></button>
            </div>
            {loading
              ? <div className="forward-empty-state"><Monitor size={18} /><div><strong>正在读取隧道状态…</strong><span>正在从当前 SSH 连接同步</span></div></div>
              : !forward
                ? <div className="forward-empty-state"><Monitor size={18} /><div><strong>隧道未运行</strong><span>点击“启动并打开查看器”建立加密隧道。</span></div></div>
                : <div className="forward-item">
                  <div className="forward-item-copy">
                    <strong>{kindLabel(kind)} · {forward.bindHost}:{forward.bindPort}</strong>
                    <span>{`→ ${forward.targetHost ?? targetHost}:${forward.targetPort ?? defaultPort}（经 SSH）`}</span>
                    <small className={`forward-health ${forwardHealth?.status ?? "unknown"}`} title={forwardHealth?.detail}>{forwardHealthLabel(forwardHealth)}</small>
                  </div>
                  <div className="forward-item-actions remote-desktop-running-actions">
                    <button disabled={busy} onClick={() => void reopenViewer()} title="重新连接桌面"><Play size={13} /></button>
                    <button disabled={busy} onClick={() => void stop()} title="停止隧道"><Trash2 size={13} /></button>
                  </div>
                </div>}
          </section>
          {desktop && <EmbeddedDesktop profile={desktop.profile} host={desktop.host} port={desktop.port} connectionId={connectionId} onClose={() => setDesktop(null)} />}
        </div>
        <footer className="modal-footer"><button className="secondary-button" onClick={requestClose}><Check size={14} />完成</button></footer>
      </section>
    </div>
  );
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("目标端口无效。");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("目标端口必须在 1 到 65535 之间。");
  return port;
}

function kindLabel(kind: RemoteDesktopKind) {
  return kind === "vnc" ? "VNC" : "RDP";
}

function forwardHealthLabel(health: ForwardHealth | null | undefined) {
  if (!health) return "正在读取状态";
  if (health.status === "running") return "监听已注册";
  if (health.status === "stopped") return "已停止";
  return "远端状态未探测";
}
