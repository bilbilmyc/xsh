use anyhow::{Context, bail};
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, load_secret_key};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc, watch};
use uuid::Uuid;
use xsh_domain::{
    ConnectionId, KnownHost, RemoteEntry, RemoteFileType, TransferDirection, TransferEvent,
    TransferId, TransferStatus,
};
use xsh_ssh::RuntimeAuthentication;
use xsh_ssh::config::resolve_proxy_jump;

#[derive(Debug)]
pub struct SftpConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub proxy_jump: Option<String>,
    pub proxy_jump_username: Option<String>,
    pub proxy_jump_authentication: Option<RuntimeAuthentication>,
    pub authentication: RuntimeAuthentication,
    pub known_host: Option<KnownHost>,
    pub proxy_jump_known_host: Option<KnownHost>,
    pub trust_unknown_host: bool,
}

#[derive(Debug, Clone)]
pub struct SftpPresentedHostKey {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug)]
pub struct SftpConnectResult {
    pub connection_id: ConnectionId,
    pub trusted_host_keys: Vec<SftpPresentedHostKey>,
}

#[derive(Debug)]
pub struct TransferSubscription {
    pub transfer_id: TransferId,
    pub events: mpsc::Receiver<TransferEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum SftpManagerError {
    #[error("SFTP connection not found: {0}")]
    ConnectionNotFound(ConnectionId),
    #[error("transfer not found: {0}")]
    TransferNotFound(TransferId),
    #[error("SFTP operation failed: {0}")]
    Operation(#[from] anyhow::Error),
}

const DOWNLOAD_RESUME_METADATA_VERSION: u8 = 2;
const UPLOAD_RESUME_METADATA_VERSION: u8 = 1;
const TRANSFER_EVENT_CAPACITY: usize = 16;
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
const RESUME_VERIFICATION_BLOCK_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct UploadResumeMetadata {
    version: u8,
    local_path: String,
    remote_path: String,
    total_bytes: u64,
    modified_at_unix_nanos: Option<u128>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DownloadResumeMetadata {
    version: u8,
    remote_path: String,
    total_bytes: u64,
    modified_at_unix: Option<u32>,
    #[serde(default)]
    source_identity: String,
}

struct DownloadFileRequest<'a> {
    remote_path: &'a str,
    local_path: &'a Path,
    overwrite: bool,
    total_bytes: u64,
    modified_at_unix: Option<u32>,
    source_identity: &'a str,
}

#[derive(Clone)]
struct TerminalTransferContext {
    transfer_id: TransferId,
    direction: TransferDirection,
    local_path: PathBuf,
    remote_path: String,
    total_bytes: u64,
}

impl TerminalTransferContext {
    fn event(
        &self,
        status: TransferStatus,
        transferred_bytes: u64,
        speed_bytes_per_second: Option<u64>,
        error: Option<String>,
    ) -> TransferEvent {
        TransferEvent {
            transfer_id: self.transfer_id,
            direction: self.direction.clone(),
            local_path: self.local_path.clone(),
            remote_path: self.remote_path.clone(),
            status,
            transferred_bytes,
            total_bytes: Some(self.total_bytes),
            speed_bytes_per_second,
            error,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferControl {
    Running,
    Paused,
    Cancelled,
}

struct ManagedTransfer {
    connection_id: ConnectionId,
    control: watch::Sender<TransferControl>,
    snapshot: Arc<StdMutex<TransferEvent>>,
}

fn update_transfer_snapshot(snapshot: &StdMutex<TransferEvent>, event: TransferEvent) {
    if let Ok(mut current) = snapshot.lock() {
        *current = event;
    }
}

struct TransferProgressReporter {
    events: mpsc::Sender<TransferEvent>,
    context: TerminalTransferContext,
    snapshot: Arc<StdMutex<TransferEvent>>,
    last_speed_sample: Instant,
    last_speed_bytes: u64,
    last_sent_at: Option<Instant>,
}

impl TransferProgressReporter {
    fn new(
        events: mpsc::Sender<TransferEvent>,
        context: TerminalTransferContext,
        snapshot: Arc<StdMutex<TransferEvent>>,
    ) -> Self {
        Self {
            events,
            context,
            snapshot,
            last_speed_sample: Instant::now(),
            last_speed_bytes: 0,
            last_sent_at: None,
        }
    }

    fn report(&mut self, transferred_bytes: u64) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_speed_sample);
        let speed_bytes_per_second = if elapsed.is_zero() {
            None
        } else {
            let bytes = transferred_bytes.saturating_sub(self.last_speed_bytes);
            Some((bytes as f64 / elapsed.as_secs_f64()) as u64)
        };
        self.last_speed_sample = now;
        self.last_speed_bytes = transferred_bytes;
        let event = self.context.event(
            TransferStatus::Running,
            transferred_bytes,
            speed_bytes_per_second,
            None,
        );
        update_transfer_snapshot(&self.snapshot, event.clone());
        if self
            .last_sent_at
            .is_some_and(|last_sent| now.duration_since(last_sent) < TRANSFER_PROGRESS_INTERVAL)
        {
            return;
        }
        self.last_sent_at = Some(now);
        let _ = self.events.try_send(event);
    }
}

struct SftpHostKeyHandler {
    host: String,
    port: u16,
    known_host: Option<KnownHost>,
    trust_unknown_host: bool,
    trusted_host_key: Arc<Mutex<Option<SftpPresentedHostKey>>>,
}

impl client::Handler for SftpHostKeyHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = server_public_key
            .to_openssh()
            .context("could not encode SFTP server key")?;
        let key_type = server_public_key.algorithm().as_str().to_owned();
        match &self.known_host {
            Some(known) if known.fingerprint == fingerprint && known.public_key == public_key => {
                Ok(true)
            }
            Some(known) => bail!(
                "SFTP Host Key 已变化：{}:{} 期望 {}，实际 {}",
                self.host,
                self.port,
                known.fingerprint,
                fingerprint
            ),
            None if self.trust_unknown_host => {
                *self.trusted_host_key.lock().await = Some(SftpPresentedHostKey {
                    host: self.host.clone(),
                    port: self.port,
                    key_type,
                    fingerprint,
                    public_key,
                });
                Ok(true)
            }
            None => bail!(
                "SFTP Host Key 未确认：{}:{}（{}，{}）。请先在终端连接并确认，或重试时选择信任。",
                self.host,
                self.port,
                key_type,
                fingerprint
            ),
        }
    }
}

async fn authenticate_password_fallback(
    session: &mut client::Handle<SftpHostKeyHandler>,
    username: &str,
    password: &str,
) -> anyhow::Result<bool> {
    let password_result = session
        .authenticate_password(username.to_owned(), password.to_owned())
        .await
        .context("SFTP password authentication exchange failed")?;
    if password_result.success() {
        return Ok(true);
    }

    let mut response = session
        .authenticate_keyboard_interactive_start(username.to_owned(), None)
        .await
        .context("SFTP keyboard-interactive authentication exchange failed")?;

    for _ in 0..8 {
        response = match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let responses = prompts
                    .into_iter()
                    .map(|prompt| {
                        if prompt.echo {
                            String::new()
                        } else {
                            password.to_owned()
                        }
                    })
                    .collect();
                session
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .context("SFTP keyboard-interactive authentication exchange failed")?
            }
        };
    }

    bail!("SFTP keyboard-interactive authentication exceeded the prompt limit")
}

