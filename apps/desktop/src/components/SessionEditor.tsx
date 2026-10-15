import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { BellRing, ChevronDown, FolderOpen, Keyboard, KeyRound, Monitor, Plus, Server, Trash2, X } from "lucide-react";
import { api } from "../api";
import { rollbackUncommittedCredentials } from "../credential-lifecycle";
import { confirmDialog } from "./DialogHost";
import {
  defaultTerminalProfile,
  remoteDesktopDefaultPort,
  type AuthenticationMethod,
  type RemoteDesktopKind,
  type RemoteDesktopProfile,
  type RemoteDesktopTransport,
  type SavedSession,
  type SshAgentKey,
  type SshKeyDefaults,
  type SessionDraft,
  type SessionGroup,
  type TerminalKeyMapping,
  type TerminalTrigger,
} from "../types";
import "./session-editor-help.css";

interface SessionEditorProps {
  groups: SessionGroup[];
  sessions: SavedSession[];
  session?: SavedSession;
  initialAddress?: { host: string; port: number; username: string };
  /** Editor flavor: remote-desktop sessions lead with VNC/RDP settings and
   * treat the SSH server purely as the encrypted transport. */
  mode?: "ssh" | "remoteDesktop";
  onClose: () => void;
  onSaved: (session: SavedSession) => void | Promise<void>;
  onSavedAndConnect?: (session: SavedSession) => void | Promise<void>;
  onDeleted: (sessionId: string) => void;
}

type AuthType = "password" | "privateKey" | "agent";

function isLocalCredentialRef(reference: string | null | undefined): reference is string {
  return Boolean(reference?.startsWith("xsh-local/"));
}

