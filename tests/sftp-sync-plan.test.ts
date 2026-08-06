import assert from "node:assert/strict";
import test from "node:test";
import { buildSftpSyncPreview, matchesSyncExclude } from "../apps/desktop/src/sftp-sync-plan.ts";
import type { LocalSyncEntry, RemoteEntry } from "../apps/desktop/src/types.ts";

const local = (relativePath: string, overrides: Partial<LocalSyncEntry> = {}): LocalSyncEntry => ({
  relativePath,
  absolutePath: `C:/project/${relativePath}`,
  isDirectory: false,
  size: 10,
  modifiedAtUnix: 100,
  ...overrides,
});

const remote = (path: string, overrides: Partial<RemoteEntry> = {}): RemoteEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  fileType: "file",
  size: 10,
  modifiedAtUnix: 100,
  permissions: null,
  owner: null,
  group: null,
  ...overrides,
});

test("matches sync exclusions for directory roots and descendant files", () => {
  assert.equal(matchesSyncExclude("node_modules/**", "node_modules"), true);
  assert.equal(matchesSyncExclude("node_modules/**", "node_modules/pkg/index.js"), true);
  assert.equal(matchesSyncExclude("*.log", "logs/app.log"), true);
  assert.equal(matchesSyncExclude("*.log", "src/app.ts"), false);
});

test("previews only create/upload changes and keeps conflicts out of execution", () => {
  const changes = buildSftpSyncPreview([
    local("config", { isDirectory: true, size: 0 }),
    local("config/app.json", { size: 12 }),
    local("replace.txt", { size: 30 }),
    local("collision", { isDirectory: true, size: 0 }),
  ], new Map([
    ["replace.txt", remote("/deploy/replace.txt", { size: 10 })],
    ["collision", remote("/deploy/collision", { fileType: "file" })],
  ]), "/deploy");

  assert.deepEqual(changes.map((change) => [change.type, change.relativePath]), [
    ["conflict", "collision"],
    ["createDirectory", "config"],
    ["upload", "config/app.json"],
    ["upload", "replace.txt"],
  ]);
});

test("treats the local directory as authoritative when same-size timestamps differ", () => {
  const changes = buildSftpSyncPreview([
    local("settings.ini", { size: 10, modifiedAtUnix: 100 }),
  ], new Map([
    ["settings.ini", remote("/deploy/settings.ini", { size: 10, modifiedAtUnix: 200 })],
  ]), "/deploy");

  assert.deepEqual(changes, [{
    type: "upload",
    relativePath: "settings.ini",
    localPath: "C:/project/settings.ini",
    remotePath: "/deploy/settings.ini",
    reason: "修改时间不同",
  }]);
});