async fn authenticate_sftp_session(
    session: &mut client::Handle<SftpHostKeyHandler>,
    username: &str,
    authentication: RuntimeAuthentication,
) -> anyhow::Result<bool> {
    match authentication {
        RuntimeAuthentication::Password(password) => {
            authenticate_password_fallback(session, username, password.as_str()).await
        }
        RuntimeAuthentication::PrivateKey {
            private_key_path,
            passphrase,
        } => {
            let key = load_secret_key(
                &private_key_path,
                passphrase.as_ref().map(|value| value.as_str()),
            )
            .context("无法读取或解密 OpenSSH 私钥")?;
            let hash_algorithm = session
                .best_supported_rsa_hash()
                .await
                .context("failed to negotiate RSA signature algorithm")?
                .flatten();
            Ok(session
                .authenticate_publickey(
                    username.to_owned(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_algorithm),
                )
                .await
                .context("SFTP public-key authentication failed")?
                .success())
        }
        RuntimeAuthentication::Agent {
            identity_fingerprint,
        } => {
            xsh_ssh::authenticate_with_agent(session, username, identity_fingerprint.as_deref())
                .await
        }
    }
}

struct ActiveSftpConnection {
    sftp: Arc<SftpSession>,
    download_source_identity: String,
    _ssh: client::Handle<SftpHostKeyHandler>,
    _proxy_ssh: Option<client::Handle<SftpHostKeyHandler>>,
}

#[derive(Default)]
struct SftpManagerInner {
    connections: Mutex<HashMap<ConnectionId, ActiveSftpConnection>>,
    transfers: Mutex<HashMap<TransferId, ManagedTransfer>>,
    released_connections: Mutex<HashSet<ConnectionId>>,
}

#[derive(Clone, Default)]
pub struct SftpManager {
    inner: Arc<SftpManagerInner>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn connect(
        &self,
        options: SftpConnectOptions,
    ) -> Result<SftpConnectResult, SftpManagerError> {
        let target_trusted_host_key = Arc::new(Mutex::new(None));
        let target_handler = SftpHostKeyHandler {
            host: options.host.clone(),
            port: options.port,
            known_host: options.known_host.clone(),
            trust_unknown_host: options.trust_unknown_host,
            trusted_host_key: Arc::clone(&target_trusted_host_key),
        };
        let proxy_target = options
            .proxy_jump
            .as_deref()
            .map(resolve_proxy_jump)
            .transpose()
            .map_err(SftpManagerError::Operation)?
            .flatten();
        let mut proxy_ssh = None;
        let mut proxy_trusted_host_key = None;
        let mut ssh = if let Some(proxy) = proxy_target {
            let trusted_host_key = Arc::new(Mutex::new(None));
            proxy_trusted_host_key = Some(Arc::clone(&trusted_host_key));
            let proxy_handler = SftpHostKeyHandler {
                host: proxy.host.clone(),
                port: proxy.port,
                known_host: options.proxy_jump_known_host.clone(),
                trust_unknown_host: options.trust_unknown_host,
                trusted_host_key,
            };
            let mut jump = client::connect(
                Arc::new(sftp_client_config()),
                (proxy.host.as_str(), proxy.port),
                proxy_handler,
            )
            .await
            .with_context(|| {
                format!(
                    "failed to connect to SFTP ProxyJump {}:{}",
                    proxy.host, proxy.port
                )
            })?;
            let proxy_username = options
                .proxy_jump_username
                .as_deref()
                .or(proxy.username.as_deref())
                .unwrap_or(&options.username);
            let proxy_authentication = options
                .proxy_jump_authentication
                .clone()
                .unwrap_or_else(|| options.authentication.clone());
            let authenticated =
                authenticate_sftp_session(&mut jump, proxy_username, proxy_authentication)
                    .await
                    .context("SFTP ProxyJump authentication failed")?;
            if !authenticated {
                return Err(SftpManagerError::Operation(anyhow::anyhow!(
                    "the SFTP ProxyJump server rejected authentication"
                )));
            }
            let channel = jump
                .channel_open_direct_tcpip(
                    options.host.clone(),
                    options.port.into(),
                    "127.0.0.1",
                    0,
                )
                .await
                .with_context(|| {
                    format!(
                        "SFTP ProxyJump could not open {}:{} through {}:{}",
                        options.host, options.port, proxy.host, proxy.port
                    )
                })?;
            proxy_ssh = Some(jump);
            client::connect_stream(
                Arc::new(sftp_client_config()),
                channel.into_stream(),
                target_handler,
            )
            .await
            .with_context(|| {
                format!(
                    "failed to connect to SFTP target {}:{} through ProxyJump",
                    options.host, options.port
                )
            })?
        } else {
            client::connect(
                Arc::new(sftp_client_config()),
                (options.host.as_str(), options.port),
                target_handler,
            )
            .await
            .with_context(|| format!("failed to connect to {}:{}", options.host, options.port))?
        };

        let authenticated =
            authenticate_sftp_session(&mut ssh, &options.username, options.authentication).await?;
        if !authenticated {
            return Err(SftpManagerError::Operation(anyhow::anyhow!(
                "the server rejected SFTP authentication"
            )));
        }

        let channel = ssh
            .channel_open_session()
            .await
            .context("failed to open SFTP channel")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("the server rejected the SFTP subsystem")?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("failed to initialize the SFTP protocol")?;
        sftp.set_timeout(30);

        let known_host_fingerprint = options
            .known_host
            .as_ref()
            .map(|known_host| known_host.fingerprint.clone());
        let presented_target_key = target_trusted_host_key.lock().await.take();
        let target_fingerprint = presented_target_key
            .as_ref()
            .map(|key| key.fingerprint.as_str())
            .or(known_host_fingerprint.as_deref())
            .unwrap_or("unverified");
        let download_source_identity =
            format!("{}:{}:{target_fingerprint}", options.host, options.port);
        let connection_id = Uuid::new_v4();
        self.inner.connections.lock().await.insert(
            connection_id,
            ActiveSftpConnection {
                sftp: Arc::new(sftp),
                download_source_identity,
                _ssh: ssh,
                _proxy_ssh: proxy_ssh,
            },
        );
        let mut trusted_host_keys = Vec::new();
        if let Some(key) = presented_target_key {
            trusted_host_keys.push(key);
        }
        if let Some(value) = proxy_trusted_host_key
            && let Some(key) = value.lock().await.take()
        {
            trusted_host_keys.push(key);
        }
        Ok(SftpConnectResult {
            connection_id,
            trusted_host_keys,
        })
    }

