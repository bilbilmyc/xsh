import { useMemo } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, Bot, Files, History, Monitor, Plus, RotateCcw, TerminalSquare } from "lucide-react";
import xshIcon from "../assets/xsh-icon.svg";
import { IS_MACOS } from "../platform";
import { loadRecentSessions, loadRecentlyOpenedSessions, type RecentSession } from "../recent-sessions";
import type { SavedSession } from "../types";
import type { BeginnerGuideTopic } from "./BeginnerGuide";
import "./welcome-panel.css";

interface WelcomePanelProps {
  sessions: SavedSession[];
  onOpen: (session: SavedSession) => void;
  onCreate: () => void;
  onRestoreWorkspace: () => void;
  recentSessions?: RecentSession[];
  recentVersion?: number;
  onOpenGuide?: (topic?: BeginnerGuideTopic) => void;
  onOpenFiles?: () => void;
  onOpenAi?: () => void;
}

export function WelcomePanel({
  sessions,
  onOpen,
  onCreate,
  onRestoreWorkspace,
  recentSessions,
  recentVersion = 0,
  onOpenGuide,
  onOpenFiles,
  onOpenAi,
}: WelcomePanelProps) {
  const recent = useMemo(() => {
    const savedById = new Map(sessions.map((session) => [session.id, session]));
    const connected = (recentSessions ?? loadRecentSessions()).filter((item) => savedById.has(item.sessionId));
    const history = connected.length > 0 ? connected : loadRecentlyOpenedSessions();
    return {
      title: connected.length > 0 ? "最近连接" : "最近打开",
      items: history.flatMap((item) => {
        const session = savedById.get(item.sessionId);
        return session ? [{ session, lastConnectedAt: item.lastConnectedAt }] : [];
      }).slice(0, 5),
    };
  }, [sessions, recentSessions, recentVersion]);

  return (
    <section className="xsh-welcome" aria-labelledby="xsh-welcome-title">
      <div className="xsh-welcome-content">
        <img className="xsh-welcome-logo" src={xshIcon} width="44" height="44" alt="" />
        <h1 id="xsh-welcome-title">{recent.items.length > 0 ? "继续你的终端工作" : "从第一次 SSH 连接开始"}</h1>
        <p className="xsh-welcome-description">{recent.items.length > 0 ? "打开最近会话，或选择下面要完成的任务。" : "准备好服务器地址、用户名和认证方式，其余跟着三步走。"}</p>
        <div className="xsh-welcome-actions">
          <button className="primary-button" onClick={onCreate}><Plus size={15} aria-hidden="true" />新建会话</button>
          <button className="secondary-button" onClick={onRestoreWorkspace} title="选择已保存的工作区并恢复连接">
            <RotateCcw size={14} aria-hidden="true" />恢复工作区
          </button>
        </div>
        {recent.items.length === 0 && <ol className="xsh-welcome-first-steps" aria-label="第一次连接的三个步骤"><li><span>1</span>准备主机与账号</li><li><span>2</span>新建并保存会话</li><li><span>3</span>核对指纹后连接</li></ol>}
        {recent.items.length > 0 && (
          <div className="xsh-welcome-recents">
            <h2><History size={13} aria-hidden="true" />{recent.title}</h2>
            <ul>
              {recent.items.map(({ session, lastConnectedAt }) => {
                const endpoint = `${session.username ? `${session.username}@` : ""}${session.host}:${session.port}`;
                const SessionIcon = session.kind === "remoteDesktop" ? Monitor : TerminalSquare;
                return (
                  <li key={session.id}>
                    <button onClick={() => onOpen(session)} title={`打开 ${session.name} · ${endpoint}`}>
                      <SessionIcon className="xsh-welcome-session-icon" size={16} aria-hidden="true" />
                      <span className="xsh-welcome-session-info"><strong>{session.name}</strong><small>{endpoint}</small></span>
                      <time dateTime={lastConnectedAt} title={new Date(lastConnectedAt).toLocaleString()}>{formatRecentTime(lastConnectedAt)}</time>
                      <ArrowUpRight className="xsh-welcome-open-icon" size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="xsh-welcome-tasks" aria-label="常用任务">
          <h2>你想先做什么？</h2>
          <button type="button" onClick={onCreate}><TerminalSquare size={16} aria-hidden="true" /><span><strong>第一次连接</strong><small>填写主机、用户和认证，保存为 SSH 会话</small></span><ArrowRight size={14} aria-hidden="true" /></button>
          <button type="button" disabled={!onOpenFiles && !onOpenGuide} onClick={() => onOpenFiles ? onOpenFiles() : onOpenGuide?.("files")}><Files size={16} aria-hidden="true" /><span><strong>传文件</strong><small>先连接 SSH，再在文件面板上传或下载</small></span><ArrowRight size={14} aria-hidden="true" /></button>
          <button type="button" disabled={!onOpenAi && !onOpenGuide} onClick={() => onOpenAi ? onOpenAi() : onOpenGuide?.("ai")}><Bot size={16} aria-hidden="true" /><span><strong>用 AI 帮忙</strong><small>配置自己的服务，解释选区或生成命令草稿</small></span><ArrowRight size={14} aria-hidden="true" /></button>
        </div>
        {onOpenGuide && <button className="xsh-welcome-guide" type="button" onClick={() => onOpenGuide()}><BookOpen size={14} aria-hidden="true" />查看使用指南<span>连接、文件、AI、快捷命令与设置</span></button>}
        <div className="xsh-welcome-shortcuts" aria-label="常用快捷键">
          <span><kbd>{IS_MACOS ? "⌘C" : "Ctrl+Shift+C"}</kbd>复制</span>
          <span><kbd>{IS_MACOS ? "⌘F" : "Ctrl+Shift+F"}</kbd>查找</span>
          <span><kbd>{IS_MACOS ? "⌘⇧P" : "Ctrl+Shift+P"}</kbd>命令中心</span>
        </div>
      </div>
    </section>
  );
}

function formatRecentTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay
    ? `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`
    : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
