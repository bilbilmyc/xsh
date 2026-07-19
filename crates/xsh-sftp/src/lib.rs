use anyhow::{Context, bail};
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, load_secret_key};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc, watch};
use uuid::Uuid;
use xsh_domain::{
    ConnectionId, KnownHost, RemoteEntry, RemoteFileType, TransferDirection, TransferEvent,
    TransferId, TransferStatus,
};
use xsh_ssh::RuntimeAuthentication;
use xsh_ssh::config::resolve_proxy_jump;
use xsh_ssh::known_hosts::read_user_known_host;

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
    pub events: mpsc::UnboundedReceiver<TransferEvent>,
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

const DOWNLOAD_RESUME_METADATA_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DownloadResumeMetadata {
    version: u8,
    remote_path: String,
    total_bytes: u64,
    modified_at_unix: Option<u32>,
}

struct DownloadFileRequest<'a> {
    remote_path: &'a str,
    local_path: &'a Path,
    overwrite: bool,
    total_bytes: u64,
    modified_at_unix: Option<u32>,
}

struct TerminalTransferContext {
    transfer_id: TransferId,
    direction: TransferDirection,
    local_path: PathBuf,
    remote_path: String,
    total_bytes: u64,
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
            .with_context(|| {
                format!(
                    "failed to load private key {}",
                    private_key_path.to_string_lossy()
                )
            })?;
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
    _ssh: client::Handle<SftpHostKeyHandler>,
    _proxy_ssh: Option<client::Handle<SftpHostKeyHandler>>,
}

#[derive(Default)]
struct SftpManagerInner {
    connections: Mutex<HashMap<ConnectionId, ActiveSftpConnection>>,
    transfers: Mutex<HashMap<TransferId, watch::Sender<bool>>>,
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
                known_host: read_user_known_host(&proxy.host, proxy.port).ok().flatten(),
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

