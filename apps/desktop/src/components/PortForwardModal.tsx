import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Edit3,
  Globe2,
  Play,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { confirmDialog } from "./DialogHost";
import type { ForwardHealth, ForwardInfo, ForwardKind, ForwardProfile, SavedSession } from "../types";

interface PortForwardModalProps {
  connectionId: string;
  session: SavedSession;
  onClose: () => void;
  onToast: (message: string) => void;
  onUpdateSession: (session: SavedSession, profiles: ForwardProfile[]) => Promise<void>;
}

export function PortForwardModal({
  connectionId,
  session,
  onClose,
  onToast,
  onUpdateSession,
}: PortForwardModalProps) {
  const [kind, setKind] = useState<ForwardKind>("local");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("0");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileGroup, setProfileGroup] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [saveAsProfile, setSaveAsProfile] = useState(true);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ForwardProfile[]>(session.forwardProfiles ?? []);
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [forwardHealth, setForwardHealth] = useState<Record<string, ForwardHealth>>({});
  const [busy, setBusy] = useState(false);
  const [loadingForwards, setLoadingForwards] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProfiles(session.forwardProfiles ?? []);
  }, [session.forwardProfiles, session.updatedAt]);

  const refreshForwards = useCallback(async () => {
    setLoadingForwards(true);
    try {
      const items = await api.listForwards(connectionId);
      setForwards(items);
      const health = await Promise.all(items.map(async (forward) => {
        try {
          return await api.getForwardHealth(connectionId, forward.forwardId);
        } catch {
          return { forwardId: forward.forwardId, status: "unknown" as const, detail: "无法读取当前健康状态" };
        }
      }));
      setForwardHealth(Object.fromEntries(health.map((item) => [item.forwardId, item])));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoadingForwards(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void refreshForwards();
    const interval = window.setInterval(() => void refreshForwards(), 10_000);
    return () => window.clearInterval(interval);
  }, [refreshForwards]);

  const resetForm = () => {
    setEditingProfileId(null);
    setKind("local");
    setBindHost("127.0.0.1");
    setBindPort("0");
    setTargetHost("127.0.0.1");
    setTargetPort("");
    setProfileName("");
    setProfileGroup("");
    setAutoStart(true);
    setSaveAsProfile(true);
    setError(null);
  };

  const buildProfile = (requireName: boolean): ForwardProfile => {
    const localBindPort = parsePort(bindPort, 0, "监听端口");
    const normalizedBindHost = bindHost.trim();
    if (!normalizedBindHost) throw new Error("监听地址不能为空。");

    const needsTarget = kind !== "dynamic";
    const normalizedTargetHost = targetHost.trim();
    if (needsTarget && !normalizedTargetHost) throw new Error("目标主机不能为空。");
    const parsedTargetPort = needsTarget ? parsePort(targetPort, 1, "目标端口") : null;
    const normalizedName = profileName.trim();
    if (requireName && !normalizedName) throw new Error("保存隧道前请填写配置名称。");

    return {
      id: editingProfileId ?? crypto.randomUUID(),
      name: normalizedName || defaultProfileName(kind, normalizedBindHost, localBindPort, normalizedTargetHost, parsedTargetPort),
      group: profileGroup.trim() || null,
      kind,
      bindHost: normalizedBindHost,
      bindPort: localBindPort,
      targetHost: needsTarget ? normalizedTargetHost : null,
      targetPort: parsedTargetPort,
      autoStart,
    };
  };

  const saveProfile = async (): Promise<ForwardProfile> => {
    const profile = buildProfile(true);
    const next = editingProfileId
      ? profiles.map((candidate) => candidate.id === profile.id ? profile : candidate)
      : [...profiles, profile];
    await onUpdateSession(session, next);
    setProfiles(next);
    setEditingProfileId(profile.id);
    onToast(editingProfileId ? `已更新隧道配置“${profile.name}”。` : `已保存隧道配置“${profile.name}”。`);
    return profile;
  };

  const startProfile = async (profile: ForwardProfile) => {
    const info = await api.startForwardProfile(connectionId, profile);
    setForwards((current) => current.some((item) => item.forwardId === info.forwardId) ? current : [...current, info]);
    void refreshForwards();
    onToast(`已启动隧道“${profile.name}”：${formatForwardAddress(info)}`);
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const profile = buildProfile(saveAsProfile);
      if (profile.kind !== "remote" && profile.bindPort !== 0) {
        const diagnostic = await api.diagnoseLocalPort(profile.bindHost, profile.bindPort);
        if (diagnostic.status !== "available") throw new Error(`${diagnostic.detail}。请释放端口或填写 0 自动分配。`);
      }
      const startedProfile = saveAsProfile ? await saveProfile() : profile;
      if (saveAsProfile) {
        await startProfile(startedProfile);
      } else {
        const info = await startEphemeralForward(connectionId, profile);
        setForwards((current) => [...current, info]);
        void refreshForwards();
        onToast(`已启动临时隧道：${formatForwardAddress(info)}`);
      }
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveProfile();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const editProfile = (profile: ForwardProfile) => {
    setEditingProfileId(profile.id);
    setKind(profile.kind);
    setBindHost(profile.bindHost);
    setBindPort(String(profile.bindPort));
    setTargetHost(profile.targetHost ?? "127.0.0.1");
    setTargetPort(profile.targetPort === null ? "" : String(profile.targetPort));
    setProfileName(profile.name);
    setProfileGroup(profile.group ?? "");
    setAutoStart(profile.autoStart);
    setSaveAsProfile(true);
    setError(null);
  };

  const removeProfile = async (profile: ForwardProfile) => {
    if (!(await confirmDialog({
      title: "删除隧道配置",
      message: `删除已保存的隧道配置“${profile.name}”？运行中的隧道也会停止。`,
      danger: true,
      confirmLabel: "删除",
    }))) return;
    setBusy(true);
    setError(null);
    try {
      const running = forwards.filter((forward) => belongsToProfile(forward, profile));
      await Promise.all(running.map((forward) => api.stopForward(connectionId, forward.forwardId).catch(() => undefined)));
      const next = profiles.filter((candidate) => candidate.id !== profile.id);
      await onUpdateSession(session, next);
      setProfiles(next);
      setForwards((current) => current.filter((forward) => !belongsToProfile(forward, profile)));
      if (editingProfileId === profile.id) resetForm();
      onToast(`已删除隧道配置“${profile.name}”。`);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (forward: ForwardInfo) => {
    setBusy(true);
    setError(null);
    try {
      await api.stopForward(connectionId, forward.forwardId);
      setForwards((current) => current.filter((item) => item.forwardId !== forward.forwardId));
      setForwardHealth((current) => {
        const next = { ...current };
        delete next[forward.forwardId];
        return next;
      });
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
  const groupedProfiles = groupForwardProfiles(profiles);

  const [dirty, setDirty] = useState(false);
  const requestClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirmDialog({
      title: "未保存的修改",
      message: "隧道配置有未保存的修改，关闭后将丢失，确定关闭吗？",
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

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <section
        className="modal-card port-forward-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="port-forward-title"
        onMouseDown={(event) => event.stopPropagation()}
        onChange={() => setDirty(true)}
      >
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Globe2 size={18} /></span>
            <div><h2 id="port-forward-title">端口转发</h2><p>{session.name} · 会话隧道 · 断线后可自动恢复</p></div>
          </div>
          <button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="port-forward-body">
          <section className="forward-config-card">
            <div className="forward-section-heading">
              <div><strong>{editingProfileId ? "编辑 SSH 隧道配置" : "创建新的 SSH 隧道"}</strong><span>选择转发方式，并配置监听端与目标端。</span></div>
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
              <div><strong>连接恢复</strong><span>保存的隧道只记录监听和目标参数，不包含凭据；连接重新建立后，启用“连接时自动启动”的配置会自动恢复。</span></div>
            </div>

            <div className="segmented-control forward-kind-tabs" aria-label="转发类型">
              <button className={kind === "local" ? "active" : ""} onClick={() => setKind("local")}><ArrowDownToLine size={14} />本地转发</button>
              <button className={kind === "remote" ? "active" : ""} onClick={() => setKind("remote")}><ArrowUpFromLine size={14} />远程转发</button>
              <button className={kind === "dynamic" ? "active" : ""} onClick={() => setKind("dynamic")}><Globe2 size={14} />SOCKS5</button>
            </div>

            <div className="forward-form-grid">
              <label className="field"><span>配置名称</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="例如：开发 API 隧道" /></label>
              <label className="field"><span>配置分组（可选）</span><input value={profileGroup} onChange={(event) => setProfileGroup(event.target.value)} placeholder="例如：开发环境" /></label>
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

            <div className="forward-profile-options">
              <label className="check-row"><input type="checkbox" checked={saveAsProfile} onChange={(event) => setSaveAsProfile(event.target.checked)} />保存到当前会话</label>
              <label className="check-row"><input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} disabled={!saveAsProfile} />连接成功后自动启动</label>
            </div>

            {error && <div className="form-error forward-error" role="alert">{error}</div>}
            <div className="forward-form-actions">
              <button className="secondary-button" disabled={busy} onClick={() => void saveOnly()}><Save size={14} />保存配置</button>
              <button className="primary-button" disabled={busy} onClick={() => void start()}><Play size={14} />{busy ? "处理中…" : saveAsProfile ? "保存并启动" : "启动临时转发"}</button>
              {editingProfileId && <button className="link-button" disabled={busy} onClick={resetForm}>新建配置</button>}
            </div>
          </section>

          <section className="forward-running-card">
            <div className="forward-list-heading">
              <div><strong>已保存的隧道配置</strong><span>配置跟随会话保存，可在每次连接成功后自动恢复。</span></div>
              <span className="forward-count">{profiles.length}</span>
            </div>
            {profiles.length === 0
              ? <div className="forward-empty-state"><Save size={18} /><div><strong>暂无已保存配置</strong><span>填写上方参数后选择“保存配置”，下次连接即可复用。</span></div></div>
              : <div className="forward-list">
                {groupedProfiles.map(([group, items]) => <div className="forward-profile-group" key={group}>
                  <div className="forward-profile-group-title">{group}</div>
                  {items.map((profile) => <div className="forward-item" key={profile.id}>
                    <div className="forward-item-copy"><strong>{profile.name}</strong><span>{profileKindLabel(profile.kind)} · {profile.bindHost}:{profile.bindPort}{profile.targetHost ? ` → ${profile.targetHost}:${profile.targetPort}` : ""}</span><small>{profile.autoStart ? "连接时自动启动" : "仅手动启动"}</small></div>
                    <div className="forward-item-actions">
                      <button disabled={busy} onClick={() => void startProfile(profile)} title="启动此隧道"><Play size={13} /></button>
                      <button disabled={busy} onClick={() => editProfile(profile)} title="编辑配置"><Edit3 size={13} /></button>
                      <button disabled={busy} onClick={() => void removeProfile(profile)} title="删除配置"><Trash2 size={13} /></button>
                    </div>
                  </div>)}
                </div>)}
              </div>}
          </section>

          <section className="forward-running-card">
            <div className="forward-list-heading">
              <div><strong>当前监听中的转发</strong><span>运行状态每 10 秒刷新一次；本地监听代表已注册，远端目标服务不做虚假可达性判断。</span></div>
              <button className="icon-button" disabled={loadingForwards} onClick={() => void refreshForwards()} title="刷新隧道状态"><RefreshCw size={14} /></button>
              <span className="forward-count">{forwards.length}</span>
            </div>
            {loadingForwards
              ? <div className="forward-empty-state"><Globe2 size={18} /><div><strong>正在读取转发状态…</strong><span>正在从当前 SSH 连接同步隧道列表</span></div></div>
              : forwards.length === 0
              ? <div className="forward-empty-state"><Globe2 size={18} /><div><strong>暂无运行中的转发</strong><span>启动成功的隧道会显示在这里。</span></div></div>
              : <div className="forward-list">
                {forwards.map((forward) => <div className="forward-item" key={forward.forwardId}>
                  <div className="forward-item-copy"><strong>{profiles.find((profile) => belongsToProfile(forward, profile))?.name ?? profileKindLabel(forward.kind)}</strong><span>{forward.bindHost}:{forward.bindPort}{forward.targetHost ? ` → ${forward.targetHost}:${forward.targetPort}` : ""}</span><small className={`forward-health ${forwardHealth[forward.forwardId]?.status ?? "unknown"}`} title={forwardHealth[forward.forwardId]?.detail}>{forwardHealthLabel(forwardHealth[forward.forwardId])}</small></div>
                  <button className="forward-stop-button" disabled={busy} onClick={() => void stop(forward)} title="停止此转发"><Trash2 size={13} />停止</button>
                </div>)}
              </div>}
          </section>
        </div>
        <footer className="modal-footer"><button className="secondary-button" onClick={requestClose}><Check size={14} />完成</button></footer>
      </section>
    </div>
  );
}

async function startEphemeralForward(connectionId: string, profile: ForwardProfile): Promise<ForwardInfo> {
  if (profile.kind === "dynamic") {
    return api.startDynamicForward(connectionId, profile.bindHost, profile.bindPort);
  }
  if (!profile.targetHost || !profile.targetPort) throw new Error("目标主机或端口无效。");
  return profile.kind === "local"
    ? api.startLocalForward(connectionId, profile.bindHost, profile.bindPort, profile.targetHost, profile.targetPort)
    : api.startRemoteForward(connectionId, profile.bindHost, profile.bindPort, profile.targetHost, profile.targetPort);
}

function parsePort(value: string, minimum: number, label: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label}无效。`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < minimum || port > 65535) throw new Error(`${label}必须在 ${minimum} 到 65535 之间。`);
  return port;
}

function defaultProfileName(kind: ForwardKind, bindHost: string, bindPort: number, targetHost: string, targetPort: number | null) {
  const label = kind === "local" ? "本地" : kind === "remote" ? "远程" : "SOCKS5";
  return targetPort ? `${label} ${bindHost}:${bindPort} → ${targetHost}:${targetPort}` : `${label} ${bindHost}:${bindPort}`;
}

function profileKindLabel(kind: ForwardKind) {
  return kind === "local" ? "本地转发" : kind === "remote" ? "远程转发" : "SOCKS5";
}

function formatForwardAddress(info: ForwardInfo) {
  const target = info.targetHost && info.targetPort ? ` → ${info.targetHost}:${info.targetPort}` : "";
  return `${profileKindLabel(info.kind)} ${info.bindHost}:${info.bindPort}${target}`;
}

function belongsToProfile(forward: ForwardInfo, profile: ForwardProfile) {
  if (forward.profileId) return forward.profileId === profile.id;
  return forward.kind === profile.kind
    && forward.bindHost === profile.bindHost
    && forward.bindPort === profile.bindPort
    && forward.targetHost === profile.targetHost
    && forward.targetPort === profile.targetPort;
}

function groupForwardProfiles(profiles: ForwardProfile[]): Array<[string, ForwardProfile[]]> {
  const groups = new Map<string, ForwardProfile[]>();
  for (const profile of profiles) {
    const group = profile.group?.trim() || "未分组";
    groups.set(group, [...(groups.get(group) ?? []), profile]);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => {
    if (left === "未分组") return 1;
    if (right === "未分组") return -1;
    return left.localeCompare(right, "zh-CN");
  });
}

function forwardHealthLabel(health: ForwardHealth | undefined) {
  if (!health) return "正在读取状态";
  if (health.status === "running") return "监听已注册";
  if (health.status === "stopped") return "已停止";
  return "远端状态未探测";
}
