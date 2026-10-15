import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, PlugZap, RefreshCw } from "lucide-react";
import { aiApi, type AiSettings } from "../ai-api";
import { AI_SERVICE_TEST_PROMPT, aiServiceHost } from "../ai-ui";
import { AiSettingsForm } from "./AiSettingsForm";
import "./AiAssistantPanel.css";

interface AiServiceSettingsProps {
  onToast?: (message: string) => void;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function AiServiceSettings({ onToast, onSaved, onDirtyChange }: AiServiceSettingsProps) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [testing, setTesting] = useState(false);
  const [testReply, setTestReply] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void aiApi.getSettings().then((saved) => { if (mounted) setSettings(saved); })
      .catch((caught) => { if (mounted) setError(String(caught)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [revision]);

  const handleSaved = (saved: AiSettings) => {
    setSettings(saved);
    setNotice("AI 服务设置已保存，终端中的 AI 助手会同步更新。");
    setTestReply(null);
    setTestError(null);
    onToast?.("AI 服务设置已保存");
    onSaved?.();
  };

  const testSavedService = async () => {
    if (!settings?.enabled || testing) return;
    setTesting(true);
    setTestReply(null);
    setTestError(null);
    try {
      setTestReply(await aiApi.complete({ mode: "explain", prompt: AI_SERVICE_TEST_PROMPT, context: "" }));
    } catch (caught) {
      setTestError(String(caught));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="ai-service-settings" aria-label="AI 服务设置" aria-busy={loading}>
      {loading && <p className="ai-settings-status" role="status"><LoaderCircle size={15} className="ai-spin" />正在读取本机已保存的 AI 设置…</p>}
      {error && <div className="ai-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setRevision((current) => current + 1)}><RefreshCw size={14} />重新读取</button></div>}
      {settings && !loading && !error && <>
        <AiSettingsForm key={revision} settings={settings} disabled={testing} onDirtyChange={onDirtyChange} onSaved={handleSaved} onCancel={() => { setNotice("已恢复为本机保存的设置。"); setRevision((current) => current + 1); }} />
        {notice && <p className="ai-settings-status" role="status"><CheckCircle2 size={15} />{notice}</p>}
        <section className="ai-service-test" aria-label="测试已保存的 AI 服务">
          <h3><PlugZap size={16} />测试已保存的服务</h3>
          <p className="ai-note">使用已保存的地址和模型。修改表单后，请先保存再测试。</p>
          <dl className="ai-test-summary"><div><dt>服务</dt><dd>{aiServiceHost(settings.baseUrl)}</dd></div><div><dt>模型</dt><dd>{settings.model || "未设置"}</dd></div></dl>
          <p className="ai-note">点击测试会联网调用你的 AI 服务，可能消耗少量 Token。只发送下面这段固定文字，不包含终端输出或会话信息。</p>
          <pre className="ai-test-prompt">{AI_SERVICE_TEST_PROMPT}</pre>
          <button type="button" className="secondary-button" disabled={!settings.enabled || !settings.baseUrl || !settings.model || testing} onClick={() => void testSavedService()}>{testing ? <LoaderCircle size={14} className="ai-spin" /> : <PlugZap size={14} />}{testing ? "正在测试…" : "确认联网测试"}</button>
          {!settings.enabled && <p className="ai-note">启用并保存 AI 助手后可测试服务。</p>}
          {testReply && <div className="ai-test-result" role="status"><h4><CheckCircle2 size={15} />已收到服务回复</h4><pre>{testReply}</pre></div>}
          {testError && <p className="ai-error" role="alert">{testError}</p>}
        </section>
      </>}
    </section>
  );
}
