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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: SessionId,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TerminalEvent {
    StateChanged(ConnectionState),
    Output(Vec<u8>),
    AuthChallenge {
        challenge_id: Uuid,
        prompts: Vec<AuthPrompt>,
    },
    HostKeyUnknown {
        host: String,
        port: u16,
        #[serde(rename = "keyType", alias = "key_type")]
        key_type: String,
        fingerprint: String,
        #[serde(rename = "publicKey", alias = "public_key")]
        public_key: String,
    },
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
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub transfer_id: TransferId,
    pub direction: TransferDirection,
    pub local_path: PathBuf,
    pub remote_path: String,
    pub status: TransferStatus,
    pub transferred_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
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
        let event = TerminalEvent::HostKeyUnknown {
            host: "example.com".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
            public_key: "ssh-ed25519 AAAA".into(),
        };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"hostKeyUnknown","payload":{"host":"example.com","port":22,"keyType":"ssh-ed25519","fingerprint":"SHA256:test","publicKey":"ssh-ed25519 AAAA"}}"#
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
    }
}
