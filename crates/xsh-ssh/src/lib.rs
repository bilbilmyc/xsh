pub mod config;
pub mod known_hosts;
mod output_flow;

use anyhow::{Context, anyhow, bail};
use config::resolve_proxy_jump_async;
use output_flow::{TERMINAL_OUTPUT_CHUNK_BYTES, TerminalOutputFlow};
use russh::client;
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, load_secret_key};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, lookup_host};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;
use xsh_domain::{
    AuthPrompt, ConnectionId, ConnectionState, ForwardKind, ForwardProfile, HostKeyApproval,
    HostKeyRole, KnownHost, SessionId, TerminalEvent, TerminalProfile,
};
use zeroize::Zeroizing;

#[derive(Debug, Clone)]
pub enum RuntimeAuthentication {
    Password(Zeroizing<String>),
    PrivateKey {
        private_key_path: PathBuf,
        passphrase: Option<Zeroizing<String>>,
    },
    Agent {
        identity_fingerprint: Option<String>,
    },
}

#[derive(Debug)]
pub struct ConnectOptions {
    pub session_id: SessionId,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub proxy_jump: Option<String>,
    pub proxy_jump_username: Option<String>,
    pub proxy_jump_authentication: Option<RuntimeAuthentication>,
    pub authentication: RuntimeAuthentication,
    pub terminal: TerminalProfile,
    pub keepalive_seconds: u64,
    pub columns: u16,
    pub rows: u16,
    pub initial_directory: Option<String>,
    pub startup_command: Option<String>,
    pub known_host: Option<KnownHost>,
    pub proxy_jump_known_host: Option<KnownHost>,
}

