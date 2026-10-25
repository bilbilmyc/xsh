import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Bot, Check, Copy, Fingerprint, Gauge, Keyboard, Monitor, RotateCcw, Shield, TerminalSquare, Trash2, X } from "lucide-react";
import { api } from "../api";
import { confirmDialog, isDialogOpen } from "./DialogHost";
import { defaultPreferences, type AccentColor, type AppPreferences } from "../preferences";
import { getThemeTokens, resolveTerminalTheme, terminal256ColorPalette, TERMINAL_THEMES, THEMES } from "../themes";
import { TERMINAL_FONT_WEIGHTS } from "../terminal-fonts";
import { TerminalFontPicker } from "./TerminalFontPicker";
import { AiServiceSettings } from "./AiServiceSettings";
import type { KnownHost } from "../types";
import "./terminal-appearance.css";

interface SettingsModalProps {
  preferences: AppPreferences;
  onSave: (preferences: AppPreferences) => void;
  onClose: () => void;
  onToast: (message: string) => void;
  initialSection?: SettingsSection;
}

export type SettingsSection = "appearance" | "terminal" | "transfer" | "shortcuts" | "security" | "ai";

export function SettingsModal({ preferences, onSave, onClose, onToast, initialSection = "appearance" }: SettingsModalProps) {
  const [page, setPage] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState(preferences);
  const [aiDirty, setAiDirty] = useState(false);
  const discardPendingRef = useRef(false);
  const terminalPreview = resolveTerminalTheme("xsh-dark", draft.theme, draft.terminalTheme);
  const terminalColors = terminal256ColorPalette(terminalPreview);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [backupDialog, setBackupDialog] = useState<{ mode: "export" | "import"; path: string } | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirmation, setBackupConfirmation] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const changePage = async (next: SettingsSection) => {
    if (next === page || discardPendingRef.current) return;
    discardPendingRef.current = true;
    try {
      if (aiDirty && !await confirmDialog({
        title: "AI 设置尚未保存",
        message: "离开此分类会丢弃未保存的 AI 输入。外观和终端设置的草稿会保留，已保存的 AI 配置不受影响。是否继续？",
        confirmLabel: "丢弃 AI 输入并切换",
      })) return;
      setAiDirty(false);
      setPage(next);
    } finally {
      discardPendingRef.current = false;
    }
  };
  useEffect(() => { void changePage(initialSection); }, [initialSection]);

  useEffect(() => {
    if (page !== "security" || hostsLoaded || loadingHosts) return;
    setLoadingHosts(true);
    setHostError(null);
    api.listKnownHosts()
      .then(setKnownHosts)
      .catch((caught) => setHostError(String(caught)))
      .finally(() => { setLoadingHosts(false); setHostsLoaded(true); });
  }, [hostsLoaded, loadingHosts, page]);

  const patch = (next: Partial<AppPreferences>) => setDraft((current) => ({ ...current, ...next }));

  const updateGlobalTransferConcurrency = (value: number) => {
    const globalSftpTransferConcurrency = clampInteger(value, 1, 32);
    patch({
      globalSftpTransferConcurrency,
      perHostSftpTransferConcurrency: Math.min(
        draft.perHostSftpTransferConcurrency,
        globalSftpTransferConcurrency,
      ),
    });
  };

  const updatePerHostTransferConcurrency = (value: number) => {
    patch({
      perHostSftpTransferConcurrency: clampInteger(
        value,
        1,
        draft.globalSftpTransferConcurrency,
      ),
    });
  };

  const save = () => {
    onSave(draft);
    onToast("设置已保存并应用。");
    onClose();
  };

  const copyFingerprint = async (fingerprint: string) => {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopied(fingerprint);
      window.setTimeout(() => setCopied((current) => current === fingerprint ? null : current), 1400);
    } catch {
      onToast("无法访问剪贴板，请手动选择指纹复制。");
    }
  };

  const removeHost = async (host: KnownHost) => {
    if (!(await confirmDialog({
      title: "删除信任记录",
      message: `删除 ${host.host}:${host.port} 的本地信任记录？\n下次连接时会重新显示指纹确认。`,
      danger: true,
      confirmLabel: "删除",
    }))) return;
    try {
      await api.deleteKnownHost(host.host, host.port);
      setKnownHosts((current) => current.filter((candidate) => !(candidate.host === host.host && candidate.port === host.port)));
      onToast(`已删除 ${host.host}:${host.port} 的本地指纹信任记录。`);
    } catch (caught) {
      setHostError(String(caught));
    }
  };

  const exportBackup = async () => {
    const targetPath = await saveFile({ defaultPath: "xsh-credentials.xshbackup", filters: [{ name: "XSH 加密备份", extensions: ["xshbackup"] }] });
    if (!targetPath) return;
    setBackupPassword("");
    setBackupConfirmation("");
    setBackupDialog({ mode: "export", path: targetPath });
  };

  const importBackup = async () => {
    const sourcePath = await open({ multiple: false, filters: [{ name: "XSH 加密备份", extensions: ["xshbackup"] }] });
    if (!sourcePath || Array.isArray(sourcePath)) return;
    setBackupPassword("");
    setBackupConfirmation("");
    setBackupDialog({ mode: "import", path: sourcePath });
  };

  const submitBackupDialog = async () => {
    if (!backupDialog || !backupPassword) return;
    if (backupDialog.mode === "export" && backupPassword !== backupConfirmation) {
      onToast("两次备份密码不一致，未导出。");
      return;
    }
    setBackupBusy(true);
    try {
      if (backupDialog.mode === "export") {
        await api.exportCredentialsBackup(backupDialog.path, backupPassword);
        onToast("XSH 凭据加密备份已导出。请妥善保存备份密码。");
      } else {
        const preview = await api.inspectCredentialsBackup(backupDialog.path, backupPassword);
        if (preview.imported === 0) {
          onToast("备份中没有可恢复的凭据记录。");
          return;
        }
        const overwriteHint = preview.overwritten > 0
          ? `其中 ${preview.overwritten} 条会覆盖当前同名凭据。`
          : "不会覆盖当前凭据。";
        if (!(await confirmDialog({
          title: "恢复凭据备份",
          message: `备份中有 ${preview.imported} 条可恢复凭据，${overwriteHint}\n\n确认继续恢复吗？`,
          confirmLabel: "恢复",
        }))) return;
        const summary = await api.importCredentialsBackup(backupDialog.path, backupPassword);
        onToast(summary.overwritten > 0
          ? `已恢复 ${summary.imported} 条 XSH 凭据，其中 ${summary.overwritten} 条覆盖了同名凭据。`
          : `已恢复 ${summary.imported} 条 XSH 凭据。`);
      }
      setBackupDialog(null);
      setBackupPassword("");
      setBackupConfirmation("");
    } catch (caught) {
      onToast(`${backupDialog.mode === "export" ? "导出" : "恢复"}凭据备份失败：${String(caught)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const dirty = draft !== preferences;
  const requestClose = async () => {
    if (discardPendingRef.current || isDialogOpen()) return;
    discardPendingRef.current = true;
    try {
      if ((dirty || aiDirty) && !await confirmDialog({
        title: "未保存的修改",
        message: aiDirty
          ? `${dirty ? "外观或终端草稿与 " : ""}AI 服务输入尚未保存，关闭后将丢弃。已保存的 AI 配置不会回滚。确定关闭吗？`
          : "设置有未保存的修改，关闭后将丢失，确定关闭吗？",
        confirmLabel: "丢弃修改并关闭",
      })) return;
      onClose();
    } finally {
      discardPendingRef.current = false;
    }
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, aiDirty]);

  return (
    <div className="modal-backdrop" onMouseDown={requestClose}>
      <section className="settings-modal settings-modal-wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Monitor size={18} /></span>
            <div><h2>设置</h2><p>调整外观、终端、传输、AI 服务和服务器信任记录。</p></div>
          </div>
          <button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <button type="button" aria-current={page === "appearance" ? "page" : undefined} className={page === "appearance" ? "active" : ""} onClick={() => void changePage("appearance")}><Monitor size={15} />外观</button>
            <button type="button" aria-current={page === "terminal" ? "page" : undefined} className={page === "terminal" ? "active" : ""} onClick={() => void changePage("terminal")}><TerminalSquare size={15} />终端</button>
            <button type="button" aria-current={page === "transfer" ? "page" : undefined} className={page === "transfer" ? "active" : ""} onClick={() => void changePage("transfer")}><Gauge size={15} />传输</button>
            <button type="button" aria-current={page === "shortcuts" ? "page" : undefined} className={page === "shortcuts" ? "active" : ""} onClick={() => void changePage("shortcuts")}><Keyboard size={15} />快捷键</button>
            <button type="button" aria-current={page === "security" ? "page" : undefined} className={page === "security" ? "active" : ""} onClick={() => void changePage("security")}><Shield size={15} />服务器指纹</button>
            <button type="button" aria-current={page === "ai" ? "page" : undefined} className={page === "ai" ? "active" : ""} onClick={() => void changePage("ai")}><Bot size={15} />AI 服务</button>
          </nav>

          <div className="settings-body settings-page">
            {page === "appearance" && (
              <>
                <SettingsHeading title="界面主题" description="切换工作区主题；终端可跟随界面，也可在「终端」中单独设置配色。" />
                <div className="theme-choice-grid" role="group" aria-label="界面主题">
                  {THEMES.map((theme) => (
                    <label key={theme.value} className={`theme-choice ${draft.theme === theme.value ? "selected" : ""}`}>
                      <input className="theme-choice-input" type="radio" name="xsh-app-theme" value={theme.value} checked={draft.theme === theme.value} onChange={() => patch({ theme: theme.value })} />
                      <span className="theme-choice-preview" style={getThemeTokens(theme.value, draft.accent) as CSSProperties} aria-hidden="true">
                        <span className="theme-choice-chrome"><i /><i /><i /></span>
                        <span className="theme-choice-sidebar"><i /><i /><i /></span>
                        <span className="theme-choice-terminal"><span><b>$</b> ssh server</span><span className="theme-choice-success">connected</span></span>
                      </span>
                      <span className="theme-choice-title"><strong>{theme.label}</strong><span>{theme.scheme === "light" ? "浅色" : "深色"}</span>{draft.theme === theme.value && <Check size={13} aria-hidden="true" />}</span>
                      <small>{theme.description}</small>
                    </label>
                  ))}
                </div>

                <SettingsHeading title="强调色" description="用于按钮、选中状态、焦点和连接提示。" />
                <div className="accent-picker">
                  {ACCENTS.map((accent) => (
                    <button key={accent.value} className={draft.accent === accent.value ? "selected" : ""} onClick={() => patch({ accent: accent.value })}>
                      <span style={{ background: accent.color }} />{accent.label}
                    </button>
                  ))}
                </div>

                <SettingsHeading title="界面字体" description="提高字号可以改善高分屏上的可读性。" />
                <div className="settings-form-grid">
                  <label className="field"><span>字体</span><select value={draft.uiFontFamily} onChange={(event) => patch({ uiFontFamily: event.target.value })}>{UI_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
                  <RangeField label="界面字号" value={draft.uiFontSize} min={12} max={18} step={1} suffix="px" onChange={(value) => patch({ uiFontSize: value })} />
                </div>
                <div className="font-preview" style={{ fontFamily: draft.uiFontFamily, fontSize: draft.uiFontSize }}>
                  XSH 会话目录 · Production Server · 清晰显示中文与 English
                </div>
              </>
            )}

            {page === "terminal" && (
              <>
                <SettingsHeading title="终端字体" description="预览字体和字重，保存后应用到已打开和之后创建的终端。" />
                <TerminalFontPicker value={draft.terminalFontFamily} onChange={(terminalFontFamily) => patch({ terminalFontFamily })} />
                <div className="settings-form-grid settings-range-grid">
                  <RangeField label="终端字号" value={draft.terminalFontSize} min={12} max={22} step={1} suffix="px" onChange={(value) => patch({ terminalFontSize: value })} />
                  <RangeField label="行高" value={draft.terminalLineHeight} min={1} max={1.6} step={0.05} suffix="" onChange={(value) => patch({ terminalLineHeight: value })} />
                  <FontWeightField label="常规文字字重" value={draft.terminalFontWeight} onChange={(terminalFontWeight) => patch({ terminalFontWeight })} />
                  <FontWeightField label="粗体文字字重" value={draft.terminalFontWeightBold} onChange={(terminalFontWeightBold) => patch({ terminalFontWeightBold })} />
                </div>
                <label className="check-row terminal-profile-toggle"><input type="checkbox" checked={draft.useSessionTerminalFont} onChange={(event) => patch({ useSessionTerminalFont: event.target.checked })} />优先使用会话中单独保存的字体和字号</label>
                <SettingsHeading title="终端配色" description="背景与界面主题独立设置，所有配色均支持 xterm 256 色；会话单独指定的配色优先。" />
                <div className="terminal-theme-grid" role="group" aria-label="终端配色">
                  {[{ value: "xsh-dark" as const, label: "跟随界面", palette: resolveTerminalTheme("xsh-dark", draft.theme) }, ...TERMINAL_THEMES].map((theme) => (
                    <label key={theme.value} className={`terminal-theme-choice ${draft.terminalTheme === theme.value ? "selected" : ""}`}>
                      <input className="theme-choice-input" type="radio" name="xsh-terminal-theme" value={theme.value} checked={draft.terminalTheme === theme.value} onChange={() => patch({ terminalTheme: theme.value })} />
                      <span className="terminal-theme-sample" style={{ background: theme.palette.background, color: theme.palette.foreground, fontFamily: draft.terminalFontFamily, fontWeight: draft.terminalFontWeight }} aria-hidden="true"><span style={{ color: theme.palette.green }}>$</span> Aa <span style={{ color: theme.palette.blue }}>256</span></span>
                      <span className="terminal-theme-label">{theme.label}{draft.terminalTheme === theme.value && <Check size={12} aria-hidden="true" />}</span>
                    </label>
                  ))}
                </div>
                <div className="terminal-font-preview" aria-label="终端外观预览" style={{ fontFamily: draft.terminalFontFamily, fontSize: draft.terminalFontSize, lineHeight: draft.terminalLineHeight, fontWeight: draft.terminalFontWeight, background: terminalPreview.background, color: terminalPreview.foreground }}>
                  <div><span className="prompt" style={{ color: terminalPreview.green }}>user@server</span>:<span className="path" style={{ color: terminalPreview.blue }}>~/projects/xsh</span>$ cargo test</div>
                  <div className="success" style={{ color: terminalPreview.green }}>test result: ok. 12 passed; 0 failed</div>
                  <div>中文路径与日志显示测试：连接成功</div>
                  <div>常规 Regular 0O 1Il <span style={{ fontWeight: draft.terminalFontWeightBold }}>粗体 Bold 0O 1Il</span></div>
                  <div className="terminal-ansi-preview" aria-label="ANSI 16 色文字">
                    {terminalColors.slice(0, 16).map((color, index) => <span key={index} style={{ color }}>Aa </span>)}
                  </div>
                </div>
                <div className="terminal-color-preview" role="img" aria-label="xterm 256 色色板">
                  {terminalColors.map((color, index) => <span key={index} style={{ background: color }} title={`xterm ${index} · ${color}`} />)}
                </div>
                <p className="field-help">0–15 色跟随配色方案，16–255 色保持标准 xterm 色立方和灰阶。字体的可用字重取决于本机安装的字体。</p>
                <SettingsHeading title="终端回滚缓冲区" description="控制每个终端可以向上查看的历史输出，最高支持 100 万行。" />
                <div className="settings-form-grid">
                  <label className="field">
                    <span>全局回滚行数</span>
                    <select value={draft.terminalScrollbackLines} onChange={(event) => patch({ terminalScrollbackLines: Number(event.target.value) })}>
                      <option value={10_000}>10,000 行（默认）</option>
                      <option value={50_000}>50,000 行</option>
                      <option value={100_000}>100,000 行</option>
                      <option value={250_000}>250,000 行</option>
                      <option value={500_000}>500,000 行</option>
                      <option value={1_000_000}>1,000,000 行</option>
                    </select>
                  </label>
                  <div className="terminal-behavior-options compact">
                    <label className="check-row"><input type="checkbox" checked={draft.useSessionTerminalScrollback} onChange={(event) => patch({ useSessionTerminalScrollback: event.target.checked })} />优先使用会话单独设置的回滚行数</label>
                  </div>
                </div>
                <div className="settings-tip warning">较大的回滚缓冲区适合日志排查，但多个终端同时使用 50 万或 100 万行时会明显增加内存占用。</div>
                <SettingsHeading title="鼠标与剪贴板" description="按常用 SSH 客户端习惯配置右键、选中复制和粘贴保护。" />
                <div className="settings-form-grid">
                  <label className="field"><span>终端右键</span><select value={draft.rightClickAction} onChange={(event) => patch({ rightClickAction: event.target.value === "menu" ? "menu" : "paste" })}><option value="paste">直接粘贴（推荐）</option><option value="menu">打开操作菜单</option></select></label>
                  <div className="terminal-behavior-options">
                    <label className="check-row"><input type="checkbox" checked={draft.copyOnSelect} onChange={(event) => patch({ copyOnSelect: event.target.checked })} />选中文本后自动复制</label>
                    <label className="check-row"><input type="checkbox" checked={draft.confirmMultiLinePaste} onChange={(event) => patch({ confirmMultiLinePaste: event.target.checked })} />粘贴超过 3 行时要求确认</label>
                  </div>
                </div>
                <div className="settings-tip">终端内可使用 macOS ⌘+ / ⌘- / ⌘0，或 Windows Ctrl+Shift++ / Ctrl+Shift+- / Ctrl+Shift+0 临时调整当前标签字号；不会修改其他会话。</div>
              </>
            )}

            {page === "transfer" && (
              <>
                <SettingsHeading title="并发任务" description="限制同时占用网络和远端 SFTP 资源的传输数量。" />
                <div className="settings-form-grid transfer-concurrency-grid">
                  <label className="field transfer-number-field" htmlFor="global-sftp-transfer-concurrency">
                    <span>全局并发</span>
                    <input
                      id="global-sftp-transfer-concurrency"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={32}
                      step={1}
                      value={draft.globalSftpTransferConcurrency}
                      onChange={(event) => updateGlobalTransferConcurrency(Number(event.target.value))}
                    />
                    <small className="field-help">所有服务器合计同时运行的传输任务，范围 1–32。</small>
                  </label>
                  <label className="field transfer-number-field" htmlFor="per-host-sftp-transfer-concurrency">
                    <span>单主机并发</span>
                    <input
                      id="per-host-sftp-transfer-concurrency"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={draft.globalSftpTransferConcurrency}
                      step={1}
                      value={draft.perHostSftpTransferConcurrency}
                      onChange={(event) => updatePerHostTransferConcurrency(Number(event.target.value))}
                    />
                    <small className="field-help">同一服务器同时运行的任务，不超过全局并发。</small>
                  </label>
                </div>

                <SettingsHeading title="聚合带宽" description="上传和下载分别限速，由对应方向的所有 SFTP 任务共享。" />
                <div className="transfer-limit-list">
                  <BandwidthLimitField
                    id="sftp-upload-bandwidth"
                    label="上传限速"
                    description="所有上传任务共享"
                    value={draft.sftpUploadBandwidthLimitBps}
                    onChange={(value) => patch({ sftpUploadBandwidthLimitBps: value })}
                  />
                  <BandwidthLimitField
                    id="sftp-download-bandwidth"
                    label="下载限速"
                    description="所有下载任务共享"
                    value={draft.sftpDownloadBandwidthLimitBps}
                    onChange={(value) => patch({ sftpDownloadBandwidthLimitBps: value })}
                  />
                </div>
                <div className="settings-tip">限速只统计文件内容；关闭开关即不限制对应方向的聚合速率。</div>
              </>
            )}


            {page === "shortcuts" && (
              <>
                <SettingsHeading title="快捷键冲突策略" description="默认兼顾桌面操作效率；使用 tmux、Vim、Emacs 或自定义键位时可切换为远端优先。" />
                <label className="field shortcut-mode-field">
                  <span>Windows 终端内的工作区快捷键</span>
                  <select value={draft.terminalShortcutMode} onChange={(event) => patch({ terminalShortcutMode: event.target.value === "remote-first" ? "remote-first" : "platform-safe" })}>
                    <option value="platform-safe">平台安全（推荐）</option>
                    <option value="remote-first">远端优先</option>
                  </select>
                  <small className="field-help">远端优先模式下，终端获得焦点时，Windows 的标签、分屏、SFTP、命令中心和快捷命令组合不再被 XSH 拦截；点击工具栏或把焦点移到侧栏后仍可操作。macOS 的 Command 组合不进入 SSH PTY，因此不受此选项影响。</small>
                </label>
                <SettingsHeading title="快捷键总览" description="应用快捷键避开远端 Shell 常用 Ctrl 控制键；文本输入框和弹窗打开时不会触发工作区操作。" />
                <div className="shortcut-list">
                  {SHORTCUTS.map((shortcut) => (
                    <div className="shortcut-row" key={shortcut.action}>
                      <div><strong>{shortcut.action}</strong><small>{shortcut.description}</small></div>
                      <div className="shortcut-keys" aria-label={shortcut.keys.join(" + ")}>
                        {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="settings-tip warning">macOS 的 Ctrl+C / Ctrl+V / Ctrl+F / Ctrl+W 等组合会原样发送到远端；Windows 复制、粘贴、查找改用 Ctrl+Shift+C / V / F，未带 Shift 的 Ctrl 控制键同样发送到远端。</div>
              </>
            )}

            {page === "ai" && <AiServiceSettings onToast={onToast} onDirtyChange={setAiDirty} />}

            {page === "security" && (
              <>
                <SettingsHeading title="服务器指纹" description={`${knownHosts.length} 条本地信任记录`} />
                <div className="security-note"><Fingerprint size={15} /><span>首次连接会显示 SHA-256 指纹。指纹变化时 XSH 会阻止连接；删除记录只会让下次连接重新询问。</span></div>
                {loadingHosts && <div className="panel-message settings-message">正在读取本地信任记录…</div>}
                {hostError && <div className="panel-error settings-message">读取失败：{hostError}</div>}
                {!loadingHosts && !hostError && knownHosts.length === 0 && <div className="settings-empty">还没有已信任的服务器。连接并确认指纹后，记录会显示在这里。</div>}
                <SettingsHeading title="XSH 凭据库备份" description="密码保存在 XSH 自建加密数据库，不使用系统钥匙串。" />
                <div className="security-note"><Shield size={15} /><span>备份文件使用独立密码加密，只包含 XSH 凭据。不要把 .xshbackup 当作普通会话导出文件分享。</span></div>
                <div className="backup-actions">
                  <button className="secondary-button" onClick={() => void exportBackup()}><Copy size={14} />导出加密备份</button>
                  <button className="secondary-button" onClick={() => void importBackup()}><RotateCcw size={14} />恢复加密备份</button>
                </div>
                <div className="known-host-list">
                  {knownHosts.map((host) => (
                    <article className="known-host-card" key={`${host.host}:${host.port}`}>
                      <div className="known-host-heading"><div><strong>{host.host}<span>:{host.port}</span></strong><small>{host.keyType}</small></div><button className="icon-button danger-icon" onClick={() => void removeHost(host)} title="删除信任记录"><Trash2 size={14} /></button></div>
                      <div className="known-host-fingerprint"><code>{host.fingerprint}</code><button className="icon-button" onClick={() => void copyFingerprint(host.fingerprint)} title="复制指纹">{copied === host.fingerprint ? <Check size={13} /> : <Copy size={13} />}</button></div>
                      <div className="known-host-meta"><span>首次信任 {formatDate(host.firstSeen)}</span><span>最近使用 {formatDate(host.lastSeen)}</span></div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="modal-footer settings-footer">
          {page === "ai" ? <><span className="settings-ai-save-note">AI 服务请使用页面内的保存按钮。</span><button className="secondary-button" onClick={requestClose}>关闭</button></> : <>
            <button className="secondary-button reset-button" onClick={() => setDraft(defaultPreferences)}><RotateCcw size={14} />恢复默认</button>
            <button className="secondary-button" onClick={requestClose}>取消</button>
            <button className="primary-button" onClick={save}>保存并应用</button>
          </>}
        </footer>
      </section>
      {backupDialog && (
        <div className="modal-backdrop backup-dialog-backdrop" onMouseDown={() => !backupBusy && setBackupDialog(null)}>
          <section className="backup-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div className="modal-title-wrap"><span className="modal-icon"><Shield size={18} /></span><div><h2>{backupDialog.mode === "export" ? "导出加密备份" : "恢复加密备份"}</h2><p>密码只用于本次加密备份操作，不会写入系统钥匙串。</p></div></div><button className="icon-button" onClick={() => setBackupDialog(null)} aria-label="关闭"><X size={18} /></button></header>
            <div className="backup-dialog-body">
              <label className="field"><span>{backupDialog.mode === "export" ? "设置备份密码" : "输入备份密码"}</span><input type="password" autoFocus value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitBackupDialog(); }} placeholder="请输入至少 1 个字符" autoComplete="new-password" /></label>
              {backupDialog.mode === "export" && <label className="field"><span>再次输入备份密码</span><input type="password" value={backupConfirmation} onChange={(event) => setBackupConfirmation(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitBackupDialog(); }} autoComplete="new-password" /></label>}
              <small className="field-help">恢复会先完整校验文件，再以事务方式合并到当前 XSH 凭据库；同名 credential_ref 会被覆盖，失败时不会留下半份恢复结果。</small>
            </div>
            <footer className="modal-footer"><button className="secondary-button" disabled={backupBusy} onClick={() => setBackupDialog(null)}>取消</button><button className="primary-button" disabled={backupBusy || !backupPassword} onClick={() => void submitBackupDialog()}>{backupBusy ? "处理中…" : backupDialog.mode === "export" ? "导出备份" : "恢复备份"}</button></footer>
          </section>
        </div>
      )}
    </div>
  );
}

function SettingsHeading({ title, description }: { title: string; description: string }) {
  return <div className="settings-heading"><strong>{title}</strong><span>{description}</span></div>;
}

function RangeField({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix: string; onChange: (value: number) => void }) {
  return <label className="field range-field"><span>{label}<output>{value}{suffix}</output></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

type BandwidthUnit = "kib" | "mib";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const MAX_BANDWIDTH_BYTES_PER_SECOND = 1024 * MEBIBYTE;
const DEFAULT_ENABLED_BANDWIDTH = 10 * MEBIBYTE;

function BandwidthLimitField({ id, label, description, value, onChange }: {
  id: string;
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [unit, setUnit] = useState<BandwidthUnit>(() => value > 0 && value < MEBIBYTE ? "kib" : "mib");
  const [lastEnabledValue, setLastEnabledValue] = useState(() => value || DEFAULT_ENABLED_BANDWIDTH);
  const enabled = value > 0;
  const multiplier = unit === "mib" ? MEBIBYTE : KIBIBYTE;
  const displayValue = enabled ? formatBandwidthInputValue(value / multiplier, unit) : 0;
  const minimum = KIBIBYTE / multiplier;
  const maximum = MAX_BANDWIDTH_BYTES_PER_SECOND / multiplier;

  const toggle = (checked: boolean) => {
    if (checked) {
      onChange(clampInteger(lastEnabledValue, KIBIBYTE, MAX_BANDWIDTH_BYTES_PER_SECOND));
      return;
    }
    if (value > 0) setLastEnabledValue(value);
    onChange(0);
  };

  const updateValue = (next: number) => {
    if (!Number.isFinite(next)) return;
    const bytesPerSecond = clampInteger(
      Math.round(next * multiplier),
      KIBIBYTE,
      MAX_BANDWIDTH_BYTES_PER_SECOND,
    );
    setLastEnabledValue(bytesPerSecond);
    onChange(bytesPerSecond);
  };

  return (
    <div className="transfer-limit-row">
      <div className="transfer-limit-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </div>
      <label className="transfer-limit-switch" title={enabled ? `关闭${label}` : `开启${label}`}>
        <input type="checkbox" checked={enabled} onChange={(event) => toggle(event.target.checked)} aria-label={enabled ? `关闭${label}` : `开启${label}`} />
        <span aria-hidden="true" />
      </label>
      <div className="transfer-limit-control">
        <input
          id={`${id}-value`}
          type="number"
          inputMode="decimal"
          min={minimum}
          max={maximum}
          step={unit === "mib" ? 0.001 : 1}
          value={displayValue}
          disabled={!enabled}
          onChange={(event) => updateValue(Number(event.target.value))}
          aria-label={`${label}数值`}
        />
        <select
          value={unit}
          disabled={!enabled}
          onChange={(event) => setUnit(event.target.value === "kib" ? "kib" : "mib")}
          aria-label={`${label}单位`}
        >
          <option value="kib">KiB/s</option>
          <option value="mib">MiB/s</option>
        </select>
      </div>
    </div>
  );
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatBandwidthInputValue(value: number, unit: BandwidthUnit) {
  return Number(value.toFixed(unit === "mib" ? 4 : 0));
}

const SHORTCUTS = [
  { action: "复制终端选区", description: "没有选区时不执行；Ctrl+C 始终可发送远端中断", keys: ["macOS ⌘C", "Windows Ctrl+Shift+C"] },
  { action: "粘贴到终端", description: "保留远端 Ctrl+V quoted-insert", keys: ["macOS ⌘V", "Windows Ctrl+Shift+V"] },
  { action: "查找终端内容", description: "保留远端 Ctrl+F 向右移动", keys: ["macOS ⌘F", "Windows Ctrl+Shift+F"] },
  { action: "临时调整终端字号", description: "仅影响当前标签", keys: ["macOS ⌘ + / - / 0", "Windows Ctrl+Shift + / - / 0"] },
  { action: "新建会话", description: "保留远端 Ctrl+T 字符交换", keys: ["macOS ⌘T", "Windows Ctrl+Shift+T"] },
  { action: "关闭当前标签", description: "保留远端 Ctrl+W 删除前一个单词", keys: ["macOS ⌘W", "Windows Ctrl+Shift+W"] },
  { action: "发送快捷命令 1～9", description: "仅在用户为命令主动绑定后生效；保留远端 Ctrl+数字", keys: ["macOS ⌘1…9", "Windows Ctrl+Shift+1…9"] },
  { action: "切换指定标签", description: "与快捷命令数字键分离", keys: ["macOS ⌘⌥1…9", "Windows Ctrl+Alt+1…9"] },
  { action: "循环切换标签", description: "不会占用 macOS 的系统级 ⌘Tab", keys: ["macOS ⌘⇧[ / ]", "Windows Ctrl+Tab"] },
  { action: "复制当前连接", description: "为同一会话创建独立 SSH 连接", keys: ["macOS ⌘⇧D", "Windows Ctrl+Shift+D"] },
  { action: "重新连接", description: "重建当前标签的 SSH 连接，保留远端 Ctrl+R", keys: ["macOS ⌘⇧R", "Windows Ctrl+Shift+R"] },
  { action: "显示或隐藏会话侧栏", description: "保留远端 Ctrl+B 向左移动", keys: ["macOS ⌘B", "Windows Ctrl+Shift+B"] },
  { action: "左右分屏", description: "至少需要两个已打开标签", keys: ["macOS ⌘⌥V", "Windows Ctrl+Alt+V"] },
  { action: "上下分屏", description: "避开 macOS 的 ⌘H / ⌘⌥H 系统隐藏快捷键", keys: ["macOS ⌘⌥J", "Windows Ctrl+Alt+J"] },
  { action: "恢复单终端", description: "关闭分屏但保留所有连接", keys: ["macOS ⌘⌥S", "Windows Ctrl+Alt+S"] },
  { action: "切换分屏焦点", description: "在两个可见终端之间切换", keys: ["macOS ⌘⌥←/→", "Windows Ctrl+Alt+←/→"] },
  { action: "显示或隐藏 SFTP", description: "切换当前会话的文件面板", keys: ["macOS ⌘⌥F", "Windows Ctrl+Alt+F"] },
  { action: "打开命令中心", description: "搜索并发送已保存命令", keys: ["macOS ⌘⇧P", "Windows Ctrl+Shift+P"] },
] as const;

const ACCENTS: { value: AccentColor; label: string; color: string }[] = [
  { value: "cyan", label: "青色", color: "#39b8d6" }, { value: "blue", label: "蓝色", color: "#4f8cff" },
  { value: "green", label: "绿色", color: "#42b883" }, { value: "orange", label: "橙色", color: "#e58b45" },
  { value: "purple", label: "紫色", color: "#9b7ee8" },
];
const UI_FONTS = [
  { label: "系统默认（推荐）", value: defaultPreferences.uiFontFamily },
  { label: "苹方 / PingFang SC", value: '"PingFang SC", -apple-system, sans-serif' },
  { label: "微软雅黑 / Microsoft YaHei", value: '"Microsoft YaHei", "Segoe UI", sans-serif' },
  { label: "Segoe UI", value: '"Segoe UI", Arial, sans-serif' },
];
function FontWeightField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {!TERMINAL_FONT_WEIGHTS.some((weight) => weight.value === value) && <option value={value}>自定义 · {value}</option>}
        {TERMINAL_FONT_WEIGHTS.map((weight) => <option key={weight.value} value={weight.value}>{weight.label} · {weight.value}</option>)}
      </select>
    </label>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
