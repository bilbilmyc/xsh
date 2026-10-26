import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { version } from "../../package.json";
import { checkForUpdates, downloadUpdate, installUpdate, useAppUpdate } from "../app-updates";
import { IS_MACOS } from "../platform";
import { confirmDialog } from "./DialogHost";
import "./AppUpdateSettings.css";

export function AppUpdateSettings() {
  const { phase, info, progress, error } = useAppUpdate();
  const installPending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const busy = ["checking", "downloading", "installing"].includes(phase);
  const percent = progress ? Math.min(100, Math.floor(progress.downloaded / progress.total * 100)) : 0;
  const installLabel = IS_MACOS ? "退出并打开安装包" : "退出并安装";

  useEffect(() => {
    if (phase === "idle") void checkForUpdates();
  }, [phase]);

  const handleInstall = async () => {
    if (installPending.current) return;
    installPending.current = true;
    setConfirming(true);
    try {
      if (!await confirmDialog({
        title: IS_MACOS ? "打开更新安装包" : "安装 XSH 更新",
        message: `XSH 将退出并断开当前连接，请先保存远程编辑内容。${IS_MACOS ? "安装包打开后，将 XSH 拖入「应用程序」替换旧版本。" : "安装程序启动后，按提示完成安装，再重新打开 XSH。"}`,
        confirmLabel: installLabel,
      })) return;
      await installUpdate();
    } finally {
      installPending.current = false;
      setConfirming(false);
    }
  };

  const status = phase === "checking" ? "正在检查更新…"
    : phase === "downloading" ? (percent === 100 ? "下载完成，正在校验安装包…" : "正在下载更新…")
    : phase === "installing" ? "正在校验并启动安装程序…"
    : phase === "ready" ? "安装包已下载并通过 SHA-256 校验。"
    : phase === "current" ? (info?.latestVersion ? "当前已是最新版本。" : "暂时还没有正式发布版本。")
    : phase === "available" ? `发现新版本 v${info?.latestVersion}`
    : phase === "error" ? "检查更新失败"
    : "检查是否有新的正式版本。";

  return (
    <section className="app-update-settings" aria-label="应用更新">
      <div className="settings-heading">
        <strong>应用更新</strong>
        <span>从 XSH 官方 GitHub Release 获取正式版本。</span>
      </div>
      <div className="app-update-card">
        <div className="app-update-version">
          <strong>XSH</strong>
          <span>当前版本 v{info?.currentVersion ?? version}</span>
        </div>
        <div className="app-update-status" role="status" aria-live="polite">
          {busy ? <LoaderCircle size={17} className="app-update-spinner" aria-hidden="true" />
            : phase === "current" || phase === "ready" ? <CheckCircle2 size={17} aria-hidden="true" />
            : <RefreshCw size={17} aria-hidden="true" />}
          <span>{status}</span>
        </div>
        {info?.available && (
          <dl className="app-update-details">
            <div><dt>最新版本</dt><dd>v{info.latestVersion}</dd></div>
            {info.publishedAt && <div><dt>发布时间</dt><dd>{formatDate(info.publishedAt)}</dd></div>}
            {info.downloadName && <div><dt>安装包</dt><dd>{info.downloadName}{info.downloadSize ? ` · ${formatBytes(info.downloadSize)}` : ""}</dd></div>}
          </dl>
        )}
        {phase === "downloading" && (
          <div className="app-update-progress">
            <progress aria-label="更新下载进度" max={100} value={progress ? percent : undefined} />
            <span>{progress ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} · ${percent}%` : "正在连接下载服务…"}</span>
          </div>
        )}
        {error && <div className="panel-error app-update-error" role="alert">{error}</div>}
        {info?.downloadUnavailableReason && <div className="settings-tip warning">{info.downloadUnavailableReason}</div>}
        <div className="app-update-actions">
          <button type="button" className="secondary-button" disabled={busy || confirming} onClick={() => void checkForUpdates({ force: true })}>
            <RefreshCw size={14} />{phase === "checking" ? "正在检查…" : "检查更新"}
          </button>
          {phase === "available" && info?.downloadName && (
            <button type="button" className="primary-button" onClick={() => void downloadUpdate()}><Download size={14} />下载更新</button>
          )}
          {(phase === "ready" || phase === "installing") && (
            <button type="button" className="primary-button" disabled={busy || confirming} onClick={() => void handleInstall()}>
              <Download size={14} />{phase === "installing" ? "正在启动…" : installLabel}
            </button>
          )}
        </div>
        <p className="app-update-hint">下载期间可继续使用 XSH，关闭设置后下载仍会继续。安装前会提示退出应用。</p>
      </div>
      {info?.releaseNotes && (
        <div className="app-update-release-notes">
          <h3>v{info.latestVersion} 更新说明</h3>
          <pre>{info.releaseNotes}</pre>
        </div>
      )}
    </section>
  );
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("zh-CN");
}
