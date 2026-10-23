import { Copy } from "lucide-react";
import { formatAiArchive, type AiConversationArchive } from "../ai-conversation";
import { writeClipboardText } from "../clipboard";

export function AiConversationArchives({ archives, onError }: {
  archives: readonly AiConversationArchive[];
  onError: (message: string) => void;
}) {
  if (!archives.length) return null;
  return <details className="ai-archives">
    <summary>旧对话 · {archives.length}</summary>
    <p className="ai-note">仅本次运行保留最近 3 份，只读查看或复制。旧对话不会附加到新请求。</p>
    {archives.map((archive) => <details key={archive.id} className="ai-archive">
      <summary>{new Date(archive.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {archive.reason === "service-change" ? "服务更新前" : "上一次对话"} · {archive.turns.length} 轮</summary>
      <pre>{formatAiArchive(archive)}</pre>
      <button type="button" className="secondary-button" onClick={() => {
        void writeClipboardText(formatAiArchive(archive)).catch(() => onError("复制旧对话失败，请选择文本复制。"));
      }}><Copy size={13} />复制旧对话</button>
    </details>)}
  </details>;
}
