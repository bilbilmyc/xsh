import { useState } from "react";
import { Tags, X } from "lucide-react";
import type { SavedSession } from "../types";

export interface SessionBatchUpdates {
  environment?: string | null;
  autoReconnect?: boolean;
  addTags: string[];
  removeTags: string[];
}

interface SessionBatchEditorModalProps {
  sessions: SavedSession[];
  onApply: (updates: SessionBatchUpdates) => void | Promise<void>;
  onClose: () => void;
}

export function SessionBatchEditorModal({ sessions, onApply, onClose }: SessionBatchEditorModalProps) {
  const [environment, setEnvironment] = useState("__keep__");
  const [autoReconnect, setAutoReconnect] = useState("keep");
  const [addTags, setAddTags] = useState("");
  const [removeTags, setRemoveTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    const additions = parseTags(addTags);
    const removals = parseTags(removeTags);
    const hasEnvironmentChange = environment !== "__keep__";
    const hasReconnectChange = autoReconnect !== "keep";
    if (!hasEnvironmentChange && !hasReconnectChange && additions.length === 0 && removals.length === 0) {
      setError("请至少选择一项需要修改的字段。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onApply({
        environment: hasEnvironmentChange ? environment || null : undefined,
        autoReconnect: hasReconnectChange ? autoReconnect === "enabled" : undefined,
        addTags: additions,
        removeTags: removals,
      });
      onClose();
    } catch (caught) {
      setError(String(caught));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal session-batch-editor" role="dialog" aria-modal="true" aria-label="批量编辑会话">
        <header className="modal-header">
          <div><strong>批量编辑会话</strong><span>将非敏感设置应用到选中的 {sessions.length} 个会话</span></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="session-batch-editor-body">
          <div className="session-batch-preview">
            {sessions.slice(0, 8).map((session) => <span key={session.id}>{session.name}</span>)}
            {sessions.length > 8 && <span>另有 {sessions.length - 8} 个</span>}
          </div>
          <div className="form-grid">
            <label className="field">
              <span>环境</span>
              <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
                <option value="__keep__">保持各会话原值</option>
                <option value="production">生产</option>
                <option value="staging">预发布</option>
                <option value="testing">测试</option>
                <option value="development">开发</option>
                <option value="">未设置</option>
              </select>
            </label>
            <label className="field">
              <span>断线自动重连</span>
              <select value={autoReconnect} onChange={(event) => setAutoReconnect(event.target.value)}>
                <option value="keep">保持各会话原值</option>
                <option value="enabled">开启</option>
                <option value="disabled">关闭</option>
              </select>
            </label>
            <label className="field field-span-2">
              <span>追加标签（逗号分隔）</span>
              <input value={addTags} onChange={(event) => setAddTags(event.target.value)} placeholder="例如：linux, production" />
            </label>
            <label className="field field-span-2">
              <span>移除标签（逗号分隔）</span>
              <input value={removeTags} onChange={(event) => setRemoveTags(event.target.value)} placeholder="例如：legacy, temporary" />
            </label>
          </div>
          <p className="workspace-security-note"><Tags size={13} />批量编辑不会读取、替换或导出密码、Key Passphrase 与私钥。</p>
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary-button" onClick={() => void apply()} disabled={saving}>{saving ? "应用中…" : `应用到 ${sessions.length} 个会话`}</button>
        </footer>
      </section>
    </div>
  );
}

function parseTags(value: string): string[] {
  return [...new Set(value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean))];
}
