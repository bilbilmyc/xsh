use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

pub type GroupId = Uuid;
pub type SessionId = Uuid;
pub type ConnectionId = Uuid;
pub type TransferId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: GroupId,
    pub parent_id: Option<GroupId>,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupDraft {
    pub parent_id: Option<GroupId>,
    pub name: String,
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthenticationMethod {
    Password {
        #[serde(rename = "credentialRef", alias = "credential_ref")]
        credential_ref: Option<String>,
    },
    PrivateKey {
        #[serde(rename = "privateKeyPath", alias = "private_key_path")]
        private_key_path: PathBuf,
        #[serde(rename = "passphraseRef", alias = "passphrase_ref")]
        passphrase_ref: Option<String>,
    },
    KeyboardInteractive {
        #[serde(rename = "credentialRef", alias = "credential_ref")]
        credential_ref: Option<String>,
    },
    /// Use an identity exposed by the local SSH agent (SSH_AUTH_SOCK,
    /// Pageant, or the Windows OpenSSH agent).
    Agent {
        #[serde(rename = "identityFingerprint", alias = "identity_fingerprint")]
        identity_fingerprint: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub terminal_type: String,
    pub encoding: String,
    pub scrollback_lines: u32,
    pub font_family: Option<String>,
    pub font_size: u16,
    pub theme: String,
    /// Match terminal output locally. Triggers never execute commands.
    #[serde(default)]
    pub triggers: Vec<TerminalTrigger>,
    /// Per-session key sequences sent directly to the terminal input stream.
    #[serde(default)]
    pub key_mappings: Vec<TerminalKeyMapping>,
}

impl Default for TerminalProfile {
    fn default() -> Self {
        Self {
            terminal_type: "xterm-256color".into(),
            encoding: "utf-8".into(),
            scrollback_lines: 10_000,
            font_family: None,
            font_size: 14,
            theme: "xsh-dark".into(),
            triggers: Vec::new(),
            key_mappings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TerminalTriggerMatchMode {
    #[default]
    Keyword,
    Regex,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTrigger {
    pub id: Uuid,
    pub label: String,
    pub pattern: String,
    #[serde(default)]
    pub match_mode: TerminalTriggerMatchMode,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_trigger_cooldown_seconds")]
    pub cooldown_seconds: u16,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

const fn default_trigger_cooldown_seconds() -> u16 {
    30
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKeyMapping {
    pub id: Uuid,
    /// For example, `F5` or `Ctrl+Alt+K`.
    pub shortcut: String,
    /// Printable text and the common `\\r`, `\\n`, `\\t`, and `\\e` escapes are
    /// decoded only while this mapping is sent.
    pub text: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardProfile {
    /// Stable within a session so the UI can edit and reconcile profiles
    /// independently of the runtime SSH forward id.
    pub id: Uuid,
    pub name: String,
    /// Optional local-only organization label for a session's tunnel profiles.
    #[serde(default)]
    pub group: Option<String>,
    pub kind: ForwardKind,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub target_host: Option<String>,
    #[serde(default)]
    pub target_port: Option<u16>,
    #[serde(default)]
    pub auto_start: bool,
}

/// What a saved session primarily connects to. Remote-desktop sessions use
/// the SSH server only as the encrypted transport for a VNC/RDP tunnel.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    #[default]
    Ssh,
    RemoteDesktop,
}

/// Remote-desktop protocol tunneled over an SSH local forward.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteDesktopKind {
    Vnc,
    Rdp,
}

impl RemoteDesktopKind {
    /// Port the protocol listens on by default on the SSH server side.
    pub fn default_target_port(self) -> u16 {
        match self {
            Self::Vnc => 5900,
            Self::Rdp => 3389,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Vnc => "VNC",
            Self::Rdp => "RDP",
        }
    }
}

/// How the desktop viewer reaches the VNC/RDP service: directly over the
/// network like a plain VNC/RDP client, or through an encrypted SSH tunnel.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum RemoteDesktopTransport {
    Direct,
    /// Encrypted via an SSH local forward; the default for profiles created
    /// before the field existed.
    #[default]
    SshTunnel,
}

/// Per-session remote-desktop settings: how to reach the VNC/RDP service
/// (directly or over an SSH tunnel) plus how to open the local viewer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopProfile {
    pub kind: RemoteDesktopKind,
    /// Transport for the viewer connection. `SshTunnel` also drives the
    /// auto-start hook in `connect_terminal`.
    #[serde(default)]
    pub transport: RemoteDesktopTransport,
    /// Host of the VNC/RDP service: the address the viewer ultimately
    /// connects to (directly, or as seen from the SSH server in tunnel mode).
    #[serde(default = "default_remote_desktop_target_host")]
    pub target_host: String,
    /// `None` falls back to the protocol default port for the kind.
    #[serde(default)]
    pub target_port: Option<u16>,
    /// Start the tunnel automatically once the SSH connection is established.
    #[serde(default)]
    pub auto_start: bool,
    /// Also open the desktop viewer when the tunnel starts automatically.
    #[serde(default)]
    pub launch_viewer: bool,
    /// Optional viewer command template, e.g.
    /// `C:\Program Files\TigerVNC\vncviewer.exe {host}::{port}`. Platforms
    /// without a built-in viewer require this.
    #[serde(default)]
    pub viewer_command: Option<String>,
    /// Optional login user for the remote desktop (RDP account, or the VNC
    /// account on servers that ask for one).
    #[serde(default)]
    pub username: Option<String>,
    /// Opaque XSH credential-vault reference for the remote-desktop login
    /// password; resolved only at viewer-launch time.
    #[serde(default)]
    pub credential_ref: Option<String>,
    /// Stable id reused as the runtime forward id so reconnects reconcile
    /// the tunnel instead of stacking listeners.
    #[serde(default)]
    pub forward_profile_id: Option<Uuid>,
}

impl RemoteDesktopProfile {
    pub fn resolved_target_port(&self) -> u16 {
        self.target_port
            .filter(|port| *port > 0)
            .unwrap_or_else(|| self.kind.default_target_port())
    }

    /// The remote-desktop tunnel is a plain ephemeral local forward under the
    /// hood, which keeps reconciliation and health checks shared with
    /// user-managed port-forward profiles.
    pub fn forward_profile(&self) -> ForwardProfile {
        ForwardProfile {
            id: self.forward_profile_id.unwrap_or_else(Uuid::new_v4),
            name: format!("{} Remote Desktop", self.kind.label()),
            group: None,
            kind: ForwardKind::Local,
            bind_host: default_remote_desktop_target_host(),
            bind_port: 0,
            target_host: Some(self.target_host.clone()),
            target_port: Some(self.resolved_target_port()),
            auto_start: false,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.target_host.trim().is_empty() {
            return Err("远程桌面目标主机不能为空".into());
        }
        if let Some(port) = self.target_port
            && port == 0
        {
            return Err("远程桌面目标端口无效".into());
        }
        if let Some(command) = self.viewer_command.as_deref()
            && command.trim().is_empty()
        {
            return Err("远程桌面查看器命令不能为空白".into());
        }
        Ok(())
    }
}

fn default_remote_desktop_target_host() -> String {
    "127.0.0.1".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: SessionId,
    /// What this session primarily connects to; remote-desktop sessions ride
    /// an SSH connection as transport but present as VNC/RDP connections.
    #[serde(default)]
    pub kind: SessionKind,
    pub group_id: Option<GroupId>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Optional OpenSSH-style jump host, e.g. `bastion` or `ops@bastion:2222`.
    #[serde(default)]
    pub proxy_jump: Option<String>,
    /// Optional username override for the ProxyJump server.
    #[serde(default)]
    pub proxy_jump_username: Option<String>,
    /// Optional independent authentication for the ProxyJump server.
    /// When omitted, the target session authentication is reused for compatibility.
    #[serde(default)]
    pub proxy_jump_authentication: Option<AuthenticationMethod>,
    pub authentication: AuthenticationMethod,
    pub terminal: TerminalProfile,
    #[serde(default)]
    pub forward_profiles: Vec<ForwardProfile>,
    /// Optional VNC/RDP remote-desktop tunnel settings for this session.
    #[serde(default)]
    pub remote_desktop: Option<RemoteDesktopProfile>,
    pub initial_directory: Option<String>,
    /// Optional command sent once after the interactive shell is ready.
    #[serde(default)]
    pub startup_command: Option<String>,
    pub keepalive_seconds: u64,
    pub auto_reconnect: bool,
    pub environment: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDraft {
    #[serde(default)]
    pub kind: SessionKind,
    pub group_id: Option<GroupId>,
    pub name: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    /// Optional OpenSSH-style jump host, e.g. `bastion` or `ops@bastion:2222`.
    #[serde(default)]
    pub proxy_jump: Option<String>,
    /// Optional username override for the ProxyJump server.
    #[serde(default)]
    pub proxy_jump_username: Option<String>,
    /// Optional independent authentication for the ProxyJump server.
    /// When omitted, the target session authentication is reused for compatibility.
    #[serde(default)]
    pub proxy_jump_authentication: Option<AuthenticationMethod>,
    pub authentication: AuthenticationMethod,
    #[serde(default)]
    pub terminal: TerminalProfile,
    #[serde(default)]
    pub forward_profiles: Vec<ForwardProfile>,
    #[serde(default)]
    pub remote_desktop: Option<RemoteDesktopProfile>,
    pub initial_directory: Option<String>,
    /// Optional command sent once after the interactive shell is ready.
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default = "default_keepalive_seconds")]
    pub keepalive_seconds: u64,
    #[serde(default)]
    pub auto_reconnect: bool,
    pub environment: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
}

const fn default_ssh_port() -> u16 {
    22
}

const fn default_keepalive_seconds() -> u64 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
    pub first_seen: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBundle {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: DateTime<Utc>,
    pub groups: Vec<SessionGroup>,
    pub sessions: Vec<SavedSession>,
    #[serde(default)]
    pub known_hosts: Vec<KnownHost>,
}

impl SessionBundle {
    pub const FORMAT: &'static str = "xsh-session-bundle";
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn new(groups: Vec<SessionGroup>, sessions: Vec<SavedSession>) -> Self {
        Self {
            format: Self::FORMAT.into(),
            schema_version: Self::SCHEMA_VERSION,
            exported_at: Utc::now(),
            groups,
            sessions,
            known_hosts: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), BundleValidationError> {
        if self.format != Self::FORMAT {
            return Err(BundleValidationError::UnsupportedFormat(
                self.format.clone(),
            ));
        }
        if self.schema_version != Self::SCHEMA_VERSION {
            return Err(BundleValidationError::UnsupportedVersion(
                self.schema_version,
            ));
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BundleValidationError {
    #[error("unsupported bundle format: {0}")]
    UnsupportedFormat(String),
    #[error("unsupported bundle schema version: {0}")]
    UnsupportedVersion(u32),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connecting,
    AwaitingHostKey,
    Authenticating,
    Connected,
    Reconnecting { attempt: u32 },
    Disconnecting,
    Disconnected,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompt {
    pub prompt: String,
    pub echo: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyRole {
    Target,
    ProxyJump,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyApproval {
    pub role: HostKeyRole,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TerminalEvent {
    StateChanged(ConnectionState),
    Output(Vec<u8>),
    AuthChallenge {
        challenge_id: Uuid,
        prompts: Vec<AuthPrompt>,
    },
    HostKeyUnknown(HostKeyApproval),
    HostKeyChanged {
        host: String,
        port: u16,
        #[serde(rename = "expectedFingerprint", alias = "expected_fingerprint")]
        expected_fingerprint: String,
        #[serde(rename = "presentedFingerprint", alias = "presented_fingerprint")]
        presented_fingerprint: String,
    },
    ExitStatus(u32),
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteFileType {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub file_type: RemoteFileType,
    pub size: u64,
    pub modified_at_unix: Option<u64>,
    pub permissions: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferWaitingReason {
    GlobalConcurrency,
    PerHostConcurrency,
    QueueOrder,
    UserPaused,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SftpTransferPolicy {
    pub global_concurrency: u16,
    pub per_host_concurrency: u16,
    pub upload_limit_bytes_per_second: u64,
    pub download_limit_bytes_per_second: u64,
}

impl SftpTransferPolicy {
    pub const MAX_CONCURRENCY: u16 = 32;
    pub const MIN_LIMIT_BYTES_PER_SECOND: u64 = 1024;
    pub const MAX_LIMIT_BYTES_PER_SECOND: u64 = 1024 * 1024 * 1024;

    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=Self::MAX_CONCURRENCY).contains(&self.global_concurrency) {
            return Err("SFTP global concurrency must be between 1 and 32");
        }
        if self.per_host_concurrency == 0 || self.per_host_concurrency > self.global_concurrency {
            return Err("SFTP per-host concurrency must be between 1 and the global limit");
        }
        for limit in [
            self.upload_limit_bytes_per_second,
            self.download_limit_bytes_per_second,
        ] {
            if limit != 0
                && !(Self::MIN_LIMIT_BYTES_PER_SECOND..=Self::MAX_LIMIT_BYTES_PER_SECOND)
                    .contains(&limit)
            {
                return Err("SFTP bandwidth limits must be 0 or between 1 KiB/s and 1 GiB/s");
            }
        }
        Ok(())
    }
}

impl Default for SftpTransferPolicy {
    fn default() -> Self {
        Self {
            global_concurrency: 4,
            per_host_concurrency: 2,
            upload_limit_bytes_per_second: 0,
            download_limit_bytes_per_second: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub transfer_id: TransferId,
    pub connection_id: ConnectionId,
    #[serde(default)]
    pub session_id: Option<SessionId>,
    #[serde(default)]
    pub batch_id: Option<Uuid>,
    pub endpoint: String,
    pub direction: TransferDirection,
    pub local_path: PathBuf,
    pub remote_path: String,
    pub status: TransferStatus,
    pub transferred_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_second: Option<u64>,
    pub error: Option<String>,
    #[serde(default)]
    pub submission_sequence: u64,
    #[serde(default)]
    pub queue_position: Option<u32>,
    #[serde(default)]
    pub waiting_reason: Option<TransferWaitingReason>,
    #[serde(default)]
    pub retry_of: Option<TransferId>,
    #[serde(default)]
    pub retry_count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct TransferRuntimeSummary {
    pub occupied_slots: u16,
    pub global_limit: u16,
    pub running: u32,
    pub queued: u32,
    pub paused: u32,
    pub cancelling: u32,
    pub aggregate_upload_bytes_per_second: u64,
    pub aggregate_download_bytes_per_second: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct TransferListSnapshot {
    pub transfers: Vec<TransferEvent>,
    pub summary: TransferRuntimeSummary,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_rejects_unknown_version() {
        let mut bundle = SessionBundle::new(Vec::new(), Vec::new());
        bundle.schema_version = 99;
        assert_eq!(
            bundle.validate(),
            Err(BundleValidationError::UnsupportedVersion(99))
        );
    }

    #[test]
    fn authentication_serializes_nested_fields_as_camel_case() {
        let password = AuthenticationMethod::Password {
            credential_ref: Some("xsh/password/test".into()),
        };
        assert_eq!(
            serde_json::to_string(&password).unwrap(),
            r#"{"type":"password","credentialRef":"xsh/password/test"}"#
        );

        let private_key = AuthenticationMethod::PrivateKey {
            private_key_path: PathBuf::from("~/.ssh/id_ed25519"),
            passphrase_ref: Some("xsh/keyPassphrase/test".into()),
        };
        assert_eq!(
            serde_json::to_string(&private_key).unwrap(),
            r#"{"type":"privateKey","privateKeyPath":"~/.ssh/id_ed25519","passphraseRef":"xsh/keyPassphrase/test"}"#
        );
    }

    #[test]
    fn authentication_accepts_legacy_snake_case_fields() {
        let password: AuthenticationMethod =
            serde_json::from_str(r#"{"type":"password","credential_ref":"xsh/password/legacy"}"#)
                .unwrap();
        assert_eq!(
            password,
            AuthenticationMethod::Password {
                credential_ref: Some("xsh/password/legacy".into()),
            }
        );

        let private_key: AuthenticationMethod = serde_json::from_str(
            r#"{"type":"privateKey","private_key_path":"~/.ssh/id_ed25519","passphrase_ref":null}"#,
        )
        .unwrap();
        assert_eq!(
            private_key,
            AuthenticationMethod::PrivateKey {
                private_key_path: PathBuf::from("~/.ssh/id_ed25519"),
                passphrase_ref: None,
            }
        );
    }

    #[test]
    fn terminal_events_serialize_nested_fields_as_camel_case() {
        let event = TerminalEvent::HostKeyUnknown(HostKeyApproval {
            role: HostKeyRole::Target,
            host: "example.com".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
            public_key: "ssh-ed25519 AAAA".into(),
        });
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"hostKeyUnknown","payload":{"role":"target","host":"example.com","port":22,"keyType":"ssh-ed25519","fingerprint":"SHA256:test","publicKey":"ssh-ed25519 AAAA"}}"#
        );

        let proxy_unknown: TerminalEvent = serde_json::from_str(
            r#"{"type":"hostKeyUnknown","payload":{"role":"proxyJump","host":"jump.example.com","port":2222,"keyType":"ssh-ed25519","fingerprint":"SHA256:test","publicKey":"ssh-ed25519 AAAA"}}"#,
        )
        .unwrap();
        assert_eq!(
            proxy_unknown,
            TerminalEvent::HostKeyUnknown(HostKeyApproval {
                role: HostKeyRole::ProxyJump,
                host: "jump.example.com".into(),
                port: 2222,
                key_type: "ssh-ed25519".into(),
                fingerprint: "SHA256:test".into(),
                public_key: "ssh-ed25519 AAAA".into(),
            })
        );

        let changed: TerminalEvent = serde_json::from_str(
            r#"{"type":"hostKeyChanged","payload":{"host":"example.com","port":22,"expected_fingerprint":"SHA256:old","presented_fingerprint":"SHA256:new"}}"#,
        )
        .unwrap();
        assert_eq!(
            changed,
            TerminalEvent::HostKeyChanged {
                host: "example.com".into(),
                port: 22,
                expected_fingerprint: "SHA256:old".into(),
                presented_fingerprint: "SHA256:new".into(),
            }
        );
    }

    #[test]
    fn terminal_profile_has_safe_defaults() {
        let profile = TerminalProfile::default();
        assert_eq!(profile.terminal_type, "xterm-256color");
        assert_eq!(profile.encoding, "utf-8");
        assert!(profile.scrollback_lines >= 1_000);
        assert!(profile.triggers.is_empty());
        assert!(profile.key_mappings.is_empty());
    }

    #[test]
    fn legacy_terminal_profile_defaults_automation_fields() {
        let profile: TerminalProfile = serde_json::from_str(
            r#"{
                "terminalType": "xterm-256color",
                "encoding": "utf-8",
                "scrollbackLines": 10000,
                "fontFamily": null,
                "fontSize": 14,
                "theme": "xsh-dark"
            }"#,
        )
        .unwrap();
        assert!(profile.triggers.is_empty());
        assert!(profile.key_mappings.is_empty());
    }

    #[test]
    fn forward_profiles_use_camel_case_and_round_trip() {
        let profile = ForwardProfile {
            id: Uuid::from_u128(7),
            name: "Local API".into(),
            group: Some("Development".into()),
            kind: ForwardKind::Local,
            bind_host: "127.0.0.1".into(),
            bind_port: 18_080,
            target_host: Some("127.0.0.1".into()),
            target_port: Some(8_080),
            auto_start: true,
        };
        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(json["kind"], "local");
        assert_eq!(json["group"], "Development");
        assert_eq!(json["bindHost"], "127.0.0.1");
        assert_eq!(json["autoStart"], true);
        assert_eq!(
            serde_json::from_value::<ForwardProfile>(json).unwrap(),
            profile
        );
    }

    #[test]
    fn legacy_session_payload_defaults_forward_profiles_to_empty() {
        let draft: SessionDraft = serde_json::from_str(
            r#"{
                "groupId": null,
                "name": "legacy",
                "host": "example.com",
                "port": 22,
                "username": "ops",
                "authentication": {"type": "agent", "identityFingerprint": null},
                "initialDirectory": null,
                "keepaliveSeconds": 30,
                "autoReconnect": true,
                "environment": null,
                "color": null,
                "notes": null
            }"#,
        )
        .unwrap();
        assert!(draft.forward_profiles.is_empty());
        assert!(draft.remote_desktop.is_none());
        assert_eq!(draft.kind, SessionKind::Ssh);
        assert_eq!(draft.terminal, TerminalProfile::default());
    }

    #[test]
    fn session_kind_round_trips_and_legacy_defaults_to_ssh() {
        let json = serde_json::json!({
            "groupId": null,
            "kind": "remoteDesktop",
            "name": "rd",
            "host": "example.com",
            "port": 22,
            "username": "ops",
            "authentication": {"type": "agent", "identityFingerprint": null},
            "initialDirectory": null,
            "keepaliveSeconds": 30,
            "autoReconnect": true,
            "environment": null,
            "color": null,
            "notes": null,
            "remoteDesktop": {
                "kind": "rdp",
                "targetHost": "10.0.0.8",
                "targetPort": 3389,
                "autoStart": true,
                "launchViewer": true,
                "viewerCommand": null,
                "forwardProfileId": null
            }
        });
        let draft: SessionDraft = serde_json::from_value(json).unwrap();
        assert_eq!(draft.kind, SessionKind::RemoteDesktop);
        assert_eq!(draft.remote_desktop.unwrap().kind, RemoteDesktopKind::Rdp);

        let legacy: SessionDraft = serde_json::from_str(
            r#"{"name":"legacy","host":"h","port":22,"username":"u",
                "authentication":{"type":"agent","identityFingerprint":null},
                "keepaliveSeconds":30}"#,
        )
        .unwrap();
        assert_eq!(legacy.kind, SessionKind::Ssh);
        assert_eq!(
            serde_json::to_value(SessionKind::RemoteDesktop).unwrap(),
            serde_json::json!("remoteDesktop")
        );
    }

    #[test]
    fn remote_desktop_profile_defaults_and_round_trip() {
        let profile: RemoteDesktopProfile = serde_json::from_str(r#"{"kind":"vnc"}"#).unwrap();
        assert_eq!(profile.target_host, "127.0.0.1");
        // Profiles persisted before the field existed are SSH tunnels.
        assert_eq!(profile.transport, RemoteDesktopTransport::SshTunnel);
        assert_eq!(profile.resolved_target_port(), 5900);
        assert!(!profile.auto_start);
        assert!(!profile.launch_viewer);
        assert_eq!(profile.forward_profile_id, None);

        let direct: RemoteDesktopProfile = serde_json::from_str(
            r#"{"kind":"rdp","transport":"direct","targetPort":3390,"autoStart":true,"launchViewer":true,
                "viewerCommand":"remmina -c rdp://{host}:{port}",
                "forwardProfileId":"00000000-0000-0000-0000-000000000007"}"#,
        )
        .unwrap();
        assert_eq!(direct.transport, RemoteDesktopTransport::Direct);
        assert_eq!(direct.resolved_target_port(), 3390);
        assert_eq!(direct.forward_profile_id, Some(Uuid::from_u128(7)));

        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(json["kind"], "vnc");
        assert_eq!(json["transport"], "sshTunnel");
        assert_eq!(json["targetHost"], "127.0.0.1");
        assert_eq!(
            serde_json::from_value::<RemoteDesktopProfile>(json).unwrap(),
            profile
        );
    }

    #[test]
    fn remote_desktop_forward_profile_is_ephemeral_local_tunnel() {
        let profile = RemoteDesktopProfile {
            kind: RemoteDesktopKind::Rdp,
            transport: RemoteDesktopTransport::SshTunnel,
            target_host: "10.0.0.8".into(),
            target_port: None,
            auto_start: false,
            launch_viewer: false,
            viewer_command: None,
            username: None,
            credential_ref: None,
            forward_profile_id: Some(Uuid::from_u128(42)),
        };
        let forward = profile.forward_profile();
        assert_eq!(forward.id, Uuid::from_u128(42));
        assert_eq!(forward.kind, ForwardKind::Local);
        assert_eq!(forward.bind_host, "127.0.0.1");
        assert_eq!(forward.bind_port, 0);
        assert_eq!(forward.target_host.as_deref(), Some("10.0.0.8"));
        assert_eq!(forward.target_port, Some(3389));
        assert!(!forward.auto_start);

        let minimal: RemoteDesktopProfile = serde_json::from_str(r#"{"kind":"vnc"}"#).unwrap();
        assert!(minimal.validate().is_ok());
        let mut invalid = minimal.clone();
        invalid.target_host = "  ".into();
        assert!(invalid.validate().is_err());
        let mut zero_port = minimal;
        zero_port.target_port = Some(0);
        assert!(zero_port.validate().is_err());
    }

    #[test]
    fn sftp_transfer_policy_defaults_validate_and_use_camel_case() {
        let policy: SftpTransferPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(policy, SftpTransferPolicy::default());
        assert!(policy.validate().is_ok());
        assert_eq!(
            serde_json::to_string(&policy).unwrap(),
            r#"{"globalConcurrency":4,"perHostConcurrency":2,"uploadLimitBytesPerSecond":0,"downloadLimitBytesPerSecond":0}"#
        );

        let mut invalid = policy;
        invalid.per_host_concurrency = invalid.global_concurrency + 1;
        assert!(invalid.validate().is_err());
        invalid = policy;
        invalid.upload_limit_bytes_per_second = 1;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn transfer_waiting_reasons_serialize_as_camel_case() {
        let reasons = [
            TransferWaitingReason::GlobalConcurrency,
            TransferWaitingReason::PerHostConcurrency,
            TransferWaitingReason::QueueOrder,
            TransferWaitingReason::UserPaused,
        ];

        assert_eq!(
            serde_json::to_string(&reasons).unwrap(),
            r#"["globalConcurrency","perHostConcurrency","queueOrder","userPaused"]"#
        );
    }

    #[test]
    fn transfer_event_new_queue_fields_default_for_legacy_payloads() {
        let event: TransferEvent = serde_json::from_str(
            r#"{
                "transferId":"00000000-0000-0000-0000-000000000001",
                "connectionId":"00000000-0000-0000-0000-000000000002",
                "endpoint":"example.com:22",
                "direction":"download",
                "localPath":"download.bin",
                "remotePath":"/tmp/download.bin",
                "status":"queued",
                "transferredBytes":0,
                "totalBytes":1024,
                "speedBytesPerSecond":null,
                "error":null
            }"#,
        )
        .unwrap();

        assert_eq!(event.submission_sequence, 0);
        assert_eq!(event.queue_position, None);
        assert_eq!(event.waiting_reason, None);

        let serialized = serde_json::to_value(event).unwrap();
        assert_eq!(serialized["submissionSequence"], 0);
        assert_eq!(serialized["queuePosition"], serde_json::Value::Null);
        assert_eq!(serialized["waitingReason"], serde_json::Value::Null);
    }

    #[test]
    fn transfer_snapshot_defaults_and_serializes_as_camel_case() {
        let snapshot: TransferListSnapshot = serde_json::from_str("{}").unwrap();
        assert_eq!(snapshot, TransferListSnapshot::default());
        assert!(snapshot.transfers.is_empty());
        assert_eq!(snapshot.summary, TransferRuntimeSummary::default());
        assert_eq!(
            serde_json::to_string(&snapshot).unwrap(),
            r#"{"transfers":[],"summary":{"occupiedSlots":0,"globalLimit":0,"running":0,"queued":0,"paused":0,"cancelling":0,"aggregateUploadBytesPerSecond":0,"aggregateDownloadBytesPerSecond":0}}"#
        );
    }
}
