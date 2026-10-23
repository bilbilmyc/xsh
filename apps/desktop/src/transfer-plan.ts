import type { RemoteEntry } from "./types.ts";

export type ConflictPolicy = "ask" | "skip" | "keep-both" | "overwrite";
export interface TransferDraft {
  id: string;
  connectionId: string;
  host: string;
  direction: "upload" | "download";
  sources: readonly RemoteEntry[];
  destination: string;
  destinationKind: "directory" | "file";
  openAfterDownload?: boolean;
}
export interface PlannedTransfer {
  localPath: string;
  remotePath: string;
  overwrite: boolean;
}
export type ConflictChoice = { type: "skip" | "keep-both" | "overwrite"; applyToBatch?: boolean } | { type: "rename"; name: string };
export interface TransferConflict {
  source: RemoteEntry;
  destination: RemoteEntry;
  destinationPath: string;
  canOverwrite: boolean;
  remainingItems: number;
  validateName(name: string): Promise<string | null>;
}
export interface TransferPlanAdapter {
  assertConnected(): void;
  destinationInfo(path: string): Promise<RemoteEntry | null>;
  sourceChildren(entry: RemoteEntry): Promise<RemoteEntry[]>;
  choose(conflict: TransferConflict): Promise<ConflictChoice | null>;
}
export interface TransferPlan {
  tasks: PlannedTransfer[];
  directories: string[];
  skipped: number;
  openPath: string | null;
}

export function transferNameError(name: string): string | null {
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)) return "名称不能为空，也不能含路径分隔符、控制字符或不兼容的特殊字符。";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "该名称是系统保留名称，请换一个。";
  return new TextEncoder().encode(name).length > 255 ? "文件名不能超过 255 字节。" : null;
}

export function joinTransferPath(parent: string, name: string, local: boolean): string {
  const separator = local && (parent.includes("\\") || /^[a-z]:/i.test(parent)) ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}
export function transferParent(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return ".";
  return path.slice(0, index + 1);
}
export function keepBothName(name: string, index: number): string {
  const dot = name.lastIndexOf(".");
  const split = dot > 0 ? dot : name.length;
  const suffix = ` (${index})`;
  const extension = name.slice(split);
  let stem = name.slice(0, split);
  while (stem && new TextEncoder().encode(stem + suffix + extension).length > 255) stem = Array.from(stem).slice(0, -1).join("");
  return `${stem}${suffix}${extension}`;
}

/**
 * Fix one batch's connection, sources and destination before any mutations.
 * All names/decisions live here, shared by uploads, downloads and recursive
 * directory merges. New/renamed files always use backend no-overwrite writes.
 */
export async function planTransferBatch(draft: TransferDraft, policy: ConflictPolicy, adapter: TransferPlanAdapter): Promise<TransferPlan | null> {
  const local = draft.direction === "download";
  const plan: TransferPlan = { tasks: [], directories: [], skipped: 0, openPath: null };
  const reserved = new Map<string, RemoteEntry>();
  const key = (path: string) => local && /^(?:[a-z]:|\\\\)/i.test(path) ? path.toLocaleLowerCase() : path;
  let batchPolicy = policy;
  let cancelled = false;
  let visited = 0;
  const lookup = async (path: string) => {
    adapter.assertConnected();
    const info = reserved.get(key(path)) ?? await adapter.destinationInfo(path);
    adapter.assertConnected();
    return info;
  };
  const visit = async (source: RemoteEntry, requestedPath: string, remainingItems: number, depth: number): Promise<void> => {
    adapter.assertConnected();
    if (cancelled) return;
    if (++visited > 10000 || depth > 48) throw new Error("本批目录超过 10,000 项或 48 层，请分批传输。");
    if (!local && source.fileType !== "file" && source.fileType !== "directory") { plan.skipped += 1; return; }
    const invalidSource = transferNameError(source.name);
    if (invalidSource) throw new Error(`无法传输 ${source.name}：${invalidSource}`);
    let destinationPath = requestedPath;
    let overwrite = false;
    let existing = await lookup(destinationPath);
    const merge = source.fileType === "directory" && existing?.fileType === "directory";
    if (existing && !merge) {
      const canOverwrite = source.fileType !== "directory" && existing.fileType === "file" && !reserved.has(key(destinationPath));
      const validateName = async (name: string) => {
        const error = transferNameError(name);
        if (error) return error;
        return await lookup(joinTransferPath(transferParent(requestedPath), name, local)) ? "这个名称已存在，请使用其他名称或选择保留两份。" : null;
      };
      const choice: ConflictChoice | null = batchPolicy === "ask" || (batchPolicy === "overwrite" && !canOverwrite)
        ? await adapter.choose({ source, destination: existing, destinationPath, canOverwrite, remainingItems, validateName })
        : { type: batchPolicy };
      if (!choice) { cancelled = true; return; }
      if (choice.type !== "rename" && choice.applyToBatch) batchPolicy = choice.type;
      if (choice.type === "skip") { plan.skipped += 1; return; }
      if (choice.type === "overwrite") {
        if (!canOverwrite) throw new Error("文件与目录、链接之间不能直接覆盖，请重命名或跳过。");
        overwrite = true;
      } else if (choice.type === "rename") {
        const error = await validateName(choice.name);
        if (error) throw new Error(error);
        destinationPath = joinTransferPath(transferParent(requestedPath), choice.name, local);
        existing = null;
      } else {
        let available: string | null = null;
        for (let index = 2; index < 10002; index += 1) {
          const candidate = keepBothName(requestedPath.split(/[\\/]/).pop() ?? source.name, index);
          const next = joinTransferPath(transferParent(requestedPath), candidate, local);
          if (!await lookup(next)) { available = next; break; }
        }
        if (!available) throw new Error("未找到可用的新名称，请手动重命名。");
        destinationPath = available;
        existing = null;
      }
    }
    reserved.set(key(destinationPath), { ...source, path: destinationPath });
    if (source.fileType === "directory") {
      if (!existing) plan.directories.push(destinationPath);
      const children = await adapter.sourceChildren(source);
      for (let index = 0; index < children.length; index += 1) {
        await visit(children[index], joinTransferPath(destinationPath, children[index].name, local), children.length - index - 1, depth + 1);
      }
    } else {
      plan.tasks.push(local
        ? { remotePath: source.path, localPath: destinationPath, overwrite }
        : { localPath: source.path, remotePath: destinationPath, overwrite });
      if (draft.openAfterDownload && draft.sources.length === 1) plan.openPath = destinationPath;
    }
  };
  for (let index = 0; index < draft.sources.length; index += 1) {
    const source = draft.sources[index];
    const destination = draft.destinationKind === "file" ? draft.destination : joinTransferPath(draft.destination, source.name, local);
    const name = destination.split(/[\\/]/).pop() ?? "";
    const error = transferNameError(name);
    if (error) throw new Error(error);
    await visit(source, destination, draft.sources.length - index - 1, 0);
  }
  adapter.assertConnected();
  return cancelled ? null : plan;
}
