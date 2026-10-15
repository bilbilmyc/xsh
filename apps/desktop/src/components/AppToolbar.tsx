import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import "./app-toolbar.css";

export interface ToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  tooltip?: string;
  disabled?: boolean;
  active?: boolean;
  showLabel?: boolean;
}

export interface ToolbarGroup {
  label: string;
  secondary?: boolean;
  actions: ToolbarAction[];
}

export function AppToolbar({ groups, children }: { groups: ToolbarGroup[]; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    moreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setExpanded(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setExpanded(false); triggerRef.current?.focus(); }
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => { window.removeEventListener("pointerdown", closeOutside); window.removeEventListener("keydown", closeEscape); };
  }, [expanded]);
  const extraGroups = groups.filter((group) => group.secondary);
  return (
    <div className="toolbar-bar app-toolbar" role="toolbar" aria-label="连接与终端工具">
      {groups.map((group) => (
        <div className={`app-toolbar-group ${group.secondary ? "toolbar-secondary" : ""}`} role="group" aria-label={group.label} key={group.label}>
          {group.actions.map((action) => (
            <button type="button" className={`toolbar-button ${action.showLabel ? "toolbar-labelled" : ""} ${action.active ? "active" : ""}`}
              key={action.id} onClick={action.onClick} disabled={action.disabled} aria-label={action.label}
              aria-pressed={action.active} data-tooltip={action.tooltip ?? action.label}>
              {action.icon}{action.showLabel && <span>{action.label}</span>}
            </button>
          ))}
        </div>
      ))}
      <div className="toolbar-overflow" ref={moreRef}
        onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}
        onKeyDown={(event) => {
          if (!expanded || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const entries = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
          const current = entries.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
          entries[next]?.focus();
        }}>
        <button type="button" ref={triggerRef} className="toolbar-button" aria-label="更多工具" aria-haspopup="menu" aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)} data-tooltip="更多工具"><MoreHorizontal size={17} /></button>
        {expanded && <div className="toolbar-overflow-menu" role="menu" aria-label="更多工具">
          {extraGroups.map((group) => <div key={group.label} role="group" aria-label={group.label}>
            <div className="toolbar-overflow-heading">{group.label}</div>
            {group.actions.map((action) => <button type="button" role="menuitem" key={action.id} disabled={action.disabled}
              onClick={() => { setExpanded(false); triggerRef.current?.focus(); action.onClick(); }}>
              {action.icon}<span>{action.label}</span>{action.active && <span className="toolbar-overflow-active">已开启</span>}
            </button>)}
          </div>)}
        </div>}
      </div>
      {children}
    </div>
  );
}
