import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Globe2, Plus, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { ForwardInfo } from "../types";

interface PortForwardModalProps {
  connectionId: string;
  sessionName: string;
  onClose: () => void;
  onToast: (message: string) => void;
}

type ForwardKind = "local" | "remote" | "dynamic";

export function PortForwardModal({ connectionId, sessionName, onClose, onToast }: PortForwardModalProps) {
  const [kind, setKind] = useState<ForwardKind>("local");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("0");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("");
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingForwards, setLoadingForwards] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoadingForwards(true);
    void api.listForwards(connectionId)
      .then((items) => {
        if (mounted) setForwards(items);
      })
      .catch((caught) => {
        if (mounted) setError(String(caught));
      })
      .finally(() => {
        if (mounted) setLoadingForwards(false);
      });
    return () => {
      mounted = false;
    };
  }, [connectionId]);

  const start = async () => {
    const localBindPort = Number(bindPort);
    if (!bindHost.trim() || !Number.isInteger(localBindPort) || localBindPort < 0 || localBindPort > 65535) {
      setError("监听地址或端口无效。端口填 0 可自动分配。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let info: ForwardInfo;
      if (kind === "dynamic") {
        info = await api.startDynamicForward(connectionId, bindHost.trim(), localBindPort);
      } else {
        const remotePort = Number(targetPort);
        if (!targetHost.trim() || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
          throw new Error("目标主机或端口无效。");
        }
        info = kind === "local"
          ? await api.startLocalForward(connectionId, bindHost.trim(), localBindPort, targetHost.trim(), remotePort)
          : await api.startRemoteForward(connectionId, bindHost.trim(), localBindPort, targetHost.trim(), remotePort);
      }
      setForwards((current) => [...current, info]);
      onToast(`已启动 ${info.kind === "local" ? "本地" : info.kind === "remote" ? "远程" : "动态 SOCKS5"} 转发：${info.bindHost}:${info.bindPort}`);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (forward: ForwardInfo) => {
    setBusy(true);
    try {
      await api.stopForward(connectionId, forward.forwardId);
      setForwards((current) => current.filter((item) => item.forwardId !== forward.forwardId));
      onToast(`已停止转发：${forward.bindHost}:${forward.bindPort}`);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const kindTitle = kind === "local" ? "本地转发" : kind === "remote" ? "远程转发" : "动态 SOCKS5";
  const kindDescription = kind === "local"
    ? "在本机打开一个端口，访问这个端口的流量会通过 SSH，到达远程服务器视角下的目标服务。"
    : kind === "remote"
      ? "在远程服务器打开一个端口，访问这个端口的流量会通过 SSH，回到当前电脑上的目标服务。"
      : "在本机打开一个 SOCKS5 代理端口，浏览器或其他支持 SOCKS5 的应用可通过 SSH 访问远端网络。";
  const kindExample = kind === "local"
    ? "例：本地 127.0.0.1:18080 → 远程 127.0.0.1:8080，然后访问 http://127.0.0.1:18080"
    : kind === "remote"
      ? "例：远程 127.0.0.1:18080 → 当前电脑 127.0.0.1:3000，然后访问远程服务器的 127.0.0.1:18080"
      : "例：本地 127.0.0.1:1080，给浏览器配置 SOCKS5 代理 127.0.0.1:1080";
  const routePreview = kind === "local"
    ? `${bindHost || "127.0.0.1"}:${bindPort || "0"}  →  远程 ${targetHost || "127.0.0.1"}:${targetPort || "端口"}`
    : kind === "remote"
      ? `远程 ${bindHost || "127.0.0.1"}:${bindPort || "0"}  →  本地 ${targetHost || "127.0.0.1"}:${targetPort || "端口"}`
      : `SOCKS5 ${bindHost || "127.0.0.1"}:${bindPort || "0"}  →  SSH 可达网络`;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal-card port-forward-modal" role="dialog" aria-modal="true" aria-labelledby="port-forward-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Globe2 size={18} /></span>
            <div><h2 id="port-forward-title">端口转发</h2><p>{sessionName} · SSH 隧道 · 依赖当前连接</p></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="port-forward-body">
          <section className="forward-config-card">
            <div className="forward-section-heading">
              <div><strong>创建新的 SSH 隧道</strong><span>选择转发方式，并配置监听端与目标端。</span></div>
              <span className="forward-kind-badge">{kindTitle}</span>
            </div>

            <div className="forward-guide-card">
              <strong>怎么使用</strong>
              <p>{kindDescription}</p>
              <code>{kindExample}</code>
              <small>端口填 0 表示自动分配；启动后请使用“运行中的转发”里显示的实际端口。</small>
            </div>

            <div className="forward-connection-note">
              <span className="forward-connection-dot" aria-hidden="true" />
              <div><strong>必须保持 SSH 连接</strong><span>XSH 关闭、当前 SSH 会话断开或重连时，转发会立即失效；重新连接后需要重新启动。</span></div>
            </div>

            <div className="segmented-control forward-kind-tabs" aria-label="转发类型">
              <button className={kind === "local" ? "active" : ""} onClick={() => setKind("local")}><ArrowDownToLine size={14} />本地转发</button>
              <button className={kind === "remote" ? "active" : ""} onClick={() => setKind("remote")}><ArrowUpFromLine size={14} />远程转发</button>
              <button className={kind === "dynamic" ? "active" : ""} onClick={() => setKind("dynamic")}><Globe2 size={14} />SOCKS5</button>
            </div>

            <div className="forward-form-grid">
              <label className="field"><span>{kind === "remote" ? "远程监听地址" : "本地监听地址"}</span><input value={bindHost} onChange={(event) => setBindHost(event.target.value)} placeholder="127.0.0.1" /></label>
              <label className="field"><span>{kind === "remote" ? "远程监听端口" : "本地监听端口"}</span><input type="number" min="0" max="65535" value={bindPort} onChange={(event) => setBindPort(event.target.value)} placeholder="0" /><small className="field-help">填 0 自动分配</small></label>
              {kind !== "dynamic" && <>
                <label className="field"><span>{kind === "remote" ? "SSH 客户端本地目标" : "远程目标主机"}</span><input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} placeholder="127.0.0.1" /></label>
                <label className="field"><span>{kind === "remote" ? "SSH 客户端本地目标端口" : "远程目标端口"}</span><input type="number" min="1" max="65535" value={targetPort} onChange={(event) => setTargetPort(event.target.value)} placeholder="8080" /></label>
              </>}
            </div>

            <div className="forward-route-preview">
              <strong>流量路径</strong>
              <span>{routePreview}</span>
              <small>{kind === "local" ? "适合访问只在远程服务器或内网开放的服务。" : kind === "remote" ? "服务器需要允许远程端口转发；对外监听还需要允许 GatewayPorts。" : "应用连接此端口后，将通过当前 SSH 会话访问远端网络。"}</small>
            </div>

            {error && <div className="form-error forward-error" role="alert">{error}</div>}
            <div className="forward-form-actions">
              <button className="primary-button" disabled={busy} onClick={() => void start()}><Plus size={14} />{busy ? "处理中…" : "启动转发"}</button>
            </div>
          </section>

          <section className="forward-running-card">
            <div className="forward-list-heading">
              <div><strong>当前监听中的转发</strong><span>监听已建立，但不代表目标服务一定可达；目标暂时不可达时，访问会失败。</span></div>
              <span className="forward-count">{forwards.length}</span>
            </div>
            {loadingForwards
              ? <div className="forward-empty-state"><Globe2 size={18} /><div><strong>正在读取转发状态…</strong><span>正在从当前 SSH 连接同步隧道列表</span></div></div>
              : forwards.length === 0
              ? <div className="forward-empty-state"><Globe2 size={18} /><div><strong>暂无运行中的转发</strong><span>填写上方参数后点击“启动转发”，启动成功的隧道会显示在这里。</span></div></div>
              : <div className="forward-list">
                {forwards.map((forward) => <div className="forward-item" key={forward.forwardId}>
                  <div className="forward-item-copy"><strong>{forward.kind === "local" ? "本地转发" : forward.kind === "remote" ? "远程转发" : "SOCKS5"}</strong><span>{forward.kind === "local" ? "本地" : forward.kind === "remote" ? "远程" : "本地 SOCKS5"} {forward.bindHost}:{forward.bindPort}{forward.targetHost ? ` → ${forward.kind === "local" ? "远程" : "本地"} ${forward.targetHost}:${forward.targetPort}` : ""}</span></div>
                  <button className="forward-stop-button" disabled={busy} onClick={() => void stop(forward)} title="停止此转发"><Trash2 size={13} />停止</button>
                </div>)}
              </div>}
          </section>
        </div>
        <footer className="modal-footer"><button className="secondary-button" onClick={onClose}>关闭</button></footer>
      </section>
    </div>
  );
}
