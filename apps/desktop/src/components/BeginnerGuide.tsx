import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, BookOpen, Bot, ChevronRight, Download, Files, Keyboard, Plus, Settings2, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { IS_MACOS } from "../platform";
import "./BeginnerGuide.css";

export type BeginnerGuideTopic = "connect" | "files" | "ai" | "commands" | "preferences" | "import";
export type BeginnerSettingsSection = "appearance" | "ai" | "shortcuts";

interface BeginnerGuideProps {
  open: boolean;
  initialTopic?: BeginnerGuideTopic;
  connectedSessionName?: string | null;
  onClose: () => void;
  onCreateSession: () => void;
  onOpenFiles: () => void;
  onOpenAi: () => void;
  onOpenSettings: (section?: BeginnerSettingsSection) => void;
  onManageQuickCommands: () => void;
  onImportSessions: () => void;
}

const TOPICS = [
  { id: "connect", title: "第一次连接", icon: TerminalSquare },
  { id: "files", title: "传文件", icon: Files },
  { id: "ai", title: "用 AI 帮忙", icon: Bot },
  { id: "commands", title: "保存常用命令", icon: Keyboard },
  { id: "preferences", title: "外观与键盘", icon: Settings2 },
  { id: "import", title: "导入已有会话", icon: Download },
] as const;

