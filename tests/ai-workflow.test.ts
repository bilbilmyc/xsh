import assert from "node:assert/strict";
import test from "node:test";
import { AI_CONTEXT_BYTES, byteLength } from "../apps/desktop/src/ai-context.ts";
import { assembleAiContext, contextTargetMatches, createContextItem } from "../apps/desktop/src/ai-context-inventory.ts";
import { createDiagnosticPlan, parseDiagnosticPlan, reconcileDiagnosticPlan } from "../apps/desktop/src/ai-diagnostic.ts";
import type { TerminalExecution } from "../apps/desktop/src/terminal-execution.ts";

const target = { tabId: "tab-1", name: "test-host", host: "qa@example.com:22", connectionId: "conn-1", connectionVersion: 1, directory: "/srv/app" };
test("context sources remain independent, frozen and explicitly removable from the request", () => {
  const selection = createContextItem("selection", "first output", target);
  const execution = createContextItem("execution", "second output", target);
  const result = assembleAiContext([selection, { ...execution, included: false }], "check the log");
  assert.match(result.text, /first output/);
  assert.match(result.text, /check the log/);
  assert.match(result.text, /qa@example\.com:22/);
  assert.match(result.text, /目录：\/srv\/app/);
  assert.match(result.text, new RegExp(selection.capturedAt));
  assert.ok(!result.text.includes("second output"));
  assert.ok(contextTargetMatches(selection.target, target));
  assert.ok(!contextTargetMatches(selection.target, { ...target, connectionId: "conn-2" }));
});
test("each source redacts before truncation and the exact request obeys the shared byte budget", () => {
  const raw = `password="${"secret".repeat(3000)}"\n${"中文".repeat(12000)}`;
  const items = Array.from({ length: 6 }, () => createContextItem("file", raw, target, "config"));
  assert.ok(items.every((item) => item.redacted && item.truncated && !item.text.includes("secret")));
  const request = assembleAiContext(items, "token=private-test-value");
  assert.ok(byteLength(request.text) <= AI_CONTEXT_BYTES);
  assert.ok(!request.text.includes("private-test-value"));
  assert.ok(request.truncated);
  assert.ok(request.omitted > 0);
  assert.ok(!request.text.includes("\ufffd"));
});
const proposal = { title: "检查磁盘", hypothesis: "空间不足可能导致写入失败", command: "df -h", expected: "检查可用空间" };
const response = (value: unknown) => `现有证据不足。\n\`\`\`xsh-plan\n${JSON.stringify(value)}\n\`\`\``;
test("diagnostic plans require a complete schema, bounded commands and no embedded credentials", () => {
  assert.deepEqual(parseDiagnosticPlan(response([proposal])), [proposal]);
  for (const invalid of [
    [], Array.from({ length: 6 }, () => proposal),
    [{ ...proposal, expected: "" }],
    [{ ...proposal, command: "df -h\nrm something" }],
    [{ ...proposal, command: "curl --token example-secret" }],
    [{ ...proposal, command: "echo \x1b[31m" }],
  ]) assert.equal(parseDiagnosticPlan(response(invalid)), null);
  assert.equal(parseDiagnosticPlan("```xsh-plan\n["), null);
});
test("diagnostic evidence matches both execution ID and original connection, never a similar command", () => {
  const plan = createDiagnosticPlan("turn-1", target, [proposal]);
  plan.steps[0] = { ...plan.steps[0], executionId: "run-1", status: "awaiting" };
  const record: TerminalExecution = {
    id: "run-1", connectionId: "conn-2", command: "df -h", source: "ai",
    startedAt: "2026-10-22T12:00:00Z", endedAt: null, status: "unknown",
    exitCode: null, output: null, truncated: false, boundary: "unavailable",
  };
  assert.equal(reconcileDiagnosticPlan(plan, [record]), plan);
  assert.equal(reconcileDiagnosticPlan(plan, [{ ...record, id: "other", connectionId: "conn-1" }]), plan);
  const unknown = reconcileDiagnosticPlan(plan, [{ ...record, connectionId: "conn-1" }]);
  assert.equal(unknown.steps[0].status, "observed");
  assert.equal(unknown.steps[0].result?.exitCode, null);
  assert.equal(unknown.steps[0].result?.output, null);
  const finished = { ...record, connectionId: "conn-1", status: "finished" as const, exitCode: 1, output: "disk full" };
  const observed = reconcileDiagnosticPlan(unknown, [finished]);
  assert.equal(observed.steps[0].result, finished);
  assert.equal(observed.steps[0].result?.exitCode, 1);
});
