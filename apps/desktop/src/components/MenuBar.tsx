import { useEffect, useRef, useState } from "react";

export interface MenuBarEntry {
  label: string;
  onClick?: () => void;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
}
export interface MenuBarMenu {
  id: string;
  label: string;
  items: MenuBarEntry[];
}

interface MenuBarProps {
  menus: MenuBarMenu[];
}

/** Classic Windows-style menu bar: click a title to open, hover across titles
 * to switch once a menu is open, Escape or an outside click closes. */
export function MenuBar({ menus }: MenuBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openId]);

  const closeAndRun = (entry: MenuBarEntry) => {
    setOpenId(null);
    entry.onClick?.();
  };

  return (
    <div ref={rootRef} className="menu-bar" role="menubar">
      {menus.map((menu) => (
        <div key={menu.id} className={`menu-bar-title ${openId === menu.id ? "open" : ""}`}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={openId === menu.id}
            onClick={() => setOpenId((current) => (current === menu.id ? null : menu.id))}
            onMouseEnter={() => {
              if (openId && openId !== menu.id) setOpenId(menu.id);
            }}
          >
            {menu.label}
          </button>
          {openId === menu.id && (
            <div className="menu-bar-dropdown" role="menu">
              {menu.items.map((entry, index) => (
                <div key={`${entry.label}-${index}`} className="menu-bar-entry">
                  {entry.separatorBefore && <div className="menu-bar-separator" />}
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled={entry.disabled || undefined}
                    className={`menu-bar-item ${entry.disabled ? "disabled" : ""}`}
                    onClick={() => {
                      if (entry.disabled) return;
                      closeAndRun(entry);
                    }}
                  >
                    <span className="menu-bar-check">{entry.checked ? "✓" : ""}</span>
                    <span className="menu-bar-label">{entry.label}</span>
                    {entry.shortcut && <span className="menu-bar-shortcut">{entry.shortcut}</span>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
