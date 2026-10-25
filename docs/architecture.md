# XSH Architecture

## Direction

XSH uses a Rust workspace behind a Tauri 2 desktop application. React renders application chrome and xterm.js renders terminal cells. Rust owns SSH, SFTP, persistence, credentials, imports/exports, and transfer scheduling.

## Components

- `xsh-domain`: serializable domain types and versioned bundle format.
- `xsh-storage`: SQLite repositories and migrations.
- `xsh-security`: XSH-owned encrypted credential storage.
- `xsh-ssh`: connection lifecycle, authentication, host-key checks, remote PTY and terminal byte streams.
- `xsh-sftp`: remote filesystem operations and transfer tasks.
- `xsh-rdp`: owned, in-process FreeRDP sessions, native rendering, input, certificate decisions and clipboard.
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

Downloads use up to six file handles sharing one queue of disjoint 256 KiB ranges. A twelve-slot budget follows each chunk from its reader through the event channel and any out-of-order buffering until the contiguous prefix is written to disk. This bounds active payload buffering to 3 MiB per download, with a separately bounded reusable buffer pool. The writer owns its reader tasks; cancellation, errors and dropping the writer abort outstanding work. A failed read closes buffer admission so an unfillable range cannot deadlock later readers.

## Transfer policy

The React preferences document in `xsh.preferences.v1` is the persistence source for the four user-facing SFTP policy values. Startup and settings saves send the normalized policy through one Tauri command. `SftpManager` validates it again and remains authoritative for runtime admission and bandwidth accounting. The defaults are four active transfers globally, two per target host, and unlimited aggregate upload/download bandwidth. A transfer carries its originating connection ID and endpoint; connection panels filter by that ownership while the global transfer manager can control background tasks from released panels.

## Remote desktop (VNC/RDP)

Remote desktop is a first-class session kind (`kind = "remoteDesktop"` on the sessions table) with an explicit transport: `direct` connects the embedded client to the target without SSH; `sshTunnel` uses an XSH-owned ephemeral SSH forward (the migration default for older profiles). The desktop reports connected only after its protocol handshake. SSH transport currently reuses `connect_terminal`, including host-key confirmation, keyboard-interactive authentication, reconnect and acknowledgement for a hidden PTY.

**VNC renders embedded in the app** with noVNC. An owned Rust bridge binds an ephemeral loopback WebSocket and forwards binary RFB bytes to the direct target or SSH forward. The WebSocket upgrade requires a random per-bridge token and an allowed application origin before the target is contacted. The stored VNC password is decrypted on demand for the in-app library and is never persisted in frontend preferences.

Each bridge owns its listener and connection tasks, admits at most sixteen simultaneous connections, and applies separate ten-second TCP-connect and WebSocket-handshake deadlines. Closing a bridge stops the listener and awaits cancellation of all connections, including unfinished handshakes. Either peer disconnecting ends both proxy directions without leaving a detached writer.

**RDP executes in the XSH process** through the `xsh-rdp` Rust crate and a narrow C adapter. FreeRDP, WinPR and OpenSSL are built from pinned sources into one bundled native library. Only the cliprdr, drdynvc, disp and rdpgfx client channels are configured; no viewer executable or separately installed channel plugin is used. Windows packages the DLL next to the application, while macOS packages the dylib in `Contents/Frameworks`.

Each RDP connection owns a blocking worker, a bounded input queue and cancellable native lifetime. Closing awaits the worker, including a stalled handshake or certificate decision. Certificate challenges have unique identifiers and a separate reply path, so they cannot wait behind protocol input. Trust decisions use the original target name through SSH tunnels and accept only for the current connection; the certificate store belongs to XSH's application-data directory.

FreeRDP's GDI framebuffer is sent as binary RGBA dirty rectangles over Tauri IPC. A single outstanding frame requires an exact sequence acknowledgement after Canvas painting. If the renderer falls behind, native decoding continues and the next admitted frame is a full snapshot. This bounds pending frame payloads without dropping protocol bytes or losing changes outside the latest dirty rectangle. Desktop dimensions are limited to 8192 per axis and a 4096×2160 pixel budget.

Native pointer callbacks send separate bounded binary cursor packets, including RGBA transparency, hotspots and hidden/default states. Cached pointer selections are deduplicated before IPC; cursor packets do not consume frame credits. The browser scales cursor images to its 128-pixel cursor limit. Negotiated CLIPRDR and DISP capabilities gate viewer controls, and the server's monitor-area budget constrains resolution choices. Optional operation errors leave the session usable; asynchronous clipboard reads and text prompts are tied to the connection that started them.

`EmbeddedDesktop` supplies shared VNC/RDP controls, credential forms, certificate confirmation, input release on blur, clipboard actions and connection ownership. The legacy serialized `viewerCommand` field is retained for reading old profiles and ignored; new saves clear it. No external viewer command is executed.

Passwords continue to live in the XSH vault (`credential_ref`), with the session editor's transactional create/rollback and reference checks. RDP credentials stay in the backend; VNC credentials cross IPC only to the app's embedded noVNC library. See [remote-desktop.md](remote-desktop.md) for build and validation boundaries.

## Persistence and secrets

SQLite contains session metadata, trusted public host keys, and AES-256-GCM encrypted XSH credential records. Passwords and private-key passphrases are addressed by opaque credential references. The encryption key is stored in a separate file in the XSH app-data directory; on Unix, the key and credential database use `0600` permissions, and symlink key files are rejected. No OS credential manager is used. This protects against casual database inspection and accidental disclosure, but not a malicious process that already has the current user's file access.

## Import/export

The versioned domain bundle is independent of SQLite. The default format contains folders, sessions, tags, settings, and optionally known hosts. It excludes passwords, passphrases, and private-key material. Terminal, SFTP, and ProxyJump all resolve trust only from XSH's SQLite Known Hosts records; the user's OpenSSH `known_hosts` file is not silently adopted as XSH trust.
