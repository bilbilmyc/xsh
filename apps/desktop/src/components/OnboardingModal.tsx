import { FileKey, Files, Plus, ShieldCheck, X } from "lucide-react";

interface OnboardingModalProps {
  onCreateSession: () => void;
  onOpenSshConfig: () => void;
  onDismiss: () => void;
}

export function OnboardingModal({ onCreateSession, onOpenSshConfig, onDismiss }: OnboardingModalProps) {
  return (
    <div className="modal-backdrop onboarding-backdrop" onMouseDown={onDismiss}>
      <section className="onboarding-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header className="modal-header onboarding-header">
          <div className="modal-title-wrap">
            <span className="modal-icon onboarding-icon"><ShieldCheck size={19} /></span>
            <div>
              <h2 id="onboarding-title">欢迎使用 XSH</h2>
              <p>一个本地优先的 SSH 工作台，把会话、终端和 SFTP 放在同一个工作区。</p>
            </div>
          </div>
          <button className="icon-button" onClick={onDismiss} aria-label="稍后设置"><X size={18} /></button>
        </header>

        <div className="onboarding-body">
          <div className="onboarding-steps">
            <div className="onboarding-step"><span className="onboarding-step-icon"><Plus size={16} /></span><div><strong>创建第一个会话</strong><span>填写主机、用户名和认证方式，保存后立即连接。</span></div></div>
            <div className="onboarding-step"><span className="onboarding-step-icon"><FileKey size={16} /></span><div><strong>导入现有 SSH 配置</strong><span>读取本机 <code>~/.ssh/config</code>，批量建立会话目录。</span></div></div>
            <div className="onboarding-step"><span className="onboarding-step-icon"><Files size={16} /></span><div><strong>用工作区组织日常工作</strong><span>多标签、分屏、命令中心和 SFTP 都可以随时使用。</span></div></div>
          </div>

          <div className="onboarding-safety"><ShieldCheck size={15} /><span>密码和私钥 Passphrase 只保存在 XSH 本地加密数据库；普通会话导出不会包含凭据。</span></div>
        </div>

        <footer className="modal-footer onboarding-footer">
          <button className="link-button onboarding-later" onClick={onDismiss}>以后再说</button>
          <div className="onboarding-actions">
            <button className="secondary-button" onClick={onOpenSshConfig}><FileKey size={14} />导入 SSH 配置</button>
            <button className="primary-button" onClick={onCreateSession}><Plus size={15} />新建第一个会话</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