        let connection_id = Uuid::new_v4();
        self.inner.connections.lock().await.insert(
            connection_id,
            ActiveSftpConnection {
                sftp: Arc::new(sftp),
                _ssh: ssh,
                _proxy_ssh: proxy_ssh,
            },
        );
        let mut trusted_host_keys = Vec::new();
        if let Some(key) = target_trusted_host_key.lock().await.take() {
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
        let total_bytes = tokio::fs::metadata(&local_path)
            .await
            .with_context(|| format!("failed to read {}", local_path.display()))?
            .len();
        let transfer_id = Uuid::new_v4();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.inner
            .transfers
            .lock()
            .await
            .insert(transfer_id, cancel_tx);
        let inner = Arc::clone(&self.inner);
        let event_local_path = local_path.clone();
        let event_remote_path = remote_path.clone();

        tokio::spawn(async move {
            let latest_transferred = Arc::new(AtomicU64::new(0));
            let progress_transferred = Arc::clone(&latest_transferred);
            let result = upload_file(
                &session,
                &local_path,
                &remote_path,
                overwrite,
                cancel_rx,
                |transferred| {
                    progress_transferred.store(transferred, Ordering::Relaxed);
                    let _ = event_tx.send(TransferEvent {
                        transfer_id,
                        direction: TransferDirection::Upload,
                        local_path: event_local_path.clone(),
                        remote_path: event_remote_path.clone(),
                        status: TransferStatus::Running,
                        transferred_bytes: transferred,
                        total_bytes: Some(total_bytes),
                        error: None,
                    });
                },
            )
            .await;
            send_terminal_transfer_event(
                &event_tx,
                TerminalTransferContext {
                    transfer_id,
                    direction: TransferDirection::Upload,
                    local_path: event_local_path,
                    remote_path: event_remote_path,
                    total_bytes,
                },
                latest_transferred.load(Ordering::Relaxed),
                result,
            );
            inner.transfers.lock().await.remove(&transfer_id);
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
        let session = self.session(connection_id).await?;
        let remote_metadata = session
            .metadata(remote_path.clone())
            .await
            .context("failed to read remote file metadata")?;
        let total_bytes = remote_metadata.len();
        let modified_at_unix = remote_metadata.mtime;
        let transfer_id = Uuid::new_v4();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.inner
            .transfers
            .lock()
            .await
            .insert(transfer_id, cancel_tx);
        let inner = Arc::clone(&self.inner);
        let event_local_path = local_path.clone();
        let event_remote_path = remote_path.clone();

        tokio::spawn(async move {
            let latest_transferred = Arc::new(AtomicU64::new(0));
            let progress_transferred = Arc::clone(&latest_transferred);
            let result = download_file(
                &session,
                DownloadFileRequest {
                    remote_path: &remote_path,
                    local_path: &local_path,
                    overwrite,
                    total_bytes,
                    modified_at_unix,
                },
                cancel_rx,
                |transferred| {
                    progress_transferred.store(transferred, Ordering::Relaxed);
                    let _ = event_tx.send(TransferEvent {
                        transfer_id,
                        direction: TransferDirection::Download,
                        local_path: event_local_path.clone(),
                        remote_path: event_remote_path.clone(),
                        status: TransferStatus::Running,
                        transferred_bytes: transferred,
                        total_bytes: Some(total_bytes),
                        error: None,
                    });
                },
            )
            .await;
            send_terminal_transfer_event(
                &event_tx,
                TerminalTransferContext {
                    transfer_id,
                    direction: TransferDirection::Download,
                    local_path: event_local_path,
                    remote_path: event_remote_path,
                    total_bytes,
                },
                latest_transferred.load(Ordering::Relaxed),
                result,
            );
            inner.transfers.lock().await.remove(&transfer_id);
        });

        Ok(TransferSubscription {
            transfer_id,
            events: event_rx,
        })
    }

    pub async fn cancel_transfer(&self, transfer_id: TransferId) -> Result<(), SftpManagerError> {
        self.inner
            .transfers
            .lock()
            .await
            .get(&transfer_id)
            .ok_or(SftpManagerError::TransferNotFound(transfer_id))?
            .send(true)
            .map_err(|error| SftpManagerError::Operation(anyhow::anyhow!(error.to_string())))
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
}

async fn upload_file(
    session: &SftpSession,
    local_path: &Path,
    remote_path: &str,
    overwrite: bool,
    cancel: watch::Receiver<bool>,
    mut progress: impl FnMut(u64),
) -> anyhow::Result<TransferStatus> {
    if session.try_exists(remote_path.to_owned()).await? && !overwrite {
        bail!("remote destination already exists");
    }
    let temporary_path = format!("{remote_path}.xsh-part");
    if session.try_exists(temporary_path.clone()).await? {
        session.remove_file(temporary_path.clone()).await?;
    }

    let mut local = tokio::fs::File::open(local_path).await?;
    let mut remote = session
        .open_with_flags(
            temporary_path.clone(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await?;
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut transferred = 0_u64;
    loop {
        if *cancel.borrow() {
            remote.shutdown().await.ok();
            session.remove_file(temporary_path).await.ok();
            return Ok(TransferStatus::Cancelled);
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
    if overwrite && session.try_exists(remote_path.to_owned()).await? {
        session.remove_file(remote_path.to_owned()).await?;
    }
    session
        .rename(temporary_path, remote_path.to_owned())
        .await?;
    Ok(TransferStatus::Completed)
}

async fn download_file(
    session: &SftpSession,
    request: DownloadFileRequest<'_>,
    cancel: watch::Receiver<bool>,
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
    };
    let partial_bytes =
        resumable_partial_bytes(&temporary_path, &metadata_path, &expected_metadata).await?;

    if partial_bytes.is_none() {
        remove_file_if_exists(&temporary_path).await?;
        remove_file_if_exists(&metadata_path).await?;
        write_download_resume_metadata(&metadata_path, &expected_metadata).await?;
    }
    let mut transferred = partial_bytes.unwrap_or(0);
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
        if *cancel.borrow() {
            local.flush().await.ok();
            local.shutdown().await.ok();
            return Ok(TransferStatus::Cancelled);
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

fn send_terminal_transfer_event(
    event_tx: &mpsc::UnboundedSender<TransferEvent>,
    context: TerminalTransferContext,
    last_transferred_bytes: u64,
    result: anyhow::Result<TransferStatus>,
) {
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
    let _ = event_tx.send(TransferEvent {
        transfer_id: context.transfer_id,
        direction: context.direction,
        local_path: context.local_path,
        remote_path: context.remote_path,
        status,
        transferred_bytes,
        total_bytes: Some(context.total_bytes),
        error,
    });
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
        }
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
