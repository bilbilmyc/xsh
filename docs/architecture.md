# XSH Architecture

## Direction

XSH uses a Rust workspace behind a Tauri 2 desktop application. React renders application chrome and xterm.js renders terminal cells. Rust owns SSH, SFTP, persistence, credentials, imports/exports, and transfer scheduling.

## Components

- `xsh-domain`: serializable domain types and versioned bundle format.
- `xsh-storage`: SQLite repositories and migrations.
- `xsh-security`: XSH-owned encrypted credential storage.
- `xsh-ssh`: connection lifecycle, authentication, host-key checks, remote PTY and terminal byte streams.
- `xsh-sftp`: remote filesystem operations and transfer tasks.
- `apps/desktop/src-tauri`: composition root and narrow IPC commands.
- `apps/desktop/src`: session tree, tabs, terminal, SFTP and transfer UI.

## Runtime flow

1. UI asks the Rust application state to connect a saved session.
2. Rust resolves the credential from XSH’s local encrypted SQLite credential table and starts an SSH task.
3. The SSH handler verifies the presented host key against SQLite. An unknown key is returned as a structured challenge bound to the target or ProxyJump endpoint; the approval command recomputes its algorithm and SHA-256 fingerprint before persistence.
4. Rust requests an `xterm-256color` PTY and shell.
5. Output bytes are forwarded through a bounded Tauri channel using a 2 MiB per-connection credit window. Credit is returned only after xterm.js finishes consuming the bytes, so renderer slowdown applies backpressure to SSH reads; input is sent back in short batches.
6. SFTP opens a subsystem channel on the authenticated SSH connection or a dedicated connection when isolation is needed. Uploads and downloads enter one Rust-owned scheduler that enforces an application-wide active limit, a normalized `host:port` limit, and earliest-eligible admission without host head-of-line blocking. Pausing releases admission and resuming requeues the task. Upload and download payloads, including remote resume samples, use separate aggregate token buckets with bounded bursts; short reads refund unused reservations and all queue registrations are drop-safe.
7. Uploads, downloads, and file mutations share leases covering the final path, subtrees, partial files, metadata, and remote-replacement recovery artifacts. If a server rejects overwrite-by-rename, XSH records bounded SHA-256 identity samples, publishes a versioned journal before moving the destination to a deterministic backup, and publishes a separate installed marker before cleanup. The next upload can then recover an interrupted rename, rollback, or cleanup without guessing ownership.

## Transfer policy

The React preferences document in `xsh.preferences.v1` is the persistence source for the four user-facing SFTP policy values. Startup and settings saves send the normalized policy through one Tauri command. `SftpManager` validates it again and remains authoritative for runtime admission and bandwidth accounting. The defaults are four active transfers globally, two per target host, and unlimited aggregate upload/download bandwidth. A transfer carries its originating connection ID and endpoint; connection panels filter by that ownership while the global transfer manager can control background tasks from released panels.

## Remote desktop (VNC/RDP)

Remote desktop is a first-class session kind (`kind = "remoteDesktop"` on the sessions table) with an explicit transport: `direct` opens the desktop straight at the target address like a plain VNC/RDP client (no SSH fields at all), `sshTunnel` routes traffic through an encrypted SSH server (ephemeral local forward; the default for profiles persisted before the field existed). Connecting such a session opens a remote-desktop control-panel tab (not a terminal): direct panes are ready immediately, tunnel panes drive the same `connect_terminal` lifecycle — host-key confirmation, keyboard-interactive auth, auto-reconnect, output acknowledgement for the hidden PTY.

**VNC renders embedded in the app**: the pane hosts noVNC (RFB over a loopback WebSocket). A Rust-side bridge (`open_remote_desktop_ws_bridge`) binds an ephemeral `127.0.0.1` port and proxies binary WebSocket frames to the tunnel listener or the direct target; the webview CSP allows `ws://127.0.0.1:*`. The stored login password is decrypted on demand and passed to noVNC for VNC auth (it crosses the IPC boundary to the app's own frontend, never persisted there). A per-session external viewer command template opts out of embedding.

**RDP uses the platform engine** (a full in-app RDP client would mean implementing CredSSP/graphics pipelines): Windows launches mstsc against a one-shot DPAPI-protected `.rdp` file (`password 51:b:` for the current user) with the stored username, so the desktop opens without a credential prompt; macOS uses `rdp://` URLs. Credential lifecycle mirrors SSH: passwords live in the XSH vault (`credential_ref` on the profile), are created/rolled back with the session editor transaction, and are checked for references before deletion.

## Persistence and secrets

SQLite contains session metadata, trusted public host keys, and AES-256-GCM encrypted XSH credential records. Passwords and private-key passphrases are addressed by opaque credential references. The encryption key is stored in a separate file in the XSH app-data directory; on Unix, the key and credential database use `0600` permissions, and symlink key files are rejected. No OS credential manager is used. This protects against casual database inspection and accidental disclosure, but not a malicious process that already has the current user's file access.

## Import/export

The versioned domain bundle is independent of SQLite. The default format contains folders, sessions, tags, settings, and optionally known hosts. It excludes passwords, passphrases, and private-key material. Terminal, SFTP, and ProxyJump all resolve trust only from XSH's SQLite Known Hosts records; the user's OpenSSH `known_hosts` file is not silently adopted as XSH trust.
