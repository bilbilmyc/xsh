import { useEffect, useState } from "react";
import { Lock, X } from "lucide-react";

interface PasswordPromptModalProps {
  mode: "export" | "import";
  title: string;
  description: string;
  busy?: boolean;
  onSubmit: (password: string) => void;
  onClose: () => void;
}

export function PasswordPromptModal({ mode, title, description, busy = false, onSubmit, onClose }: PasswordPromptModalProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    setError(null);
  }, [busy]);

  const submit = () => {
    if (!password) {
      setError("请输入文件密码。");
      return;
    }
    if (mode === "export" && password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    onSubmit(password);
  };

  return (
    <div className="modal-backdrop backup-dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <section className="backup-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Lock size={18} /></span>
            <div><h2>{title}</h2><p>{description}</p></div>
          </div>
          <button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="backup-dialog-body">
          <label className="field">
            <span>{mode === "export" ? "设置文件密码" : "输入文件密码"}</span>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              autoComplete={mode === "export" ? "new-password" : "current-password"}
              placeholder="请输入密码"
            />
          </label>
          {mode === "export" && <label className="field">
            <span>再次输入文件密码</span>
            <input
              type="password"
              value={confirmation}
              onChange={(event) => { setConfirmation(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              autoComplete="new-password"
            />
          </label>}
          <small className="field-help">密码不会保存。导入文件在解密和校验成功前不会写入数据。</small>
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy} onClick={submit}>{busy ? "处理中…" : mode === "export" ? "加密导出" : "解密导入"}</button>
        </footer>
      </section>
    </div>
  );
}
