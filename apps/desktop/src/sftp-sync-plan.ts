import type { LocalSyncEntry, RemoteEntry } from "./types";

export type SyncChange =
  | { type: "createDirectory"; relativePath: string; remotePath: string }
  | { type: "upload"; relativePath: string; localPath: string; remotePath: string; reason: string }
  | { type: "conflict"; relativePath: string; reason: string };

export function buildSftpSyncPreview(
  localEntries: LocalSyncEntry[],
  remoteEntries: Map<string, RemoteEntry>,
  remoteRoot: string,
): SyncChange[] {
  const changes: SyncChange[] = [];
  for (const entry of localEntries) {
    const remote = remoteEntries.get(entry.relativePath);
    const remotePath = joinRemoteSyncPath(remoteRoot, entry.relativePath);
    if (entry.isDirectory) {
      if (!remote) changes.push({ type: "createDirectory", relativePath: entry.relativePath, remotePath });
      else if (remote.fileType !== "directory") changes.push({ type: "conflict", relativePath: entry.relativePath, reason: "远程同名路径是文件" });
      continue;
    }
    if (!remote) {
      changes.push({ type: "upload", relativePath: entry.relativePath, localPath: entry.absolutePath, remotePath, reason: "远程不存在" });
    } else if (remote.fileType === "directory") {
      changes.push({ type: "conflict", relativePath: entry.relativePath, reason: "远程同名路径是目录" });
    } else if (remote.size !== entry.size || (entry.modifiedAtUnix !== null && remote.modifiedAtUnix !== null && entry.modifiedAtUnix !== remote.modifiedAtUnix)) {
      changes.push({ type: "upload", relativePath: entry.relativePath, localPath: entry.absolutePath, remotePath, reason: remote.size !== entry.size ? "文件大小不同" : "修改时间不同" });
    }
  }
  return changes.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
}

export function matchesSyncExclude(pattern: string, value: string): boolean {
  const normalized = pattern.trim().replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized.endsWith("/**") && value === normalized.slice(0, -3)) return true;
  const source = [...normalized];
  const target = [...value];
  const matches = Array.from({ length: source.length + 1 }, () => Array<boolean>(target.length + 1).fill(false));
  matches[0][0] = true;
  for (let index = 1; index <= source.length; index += 1) {
    if (source[index - 1] === "*") matches[index][0] = matches[index - 1][0];
  }
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      matches[sourceIndex][targetIndex] = source[sourceIndex - 1] === "*"
        ? matches[sourceIndex - 1][targetIndex] || matches[sourceIndex][targetIndex - 1]
        : source[sourceIndex - 1] === "?" || source[sourceIndex - 1] === target[targetIndex - 1]
          ? matches[sourceIndex - 1][targetIndex - 1]
          : false;
    }
  }
  return matches[source.length][target.length];
}

export function joinRemoteSyncPath(root: string, relative: string) {
  return `${root.replace(/\/+$/, "")}/${relative}`.replace(/^([^/])/, "/$1");
}
