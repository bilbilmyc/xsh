import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CONTEXT_MENU_GUTTER = 8;

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(CONTEXT_MENU_GUTTER, window.innerWidth - rect.width - CONTEXT_MENU_GUTTER);
    const maxTop = Math.max(CONTEXT_MENU_GUTTER, window.innerHeight - rect.height - CONTEXT_MENU_GUTTER);
    const left = Math.max(CONTEXT_MENU_GUTTER, Math.min(x, maxLeft));
    const preferredTop = y + rect.height + CONTEXT_MENU_GUTTER <= window.innerHeight
      ? y
      : y - rect.height;
    const top = Math.max(CONTEXT_MENU_GUTTER, Math.min(preferredTop, maxTop));
    setPosition({ left, top });
    menu.focus();
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const runItem = (index: number) => {
    const item = items[index];
    if (!item) return;
    onClose();
    item.onClick();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(items.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      runItem(activeIndex);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onMenuKeyDown}
      tabIndex={-1}
      role="menu"
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          className={`context-menu-item ${item.danger ? "danger" : ""} ${item.separatorBefore ? "separator" : ""} ${index === activeIndex ? "active" : ""}`}
          onClick={() => runItem(index)}
          onMouseEnter={() => setActiveIndex(index)}
          role="menuitem"
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
