import { useMemo, useState } from "react";
import { FileKey, RefreshCw, Server, X } from "lucide-react";
import type { SshConfigEntry } from "../types";

interface SshConfigModalProps {
  entries: SshConfigEntry[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onImport: (entries: SshConfigEntry[]) => Promise<void>;
}

export function SshConfigModal({ entries, loading, onClose, onRefresh, onImport }: SshConfigModalProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(entries.map((entry) => entry.alias)));
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedEntries = useMemo(() => entries.filter((entry) => selected.has(entry.alias)), [entries, selected]);
  const allSelected = entries.length > 0 && selectedEntries.length === entries.length;

  const toggle = (alias: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(alias)) next.delete(alias); else next.add(alias);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(entries.map((entry) => entry.alias)));
  };

  const clearSelection = () => {
    setSelected(new Set());
  };

  const importSelected = async () => {
    if (selectedEntries.length === 0) {
      setError("请至少选择一个 SSH 主机配置。");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      await onImport(selectedEntries);
      onClose();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="ssh-config-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><FileKey size={18} /></span>
            <div><h2>导入 SSH 配置</h2><p>读取 {entries[0]?.sourcePath ?? "~/.ssh/config"}，不会读取或保存密码。</p></div>
          </div>
          <div className="modal-header-actions">
            <button className="icon-button" onClick={onRefresh} disabled={loading} title="重新读取"><RefreshCw size={15} /></button>
            <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
          </div>
        </header>

        <div className="ssh-config-body">
          {loading ? <div className="panel-message">正在读取 ~/.ssh/config…</div> : entries.length === 0 ? (
            <div className="panel-message">没有找到可导入的 Host 配置。</div>
          ) : (
            <div className="ssh-config-list">
              {entries.map((entry) => (
                <label className="ssh-config-row" key={entry.alias}>
                  <input type="checkbox" checked={selected.has(entry.alias)} onChange={() => toggle(entry.alias)} />
                  <span className="ssh-config-row-icon"><Server size={14} /></span>
                  <span className="ssh-config-row-main">
                    <strong>{entry.alias}</strong>
                    <small>{entry.username || "未设置用户"}@{entry.hostname}:{entry.port}</small>
                  </span>
                  <span className="ssh-config-row-meta">
                    {entry.identityFile ? <><FileKey size={12} /> Key</> : "需要密码"}
                    {entry.proxyJump && <em>ProxyJump {entry.proxyJump}</em>}
                  </span>
                </label>
              ))}
            </div>
          )}
          <p className="ssh-config-note">导入后会创建本地会话。没有 IdentityFile 的配置会以密码认证导入，需要在会话编辑中填写密码；密码不会来自 ~/.ssh/config。</p>
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <span className="ssh-config-selection">已选择 {selectedEntries.length} 个</span>
          <button className="secondary-button ssh-config-select-button" onClick={selectAll} disabled={loading || importing || allSelected}>全选</button>
          <button className="secondary-button ssh-config-select-button" onClick={clearSelection} disabled={loading || importing || selectedEntries.length === 0}>取消全选</button>
          <button className="secondary-button" onClick={onClose} disabled={importing}>取消</button>
          <button className="primary-button" onClick={() => void importSelected()} disabled={loading || importing || selectedEntries.length === 0}>{importing ? "导入中…" : "导入选中配置"}</button>
        </footer>
      </section>
    </div>
  );
}