    pub async fn disconnect(&self, connection_id: ConnectionId) -> Result<(), SftpManagerError> {
        self.inner
            .released_connections
            .lock()
            .await
            .remove(&connection_id);
        self.close_connection(connection_id).await
    }

    pub async fn release_connection(
        &self,
        connection_id: ConnectionId,
    ) -> Result<(), SftpManagerError> {
        let has_active_transfers = self
            .inner
            .transfers
            .lock()
            .await
            .values()
            .filter(|transfer| transfer.connection_id == connection_id)
            .any(|transfer| {
                transfer
                    .snapshot
                    .lock()
                    .map(|snapshot| transfer_is_active(&snapshot.status))
                    .unwrap_or(false)
            });
        if has_active_transfers {
            self.inner
                .released_connections
                .lock()
                .await
                .insert(connection_id);
            return Ok(());
        }
        self.close_connection(connection_id).await
    }

    pub async fn list_transfers(&self) -> Vec<TransferEvent> {
        let transfers = self.inner.transfers.lock().await;
        let mut snapshots = transfers
            .values()
            .filter_map(|transfer| {
                transfer
                    .snapshot
                    .lock()
                    .ok()
                    .map(|snapshot| snapshot.clone())
            })
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|transfer| transfer.transfer_id);
        snapshots
    }

    pub async fn pause_transfer(
        &self,
        transfer_id: TransferId,
    ) -> Result<TransferEvent, SftpManagerError> {
        self.update_transfer_control(transfer_id, TransferControl::Paused)
            .await
    }

    pub async fn resume_transfer(
        &self,
        transfer_id: TransferId,
    ) -> Result<TransferEvent, SftpManagerError> {
        self.update_transfer_control(transfer_id, TransferControl::Running)
            .await
    }

    pub async fn cancel_transfer(
        &self,
        transfer_id: TransferId,
    ) -> Result<TransferEvent, SftpManagerError> {
        self.update_transfer_control(transfer_id, TransferControl::Cancelled)
            .await
    }

    pub async fn remove_transfer(&self, transfer_id: TransferId) -> Result<(), SftpManagerError> {
        let connection_id = {
            let mut transfers = self.inner.transfers.lock().await;
            let transfer = transfers
                .get(&transfer_id)
                .ok_or(SftpManagerError::TransferNotFound(transfer_id))?;
            let is_active = transfer
                .snapshot
                .lock()
                .map(|snapshot| transfer_is_active(&snapshot.status))
                .unwrap_or(true);
            if is_active {
                return Err(SftpManagerError::Operation(anyhow::anyhow!(
                    "cannot remove an active transfer"
                )));
            }
            transfers
                .remove(&transfer_id)
                .map(|transfer| transfer.connection_id)
        };
        if let Some(connection_id) = connection_id {
            self.close_released_connection_if_idle(connection_id)
                .await?;
        }
        Ok(())
    }

    async fn update_transfer_control(
        &self,
        transfer_id: TransferId,
        control: TransferControl,
    ) -> Result<TransferEvent, SftpManagerError> {
        let transfers = self.inner.transfers.lock().await;
        let transfer = transfers
            .get(&transfer_id)
            .ok_or(SftpManagerError::TransferNotFound(transfer_id))?;
        let mut snapshot = transfer.snapshot.lock().map_err(|_| {
            SftpManagerError::Operation(anyhow::anyhow!("transfer state lock poisoned"))
        })?;
        if !transfer_is_active(&snapshot.status) {
            return Ok(snapshot.clone());
        }
        match control {
            TransferControl::Running => {
                if snapshot.status == TransferStatus::Paused {
                    snapshot.status = TransferStatus::Running;
                    snapshot.speed_bytes_per_second = None;
                }
            }
            TransferControl::Paused => {
                if snapshot.status == TransferStatus::Running
                    || snapshot.status == TransferStatus::Queued
                {
                    snapshot.status = TransferStatus::Paused;
                    snapshot.speed_bytes_per_second = Some(0);
                }
            }
            TransferControl::Cancelled => {
                snapshot.status = TransferStatus::Cancelled;
                snapshot.speed_bytes_per_second = Some(0);
            }
        }
        let event = snapshot.clone();
        transfer
            .control
            .send(control)
            .map_err(|error| SftpManagerError::Operation(anyhow::anyhow!(error.to_string())))?;
        Ok(event)
    }

    async fn close_connection(&self, connection_id: ConnectionId) -> Result<(), SftpManagerError> {
        let connection = self
            .inner
            .connections
            .lock()
            .await
            .remove(&connection_id)
            .ok_or(SftpManagerError::ConnectionNotFound(connection_id))?;
        connection
            .sftp
            .close()
            .await
            .context("failed to close SFTP session")?;
        Ok(())
    }

    async fn close_released_connection_if_idle(
        &self,
        connection_id: ConnectionId,
    ) -> Result<(), SftpManagerError> {
        let has_active_transfers = self
            .inner
            .transfers
            .lock()
            .await
            .values()
            .filter(|transfer| transfer.connection_id == connection_id)
            .any(|transfer| {
                transfer
                    .snapshot
                    .lock()
                    .map(|snapshot| transfer_is_active(&snapshot.status))
                    .unwrap_or(false)
            });
        if has_active_transfers {
            return Ok(());
        }
        if self
            .inner
            .released_connections
            .lock()
            .await
            .remove(&connection_id)
        {
            self.close_connection(connection_id).await?;
        }
        Ok(())
    }

    pub async fn canonicalize(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<String, SftpManagerError> {
        self.session(connection_id)
            .await?
            .canonicalize(path)
            .await
            .context("failed to canonicalize remote path")
            .map_err(Into::into)
    }

    pub async fn list_directory(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<Vec<RemoteEntry>, SftpManagerError> {
        let session = self.session(connection_id).await?;
        let mut entries = session
            .read_dir(path)
            .await
            .context("failed to read remote directory")?
            .map(|entry| {
                let metadata = entry.metadata();
                RemoteEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    file_type: map_file_type(entry.file_type()),
                    size: metadata.len(),
                    modified_at_unix: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions,
                    owner: metadata.user,
                    group: metadata.group,
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            entry_rank(&left.file_type)
                .cmp(&entry_rank(&right.file_type))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn stat(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<RemoteEntry, SftpManagerError> {
        let session = self.session(connection_id).await?;
        let metadata = session
            .metadata(path.clone())
            .await
            .context("failed to read remote metadata")?;
        let name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or(&path)
            .to_owned();
        Ok(RemoteEntry {
            name,
            path,
            file_type: map_file_type(metadata.file_type()),
            size: metadata.len(),
            modified_at_unix: metadata.mtime.map(u64::from),
            permissions: metadata.permissions,
            owner: metadata.user,
            group: metadata.group,
        })
    }

    pub async fn create_directory(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<(), SftpManagerError> {
        self.session(connection_id)
            .await?
            .create_dir(path)
            .await
            .context("failed to create remote directory")?;
        Ok(())
    }

    pub async fn rename(
        &self,
        connection_id: ConnectionId,
        old_path: String,
        new_path: String,
    ) -> Result<(), SftpManagerError> {
        self.session(connection_id)
            .await?
            .rename(old_path, new_path)
            .await
            .context("failed to rename remote path")?;
        Ok(())
    }

    pub async fn delete(
        &self,
        connection_id: ConnectionId,
        path: String,
        is_directory: bool,
    ) -> Result<(), SftpManagerError> {
        let session = self.session(connection_id).await?;
        if is_directory {
            session
                .remove_dir(path)
                .await
                .context("failed to delete remote directory")?;
        } else {
            session
                .remove_file(path)
                .await
                .context("failed to delete remote file")?;
        }
        Ok(())
    }

    pub async fn upload(
        &self,
        connection_id: ConnectionId,
        local_path: PathBuf,
        remote_path: String,
        overwrite: bool,
    ) -> Result<TransferSubscription, SftpManagerError> {
        let session = self.session(connection_id).await?;
        let local_metadata = tokio::fs::metadata(&local_path)
            .await
            .with_context(|| format!("failed to read {}", local_path.display()))?;
        let total_bytes = local_metadata.len();
        let upload_metadata =
            make_upload_resume_metadata(&local_path, &remote_path, &local_metadata);
        let transfer_id = Uuid::new_v4();
        let (event_tx, event_rx) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let (control_tx, control_rx) = watch::channel(TransferControl::Running);
        let context = TerminalTransferContext {
            transfer_id,
            direction: TransferDirection::Upload,
            local_path: local_path.clone(),
            remote_path: remote_path.clone(),
            total_bytes,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        self.inner.transfers.lock().await.insert(
            transfer_id,
            ManagedTransfer {
                connection_id,
                control: control_tx,
                snapshot: Arc::clone(&snapshot),
            },
        );
        let _ = event_tx.try_send(
            snapshot
                .lock()
                .map(|event| event.clone())
                .unwrap_or_else(|_| context.event(TransferStatus::Queued, 0, None, None)),
        );
        let manager = self.clone();

        tokio::spawn(async move {
            let mut latest_transferred = 0;
            let mut reporter = TransferProgressReporter::new(
                event_tx.clone(),
                context.clone(),
                Arc::clone(&snapshot),
            );
            let result = upload_file(
                &session,
                &local_path,
                &remote_path,
                overwrite,
                &upload_metadata,
                control_rx,
                |transferred| {
                    latest_transferred = transferred;
                    reporter.report(transferred);
                },
            )
            .await;
            let terminal_event = terminal_transfer_event(context, latest_transferred, result);
            update_transfer_snapshot(&snapshot, terminal_event.clone());
            let _ = event_tx.send(terminal_event).await;
            let _ = manager
                .close_released_connection_if_idle(connection_id)
                .await;
        });

        Ok(TransferSubscription {
            transfer_id,
            events: event_rx,
        })
    }

    pub async fn download(
        &self,
        connection_id: ConnectionId,
        remote_path: String,
        local_path: PathBuf,
        overwrite: bool,
    ) -> Result<TransferSubscription, SftpManagerError> {
        let (session, source_identity) = self.download_connection(connection_id).await?;
        let remote_metadata = session
            .metadata(remote_path.clone())
            .await
            .context("failed to read remote file metadata")?;
        let total_bytes = remote_metadata.len();
        let modified_at_unix = remote_metadata.mtime;
        let transfer_id = Uuid::new_v4();
        let (event_tx, event_rx) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let (control_tx, control_rx) = watch::channel(TransferControl::Running);
        let context = TerminalTransferContext {
            transfer_id,
            direction: TransferDirection::Download,
            local_path: local_path.clone(),
            remote_path: remote_path.clone(),
            total_bytes,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        self.inner.transfers.lock().await.insert(
            transfer_id,
            ManagedTransfer {
                connection_id,
                control: control_tx,
                snapshot: Arc::clone(&snapshot),
            },
        );
        let _ = event_tx.try_send(
            snapshot
                .lock()
                .map(|event| event.clone())
                .unwrap_or_else(|_| context.event(TransferStatus::Queued, 0, None, None)),
        );
        let manager = self.clone();

        tokio::spawn(async move {
            let mut latest_transferred = 0;
            let mut reporter = TransferProgressReporter::new(
                event_tx.clone(),
                context.clone(),
                Arc::clone(&snapshot),
            );
            let result = download_file(
                &session,
                DownloadFileRequest {
                    remote_path: &remote_path,
                    local_path: &local_path,
                    overwrite,
                    total_bytes,
                    modified_at_unix,
                    source_identity: &source_identity,
                },
                control_rx,
                |transferred| {
                    latest_transferred = transferred;
                    reporter.report(transferred);
                },
            )
            .await;
            let terminal_event = terminal_transfer_event(context, latest_transferred, result);
            update_transfer_snapshot(&snapshot, terminal_event.clone());
            let _ = event_tx.send(terminal_event).await;
            let _ = manager
                .close_released_connection_if_idle(connection_id)
                .await;
        });

        Ok(TransferSubscription {
            transfer_id,
            events: event_rx,
        })
    }

    async fn session(
        &self,
        connection_id: ConnectionId,
    ) -> Result<Arc<SftpSession>, SftpManagerError> {
        self.inner
            .connections
            .lock()
            .await
            .get(&connection_id)
            .map(|connection| Arc::clone(&connection.sftp))
            .ok_or(SftpManagerError::ConnectionNotFound(connection_id))
    }

    async fn download_connection(
        &self,
        connection_id: ConnectionId,
    ) -> Result<(Arc<SftpSession>, String), SftpManagerError> {
        self.inner
            .connections
            .lock()
            .await
            .get(&connection_id)
            .map(|connection| {
                (
                    Arc::clone(&connection.sftp),
                    connection.download_source_identity.clone(),
                )
            })
            .ok_or(SftpManagerError::ConnectionNotFound(connection_id))
    }
}

async fn wait_for_transfer_control(
    control: &mut watch::Receiver<TransferControl>,
) -> anyhow::Result<Option<TransferStatus>> {
    loop {
        let current = *control.borrow_and_update();
        match current {
            TransferControl::Running => return Ok(None),
            TransferControl::Cancelled => return Ok(Some(TransferStatus::Cancelled)),
            TransferControl::Paused => control
                .changed()
                .await
                .map_err(|_| anyhow::anyhow!("transfer control channel closed"))?,
        }
    }
}

async fn upload_file(
    session: &SftpSession,
    local_path: &Path,
    remote_path: &str,
    overwrite: bool,
    expected_metadata: &UploadResumeMetadata,
    mut control: watch::Receiver<TransferControl>,
    mut progress: impl FnMut(u64),
) -> anyhow::Result<TransferStatus> {
    if session.try_exists(remote_path.to_owned()).await? && !overwrite {
        bail!("remote destination already exists");
    }

    let local_metadata = tokio::fs::metadata(local_path).await?;
    let actual_metadata = make_upload_resume_metadata(local_path, remote_path, &local_metadata);
    if &actual_metadata != expected_metadata {
        bail!("local source changed before upload started");
    }

    let temporary_path = upload_temporary_path(remote_path);
    let metadata_path = upload_metadata_path(remote_path);
    let transferred =
        resumable_upload_bytes(session, &temporary_path, &metadata_path, expected_metadata).await?;

    let mut transferred = match transferred {
        Some(partial_bytes) => partial_bytes,
        None => {
            remove_remote_file_if_exists(session, &temporary_path).await?;
            remove_remote_file_if_exists(session, &metadata_path).await?;
            write_upload_resume_metadata(session, &metadata_path, expected_metadata).await?;
            0
        }
    };
    progress(transferred);

    let mut local = tokio::fs::File::open(local_path).await?;
    if transferred > 0 {
        local.seek(SeekFrom::Start(transferred)).await?;
    }

    let mut remote = session
        .open_with_flags(temporary_path.clone(), OpenFlags::CREATE | OpenFlags::WRITE)
        .await?;
    if transferred > 0 {
        remote.seek(SeekFrom::Start(transferred)).await?;
    }

    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        if let Some(status) = wait_for_transfer_control(&mut control).await? {
            remote.flush().await.ok();
            remote.shutdown().await.ok();
            return Ok(status);
        }
        let read = local.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        remote.write_all(&buffer[..read]).await?;
        transferred += read as u64;
        progress(transferred);
    }

    remote.flush().await?;
    remote.shutdown().await?;
    if let Some(status) = wait_for_transfer_control(&mut control).await? {
        return Ok(status);
    }
    if transferred != expected_metadata.total_bytes {
        bail!(
            "local file changed during upload: expected {} bytes, read {transferred} bytes",
            expected_metadata.total_bytes
        );
    }

    let final_local_metadata = tokio::fs::metadata(local_path).await?;
    let final_expected_metadata =
        make_upload_resume_metadata(local_path, remote_path, &final_local_metadata);
    if &final_expected_metadata != expected_metadata {
        bail!("local source changed during upload");
    }

    finalize_upload(
        session,
        &temporary_path,
        &metadata_path,
        remote_path,
        overwrite,
    )
    .await?;
    Ok(TransferStatus::Completed)
}

fn upload_temporary_path(remote_path: &str) -> String {
    format!("{remote_path}.xsh-part")
}

fn upload_metadata_path(remote_path: &str) -> String {
    format!("{remote_path}.xsh-part.meta")
}

fn make_upload_resume_metadata(
    local_path: &Path,
    remote_path: &str,
    local_metadata: &std::fs::Metadata,
) -> UploadResumeMetadata {
    UploadResumeMetadata {
        version: UPLOAD_RESUME_METADATA_VERSION,
        local_path: local_path.to_string_lossy().into_owned(),
        remote_path: remote_path.to_owned(),
        total_bytes: local_metadata.len(),
        modified_at_unix_nanos: local_metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
    }
}

fn can_resume_upload(
    saved: &UploadResumeMetadata,
    expected: &UploadResumeMetadata,
    partial_bytes: u64,
) -> bool {
    saved == expected && partial_bytes <= expected.total_bytes
}

async fn resumable_upload_bytes(
    session: &SftpSession,
    temporary_path: &str,
    metadata_path: &str,
    expected: &UploadResumeMetadata,
) -> anyhow::Result<Option<u64>> {
    if !session.try_exists(temporary_path.to_owned()).await?
        || !session.try_exists(metadata_path.to_owned()).await?
    {
        return Ok(None);
    }

    let temporary_metadata = session.metadata(temporary_path.to_owned()).await?;
    if temporary_metadata.file_type() != FileType::File {
        bail!("SFTP upload checkpoint is not a regular file: {temporary_path}");
    }
    let partial_bytes = temporary_metadata.len();
    let raw_metadata = match session.read(metadata_path.to_owned()).await {
        Ok(raw_metadata) => raw_metadata,
        Err(_) => return Ok(None),
    };
    let saved = match serde_json::from_slice::<UploadResumeMetadata>(&raw_metadata) {
        Ok(saved) => saved,
        Err(_) => return Ok(None),
    };

    Ok(can_resume_upload(&saved, expected, partial_bytes).then_some(partial_bytes))
}

async fn write_upload_resume_metadata(
    session: &SftpSession,
    metadata_path: &str,
    metadata: &UploadResumeMetadata,
) -> anyhow::Result<()> {
    let temporary_metadata_path = format!("{metadata_path}.tmp");
    remove_remote_file_if_exists(session, &temporary_metadata_path).await?;
    let encoded =
        serde_json::to_vec(metadata).context("failed to encode upload resume metadata")?;
    let mut remote = session
        .open_with_flags(
            temporary_metadata_path.clone(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await?;
    remote.write_all(&encoded).await?;
    remote.flush().await?;
    remote.shutdown().await?;
    remove_remote_file_if_exists(session, metadata_path).await?;
    session
        .rename(temporary_metadata_path, metadata_path.to_owned())
        .await?;
    Ok(())
}

async fn finalize_upload(
    session: &SftpSession,
    temporary_path: &str,
    metadata_path: &str,
    remote_path: &str,
    overwrite: bool,
) -> anyhow::Result<()> {
    match session
        .rename(temporary_path.to_owned(), remote_path.to_owned())
        .await
    {
        Ok(()) => {}
        Err(rename_error) if overwrite && session.try_exists(remote_path.to_owned()).await? => {
            // Prefer the direct rename above: on servers that support replacing a
            // destination it is atomic. The remove-and-retry path keeps compatibility
            // with servers that reject rename-over-existing-file.
            session.remove_file(remote_path.to_owned()).await?;
            session
                .rename(temporary_path.to_owned(), remote_path.to_owned())
                .await
                .with_context(|| {
                    format!(
                        "failed to replace remote destination after rename failed: {rename_error}"
                    )
                })?;
        }
        Err(error) => return Err(error.into()),
    }
    remove_remote_file_if_exists(session, metadata_path).await?;
    Ok(())
}

async fn remove_remote_file_if_exists(session: &SftpSession, path: &str) -> anyhow::Result<()> {
    if session.try_exists(path.to_owned()).await? {
        session.remove_file(path.to_owned()).await?;
    }
    Ok(())
}

async fn download_file(
    session: &SftpSession,
    request: DownloadFileRequest<'_>,
    mut control: watch::Receiver<TransferControl>,
    mut progress: impl FnMut(u64),
) -> anyhow::Result<TransferStatus> {
    if tokio::fs::try_exists(request.local_path).await? && !request.overwrite {
        bail!("local destination already exists");
    }
    if let Some(parent) = request.local_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let temporary_path = download_temporary_path(request.local_path);
    let metadata_path = download_metadata_path(request.local_path);
    let expected_metadata = DownloadResumeMetadata {
        version: DOWNLOAD_RESUME_METADATA_VERSION,
        remote_path: request.remote_path.to_owned(),
        total_bytes: request.total_bytes,
        modified_at_unix: request.modified_at_unix,
        source_identity: request.source_identity.to_owned(),
    };
    let partial_bytes =
        resumable_partial_bytes(&temporary_path, &metadata_path, &expected_metadata).await?;

    if partial_bytes.is_none() {
        remove_file_if_exists(&temporary_path).await?;
        remove_file_if_exists(&metadata_path).await?;
        write_download_resume_metadata(&metadata_path, &expected_metadata).await?;
    }
    let mut transferred = partial_bytes.unwrap_or(0);
    if transferred > 0
        && !verify_download_resume_samples(
            session,
            request.remote_path,
            &temporary_path,
            transferred,
        )
        .await?
    {
        remove_file_if_exists(&temporary_path).await?;
        remove_file_if_exists(&metadata_path).await?;
        write_download_resume_metadata(&metadata_path, &expected_metadata).await?;
        transferred = 0;
    }
    progress(transferred);

    if transferred == request.total_bytes {
        finalize_download(
            &temporary_path,
            &metadata_path,
            request.local_path,
            request.overwrite,
        )
        .await?;
        return Ok(TransferStatus::Completed);
    }

    let mut remote = session.open(request.remote_path.to_owned()).await?;
    if transferred > 0 {
        remote.seek(SeekFrom::Start(transferred)).await?;
    }
    let mut local = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temporary_path)
        .await?;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        if let Some(status) = wait_for_transfer_control(&mut control).await? {
            local.flush().await.ok();
            local.shutdown().await.ok();
            return Ok(status);
        }
        let read = remote.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        local.write_all(&buffer[..read]).await?;
        transferred += read as u64;
        progress(transferred);
    }
    local.flush().await?;
    local.shutdown().await?;
    if transferred != request.total_bytes {
        bail!(
            "remote file ended early: expected {} bytes, received {transferred} bytes",
            request.total_bytes
        );
    }
    finalize_download(
        &temporary_path,
        &metadata_path,
        request.local_path,
        request.overwrite,
    )
    .await?;
    Ok(TransferStatus::Completed)
}

fn download_temporary_path(local_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.xsh-part", local_path.to_string_lossy()))
}

fn download_metadata_path(local_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.xsh-part.meta", local_path.to_string_lossy()))
}

fn can_resume_download(
    saved: &DownloadResumeMetadata,
    expected: &DownloadResumeMetadata,
    partial_bytes: u64,
) -> bool {
    saved == expected && partial_bytes <= expected.total_bytes
}

async fn resumable_partial_bytes(
    temporary_path: &Path,
    metadata_path: &Path,
    expected: &DownloadResumeMetadata,
) -> anyhow::Result<Option<u64>> {
    if !tokio::fs::try_exists(temporary_path).await?
        || !tokio::fs::try_exists(metadata_path).await?
    {
        return Ok(None);
    }

    let partial_bytes = tokio::fs::metadata(temporary_path).await?.len();
    let raw_metadata = match tokio::fs::read(metadata_path).await {
        Ok(raw_metadata) => raw_metadata,
        Err(_) => return Ok(None),
    };
    let saved = match serde_json::from_slice::<DownloadResumeMetadata>(&raw_metadata) {
        Ok(saved) => saved,
        Err(_) => return Ok(None),
    };

    Ok(can_resume_download(&saved, expected, partial_bytes).then_some(partial_bytes))
}

fn resume_sample_offsets(partial_bytes: u64) -> Vec<u64> {
    if partial_bytes == 0 {
        return Vec::new();
    }
    let sample_bytes = partial_bytes.min(RESUME_VERIFICATION_BLOCK_BYTES);
    let tail_offset = partial_bytes - sample_bytes;
    if tail_offset == 0 {
        vec![0]
    } else {
        vec![0, tail_offset]
    }
}

async fn verify_download_resume_samples(
    session: &SftpSession,
    remote_path: &str,
    temporary_path: &Path,
    partial_bytes: u64,
) -> anyhow::Result<bool> {
    let sample_bytes = partial_bytes.min(RESUME_VERIFICATION_BLOCK_BYTES) as usize;
    for offset in resume_sample_offsets(partial_bytes) {
        let mut remote = session.open(remote_path.to_owned()).await?;
        remote.seek(SeekFrom::Start(offset)).await?;
        let mut local = tokio::fs::File::open(temporary_path).await?;
        local.seek(SeekFrom::Start(offset)).await?;
        let mut remote_sample = vec![0_u8; sample_bytes];
        let mut local_sample = vec![0_u8; sample_bytes];
        if remote.read_exact(&mut remote_sample).await.is_err()
            || local.read_exact(&mut local_sample).await.is_err()
            || remote_sample != local_sample
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn write_download_resume_metadata(
    metadata_path: &Path,
    metadata: &DownloadResumeMetadata,
) -> anyhow::Result<()> {
    let temporary_metadata_path = PathBuf::from(format!("{}.tmp", metadata_path.to_string_lossy()));
    remove_file_if_exists(&temporary_metadata_path).await?;
    tokio::fs::write(
        &temporary_metadata_path,
        serde_json::to_vec(metadata).context("failed to encode download resume metadata")?,
    )
    .await?;
    tokio::fs::rename(&temporary_metadata_path, metadata_path).await?;
    Ok(())
}

async fn finalize_download(
    temporary_path: &Path,
    metadata_path: &Path,
    local_path: &Path,
    overwrite: bool,
) -> anyhow::Result<()> {
    if overwrite {
        remove_file_if_exists(local_path).await?;
    }
    tokio::fs::rename(temporary_path, local_path).await?;
    remove_file_if_exists(metadata_path).await?;
    Ok(())
}

async fn remove_file_if_exists(path: &Path) -> anyhow::Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn terminal_transfer_event(
    context: TerminalTransferContext,
    last_transferred_bytes: u64,
    result: anyhow::Result<TransferStatus>,
) -> TransferEvent {
    let (status, error, transferred_bytes) = match result {
        Ok(status) => {
            let transferred = if status == TransferStatus::Completed {
                context.total_bytes
            } else {
                last_transferred_bytes
            };
            (status, None, transferred)
        }
        Err(error) => (
            TransferStatus::Failed,
            Some(format!("{error:#}")),
            last_transferred_bytes,
        ),
    };
    context.event(status, transferred_bytes, Some(0), error)
}

fn transfer_is_active(status: &TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
    )
}

fn map_file_type(file_type: FileType) -> RemoteFileType {
    match file_type {
        FileType::Dir => RemoteFileType::Directory,
        FileType::File => RemoteFileType::File,
        FileType::Symlink => RemoteFileType::Symlink,
        FileType::Other => RemoteFileType::Other,
    }
}

fn entry_rank(file_type: &RemoteFileType) -> u8 {
    match file_type {
        RemoteFileType::Directory => 0,
        RemoteFileType::Symlink => 1,
        RemoteFileType::File => 2,
        RemoteFileType::Other => 3,
    }
}

fn sftp_client_config() -> client::Config {
    client::Config {
        nodelay: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resume_metadata(remote_path: &str, total_bytes: u64) -> DownloadResumeMetadata {
        DownloadResumeMetadata {
            version: DOWNLOAD_RESUME_METADATA_VERSION,
            remote_path: remote_path.to_owned(),
            total_bytes,
            modified_at_unix: Some(1_700_000_000),
            source_identity: "files.example.com:22:SHA256:expected".into(),
        }
    }

    #[test]
    fn transfer_progress_is_throttled_before_the_event_queue() {
        let (events, mut received) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let context = TerminalTransferContext {
            transfer_id: Uuid::new_v4(),
            direction: TransferDirection::Upload,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        let mut reporter = TransferProgressReporter::new(events, context, snapshot);

        reporter.report(0);
        reporter.report(1_024);

        assert_eq!(received.try_recv().unwrap().transferred_bytes, 0);
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn terminal_transfer_event_preserves_terminal_status() {
        let context = TerminalTransferContext {
            transfer_id: Uuid::new_v4(),
            direction: TransferDirection::Download,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let event = terminal_transfer_event(context, 1_024, Ok(TransferStatus::Completed));
        assert_eq!(event.status, TransferStatus::Completed);
        assert_eq!(event.transferred_bytes, 2_048);
        assert_eq!(event.speed_bytes_per_second, Some(0));
    }

    #[tokio::test]
    async fn paused_transfer_waits_until_resumed() {
        let (control_tx, mut control_rx) = watch::channel(TransferControl::Paused);
        let mut task =
            tokio::spawn(async move { wait_for_transfer_control(&mut control_rx).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut task)
                .await
                .is_err()
        );
        control_tx.send(TransferControl::Running).unwrap();
        assert!(task.await.unwrap().unwrap().is_none());
    }

    #[tokio::test]
    async fn manager_updates_paused_transfer_snapshot() {
        let manager = SftpManager::new();
        let transfer_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let context = TerminalTransferContext {
            transfer_id,
            direction: TransferDirection::Upload,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let (control, _control_receiver) = watch::channel(TransferControl::Running);
        manager.inner.transfers.lock().await.insert(
            transfer_id,
            ManagedTransfer {
                connection_id,
                control,
                snapshot: Arc::new(StdMutex::new(context.event(
                    TransferStatus::Running,
                    512,
                    Some(42),
                    None,
                ))),
            },
        );

        let paused = manager.pause_transfer(transfer_id).await.unwrap();
        assert_eq!(paused.status, TransferStatus::Paused);
        assert_eq!(paused.speed_bytes_per_second, Some(0));
        assert_eq!(
            manager.resume_transfer(transfer_id).await.unwrap().status,
            TransferStatus::Running
        );
    }

    #[test]
    fn upload_resume_metadata_round_trips_and_validates_checkpoint() {
        let source = std::env::temp_dir().join(format!("xsh-sftp-upload-test-{}", Uuid::new_v4()));
        std::fs::write(&source, b"partial upload contents").expect("create upload fixture");
        let file_metadata = std::fs::metadata(&source).expect("stat upload fixture");
        let expected = make_upload_resume_metadata(&source, "/tmp/archive.tar", &file_metadata);
        let encoded = serde_json::to_vec(&expected).expect("encode upload metadata");
        let decoded: UploadResumeMetadata =
            serde_json::from_slice(&encoded).expect("decode upload metadata");

        assert_eq!(decoded, expected);
        assert!(can_resume_upload(&decoded, &expected, 0));
        assert!(can_resume_upload(&decoded, &expected, expected.total_bytes));
        assert!(!can_resume_upload(
            &decoded,
            &expected,
            expected.total_bytes + 1
        ));

        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn changed_upload_source_or_destination_cannot_resume() {
        let source = std::env::temp_dir().join(format!("xsh-sftp-upload-test-{}", Uuid::new_v4()));
        std::fs::write(&source, b"upload contents").expect("create upload fixture");
        let file_metadata = std::fs::metadata(&source).expect("stat upload fixture");
        let expected = make_upload_resume_metadata(&source, "/tmp/archive.tar", &file_metadata);

        let mut changed_source = expected.clone();
        changed_source.local_path.push_str(".renamed");
        assert!(!can_resume_upload(&changed_source, &expected, 4));

        let mut changed_destination = expected.clone();
        changed_destination.remote_path = "/tmp/other.tar".into();
        assert!(!can_resume_upload(&changed_destination, &expected, 4));

        let mut changed_size = expected.clone();
        changed_size.total_bytes += 1;
        assert!(!can_resume_upload(&changed_size, &expected, 4));

        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn upload_checkpoint_paths_are_stable_and_separate() {
        let temporary = upload_temporary_path("/var/tmp/archive.tar");
        let metadata = upload_metadata_path("/var/tmp/archive.tar");
        assert_eq!(temporary, "/var/tmp/archive.tar.xsh-part");
        assert_eq!(metadata, "/var/tmp/archive.tar.xsh-part.meta");
        assert_ne!(temporary, metadata);
    }

    #[test]
    fn directories_sort_before_files() {
        assert!(entry_rank(&RemoteFileType::Directory) < entry_rank(&RemoteFileType::File));
    }

    #[test]
    fn matching_partial_download_can_resume() {
        let metadata = resume_metadata("/logs/archive.tar", 2_048);
        assert!(can_resume_download(&metadata, &metadata, 1_024));
        assert!(can_resume_download(&metadata, &metadata, 2_048));
    }

    #[test]
    fn changed_remote_file_cannot_resume() {
        let expected = resume_metadata("/logs/archive.tar", 2_048);

        let mut changed_path = expected.clone();
        changed_path.remote_path = "/logs/other.tar".into();
        assert!(!can_resume_download(&changed_path, &expected, 1_024));

        let mut changed_size = expected.clone();
        changed_size.total_bytes = 4_096;
        assert!(!can_resume_download(&changed_size, &expected, 1_024));

        let mut changed_time = expected.clone();
        changed_time.modified_at_unix = Some(1_800_000_000);
        assert!(!can_resume_download(&changed_time, &expected, 1_024));

        let mut changed_source = expected.clone();
        changed_source.source_identity = "other.example.com:22:SHA256:other".into();
        assert!(!can_resume_download(&changed_source, &expected, 1_024));
    }

    #[test]
    fn download_resume_samples_cover_the_start_and_tail() {
        assert_eq!(resume_sample_offsets(0), Vec::<u64>::new());
        assert_eq!(resume_sample_offsets(512), vec![0]);
        assert_eq!(
            resume_sample_offsets(RESUME_VERIFICATION_BLOCK_BYTES + 512),
            vec![0, 512]
        );
    }

    #[test]
    fn oversized_partial_download_cannot_resume() {
        let metadata = resume_metadata("/logs/archive.tar", 2_048);
        assert!(!can_resume_download(&metadata, &metadata, 2_049));
    }

    #[tokio::test]
    async fn missing_connection_is_reported() {
        let manager = SftpManager::new();
        let result = manager.list_directory(Uuid::new_v4(), "/".into()).await;
        assert!(matches!(
            result,
            Err(SftpManagerError::ConnectionNotFound(_))
        ));
    }
}
