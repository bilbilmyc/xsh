import assert from "node:assert/strict";
import test from "node:test";
import { planTransferBatch, transferNameError, keepBothName, type ConflictChoice, type TransferDraft } from "../apps/desktop/src/transfer-plan.ts";
import type { RemoteEntry } from "../apps/desktop/src/types.ts";

const entry = (path: string, fileType: RemoteEntry["fileType"] = "file"): RemoteEntry => ({
  name: path.split(/[\\/]/).pop()!, path, fileType, size: 1024, modifiedAtUnix: 1700000000, permissions: null, owner: null, group: null,
});
function fixture(direction: "upload" | "download" = "upload") {
  const draft: TransferDraft = { id: "batch", connectionId: "fixed-connection", host: "fixture.example.com:22", direction, sources: [entry(direction === "upload" ? "/local/report.txt" : "/remote/report.txt")], destination: direction === "upload" ? "/remote" : "C:\\downloads", destinationKind: "directory" };
  const existing = new Map<string, RemoteEntry>();
  const children = new Map<string, RemoteEntry[]>();
  const choices: Array<ConflictChoice | null> = [];
  let connected = true;
  const adapter = {
    assertConnected() { if (!connected) throw new Error("original connection changed"); },
    async destinationInfo(path: string) { return existing.get(path) ?? null; },
    async sourceChildren(source: RemoteEntry) { return children.get(source.path) ?? []; },
    async choose() { return choices.shift() ?? null; },
  };
  return { draft, existing, children, choices, adapter, disconnect() { connected = false; } };
}

test("fresh upload and download targets use no-overwrite writes", async () => {
  for (const direction of ["upload", "download"] as const) {
    const f = fixture(direction);
    const plan = await planTransferBatch(f.draft, "ask", f.adapter);
    assert.equal(plan!.tasks[0].overwrite, false);
    assert.equal(plan!.tasks[0].localPath, direction === "upload" ? "/local/report.txt" : "C:\\downloads\\report.txt");
    assert.equal(plan!.tasks[0].remotePath, "/remote/report.txt");
  }
});

test("recursive uploads merge existing directories and decide nested conflicts before creating anything", async () => {
  const f = fixture();
  f.draft.sources = [entry("C:\\local\\config", "directory"), entry("C:\\local\\readme.txt")];
  f.existing.set("/remote/config", entry("/remote/config", "directory"));
  f.existing.set("/remote/config/app.conf", entry("/remote/config/app.conf"));
  f.children.set("C:\\local\\config", [entry("C:\\local\\config\\app.conf"), entry("C:\\local\\config\\empty", "directory"), entry("C:\\local\\config\\shortcut", "symlink")]);
  f.choices.push({ type: "keep-both" });
  const plan = await planTransferBatch(f.draft, "ask", f.adapter);
  assert.deepEqual(plan!.directories, ["/remote/config/empty"]);
  assert.deepEqual(plan!.tasks.map((item) => item.remotePath), ["/remote/config/app (2).conf", "/remote/readme.txt"]);
  assert.ok(plan!.tasks.every((item) => !item.overwrite));
  assert.equal(plan!.skipped, 1);
});

test("new upload trees preserve empty nested directories and cancellation submits no partial plan", async () => {
  const f = fixture();
  f.draft.sources = [entry("/local/config", "directory")];
  f.children.set("/local/config", [entry("/local/config/nested", "directory")]);
  const plan = await planTransferBatch(f.draft, "ask", f.adapter);
  assert.deepEqual(plan!.directories, ["/remote/config", "/remote/config/nested"]);
  assert.deepEqual(plan!.tasks, []);
  f.existing.set("/remote/config", entry("/remote/config"));
  f.choices.push(null);
  assert.equal(await planTransferBatch(f.draft, "ask", f.adapter), null);
});

test("keep both skips existing names and names already reserved by this batch", async () => {
  const f = fixture();
  f.draft.sources = [entry("/one/report.txt"), entry("/two/report.txt")];
  f.existing.set("/remote/report.txt", entry("/remote/report.txt"));
  f.existing.set("/remote/report (2).txt", entry("/remote/report (2).txt"));
  const plan = await planTransferBatch(f.draft, "keep-both", f.adapter);
  assert.deepEqual(plan!.tasks.map((task) => task.remotePath), ["/remote/report (3).txt", "/remote/report (4).txt"]);
  assert.ok(plan!.tasks.every((task) => !task.overwrite));
});

test("a renamed target collision cancels planning without silently overwriting", async () => {
  const f = fixture();
  f.existing.set("/remote/report.txt", entry("/remote/report.txt"));
  f.existing.set("/remote/other.txt", entry("/remote/other.txt"));
  f.choices.push({ type: "rename", name: "other.txt" });
  await assert.rejects(planTransferBatch(f.draft, "ask", f.adapter), /名称已存在/);
});

