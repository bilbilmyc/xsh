import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { Check, ChevronDown, CircleHelp, Send, TerminalSquare, Trash2, X } from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  createQuickCommand,
  emptyQuickCommand,
  updateQuickCommand,
  type QuickCommandDraft,
  type QuickCommandItem,
} from "../quick-command-bar";
import { containsSensitiveCommand, SENSITIVE_COMMAND_ERROR } from "../sensitive-command";
import type { TerminalShortcutMode } from "../preferences";

interface QuickCommandBarProps {
  items: Array<QuickCommandItem | null>;
  canSend: boolean;
  unavailableReason: string;
  targetName: string | null;
  terminalShortcutMode: TerminalShortcutMode;
  onChange: (items: Array<QuickCommandItem | null>) => void;
  onSend: (item: QuickCommandItem, text: string) => void;
  onToast: (message: string) => void;
}

type EditorState = { slot: number; item: QuickCommandItem | null; draft: QuickCommandDraft } | null;

const IS_MACOS = /mac|iphone|ipad/i.test(`${navigator.platform} ${navigator.userAgent}`);
const shortcutOptions = [
  { value: "", label: "不绑定快捷键" },
  ...Array.from({ length: 9 }, (_, index) => ({
    value: `mod-${index + 1}`,
    label: `macOS ⌘${index + 1} / Windows Ctrl+Shift+${index + 1}`,
  })),
];