export function SessionEditor({
  groups,
  sessions,
  session,
  initialAddress,
  mode = "ssh",
  onClose,
  onSaved,
  onSavedAndConnect,
  onDeleted,
}: SessionEditorProps) {
  const isRemoteDesktop = mode === "remoteDesktop" || session?.kind === "remoteDesktop";
  const existingAuthType = session?.authentication.type ?? "password";
  const existingProxyAuth = session?.proxyJumpAuthentication ?? null;
  const [name, setName] = useState(session?.name ?? initialAddress?.host ?? "");
  const [host, setHost] = useState(session?.host ?? initialAddress?.host ?? "");
  const [port, setPort] = useState(String(session?.port ?? initialAddress?.port ?? 22));
  const [username, setUsername] = useState(session?.username ?? initialAddress?.username ?? "");
  const [proxyJump, setProxyJump] = useState(session?.proxyJump ?? "");
  const [proxyJumpUsername, setProxyJumpUsername] = useState(
    session?.proxyJumpUsername ?? "",
  );
  const [proxyAuthEnabled, setProxyAuthEnabled] = useState(
    Boolean(existingProxyAuth),
  );
  const [groupId, setGroupId] = useState(session?.groupId ?? "");
  const [authType, setAuthType] = useState<AuthType>(
    existingAuthType === "privateKey" ? "privateKey" : existingAuthType === "agent" ? "agent" : "password",
  );
  const [agentFingerprint, setAgentFingerprint] = useState(
    session?.authentication.type === "agent"
      ? session.authentication.identityFingerprint ?? ""
      : "",
  );
  const [agentKeys, setAgentKeys] = useState<SshAgentKey[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [sshKeyDefaults, setSshKeyDefaults] = useState<SshKeyDefaults | null>(null);
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState(
    session?.authentication.type === "privateKey"
      ? session.authentication.privateKeyPath
      : "",
  );
  const [passphrase, setPassphrase] = useState("");
  const [proxyAuthType, setProxyAuthType] = useState<AuthType>(
    existingProxyAuth?.type === "privateKey" ? "privateKey" : existingProxyAuth?.type === "agent" ? "agent" : "password",
  );
  const [proxyAgentFingerprint, setProxyAgentFingerprint] = useState(
    existingProxyAuth?.type === "agent"
      ? existingProxyAuth.identityFingerprint ?? ""
      : "",
  );
  const [proxyPassword, setProxyPassword] = useState("");
  const [proxyPrivateKeyPath, setProxyPrivateKeyPath] = useState(
    existingProxyAuth?.type === "privateKey"
      ? existingProxyAuth.privateKeyPath
      : "",
  );
  const [proxyPassphrase, setProxyPassphrase] = useState("");
  const [initialDirectory, setInitialDirectory] = useState(
    session?.initialDirectory ?? "",
  );
  const [startupCommand, setStartupCommand] = useState(
    session?.startupCommand ?? "",
  );
  const [terminalType, setTerminalType] = useState(
    session?.terminal.terminalType ?? defaultTerminalProfile().terminalType,
  );
  const [encoding, setEncoding] = useState(
    session?.terminal.encoding ?? defaultTerminalProfile().encoding,
  );
  const [scrollbackLines, setScrollbackLines] = useState(
    String(session?.terminal.scrollbackLines ?? defaultTerminalProfile().scrollbackLines),
  );
  const [terminalFontFamily, setTerminalFontFamily] = useState(
    session?.terminal.fontFamily ?? "",
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    String(session?.terminal.fontSize ?? defaultTerminalProfile().fontSize),
  );
  const [terminalTheme, setTerminalTheme] = useState(
    session?.terminal.theme ?? defaultTerminalProfile().theme,
  );
  const [terminalTriggers, setTerminalTriggers] = useState<TerminalTrigger[]>(
    session?.terminal.triggers ?? [],
  );
  const [terminalKeyMappings, setTerminalKeyMappings] = useState<TerminalKeyMapping[]>(
    session?.terminal.keyMappings ?? [],
  );
  const [environment, setEnvironment] = useState(
    session?.environment ?? "development",
  );
  const [tags, setTags] = useState(session?.tags.join(", ") ?? "");
  const [favorite, setFavorite] = useState(session?.favorite ?? false);
  const [autoReconnect, setAutoReconnect] = useState(
    session?.autoReconnect ?? true,
  );
  const [remoteDesktopEnabled, setRemoteDesktopEnabled] = useState(
    isRemoteDesktop || Boolean(session?.remoteDesktop),
  );
  const [remoteDesktopKind, setRemoteDesktopKind] = useState<RemoteDesktopKind>(
    session?.remoteDesktop?.kind ?? "vnc",
  );
  const [remoteDesktopTransport, setRemoteDesktopTransport] =
    useState<RemoteDesktopTransport>(
      // New remote-desktop sessions default to a plain direct connection;
      // SSH-tunnel attachments and stored profiles keep the tunnel.
      session?.remoteDesktop?.transport ?? (mode === "remoteDesktop" ? "direct" : "sshTunnel"),
    );
  const [remoteDesktopTargetHost, setRemoteDesktopTargetHost] = useState(
    session?.remoteDesktop?.targetHost ?? "127.0.0.1",
  );
  const [remoteDesktopTargetPort, setRemoteDesktopTargetPort] = useState(
    session?.remoteDesktop?.targetPort == null ? "" : String(session.remoteDesktop.targetPort),
  );
  const [remoteDesktopViewerCommand, setRemoteDesktopViewerCommand] = useState(
    session?.remoteDesktop?.viewerCommand ?? "",
  );
  const [remoteDesktopUsername, setRemoteDesktopUsername] = useState(
    session?.remoteDesktop?.username ?? "",
  );
  const [remoteDesktopPassword, setRemoteDesktopPassword] = useState("");
  const remoteDesktopPasswordSaved = session?.remoteDesktop?.credentialRef?.startsWith("xsh-local/") ?? false;
  const [remoteDesktopAutoStart, setRemoteDesktopAutoStart] = useState(
    session?.remoteDesktop?.autoStart ?? false,
  );
  const [remoteDesktopLaunchViewer, setRemoteDesktopLaunchViewer] = useState(
    session?.remoteDesktop?.launchViewer ?? false,
  );
  // Direct remote-desktop sessions carry no SSH transport at all.
  const usesSshTransport = !isRemoteDesktop || remoteDesktopTransport === "sshTunnel";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordSaved = session?.authentication.type === "password"
    && isLocalCredentialRef(session.authentication.credentialRef);
  const passphraseSaved = session?.authentication.type === "privateKey"
    && isLocalCredentialRef(session.authentication.passphraseRef);
  const proxyPasswordSaved = existingProxyAuth?.type === "password"
    && isLocalCredentialRef(existingProxyAuth.credentialRef);
  const proxyPassphraseSaved = existingProxyAuth?.type === "privateKey"
    && isLocalCredentialRef(existingProxyAuth.passphraseRef);

  const title = useMemo(
    () => (session ? `编辑 ${session.name}` : isRemoteDesktop ? "新建远程桌面" : "新建 SSH 会话"),
    [session, isRemoteDesktop],
  );

  const refreshAgentKeys = async () => {
    setAgentLoading(true);
    try {
      setAgentKeys(await api.listSshAgentKeys());
    } catch (caught) {
      setAgentKeys([]);
      setError(String(caught));
    } finally {
      setAgentLoading(false);
    }
  };

  useEffect(() => {
    if (authType === "agent" || proxyAuthType === "agent") {
      void refreshAgentKeys();
    }
  }, [authType, proxyAuthType]);

  useEffect(() => {
    void api.getSshKeyDefaults().then(setSshKeyDefaults).catch(() => undefined);
  }, []);

  const choosePrivateKey = async (forProxy = false) => {
    try {
      const defaults = sshKeyDefaults ?? await api.getSshKeyDefaults();
      if (!sshKeyDefaults) setSshKeyDefaults(defaults);
      const selected = await open({
        title: forProxy ? "选择跳板机 OpenSSH 私钥" : "选择 OpenSSH 私钥",
        defaultPath: defaults.sshDirectory,
        multiple: false,
        directory: false,
      });
      if (typeof selected !== "string") return;
      if (forProxy) setProxyPrivateKeyPath(selected);
      else setPrivateKeyPath(selected);
    } catch (caught) {
      setError(`无法打开私钥选择器：${String(caught)}`);
    }
  };

  const openSshDirectory = async () => {
    try {
      const defaults = sshKeyDefaults ?? await api.getSshKeyDefaults();
      if (!sshKeyDefaults) setSshKeyDefaults(defaults);
      await api.openLocalPath(defaults.sshDirectory);
    } catch (caught) {
      setError(`无法打开 ~/.ssh：${String(caught)}`);
    }
  };

  const useDefaultPrivateKey = (forProxy = false) => {
    const defaultKeyPath = sshKeyDefaults?.defaultKeyPath;
    if (!defaultKeyPath) {
      setError("未发现默认 SSH 私钥，请点击“选择私钥”手动选择");
      return;
    }
    if (forProxy) setProxyPrivateKeyPath(defaultKeyPath);
    else setPrivateKeyPath(defaultKeyPath);
  };

  const save = async (connectAfterSave = false) => {
    setSaving(true);
    setError(null);
    const createdCredentialRefs: string[] = [];
    let sessionPersisted = false;
    try {
      const portText = port.trim();
      if (!/^\d+$/.test(portText)) throw new Error("请输入有效的 SSH 端口（默认 22）");
      const parsedPort = Number(portText);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("SSH 端口必须在 1 到 65535 之间");
      }

      const normalizedName = name.trim();
      const normalizedHost = host.trim();
      const normalizedUsername = username.trim();
      // Direct remote-desktop sessions have no SSH transport, so its fields
      // are neither required nor duplicated-checked.
      if (!normalizedName) throw new Error("请输入会话名称");
      if (usesSshTransport && !normalizedHost) throw new Error("请输入 SSH 主机");
      if (usesSshTransport && !normalizedUsername) throw new Error("请输入 SSH 用户名");

      const duplicateTarget = usesSshTransport
        ? sessions.find((candidate) =>
          candidate.id !== session?.id
          && candidate.host.trim().toLowerCase() === normalizedHost.toLowerCase()
          && candidate.port === parsedPort
          && candidate.username.trim().toLowerCase() === normalizedUsername.toLowerCase(),
        )
        : undefined;
      const duplicateName = sessions.find((candidate) =>
        candidate.id !== session?.id
        && candidate.name.trim().toLowerCase() === normalizedName.toLowerCase(),
      );
      if (duplicateTarget || duplicateName) {
        const warnings = [
          duplicateTarget ? `已存在相同连接目标的会话“${duplicateTarget.name}”` : null,
          duplicateName && duplicateName.id !== duplicateTarget?.id
            ? `已存在同名会话“${duplicateName.name}”`
            : null,
        ].filter(Boolean);
        const confirmed = await confirmDialog({
          title: "重复的会话",
          message: `${warnings.join("\n")}。${usesSshTransport ? `\n\n目标：${normalizedUsername}@${normalizedHost}:${parsedPort}` : ""}\n\n仍要保存当前会话吗？`,
          confirmLabel: "仍然保存",
        });
        if (!confirmed) return;
      }

      let authentication: AuthenticationMethod;
      if (!usesSshTransport) {
        // Direct remote-desktop sessions never open an SSH connection; keep
        // whatever authentication is stored (agent needs no secrets).
        authentication = session?.authentication ?? { type: "agent", identityFingerprint: null };
      } else if (authType === "password") {
        let credentialRef =
          session?.authentication.type === "password"
            && isLocalCredentialRef(session.authentication.credentialRef)
            ? session.authentication.credentialRef
            : null;
        if (password) {
          credentialRef = await api.createCredential("password", password);
          createdCredentialRefs.push(credentialRef);
        }
        if (!credentialRef) throw new Error("请输入 SSH 密码");
        authentication = { type: "password", credentialRef };
      } else if (authType === "agent") {
        authentication = {
          type: "agent",
          identityFingerprint: agentFingerprint || null,
        };
      } else {
        if (!privateKeyPath) throw new Error("请选择 OpenSSH 私钥");
        let passphraseRef =
          session?.authentication.type === "privateKey"
            && isLocalCredentialRef(session.authentication.passphraseRef)
            ? session.authentication.passphraseRef
            : null;
        if (passphrase) {
          passphraseRef = await api.createCredential("keyPassphrase", passphrase);
          createdCredentialRefs.push(passphraseRef);
        }
        authentication = { type: "privateKey", privateKeyPath, passphraseRef };
      }

      let proxyJumpAuthentication: AuthenticationMethod | null = null;
      if (proxyAuthEnabled) {
        if (!proxyJump.trim()) {
          throw new Error("启用跳板机独立认证前，请先填写 ProxyJump");
        }
        if (proxyAuthType === "password") {
          let credentialRef =
            existingProxyAuth?.type === "password"
              && isLocalCredentialRef(existingProxyAuth.credentialRef)
              ? existingProxyAuth.credentialRef
              : null;
          if (proxyPassword) {
            credentialRef = await api.createCredential("password", proxyPassword);
            createdCredentialRefs.push(credentialRef);
          }
          if (!credentialRef) throw new Error("请输入跳板机密码");
          proxyJumpAuthentication = { type: "password", credentialRef };
        } else if (proxyAuthType === "agent") {
          proxyJumpAuthentication = {
            type: "agent",
            identityFingerprint: proxyAgentFingerprint || null,
          };
        } else {
          if (!proxyPrivateKeyPath) throw new Error("请选择跳板机 OpenSSH 私钥");
          let passphraseRef =
            existingProxyAuth?.type === "privateKey"
              && isLocalCredentialRef(existingProxyAuth.passphraseRef)
              ? existingProxyAuth.passphraseRef
              : null;
          if (proxyPassphrase) {
            passphraseRef = await api.createCredential(
              "keyPassphrase",
              proxyPassphrase,
            );
            createdCredentialRefs.push(passphraseRef);
          }
          proxyJumpAuthentication = {
            type: "privateKey",
            privateKeyPath: proxyPrivateKeyPath,
            passphraseRef,
          };
        }
      }

      const parsedScrollback = Number(scrollbackLines.trim());
      if (!/^\d+$/.test(scrollbackLines.trim()) || !Number.isInteger(parsedScrollback) || parsedScrollback < 100 || parsedScrollback > 1_000_000) {
        throw new Error("终端回滚行数必须在 100 到 1,000,000 之间");
      }
      const parsedTerminalFontSize = Number(terminalFontSize.trim());
      if (!/^\d+(\.\d+)?$/.test(terminalFontSize.trim()) || !Number.isFinite(parsedTerminalFontSize) || parsedTerminalFontSize < 10 || parsedTerminalFontSize > 48) {
        throw new Error("终端字体大小必须在 10 到 48 之间");
      }

      const normalizedTriggers = terminalTriggers.map((trigger) => ({
        ...trigger,
        label: trigger.label.trim() || trigger.pattern.trim(),
        pattern: trigger.pattern.trim(),
        cooldownSeconds: Math.min(86_400, Math.max(0, Math.round(Number(trigger.cooldownSeconds) || 0))),
      }));
      for (const trigger of normalizedTriggers) {
        if (!trigger.pattern) throw new Error("终端触发器需要匹配关键词或正则表达式");
        if (trigger.pattern.length > 1_024) throw new Error("终端触发器匹配内容不能超过 1024 个字符");
        if (trigger.matchMode === "regex") {
          try {
            new RegExp(trigger.pattern, trigger.caseSensitive ? "" : "i");
          } catch (caught) {
            throw new Error(`终端触发器“${trigger.label || trigger.pattern}”的正则无效：${String(caught)}`);
          }
        }
      }
      const normalizedKeyMappings = terminalKeyMappings.map((mapping) => ({
        ...mapping,
        shortcut: mapping.shortcut.trim(),
        text: mapping.text,
      }));
      const shortcuts = new Set<string>();
      for (const mapping of normalizedKeyMappings) {
        if (!mapping.shortcut || !mapping.text) throw new Error("键映射需要填写按键和发送内容");
        const key = mapping.shortcut.toLowerCase().replace(/\s+/g, "");
        if (shortcuts.has(key)) throw new Error(`键映射“${mapping.shortcut}”重复`);
        shortcuts.add(key);
      }

      let remoteDesktop: RemoteDesktopProfile | null = null;
      if (remoteDesktopEnabled || isRemoteDesktop) {
        const normalizedRdHost = remoteDesktopTargetHost.trim();
        if (!normalizedRdHost) throw new Error("远程桌面目标主机不能为空。");
        const trimmedRdPort = remoteDesktopTargetPort.trim();
        const parsedRdPort = trimmedRdPort === "" ? null : Number(trimmedRdPort);
        if (parsedRdPort !== null && (!Number.isInteger(parsedRdPort) || parsedRdPort < 1 || parsedRdPort > 65535)) {
          throw new Error("远程桌面目标端口必须在 1 到 65535 之间。");
        }
        const normalizedViewer = remoteDesktopViewerCommand.trim();
        if (normalizedViewer && !normalizedViewer.includes("{port}")) {
          throw new Error("远程桌面查看器命令必须包含 {port} 占位符，例如 vncviewer {host}::{port}。");
        }
        let remoteCredentialRef = isLocalCredentialRef(session?.remoteDesktop?.credentialRef)
          ? session!.remoteDesktop!.credentialRef
          : null;
        if (remoteDesktopPassword) {
          remoteCredentialRef = await api.createCredential("password", remoteDesktopPassword);
          createdCredentialRefs.push(remoteCredentialRef);
        }
        remoteDesktop = {
          kind: remoteDesktopKind,
          transport: remoteDesktopTransport,
          targetHost: normalizedRdHost,
          targetPort: parsedRdPort,
          // Remote-desktop sessions live and die with the tunnel: connecting
          // always starts it (and opens the viewer) automatically. Direct
          // sessions have no tunnel lifecycle to automate.
          autoStart: isRemoteDesktop && remoteDesktopTransport === "sshTunnel"
            ? true
            : remoteDesktopAutoStart,
          launchViewer: isRemoteDesktop && remoteDesktopTransport === "sshTunnel"
            ? true
            : remoteDesktopLaunchViewer,
          viewerCommand: normalizedViewer || null,
          username: remoteDesktopUsername.trim() || null,
          credentialRef: remoteCredentialRef,
          forwardProfileId: session?.remoteDesktop?.forwardProfileId ?? crypto.randomUUID(),
        };
      }
      if (isRemoteDesktop && !remoteDesktop) {
        throw new Error("远程桌面会话需要配置 VNC/RDP 目标。");
      }

      const draft: SessionDraft = {
        kind: isRemoteDesktop ? "remoteDesktop" : "ssh",
        groupId: groupId || null,
        name: normalizedName,
        host: normalizedHost,
        port: parsedPort,
        username: normalizedUsername,
        proxyJump: proxyJump.trim() || null,
        proxyJumpUsername: proxyJumpUsername.trim() || null,
        proxyJumpAuthentication,
        authentication,
        terminal: {
          terminalType: terminalType.trim() || defaultTerminalProfile().terminalType,
          encoding: encoding.trim() || defaultTerminalProfile().encoding,
          scrollbackLines: parsedScrollback,
          fontFamily: terminalFontFamily.trim() || null,
          fontSize: parsedTerminalFontSize,
          theme: terminalTheme,
          triggers: normalizedTriggers,
          keyMappings: normalizedKeyMappings,
        },
        initialDirectory: initialDirectory.trim() || null,
        startupCommand: startupCommand.trim() || null,
        keepaliveSeconds: session?.keepaliveSeconds ?? 30,
        autoReconnect,
        environment: environment || null,
        color: session?.color ?? null,
        notes: session?.notes ?? null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        favorite,
        forwardProfiles: session?.forwardProfiles ?? [],
        remoteDesktop,
      };
      const saved = session
        ? await api.updateSession(session.id, draft)
        : await api.createSession(draft);
      sessionPersisted = true;
      if (connectAfterSave && onSavedAndConnect) await onSavedAndConnect(saved);
      else await onSaved(saved);
    } catch (caught) {
      await rollbackUncommittedCredentials(
        sessionPersisted,
        createdCredentialRefs,
        api.deleteCredential,
      );
      setError(String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!session || !(await confirmDialog({
      title: "删除会话",
      message: `确定删除会话“${session.name}”？此操作不会删除服务器上的任何内容。`,
      danger: true,
      confirmLabel: "删除",
    }))) return;
    setSaving(true);
    setError(null);
    try {
      await api.deleteSession(session.id);
      onDeleted(session.id);
    } catch (caught) {
      setError(String(caught));
      setSaving(false);
    }
  };

  const [dirty, setDirty] = useState(false);
  const requestClose = () => {
    if (saving) return;
    if (dirty) {
      void confirmDialog({
        title: "未保存的修改",
        message: "有未保存的修改，关闭后将丢失，确定关闭吗？",
      }).then((confirmed) => {
        if (confirmed) onClose();
      });
      return;
    }
    onClose();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving]);
  const onEditorKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    event.preventDefault();
    void save();
  };

  const proxyJumpSection = (
          <details className="proxy-jump-details">
            <summary>
              <span className="proxy-jump-summary-title"><ChevronDown size={16} />跳板机设置（可选）</span>
              <span className="proxy-jump-summary-hint">{proxyJump.trim() ? `已配置：${proxyJump.trim()}` : "默认关闭，按需展开"}</span>
            </summary>
            <div className="proxy-jump-body">
              <div className="form-grid">
                <label className="field field-span-2"><span>ProxyJump</span><input value={proxyJump} onChange={(e) => setProxyJump(e.target.value)} placeholder="bastion 或 ops@bastion:2200" /><small className="field-help">支持单级跳板机，也支持 ~/.ssh/config 中的别名。</small></label>
                <label className="field field-span-2"><span>跳板机用户名覆盖（可选）</span><input value={proxyJumpUsername} onChange={(e) => setProxyJumpUsername(e.target.value)} placeholder="留空使用 ops@host 中的用户，或跟随目标用户名" /></label>
              </div>

              <div className="form-section proxy-auth-section">
                <div className="section-heading"><KeyRound size={15} />跳板机认证（可选）</div>
                <label className="check-row"><span><input type="checkbox" checked={proxyAuthEnabled} onChange={(e) => setProxyAuthEnabled(e.target.checked)} />使用独立认证（关闭时跟随目标会话认证）</span></label>
                {proxyAuthEnabled && <>
                  <div className="segmented-control"><button className={proxyAuthType === "password" ? "active" : ""} onClick={() => setProxyAuthType("password")}>密码</button><button className={proxyAuthType === "privateKey" ? "active" : ""} onClick={() => setProxyAuthType("privateKey")}>SSH Key</button><button className={proxyAuthType === "agent" ? "active" : ""} onClick={() => setProxyAuthType("agent")}>SSH Agent</button></div>
                  {proxyAuthType === "password" ? <label className="field"><span>跳板机密码 {proxyPasswordSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={proxyPassword} onChange={(e) => setProxyPassword(e.target.value)} placeholder={proxyPasswordSaved ? "留空保持已保存的密码" : "请输入跳板机密码"} autoComplete="new-password" /></label> : proxyAuthType === "agent" ? <label className="field"><span>跳板机 Agent 身份（可选）</span><select value={proxyAgentFingerprint} onChange={(e) => setProxyAgentFingerprint(e.target.value)}><option value="">自动尝试 Agent 中的密钥</option>{agentKeys.map((key) => <option key={key.fingerprint} value={key.fingerprint}>{key.algorithm} · {key.fingerprint}{key.comment ? ` · ${key.comment}` : ""}</option>)}</select></label> : <div className="form-grid"><label className="field field-span-2"><span>跳板机私钥文件</span><div className="input-action-row"><input value={proxyPrivateKeyPath} onChange={(e) => setProxyPrivateKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519_jump" /><button type="button" className="secondary-button" onClick={() => void choosePrivateKey(true)}>选择私钥</button></div><div className="private-key-actions"><button type="button" className="link-button private-key-directory-button" onClick={() => void openSshDirectory()}><FolderOpen size={13} />打开 ~/.ssh</button>{sshKeyDefaults?.defaultKeyPath && <button type="button" className="link-button" onClick={() => useDefaultPrivateKey(true)}>使用默认密钥</button>}</div><small className="field-help">选择器会默认打开 ~/.ssh，不需要在 Finder 中显示隐藏目录。</small></label><label className="field field-span-2"><span>跳板机 Key Passphrase（没有则留空） {proxyPassphraseSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={proxyPassphrase} onChange={(e) => setProxyPassphrase(e.target.value)} placeholder={proxyPassphraseSaved ? "留空保持已保存的 Passphrase" : "没有则留空"} autoComplete="new-password" /></label></div>}
                </>}
              </div>
            </div>
          </details>
  );

  const remoteDesktopSection = (
          <details className={`proxy-jump-details remote-desktop-details${isRemoteDesktop ? " remote-desktop-primary" : ""}`} open={isRemoteDesktop || undefined}>
            <summary>
              <span className="proxy-jump-summary-title"><ChevronDown size={16} />远程桌面{isRemoteDesktop ? "（VNC / RDP）" : "（VNC / RDP，可选）"}</span>
              <span className="proxy-jump-summary-hint">
                {isRemoteDesktop
                  ? `已启用：${remoteDesktopKind === "vnc" ? "VNC" : "RDP"} → ${remoteDesktopTargetHost || "127.0.0.1"}:${remoteDesktopTargetPort.trim() || remoteDesktopDefaultPort(remoteDesktopKind)}`
                  : session?.remoteDesktop
                    ? `已配置：${session.remoteDesktop.kind === "vnc" ? "VNC" : "RDP"} → ${session.remoteDesktop.targetHost}:${session.remoteDesktop.targetPort ?? remoteDesktopDefaultPort(session.remoteDesktop.kind)}`
                    : "默认关闭，按需展开"}
              </span>
            </summary>
            <div className="proxy-jump-body">
              {!isRemoteDesktop && (
                <label className="check-row"><span><input type="checkbox" checked={remoteDesktopEnabled} onChange={(e) => setRemoteDesktopEnabled(e.target.checked)} />启用远程桌面（通过当前 SSH 会话加密隧道连接 VNC/RDP）</span></label>
              )}
              {(remoteDesktopEnabled || isRemoteDesktop) && <>
                <div className="form-grid">
                  <label className="field"><span>协议</span><div className="segmented-control"><button className={remoteDesktopKind === "vnc" ? "active" : ""} onClick={() => setRemoteDesktopKind("vnc")}><Monitor size={14} />VNC</button><button className={remoteDesktopKind === "rdp" ? "active" : ""} onClick={() => setRemoteDesktopKind("rdp")}><Monitor size={14} />RDP</button></div></label>
                  {isRemoteDesktop && (
                    <label className="field"><span>连接方式</span>
                      <div className="segmented-control">
                        <button className={remoteDesktopTransport === "direct" ? "active" : ""} onClick={() => setRemoteDesktopTransport("direct")}>直连</button>
                        <button className={remoteDesktopTransport === "sshTunnel" ? "active" : ""} onClick={() => setRemoteDesktopTransport("sshTunnel")}>SSH 加密隧道</button>
                      </div>
                    </label>
                  )}
                  <label className="field"><span>远程目标主机</span><input value={remoteDesktopTargetHost} onChange={(e) => setRemoteDesktopTargetHost(e.target.value)} placeholder={remoteDesktopTransport === "direct" ? "192.168.1.10 或 vnc.example.com" : "127.0.0.1"} /></label>
                  <label className="field"><span>远程目标端口</span><input type="number" min="1" max="65535" value={remoteDesktopTargetPort} onChange={(e) => setRemoteDesktopTargetPort(e.target.value)} placeholder={`默认 ${remoteDesktopDefaultPort(remoteDesktopKind)}`} /></label>
                  <label className="field"><span>登录用户（可选）</span><input value={remoteDesktopUsername} onChange={(e) => setRemoteDesktopUsername(e.target.value)} placeholder={remoteDesktopKind === "rdp" ? "administrator 或 DOMAIN\\user" : "多数 VNC 服务器无需用户名"} /></label>
                  <label className={`field${isRemoteDesktop ? "" : " field-span-2"}`}><span>登录密码（可选） {remoteDesktopPasswordSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={remoteDesktopPassword} onChange={(e) => setRemoteDesktopPassword(e.target.value)} placeholder={remoteDesktopPasswordSaved ? "留空保持已保存的密码" : "保存在 XSH 本地加密库"} autoComplete="new-password" /></label>
                  <label className="field field-span-2"><span>外部查看器命令模板（可选）</span><input value={remoteDesktopViewerCommand} onChange={(e) => setRemoteDesktopViewerCommand(e.target.value)} placeholder={remoteDesktopKind === "vnc" ? "vncviewer {host}::{port}" : "remmina -c rdp://{host}:{port}"} spellCheck={false} /></label>
                </div>
                <p className="field-help">
                  {isRemoteDesktop
                    ? remoteDesktopTransport === "direct"
                      ? "直连：在应用内直接连接目标地址，不经过 SSH。登录信息保存在本地加密凭据库，VNC 桌面在应用内打开；填写外部查看器模板后将改用外部程序。"
                      : "SSH 加密隧道：流量经 SSH 服务器加密转发，适合桌面不在公网或需要加密的场景。登录信息保存在本地加密凭据库；RDP 使用系统远程桌面并自动填入登录信息。"
                    : "登录信息保存在本地加密凭据库；留空时 VNC 在应用内打开，RDP 使用系统远程桌面。也可以连接后在工具栏点“远程”随时启动。"}
                </p>
                {!isRemoteDesktop && (
                  <div className="check-row">
                    <label><input type="checkbox" checked={remoteDesktopAutoStart} onChange={(e) => setRemoteDesktopAutoStart(e.target.checked)} />连接成功后自动启动隧道</label>
                    <label><input type="checkbox" checked={remoteDesktopLaunchViewer} onChange={(e) => setRemoteDesktopLaunchViewer(e.target.checked)} disabled={!remoteDesktopAutoStart} />自动启动时同时打开查看器</label>
                  </div>
                )}
              </>}
            </div>
          </details>
  );

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <section
        className="session-editor"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onEditorKeyDown}
        onChange={() => setDirty(true)}
      >
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Server size={18} /></span>
            <div>
              <h2>{title}</h2>
              <p>{isRemoteDesktop
                ? "通过 SSH 加密隧道连接服务器的 VNC/RDP 桌面；SSH 服务器只作为加密通道使用。"
                : "连接信息保存在本地，密码由 XSH 本地加密数据库托管，不使用系统钥匙串。"}</p>
            </div>
          </div>
          <button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="editor-body">
          <div className="form-section session-basic-section">
            <div className="section-heading"><Server size={15} />连接信息</div>
            <p className="section-description">{isRemoteDesktop
              ? "为这个远程桌面连接命名；VNC/RDP 桌面经由下方的 SSH 加密通道访问。"
              : "填写你已有服务器的地址和登录账号；这些信息由服务器管理员或云服务商提供。"}</p>
            <div className="form-grid">
              <label className="field field-span-2"><span>会话名称</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder={isRemoteDesktop ? "机房工作站桌面" : "生产环境 API"} autoFocus /></label>
              <label className="field field-span-2"><span>所属目录</span><select value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="">未分类</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
              {!isRemoteDesktop && <>
                <label className="field field-span-2"><span>主机</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com" /></label>
                <label className="field"><span>端口</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="22" aria-label="SSH 端口" /></label>
                <label className="field"><span>用户名</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" /></label>
              </>}
            </div>
          </div>

          {isRemoteDesktop && remoteDesktopSection}

          {isRemoteDesktop && remoteDesktopTransport === "sshTunnel" && (
            <div className="form-section">
              <div className="section-heading"><Server size={15} />SSH 服务器（加密通道）</div>
              <p className="section-description">填写用作加密通道的 SSH 服务器；远程桌面流量全部经由这条 SSH 连接转发，不直接暴露在网络上。</p>
              <div className="form-grid">
                <label className="field field-span-2"><span>主机</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com" /></label>
                <label className="field"><span>端口</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="22" aria-label="SSH 端口" /></label>
                <label className="field"><span>用户名</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" /></label>
              </div>
            </div>
          )}

          {usesSshTransport && proxyJumpSection}
          {!isRemoteDesktop && remoteDesktopSection}

          {usesSshTransport && (
          <div className="form-section">
            <div className="section-heading"><KeyRound size={15} />{isRemoteDesktop ? "SSH 服务器认证（加密通道）" : "目标主机认证"}</div>
            <p className="section-description">{authType === "password" ? "使用服务器账号的登录密码，不是 XSH 或云平台网站的密码。" : authType === "privateKey" ? "选择保存在本机的私钥文件；公钥需已由管理员安装在服务器上。" : "使用本机 SSH Agent 已加载的密钥；不确定时可先选择密码或私钥。"}</p>
            <div className="segmented-control"><button className={authType === "password" ? "active" : ""} onClick={() => setAuthType("password")}>密码</button><button className={authType === "privateKey" ? "active" : ""} onClick={() => setAuthType("privateKey")}>SSH Key</button><button className={authType === "agent" ? "active" : ""} onClick={() => setAuthType("agent")}>SSH Agent</button></div>
            {authType === "password" ? <label className="field"><span>密码 {passwordSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={passwordSaved ? "留空保持已保存的密码" : "请输入 SSH 密码"} autoComplete="new-password" /></label> : authType === "agent" ? <label className="field"><span>Agent 身份（可选）</span><select value={agentFingerprint} onChange={(e) => setAgentFingerprint(e.target.value)}><option value="">自动尝试 Agent 中的密钥</option>{agentKeys.map((key) => <option key={key.fingerprint} value={key.fingerprint}>{key.algorithm} · {key.fingerprint}{key.comment ? ` · ${key.comment}` : ""}{key.certificate ? " · 证书" : ""}</option>)}</select><small className="field-help">{agentLoading ? "正在读取本机 SSH Agent…" : agentKeys.length ? `已发现 ${agentKeys.length} 个 Agent 身份` : "未发现身份；保存后连接时会再次检测"}<button type="button" className="link-button" onClick={() => void refreshAgentKeys()}>刷新</button></small></label> : <div className="form-grid"><label className="field field-span-2"><span>私钥文件</span><div className="input-action-row"><input value={privateKeyPath} onChange={(e) => setPrivateKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" /><button type="button" className="secondary-button" onClick={() => void choosePrivateKey()}>选择私钥</button></div><div className="private-key-actions"><button type="button" className="link-button private-key-directory-button" onClick={() => void openSshDirectory()}><FolderOpen size={13} />打开 ~/.ssh</button>{sshKeyDefaults?.defaultKeyPath && <button type="button" className="link-button" onClick={() => useDefaultPrivateKey()}>使用默认密钥</button>}</div><small className="field-help">选择器会默认打开 ~/.ssh，不需要在 Finder 中显示隐藏目录。</small></label><label className="field field-span-2"><span>Key Passphrase（没有则留空） {passphraseSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={passphraseSaved ? "留空保持已保存的 Passphrase" : "没有则留空"} autoComplete="new-password" /></label></div>}
          </div>
          )}


          {!isRemoteDesktop && (
          <details className="form-section session-advanced-section" open={session ? true : undefined}>
            <summary className="session-advanced-summary"><ChevronDown size={14} /><strong>高级选项</strong><span>初次连接可跳过</span></summary>
            <p className="section-description">连接后行为、终端外观和标签等低频设置按需配置。</p>
            <div className="form-grid">
              <label className="field"><span>环境</span><select value={environment} onChange={(e) => setEnvironment(e.target.value)}><option value="production">生产</option><option value="staging">预发布</option><option value="testing">测试</option><option value="development">开发</option></select></label>
            <label className="field"><span>默认远程目录</span><input value={initialDirectory} onChange={(e) => setInitialDirectory(e.target.value)} placeholder="/var/www/app" /></label>
            <label className="field field-span-2"><span>连接后执行命令（可选）</span><textarea className="session-startup-command" value={startupCommand} onChange={(e) => setStartupCommand(e.target.value)} placeholder="例如：clear\nuname -a" rows={3} spellCheck={false} /><small className="field-help">连接成功、进入默认目录后自动发送；支持多行。不要填写密码、Token、私钥或其他敏感信息。</small></label>
            <details className="session-terminal-options field-span-2">
              <summary><ChevronDown size={14} />终端配置</summary>
              <div className="form-grid">
                <label className="field"><span>终端类型（TERM）</span><input value={terminalType} onChange={(e) => setTerminalType(e.target.value)} placeholder="xterm-256color" /></label>
                <label className="field"><span>编码</span><select value={encoding} onChange={(e) => setEncoding(e.target.value)}><option value="utf-8">UTF-8</option><option value="gbk">GBK</option><option value="gb18030">GB18030</option></select></label>
                <label className="field"><span>回滚行数</span><input inputMode="numeric" list="xsh-scrollback-presets" value={scrollbackLines} onChange={(e) => setScrollbackLines(e.target.value)} /><small className="field-help">支持 100 到 1,000,000 行；是否生效由全局“优先使用会话设置”控制。</small></label>
                <label className="field"><span>字体大小</span><input inputMode="decimal" value={terminalFontSize} onChange={(e) => setTerminalFontSize(e.target.value)} /><small className="field-help">留空字体名称则跟随全局设置。</small></label>
                <label className="field field-span-2"><span>字体名称（可选）</span><input value={terminalFontFamily} onChange={(e) => setTerminalFontFamily(e.target.value)} placeholder="留空使用全局字体，例如 Menlo, JetBrains Mono" /></label>
                <label className="field"><span>终端主题</span><select value={terminalTheme} onChange={(e) => setTerminalTheme(e.target.value)}><option value="xsh-dark">跟随全局主题</option><option value="xsh-blue">深蓝</option><option value="xsh-green">绿幕</option></select></label>
                <datalist id="xsh-scrollback-presets"><option value="10000" /><option value="50000" /><option value="100000" /><option value="250000" /><option value="500000" /><option value="1000000" /></datalist>
              </div>
            </details>
            <details className="session-terminal-options field-span-2">
              <summary><BellRing size={14} />终端输出触发器 <small>{terminalTriggers.length ? `${terminalTriggers.length} 条` : "未配置"}</small></summary>
              <p className="field-help terminal-automation-note">命中后只发送本地通知、点亮标签并写入会话日志；不会执行任何命令。</p>
              <div className="terminal-automation-list">
                {terminalTriggers.map((trigger) => (
                  <div className="terminal-automation-row" key={trigger.id}>
                    <label className="field"><span>名称</span><input value={trigger.label} onChange={(event) => setTerminalTriggers((current) => current.map((item) => item.id === trigger.id ? { ...item, label: event.target.value } : item))} placeholder="例如：部署失败" /></label>
                    <label className="field"><span>匹配</span><input value={trigger.pattern} onChange={(event) => setTerminalTriggers((current) => current.map((item) => item.id === trigger.id ? { ...item, pattern: event.target.value } : item))} placeholder="FAILED 或 error\\s+\\d+" spellCheck={false} /></label>
                    <label className="field"><span>方式</span><select value={trigger.matchMode} onChange={(event) => setTerminalTriggers((current) => current.map((item) => item.id === trigger.id ? { ...item, matchMode: event.target.value === "regex" ? "regex" : "keyword" } : item))}><option value="keyword">关键词</option><option value="regex">正则</option></select></label>
                    <label className="field terminal-automation-cooldown"><span>冷却（秒）</span><input type="number" min={0} max={86400} value={trigger.cooldownSeconds} onChange={(event) => setTerminalTriggers((current) => current.map((item) => item.id === trigger.id ? { ...item, cooldownSeconds: Number(event.target.value) } : item))} /></label>
                    <label className="check-row terminal-automation-toggle"><input type="checkbox" checked={trigger.caseSensitive} onChange={(event) => setTerminalTriggers((current) => current.map((item) => item.id === trigger.id ? { ...item, caseSensitive: event.target.checked } : item))} />区分大小写</label>
                    <label className="check-row terminal-automation-toggle"><input type="checkbox" checked={trigger.enabled} onChange={(event) => setTerminalTriggers((current) => current.map((item) => item.id === trigger.id ? { ...item, enabled: event.target.checked } : item))} />启用</label>
                    <button type="button" className="icon-button terminal-automation-remove" onClick={() => setTerminalTriggers((current) => current.filter((item) => item.id !== trigger.id))} title="删除此触发器" aria-label="删除此触发器"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <button type="button" className="secondary-button terminal-automation-add" onClick={() => setTerminalTriggers((current) => [...current, { id: crypto.randomUUID(), label: "", pattern: "", matchMode: "keyword", caseSensitive: false, cooldownSeconds: 30, enabled: true }])}><Plus size={14} />添加触发器</button>
            </details>
            <details className="session-terminal-options field-span-2">
              <summary><Keyboard size={14} />会话键映射 <small>{terminalKeyMappings.length ? `${terminalKeyMappings.length} 条` : "未配置"}</small></summary>
              <p className="field-help terminal-automation-note">映射优先于本应用的同一快捷键处理，可输入 <code>F5</code>、<code>Ctrl+Alt+K</code>；发送内容支持 <code>\\e</code>、<code>\\r</code>、<code>\\n</code> 和 <code>\\t</code>。</p>
              <div className="terminal-automation-list">
                {terminalKeyMappings.map((mapping) => (
                  <div className="terminal-automation-row key-mapping-row" key={mapping.id}>
                    <label className="field"><span>按键</span><input value={mapping.shortcut} onChange={(event) => setTerminalKeyMappings((current) => current.map((item) => item.id === mapping.id ? { ...item, shortcut: event.target.value } : item))} placeholder="F5 或 Ctrl+Alt+K" spellCheck={false} /></label>
                    <label className="field"><span>发送内容</span><input value={mapping.text} onChange={(event) => setTerminalKeyMappings((current) => current.map((item) => item.id === mapping.id ? { ...item, text: event.target.value } : item))} placeholder="例如：\\e[15~" spellCheck={false} /></label>
                    <label className="check-row terminal-automation-toggle"><input type="checkbox" checked={mapping.enabled} onChange={(event) => setTerminalKeyMappings((current) => current.map((item) => item.id === mapping.id ? { ...item, enabled: event.target.checked } : item))} />启用</label>
                    <button type="button" className="icon-button terminal-automation-remove" onClick={() => setTerminalKeyMappings((current) => current.filter((item) => item.id !== mapping.id))} title="删除此键映射" aria-label="删除此键映射"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              <button type="button" className="secondary-button terminal-automation-add" onClick={() => setTerminalKeyMappings((current) => [...current, { id: crypto.randomUUID(), shortcut: "", text: "", enabled: true }])}><Plus size={14} />添加键映射</button>
            </details>
              <label className="field field-span-2"><span>标签（逗号分隔）</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="linux, api, production" /></label>
            </div>
          </details>
          )}
          {isRemoteDesktop && remoteDesktopTransport === "sshTunnel" && (
            <div className="check-row"><label><input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />断线自动重连（重连后自动恢复隧道并重新打开查看器）</label></div>
          )}
          {!isRemoteDesktop && (
            <div className="check-row"><label><input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />加入收藏</label><label><input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />断线自动重连</label></div>
          )}
          {!session && !isRemoteDesktop && <p className="session-first-connection-note">首次连接会请你核对服务器指纹。请向管理员确认后再信任；「保存会话」仅保存，「保存并连接」才会开始登录。</p>}
          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="modal-footer">{session && <button className="danger-button" disabled={saving} onClick={remove}><Trash2 size={14} />删除会话</button>}<button className="secondary-button" onClick={requestClose}>取消</button>{!session && onSavedAndConnect && <button className="primary-button" disabled={saving} onClick={() => void save(true)}>{saving ? "保存中…" : "保存并连接"}</button>}<button className={session ? "primary-button" : "secondary-button"} disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存会话"}</button></footer>
      </section>
    </div>
  );
}
