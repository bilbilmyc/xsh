import { useId, useRef, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import type { SavedSession } from "../types";
import { parseQuickConnectAddress, type QuickConnectAddress } from "../quick-connect";

interface QuickConnectProps {
  sessions: SavedSession[];
  onOpen: (session: SavedSession) => void;
  onCreate: (address: QuickConnectAddress) => void;
}

export function QuickConnect({ sessions, onOpen, onCreate }: QuickConnectProps) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const query = value.trim().toLowerCase();
  const matches = query ? sessions.filter((session) => `${session.name} ${session.host} ${session.username}`.toLowerCase().includes(query))
    .sort((first, second) => Number(second.name.toLowerCase() === query || second.host.toLowerCase() === query)
      - Number(first.name.toLowerCase() === query || first.host.toLowerCase() === query)).slice(0, 6) : [];
  const open = focused && Boolean(query);
  const finish = () => { setValue(""); setFocused(false); setError(null); inputRef.current?.blur(); };
  const connectSaved = (session: SavedSession) => { finish(); onOpen(session); };
  const create = () => {
    try { const address = parseQuickConnectAddress(value); finish(); onCreate(address); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "地址格式不正确。"); }
  };
  const submit = () => { const session = matches[selected]; if (session) connectSaved(session); else create(); };

  return (
    <div className={`toolbar-address quick-connect ${open ? "open" : ""}`}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); finish(); } }}>
      <Search size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        role="combobox"
        aria-label="快速连接"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${selected}` : undefined}
        placeholder="快速连接 · user@host:22"
        value={value}
        spellCheck={false}
        onChange={(event) => { setValue(event.target.value); setSelected(0); setError(null); }}
        onFocus={() => setFocused(true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); submit(); }
          else if (event.key === "ArrowDown") { event.preventDefault(); setSelected((current) => Math.min(matches.length, current + 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((current) => Math.max(0, current - 1)); }
          else if (event.key === "Escape") { event.preventDefault(); finish(); }
        }}
      />
      <button type="button" className="quick-connect-submit" aria-label="连接或配置新主机" disabled={!query} onClick={submit}><ArrowRight size={14} /></button>
      {open && (
        <div className="toolbar-address-suggestions" id={listId} role="listbox" aria-label="快速连接匹配结果">
          <div className="quick-connect-hint">已保存会话直接连接 · 新主机先配置登录方式</div>
          {matches.map((session, index) => (
            <button type="button" role="option" tabIndex={-1} id={`${listId}-${index}`} aria-selected={index === selected} key={session.id}
              className={`toolbar-address-suggestion ${index === selected ? "selected" : ""}`}
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => connectSaved(session)}>
              <span className="toolbar-address-name">{session.name}</span>
              <span className="toolbar-address-host">{session.kind === "remoteDesktop" ? "远程桌面" : "SSH"} · {session.host}:{session.port}</span>
            </button>
          ))}
          <button type="button" role="option" tabIndex={-1} id={`${listId}-${matches.length}`} aria-selected={selected === matches.length}
            className={`toolbar-address-suggestion quick-connect-create ${selected === matches.length ? "selected" : ""}`}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSelected(matches.length)} onClick={create}>
            <span>配置新主机</span><span className="toolbar-address-host">{value.trim()}</span>
          </button>
          {error && <div className="quick-connect-error" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
