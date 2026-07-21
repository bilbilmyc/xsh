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
}

export interface SshConfigEntry {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identityFile: string | null;
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

export type TerminalEvent =
  | { type: "stateChanged"; payload: ConnectionState }
  | { type: "output"; payload: number[] }
  | {
      type: "authChallenge";
      payload: {
        challengeId: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
      };
    }
  | {
      type: "hostKeyUnknown";
      payload: {
        host: string;
        port: number;
        keyType: string;
        fingerprint: string;
        publicKey: string;
      };
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


export type TransferStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface TransferEvent {
  transferId: Uuid;
  direction: "upload" | "download";
  localPath: string;
  remotePath: string;
  status: TransferStatus;
  transferredBytes: number;
  totalBytes: number | null;
  error: string | null;
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
  kind: "local" | "remote" | "dynamic";
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
}

export interface SshDiagnosticReport {
  target: EndpointDiagnostic;
  proxyJump: EndpointDiagnostic | null;
  usesProxyJump: boolean;
  ready: boolean;
}

export interface ImportSummary {
  groupsCreated: number;
  sessionsCreated: number;
}

export const defaultTerminalProfile = (): TerminalProfile => ({
  terminalType: "xterm-256color",
  encoding: "utf-8",
  scrollbackLines: 10_000,
  fontFamily: null,
  fontSize: 14,
  theme: "xsh-dark",
});