export function BeginnerGuide({ open, initialTopic = "connect", connectedSessionName, onClose, onCreateSession, onOpenFiles, onOpenAi, onOpenSettings, onManageQuickCommands, onImportSessions }: BeginnerGuideProps) {
  const [topic, setTopic] = useState<BeginnerGuideTopic>(initialTopic);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const guideId = useId();

  useEffect(() => {
    if (!open) return;
    setTopic(initialTopic);
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open, initialTopic]);

  if (!open) return null;

  const content = guideContent(topic, connectedSessionName);
  const selectedTopic = TOPICS.find((candidate) => candidate.id === topic)!;
  const runAction = (action: () => void) => {
    onClose();
    window.setTimeout(action, 0);
  };
  const primaryAction = topic === "connect" ? onCreateSession
    : topic === "files" ? connectedSessionName ? onOpenFiles : onCreateSession
      : topic === "ai" ? onOpenAi
        : topic === "commands" ? onManageQuickCommands
          : topic === "preferences" ? () => onOpenSettings("appearance") : onImportSessions;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? [])];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  const navigateTopics = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = TOPICS.findIndex((candidate) => candidate.id === topic);
    const next = event.key === "Home" ? 0 : event.key === "End" ? TOPICS.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + TOPICS.length) % TOPICS.length;
    setTopic(TOPICS[next].id);
    document.getElementById(`${guideId}-tab-${TOPICS[next].id}`)?.focus();
  };

  return (
    <div className="modal-backdrop beginner-guide-backdrop" onMouseDown={(event) => { if (event.button === 0 && event.target === event.currentTarget) onClose(); }}>
      <section className="beginner-guide" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${guideId}-title`} onKeyDown={handleKeyDown}>
        <header className="beginner-guide-header"><div><BookOpen size={18} aria-hidden="true" /><h2 id={`${guideId}-title`}>使用指南</h2><span>从一个具体任务开始</span></div><button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} aria-label="关闭使用指南" title="关闭（Esc）"><X size={17} /></button></header>
        <div className="beginner-guide-layout">
          <nav className="beginner-guide-topics" role="tablist" aria-label="学习任务" aria-orientation="vertical">
            {TOPICS.map(({ id, title, icon: TopicIcon }) => <button key={id} id={`${guideId}-tab-${id}`} type="button" role="tab" aria-selected={topic === id} aria-controls={`${guideId}-content`} tabIndex={topic === id ? 0 : -1} onClick={() => setTopic(id)} onKeyDown={navigateTopics}><TopicIcon size={15} aria-hidden="true" /><span>{title}</span><ChevronRight size={12} aria-hidden="true" /></button>)}
          </nav>
          <div id={`${guideId}-content`} className="beginner-guide-content" role="tabpanel" aria-labelledby={`${guideId}-tab-${topic}`} tabIndex={0}>
            <h3>{selectedTopic.title}</h3>
            <p className="beginner-guide-intro">{content.intro}</p>
            <div className="beginner-guide-requirement"><strong>开始前</strong><span>{content.requirement}</span></div>
            <ol className="beginner-guide-steps">{content.steps.map((step) => <li key={step.title}><strong>{step.title}</strong><p>{step.body}</p></li>)}</ol>
            <p className="beginner-guide-next"><ArrowRight size={14} aria-hidden="true" /><span><strong>接下来：</strong>{content.next}</span></p>
            <div className="beginner-guide-actions"><button type="button" className="primary-button" onClick={() => runAction(primaryAction)}>{topic === "connect" || (topic === "files" && !connectedSessionName) ? <Plus size={14} /> : <ArrowRight size={14} />}{content.actionLabel}</button>{topic === "ai" && <button type="button" className="secondary-button" onClick={() => runAction(() => onOpenSettings("ai"))}><Settings2 size={14} />配置 AI 服务</button>}{topic === "connect" && <button type="button" className="secondary-button" onClick={() => setTopic("import")}><Download size={14} />已有会话？</button>}</div>
            {topic === "commands" && <div className="beginner-guide-keys"><span><kbd>{IS_MACOS ? "⌘⇧P" : "Ctrl+Shift+P"}</kbd>命令中心</span><span><kbd>{IS_MACOS ? "⌘1…9" : "Ctrl+Shift+1…9"}</kbd>自定义快捷命令</span></div>}
            {topic === "preferences" && !IS_MACOS && <p className="beginner-guide-footnote">Windows 终端默认将 Ctrl+C 等交给远端程序；本机复制使用 Ctrl+Shift+C。可在设置中调整快捷键模式。</p>}
          </div>
        </div>
        <footer className="beginner-guide-footer"><ShieldCheck size={14} aria-hidden="true" /><span>这些按钮只打开功能界面，连接和发送由你确认。</span><span>帮助 → 使用指南 · <kbd>Esc</kbd> 关闭</span></footer>
      </section>
    </div>
  );
}

function guideContent(topic: BeginnerGuideTopic, connectedSessionName?: string | null) {
  const content = {
    connect: {
      intro: "SSH 用来登录另一台电脑或服务器。先保存连接资料，再由你发起连接。",
      requirement: "准备服务器地址、SSH 端口、用户名，以及密码或私钥。XSH 不提供服务器账号。",
      steps: [{ title: "填写连接资料", body: "点击“新建 SSH 会话”，填写主机和用户名。端口通常是 22，请以服务器实际配置为准。" }, { title: "选择认证方式", body: "使用服务器密码，或选择已有私钥。先保存会话，方便以后从左侧再次打开。" }, { title: "核对并连接", body: "打开保存的会话。首次连接需与服务器管理员核对主机指纹；看到终端提示符后才能输入命令。" }],
      next: "已连接时左侧显示绿点。连接失败可右键会话打开“连接诊断”，检查地址、网络和认证。",
      actionLabel: "新建 SSH 会话",
    },
    files: {
      intro: "SFTP 用来在本机和当前服务器之间传文件，不需要把文件内容粘贴到终端。",
      requirement: connectedSessionName ? `当前已连接：${connectedSessionName}。服务器还需支持 SFTP，并允许你读写目标目录。` : "先打开并连接一个 SSH 会话。文件面板跟随当前会话，不用于 VNC/RDP 桌面会话。",
      steps: [{ title: "选择目标会话", body: "先点选要传文件的终端标签，确认会话名称，再打开右侧“文件”面板。" }, { title: "确认方向和目录", body: "上传是从本机到服务器，下载是从服务器到本机。先进入正确的服务器目录，再选择文件。" }, { title: "查看传输结果", body: "从文件面板发起上传或下载，在传输队列查看进度。遇到同名文件时先确认是否覆盖。" }],
      next: "若提示权限不足，换到当前账号可读写的目录，或向服务器管理员确认权限。",
      actionLabel: connectedSessionName ? "打开文件面板" : "先新建 SSH 会话",
    },
    ai: {
      intro: "让 AI 解释选中的输出、分析报错，或按你的描述生成一份可编辑命令。",
      requirement: "先在全局设置的 AI 服务中填写地址、模型和 API Key，并启用。保存配置不会发送终端内容。",
      steps: [{ title: "提供少量上下文", body: "拖选终端文字，点击上方“解释 / 分析报错”；Shift+右键也能打开菜单。AI 面板可手动附加最近50行，或直接描述需求。" }, { title: "预览后再发送", body: "检查问题与上下文的脱敏预览，删除仍然敏感的信息，确认后才会发给你配置的 AI 服务。" }, { title: "核对命令草稿", body: "生成的命令可继续编辑。检查用途、参数与目标会话，确认后只发送到草稿关联的会话。" }],
      next: "默认不会读取完整终端历史；AI 草稿不使用广播。执行前仍需自己核对命令。",
      actionLabel: "打开 AI 助手",
    },
    commands: {
      intro: "把经常手输的命令保存到底部快捷命令栏，离线时也可以添加和编辑。",
      requirement: "先准备你已经理解的命令。添加无需联网；发送前要有已连接的目标会话。",
      steps: [{ title: "添加一条命令", body: "点击底部“添加命令”，填写容易辨认的名称与命令内容，可选择快捷键或每次发送前确认。" }, { title: "管理已有命令", body: "双击或右键命令可以编辑，拖动按钮可调整顺序；底部标题旁显示已保存的数量。" }, { title: "确认目标再发送", body: "查看栏上的“发送至”。如果开启广播，同一命令会发到多个会话，需额外确认。" }],
      next: "命令中心适合按名称查找；快捷命令栏适合常用操作。不要在命令中保存密码或密钥。",
      actionLabel: "添加或管理快捷命令",
    },
    preferences: {
      intro: "先把终端调到能长时间看清、按键符合习惯，再继续连接工作。",
      requirement: "主题、界面字号、终端字体和快捷键模式统一在全局设置中调整。",
      steps: [{ title: "选择主题和字号", body: "在外观页选明暗主题，检查菜单、侧栏和终端对比度，按屏幕大小调整界面字号。" }, { title: "设置终端字体", body: "选择已安装的等宽字体，再调整终端字号与行高；这些影响命令和输出的可读性。" }, { title: "理解复制与快捷键", body: `当前系统复制使用 ${IS_MACOS ? "⌘C" : "Ctrl+Shift+C"}，查找使用 ${IS_MACOS ? "⌘F" : "Ctrl+Shift+F"}。需要时在键盘设置中调整本机与远端的按键分配。` }],
      next: "设置保存在本机；调整完成后关闭设置，回到终端验证字体与按键。",
      actionLabel: "打开外观设置",
    },
    import: {
      intro: "已经保存过连接资料时，可以先导入，再逐个检查主机与认证。",
      requirement: "准备 XSH 支持的会话文件。需要文件密码的导出包，应同时准备正确密码；其他工具的格式请先核对导入支持。",
      steps: [{ title: "选择已有文件", body: "点击“导入已有会话”，从文件选择器选取要导入的文件，按界面提示填写密码。" }, { title: "检查导入结果", body: "在左侧会话目录检查名称、主机和分组；导入资料不等于已经连接成功。" }, { title: "补全认证并连接", body: "如果原文件没有可用凭据，编辑会话后重新填写密码或选择私钥，再由你打开连接。" }],
      next: "本机已有 ~/.ssh/config 时，也可以从文件菜单的“SSH 配置管理”读取现有主机。",
      actionLabel: "导入已有会话",
    },
  };
  return content[topic];
}
