import assert from "node:assert/strict";
import test from "node:test";
import { browseRemoteEntries, remoteBreadcrumbs, selectBrowserPaths } from "../apps/desktop/src/sftp-browser.ts";
import type { RemoteEntry } from "../apps/desktop/src/types.ts";

function entry(name: string, fileType: RemoteEntry["fileType"] = "file", size = 0, modifiedAtUnix: number | null = null): RemoteEntry {
  return { name, path: `/srv/${name}`, fileType, size, modifiedAtUnix, permissions: null, owner: null, group: null };
}

const plainClick = { shiftKey: false, ctrlKey: false, metaKey: false };
test("both file panes select directories and extend a visible range with the same anchor", () => {
  const visible = ["/app", "/logs", "/readme"];
  const first = selectBrowserPaths(visible, new Set(), null, "/app", plainClick);
  const range = selectBrowserPaths(visible, first.paths, first.anchor, "/readme", { ...plainClick, shiftKey: true });
  assert.deepEqual([...range.paths], visible);
  assert.equal(range.anchor, "/app");
  const shorter = selectBrowserPaths(visible, range.paths, range.anchor, "/logs", { ...plainClick, shiftKey: true });
  assert.deepEqual([...shorter.paths], ["/app", "/logs"]);
  assert.deepEqual([...first.paths], ["/app"]);
});

test("modifier selection toggles and adds ranges while a missing filtered anchor starts a fresh selection", () => {
  const visible = ["/app", "/logs", "/readme"];
  const selected = new Set(["/app"]);
  const toggle = selectBrowserPaths(visible, selected, "/app", "/app", { ...plainClick, metaKey: true });
  assert.equal(toggle.paths.size, 0);
  const range = selectBrowserPaths(visible, selected, "/logs", "/readme", { ...plainClick, ctrlKey: true, shiftKey: true });
  assert.deepEqual([...range.paths], visible);
  const filtered = selectBrowserPaths(["/logs", "/readme"], selected, "/app", "/readme", { ...plainClick, shiftKey: true });
  assert.deepEqual([...filtered.paths], ["/readme"]);
  assert.equal(filtered.anchor, "/readme");
  assert.deepEqual([...selected], ["/app"]);
});

test("file browsing keeps directories first and naturally orders numbered filenames without changing server entries", () => {
  const entries = [entry("log10.txt"), entry("z-backups", "directory"), entry("log2.txt"), entry("app", "directory")];
  const original = [...entries];
  assert.deepEqual(browseRemoteEntries(entries, "", true, { field: "name", descending: false }).map((item) => item.name), ["app", "z-backups", "log2.txt", "log10.txt"]);
  assert.deepEqual(browseRemoteEntries(entries, "", true, { field: "name", descending: true }).map((item) => item.name), ["z-backups", "app", "log10.txt", "log2.txt"]);
  assert.deepEqual(entries, original);
});

test("search and hidden-file filtering compose before range selection uses visible entries", () => {
  const entries = [entry(".error.log"), entry("Error.log"), entry("error2.log"), entry("app.txt")];
  const visible = browseRemoteEntries(entries, " ERROR ", false, { field: "name", descending: false });
  assert.deepEqual(visible.map((item) => item.name), ["Error.log", "error2.log"]);
  assert.deepEqual(browseRemoteEntries(entries, "error", true, { field: "name", descending: false }).map((item) => item.name), [".error.log", "Error.log", "error2.log"]);
});

test("size and timestamp sorting preserve directories first and handle unknown timestamps", () => {
  const entries = [entry("small", "file", 2, null), entry("large", "file", 100, 100), entry("dir", "directory", 0, 1)];
  assert.deepEqual(browseRemoteEntries(entries, "", true, { field: "size", descending: true }).map((item) => item.name), ["dir", "large", "small"]);
  assert.deepEqual(browseRemoteEntries(entries, "", true, { field: "modified", descending: true }).map((item) => item.name), ["dir", "large", "small"]);
});

test("directory breadcrumbs preserve literal remote names and navigate to actual ancestor paths", () => {
  assert.deepEqual(remoteBreadcrumbs("/"), [{ label: "/", path: "/" }]);
  assert.deepEqual(remoteBreadcrumbs("/srv/项目 files/logs"), [
    { label: "/", path: "/" },
    { label: "srv", path: "/srv" },
    { label: "项目 files", path: "/srv/项目 files" },
    { label: "logs", path: "/srv/项目 files/logs" },
  ]);
  assert.deepEqual(remoteBreadcrumbs("."), [{ label: ".", path: "." }]);
});
