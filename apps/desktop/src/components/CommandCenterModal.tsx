import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  ClipboardCopy,
  Command,
  Edit3,
  Play,
  Plus,
  Search,
  ShieldAlert,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  createCommandSnippet,
  emptyCommandSnippet,
  updateCommandSnippet,
  type CommandSnippet,
  type CommandSnippetDraft,
} from "../command-library";
import { containsSensitiveCommand, SENSITIVE_COMMAND_ERROR } from "../sensitive-command";

interface CommandCenterModalProps {
  commands: CommandSnippet[];
  activeSessionName: string | null;
  activeSessionAddress: string | null;
  broadcastEnabled: boolean;
  broadcastTargetCount: number;
  canExecute: boolean;
  executionUnavailableReason: string;
  onChange: (commands: CommandSnippet[]) => void;
  onExecute: (command: CommandSnippet) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

type EditorState =
  | { mode: "browse" }
  | { mode: "create"; draft: CommandSnippetDraft }
  | { mode: "edit"; command: CommandSnippet; draft: CommandSnippetDraft };

export function CommandCenterModal({
  commands,
  activeSessionName,
  activeSessionAddress,
  broadcastEnabled,
  broadcastTargetCount,
  canExecute,
  executionUnavailableReason,
  onChange,
  onExecute,
  onClose,
  onToast,
}: CommandCenterModalProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [selectedId, setSelectedId] = useState<string | null>(commands[0]?.id ?? null);
  const [editor, setEditor] = useState<EditorState>({ mode: "browse" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editor.mode === "browse") onClose();
        else setEditor({ mode: "browse" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor.mode, onClose]);

  const categories = useMemo(
    () => ["全部", ...Array.from(new Set(commands.map((command) => command.category))).sort((a, b) => a.localeCompare(b, "zh-CN"))],
    [commands],
  );

  const filteredCommands = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return commands.filter((command) => {
      if (category !== "全部" && command.category !== category) return false;
      if (!normalized) return true;
      return [command.name, command.description, command.category, command.command, ...command.tags]
        .some((value) => value.toLowerCase().includes(normalized));
    });
  }, [category, commands, query]);

  const selected = filteredCommands.find((command) => command.id === selectedId) ?? filteredCommands[0] ?? null;

  const beginCreate = () => {
    setError(null);
    setEditor({ mode: "create", draft: emptyCommandSnippet() });
  };

  const beginEdit = (command: CommandSnippet) => {
    setError(null);
    setEditor({
      mode: "edit",
      command,
      draft: {
        name: command.name,
        description: command.description,
        category: command.category,
        tags: command.tags,
        command: command.command,
        requiresConfirmation: command.requiresConfirmation,
        favorite: command.favorite,
      },
    });
  };

  const saveEditor = () => {
    if (editor.mode === "browse") return;
    const draft = editor.draft;
    if (!draft.name.trim()) {
      setError("请填写命令名称。");
      return;
    }
    if (!draft.command.trim()) {
      setError("请填写要执行的命令内容。");
      return;
    }
    if (containsSensitiveCommand(draft.command)) {
      setError(SENSITIVE_COMMAND_ERROR);
      return;
    }
    const next = editor.mode === "create"
      ? [createCommandSnippet(draft), ...commands]
      : commands.map((command) => command.id === editor.command.id ? updateCommandSnippet(command, draft) : command);
    onChange(next);
    const saved = editor.mode === "create" ? next[0] : next.find((command) => command.id === editor.command.id) ?? null;
    if (saved) setSelectedId(saved.id);
    setEditor({ mode: "browse" });
    setError(null);
    onToast(editor.mode === "create" ? "命令片段已保存。" : "命令片段已更新。");
  };

  const deleteCommand = (command: CommandSnippet) => {
    if (!window.confirm(`确定删除命令片段“${command.name}”？`)) return;
    const next = commands.filter((candidate) => candidate.id !== command.id);
    onChange(next);
    setSelectedId(next[0]?.id ?? null);
    onToast("命令片段已删除。");
  };

  const toggleFavorite = (command: CommandSnippet) => {
    onChange(commands.map((candidate) => candidate.id === command.id
      ? updateCommandSnippet(candidate, { ...candidate, favorite: !candidate.favorite })
      : candidate));
  };

  const copyCommand = async (command: CommandSnippet) => {
    try {
      await navigator.clipboard.writeText(command.command);
      onToast(`已复制“${command.name}”。`);
    } catch {
      onToast("复制失败，请检查系统剪贴板权限。");
    }
  };

