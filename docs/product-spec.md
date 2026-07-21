# XSH Product Specification

## Objective

Build a local-first SSH2 desktop client for macOS and Windows that covers the daily Xshell/SecureCRT/MobaXterm workflow: organized saved sessions, persistent tabbed terminals, password and key authentication, safe clipboard behavior, workspace recovery, command shortcuts, port forwarding, and integrated SFTP transfers.

## V2 acceptance criteria

1. Connect to OpenSSH servers using password, OpenSSH private key, SSH Agent, or keyboard-interactive authentication.
2. Store passwords and private-key passphrases only in the XSH SQLite + AES-256-GCM credential vault; do not use the OS keychain.
3. Present and persist SHA-256 server fingerprints on first use and block changed keys by default.
4. Render UTF-8/CJK, 256-color and true-color terminal output with a resizable remote PTY and configurable scrollback up to 1,000,000 lines.
5. Keep background terminal tabs mounted so switching tabs preserves the SSH connection, remote process, scrollback, and PTY state.
6. Restore open session IDs, active tab, second split pane, and layout after restart without persisting credentials, terminal output, or command text.
7. Support nested session folders, drag-to-folder organization, search, favorites, tags, import/export, and `~/.ssh/config` import.
8. Support configurable right-click paste/menu, macOS Command clipboard/search shortcuts, Windows Ctrl+Shift clipboard/search shortcuts, optional copy-on-select, optional multiline-paste confirmation, and platform-safe temporary terminal font zoom without stealing remote Ctrl control sequences.
9. Stream SFTP uploads/downloads with bounded memory, real concurrency limits, progress, cancellation, retry, bulk selection, drag upload, and conflict handling.
10. Reject high-confidence plaintext credentials and private keys from command snippets and quick commands.

## Implemented V2 scope

- Multi-tab terminals, duplicate/reorder/rename/close workflows, draggable 15%–85% split panes, split-focus switching, broadcast, keepalive, reconnect, logs, and command history.
- Network-aware reconnect that pauses while offline, resumes immediately when connectivity returns, and checks stale terminals after device wake or page visibility restoration.
- Live connection state and duplicate-tab counts in the session tree, plus recursive folder-level bulk opening with connection-count protection.
- An active-connection manager for locating, reconnecting, closing, and bulk-handling disconnected tabs.
- Workspace shortcuts for tab creation/closing/navigation, connection duplication/reconnect, sidebar visibility, split layouts/focus, SFTP, and the command center, with an in-app shortcut reference.
- Global appearance and terminal preferences with optional per-session font and scrollback overrides; scrollback supports 100 to 1,000,000 lines with an explicit high-memory warning.
- Command center and Xshell-style quick-command bar with groups, search, platform-safe keyboard shortcuts, drag ordering, and `\r`/`\n`/`\t` escapes.
- Password, private-key, encrypted-key, SSH Agent, and keyboard-interactive authentication.
- Known Hosts management, diagnostics, ProxyJump, and local/remote/dynamic port forwarding.
- SFTP directory operations, remote editing, multi-select bulk actions, two-worker upload queue, retries, cancellation, and task cleanup.
- Password-protected session export carries the credentials referenced by those sessions; `.xshbackup` remains available for a separate full credential-vault backup.
- macOS personal build and Windows build/CI preparation.

## Data and security boundaries

- Never persist credentials in plaintext, logs, workspace state, command history, quick commands, or unencrypted export payloads.
- Never silently trust a changed server key.
- Keep workspace snapshots limited to tab IDs, session IDs, active/secondary tab IDs, and layout.
- Keep command snippets local and outside session exports; variable references such as `$TOKEN` are allowed, literal secrets are rejected.
- Stream terminal and file data with bounded buffers.
- Do not introduce cloud synchronization or shared credentials without an explicit security design review.

## Validation commands

```bash
pnpm run build
cargo fmt --all --check
cargo test --workspace --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
pnpm run build:macos:personal
```

## Deferred

SSH1, Telnet, Rlogin, serial ports, RDP, X11 forwarding, ZMODEM, Kerberos, PKCS#11, cloud synchronization, shared team credentials, and a general-purpose end-user scripting runtime.
