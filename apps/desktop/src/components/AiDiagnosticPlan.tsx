import { Pause, Play, SkipForward, TerminalSquare } from "lucide-react";
import type { DiagnosticPlan, DiagnosticStep } from "../ai-diagnostic";
import { contextTargetMatches, type AiContextTarget } from "../ai-context-inventory";
import { executionAiContext, executionStatus } from "../terminal-execution";
import { safeCompletionCommand } from "../terminal-completion";

export function AiDiagnosticPlanView({ plan, target, busy, onChange, onExecute, onAttachResult }: {
  plan: DiagnosticPlan;
  target: (AiContextTarget & { connected: boolean }) | null;
  busy: boolean;
  onChange: (plan: DiagnosticPlan) => void;
  onExecute: (step: DiagnosticStep) => void;
  onAttachResult: (step: DiagnosticStep) => void;
}) {
  const active = plan.steps.some((step) => step.status === "sending" || step.status === "awaiting");
  const nextId = plan.steps.find((step) => step.status === "proposed")?.id;
  const stale = !target?.connected || !contextTargetMatches(plan.target, target);
  const changeStep = (id: string, patch: Partial<DiagnosticStep>) => onChange({ ...plan, steps: plan.steps.map((step) => step.id === id ? { ...step, ...patch } : step) });
  return <section className="ai-diagnostic-plan" aria-label="分步诊断计划">
    <header><div><strong>分步诊断</strong><span>{plan.target?.host || plan.target?.name || "未绑定终端"}</span></div><button type="button" className="ai-text-button" disabled={busy} onClick={() => onChange({ ...plan, stopped: !plan.stopped })}>{plan.stopped ? <Play size={12} /> : <Pause size={12} />}{plan.stopped ? "继续审阅" : "暂停后续步骤"}</button></header>
    <p className="ai-note">逐步检查和编辑；每步单独确认后执行。返回退出码也需要结合实际输出判断。</p>
    {stale && <p className="ai-warning">原终端连接已变化。此计划可查看，无法在新连接执行。</p>}
    {plan.steps.map((step, index) => <article key={step.id} className={`ai-diagnostic-step ${step.status}`}>
      <div className="ai-diagnostic-step-title"><span>{index + 1}</span><strong>{step.title}</strong><small>{step.status === "proposed" ? "待审阅" : step.status === "skipped" ? "已跳过" : step.result ? executionStatus(step.result) : step.status === "sending" ? "正在确认" : "等待实际结果"}</small></div>
      <p><b>检查假设：</b>{step.hypothesis}</p>
      <textarea aria-label={`诊断步骤 ${index + 1} 命令`} rows={2} value={step.command} spellCheck={false} disabled={step.status !== "proposed" || busy} onChange={(event) => changeStep(step.id, { command: event.target.value })} />
      <p><b>观察什么：</b>{step.expected}</p>
      {step.status === "proposed" && <div className="ai-actions"><button type="button" className="secondary-button" disabled={busy || active || plan.stopped} onClick={() => changeStep(step.id, { status: "skipped" })}><SkipForward size={12} />跳过</button><button type="button" className="primary-button" disabled={busy || active || plan.stopped || stale || nextId !== step.id || !safeCompletionCommand(step.command)} onClick={() => onExecute(step)}><TerminalSquare size={12} />审阅并执行此步</button></div>}
      {step.result && <details><summary>查看本步实际结果</summary><pre>{step.result.output ?? "无法可靠识别输出范围，请在终端检查。"}{step.result.truncated ? "\n[输出已截短或部分丢失]" : ""}</pre></details>}
      {step.result && <button type="button" className="secondary-button" disabled={busy || stale || executionAiContext(step.result) === null} onClick={() => onAttachResult(step)}>附加结果，更新诊断</button>}
    </article>)}
    {plan.stopped && <p className="ai-note">后续步骤已暂停；已发送到终端的命令仍需在终端查看或中断。</p>}
  </section>;
}
