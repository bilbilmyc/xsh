import { useState } from "react";
import { Folder, X } from "lucide-react";
import type { SessionGroup, SessionGroupDraft } from "../types";

interface GroupEditorModalProps {
  groups: SessionGroup[];
  mode: "create" | "rename";
  group?: SessionGroup;
  parentId?: string | null;
  onClose: () => void;
  onSubmit: (draft: SessionGroupDraft) => Promise<void>;
}

export function GroupEditorModal({
  groups,
  mode,
  group,
  parentId: initialParentId = null,
  onClose,
  onSubmit,
}: GroupEditorModalProps) {
  const [name, setName] = useState(group?.name ?? "");
  const [parentId, setParentId] = useState(group?.parentId ?? initialParentId);
  const [color, setColor] = useState(group?.color ?? "#39b8d6");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("目录名称不能为空");
      return;
    }
    if (trimmed.length > 64) {
      setError("目录名称不能超过 64 个字符");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        parentId: mode === "rename" ? group?.parentId ?? null : parentId,
        name: trimmed,
        color: color || null,
        sortOrder: group?.sortOrder ?? 0,
      });
    } catch (caught) {
      setError(String(caught));
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="group-editor-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Folder size={18} /></span>
            <div>
              <h2>{mode === "create" ? "新建会话目录" : "重命名目录"}</h2>
              <p>{mode === "create" ? "用目录整理不同环境、项目或团队的 SSH 会话。" : "目录中的会话和子目录会保留。"}</p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="group-editor-body">
          <label className="field">
            <span>目录名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="例如：生产环境" />
          </label>
          {mode === "create" && (
            <label className="field">
              <span>上级目录</span>
              <select value={parentId ?? ""} onChange={(event) => setParentId(event.target.value || null)}>
                <option value="">根目录</option>
                {groups.map((candidate) => <option key={candidate.id} value={candidate.id}>{groupPath(candidate, groups)}</option>)}
              </select>
            </label>
          )}
          <div className="field">
            <span>目录颜色</span>
            <div className="color-picker-row">
              {GROUP_COLORS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className={`color-swatch ${color === candidate ? "selected" : ""}`}
                  style={{ backgroundColor: candidate }}
                  onClick={() => setColor(candidate)}
                  aria-label={`选择颜色 ${candidate}`}
                />
              ))}
              <button type="button" className="color-clear" onClick={() => setColor("")}>无颜色</button>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary-button" onClick={() => void submit()} disabled={saving}>{saving ? "保存中…" : "保存目录"}</button>
        </footer>
      </section>
    </div>
  );
}

const GROUP_COLORS = ["#39b8d6", "#58a6ff", "#56d364", "#e3b341", "#ff8a65", "#bc8cff"];

function groupPath(group: SessionGroup, groups: SessionGroup[]): string {
  const parent = group.parentId ? groups.find((candidate) => candidate.id === group.parentId) : undefined;
  return parent ? `${groupPath(parent, groups)} / ${group.name}` : group.name;
}
