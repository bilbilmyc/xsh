import { useEffect, useState } from "react";
import { Check, CheckCircle2, CircleAlert, Clock3, Copy, Globe2, Loader2, Network, RefreshCw, X } from "lucide-react";
import { api } from "../api";
import type { EndpointDiagnostic, EndpointDiagnosticIssue, SavedSession, SshDiagnosticReport } from "../types";

interface DiagnosticModalProps {
  session: SavedSession;
  report: SshDiagnosticReport | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}

const issueLabels: Record<EndpointDiagnosticIssue, string> = {
  dnsResolutionFailed: "DNS 解析失败",
  dnsNoAddresses: "DNS 无可用地址",
  connectionTimedOut: "连接超时",
  connectionRefused: "目标端口拒绝连接",
  networkUnreachable: "网络不可达",
  connectionReset: "连接被中途关闭",
  tcpConnectionFailed: "TCP 连接失败",
};

export function DiagnosticModal({ session, report, loading, error, onRetry, onClose }: DiagnosticModalProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setCopyState("idle");
  }, [report]);

  const copyRedactedSummary = async () => {
    if (!report) return;
    try {
      await api.clipboardWrite(buildRedactedDiagnosticSummary(report));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="diagnostic-modal" role="dialog" aria-modal="true" aria-label="SSH 连接诊断">
        <header className="modal-header">
          <div>
            <strong>SSH 连接诊断</strong>
            <span>{session.name} · {session.username}@{session.host}:{session.port}</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        <div className="diagnostic-body">
          {loading && (
            <div className="diagnostic-loading"><Loader2 size={22} className="spin" /><span>正在检查 DNS 和 TCP 端口…</span></div>
          )}
          {error && !loading && (
            <div className="diagnostic-error"><CircleAlert size={17} /><span>{error}</span></div>
          )}
          {report && !loading && (
            <>
              <div className={`diagnostic-summary ${report.ready ? "ready" : "blocked"}`}>
                {report.ready ? <CheckCircle2 size={20} /> : <CircleAlert size={20} />}
                <div>
                  <strong>{report.ready ? "网络路径可达，可以继续尝试 SSH" : "网络路径不可达，暂时无法建立 SSH"}</strong>
                  <span>{report.usesProxyJump ? "已检测跳板机到达性；目标主机将在跳板机侧建立连接。" : "已检测目标主机的 DNS 和 SSH 端口。"}</span>
                </div>
              </div>
              <DiagnosticEndpoint label="目标主机" endpoint={report.target} checkTcp={!report.usesProxyJump} />
              {report.proxyJump && <DiagnosticEndpoint label="ProxyJump 跳板机" endpoint={report.proxyJump} checkTcp />}
              <p className="diagnostic-safe-note"><Network size={13} />诊断不会读取或发送密码、私钥和 Key Passphrase；复制摘要会隐藏主机、用户名和 IP。</p>
            </>
          )}
        </div>

        <footer className="modal-footer">
          <span className="diagnostic-duration"><Clock3 size={13} />仅检查网络层</span>
          <button className="secondary-button" onClick={() => void copyRedactedSummary()} disabled={!report || loading}>
            {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
            {copyState === "copied" ? "已复制脱敏摘要" : copyState === "failed" ? "复制失败，请重试" : "复制脱敏摘要"}
          </button>
          <button className="secondary-button" onClick={onClose}>关闭</button>
          <button className="primary-button" onClick={onRetry} disabled={loading}><RefreshCw size={14} />重新诊断</button>
        </footer>
      </section>
    </div>
  );
}

function DiagnosticEndpoint({ label, endpoint, checkTcp }: { label: string; endpoint: EndpointDiagnostic; checkTcp: boolean }) {
  const dnsOk = !endpoint.dnsError;
  const tcpOk = endpoint.tcpReachable === true;
  return (
    <div className="diagnostic-endpoint">
      <div className="diagnostic-endpoint-title"><Globe2 size={15} /><strong>{label}</strong><code>{endpoint.host}:{endpoint.port}</code><small>{endpoint.elapsedMs} ms</small></div>
      <div className="diagnostic-checks">
        <span className={dnsOk ? "ok" : "bad"}>{dnsOk ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}DNS {dnsOk ? "正常" : "失败"}</span>
        {endpoint.addresses.length > 0 && <span className="diagnostic-addresses">{endpoint.addresses.join(" · ")}</span>}
        {checkTcp && <span className={tcpOk ? "ok" : "bad"}>{tcpOk ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}TCP {tcpOk ? "可达" : "不可达"}</span>}
        {endpoint.issue && <span className="diagnostic-issue">{issueLabels[endpoint.issue]}</span>}
      </div>
      {(endpoint.dnsError || endpoint.tcpError) && <div className="diagnostic-detail">{endpoint.dnsError ?? endpoint.tcpError}</div>}
      {endpoint.suggestion && <div className="diagnostic-suggestion">建议：{endpoint.suggestion}</div>}
    </div>
  );
}

function buildRedactedDiagnosticSummary(report: SshDiagnosticReport): string {
  const lines = [
    "XSH SSH 连接诊断（脱敏）",
    `连接路径：${report.usesProxyJump ? "ProxyJump" : "直连"}`,
    `结论：${report.ready ? "网络路径可达" : "网络路径不可达"}`,
    ...redactedEndpointLines("目标主机", report.target, !report.usesProxyJump),
  ];

  if (report.proxyJump) {
    lines.push(...redactedEndpointLines("ProxyJump 跳板机", report.proxyJump, true));
  }
  lines.push("安全说明：摘要不包含主机名、用户名、IP、密码、Credential Ref、私钥路径或 Key Passphrase。");
  return lines.join("\n");
}

function redactedEndpointLines(label: string, endpoint: EndpointDiagnostic, includeTcp: boolean): string[] {
  const dnsStatus = endpoint.dnsError ? "失败" : `正常（解析到 ${endpoint.addresses.length} 个地址）`;
  const tcpStatus = endpoint.tcpReachable === true ? "可达" : endpoint.tcpReachable === false ? "不可达" : "未检查";
  const lines = [
    `${label}：<redacted>:${endpoint.port}`,
    `  DNS：${dnsStatus}`,
    `  TCP：${includeTcp ? tcpStatus : "由跳板机侧建立，未在本机检查"}`,
    `  耗时：${endpoint.elapsedMs} ms`,
  ];
  if (endpoint.issue) lines.push(`  分类：${issueLabels[endpoint.issue]}`);
  if (endpoint.suggestion) lines.push(`  建议：${endpoint.suggestion}`);
  return lines;
}
