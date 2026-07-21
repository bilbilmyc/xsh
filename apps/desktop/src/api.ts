import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ForwardInfo,
  ImportSummary,
  SshConfigEntry,
  SshAgentKey,
  SshDiagnosticReport,
  KnownHost,
  RemoteEntry,
  SavedSession,
  SessionDraft,
  SessionGroup,
  SessionGroupDraft,
  SshKeyDefaults,
  TerminalEvent,
  TransferEvent,
  Uuid,
} from "./types";

export const api = {
  clipboardWrite: (text: string) => invoke<void>("clipboard_write", { text }),
  clipboardRead: () => invoke<string>("clipboard_read"),
  writeTextFile: (targetPath: string, contents: string) =>
    invoke<void>("write_text_file", { targetPath, contents }),
  readTextFile: (sourcePath: string) =>
    invoke<string>("read_text_file", { sourcePath }),
  listGroups: () => invoke<SessionGroup[]>("list_groups"),
  createGroup: (draft: SessionGroupDraft) =>
    invoke<SessionGroup>("create_group", { draft }),
  updateGroup: (id: Uuid, draft: SessionGroupDraft) =>
    invoke<SessionGroup>("update_group", { id, draft }),
  deleteGroup: (id: Uuid) => invoke<Uuid[]>("delete_group", { id }),

  listKnownHosts: () => invoke<KnownHost[]>("list_known_hosts"),
  deleteKnownHost: (host: string, port: number) =>
    invoke<void>("delete_known_host", { host, port }),

  listSessions: () => invoke<SavedSession[]>("list_sessions"),
  listSshAgentKeys: () => invoke<SshAgentKey[]>("list_ssh_agent_keys"),
  getSshKeyDefaults: () => invoke<SshKeyDefaults>("get_ssh_key_defaults"),
  listSshConfigEntries: () => invoke<SshConfigEntry[]>("list_ssh_config_entries"),
  createSession: (draft: SessionDraft) =>
    invoke<SavedSession>("create_session", { draft }),
  updateSession: (id: Uuid, draft: SessionDraft) =>
    invoke<SavedSession>("update_session", { id, draft }),
  deleteSession: (id: Uuid) => invoke<void>("delete_session", { id }),

  createCredential: (
    kind: "password" | "keyPassphrase" | "keyboardInteractive",
    secret: string,
  ) => invoke<string>("create_credential", { kind, secret }),
  deleteCredential: (credentialRef: string) =>
    invoke<void>("delete_credential", { credentialRef }),

  diagnoseSession: (sessionId: Uuid) =>
    invoke<SshDiagnosticReport>("diagnose_session", { sessionId }),

  connectTerminal: (
    sessionId: Uuid,
    columns: number,
    rows: number,
    trustUnknownHost: boolean,
    onEvent: Channel<TerminalEvent>,
  ) =>
    invoke<Uuid>("connect_terminal", {
      sessionId,
      columns,
      rows,
      trustUnknownHost,
      onEvent,
    }),
  terminalWrite: (connectionId: Uuid, data: number[]) =>
    invoke<void>("terminal_write", { connectionId, data }),
  terminalRespondAuth: (connectionId: Uuid, challengeId: Uuid, responses: string[]) =>
    invoke<void>("terminal_respond_auth", { connectionId, challengeId, responses }),
  startLocalForward: (connectionId: Uuid, bindHost: string, bindPort: number, targetHost: string, targetPort: number) =>
    invoke<ForwardInfo>("start_local_forward", { connectionId, bindHost, bindPort, targetHost, targetPort }),
  startDynamicForward: (connectionId: Uuid, bindHost: string, bindPort: number) =>
    invoke<ForwardInfo>("start_dynamic_forward", { connectionId, bindHost, bindPort }),
  startRemoteForward: (connectionId: Uuid, bindHost: string, bindPort: number, localHost: string, localPort: number) =>
    invoke<ForwardInfo>("start_remote_forward", { connectionId, bindHost, bindPort, localHost, localPort }),
  stopForward: (connectionId: Uuid, forwardId: Uuid) =>
    invoke<void>("stop_forward", { connectionId, forwardId }),
  listForwards: (connectionId: Uuid) =>
    invoke<ForwardInfo[]>("list_forwards", { connectionId }),

  terminalResize: (connectionId: Uuid, columns: number, rows: number) =>
    invoke<void>("terminal_resize", { connectionId, columns, rows }),
  disconnectTerminal: (connectionId: Uuid) =>
    invoke<void>("disconnect_terminal", { connectionId }),

  connectSftp: (sessionId: Uuid, trustUnknownHost = false) =>
    invoke<Uuid>("connect_sftp", { sessionId, trustUnknownHost }),
  disconnectSftp: (connectionId: Uuid) =>
    invoke<void>("disconnect_sftp", { connectionId }),
  sftpCanonicalize: (connectionId: Uuid, path: string) =>
    invoke<string>("sftp_canonicalize", { connectionId, path }),
  sftpListDirectory: (connectionId: Uuid, path: string) =>
    invoke<RemoteEntry[]>("sftp_list_directory", { connectionId, path }),
  sftpStat: (connectionId: Uuid, path: string) =>
    invoke<RemoteEntry>("sftp_stat", { connectionId, path }),
  prepareRemoteEditPath: (remoteName: string) =>
    invoke<string>("prepare_remote_edit_path", { remoteName }),
  createLocalDirectory: (path: string) => invoke<void>("create_local_directory", { path }),
  openLocalPath: (path: string) => invoke<void>("open_local_path", { path }),
  sftpCreateDirectory: (connectionId: Uuid, path: string) =>
    invoke<void>("sftp_create_directory", { connectionId, path }),
  sftpRename: (connectionId: Uuid, oldPath: string, newPath: string) =>
    invoke<void>("sftp_rename", { connectionId, oldPath, newPath }),
  sftpDelete: (connectionId: Uuid, path: string, isDirectory: boolean) =>
    invoke<void>("sftp_delete", { connectionId, path, isDirectory }),
  sftpUpload: (
    connectionId: Uuid,
    localPath: string,
    remotePath: string,
    overwrite: boolean,
    onEvent: Channel<TransferEvent>,
  ) =>
    invoke<Uuid>("sftp_upload", {
      connectionId,
      localPath,
      remotePath,
      overwrite,
      onEvent,
    }),
  sftpDownload: (
    connectionId: Uuid,
    remotePath: string,
    localPath: string,
    overwrite: boolean,
    onEvent: Channel<TransferEvent>,
  ) =>
    invoke<Uuid>("sftp_download", {
      connectionId,
      remotePath,
      localPath,
      overwrite,
      onEvent,
    }),
  cancelTransfer: (transferId: Uuid) =>
    invoke<void>("cancel_transfer", { transferId }),

  exportCredentialsBackup: (targetPath: string, password: string) =>
    invoke<void>("export_credentials_backup", { targetPath, password }),
  importCredentialsBackup: (sourcePath: string, password: string) =>
    invoke<number>("import_credentials_backup", { sourcePath, password }),

  exportSessions: (targetPath: string, includeKnownHosts: boolean) =>
    invoke<void>("export_sessions", { targetPath, includeKnownHosts }),
  importSessions: (sourcePath: string) =>
    invoke<ImportSummary>("import_sessions", { sourcePath }),
};
