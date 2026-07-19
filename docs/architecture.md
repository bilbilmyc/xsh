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
3. The SSH handler verifies the presented host key against SQLite.
4. Rust requests an `xterm-256color` PTY and shell.
5. Output bytes are forwarded through a Tauri channel; input is sent back in short batches.
6. SFTP opens a subsystem channel on the authenticated SSH connection or a dedicated connection when isolation is needed.

## Persistence and secrets

SQLite contains session metadata, trusted public host keys, and AES-256-GCM encrypted XSH credential records. Passwords and private-key passphrases are addressed by opaque credential references; the encryption key is stored in the XSH app-data directory, and no OS credential manager is used.

## Import/export

The versioned domain bundle is independent of SQLite. The default format contains folders, sessions, tags, settings, and optionally known hosts. It excludes passwords, passphrases, and private-key material.
