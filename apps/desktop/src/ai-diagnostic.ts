import { byteLength, prepareAiText } from "./ai-context.ts";
import type { AiContextTarget } from "./ai-context-inventory.ts";
import { safeCompletionCommand } from "./terminal-completion.ts";
import type { TerminalExecution } from "./terminal-execution.ts";

export interface DiagnosticProposal {
  title: string;
  hypothesis: string;
  command: string;
  expected: string;
}
export interface DiagnosticStep extends DiagnosticProposal {
  id: string;
  status: "proposed" | "sending" | "awaiting" | "observed" | "skipped";
  executionId: string | null;
  result: TerminalExecution | null;
}
export interface DiagnosticPlan {
  id: string;
  turnId: string;
  target: AiContextTarget | null;
  stopped: boolean;
  steps: DiagnosticStep[];
}

/** A complete, bounded schema is required before exposing executable plan controls. */
export function parseDiagnosticPlan(text: string): DiagnosticProposal[] | null {
  const block = /(?:^|\n)```xsh-plan\s*\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (!block || byteLength(block[1]) > 24 * 1024) return null;
  try {
    const value: unknown = JSON.parse(block[1]);
    if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
    const steps: DiagnosticProposal[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (!["title", "hypothesis", "command", "expected"].every((key) => typeof record[key] === "string" && (record[key] as string).trim() && byteLength(record[key] as string) <= 2048)) return null;
      const command = record.command as string;
      if (!safeCompletionCommand(command) || prepareAiText(command).redacted) return null;
      steps.push({
        title: prepareAiText(record.title as string, 256).text,
        hypothesis: prepareAiText(record.hypothesis as string, 2048).text,
        command, expected: prepareAiText(record.expected as string, 2048).text,
      });
    }
    return steps;
  } catch { return null; }
}

export function createDiagnosticPlan(turnId: string, target: AiContextTarget | null, proposals: DiagnosticProposal[]): DiagnosticPlan {
  return { id: crypto.randomUUID(), turnId, target, stopped: false, steps: proposals.map((step) => ({ ...step, id: crypto.randomUUID(), status: "proposed", executionId: null, result: null })) };
}

export function reconcileDiagnosticPlan(plan: DiagnosticPlan, records: readonly TerminalExecution[]): DiagnosticPlan {
  let changed = false;
  const steps = plan.steps.map((step) => {
    if (!step.executionId || step.status === "skipped") return step;
    const result = records.find((record) => record.id === step.executionId && record.connectionId === plan.target?.connectionId);
    if (!result || result === step.result) return step;
    changed = true;
    return { ...step, result, status: result.status === "sent" || result.status === "running" ? "awaiting" as const : "observed" as const };
  });
  return changed ? { ...plan, steps } : plan;
}
