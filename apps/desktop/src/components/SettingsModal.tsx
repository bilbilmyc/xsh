import { useEffect, useState } from "react";
import { open, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Check, Copy, Fingerprint, Keyboard, Monitor, RotateCcw, Shield, TerminalSquare, Trash2, X } from "lucide-react";
import { api } from "../api";
import { defaultPreferences, type AccentColor, type AppPreferences, type AppTheme } from "../preferences";
import type { KnownHost } from "../types";

interface SettingsModalProps {
  preferences: AppPreferences;
  onSave: (preferences: AppPreferences) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

type SettingsPage = "appearance" | "terminal" | "shortcuts" | "security";

export function SettingsModal({ preferences, onSave, onClose, onToast }: SettingsModalProps) {
  const [page, setPage] = useState<SettingsPage>("appearance");
  const [draft, setDraft] = useState(preferences);
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [backupDialog, setBackupDialog] = useState<{ mode: "export" | "import"; path: string } | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirmation, setBackupConfirmation] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

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

  const save = () => {
    onSave(draft);
    onToast("外观与终端设置已保存。新设置已应用到所有终端标签。");
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
    if (!window.confirm(`删除 ${host.host}:${host.port} 的本地信任记录？\n下次连接时会重新显示指纹确认。`)) return;
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
        if (!window.confirm(`备份中有 ${preview.imported} 条可恢复凭据，${overwriteHint}\n\n确认继续恢复吗？`)) return;
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

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="settings-modal settings-modal-wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Monitor size={18} /></span>
            <div><h2>设置</h2><p>调整应用外观、终端显示和服务器信任记录。</p></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav">
            <button className={page === "appearance" ? "active" : ""} onClick={() => setPage("appearance")}><Monitor size={15} />外观</button>
            <button className={page === "terminal" ? "active" : ""} onClick={() => setPage("terminal")}><TerminalSquare size={15} />终端</button>
            <button className={page === "shortcuts" ? "active" : ""} onClick={() => setPage("shortcuts")}><Keyboard size={15} />快捷键</button>
            <button className={page === "security" ? "active" : ""} onClick={() => setPage("security")}><Shield size={15} />服务器指纹</button>
          </nav>

          <div className="settings-body settings-page">
            {page === "appearance" && (
              <>
                <SettingsHeading title="界面主题" description="选择工作区的整体明暗与背景风格。" />
                <div className="theme-grid">
                  {THEMES.map((theme) => (
                    <button key={theme.value} className={`theme-card ${draft.theme === theme.value ? "selected" : ""}`} onClick={() => patch({ theme: theme.value })}>
                      <span className={`theme-preview ${theme.value}`}><i /><i /><i /></span>
                      <strong>{theme.label}</strong><small>{theme.description}</small>
                    </button>
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
                  <RangeField label="界面字号" value={draft.uiFontSize} min={12} max={16} step={1} suffix="px" onChange={(value) => patch({ uiFontSize: value })} />
                </div>
                <div className="font-preview" style={{ fontFamily: draft.uiFontFamily, fontSize: draft.uiFontSize }}>
                  XSH 会话目录 · Production Server · 清晰显示中文与 English
                </div>
              </>
            )}

            {page === "terminal" && (
              <>
                <SettingsHeading title="终端字体" description="设置会立即应用到所有已打开和之后创建的终端标签。" />
                <label className="field"><span>等宽字体</span><select value={draft.terminalFontFamily} onChange={(event) => patch({ terminalFontFamily: event.target.value })}>{TERMINAL_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
                <div className="settings-form-grid settings-range-grid">
                  <RangeField label="终端字号" value={draft.terminalFontSize} min={12} max={22} step={1} suffix="px" onChange={(value) => patch({ terminalFontSize: value })} />
                  <RangeField label="行高" value={draft.terminalLineHeight} min={1} max={1.6} step={0.05} suffix="" onChange={(value) => patch({ terminalLineHeight: value })} />
                  <RangeField label="普通字重" value={draft.terminalFontWeight} min={300} max={700} step={100} suffix="" onChange={(value) => patch({ terminalFontWeight: value })} />
                  <RangeField label="粗体字重" value={draft.terminalFontWeightBold} min={400} max={900} step={100} suffix="" onChange={(value) => patch({ terminalFontWeightBold: value })} />
                </div>
                <label className="check-row terminal-profile-toggle"><input type="checkbox" checked={draft.useSessionTerminalFont} onChange={(event) => patch({ useSessionTerminalFont: event.target.checked })} />优先使用会话中单独保存的字体和字号</label>
                <div className={`terminal-font-preview ${draft.theme}`} style={{ fontFamily: draft.terminalFontFamily, fontSize: draft.terminalFontSize, lineHeight: draft.terminalLineHeight, fontWeight: draft.terminalFontWeight }}>
                  <div><span className="prompt">user@server</span>:<span className="path">~/projects/xsh</span>$ cargo test</div>
                  <div className="success">test result: ok. 12 passed; 0 failed</div>
                  <div>中文路径与日志显示测试：连接成功</div>
                </div>
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
          <button className="secondary-button reset-button" onClick={() => setDraft(defaultPreferences)}><RotateCcw size={14} />恢复默认</button>
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" onClick={save}>保存并应用</button>
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

const THEMES: { value: AppTheme; label: string; description: string }[] = [
  { value: "light", label: "浅色", description: "白色工作区" },
  { value: "midnight", label: "深海", description: "蓝黑高对比" },
  { value: "graphite", label: "石墨", description: "中性灰黑" },
  { value: "dusk", label: "暮色", description: "暗紫背景" },
];
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
const TERMINAL_FONTS = [
  { label: "系统等宽字体（推荐）", value: defaultPreferences.terminalFontFamily },
  { label: "Monaco（可选）", value: '"Monaco", "SFMono-Regular", Menlo, Consolas, monospace' },
  { label: "SF Mono", value: '"SFMono-Regular", Menlo, monospace' },
  { label: "Cascadia Code", value: '"Cascadia Code", Consolas, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Menlo, monospace' },
  { label: "Menlo", value: 'Menlo, Monaco, monospace' },
  { label: "Consolas", value: 'Consolas, "Courier New", monospace' },
];

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