pub fn validate_host_key_approval(approval: &HostKeyApproval) -> anyhow::Result<KnownHost> {
    let mut parsed = PublicKey::from_openssh(&approval.public_key)
        .context("Host Key public_key 不是有效的 OpenSSH 公钥")?;
    parsed.set_comment("");
    let canonical_public_key = parsed
        .to_openssh()
        .context("无法规范化 Host Key public_key")?;
    let key_type = parsed.algorithm().as_str().to_owned();
    let fingerprint = parsed.fingerprint(HashAlg::Sha256).to_string();

    if approval.public_key.trim() != canonical_public_key {
        bail!("Host Key public_key 不是服务器提供的规范形式");
    }
    if approval.key_type != key_type {
        bail!(
            "Host Key 算法不匹配：声明为 {}，实际为 {}",
            approval.key_type,
            key_type
        );
    }
    if approval.fingerprint != fingerprint {
        bail!(
            "Host Key 指纹不匹配：声明为 {}，实际为 {}",
            approval.fingerprint,
            fingerprint
        );
    }

    let now = chrono::Utc::now();
    Ok(KnownHost {
        host: approval.host.clone(),
        port: approval.port,
        key_type,
        fingerprint,
        public_key: canonical_public_key,
        first_seen: now,
        last_seen: now,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointDiagnostic {
    pub host: String,
    pub port: u16,
    pub addresses: Vec<String>,
    pub dns_error: Option<String>,
    pub tcp_reachable: Option<bool>,
    pub tcp_error: Option<String>,
    pub issue: Option<EndpointDiagnosticIssue>,
    pub suggestion: Option<String>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointDiagnosticIssue {
    DnsResolutionFailed,
    DnsNoAddresses,
    ConnectionTimedOut,
    ConnectionRefused,
    NetworkUnreachable,
    ConnectionReset,
    TcpConnectionFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticReport {
    pub target: EndpointDiagnostic,
    pub proxy_jump: Option<EndpointDiagnostic>,
    pub uses_proxy_jump: bool,
    pub ready: bool,
}

#[derive(Debug)]
pub struct ConnectionSubscription {
    pub connection_id: ConnectionId,
    pub events: mpsc::Receiver<TerminalEvent>,
}

const TERMINAL_EVENT_CAPACITY: usize = 128;

fn terminal_event_channel() -> (mpsc::Sender<TerminalEvent>, mpsc::Receiver<TerminalEvent>) {
    mpsc::channel(TERMINAL_EVENT_CAPACITY)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub forward_id: Uuid,
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub profile_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentKey {
    pub fingerprint: String,
    pub algorithm: String,
    pub comment: String,
    pub certificate: bool,
}

type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

async fn connect_agent() -> anyhow::Result<DynamicAgentClient> {
    #[cfg(unix)]
    {
        return AgentClient::connect_env()
            .await
            .map(|agent| agent.dynamic())
            .map_err(|error| anyhow!("SSH Agent 不可用：{error}"));
    }
    #[cfg(windows)]
    {
        let pipe_candidates = [
            std::env::var("SSH_AUTH_SOCK").ok(),
            Some(r"\\.\pipe\openssh-ssh-agent".to_owned()),
        ];
        for pipe in pipe_candidates.into_iter().flatten() {
            if let Ok(agent) = AgentClient::connect_named_pipe(&pipe).await {
                return Ok(agent.dynamic());
            }
        }
        return AgentClient::connect_pageant()
            .await
            .map(|agent| agent.dynamic())
            .map_err(|error| anyhow!("Windows OpenSSH Agent/Pageant 不可用：{error}"));
    }
    #[allow(unreachable_code)]
    Err(anyhow!("当前平台不支持 SSH Agent"))
}

pub async fn list_agent_keys() -> anyhow::Result<Vec<SshAgentKey>> {
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .context("无法读取 SSH Agent 中的身份")?;
    Ok(identities
        .iter()
        .map(|identity| {
            let key = identity.public_key();
            SshAgentKey {
                fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                algorithm: key.algorithm().as_str().to_owned(),
                comment: identity.comment().to_owned(),
                certificate: matches!(identity, AgentIdentity::Certificate { .. }),
            }
        })
        .collect())
}

#[derive(Debug, Clone)]
struct RemoteForwardTarget {
    bind_host: String,
    bind_port: u16,
    local_host: String,
    local_port: u16,
    profile_id: Option<Uuid>,
}

/// Check the network path needed for an SSH session without opening an SSH
/// authentication session. No password, key, or credential is read here.
pub async fn diagnose_connection(
    host: String,
    port: u16,
    proxy_jump: Option<String>,
) -> anyhow::Result<SshDiagnosticReport> {
    let proxy = match proxy_jump.as_deref() {
        Some(value) => resolve_proxy_jump_async(value).await?,
        None => None,
    };
    let target = diagnose_endpoint(&host, port, proxy.is_none()).await;
    let proxy_report = if let Some(proxy) = proxy {
        Some(diagnose_endpoint(&proxy.host, proxy.port, true).await)
    } else {
        None
    };
    let ready = match &proxy_report {
        Some(report) => report.tcp_reachable == Some(true),
        None => target.tcp_reachable == Some(true),
    };
    Ok(SshDiagnosticReport {
        target,
        proxy_jump: proxy_report,
        uses_proxy_jump: proxy_jump.is_some(),
        ready,
    })
}

async fn diagnose_endpoint(host: &str, port: u16, attempt_tcp: bool) -> EndpointDiagnostic {
    let started = Instant::now();
    let mut report = EndpointDiagnostic {
        host: host.to_owned(),
        port,
        addresses: Vec::new(),
        dns_error: None,
        tcp_reachable: None,
        tcp_error: None,
        issue: None,
        suggestion: None,
        elapsed_ms: 0,
    };
    let addresses = match lookup_host((host, port)).await {
        Ok(addresses) => addresses.collect::<Vec<_>>(),
        Err(error) => {
            report.dns_error = Some(error.to_string());
            report.issue = Some(EndpointDiagnosticIssue::DnsResolutionFailed);
            report.suggestion = Some("检查会话 HostName、DNS、VPN 和代理配置。".into());
            report.elapsed_ms = started.elapsed().as_millis();
            return report;
        }
    };
    report.addresses = addresses.iter().map(ToString::to_string).collect();
    if !attempt_tcp {
        report.elapsed_ms = started.elapsed().as_millis();
        return report;
    }
    if addresses.is_empty() {
        report.tcp_reachable = Some(false);
        report.tcp_error = Some("DNS returned no addresses".into());
        report.issue = Some(EndpointDiagnosticIssue::DnsNoAddresses);
        report.suggestion = Some("DNS 查询没有返回可用地址，请检查域名记录和网络环境。".into());
        report.elapsed_ms = started.elapsed().as_millis();
        return report;
    }
    let mut last_error = None;
    let mut last_issue = None;
    for address in addresses {
        match timeout(Duration::from_secs(5), TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                drop(stream);
                report.tcp_reachable = Some(true);
                report.elapsed_ms = started.elapsed().as_millis();
                return report;
            }
            Ok(Err(error)) => {
                last_issue = Some(classify_tcp_error(&error));
                last_error = Some(error.to_string());
            }
            Err(_) => {
                last_issue = Some(EndpointDiagnosticIssue::ConnectionTimedOut);
                last_error = Some("connection timed out after 5 seconds".into());
            }
        }
    }
    report.tcp_reachable = Some(false);
    report.tcp_error = last_error;
    report.issue = last_issue;
    report.suggestion = report
        .issue
        .map(endpoint_issue_suggestion)
        .map(str::to_owned);
    report.elapsed_ms = started.elapsed().as_millis();
    report
}

fn classify_tcp_error(error: &std::io::Error) -> EndpointDiagnosticIssue {
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => EndpointDiagnosticIssue::ConnectionRefused,
        std::io::ErrorKind::TimedOut => EndpointDiagnosticIssue::ConnectionTimedOut,
        std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::BrokenPipe => EndpointDiagnosticIssue::ConnectionReset,
        std::io::ErrorKind::NetworkUnreachable
        | std::io::ErrorKind::HostUnreachable
        | std::io::ErrorKind::NotConnected
        | std::io::ErrorKind::AddrNotAvailable => EndpointDiagnosticIssue::NetworkUnreachable,
        _ => {
            let lower = error.to_string().to_ascii_lowercase();
            if lower.contains("refused") {
                EndpointDiagnosticIssue::ConnectionRefused
            } else if lower.contains("timed out") || lower.contains("timeout") {
                EndpointDiagnosticIssue::ConnectionTimedOut
            } else if lower.contains("unreachable") || lower.contains("no route") {
                EndpointDiagnosticIssue::NetworkUnreachable
            } else if lower.contains("reset") || lower.contains("broken pipe") {
                EndpointDiagnosticIssue::ConnectionReset
            } else {
                EndpointDiagnosticIssue::TcpConnectionFailed
            }
        }
    }
}

fn endpoint_issue_suggestion(issue: EndpointDiagnosticIssue) -> &'static str {
    match issue {
        EndpointDiagnosticIssue::DnsResolutionFailed => "检查会话 HostName、DNS、VPN 和代理配置。",
        EndpointDiagnosticIssue::DnsNoAddresses => {
            "DNS 查询没有返回可用地址，请检查域名记录和网络环境。"
        }
        EndpointDiagnosticIssue::ConnectionTimedOut => {
            "检查目标端口、防火墙、安全组、VPN 和网络路由。"
        }
        EndpointDiagnosticIssue::ConnectionRefused => {
            "检查 SSH 服务是否启动，以及会话端口是否正确。"
        }
        EndpointDiagnosticIssue::NetworkUnreachable => {
            "检查本机网络、VPN、路由、防火墙和跳板机配置。"
        }
        EndpointDiagnosticIssue::ConnectionReset => {
            "连接被中途关闭，请检查防火墙、代理和远端 SSH 服务日志。"
        }
        EndpointDiagnosticIssue::TcpConnectionFailed => {
            "检查目标地址、端口、网络策略和远端 SSH 服务状态。"
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SshManagerError {
    #[error("connection not found: {0}")]
    ConnectionNotFound(ConnectionId),
    #[error("connection command channel is closed: {0}")]
    ChannelClosed(ConnectionId),
}

#[derive(Debug)]
enum SessionCommand {
    Input(Vec<u8>),
    Resize {
        columns: u16,
        rows: u16,
    },
    AuthResponse {
        challenge_id: Uuid,
        responses: Vec<String>,
    },
    StartLocalForward {
        forward_id: Uuid,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
        reply: oneshot::Sender<anyhow::Result<ForwardInfo>>,
    },
    StartDynamicForward {
        forward_id: Uuid,
        bind_host: String,
        bind_port: u16,
        reply: oneshot::Sender<anyhow::Result<ForwardInfo>>,
    },
    StartRemoteForward {
        forward_id: Uuid,
        bind_host: String,
        bind_port: u16,
        local_host: String,
        local_port: u16,
        reply: oneshot::Sender<anyhow::Result<ForwardInfo>>,
    },
    StartForwardProfile {
        profile: ForwardProfile,
        reply: oneshot::Sender<anyhow::Result<ForwardInfo>>,
    },
    StopForward {
        forward_id: Uuid,
        reply: oneshot::Sender<anyhow::Result<()>>,
    },
    ListForwards {
        reply: oneshot::Sender<anyhow::Result<Vec<ForwardInfo>>>,
    },
    Disconnect,
}

#[derive(Debug, Default)]
struct ManagerInner {
    connections: Mutex<HashMap<ConnectionId, ManagedConnection>>,
}

#[derive(Debug, Clone)]
struct ManagedConnection {
    commands: mpsc::Sender<SessionCommand>,
    output_flow: Arc<TerminalOutputFlow>,
}

/// Removes the connection map entry when the runner task ends — including a
/// panic, which would otherwise leak the entry forever and skew
/// `active_connection_count`. `try_lock` keeps `drop` non-blocking and safe
/// outside a runtime context.
struct ConnectionEntryGuard {
    inner: Arc<ManagerInner>,
    connection_id: ConnectionId,
}

impl Drop for ConnectionEntryGuard {
    fn drop(&mut self) {
        if let Ok(mut connections) = self.inner.connections.try_lock() {
            connections.remove(&self.connection_id);
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SshSessionManager {
    inner: Arc<ManagerInner>,
}

impl SshSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn connect(&self, options: ConnectOptions) -> ConnectionSubscription {
        let connection_id = Uuid::new_v4();
        let (command_tx, command_rx) = mpsc::channel(256);
        let (event_tx, event_rx) = terminal_event_channel();
        let output_flow = Arc::new(TerminalOutputFlow::default());
        self.inner.connections.lock().await.insert(
            connection_id,
            ManagedConnection {
                commands: command_tx,
                output_flow: Arc::clone(&output_flow),
            },
        );

        let inner = Arc::clone(&self.inner);
        let entry_guard = ConnectionEntryGuard {
            inner: Arc::clone(&inner),
            connection_id,
        };
        tokio::spawn(async move {
            if let Err(error) = run_terminal_connection(
                options,
                command_rx,
                event_tx.clone(),
                Arc::clone(&output_flow),
            )
            .await
                && !output_flow.is_closed()
            {
                let _ = event_tx
                    .send(TerminalEvent::Error(humanize_ssh_error(&error)))
                    .await;
                let _ = event_tx
                    .send(TerminalEvent::StateChanged(ConnectionState::Failed))
                    .await;
            }
            let _ = event_tx
                .send(TerminalEvent::StateChanged(ConnectionState::Disconnected))
                .await;
            drop(entry_guard);
        });

        ConnectionSubscription {
            connection_id,
            events: event_rx,
        }
    }

    pub async fn send_input(
        &self,
        connection_id: ConnectionId,
        input: Vec<u8>,
    ) -> Result<(), SshManagerError> {
        self.send(connection_id, SessionCommand::Input(input)).await
    }

    pub async fn resize(
        &self,
        connection_id: ConnectionId,
        columns: u16,
        rows: u16,
    ) -> Result<(), SshManagerError> {
        self.send(connection_id, SessionCommand::Resize { columns, rows })
            .await
    }

    pub async fn disconnect(&self, connection_id: ConnectionId) -> Result<(), SshManagerError> {
        let connection = self.connection(connection_id).await?;
        connection.output_flow.close();
        connection
            .commands
            .send(SessionCommand::Disconnect)
            .await
            .map_err(|_| SshManagerError::ChannelClosed(connection_id))
    }

    pub async fn acknowledge_output(
        &self,
        connection_id: ConnectionId,
        consumed_bytes: u64,
    ) -> Result<(), SshManagerError> {
        self.connection(connection_id)
            .await?
            .output_flow
            .acknowledge(consumed_bytes);
        Ok(())
    }

    pub async fn respond_auth(
        &self,
        connection_id: ConnectionId,
        challenge_id: Uuid,
        responses: Vec<String>,
    ) -> Result<(), SshManagerError> {
        self.send(
            connection_id,
            SessionCommand::AuthResponse {
                challenge_id,
                responses,
            },
        )
        .await
    }

    pub async fn start_local_forward(
        &self,
        connection_id: ConnectionId,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> anyhow::Result<ForwardInfo> {
        self.request(connection_id, |reply| SessionCommand::StartLocalForward {
            forward_id: Uuid::new_v4(),
            bind_host,
            bind_port,
            target_host,
            target_port,
            reply,
        })
        .await
    }

    pub async fn start_dynamic_forward(
        &self,
        connection_id: ConnectionId,
        bind_host: String,
        bind_port: u16,
    ) -> anyhow::Result<ForwardInfo> {
        self.request(connection_id, |reply| SessionCommand::StartDynamicForward {
            forward_id: Uuid::new_v4(),
            bind_host,
            bind_port,
            reply,
        })
        .await
    }

    pub async fn start_remote_forward(
        &self,
        connection_id: ConnectionId,
        bind_host: String,
        bind_port: u16,
        local_host: String,
        local_port: u16,
    ) -> anyhow::Result<ForwardInfo> {
        self.request(connection_id, |reply| SessionCommand::StartRemoteForward {
            forward_id: Uuid::new_v4(),
            bind_host,
            bind_port,
            local_host,
            local_port,
            reply,
        })
        .await
    }

    /// Start a persisted forward using its stable profile id as the runtime id.
    /// Repeating this call for the same connection/profile is idempotent: the
    /// existing runtime is returned by the session command loop.
    pub async fn start_forward_profile(
        &self,
        connection_id: ConnectionId,
        profile: ForwardProfile,
    ) -> anyhow::Result<ForwardInfo> {
        validate_forward_profile(&profile)?;
        self.request(connection_id, |reply| SessionCommand::StartForwardProfile {
            profile,
            reply,
        })
        .await
    }

    pub async fn stop_forward(
        &self,
        connection_id: ConnectionId,
        forward_id: Uuid,
    ) -> anyhow::Result<()> {
        self.request(connection_id, |reply| SessionCommand::StopForward {
            forward_id,
            reply,
        })
        .await
    }

    pub async fn list_forwards(
        &self,
        connection_id: ConnectionId,
    ) -> anyhow::Result<Vec<ForwardInfo>> {
        self.request(connection_id, |reply| SessionCommand::ListForwards {
            reply,
        })
        .await
    }

    pub async fn active_connection_count(&self) -> usize {
        self.inner.connections.lock().await.len()
    }

    /// Every forward control API is the same "oneshot reply + send to the
    /// session loop + await" shape; this keeps the channel-closed error
    /// mapping in one place.
    async fn request<T, F>(&self, connection_id: ConnectionId, build: F) -> anyhow::Result<T>
    where
        F: FnOnce(oneshot::Sender<anyhow::Result<T>>) -> SessionCommand,
    {
        let (reply, receiver) = oneshot::channel();
        self.send(connection_id, build(reply))
            .await
            .map_err(|error| anyhow!(error))?;
        receiver
            .await
            .map_err(|_| anyhow!("SSH 转发管理器已关闭"))?
    }

    async fn send(
        &self,
        connection_id: ConnectionId,
        command: SessionCommand,
    ) -> Result<(), SshManagerError> {
        self.connection(connection_id)
            .await?
            .commands
            .send(command)
            .await
            .map_err(|_| SshManagerError::ChannelClosed(connection_id))
    }

    async fn connection(
        &self,
        connection_id: ConnectionId,
    ) -> Result<ManagedConnection, SshManagerError> {
        self.inner
            .connections
            .lock()
            .await
            .get(&connection_id)
            .cloned()
            .ok_or(SshManagerError::ConnectionNotFound(connection_id))
    }
}

#[derive(Debug)]
struct HostKeyHandler {
    role: HostKeyRole,
    host: String,
    port: u16,
    known_host: Option<KnownHost>,
    event_tx: mpsc::Sender<TerminalEvent>,
    output_flow: Arc<TerminalOutputFlow>,
    remote_forwards: Arc<Mutex<HashMap<Uuid, RemoteForwardTarget>>>,
}

impl client::Handler for HostKeyHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = server_public_key
            .to_openssh()
            .context("could not encode server public key")?;
        let key_type = server_public_key.algorithm().as_str().to_owned();

        match &self.known_host {
            Some(known) if known.fingerprint == fingerprint && known.public_key == public_key => {
                Ok(true)
            }
            Some(known) => {
                let _ = self
                    .event_tx
                    .send(TerminalEvent::StateChanged(ConnectionState::Failed))
                    .await;
                let _ = self
                    .event_tx
                    .send(TerminalEvent::HostKeyChanged {
                        host: self.host.clone(),
                        port: self.port,
                        expected_fingerprint: known.fingerprint.clone(),
                        presented_fingerprint: fingerprint,
                    })
                    .await;
                Ok(false)
            }
            None => {
                let _ = self
                    .event_tx
                    .send(TerminalEvent::StateChanged(
                        ConnectionState::AwaitingHostKey,
                    ))
                    .await;
                let _ = self
                    .event_tx
                    .send(TerminalEvent::HostKeyUnknown(HostKeyApproval {
                        role: self.role,
                        host: self.host.clone(),
                        port: self.port,
                        key_type,
                        fingerprint,
                        public_key,
                    }))
                    .await;
                Ok(false)
            }
        }
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !send_terminal_output(
            &self.event_tx,
            &self.output_flow,
            format!("{banner}\r\n").as_bytes(),
        )
        .await
        {
            bail!("terminal output consumer closed");
        }
        Ok(())
    }

    fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send {
        let remote_forwards = Arc::clone(&self.remote_forwards);
        let connected_address = _connected_address.to_owned();
        let connected_port = _connected_port as u16;
        async move {
            reply.accept().await;
            let target = {
                let forwards = remote_forwards.lock().await;
                forwards
                    .values()
                    .find(|target| {
                        target.bind_port == connected_port && target.bind_host == connected_address
                    })
                    .or_else(|| {
                        forwards
                            .values()
                            .find(|target| target.bind_port == connected_port)
                    })
                    .cloned()
            };
            if let Some(target) = target {
                tokio::spawn(async move {
                    match TcpStream::connect((target.local_host.as_str(), target.local_port)).await
                    {
                        Ok(stream) => {
                            let _ = proxy_channel_with_tcp(channel, stream).await;
                        }
                        Err(_) => {
                            let _ = channel.close().await;
                        }
                    }
                });
            } else {
                let _ = channel.close().await;
            }
            Ok(())
        }
    }
}

async fn send_terminal_output(
    event_tx: &mpsc::Sender<TerminalEvent>,
    output_flow: &TerminalOutputFlow,
    data: &[u8],
) -> bool {
    for chunk in data.chunks(TERMINAL_OUTPUT_CHUNK_BYTES) {
        if !output_flow.reserve(chunk.len()).await {
            return false;
        }
        if event_tx
            .send(TerminalEvent::Output(chunk.to_vec()))
            .await
            .is_err()
        {
            output_flow.close();
            return false;
        }
    }
    true
}

async fn authenticate_with_password_fallback(
    session: &mut client::Handle<HostKeyHandler>,
    username: &str,
    password: &str,
    commands: &mut mpsc::Receiver<SessionCommand>,
    event_tx: &mpsc::Sender<TerminalEvent>,
) -> anyhow::Result<bool> {
    let password_result = session
        .authenticate_password(username.to_owned(), password.to_owned())
        .await
        .context("password authentication exchange failed")?;
    if password_result.success() {
        return Ok(true);
    }

    let mut response = session
        .authenticate_keyboard_interactive_start(username.to_owned(), None)
        .await
        .context("keyboard-interactive authentication exchange failed")?;

    for _ in 0..8 {
        response = match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let use_saved_password = prompts.len() == 1 && !prompts[0].echo;
                let responses = if use_saved_password {
                    vec![password.to_owned()]
                } else {
                    let challenge_id = Uuid::new_v4();
                    event_tx
                        .send(TerminalEvent::AuthChallenge {
                            challenge_id,
                            prompts: prompts
                                .iter()
                                .map(|prompt| AuthPrompt {
                                    prompt: prompt.prompt.clone(),
                                    echo: prompt.echo,
                                })
                                .collect(),
                        })
                        .await
                        .ok();
                    loop {
                        match commands.recv().await {
                            Some(SessionCommand::AuthResponse {
                                challenge_id: response_id,
                                responses,
                            }) if response_id == challenge_id => break responses,
                            Some(SessionCommand::Disconnect) | None => {
                                bail!("authentication cancelled by user")
                            }
                            Some(_) => continue,
                        }
                    }
                };
                if responses.len() != prompts.len() {
                    bail!("authentication response count does not match server prompts")
                }
                session
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .context("keyboard-interactive authentication exchange failed")?
            }
        };
    }

    bail!("keyboard-interactive authentication exceeded the prompt limit")
}

pub async fn authenticate_with_agent<H>(
    session: &mut client::Handle<H>,
    username: &str,
    identity_fingerprint: Option<&str>,
) -> anyhow::Result<bool>
where
    H: client::Handler,
{
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .context("无法读取 SSH Agent 身份列表")?;
    if identities.is_empty() {
        bail!("SSH Agent 中没有可用的密钥");
    }
    let mut candidates = Vec::new();
    for identity in identities {
        let key = identity.public_key().into_owned();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        if identity_fingerprint.is_none_or(|wanted| wanted == fingerprint) {
            candidates.push((key, fingerprint));
        }
    }
    if candidates.is_empty() {
        bail!("SSH Agent 中找不到指定指纹的密钥");
    }
    let hash_algorithm = session
        .best_supported_rsa_hash()
        .await
        .context("failed to negotiate RSA signature algorithm")?
        .flatten();
    for (key, _fingerprint) in candidates {
        let result = session
            .authenticate_publickey_with(username.to_owned(), key, hash_algorithm, &mut agent)
            .await
            .context("SSH Agent 签名认证失败")?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn authenticate_session(
    session: &mut client::Handle<HostKeyHandler>,
    username: &str,
    authentication: RuntimeAuthentication,
    commands: &mut mpsc::Receiver<SessionCommand>,
    event_tx: &mpsc::Sender<TerminalEvent>,
) -> anyhow::Result<&'static str> {
    let (authentication_succeeded, authentication_method) = match authentication {
        RuntimeAuthentication::Password(password) => (
            authenticate_with_password_fallback(
                session,
                username,
                password.as_str(),
                commands,
                event_tx,
            )
            .await?,
            "password or keyboard-interactive",
        ),
        RuntimeAuthentication::PrivateKey {
            private_key_path,
            passphrase,
        } => {
            // Decrypting an encrypted OpenSSH key runs the bcrypt KDF, which
            // can block for hundreds of milliseconds; keep it off the async
            // worker.
            let key = tokio::task::spawn_blocking(move || {
                load_secret_key(
                    &private_key_path,
                    passphrase.as_ref().map(|value| value.as_str()),
                )
            })
            .await
            .context("私钥解密任务失败")?
            .context("无法读取或解密 OpenSSH 私钥")?;
            let hash_algorithm = session
                .best_supported_rsa_hash()
                .await
                .context("failed to negotiate RSA signature algorithm")?
                .flatten();
            (
                session
                    .authenticate_publickey(
                        username.to_owned(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash_algorithm),
                    )
                    .await
                    .context("public-key authentication failed")?
                    .success(),
                "public-key",
            )
        }
        RuntimeAuthentication::Agent {
            identity_fingerprint,
        } => (
            authenticate_with_agent(session, username, identity_fingerprint.as_deref()).await?,
            "ssh-agent",
        ),
    };
    if !authentication_succeeded {
        bail!("SSH server rejected the configured {authentication_method} authentication method");
    }
    Ok(authentication_method)
}

async fn run_terminal_connection(
    options: ConnectOptions,
    mut commands: mpsc::Receiver<SessionCommand>,
    event_tx: mpsc::Sender<TerminalEvent>,
    output_flow: Arc<TerminalOutputFlow>,
) -> anyhow::Result<()> {
    event_tx
        .send(TerminalEvent::StateChanged(ConnectionState::Connecting))
        .await
        .ok();

    let proxy_target = match options.proxy_jump.as_deref() {
        Some(value) => resolve_proxy_jump_async(value).await?,
        None => None,
    };
    let mut proxy_session: Option<client::Handle<HostKeyHandler>> = None;
    let remote_forwards = Arc::new(Mutex::new(HashMap::new()));
    let target_handler = HostKeyHandler {
        role: HostKeyRole::Target,
        host: options.host.clone(),
        port: options.port,
        known_host: options.known_host.clone(),
        event_tx: event_tx.clone(),
        output_flow: Arc::clone(&output_flow),
        remote_forwards: Arc::clone(&remote_forwards),
    };

    let mut session = if let Some(proxy) = proxy_target {
        let proxy_handler = HostKeyHandler {
            role: HostKeyRole::ProxyJump,
            host: proxy.host.clone(),
            port: proxy.port,
            known_host: options.proxy_jump_known_host.clone(),
            event_tx: event_tx.clone(),
            output_flow: Arc::clone(&output_flow),
            remote_forwards: Arc::clone(&remote_forwards),
        };
        let mut jump_session = connect_jump_session(
            Arc::new(client_config(options.keepalive_seconds)),
            &proxy,
            proxy_handler,
        )
        .await?;
        let proxy_username = options
            .proxy_jump_username
            .as_deref()
            .or(proxy.username.as_deref())
            .unwrap_or(&options.username)
            .to_owned();
        let proxy_authentication = options
            .proxy_jump_authentication
            .clone()
            .unwrap_or_else(|| options.authentication.clone());
        authenticate_session(
            &mut jump_session,
            &proxy_username,
            proxy_authentication,
            &mut commands,
            &event_tx,
        )
        .await
        .context("ProxyJump authentication failed")?;
        let target_session = connect_target_via_jump(
            Arc::new(client_config(options.keepalive_seconds)),
            &mut jump_session,
            &options.host,
            options.port,
            target_handler,
        )
        .await?;
        proxy_session = Some(jump_session);
        target_session
    } else {
        client::connect(
            Arc::new(client_config(options.keepalive_seconds)),
            (options.host.as_str(), options.port),
            target_handler,
        )
        .await
        .with_context(|| format!("failed to connect to {}:{}", options.host, options.port))?
    };

    event_tx
        .send(TerminalEvent::StateChanged(ConnectionState::Authenticating))
        .await
        .ok();
    authenticate_session(
        &mut session,
        &options.username,
        options.authentication,
        &mut commands,
        &event_tx,
    )
    .await?;

    let mut channel = session
        .channel_open_session()
        .await
        .context("failed to open SSH session channel")?;
    channel
        .request_pty(
            true,
            &options.terminal.terminal_type,
            options.columns.into(),
            options.rows.into(),
            0,
            0,
            &[],
        )
        .await
        .context("failed to request remote PTY")?;
    channel
        .request_shell(true)
        .await
        .context("failed to request remote shell")?;

    if let Some(initial_directory) = options.initial_directory.as_deref() {
        let initial_directory = initial_directory.trim();
        if !initial_directory.is_empty() {
            let command = format!("cd {}\r", shell_quote(initial_directory));
            channel
                .data_bytes(command.into_bytes())
                .await
                .context("failed to set initial remote directory")?;
        }
    }

    if let Some(startup_command) = options.startup_command.as_deref() {
        let startup_command = normalize_startup_command(startup_command);
        if !startup_command.is_empty() {
            channel
                .data_bytes(startup_command.into_bytes())
                .await
                .context("failed to send session startup command")?;
        }
    }

    event_tx
        .send(TerminalEvent::StateChanged(ConnectionState::Connected))
        .await
        .ok();

    // `client::Handle` methods take `&self`, so sharing it behind a plain Arc
    // keeps concurrent channel opens (forwarding, SOCKS5) parallel instead of
    // serializing them behind a lock held across network round trips.
    let session = Arc::new(session);
    let (accepted_tx, mut accepted_rx) = mpsc::channel::<ForwardAccepted>(128);
    let mut local_forwards: HashMap<Uuid, ForwardRuntime> = HashMap::new();

    loop {
        tokio::select! {
            accepted = accepted_rx.recv() => {
                if let Some(mut accepted) = accepted {
                    let Some(runtime) = local_forwards.get(&accepted.forward_id) else {
                        let _ = accepted.stream.shutdown().await;
                        continue;
                    };
                    match runtime {
                        ForwardRuntime::Local { target_host, target_port, .. } => {
                            let target_host = target_host.clone();
                            let target_port = *target_port;
                            let session = Arc::clone(&session);
                            tokio::spawn(async move {
                                let channel = session
                                    .channel_open_direct_tcpip(
                                        target_host,
                                        target_port.into(),
                                        accepted.origin.ip().to_string(),
                                        accepted.origin.port().into(),
                                    )
                                    .await;
                                match channel {
                                    Ok(channel) => { let _ = proxy_channel_with_tcp(channel, accepted.stream).await; }
                                    Err(_) => { let _ = accepted.stream.shutdown().await; }
                                }
                            });
                        }
                        ForwardRuntime::Dynamic { .. } => {
                            let session = Arc::clone(&session);
                            tokio::spawn(async move {
                                let _ = handle_socks5_connection(&session, accepted.stream, accepted.origin).await;
                            });
                        }
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Input(input)) if !input.is_empty() => {
                        channel.data_bytes(input).await.context("failed to send terminal input")?;
                    }
                    Some(SessionCommand::Resize { columns, rows }) => {
                        channel.window_change(columns.into(), rows.into(), 0, 0)
                            .await
                            .context("failed to resize remote PTY")?;
                    }
                    Some(SessionCommand::Disconnect) | None => {
                        event_tx.send(TerminalEvent::StateChanged(ConnectionState::Disconnecting)).await.ok();
                        channel.close().await.ok();
                        break;
                    }
                    Some(SessionCommand::Input(_)) => {}
                    Some(SessionCommand::AuthResponse { .. }) => {}
                    Some(SessionCommand::StartForwardProfile { profile, reply }) => {
                        let forward_id = profile.id;
                        let existing = if let Some(runtime) = local_forwards.get(&forward_id) {
                            Some(runtime.info().clone())
                        } else {
                            remote_forwards
                                .lock()
                                .await
                                .get(&forward_id)
                                .map(|target| remote_forward_info(forward_id, target))
                        };
                        let reconciliation =
                            forward_profile_reconciliation(existing.as_ref(), &profile);
                        let result = async {
                            match reconciliation {
                                ForwardProfileReconciliation::Reuse => existing.ok_or_else(|| {
                                    anyhow!("端口转发复用失败：运行时信息缺失")
                                }),
                                ForwardProfileReconciliation::Start
                                | ForwardProfileReconciliation::Restart => {
                                    if matches!(reconciliation, ForwardProfileReconciliation::Restart) {
                                        if let Some(runtime) = local_forwards.remove(&forward_id) {
                                            runtime.abort();
                                        } else if let Some(target) = remote_forwards
                                            .lock()
                                            .await
                                            .get(&forward_id)
                                            .cloned()
                                        {
                                            session
                                                .cancel_tcpip_forward(
                                                    target.bind_host.clone(),
                                                    target.bind_port.into(),
                                                )
                                                .await
                                                .map_err(|error| anyhow!("停止远程转发失败：{error}"))?;
                                            remote_forwards.lock().await.remove(&forward_id);
                                        }
                                    }

                                    match profile.kind {
                                        ForwardKind::Local => {
                                            let (target_host, target_port) = match (
                                                profile.target_host,
                                                profile.target_port,
                                            ) {
                                                (Some(host), Some(port)) => (host, port),
                                                _ => bail!("本地端口转发缺少目标地址或端口"),
                                            };
                                            let (listener, mut info) = start_local_listener(
                                                forward_id,
                                                profile.bind_host,
                                                profile.bind_port,
                                                target_host,
                                                target_port,
                                            )
                                            .await?;
                                            info.profile_id = Some(forward_id);
                                            let task = spawn_forward_acceptor(
                                                listener,
                                                info.forward_id,
                                                accepted_tx.clone(),
                                            );
                                            local_forwards.insert(
                                                info.forward_id,
                                                ForwardRuntime::Local {
                                                    task,
                                                    info: info.clone(),
                                                    target_host: info
                                                        .target_host
                                                        .clone()
                                                        .unwrap_or_default(),
                                                    target_port: info.target_port.unwrap_or_default(),
                                                },
                                            );
                                            Ok(info)
                                        }
                                        ForwardKind::Remote => {
                                            let bind_host = profile.bind_host;
                                            let (local_host, local_port) = match (
                                                profile.target_host,
                                                profile.target_port,
                                            ) {
                                                (Some(host), Some(port)) => (host, port),
                                                _ => bail!("远程端口转发缺少目标地址或端口"),
                                            };
                                            let info = session
                                                .tcpip_forward(
                                                    bind_host.clone(),
                                                    profile.bind_port.into(),
                                                )
                                                .await
                                                .map(|port| ForwardInfo {
                                                    forward_id,
                                                    kind: "remote".into(),
                                                    bind_host: bind_host.clone(),
                                                    bind_port: port as u16,
                                                    target_host: Some(local_host.clone()),
                                                    target_port: Some(local_port),
                                                    profile_id: Some(forward_id),
                                                })
                                                .map_err(|error| anyhow!("远程端口转发启动失败：{error}"))?;
                                            remote_forwards.lock().await.insert(
                                                info.forward_id,
                                                RemoteForwardTarget {
                                                    bind_host: info.bind_host.clone(),
                                                    bind_port: info.bind_port,
                                                    local_host,
                                                    local_port,
                                                    profile_id: Some(forward_id),
                                                },
                                            );
                                            Ok(info)
                                        }
                                        ForwardKind::Dynamic => {
                                            let (listener, mut info) = start_dynamic_listener(
                                                forward_id,
                                                profile.bind_host,
                                                profile.bind_port,
                                            )
                                            .await?;
                                            info.profile_id = Some(forward_id);
                                            let task = spawn_forward_acceptor(
                                                listener,
                                                info.forward_id,
                                                accepted_tx.clone(),
                                            );
                                            local_forwards.insert(
                                                info.forward_id,
                                                ForwardRuntime::Dynamic {
                                                    task,
                                                    info: info.clone(),
                                                },
                                            );
                                            Ok(info)
                                        }
                                    }
                                }
                            }
                        }
                        .await;
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::StartLocalForward { forward_id, bind_host, bind_port, target_host, target_port, reply }) => {
                        let result = start_local_listener(forward_id, bind_host, bind_port, target_host, target_port).await;
                        match result {
                            Ok((listener, info)) => {
                                let task = spawn_forward_acceptor(listener, info.forward_id, accepted_tx.clone());
                                local_forwards.insert(info.forward_id, ForwardRuntime::Local {
                                    task,
                                    info: info.clone(),
                                    target_host: info.target_host.clone().unwrap_or_default(),
                                    target_port: info.target_port.unwrap_or_default(),
                                });
                                let _ = reply.send(Ok(info));
                            }
                            Err(error) => { let _ = reply.send(Err(error)); }
                        }
                    }
                    Some(SessionCommand::StartDynamicForward { forward_id, bind_host, bind_port, reply }) => {
                        let result = start_dynamic_listener(forward_id, bind_host, bind_port).await;
                        match result {
                            Ok((listener, info)) => {
                                let task = spawn_forward_acceptor(listener, info.forward_id, accepted_tx.clone());
                                local_forwards.insert(info.forward_id, ForwardRuntime::Dynamic {
                                    task,
                                    info: info.clone(),
                                });
                                let _ = reply.send(Ok(info));
                            }
                            Err(error) => { let _ = reply.send(Err(error)); }
                        }
                    }
                    Some(SessionCommand::StartRemoteForward { forward_id, bind_host, bind_port, local_host, local_port, reply }) => {
                        let result = session.tcpip_forward(bind_host.clone(), bind_port.into()).await
                            .map(|port| ForwardInfo {
                                forward_id,
                                kind: "remote".into(),
                                bind_host: bind_host.clone(),
                                bind_port: port as u16,
                                target_host: Some(local_host.clone()),
                                target_port: Some(local_port),
                                profile_id: None,
                            })
                            .map_err(|error| anyhow!("远程端口转发启动失败：{error}"));
                        if let Ok(info) = &result {
                            remote_forwards.lock().await.insert(info.forward_id, RemoteForwardTarget {
                                bind_host: info.bind_host.clone(),
                                bind_port: info.bind_port,
                                local_host,
                                local_port,
                                profile_id: None,
                            });
                        }
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::StopForward { forward_id, reply }) => {
                        let result = if let Some(runtime) = local_forwards.remove(&forward_id) {
                            runtime.abort();
                            Ok(())
                        } else if let Some(target) = remote_forwards.lock().await.get(&forward_id).cloned() {
                            let result = session.cancel_tcpip_forward(target.bind_host.clone(), target.bind_port.into()).await
                                .map_err(|error| anyhow!("停止远程转发失败：{error}"));
                            if result.is_ok() { remote_forwards.lock().await.remove(&forward_id); }
                            result
                        } else {
                            // Repeated cleanup is expected during reconnects and profile edits.
                            Ok(())
                        };
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::ListForwards { reply }) => {
                        let mut forwards = local_forwards
                            .values()
                            .map(|runtime| runtime.info().clone())
                            .collect::<Vec<_>>();
                        forwards.extend(remote_forwards.lock().await.iter().map(|(forward_id, target)| {
                            remote_forward_info(*forward_id, target)
                        }));
                        let _ = reply.send(Ok(forwards));
                    }
                }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if !send_terminal_output(&event_tx, &output_flow, &data).await {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        event_tx.send(TerminalEvent::ExitStatus(exit_status)).await.ok();
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }

    for runtime in local_forwards.into_values() {
        runtime.abort();
    }
    let remote_targets: Vec<_> = remote_forwards.lock().await.values().cloned().collect();
    for target in remote_targets {
        let _ = session
            .cancel_tcpip_forward(target.bind_host, target.bind_port.into())
            .await;
    }

    session
        .disconnect(Disconnect::ByApplication, "XSH session closed", "en")
        .await
        .ok();
    if let Some(proxy_session) = proxy_session {
        proxy_session
            .disconnect(Disconnect::ByApplication, "XSH ProxyJump closed", "en")
            .await
            .ok();
    }
    Ok(())
}

struct ForwardAccepted {
    forward_id: Uuid,
    stream: TcpStream,
    origin: std::net::SocketAddr,
}

enum ForwardRuntime {
    Local {
        task: JoinHandle<()>,
        info: ForwardInfo,
        target_host: String,
        target_port: u16,
    },
    Dynamic {
        task: JoinHandle<()>,
        info: ForwardInfo,
    },
}

impl ForwardRuntime {
    fn info(&self) -> &ForwardInfo {
        match self {
            Self::Local { info, .. } | Self::Dynamic { info, .. } => info,
        }
    }

    fn abort(self) {
        match self {
            Self::Local { task, .. } | Self::Dynamic { task, .. } => task.abort(),
        }
    }
}

fn remote_forward_info(forward_id: Uuid, target: &RemoteForwardTarget) -> ForwardInfo {
    ForwardInfo {
        forward_id,
        kind: "remote".into(),
        bind_host: target.bind_host.clone(),
        bind_port: target.bind_port,
        target_host: Some(target.local_host.clone()),
        target_port: Some(target.local_port),
        profile_id: target.profile_id,
    }
}

fn spawn_forward_acceptor(
    listener: TcpListener,
    forward_id: Uuid,
    accepted_tx: mpsc::Sender<ForwardAccepted>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok((stream, origin)) = listener.accept().await {
            if accepted_tx
                .send(ForwardAccepted {
                    forward_id,
                    stream,
                    origin,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    })
}

async fn start_local_listener(
    forward_id: Uuid,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> anyhow::Result<(TcpListener, ForwardInfo)> {
    validate_forward_endpoint(&bind_host, &target_host, target_port)?;
    let listener = TcpListener::bind((bind_host.as_str(), bind_port)).await?;
    let actual_port = listener.local_addr()?.port();
    Ok((
        listener,
        ForwardInfo {
            forward_id,
            kind: "local".into(),
            bind_host,
            bind_port: actual_port,
            target_host: Some(target_host),
            target_port: Some(target_port),
            profile_id: None,
        },
    ))
}

async fn start_dynamic_listener(
    forward_id: Uuid,
    bind_host: String,
    bind_port: u16,
) -> anyhow::Result<(TcpListener, ForwardInfo)> {
    if bind_host.trim().is_empty() {
        bail!("动态转发监听地址无效");
    }
    let listener = TcpListener::bind((bind_host.as_str(), bind_port)).await?;
    let actual_port = listener.local_addr()?.port();
    Ok((
        listener,
        ForwardInfo {
            forward_id,
            kind: "dynamic".into(),
            bind_host,
            bind_port: actual_port,
            target_host: None,
            target_port: None,
            profile_id: None,
        },
    ))
}

fn validate_forward_endpoint(
    bind_host: &str,
    target_host: &str,
    target_port: u16,
) -> anyhow::Result<()> {
    if bind_host.trim().is_empty() || target_host.trim().is_empty() || target_port == 0 {
        bail!("端口转发参数无效");
    }
    Ok(())
}

fn validate_forward_profile(profile: &ForwardProfile) -> anyhow::Result<()> {
    if profile.id.is_nil() {
        bail!("端口转发配置 ID 无效");
    }
    if profile.name.trim().is_empty() {
        bail!("端口转发配置名称无效");
    }
    if profile.bind_host.trim().is_empty() {
        bail!("端口转发监听地址无效");
    }
    match profile.kind {
        ForwardKind::Local | ForwardKind::Remote => {
            let target_host = profile
                .target_host
                .as_deref()
                .filter(|host| !host.trim().is_empty())
                .ok_or_else(|| anyhow!("端口转发目标地址无效"))?;
            let target_port = profile
                .target_port
                .filter(|port| *port > 0)
                .ok_or_else(|| anyhow!("端口转发目标端口无效"))?;
            if matches!(profile.kind, ForwardKind::Local) {
                validate_forward_endpoint(&profile.bind_host, target_host, target_port)?;
            }
        }
        ForwardKind::Dynamic => {}
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForwardProfileReconciliation {
    Start,
    Reuse,
    Restart,
}

fn forward_profile_reconciliation(
    existing: Option<&ForwardInfo>,
    profile: &ForwardProfile,
) -> ForwardProfileReconciliation {
    match existing {
        None => ForwardProfileReconciliation::Start,
        Some(info) if forward_info_matches_profile(info, profile) => {
            ForwardProfileReconciliation::Reuse
        }
        Some(_) => ForwardProfileReconciliation::Restart,
    }
}

fn forward_info_matches_profile(info: &ForwardInfo, profile: &ForwardProfile) -> bool {
    let expected_kind = match profile.kind {
        ForwardKind::Local => "local",
        ForwardKind::Remote => "remote",
        ForwardKind::Dynamic => "dynamic",
    };
    info.profile_id == Some(profile.id)
        && info.kind == expected_kind
        && info.bind_host == profile.bind_host
        && (profile.bind_port == 0 || info.bind_port == profile.bind_port)
        && info.target_host.as_deref() == profile.target_host.as_deref()
        && info.target_port == profile.target_port
}

async fn proxy_channel_with_tcp(
    mut channel: russh::Channel<client::Msg>,
    mut stream: TcpStream,
) -> anyhow::Result<()> {
    let mut channel_closed = false;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        tokio::select! {
            read = stream.read(&mut buffer), if !channel_closed => {
                let n = read?;
                if n == 0 { channel.eof().await.ok(); channel_closed = true; } else { channel.data(&buffer[..n]).await?; }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) => stream.write_all(&data).await?,
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

async fn handle_socks5_connection(
    session: &Arc<client::Handle<HostKeyHandler>>,
    mut stream: TcpStream,
    origin: std::net::SocketAddr,
) -> anyhow::Result<()> {
    let (host, target_port) = read_socks5_connect_request(&mut stream).await?;
    let channel = session
        .channel_open_direct_tcpip(
            host.clone(),
            target_port.into(),
            origin.ip().to_string(),
            origin.port().into(),
        )
        .await?;
    stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    proxy_channel_with_tcp(channel, stream).await
}

/// Reads and validates a SOCKS5 greeting plus CONNECT request, sending the
/// no-auth method selection in between. Separated from the connection handler
/// so the byte-level protocol is unit-testable against crafted inputs.
async fn read_socks5_connect_request<R>(stream: &mut R) -> anyhow::Result<(String, u16)>
where
    R: AsyncRead + AsyncWrite + Unpin,
{
    let mut header = [0_u8; 2];
    stream.read_exact(&mut header).await?;
    if header[0] != 5 {
        bail!("仅支持 SOCKS5");
    }
    let mut methods = vec![0_u8; header[1] as usize];
    stream.read_exact(&mut methods).await?;
    stream.write_all(&[5, 0]).await?;
    let mut request = [0_u8; 4];
    stream.read_exact(&mut request).await?;
    if request[0] != 5 || request[1] != 1 {
        bail!("SOCKS5 仅支持 CONNECT");
    }
    let host = match request[3] {
        1 => {
            let mut addr = [0_u8; 4];
            stream.read_exact(&mut addr).await?;
            std::net::Ipv4Addr::from(addr).to_string()
        }
        3 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len).await?;
            let mut value = vec![0_u8; len[0] as usize];
            stream.read_exact(&mut value).await?;
            String::from_utf8(value)?
        }
        4 => {
            let mut addr = [0_u8; 16];
            stream.read_exact(&mut addr).await?;
            std::net::Ipv6Addr::from(addr).to_string()
        }
        _ => bail!("SOCKS5 地址类型不支持"),
    };
    let mut port = [0_u8; 2];
    stream.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

fn client_config(keepalive_seconds: u64) -> client::Config {
    client::Config {
        keepalive_interval: (keepalive_seconds > 0).then(|| Duration::from_secs(keepalive_seconds)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    }
}

/// Connects the ProxyJump host itself. Shared by the terminal and SFTP paths
/// so jump dialing (error contexts included) cannot drift between crates;
/// authentication of the jump host stays with the caller.
pub async fn connect_jump_session<J>(
    config: Arc<client::Config>,
    proxy: &config::ProxyJumpTarget,
    handler: J,
) -> anyhow::Result<client::Handle<J>>
where
    J: client::Handler<Error = anyhow::Error> + Send + 'static,
{
    client::connect(config, (proxy.host.as_str(), proxy.port), handler)
        .await
        .with_context(|| {
            format!(
                "failed to connect to ProxyJump {}:{}",
                proxy.host, proxy.port
            )
        })
}

/// Tunnels the target SSH transport to the caller-supplied handler over a
/// direct-tcpip channel on an authenticated jump session.
pub async fn connect_target_via_jump<J, H>(
    config: Arc<client::Config>,
    jump_session: &mut client::Handle<J>,
    target_host: &str,
    target_port: u16,
    handler: H,
) -> anyhow::Result<client::Handle<H>>
where
    J: client::Handler + Send + 'static,
    H: client::Handler<Error = anyhow::Error> + Send + 'static,
{
    let channel = jump_session
        .channel_open_direct_tcpip(target_host.to_owned(), target_port.into(), "127.0.0.1", 0)
        .await
        .with_context(|| {
            format!("ProxyJump could not open {target_host}:{target_port} over the jump session")
        })?;
    client::connect_stream(config, channel.into_stream(), handler)
        .await
        .with_context(|| {
            format!("failed to connect to {target_host}:{target_port} through ProxyJump")
        })
}

fn normalize_startup_command(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            match chars.next() {
                Some('r') => decoded.push('\r'),
                Some('n') => decoded.push('\n'),
                Some('t') => decoded.push('\t'),
                Some('\\') => decoded.push('\\'),
                Some(other) => {
                    decoded.push('\\');
                    decoded.push(other);
                }
                None => decoded.push('\\'),
            }
        } else {
            decoded.push(character);
        }
    }
    let normalized = decoded.replace("\r\n", "\n").replace('\n', "\r");
    if normalized.ends_with('\r') {
        normalized
    } else {
        format!("{normalized}\r")
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshErrorCategory {
    DnsResolution,
    ConnectionTimeout,
    ConnectionRefused,
    NetworkUnreachable,
    HostKeyChanged,
    HostKeyUntrusted,
    PasswordAuthentication,
    PrivateKeyAuthentication,
    PrivateKeyLoad,
    ProtocolHandshake,
    RemoteClosed,
    Unknown,
}

impl SshErrorCategory {
    fn code(self) -> &'static str {
        match self {
            Self::DnsResolution => "NET_DNS",
            Self::ConnectionTimeout => "NET_TIMEOUT",
            Self::ConnectionRefused => "NET_REFUSED",
            Self::NetworkUnreachable => "NET_UNREACHABLE",
            Self::HostKeyChanged => "HOST_KEY_CHANGED",
            Self::HostKeyUntrusted => "HOST_KEY_UNTRUSTED",
            Self::PasswordAuthentication => "AUTH_PASSWORD",
            Self::PrivateKeyAuthentication => "AUTH_PRIVATE_KEY",
            Self::PrivateKeyLoad => "KEY_LOAD",
            Self::ProtocolHandshake => "SSH_HANDSHAKE",
            Self::RemoteClosed => "REMOTE_CLOSED",
            Self::Unknown => "SSH_UNKNOWN",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::DnsResolution => "无法解析主机名",
            Self::ConnectionTimeout => "连接超时",
            Self::ConnectionRefused => "目标主机拒绝连接",
            Self::NetworkUnreachable => "网络不可达",
            Self::HostKeyChanged => "服务器 Host Key 已变化",
            Self::HostKeyUntrusted => "服务器 Host Key 尚未确认",
            Self::PasswordAuthentication => "密码认证失败",
            Self::PrivateKeyAuthentication => "私钥认证失败",
            Self::PrivateKeyLoad => "无法读取或解密私钥",
            Self::ProtocolHandshake => "SSH 协议握手失败",
            Self::RemoteClosed => "连接被远端关闭",
            Self::Unknown => "SSH 连接失败",
        }
    }

    fn suggestion(self) -> &'static str {
        match self {
            Self::DnsResolution => "请检查 HostName、DNS、VPN 或代理配置",
            Self::ConnectionTimeout => "请检查主机地址、端口、防火墙、安全组和网络/VPN",
            Self::ConnectionRefused => "请检查 SSH 服务是否启动以及端口是否正确",
            Self::NetworkUnreachable => "请检查网络、VPN、路由、防火墙或跳板机配置",
            Self::HostKeyChanged => "请核对服务器指纹；确认服务器重装或密钥轮换后再更新已保存指纹",
            Self::HostKeyUntrusted => "请先核对并信任服务器指纹",
            Self::PasswordAuthentication => "请检查用户名、已保存密码和服务端认证策略",
            Self::PrivateKeyAuthentication => "请检查用户名、公钥部署、私钥类型和服务端认证策略",
            Self::PrivateKeyLoad => "请检查私钥格式、文件权限以及 Key Passphrase",
            Self::ProtocolHandshake => "请检查 SSH 服务版本、加密算法兼容性和中间代理",
            Self::RemoteClosed => "请检查远端 SSH 服务日志、防火墙、空闲超时和 Keepalive 设置",
            Self::Unknown => "请运行连接诊断并检查详细信息",
        }
    }
}

fn classify_ssh_error(details: &str) -> SshErrorCategory {
    let lower = details.to_ascii_lowercase();

    if (lower.contains("host key") || lower.contains("server key"))
        && (lower.contains("changed")
            || lower.contains("mismatch")
            || lower.contains("期望")
            || lower.contains("已变化"))
    {
        SshErrorCategory::HostKeyChanged
    } else if lower.contains("host key") || lower.contains("server key") || lower.contains("指纹")
    {
        SshErrorCategory::HostKeyUntrusted
    } else if lower.contains("failed to load private key")
        || lower.contains("could not load private key")
        || lower.contains("private key file")
        || lower.contains("key passphrase")
        || lower.contains("encrypted private key")
        || lower.contains("invalid openssh key")
        || lower.contains("decode private key")
    {
        SshErrorCategory::PrivateKeyLoad
    } else if lower.contains("public-key authentication")
        || lower.contains("public key authentication")
        || lower.contains("private-key authentication")
        || lower.contains("private key authentication")
    {
        SshErrorCategory::PrivateKeyAuthentication
    } else if lower.contains("authentication")
        || lower.contains("password")
        || lower.contains("keyboard-interactive")
        || lower.contains("permission denied")
    {
        SshErrorCategory::PasswordAuthentication
    } else if lower.contains("connection refused") {
        SshErrorCategory::ConnectionRefused
    } else if lower.contains("timed out") || lower.contains("timeout") {
        SshErrorCategory::ConnectionTimeout
    } else if lower.contains("could not resolve")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
        || lower.contains("dns")
    {
        SshErrorCategory::DnsResolution
    } else if lower.contains("no route")
        || lower.contains("network is unreachable")
        || lower.contains("host is unreachable")
    {
        SshErrorCategory::NetworkUnreachable
    } else if lower.contains("handshake")
        || lower.contains("key exchange")
        || lower.contains("kex")
        || lower.contains("protocol error")
        || lower.contains("invalid ssh identification")
        || lower.contains("ssh banner")
    {
        SshErrorCategory::ProtocolHandshake
    } else if lower.contains("connection reset")
        || lower.contains("closed by remote")
        || lower.contains("connection closed")
        || lower.contains("unexpected eof")
        || lower.contains("broken pipe")
    {
        SshErrorCategory::RemoteClosed
    } else {
        SshErrorCategory::Unknown
    }
}

fn humanize_ssh_error(error: &anyhow::Error) -> String {
    let details = format!("{error:#}");
    let category = classify_ssh_error(&details);
    format!(
        "{}（{}）：{}。",
        category.title(),
        category.code(),
        category.suggestion()
    )
}

pub fn validate_dimensions(columns: u16, rows: u16) -> anyhow::Result<()> {
    if columns == 0 || rows == 0 {
        return Err(anyhow!("terminal dimensions must be greater than zero"));
    }
    if columns > 1_000 || rows > 1_000 {
        return Err(anyhow!("terminal dimensions exceed the supported limit"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_command_is_sent_as_terminal_input() {
        assert_eq!(normalize_startup_command("clear"), "clear\r");
        assert_eq!(
            normalize_startup_command("clear\nwhoami\r"),
            "clear\rwhoami\r"
        );
    }

    #[test]
    fn shell_quote_prevents_command_injection() {
        assert_eq!(shell_quote("/var/www/app"), "'/var/www/app'");
        assert_eq!(shell_quote("/tmp/o'neil"), r#"'/tmp/o'\''neil'"#);
    }

    #[test]
    fn ssh_errors_are_actionable() {
        let error = anyhow!("failed to connect: Connection refused");
        assert!(humanize_ssh_error(&error).contains("拒绝连接"));
        assert_eq!(
            classify_ssh_error("failed to connect: Connection refused"),
            SshErrorCategory::ConnectionRefused
        );

        let error = anyhow!("public-key authentication failed");
        assert!(humanize_ssh_error(&error).contains("私钥认证失败"));
        assert_eq!(
            classify_ssh_error("public-key authentication failed"),
            SshErrorCategory::PrivateKeyAuthentication
        );

        assert_eq!(
            classify_ssh_error("failed to load private key: incorrect key passphrase"),
            SshErrorCategory::PrivateKeyLoad
        );
        assert_eq!(
            classify_ssh_error("SSH handshake failed during key exchange"),
            SshErrorCategory::ProtocolHandshake
        );
        assert_eq!(
            classify_ssh_error("connection reset by peer"),
            SshErrorCategory::RemoteClosed
        );
        assert_eq!(
            classify_ssh_error("Host key changed: fingerprint mismatch"),
            SshErrorCategory::HostKeyChanged
        );
    }

    #[test]
    fn humanize_ssh_error_hides_private_key_path() {
        let error = anyhow!(
            "failed to load private key /Users/alice/.ssh/id_ed25519: incorrect passphrase"
        );
        let message = humanize_ssh_error(&error);
        assert!(!message.contains("/Users/alice"));
        assert!(!message.contains("id_ed25519"));
        assert!(message.contains("私钥"));
    }

    #[test]
    fn tcp_error_classification_is_stable() {
        assert_eq!(
            classify_tcp_error(&std::io::Error::from(std::io::ErrorKind::ConnectionRefused)),
            EndpointDiagnosticIssue::ConnectionRefused
        );
        assert_eq!(
            classify_tcp_error(&std::io::Error::from(std::io::ErrorKind::TimedOut)),
            EndpointDiagnosticIssue::ConnectionTimedOut
        );
        assert_eq!(
            classify_tcp_error(&std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
            EndpointDiagnosticIssue::ConnectionReset
        );
    }

    #[test]
    fn local_forward_validation_allows_ephemeral_bind_port() {
        assert!(validate_forward_endpoint("127.0.0.1", "127.0.0.1", 22).is_ok());
        assert!(validate_forward_endpoint("", "127.0.0.1", 22).is_err());
        assert!(validate_forward_endpoint("127.0.0.1", "", 22).is_err());
        assert!(validate_forward_endpoint("127.0.0.1", "127.0.0.1", 0).is_err());
    }

    #[test]
    fn persisted_forward_profiles_validate_and_match_runtime_info() {
        let profile = ForwardProfile {
            id: Uuid::from_u128(1),
            name: "api tunnel".into(),
            group: Some("APIs".into()),
            kind: ForwardKind::Local,
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            target_host: Some("10.0.0.5".into()),
            target_port: Some(8080),
            auto_start: true,
        };
        assert!(validate_forward_profile(&profile).is_ok());
        let runtime = ForwardInfo {
            forward_id: profile.id,
            kind: "local".into(),
            bind_host: profile.bind_host.clone(),
            bind_port: 41_231,
            target_host: profile.target_host.clone(),
            target_port: profile.target_port,
            profile_id: Some(profile.id),
        };
        assert!(forward_info_matches_profile(&runtime, &profile));

        let mut changed = profile.clone();
        changed.target_port = Some(8081);
        assert!(!forward_info_matches_profile(&runtime, &changed));
    }

    #[test]
    fn persisted_forward_profile_reconciliation_reuses_or_restarts_deterministically() {
        let profile = ForwardProfile {
            id: Uuid::from_u128(3),
            name: "api tunnel".into(),
            group: Some("APIs".into()),
            kind: ForwardKind::Local,
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            target_host: Some("10.0.0.5".into()),
            target_port: Some(8080),
            auto_start: true,
        };
        let runtime = ForwardInfo {
            forward_id: profile.id,
            kind: "local".into(),
            bind_host: profile.bind_host.clone(),
            bind_port: 41_231,
            target_host: profile.target_host.clone(),
            target_port: profile.target_port,
            profile_id: Some(profile.id),
        };

        assert_eq!(
            forward_profile_reconciliation(None, &profile),
            ForwardProfileReconciliation::Start
        );
        assert_eq!(
            forward_profile_reconciliation(Some(&runtime), &profile),
            ForwardProfileReconciliation::Reuse
        );

        let mut changed = profile;
        changed.target_port = Some(8081);
        assert_eq!(
            forward_profile_reconciliation(Some(&runtime), &changed),
            ForwardProfileReconciliation::Restart
        );
    }

    #[test]
    fn persisted_forward_profiles_reject_missing_required_fields() {
        let mut profile = ForwardProfile {
            id: Uuid::from_u128(2),
            name: "invalid".into(),
            group: None,
            kind: ForwardKind::Remote,
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            target_host: None,
            target_port: None,
            auto_start: false,
        };
        assert!(validate_forward_profile(&profile).is_err());
        profile.kind = ForwardKind::Dynamic;
        assert!(validate_forward_profile(&profile).is_ok());
        profile.name = "   ".into();
        assert!(validate_forward_profile(&profile).is_err());
        profile.name = "valid".into();
        profile.id = Uuid::nil();
        assert!(validate_forward_profile(&profile).is_err());
    }

    #[test]
    fn dimensions_must_be_nonzero_and_bounded() {
        assert!(validate_dimensions(80, 24).is_ok());
        assert!(validate_dimensions(0, 24).is_err());
        assert!(validate_dimensions(80, 0).is_err());
        assert!(validate_dimensions(1_001, 24).is_err());
    }

    #[test]
    fn host_key_approval_is_recomputed_before_it_can_be_saved() {
        const ED25519_KEY: &str =
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
        let public_key = PublicKey::from_openssh(&format!("ssh-ed25519 {ED25519_KEY}"))
            .expect("test public key");
        let approval = HostKeyApproval {
            role: HostKeyRole::ProxyJump,
            host: "jump.example.com".into(),
            port: 2222,
            key_type: public_key.algorithm().as_str().into(),
            fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: public_key.to_openssh().unwrap(),
        };

        let known_host = validate_host_key_approval(&approval).unwrap();
        assert_eq!(known_host.host, approval.host);
        assert_eq!(known_host.port, approval.port);
        assert_eq!(known_host.key_type, approval.key_type);
        assert_eq!(known_host.fingerprint, approval.fingerprint);
        assert_eq!(known_host.public_key, approval.public_key);

        let mut changed_fingerprint = approval.clone();
        changed_fingerprint.fingerprint = "SHA256:not-the-presented-key".into();
        assert!(validate_host_key_approval(&changed_fingerprint).is_err());

        let mut changed_algorithm = approval.clone();
        changed_algorithm.key_type = "ssh-rsa".into();
        assert!(validate_host_key_approval(&changed_algorithm).is_err());

        let mut non_canonical = approval;
        non_canonical
            .public_key
            .push_str(" attacker-supplied-comment");
        assert!(validate_host_key_approval(&non_canonical).is_err());
    }

    #[tokio::test]
    async fn manager_reports_unknown_connection() {
        let manager = SshSessionManager::new();
        let id = Uuid::new_v4();
        assert!(matches!(
            manager.send_input(id, vec![b'a']).await,
            Err(SshManagerError::ConnectionNotFound(value)) if value == id
        ));
        assert!(matches!(
            manager.acknowledge_output(id, 1).await,
            Err(SshManagerError::ConnectionNotFound(value)) if value == id
        ));
    }

    #[tokio::test]
    async fn terminal_output_waits_for_renderer_credit_before_sending_more() {
        let flow = Arc::new(TerminalOutputFlow::new(TERMINAL_OUTPUT_CHUNK_BYTES));
        let (events, mut receiver) = terminal_event_channel();
        let output = vec![b'x'; TERMINAL_OUTPUT_CHUNK_BYTES + 1];
        let sending = {
            let flow = Arc::clone(&flow);
            tokio::spawn(async move { send_terminal_output(&events, &flow, &output).await })
        };

        let first = receiver.recv().await.unwrap();
        assert!(matches!(
            first,
            TerminalEvent::Output(ref data) if data.len() == TERMINAL_OUTPUT_CHUNK_BYTES
        ));
        tokio::task::yield_now().await;
        assert!(!sending.is_finished());

        assert_eq!(
            flow.acknowledge(TERMINAL_OUTPUT_CHUNK_BYTES as u64),
            TERMINAL_OUTPUT_CHUNK_BYTES
        );
        assert!(
            timeout(Duration::from_secs(1), sending)
                .await
                .unwrap()
                .unwrap()
        );
        assert!(matches!(
            receiver.recv().await.unwrap(),
            TerminalEvent::Output(data) if data == *b"x"
        ));
    }

    #[test]
    fn terminal_event_channel_has_a_fixed_capacity() {
        let (events, _receiver) = terminal_event_channel();
        for _ in 0..TERMINAL_EVENT_CAPACITY {
            events
                .try_send(TerminalEvent::StateChanged(ConnectionState::Connecting))
                .unwrap();
        }
        assert!(matches!(
            events.try_send(TerminalEvent::StateChanged(ConnectionState::Connecting)),
            Err(mpsc::error::TrySendError::Full(_))
        ));
    }

    /// Feeds `payload` through a duplex and runs the SOCKS5 parser, keeping
    /// the client half alive until parsing finishes (the parser writes the
    /// method-selection reply back on the same stream).
    async fn socks5_parse(payload: &[u8]) -> anyhow::Result<(String, u16)> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut client, mut server) = tokio::io::duplex(256);
        client.write_all(payload).await.unwrap();
        let parsed = read_socks5_connect_request(&mut server).await;
        if parsed.is_ok() {
            let mut reply = [0_u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(&reply, &[5, 0]);
        }
        parsed
    }

    #[tokio::test]
    async fn socks5_parser_reads_ipv4_domain_and_ipv6_connect_requests() {
        let mut ipv4 = vec![5, 1, 0];
        ipv4.extend_from_slice(&[5, 1, 0, 1, 10, 0, 0, 5, 0x1f, 0x90]);
        assert_eq!(
            socks5_parse(&ipv4).await.unwrap(),
            ("10.0.0.5".to_owned(), 8080)
        );

        let mut domain = vec![5, 1, 0, 5, 1, 0, 3, 11];
        domain.extend_from_slice(b"example.com");
        domain.extend_from_slice(&[0, 22]);
        assert_eq!(
            socks5_parse(&domain).await.unwrap(),
            ("example.com".to_owned(), 22)
        );

        let mut ipv6 = vec![5, 1, 0, 5, 1, 0, 4];
        ipv6.extend_from_slice(&[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        ipv6.extend_from_slice(&[0x01, 0xbb]);
        assert_eq!(
            socks5_parse(&ipv6).await.unwrap(),
            ("2001:db8::1".to_owned(), 443)
        );
    }

    #[tokio::test]
    async fn socks5_parser_rejects_other_versions_commands_and_address_types() {
        // SOCKS4 greeting must be rejected.
        let socks4 = [4, 1, 0, 1, 127, 0, 0, 1, 0, 22];
        assert!(
            socks5_parse(&socks4)
                .await
                .unwrap_err()
                .to_string()
                .contains("仅支持 SOCKS5")
        );

        // SOCKS5 BIND (cmd 2) must be rejected.
        let bind = [5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 22];
        assert!(
            socks5_parse(&bind)
                .await
                .unwrap_err()
                .to_string()
                .contains("仅支持 CONNECT")
        );

        // Address type 2 is not assigned by RFC 1928.
        let bad_address_type = [5, 1, 0, 5, 1, 0, 2, 4, 22];
        assert!(
            socks5_parse(&bad_address_type)
                .await
                .unwrap_err()
                .to_string()
                .contains("地址类型不支持")
        );
    }
}