  const runCommand = (command: CommandSnippet) => {
    if (!canExecute) {
      onToast(executionUnavailableReason);
      return;
    }
    const risk = detectCommandRisk(command.command);
    const requiresConfirmation = command.requiresConfirmation || /\r?\n/.test(command.command.trim()) || Boolean(risk);
    if (requiresConfirmation) {
      const target = broadcastEnabled
        ? `广播到 ${broadcastTargetCount} 个已连接会话${activeSessionName ? `（当前：${activeSessionName}）` : ""}`
        : `${activeSessionName ?? "当前会话"}${activeSessionAddress ? `\n${activeSessionAddress}` : ""}`;
      const riskNote = risk ? `\n\n风险提示：${risk}` : "";
      if (!window.confirm(`执行目标：${target}\n\n命令：\n${command.command}${riskNote}\n\n是否继续？`)) return;
    }
    onExecute(command);
  };

  const updateDraft = (update: Partial<CommandSnippetDraft>) => {
    if (editor.mode === "browse") return;
    setEditor({ ...editor, draft: { ...editor.draft, ...update } });
  };

  const editorOpen = editor.mode !== "browse";

  return (
    <div className="modal-backdrop command-center-backdrop" onMouseDown={onClose}>
      <section className="command-center-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="命令中心">
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Command size={18} /></span>
            <div>
              <h2>命令中心</h2>
              <p>把常用 SSH 命令整理成可检索、可安全派发的片段。</p>
            </div>
          </div>
          <div className="command-center-header-actions">
            <kbd>⌘/Ctrl ⇧ P</kbd>
            <button className="icon-button" onClick={onClose} aria-label="关闭命令中心"><X size={18} /></button>
          </div>
        </header>

        {editorOpen ? (
          <CommandEditor
            state={editor}
            error={error}
            onBack={() => { setEditor({ mode: "browse" }); setError(null); }}
            onUpdate={updateDraft}
            onSave={saveEditor}
          />
        ) : (
          <div className="command-center-body">
            <aside className="command-library-pane">
              <div className="command-library-tools">
                <label className="command-search">
                  <Search size={15} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} autoFocus placeholder="搜索命令、标签或正文" />
                </label>
                <button className="primary-button command-new-button" onClick={beginCreate}><Plus size={15} />新建</button>
              </div>
              <div className="command-filter-row">
                <span>分类</span>
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  {categories.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <small>{filteredCommands.length} 条</small>
              </div>
              <div className="command-list">
                {filteredCommands.map((command) => (
                  <button
                    key={command.id}
                    className={`command-list-item ${selected?.id === command.id ? "active" : ""}`}
                    onClick={() => setSelectedId(command.id)}
                  >
                    <span className="command-list-item-top">
                      <strong>{command.name}</strong>
                      {command.favorite && <Star size={13} fill="currentColor" />}
                    </span>
                    <span>{command.description || command.command.split(/\r?\n/, 1)[0]}</span>
                    <small>{command.category}{command.tags.length > 0 ? ` · ${command.tags.join(" · ")}` : ""}</small>
                  </button>
                ))}
                {filteredCommands.length === 0 && (
                  <div className="command-empty-state">
                    <Command size={24} />
                    <strong>{commands.length === 0 ? "还没有命令片段" : "没有匹配的命令"}</strong>
                    <span>{commands.length === 0 ? "将日常命令保存为片段，在连接后快速发送。" : "试试修改关键词或分类筛选。"}</span>
                    {commands.length === 0 && <button className="secondary-button" onClick={beginCreate}><Plus size={14} />创建第一条命令</button>}
                  </div>
                )}
              </div>
            </aside>

            <section className="command-detail-pane">
              {selected ? (
                <>
                  <div className="command-detail-header">
                    <div>
                      <div className="command-eyebrow">{selected.category}</div>
                      <h3>{selected.name}</h3>
                      {selected.description && <p>{selected.description}</p>}
                    </div>
                    <button
                      className={`icon-button ${selected.favorite ? "favorite-active" : ""}`}
                      title={selected.favorite ? "取消收藏" : "加入收藏"}
                      onClick={() => toggleFavorite(selected)}
                    ><Star size={16} fill={selected.favorite ? "currentColor" : "none"} /></button>
                  </div>
                  {selected.tags.length > 0 && <div className="command-tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
                  <pre className="command-preview"><code>{selected.command}</code></pre>
                  {selected.requiresConfirmation && <div className="command-safety-note"><ShieldAlert size={14} />此命令已标记为执行前确认。</div>}
                  <div className="command-execution-target">
                    <span>执行目标</span>
                    <strong>{canExecute && activeSessionName ? activeSessionName : executionUnavailableReason}</strong>
                  </div>
                  <div className="command-detail-actions">
                    <button className="secondary-button" onClick={() => void copyCommand(selected)}><ClipboardCopy size={15} />复制</button>
                    <button className="secondary-button" onClick={() => beginEdit(selected)}><Edit3 size={15} />编辑</button>
                    <button className="danger-button" onClick={() => deleteCommand(selected)}><Trash2 size={15} />删除</button>
                    <button className="primary-button" onClick={() => runCommand(selected)} disabled={!canExecute} title={canExecute ? "发送到活动终端" : executionUnavailableReason}><Play size={15} />发送到终端</button>
                  </div>
                </>
              ) : (
                <div className="command-empty-state command-detail-empty"><Command size={30} /><strong>选择一条命令</strong><span>命令详情和执行入口会显示在这里。</span></div>
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

interface CommandEditorProps {
  state: Exclude<EditorState, { mode: "browse" }>;
  error: string | null;
  onBack: () => void;
  onUpdate: (update: Partial<CommandSnippetDraft>) => void;
  onSave: () => void;
}

function CommandEditor({ state, error, onBack, onUpdate, onSave }: CommandEditorProps) {
  const draft = state.draft;
  return (
    <div className="command-editor-body">
      <div className="command-editor-heading">
        <button className="secondary-button" onClick={onBack}><ChevronLeft size={15} />返回命令库</button>
        <div><h3>{state.mode === "create" ? "新建命令片段" : "编辑命令片段"}</h3><p>只保存命令文本和描述，请勿在这里写入密码、Token 或私钥。</p></div>
      </div>
      <div className="command-form-grid">
        <label className="field"><span>命令名称</span><input value={draft.name} onChange={(event) => onUpdate({ name: event.target.value })} autoFocus placeholder="例如：查看磁盘使用率" /></label>
        <label className="field"><span>分类</span><input value={draft.category} onChange={(event) => onUpdate({ category: event.target.value })} placeholder="例如：巡检" /></label>
        <label className="field field-span-2"><span>说明（可选）</span><input value={draft.description} onChange={(event) => onUpdate({ description: event.target.value })} placeholder="说明这条命令的用途和影响范围" /></label>
        <label className="field field-span-2"><span>标签（用逗号分隔）</span><input value={draft.tags.join(", ")} onChange={(event) => onUpdate({ tags: event.target.value.split(",") })} placeholder="例如：生产, Linux, 巡检" /></label>
        <label className="field field-span-2"><span>命令正文</span><textarea className="command-textarea" value={draft.command} onChange={(event) => onUpdate({ command: event.target.value })} placeholder="df -h" spellCheck={false} /></label>
      </div>
      <label className="check-row command-confirm-row"><input type="checkbox" checked={draft.requiresConfirmation} onChange={(event) => onUpdate({ requiresConfirmation: event.target.checked })} />执行前总是要求确认</label>
      <label className="check-row command-confirm-row"><input type="checkbox" checked={draft.favorite} onChange={(event) => onUpdate({ favorite: event.target.checked })} />加入收藏</label>
      {error && <div className="form-error">{error}</div>}
      <div className="command-editor-footer"><span><ShieldAlert size={14} />多行命令在发送前也会二次确认。</span><button className="primary-button" onClick={onSave}><Check size={15} />保存命令</button></div>
    </div>
  );
}

function detectCommandRisk(command: string): string | null {
  const normalized = command.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/\brm\b|\brmdir\b|\bdel\b/, "删除命令可能不可恢复"],
    [/\b(shutdown|reboot|halt|poweroff)\b/, "会导致目标主机重启或关机"],
    [/\bsystemctl\s+(stop|disable|mask)\b/, "可能停止或禁用系统服务"],
    [/\bkill(all)?\b/, "可能终止正在运行的进程"],
    [/\bdd\s+if=/, "可能直接改写磁盘数据"],
    [/\bmkfs(?:\.|\s)/, "可能格式化文件系统"],
    [/\bdrop\s+(database|table|schema)\b/, "可能删除数据库对象"],
  ];
  return patterns.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}
