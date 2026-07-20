import { useEffect, useRef } from "react";

const CONTEXT_MENU_WIDTH = 208;
const CONTEXT_MENU_ITEM_HEIGHT = 36;

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

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - CONTEXT_MENU_WIDTH - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - items.length * CONTEXT_MENU_ITEM_HEIGHT - 16)),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`context-menu-item ${item.danger ? "danger" : ""} ${item.separatorBefore ? "separator" : ""}`}
          onClick={() => {
            onClose();
            item.onClick();
          }}
          role="menuitem"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
