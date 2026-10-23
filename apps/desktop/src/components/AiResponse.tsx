import { Children, isValidElement, memo, useState, type ReactNode } from "react";
import { Check, Copy, TerminalSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { commandDraftFromCode } from "../ai-context";
import { writeClipboardText } from "../clipboard";

interface AiResponseProps {
  text: string;
  complete: boolean;
  onUseCommand: (command: string) => void;
  onError: (message: string) => void;
}

function AiCodeBlock({ code, language, complete, closed, onUseCommand, onError }: Omit<AiResponseProps, "text"> & { code: string; language: string; closed: boolean }) {
  const [copied, setCopied] = useState(false);
  const command = commandDraftFromCode(code, language);
  return (
    <div className="ai-code-block">
      <div className="ai-code-toolbar">
        <span><TerminalSquare size={13} />{language || "文本"}</span>
        <button type="button" onClick={() => {
          void writeClipboardText(code).then(() => setCopied(true)).catch(() => onError("复制失败，请选择代码手动复制。"));
        }} aria-label="复制代码">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : "复制"}</button>
      </div>
      <pre><code>{code}</code></pre>
      {command && <button type="button" className="ai-code-use" disabled={!complete || !closed} onClick={() => onUseCommand(command)}>
        <TerminalSquare size={13} />{!closed ? "代码块尚未完整" : complete ? "放入命令草稿" : "回复完成后可使用此命令"}
      </button>}
    </div>
  );
}

export const AiResponse = memo(function AiResponse({ text, complete, onUseCommand, onError }: AiResponseProps) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
        pre: ({ node, children }) => {
          const child = Children.toArray(children)[0];
          if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre>{children}</pre>;
          const language = /language-([^\s]+)/.exec(child.props.className ?? "")?.[1] ?? "";
          const code = String(child.props.children ?? "").replace(/\n$/, "");
          const source = text.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset ?? 0);
          const lines = source.trimEnd().split(/\r?\n/);
          const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1];
          const closed = !!fence && lines.length > 1 && new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[lines.length - 1]);
          return <AiCodeBlock code={code} language={language} complete={complete} closed={closed} onUseCommand={onUseCommand} onError={onError} />;
        },
        table: ({ children }) => <div className="ai-table-scroll"><table>{children}</table></div>,
        img: ({ alt }) => <span className="ai-note">{alt ? `[图片：${alt}]` : "[图片]"}</span>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
      }}>{text}</ReactMarkdown>
    </div>
  );
});
