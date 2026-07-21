import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, KeyRound, Server, Trash2, X } from "lucide-react";
import { api } from "../api";
import {
  defaultTerminalProfile,
  type AuthenticationMethod,
  type SavedSession,
  type SshAgentKey,
  type SshKeyDefaults,
  type SessionDraft,
  type SessionGroup,
} from "../types";

interface SessionEditorProps {
  groups: SessionGroup[];
  sessions: SavedSession[];
  session?: SavedSession;
  onClose: () => void;
  onSaved: (session: SavedSession) => void | Promise<void>;
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
  onClose,
  onSaved,
  onDeleted,
}: SessionEditorProps) {
  const existingAuthType = session?.authentication.type ?? "password";
  const existingProxyAuth = session?.proxyJumpAuthentication ?? null;
  const [name, setName] = useState(session?.name ?? "");
  const [host, setHost] = useState(session?.host ?? "");
  const [port, setPort] = useState(String(session?.port ?? 22));
  const [username, setUsername] = useState(session?.username ?? "");
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
  const [environment, setEnvironment] = useState(
    session?.environment ?? "development",
  );
  const [tags, setTags] = useState(session?.tags.join(", ") ?? "");
  const [favorite, setFavorite] = useState(session?.favorite ?? false);
  const [autoReconnect, setAutoReconnect] = useState(
    session?.autoReconnect ?? true,
  );
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
    () => (session ? `编辑 ${session.name}` : "新建 SSH 会话"),
    [session],
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

  const save = async () => {
    setSaving(true);
    setError(null);
    const createdCredentialRefs: string[] = [];
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
      if (!normalizedName) throw new Error("请输入会话名称");
      if (!normalizedHost) throw new Error("请输入 SSH 主机");
      if (!normalizedUsername) throw new Error("请输入 SSH 用户名");

      const duplicateTarget = sessions.find((candidate) =>
        candidate.id !== session?.id
        && candidate.host.trim().toLowerCase() === normalizedHost.toLowerCase()
        && candidate.port === parsedPort
        && candidate.username.trim().toLowerCase() === normalizedUsername.toLowerCase(),
      );
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
        const confirmed = window.confirm(
          `${warnings.join("\n")}。\n\n目标：${normalizedUsername}@${normalizedHost}:${parsedPort}\n\n仍要保存当前会话吗？`,
        );
        if (!confirmed) return;
      }

      let authentication: AuthenticationMethod;
      if (authType === "password") {
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

      const draft: SessionDraft = {
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
      };
      const saved = session
        ? await api.updateSession(session.id, draft)
        : await api.createSession(draft);
      await onSaved(saved);
    } catch (caught) {
      await Promise.all(
        createdCredentialRefs.map((credentialRef) =>
          api.deleteCredential(credentialRef).catch(() => undefined),
        ),
      );
      setError(String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!session || !window.confirm(`确定删除会话“${session.name}”？此操作不会删除服务器上的任何内容。`)) return;
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

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="session-editor" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Server size={18} /></span>
            <div>
              <h2>{title}</h2>
              <p>连接信息保存在本地，密码由 XSH 本地加密数据库托管，不使用系统钥匙串。</p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="editor-body">
          <div className="form-section session-basic-section">
            <div className="section-heading"><Server size={15} />连接信息</div>
            <p className="section-description">先填写服务器地址和登录用户，其他选项可以稍后再配置。</p>
            <div className="form-grid">
              <label className="field field-span-2"><span>会话名称</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="生产环境 API" autoFocus /></label>
              <label className="field field-span-2"><span>所属目录</span><select value={groupId} onChange={(e) => setGroupId(e.target.value)}><option value="">未分类</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
              <label className="field field-span-2"><span>主机</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com" /></label>
              <label className="field"><span>端口</span><input type="text" inputMode="numeric" pattern="[0-9]*" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="22" aria-label="SSH 端口" /></label>
              <label className="field"><span>用户名</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="deploy" /></label>
            </div>
          </div>

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

          <div className="form-section">
            <div className="section-heading"><KeyRound size={15} />目标主机认证</div>
            <div className="segmented-control"><button className={authType === "password" ? "active" : ""} onClick={() => setAuthType("password")}>密码</button><button className={authType === "privateKey" ? "active" : ""} onClick={() => setAuthType("privateKey")}>SSH Key</button><button className={authType === "agent" ? "active" : ""} onClick={() => setAuthType("agent")}>SSH Agent</button></div>
            {authType === "password" ? <label className="field"><span>密码 {passwordSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={passwordSaved ? "留空保持已保存的密码" : "请输入 SSH 密码"} autoComplete="new-password" /></label> : authType === "agent" ? <label className="field"><span>Agent 身份（可选）</span><select value={agentFingerprint} onChange={(e) => setAgentFingerprint(e.target.value)}><option value="">自动尝试 Agent 中的密钥</option>{agentKeys.map((key) => <option key={key.fingerprint} value={key.fingerprint}>{key.algorithm} · {key.fingerprint}{key.comment ? ` · ${key.comment}` : ""}{key.certificate ? " · certificate" : ""}</option>)}</select><small className="field-help">{agentLoading ? "正在读取本机 SSH Agent…" : agentKeys.length ? `已发现 ${agentKeys.length} 个 Agent 身份` : "未发现身份；保存后连接时会再次检测"}<button type="button" className="link-button" onClick={() => void refreshAgentKeys()}>刷新</button></small></label> : <div className="form-grid"><label className="field field-span-2"><span>私钥文件</span><div className="input-action-row"><input value={privateKeyPath} onChange={(e) => setPrivateKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" /><button type="button" className="secondary-button" onClick={() => void choosePrivateKey()}>选择私钥</button></div><div className="private-key-actions"><button type="button" className="link-button private-key-directory-button" onClick={() => void openSshDirectory()}><FolderOpen size={13} />打开 ~/.ssh</button>{sshKeyDefaults?.defaultKeyPath && <button type="button" className="link-button" onClick={() => useDefaultPrivateKey()}>使用默认密钥</button>}</div><small className="field-help">选择器会默认打开 ~/.ssh，不需要在 Finder 中显示隐藏目录。</small></label><label className="field field-span-2"><span>Key Passphrase（没有则留空） {passphraseSaved && <em className="credential-saved-badge">•••••••• 已保存</em>}</span><input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={passphraseSaved ? "留空保持已保存的 Passphrase" : "没有则留空"} autoComplete="new-password" /></label></div>}
          </div>


          <div className="form-section session-advanced-section">
            <div className="section-heading"><span>终端与高级</span></div>
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
              <label className="field field-span-2"><span>标签（逗号分隔）</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="linux, api, production" /></label>
            </div>
          </div>
          <div className="check-row"><label><input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />加入收藏</label><label><input type="checkbox" checked={autoReconnect} onChange={(e) => setAutoReconnect(e.target.checked)} />断线自动重连</label></div>
          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="modal-footer">{session && <button className="danger-button" disabled={saving} onClick={remove}><Trash2 size={14} />删除会话</button>}<button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存会话"}</button></footer>
      </section>
    </div>
  );
}
