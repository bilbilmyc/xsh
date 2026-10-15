import { useEffect, useRef, useState } from "react";
import { aiApi, type AiSettings } from "../ai-api";
import { AI_SETTINGS_CHANGED_EVENT } from "../ai-ui";

interface AiSettingsFormProps {
  settings: AiSettings;
  onSaved: (settings: AiSettings) => void;
  onCancel: () => void;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

export function AiSettingsForm({ settings, onSaved, onCancel, disabled = false, onDirtyChange }: AiSettingsFormProps) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const dirty = enabled !== settings.enabled || baseUrl !== settings.baseUrl || model !== settings.model || apiKey.length > 0 || clearApiKey;

  useEffect(() => { onDirtyChangeRef.current?.(dirty); }, [dirty]);

  const save = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await aiApi.saveSettings({ enabled, baseUrl, model, apiKey: apiKey || null, clearApiKey });
      setEnabled(saved.enabled);
      setBaseUrl(saved.baseUrl);
      setModel(saved.model);
      setApiKey("");
      setClearApiKey(false);
      onDirtyChangeRef.current?.(false);
      onSaved(saved);
      window.dispatchEvent(new CustomEvent(AI_SETTINGS_CHANGED_EVENT));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ai-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || disabled}>
      <h3>AI 服务设置</h3>
      <p className="ai-note">支持 OpenAI 兼容的 Chat Completions 文本协议。保存设置不会发送网络请求。</p>
      <label className="ai-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />启用 AI 助手</label>
      <label htmlFor="ai-base-url">Base URL</label>
      <input id="ai-base-url" type="url" autoComplete="off" spellCheck={false} placeholder="https://服务地址/v1" value={baseUrl} disabled={busy} onChange={(event) => setBaseUrl(event.target.value)} />
      <p className="ai-note">请求地址会追加 /chat/completions。本机服务支持 http://localhost:端口/v1，远程服务使用 HTTPS。</p>
      <label htmlFor="ai-model">模型名称</label>
      <input id="ai-model" autoComplete="off" spellCheck={false} placeholder="填写服务提供的模型名称" value={model} disabled={busy} onChange={(event) => setModel(event.target.value)} />
      <label htmlFor="ai-api-key">API Key <span className="ai-note">{settings.hasApiKey ? "已加密保存" : "可选，本机服务可留空"}</span></label>
      <input id="ai-api-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} disabled={busy || clearApiKey} placeholder={settings.hasApiKey ? "留空保留现有密钥" : "输入后保存在本机加密凭据库"} onChange={(event) => setApiKey(event.target.value)} />
      {settings.hasApiKey && <label className="ai-check"><input type="checkbox" checked={clearApiKey} disabled={busy} onChange={(event) => { setClearApiKey(event.target.checked); setApiKey(""); }} />保存时清除现有 API Key</label>}
      <p className="ai-note">每次发送前可检查脱敏后的内容；不会自动上传终端历史。不要在地址中填写密钥。</p>
      {error && <p className="ai-error" role="alert">{error}</p>}
      <div className="ai-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => { onDirtyChangeRef.current?.(false); onCancel(); }}>撤销未保存修改</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "保存中…" : "保存 AI 设置"}</button></div>
      </fieldset>
    </form>
  );
}