export function QuickCommandBar({
  items,
  canSend,
  unavailableReason,
  targetName,
  terminalShortcutMode,
  onChange,
  onSend,
  onToast,
}: QuickCommandBarProps) {
  const [expanded, setExpanded] = useState(true);
  const [editor, setEditor] = useState<EditorState>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentItemId, setSentItemId] = useState<string | null>(null);
  const [draggedSlot, setDraggedSlot] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; slot: number } | null>(null);
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditor(null);
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onEscape);
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  const nextEmptySlot = () => items.findIndex((item) => item === null);

  const openEditor = (slot: number) => {
    if (slot < 0) {
      onToast("快捷命令最多保存 10 项，请先双击已有命令进行编辑或删除。 ");
      return;
    }
    const item = items[slot] ?? null;
    setEditor({
      slot,
      item,
      draft: item
        ? { label: item.label, command: item.command, group: item.group, shortcut: item.shortcut, requiresConfirmation: item.requiresConfirmation }
        : emptyQuickCommand(),
    });
    setError(null);
  };

  const saveEditor = () => {
    if (!editor) return;
    const { draft, item, slot } = editor;
    if (!draft.label.trim()) {
      setError("请填写按钮名称。");
      return;
    }
    if (!draft.command.trim()) {
      setError("请填写点击后要发送的命令。");
      return;
    }
    if (containsSensitiveCommand(draft.command)) {
      setError(SENSITIVE_COMMAND_ERROR);
      return;
    }
    if (draft.shortcut && items.some((candidate, index) => index !== slot && candidate?.shortcut === draft.shortcut)) {
      setError("这个快捷键已经被其他命令占用，请换一个。");
      return;
    }
    const next = [...items];
    next[slot] = item ? updateQuickCommand(item, draft) : createQuickCommand(draft);
    onChange(next);
    setEditor(null);
    onToast("快捷命令已保存。 ");
  };

  const removeEditorItem = () => {
    if (!editor?.item) return;
    const next = [...items];
    next[editor.slot] = null;
    onChange(next);
    setEditor(null);
    onToast("快捷命令已移除。 ");
  };

  const moveItem = (sourceSlot: number, targetSlot: number) => {
    if (sourceSlot === targetSlot) return;
    const next = [...items];
    [next[sourceSlot], next[targetSlot]] = [next[targetSlot], next[sourceSlot]];
    onChange(next);
  };

  const runItem = (item: QuickCommandItem) => {
    if (!canSend) {
      onToast(unavailableReason);
      return;
    }
    const needsConfirmation = item.requiresConfirmation || /\r?\n/.test(item.command.trim());
    if (needsConfirmation && !window.confirm(`即将向“${targetName}”发送：\n\n${item.command}\n\n是否继续？`)) return;
    onSend(item, item.command);
    setSentItemId(item.id);
    window.setTimeout(() => setSentItemId((current) => current === item.id ? null : current), 900);
  };

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const modifier = IS_MACOS
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
      if (!modifier) return;
      const terminalHasFocus = event.target instanceof Element && event.target.closest(".terminal-pane") !== null;
      if (!IS_MACOS && terminalShortcutMode === "remote-first" && terminalHasFocus) return;
      if (editor || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement | null)?.tagName ?? "")) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit) return;
      const shortcut = `mod-${digit}`;
      const item = items.find((candidate) => candidate?.shortcut === shortcut);
      if (!item) return;
      event.preventDefault();
      runItem(item);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [editor, items, canSend, unavailableReason, targetName, terminalShortcutMode]);

  const scheduleRun = (item: QuickCommandItem) => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      runItem(item);
    }, 220);
  };

  const showCommandMenu = (event: MouseEvent, slot: number) => {
    event.preventDefault();
    event.stopPropagation();
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    setContextMenu({ x: event.clientX, y: event.clientY, slot });
  };

  const openEditorFromDoubleClick = (event: MouseEvent, slot: number) => {
    event.preventDefault();
    event.stopPropagation();
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    openEditor(slot);
  };

  const updateDraft = (update: Partial<QuickCommandDraft>) => {
    if (!editor) return;
    setEditor({ ...editor, draft: { ...editor.draft, ...update } });
  };

  const handleBarDoubleClick = () => openEditor(nextEmptySlot());

  const navigateCommandButtons = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(".quick-command-button") ?? [],
    );
    if (buttons.length < 2) return;
    const currentIndex = buttons.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (currentIndex + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return (
    <>
      <section
        className={`quick-command-bar ${expanded ? "expanded" : "collapsed"}`}
        aria-label="快捷命令栏"
        onDoubleClick={handleBarDoubleClick}
        title="单击发送；双击或右键编辑；拖拽按钮可调整顺序"
      >
        <div className="quick-command-title">
          <TerminalSquare size={14} />
          <span>快捷命令</span>
          <button
            type="button"
            className="quick-command-help"
            aria-label="快捷命令操作说明"
            title="单击命令发送；双击或右键编辑；拖拽按钮调整顺序；双击空白处添加命令"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <CircleHelp size={13} />
          </button>
        </div>
        {expanded && (
          <>
            <div className="quick-command-slots">
              {items.map((item, slot) => item ? (
                <button
                  key={item.id}
                  className={`quick-command-button ${!canSend ? "unavailable" : ""} ${sentItemId === item.id ? "sent" : ""} ${draggedSlot === slot ? "dragging" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    setDraggedSlot(slot);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(slot));
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceSlot = Number(event.dataTransfer.getData("text/plain"));
                    if (Number.isInteger(sourceSlot) && sourceSlot >= 0 && sourceSlot < items.length) moveItem(sourceSlot, slot);
                    setDraggedSlot(null);
                  }}
                  onDragEnd={() => setDraggedSlot(null)}
                  onClick={(event) => { event.stopPropagation(); scheduleRun(item); }}
                  onKeyDown={navigateCommandButtons}
                  onDoubleClick={(event) => openEditorFromDoubleClick(event, slot)}
                  onContextMenu={(event) => showCommandMenu(event, slot)}
                  title={`${item.command}\n分组：${item.group}${item.shortcut ? `\n快捷键：macOS ⌘${item.shortcut.slice(-1)} / Windows Ctrl+Shift+${item.shortcut.slice(-1)}` : ""}\n单击发送，双击或右键编辑，拖拽调整顺序`}
                >
                  <Send size={12} />
                  <span>{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut.slice(-1)}</kbd>}
                </button>
              ) : null)}
            </div>
          </>
        )}
        <button
          className="quick-command-collapse"
          onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
          title={expanded ? "收起快捷命令栏" : "展开快捷命令栏"}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <ChevronDown size={15} />
        </button>
      </section>

      {contextMenu && items[contextMenu.slot] && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            { label: "编辑快捷命令", onClick: () => openEditor(contextMenu.slot) },
            {
              label: "删除快捷命令",
              danger: true,
              separatorBefore: true,
              onClick: () => {
                const next = [...items];
                next[contextMenu.slot] = null;
                onChange(next);
                onToast("快捷命令已移除。 ");
              },
            },
          ] satisfies ContextMenuItem[]}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editor && (
        <div className="modal-backdrop quick-command-modal-backdrop" onMouseDown={() => setEditor(null)}>
          <section className="quick-command-editor-modal" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div className="modal-title-wrap">
                <span className="modal-icon"><TerminalSquare size={18} /></span>
                <div>
                  <h2>{editor.item ? "编辑快捷命令" : "配置快捷命令"}</h2>
                  <p>双击空白区域添加；双击或右键已有命令进行编辑。</p>
                </div>
              </div>
              <button className="icon-button" onClick={() => setEditor(null)} aria-label="关闭"><X size={18} /></button>
            </header>
            <div className="quick-command-editor-body">
              <label className="field"><span>按钮名称</span><input autoFocus value={editor.draft.label} onChange={(event) => updateDraft({ label: event.target.value })} placeholder="例如：查看磁盘" /></label>
              <label className="field"><span>命令分组</span><input value={editor.draft.group} onChange={(event) => updateDraft({ group: event.target.value })} placeholder="例如：运维、Docker、日志" /></label>
              <label className="field"><span>点击后发送的命令</span><textarea className="quick-command-textarea" value={editor.draft.command} onChange={(event) => updateDraft({ command: event.target.value })} placeholder={'例如：df -h\n支持 \\r 回车、\\n 换行、\\t Tab'} spellCheck={false} /></label>
              <p className="quick-command-escape-help"><code>\\r</code> = 回车　<code>\\n</code> = 换行　<code>\\t</code> = Tab。命令末尾会自动回车。</p>
              <label className="field"><span>快捷键（可选）</span><select value={editor.draft.shortcut ?? ""} onChange={(event) => updateDraft({ shortcut: event.target.value || null })}>{shortcutOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="check-row quick-command-confirm"><input type="checkbox" checked={editor.draft.requiresConfirmation} onChange={(event) => updateDraft({ requiresConfirmation: event.target.checked })} />每次发送前确认</label>
              {error && <div className="form-error">{error}</div>}
            </div>
            <footer className="modal-footer quick-command-editor-footer">
              {editor.item && <button className="danger-button" onClick={removeEditorItem}><Trash2 size={15} />移除</button>}
              <span />
              <button className="secondary-button" onClick={() => setEditor(null)}>取消</button>
              <button className="primary-button" onClick={saveEditor}><Check size={15} />保存</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
