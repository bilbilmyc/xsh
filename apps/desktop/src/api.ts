import { Channel, invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  BackupImportSummary,
  ForwardHealth,
  ForwardInfo,
  ForwardProfile,
  ImportSummary,
  RemoteDesktopLaunch,
  RemoteDesktopProfile,
  RemoteDesktopWsBridge,
  SshConfigEntry,
  SshAgentKey,
  SshDiagnosticReport,
  HostKeyApproval,
  KnownHost,
  LocalPortDiagnostic,
  LocalSyncEntry,
  RemoteEntry,
  SavedSession,
  SessionDraft,
  SessionGroup,
  SessionGroupDraft,
  SshKeyDefaults,
  TerminalEvent,
  TransferEvent,
  TransferListSnapshot,
  SftpConnectResponse,
  SftpTransferPolicy,
  Uuid,
} from "./types";

export const api = {
  clipboardWrite: (text: string) => writeText(text),
  clipboardRead: () => readText(),
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
  trustSessionHostKey: (sessionId: Uuid, approval: HostKeyApproval) =>
    invoke<void>("trust_session_host_key", { sessionId, approval }),

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
    onEvent: Channel<TerminalEvent | ArrayBuffer>,
  ) =>
    invoke<Uuid>("connect_terminal", {
      sessionId,
      columns,
      rows,
      onEvent,
    }),
  terminalWrite: (connectionId: Uuid, data: string) =>
    invoke<void>("terminal_write", { connectionId, data }),
  terminalWriteBinary: (connectionId: Uuid, data: number[]) =>
    invoke<void>("terminal_write_binary", { connectionId, data }),
  terminalAcknowledgeOutput: (connectionId: Uuid, consumedBytes: number) =>
    invoke<void>("terminal_acknowledge_output", { connectionId, consumedBytes }),
  terminalRespondAuth: (connectionId: Uuid, challengeId: Uuid, responses: string[]) =>
    invoke<void>("terminal_respond_auth", { connectionId, challengeId, responses }),
  startLocalForward: (connectionId: Uuid, bindHost: string, bindPort: number, targetHost: string, targetPort: number) =>
    invoke<ForwardInfo>("start_local_forward", { connectionId, bindHost, bindPort, targetHost, targetPort }),
  startDynamicForward: (connectionId: Uuid, bindHost: string, bindPort: number) =>
    invoke<ForwardInfo>("start_dynamic_forward", { connectionId, bindHost, bindPort }),
  startRemoteForward: (connectionId: Uuid, bindHost: string, bindPort: number, localHost: string, localPort: number) =>
    invoke<ForwardInfo>("start_remote_forward", { connectionId, bindHost, bindPort, localHost, localPort }),
  startForwardProfile: (connectionId: Uuid, profile: ForwardProfile) =>
    invoke<ForwardInfo>("start_forward_profile", { connectionId, profile }),
  stopForward: (connectionId: Uuid, forwardId: Uuid) =>
    invoke<void>("stop_forward", { connectionId, forwardId }),
  listForwards: (connectionId: Uuid) =>
    invoke<ForwardInfo[]>("list_forwards", { connectionId }),
  diagnoseLocalPort: (bindHost: string, bindPort: number) =>
    invoke<LocalPortDiagnostic>("diagnose_local_port", { bindHost, bindPort }),
  getForwardHealth: (connectionId: Uuid, forwardId: Uuid) =>
    invoke<ForwardHealth>("get_forward_health", { connectionId, forwardId }),
  startRemoteDesktop: (connectionId: Uuid, profile: RemoteDesktopProfile, launchViewer: boolean) =>
    invoke<RemoteDesktopLaunch>("start_remote_desktop", { connectionId, profile, launchViewer }),
  openRemoteDesktopViewer: (profile: RemoteDesktopProfile) =>
    invoke<string>("open_remote_desktop_viewer", { profile }),
  openRemoteDesktopWsBridge: (host: string, port: number) =>
    invoke<RemoteDesktopWsBridge>("open_remote_desktop_ws_bridge", { host, port }),
  closeRemoteDesktopWsBridge: (port: number) =>
    invoke<void>("close_remote_desktop_ws_bridge", { port }),
  getRemoteDesktopPassword: (credentialRef: string) =>
    invoke<string>("get_remote_desktop_password", { credentialRef }),

  terminalResize: (connectionId: Uuid, columns: number, rows: number) =>
    invoke<void>("terminal_resize", { connectionId, columns, rows }),
  disconnectTerminal: (connectionId: Uuid) =>
    invoke<void>("disconnect_terminal", { connectionId }),

  connectSftp: (sessionId: Uuid) =>
    invoke<SftpConnectResponse>("connect_sftp", { sessionId }),
  configureSftpTransfers: (policy: SftpTransferPolicy) =>
    invoke<SftpTransferPolicy>("configure_sftp_transfers", { policy }),
  disconnectSftp: (connectionId: Uuid) =>
    invoke<void>("disconnect_sftp", { connectionId }),
  releaseSftpConnection: (connectionId: Uuid) =>
    invoke<void>("release_sftp_connection", { connectionId }),
  listTransfers: () => invoke<TransferListSnapshot>("list_transfers"),
  pauseTransfer: (transferId: Uuid) => invoke<TransferEvent>("pause_transfer", { transferId }),
  resumeTransfer: (transferId: Uuid) => invoke<TransferEvent>("resume_transfer", { transferId }),
  removeTransfer: (transferId: Uuid) => invoke<void>("remove_transfer", { transferId }),
  retryTransfer: (transferId: Uuid, onEvent: Channel<TransferEvent> = new Channel<TransferEvent>()) =>
    invoke<Uuid>("retry_transfer", { transferId, onEvent }),
  sftpCanonicalize: (connectionId: Uuid, path: string) =>
    invoke<string>("sftp_canonicalize", { connectionId, path }),
  sftpListDirectory: (connectionId: Uuid, path: string) =>
    invoke<RemoteEntry[]>("sftp_list_directory", { connectionId, path }),
  listLocalSyncEntries: (rootPath: string, excludePatterns: string[]) =>
    invoke<LocalSyncEntry[]>("list_local_sync_entries", { rootPath, excludePatterns }),
  sftpStat: (connectionId: Uuid, path: string) =>
    invoke<RemoteEntry>("sftp_stat", { connectionId, path }),
  localFileInfo: (path: string) => invoke<RemoteEntry | null>("local_file_info", { path }),
  listLocalDirectory: (path: string) => invoke<RemoteEntry[]>("list_local_directory", { path }),
  localDownloadDirectory: () => invoke<string>("local_download_directory"),
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
    batchId?: Uuid,
  ) =>
    invoke<Uuid>("sftp_upload", {
      connectionId,
      localPath,
      remotePath,
      overwrite,
      onEvent,
      batchId,
    }),
  sftpDownload: (
    connectionId: Uuid,
    remotePath: string,
    localPath: string,
    overwrite: boolean,
    onEvent: Channel<TransferEvent>,
    batchId?: Uuid,
  ) =>
    invoke<Uuid>("sftp_download", {
      connectionId,
      remotePath,
      localPath,
      overwrite,
      onEvent,
      batchId,
    }),
  cancelTransfer: (transferId: Uuid) =>
    invoke<TransferEvent>("cancel_transfer", { transferId }),

  exportCredentialsBackup: (targetPath: string, password: string) =>
    invoke<void>("export_credentials_backup", { targetPath, password }),
  inspectCredentialsBackup: (sourcePath: string, password: string) =>
    invoke<BackupImportSummary>("inspect_credentials_backup", { sourcePath, password }),
  importCredentialsBackup: (sourcePath: string, password: string) =>
    invoke<BackupImportSummary>("import_credentials_backup", { sourcePath, password }),

  exportSessions: (targetPath: string, password: string, includeKnownHosts: boolean) =>
    invoke<void>("export_sessions", { targetPath, password, includeKnownHosts }),
  importSessions: (sourcePath: string, password: string) =>
    invoke<ImportSummary>("import_sessions", { sourcePath, password }),
  exportWorkspaces: (targetPath: string, password: string, payload: string) =>
    invoke<void>("export_workspaces", { targetPath, password, payload }),
  importWorkspaces: (sourcePath: string, password: string) =>
    invoke<string>("import_workspaces", { sourcePath, password }),
};
