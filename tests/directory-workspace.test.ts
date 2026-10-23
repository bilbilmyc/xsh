import assert from "node:assert/strict";
import test from "node:test";
import { directoryCommand, directoryWorkspaceKey, parseDirectoryWorkspace, parseTerminalDirectory, rememberDirectory, toggleDirectoryBookmark } from "../apps/desktop/src/directory-workspace.ts";

test("directory workspaces separate users and ports and bound imported histories", () => {
  const first = { host: "EXAMPLE.COM", port: 22, username: "qa" };
  assert.equal(directoryWorkspaceKey(first), directoryWorkspaceKey({ ...first, host: "example.com" }));
  assert.notEqual(directoryWorkspaceKey(first), directoryWorkspaceKey({ ...first, username: "root" }));
  assert.notEqual(directoryWorkspaceKey(first), directoryWorkspaceKey({ ...first, port: 2222 }));
  const loaded = parseDirectoryWorkspace(JSON.stringify({ recent: ["/a", "/a", "\x00", ...Array.from({ length: 30 }, (_, index) => "/" + index)], bookmarks: [12, "/srv"], localDirectory: 4 }));
  assert.equal(loaded.recent.length, 12);
  assert.deepEqual(loaded.bookmarks, ["/srv"]);
  assert.equal(loaded.localDirectory, "");
  assert.deepEqual(parseDirectoryWorkspace("null"), { recent: [], bookmarks: [], localDirectory: "" });
});
test("bookmarks toggle and recent directories keep the newest visit first", () => {
  let workspace = parseDirectoryWorkspace(null);
  workspace = rememberDirectory(rememberDirectory(rememberDirectory(workspace, "/a"), "/b"), "/a");
  assert.deepEqual(workspace.recent, ["/a", "/b"]);
  workspace = toggleDirectoryBookmark(workspace, "/srv");
  assert.deepEqual(workspace.bookmarks, ["/srv"]);
  assert.deepEqual(toggleDirectoryBookmark(workspace, "/srv").bookmarks, []);
});
test("only explicit valid directory reports are accepted; URI data cannot become terminal control input", () => {
  assert.equal(parseTerminalDirectory("file://qa-host/srv/a%20b%23c%3Fd%25"), "/srv/a b#c?d%");
  for (const value of ["/srv/app", "https://example.com/a", "file://user:pass@host/tmp", "file://host/tmp?x=1", "file://host/tmp#x", "file://host/%1b", "file://host/%ZZ"]) assert.equal(parseTerminalDirectory(value), null);
  assert.equal(directoryCommand("/srv/a'b"), "cd -- '/srv/a'\\''b'");
  assert.equal(directoryCommand("relative/path"), null);
  assert.equal(directoryCommand("/tmp\ninjected"), null);
});
