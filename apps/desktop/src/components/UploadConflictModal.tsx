import { useEffect, useState } from "react";
import { CircleAlert, X } from "lucide-react";

export type UploadConflictChoice =
  | { type: "overwrite" }
  | { type: "overwrite-all" }
  | { type: "skip" }
  | { type: "skip-all" }
  | { type: "rename"; name: string };

type UploadConflictStrategy = UploadConflictChoice["type"];

interface UploadConflictModalProps {
  fileName: string;
  remainingConflicts: number;
  existingNames: ReadonlySet<string>;
  onConfirm: (choice: UploadConflictChoice) => void;
  onCancel: () => void;
}

const STRATEGY_LABELS: Record<UploadConflictStrategy, string> = {
  overwrite: "覆盖该文件",
  "overwrite-all": "覆盖该文件，并覆盖后续所有冲突文件",
  skip: "跳过该文件",
  "skip-all": "跳过该文件，并跳过后续所有冲突文件",
  rename: "重命名为其他名称上传",
};

function isInvalidRemoteName(value: string) {
  return !value || value === "." || value === ".." || /[\\/]/.test(value);
}

export function UploadConflictModal({
  fileName,
  remainingConflicts,
  existingNames,
  onConfirm,
  onCancel,
}: UploadConflictModalProps) {
  const [strategy, setStrategy] = useState<UploadConflictStrategy>("overwrite");
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const renameTarget = renameValue.trim();
  const renameCollides = strategy === "rename"
    && !isInvalidRemoteName(renameTarget)
    && existingNames.has(renameTarget);

  const confirm = () => {
    if (strategy === "rename") {
      if (isInvalidRemoteName(renameTarget)) {
        setError("名称不能为空，不能包含路径分隔符，也不能是 . 或 ..");
        return;
      }
      onConfirm({ type: "rename", name: renameTarget });
      return;
    }
    onConfirm({ type: strategy });
  };

  return (
    <div className="modal-backdrop upload-conflict-backdrop" onMouseDown={onCancel}>
      <section
        className="upload-conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-label="上传文件冲突"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon conflict"><CircleAlert size={18} /></span>
            <div><h2>远程文件已存在</h2><p>选择本次上传的处理方式</p></div>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="取消上传"><X size={18} /></button>
        </header>
        <div className="upload-conflict-body">
          <div className="upload-conflict-file" title={fileName}>
            <span className="upload-conflict-file-name">{fileName}</span>
            <span className="upload-conflict-file-note">目标目录中已有同名文件</span>
          </div>
          <label className="field">
            <span>处理方式</span>
            <select
              autoFocus
              value={strategy}
              onChange={(event) => {
                setStrategy(event.target.value as UploadConflictStrategy);
                setError(null);
              }}
            >
              <option value="overwrite">{STRATEGY_LABELS.overwrite}</option>
              {remainingConflicts > 0 && <option value="overwrite-all">{STRATEGY_LABELS["overwrite-all"]}</option>}
              <option value="skip">{STRATEGY_LABELS.skip}</option>
              {remainingConflicts > 0 && <option value="skip-all">{STRATEGY_LABELS["skip-all"]}</option>}
              <option value="rename">{STRATEGY_LABELS.rename}</option>
            </select>
          </label>
          {strategy === "rename" && (
            <label className="field">
              <span>新的远程文件名</span>
              <input
                value={renameValue}
                onChange={(event) => { setRenameValue(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") confirm(); }}
                placeholder={`${fileName}.new`}
                spellCheck={false}
              />
            </label>
          )}
          {strategy === "rename" && renameCollides && (
            <small className="upload-conflict-warning">该名称在远程目录中同样存在，确认后将覆盖同名文件。</small>
          )}
          {remainingConflicts > 0 && strategy !== "overwrite-all" && strategy !== "skip-all" && (
            <small className="field-help">后续还有 {remainingConflicts} 个冲突文件，会逐个询问。</small>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" onClick={onCancel}>取消上传</button>
          <button className="primary-button" onClick={confirm} disabled={strategy === "rename" && isInvalidRemoteName(renameTarget)}>
            确定
          </button>
        </footer>
      </section>
    </div>
  );
}
