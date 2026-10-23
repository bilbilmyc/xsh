import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, Files, Settings2, X } from "lucide-react";
import "./right-tool-panel.css";

const STORAGE_KEY = "xsh.right-tool-width.v1";

function loadWidth() {
  try { const width = Number(localStorage.getItem(STORAGE_KEY)); return width >= 280 && width <= 560 ? width : 360; }
  catch { return 360; }
}

export function RightToolPanel({ tool, visible, canShowFiles, onSelect, onClose, onOpenAiSettings, children, expanded = false, onCollapseFiles }: {
  tool: "files" | "ai";
  visible: boolean;
  canShowFiles: boolean;
  onSelect: (tool: "files" | "ai") => void;
  onClose: () => void;
  onOpenAiSettings: () => void;
  children: ReactNode;
  expanded?: boolean;
  onCollapseFiles?: () => void;
}) {
  const [width, setWidth] = useState(loadWidth);
  const panelId = useId();
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ start: number; width: number } | null>(null);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(width)); } catch {}
  }, [width]);
  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) setWidth(Math.max(280, Math.min(560, drag.width + drag.start - event.clientX)));
    };
    const finish = () => { dragRef.current = null; setResizing(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); };
  }, [resizing]);
  return (
    <aside className={`right-tool-panel ${resizing ? "resizing" : ""} ${expanded ? "expanded" : ""}`} hidden={!visible} style={expanded ? undefined : { width }} aria-label="会话工具面板">
      {!expanded && <div className="right-tool-resize" role="separator" aria-label="调整工具面板宽度" aria-orientation="vertical" tabIndex={0}
        aria-valuemin={280} aria-valuemax={560} aria-valuenow={width}
        onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); dragRef.current = { start: event.clientX, width }; setResizing(true); }}
        onDoubleClick={() => setWidth(360)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth((current) => Math.max(280, Math.min(560, current + (event.key === "ArrowLeft" ? 16 : -16)))); }
        }} />}
      <header className="right-tool-header">
        <div role="tablist" aria-label="会话工具" onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? (canShowFiles ? "files" : "ai") : event.key === "End" ? "ai" : (tool === "files" || !canShowFiles ? "ai" : "files");
          onSelect(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tool="${next}"]`)?.focus();
        }}>
          <button type="button" id={`${panelId}-files`} role="tab" data-tool="files" aria-controls={`${panelId}-content`} tabIndex={tool === "files" ? 0 : -1} aria-selected={tool === "files"} disabled={!canShowFiles} onClick={() => onSelect("files")}><Files size={14} />文件</button>
          <button type="button" id={`${panelId}-ai`} role="tab" data-tool="ai" aria-controls={`${panelId}-content`} tabIndex={tool === "ai" ? 0 : -1} aria-selected={tool === "ai"} onClick={() => onSelect("ai")}><Bot size={14} />AI 助手</button>
        </div>
        <div className="right-tool-header-actions">
          {expanded && <button type="button" className="right-tool-return" onClick={onCollapseFiles}><ArrowLeft size={14} />返回终端</button>}
          {tool === "ai" && <button type="button" className="icon-button" aria-label="AI 服务设置" data-tooltip="AI 服务设置" onClick={onOpenAiSettings}><Settings2 size={15} /></button>}
          <button type="button" className="icon-button" aria-label="关闭工具面板" onClick={onClose}><X size={15} /></button>
        </div>
      </header>
      <div className="right-tool-content" id={`${panelId}-content`} role="tabpanel" aria-labelledby={`${panelId}-${tool}`}>{children}</div>
    </aside>
  );
}
