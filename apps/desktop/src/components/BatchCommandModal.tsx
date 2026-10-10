import { useEffect, useMemo, useState } from "react";
import { Check, ClipboardCopy, Command, Play, Square, X } from "lucide-react";
import { containsSensitiveCommand, SENSITIVE_COMMAND_ERROR } from "../sensitive-command";
import { confirmDialog } from "./DialogHost";

export interface BatchCommandTarget {
  tabId: string;
  name: string;
  address: string;
  connected: boolean;
}

export interface BatchCommandRun {
  id: string;
  command: string;
  startedAt: number;
  results: Record<string, { status: "pending" | "sent" | "failed"; error?: string }>;
}

interface BatchCommandModalProps {
  targets: BatchCommandTarget[];
  run: BatchCommandRun | null;
  onExecute: (command: string, targetTabIds: string[]) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}

export function BatchCommandModal({ targets, run, onExecute, onClose, onToast }: BatchCommandModalProps) {
  const [command, setCommand] = useState("");
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(
    () => new Set(targets.filter((target) => target.connected).map((target) => target.tabId)),
  );

  const targetSignature = targets.map((target) => `${target.tabId}:${target.connected}`).join("|");
  useEffect(() => {
    setSelectedTabIds((current) => current.size > 0
      ? new Set(Array.from(current).filter((id) => targets.some((target) => target.tabId === id && target.connected)))
      : new Set(targets.filter((target) => target.connected).map((target) => target.tabId)));
  }, [targetSignature]);

  const selectedConnectedTargets = useMemo(
    () => targets.filter((target) => target.connected && selectedTabIds.has(target.tabId)),
    [selectedTabIds, targets],
  );
  const runResults = run
    ? targets.filter((target) => Object.prototype.hasOwnProperty.call(run.results, target.tabId)).map((target) => ({ target, result: run.results[target.tabId] }))
    : [];
  const sent = runResults.filter(({ result }) => result?.status === "sent").length;
  const failed = runResults.filter(({ result }) => result?.status === "failed").length;
  const pending = runResults.filter(({ result }) => result?.status === "pending").length;

  const toggleTarget = (target: BatchCommandTarget) => {
    if (!target.connected) return;
    setSelectedTabIds((current) => {
      const next = new Set(current);
      if (next.has(target.tabId)) next.delete(target.tabId);
      else next.add(target.tabId);
      return next;
    });
  };

  const submit = async () => {
    const text = command.trim();
    if (!text) {
      onToast("请输入要发送的命令。");
      return;
    }
    if (containsSensitiveCommand(text)) {
      onToast(SENSITIVE_COMMAND_ERROR);
      return;
    }
    if (selectedConnectedTargets.length === 0) {
      onToast("至少选择一个已连接会话。");
      return;
    }
    const names = selectedConnectedTargets.slice(0, 5).map((target) => target.name).join("、");
    const suffix = selectedConnectedTargets.length > 5 ? "…" : "";
    if (!(await confirmDialog({
      title: "批量发送命令",
      message: `将向 ${selectedConnectedTargets.length} 个会话发送命令：\n${names}${suffix}\n\n${text}`,
      confirmLabel: "发送",
    }))) return;
    onExecute(text, selectedConnectedTargets.map((target) => target.tabId));
  };

  const copySummary = async () => {
    if (!run) return;
    const lines = [
      `XSH 批量命令 · ${new Date(run.startedAt).toLocaleString()}`,
      `命令：${run.command}`,
      ...runResults.map(({ target, result }) => {
        const label = result?.status === "sent" ? "已发送" : result?.status === "failed" ? `失败：${result.error ?? "未知错误"}` : "等待发送";
        return `${target.name} (${target.address})：${label}`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      onToast("批量命令结果已复制。");
    } catch {
      onToast("复制失败，请检查系统剪贴板权限。");
    }
  };

  return (
    <div className="modal-backdrop batch-command-backdrop" onMouseDown={onClose}>
      <section className="batch-command-modal" onMouseDown={(event) => event.stopPropagation()} aria-label="批量命令">
        <header className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon"><Command size={18} /></span>
            <div><h2>批量命令</h2><p>显式选择会话；仅汇总本地投递结果，不推断远端命令是否执行成功。</p></div>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭批量命令"><X size={18} /></button>
        </header>
        <div className="batch-command-body">
          <section className="batch-command-targets" aria-label="选择会话">
            <div className="batch-command-section-heading"><span>目标会话</span><small>{selectedConnectedTargets.length} / {targets.filter((target) => target.connected).length} 已选择</small></div>
            <div className="batch-command-select-actions">
              <button type="button" className="link-button" onClick={() => setSelectedTabIds(new Set(targets.filter((target) => target.connected).map((target) => target.tabId)))}>全选已连接</button>
              <button type="button" className="link-button" onClick={() => setSelectedTabIds(new Set())}>清除</button>
            </div>
            <div className="batch-command-target-list">
              {targets.map((target) => (
                <label className={`batch-command-target ${target.connected ? "" : "offline"}`} key={target.tabId}>
                  <input type="checkbox" checked={selectedTabIds.has(target.tabId)} disabled={!target.connected} onChange={() => toggleTarget(target)} />
                  <span className={`connection-dot ${target.connected ? "connected" : "disconnected"}`} />
                  <span><strong>{target.name}</strong><small>{target.address}</small></span>
                  {!target.connected && <em>未连接</em>}
                </label>
              ))}
              {targets.length === 0 && <div className="batch-command-empty"><Square size={18} />暂无打开的会话标签</div>}
            </div>
          </section>
          <section className="batch-command-compose">
            <label className="field"><span>命令</span><textarea value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如：uname -a" rows={5} spellCheck={false} /></label>
            <button type="button" className="primary-button batch-command-send" onClick={() => void submit()} disabled={selectedConnectedTargets.length === 0}><Play size={15} />发送到 {selectedConnectedTargets.length} 个会话</button>
            <div className="batch-command-run" aria-live="polite">
              <div className="batch-command-section-heading"><span>投递结果</span>{run && <small><Check size={12} /> {sent} 已发送 · {failed} 失败 · {pending} 等待</small>}</div>
              {run ? <>
                <pre>{run.command}</pre>
                <div className="batch-command-results">
                  {runResults.map(({ target, result }) => (
                    <div className={`batch-command-result ${result?.status ?? "pending"}`} key={target.tabId}>
                      <span>{target.name}</span><small>{result?.status === "sent" ? "已发送" : result?.status === "failed" ? result.error ?? "发送失败" : "等待发送"}</small>
                    </div>
                  ))}
                </div>
                <button type="button" className="secondary-button" onClick={() => void copySummary()}><ClipboardCopy size={14} />复制结果</button>
              </> : <div className="batch-command-empty"><Command size={18} />发送后会在这里按会话显示本地投递状态。</div>}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