test("only an explicit overwrite choice can set overwrite=true", async () => {
  const f = fixture("download");
  f.existing.set("C:\\downloads\\report.txt", entry("C:\\downloads\\report.txt"));
  f.choices.push({ type: "overwrite" });
  assert.equal((await planTransferBatch(f.draft, "ask", f.adapter))!.tasks[0].overwrite, true);
});

test("batch overwrite never replaces a directory or a symbolic link", async () => {
  for (const type of ["directory", "symlink"] as const) {
    const f = fixture();
    f.existing.set("/remote/report.txt", entry("/remote/report.txt", type));
    f.choices.push({ type: "rename", name: "safe.txt" });
    const plan = await planTransferBatch(f.draft, "overwrite", f.adapter);
    assert.equal(plan!.tasks[0].remotePath, "/remote/safe.txt");
    assert.equal(plan!.tasks[0].overwrite, false);
  }
});

test("same-batch duplicate destinations cannot overwrite the earlier planned source", async () => {
  const f = fixture();
  f.draft.sources = [entry("/one/report.txt"), entry("/two/report.txt")];
  f.choices.push({ type: "keep-both" });
  assert.deepEqual((await planTransferBatch(f.draft, "overwrite", f.adapter))!.tasks.map((task) => task.remotePath), ["/remote/report.txt", "/remote/report (2).txt"]);
});

test("download directories merge recursively without mutating the filesystem during planning", async () => {
  const f = fixture("download");
  f.draft.sources = [entry("/remote/config", "directory")];
  f.existing.set("C:\\downloads\\config", entry("C:\\downloads\\config", "directory"));
  f.children.set("/remote/config", [entry("/remote/config/nested", "directory")]);
  f.children.set("/remote/config/nested", [entry("/remote/config/nested/file.txt")]);
  const plan = await planTransferBatch(f.draft, "ask", f.adapter);
  assert.deepEqual(plan!.directories, ["C:\\downloads\\config\\nested"]);
  assert.equal(plan!.tasks[0].localPath, "C:\\downloads\\config\\nested\\file.txt");
});

test("cancel after earlier decisions discards the entire unsubmitted batch", async () => {
  const f = fixture();
  f.draft.sources = [entry("/local/fresh.txt"), entry("/local/report.txt")];
  f.existing.set("/remote/report.txt", entry("/remote/report.txt"));
  f.choices.push(null);
  assert.equal(await planTransferBatch(f.draft, "ask", f.adapter), null);
});

test("decisions applied to a batch do not leak into subsequent batches", async () => {
  const f = fixture();
  f.existing.set("/remote/report.txt", entry("/remote/report.txt"));
  f.choices.push({ type: "skip", applyToBatch: true });
  assert.equal((await planTransferBatch(f.draft, "ask", f.adapter))!.skipped, 1);
  f.choices.push({ type: "keep-both" });
  assert.equal((await planTransferBatch(f.draft, "ask", f.adapter))!.tasks[0].remotePath, "/remote/report (2).txt");
});

test("connection changes during a conflict decision invalidate the fixed batch", async () => {
  const f = fixture();
  f.existing.set("/remote/report.txt", entry("/remote/report.txt"));
  f.adapter.choose = async () => { f.disconnect(); return { type: "overwrite" }; };
  await assert.rejects(planTransferBatch(f.draft, "ask", f.adapter), /original connection changed/);
});

test("canceling while metadata is in flight cannot open a stale conflict prompt", async () => {
  const f = fixture();
  let prompts = 0;
  f.adapter.destinationInfo = async (path) => { f.disconnect(); return entry(path); };
  f.adapter.choose = async () => { prompts += 1; return { type: "overwrite" }; };
  await assert.rejects(planTransferBatch(f.draft, "ask", f.adapter), /original connection changed/);
  assert.equal(prompts, 0);
});

test("single-file save-as keep-both preserves the selected target basename", async () => {
  const f = fixture("download");
  f.draft.destination = "C:\\downloads\\custom.txt";
  f.draft.destinationKind = "file";
  f.draft.openAfterDownload = true;
  f.existing.set(f.draft.destination, entry(f.draft.destination));
  const plan = await planTransferBatch(f.draft, "keep-both", f.adapter);
  assert.equal(plan!.openPath, "C:\\downloads\\custom (2).txt");
});

test("unsafe source filenames cannot escape the chosen destination", async () => {
  const f = fixture("download");
  f.draft.sources = [{ ...entry("/remote/file"), name: "../escape" }];
  await assert.rejects(planTransferBatch(f.draft, "ask", f.adapter), /无法传输/);
  for (const invalid of ["..", ".", "NUL.txt", "trailing.", "file/child", "file\\child", "bad\u001bname"]) assert.ok(transferNameError(invalid));
  assert.equal(keepBothName("report.tar.gz", 2), "report.tar (2).gz");
  assert.ok(new TextEncoder().encode(keepBothName("文".repeat(80) + ".txt", 12)).length <= 255);
});
