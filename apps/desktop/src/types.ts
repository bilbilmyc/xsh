export type Uuid = string;

export interface SessionGroup {
  id: Uuid;
  parentId: Uuid | null;
  name: string;
  color: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type AuthenticationMethod =
  | { type: "password"; credentialRef: string | null }
  | {
      type: "privateKey";
      privateKeyPath: string;
      passphraseRef: string | null;
    }
  | { type: "keyboardInteractive"; credentialRef: string | null }
  | { type: "agent"; identityFingerprint: string | null };

export interface TerminalProfile {
  terminalType: string;
  encoding: string;
  scrollbackLines: number;
  fontFamily: string | null;
  fontSize: number;
  theme: string;
  triggers: TerminalTrigger[];
  keyMappings: TerminalKeyMapping[];
}

export type TerminalTriggerMatchMode = "keyword" | "regex";

export interface TerminalTrigger {
  id: Uuid;
  label: string;
  pattern: string;
  matchMode: TerminalTriggerMatchMode;
  caseSensitive: boolean;
  cooldownSeconds: number;
  enabled: boolean;
}

export interface TerminalKeyMapping {
  id: Uuid;
  shortcut: string;
  text: string;
  enabled: boolean;
}

export interface SshConfigEntry {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identityFile: string | null;
  identityFiles: string[];
  proxyJump: string | null;
  sourcePath: string;
}

export interface SshAgentKey {
  fingerprint: string;
  algorithm: string;
  comment: string;
  certificate: boolean;
}

export interface SshKeyDefaults {
  sshDirectory: string;
  defaultKeyPath: string | null;
}

export interface SavedSession {
  id: Uuid;
  groupId: Uuid | null;
  name: string;
  host: string;
  port: number;
  username: string;
  proxyJump: string | null;
  proxyJumpUsername: string | null;
  proxyJumpAuthentication: AuthenticationMethod | null;
  authentication: AuthenticationMethod;
  terminal: TerminalProfile;
  initialDirectory: string | null;
  startupCommand: string | null;
  keepaliveSeconds: number;
  autoReconnect: boolean;
  environment: string | null;
  color: string | null;
  notes: string | null;
  tags: string[];
  favorite: boolean;
  forwardProfiles: ForwardProfile[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionDraft {
  groupId: Uuid | null;
  name: string;
  host: string;
  port: number;
  username: string;
  proxyJump: string | null;
  proxyJumpUsername: string | null;
  proxyJumpAuthentication: AuthenticationMethod | null;
  authentication: AuthenticationMethod;
  terminal: TerminalProfile;
  initialDirectory: string | null;
  startupCommand: string | null;
  keepaliveSeconds: number;
  autoReconnect: boolean;
  environment: string | null;
  color: string | null;
  notes: string | null;
  tags: string[];
  favorite: boolean;
  forwardProfiles: ForwardProfile[];
}

export interface SessionGroupDraft {
  parentId: Uuid | null;
  name: string;
  color: string | null;
  sortOrder: number;
}

export type ConnectionState =
  | "connecting"
  | "awaitingHostKey"
  | "authenticating"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "failed"
  | { reconnecting: { attempt: number } };

export type HostKeyRole = "target" | "proxyJump";

export interface HostKeyApproval {
  role: HostKeyRole;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey: string;
}

export type SftpConnectResponse =
  | { status: "connected"; connectionId: Uuid }
  | { status: "hostKeyUnknown"; challenge: HostKeyApproval };

export interface SftpTransferPolicy {
  globalConcurrency: number;
  perHostConcurrency: number;
  uploadLimitBytesPerSecond: number;
  downloadLimitBytesPerSecond: number;
}

// Terminal output bytes no longer travel through this JSON event type: the
// backend sends them as raw binary over the IPC channel, so the webview
// receives an ArrayBuffer instead (see `TerminalEvent | ArrayBuffer`).
export type TerminalEvent =  | { type: "stateChanged"; payload: ConnectionState }
  | {
      type: "authChallenge";
      payload: {
        challengeId: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
      };
    }
  | {
      type: "hostKeyUnknown";
      payload: HostKeyApproval;
    }
  | {
      type: "hostKeyChanged";
      payload: {
        host: string;
        port: number;
        expectedFingerprint: string;
        presentedFingerprint: string;
      };
    }
  | { type: "exitStatus"; payload: number }
  | { type: "error"; payload: string };

/** Narrows the terminal IPC channel union without a blind cast; keeps the
 * `TerminalEvent | ArrayBuffer` contract honest if the union ever grows. */
export function isTerminalEvent(value: unknown): value is TerminalEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

export type RemoteFileType = "directory" | "file" | "symlink" | "other";

export interface RemoteEntry {
  name: string;
  path: string;
  fileType: RemoteFileType;
  size: number;
  modifiedAtUnix: number | null;
  permissions: number | null;
  owner: string | null;
  group: string | null;
}

export interface LocalSyncEntry {
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
  size: number;
  modifiedAtUnix: number | null;
}


export type TransferStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type TransferWaitingReason =
  | "globalConcurrency"
  | "perHostConcurrency"
  | "queueOrder"
  | "userPaused";

export interface TransferEvent {
  transferId: Uuid;
  connectionId: Uuid;
  endpoint: string;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  status: TransferStatus;
  transferredBytes: number;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  error: string | null;
  submissionSequence: number;
  queuePosition: number | null;
  waitingReason: TransferWaitingReason | null;
}

export interface TransferRuntimeSummary {
  occupiedSlots: number;
  globalLimit: number;
  running: number;
  queued: number;
  paused: number;
  cancelling: number;
  aggregateUploadBytesPerSecond: number;
  aggregateDownloadBytesPerSecond: number;
}

export interface TransferListSnapshot {
  transfers: TransferEvent[];
  summary: TransferRuntimeSummary;
}

export interface KnownHost {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  publicKey: string;
  firstSeen: string;
  lastSeen: string;
}

export interface EndpointDiagnostic {
  host: string;
  port: number;
  addresses: string[];
  dnsError: string | null;
  tcpReachable: boolean | null;
  tcpError: string | null;
  issue: EndpointDiagnosticIssue | null;
  suggestion: string | null;
  elapsedMs: number;
}

export type EndpointDiagnosticIssue =
  | "dnsResolutionFailed"
  | "dnsNoAddresses"
  | "connectionTimedOut"
  | "connectionRefused"
  | "networkUnreachable"
  | "connectionReset"
  | "tcpConnectionFailed";

export interface ForwardInfo {
  forwardId: Uuid;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
  profileId: Uuid | null;
}

export interface LocalPortDiagnostic {
  status: "available" | "occupied" | "unavailable";
  detail: string;
}

export interface ForwardHealth {
  forwardId: Uuid;
  status: "running" | "unknown" | "stopped";
  detail: string;
}

export type ForwardKind = "local" | "remote" | "dynamic";

export interface ForwardProfile {
  id: Uuid;
  name: string;
  group: string | null;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
  autoStart: boolean;
}

export interface SshDiagnosticReport {
  target: EndpointDiagnostic;
  proxyJump: EndpointDiagnostic | null;
  usesProxyJump: boolean;
  ready: boolean;
}

export interface BackupImportSummary {
  imported: number;
  overwritten: number;
}

export interface ImportSummary {
  groupsCreated: number;
  sessionsCreated: number;
  credentialsImported: number;
  credentialsOverwritten: number;
}

export const defaultTerminalProfile = (): TerminalProfile => ({
  terminalType: "xterm-256color",
  encoding: "utf-8",
  scrollbackLines: 10_000,
  fontFamily: null,
  fontSize: 14,
  theme: "xsh-dark",
  triggers: [],
  keyMappings: [],
});
