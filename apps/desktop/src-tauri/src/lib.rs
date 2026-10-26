mod ai;
mod remote_desktop;
mod remote_desktop_bridge;
mod updates;

#[cfg(test)]
use chrono::Utc;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use uuid::Uuid;
use xsh_domain::{
    AuthenticationMethod, ConnectionId, ConnectionState, ForwardProfile, HostKeyApproval,
    HostKeyRole, KnownHost, RemoteDesktopProfile, RemoteEntry, SavedSession, SessionBundle,
    SessionDraft, SessionGroup, SessionGroupDraft, SessionId, SftpTransferPolicy, TerminalEvent,
    TransferEvent, TransferId, TransferListSnapshot,
};
use xsh_security::{
    BackupImportSummary, CredentialKind, CredentialRecord, CredentialStore, LocalCredentialStore,
    SESSION_EXPORT_MAGIC, WORKSPACE_EXPORT_MAGIC, decrypt_export_payload, encrypt_export_payload,
};
use xsh_sftp::{SftpConnectOptions, SftpManager, SftpManagerError};
use xsh_ssh::config::{SshConfigEntry, resolve_proxy_jump_async, user_home_directory};
use xsh_ssh::{
    ConnectOptions, ForwardInfo, RuntimeAuthentication, SshAgentKey, SshDiagnosticReport,
    SshSessionManager, diagnose_connection, list_agent_keys, validate_dimensions,
    validate_host_key_approval,
};
use xsh_storage::SessionRepository;

struct AppState {
    repository: Arc<SessionRepository>,
    credentials: Arc<LocalCredentialStore>,
    credential_lifecycle: tokio::sync::Mutex<()>,
    ssh: SshSessionManager,
    sftp: SftpManager,
    rdp: xsh_rdp::RdpManager,
    /// Live in-app viewer bridges (noVNC): loopback WebSocket listeners that
    /// proxy binary frames to the tunnel/direct TCP target, keyed by port.
    ws_bridges: tokio::sync::Mutex<HashMap<u16, remote_desktop_bridge::RemoteDesktopBridge>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPortDiagnostic {
    status: String,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardHealth {
    forward_id: Uuid,
    status: String,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSyncEntry {
    relative_path: String,
    absolute_path: PathBuf,
    is_directory: bool,
    size: u64,
    modified_at_unix: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportSummary {
    groups_created: usize,
    sessions_created: usize,
    credentials_imported: usize,
    credentials_overwritten: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum SftpConnectResponse {
    Connected {
        #[serde(rename = "connectionId")]
        connection_id: ConnectionId,
    },
    HostKeyUnknown {
        challenge: HostKeyApproval,
    },
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionExportPayload {
    format: String,
    schema_version: u32,
    bundle: SessionBundle,
    credentials: Vec<CredentialRecord>,
}

impl SessionExportPayload {
    const FORMAT: &'static str = "xsh-session-export";
    const SCHEMA_VERSION: u32 = 2;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshKeyDefaults {
    ssh_directory: String,
    default_key_path: Option<String>,
}

type CommandResult<T> = Result<T, String>;

#[tauri::command]
async fn write_text_file(target_path: PathBuf, contents: String) -> CommandResult<()> {
    validate_local_path(&target_path, "文件保存路径")?;
    if contents.len() > 32 * 1024 * 1024 {
        return Err("文本文件不能超过 32 MiB".into());
    }
    tokio::fs::write(&target_path, contents)
        .await
        .map_err(|error| format!("无法保存文本文件：{error}"))?;
    set_private_file_permissions(&target_path)
        .map_err(|error| format!("无法设置文本文件权限：{error}"))
}

#[tauri::command]
async fn read_text_file(source_path: PathBuf) -> CommandResult<String> {
    validate_local_path(&source_path, "文件路径")?;
    let metadata = tokio::fs::metadata(&source_path)
        .await
        .map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("指定路径不是普通文件".into());
    }
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("文本文件不能超过 5 MiB".into());
    }
    tokio::fs::read_to_string(source_path)
        .await
        .map_err(|error| format!("无法读取文本文件：{error}"))
}

#[tauri::command]
async fn list_groups(state: State<'_, AppState>) -> CommandResult<Vec<SessionGroup>> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.list_groups().map_err(display_error)).await
}

#[tauri::command]
async fn create_group(
    state: State<'_, AppState>,
    draft: SessionGroupDraft,
) -> CommandResult<SessionGroup> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.create_group(draft).map_err(display_error)).await
}

#[tauri::command]
async fn update_group(
    state: State<'_, AppState>,
    id: Uuid,
    draft: SessionGroupDraft,
) -> CommandResult<SessionGroup> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.update_group(id, draft).map_err(display_error)).await
}

#[tauri::command]
async fn delete_group(state: State<'_, AppState>, id: Uuid) -> CommandResult<Vec<SessionId>> {
    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    let repository = Arc::clone(&state.repository);
    let deleted_sessions =
        run_storage_operation(move || repository.delete_group(id).map_err(display_error)).await?;
    let deleted_ids = deleted_sessions.iter().map(|session| session.id).collect();
    let mut orphaned_refs = Vec::new();
    for session in deleted_sessions {
        orphaned_refs.extend(session_credential_references(&session));
    }
    cleanup_credentials_if_unused(&state, &orphaned_refs).await;
    Ok(deleted_ids)
}

#[tauri::command]
async fn list_known_hosts(state: State<'_, AppState>) -> CommandResult<Vec<KnownHost>> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.list_known_hosts().map_err(display_error)).await
}

#[tauri::command]
async fn delete_known_host(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> CommandResult<()> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || {
        repository
            .delete_known_host(&host, port)
            .map_err(display_error)
    })
    .await
}

#[tauri::command]
async fn trust_session_host_key(
    state: State<'_, AppState>,
    session_id: SessionId,
    approval: HostKeyApproval,
) -> CommandResult<()> {
    let session = require_session_async(&state, session_id).await?;
    validate_session_host_key_endpoint(&session, &approval).await?;
    let known_host = validate_host_key_approval(&approval).map_err(display_error)?;
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || {
        repository
            .save_known_host(known_host)
            .map_err(display_error)
    })
    .await
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>) -> CommandResult<Vec<SavedSession>> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.list_sessions().map_err(display_error)).await
}

#[tauri::command]
async fn list_ssh_agent_keys() -> CommandResult<Vec<SshAgentKey>> {
    list_agent_keys().await.map_err(display_error)
}

#[tauri::command]
async fn get_ssh_key_defaults() -> CommandResult<SshKeyDefaults> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = user_home_directory().ok_or_else(|| "无法确定当前用户的主目录".to_owned())?;
        let ssh_directory = home.join(".ssh");
        let default_key_path = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"]
            .iter()
            .map(|name| ssh_directory.join(name))
            .find(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned());

        Ok(SshKeyDefaults {
            ssh_directory: ssh_directory.to_string_lossy().into_owned(),
            default_key_path,
        })
    })
    .await
    .map_err(|error| format!("XSH 读取 SSH 密钥默认值线程异常：{error}"))?
}

#[tauri::command]
async fn list_ssh_config_entries() -> CommandResult<Vec<SshConfigEntry>> {
    SshConfigEntry::read_user_config_async()
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn create_session(
    state: State<'_, AppState>,
    draft: SessionDraft,
) -> CommandResult<SavedSession> {
    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    validate_session_draft(&state, &draft, None).await?;
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.create_session(draft).map_err(display_error)).await
}

#[tauri::command]
async fn update_session(
    state: State<'_, AppState>,
    id: SessionId,
    draft: SessionDraft,
) -> CommandResult<SavedSession> {
    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    let previous = require_session_async(&state, id).await?;
    validate_session_draft(&state, &draft, Some(&previous)).await?;
    let repository = Arc::clone(&state.repository);
    let updated =
        run_storage_operation(move || repository.update_session(id, draft).map_err(display_error))
            .await?;
    let previous_refs = session_credential_references(&previous);
    let updated_refs = session_credential_references(&updated);
    let orphaned_refs = previous_refs
        .into_iter()
        .filter(|credential_ref| !updated_refs.iter().any(|current| current == credential_ref))
        .collect::<Vec<_>>();
    cleanup_credentials_if_unused(&state, &orphaned_refs).await;
    Ok(updated)
}

#[tauri::command]
async fn delete_session(state: State<'_, AppState>, id: SessionId) -> CommandResult<()> {
    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    let session = require_session_async(&state, id).await?;
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || repository.delete_session(id).map_err(display_error)).await?;
    let orphaned_refs = session_credential_references(&session);
    cleanup_credentials_if_unused(&state, &orphaned_refs).await;
    Ok(())
}

#[tauri::command]
async fn create_credential(
    state: State<'_, AppState>,
    kind: String,
    secret: String,
) -> CommandResult<String> {
    if secret.is_empty() {
        return Err("credential must not be empty".into());
    }
    let kind = match kind.as_str() {
        "password" => CredentialKind::Password,
        "keyPassphrase" => CredentialKind::PrivateKeyPassphrase,
        "keyboardInteractive" => CredentialKind::KeyboardInteractive,
        _ => return Err(format!("unsupported credential kind: {kind}")),
    };
    credential_create(Arc::clone(&state.credentials), kind, secret).await
}

#[tauri::command]
async fn delete_credential(
    state: State<'_, AppState>,
    credential_ref: String,
) -> CommandResult<()> {
    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    let repository = Arc::clone(&state.repository);
    let sessions =
        run_storage_operation(move || repository.list_sessions().map_err(display_error)).await?;
    ensure_credential_unreferenced(&sessions, &credential_ref)?;
    credential_delete(Arc::clone(&state.credentials), credential_ref).await
}

#[tauri::command]
async fn diagnose_session(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> CommandResult<SshDiagnosticReport> {
    let session = require_session_async(&state, session_id).await?;
    diagnose_connection(session.host, session.port, session.proxy_jump)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn connect_terminal(
    state: State<'_, AppState>,
    session_id: SessionId,
    columns: u16,
    rows: u16,
    on_event: Channel<InvokeResponseBody>,
) -> CommandResult<ConnectionId> {
    validate_dimensions(columns, rows).map_err(display_error)?;
    let session = require_session_async(&state, session_id).await?;
    let authentication = resolve_authentication(&state, &session).await?;
    let proxy_jump_authentication = resolve_proxy_jump_authentication(&state, &session).await?;
    let known_host = find_known_host_for(&state, &session.host, session.port).await?;
    let proxy_jump_known_host =
        find_proxy_jump_known_host(&state, session.proxy_jump.as_deref()).await?;
    let auto_start_profiles = session
        .forward_profiles
        .iter()
        .filter(|profile| profile.auto_start)
        .cloned()
        .collect::<Vec<_>>();
    let auto_start_remote_desktop = session
        .remote_desktop
        .clone()
        .filter(|profile| profile.auto_start)
        .filter(|profile| profile.transport == xsh_domain::RemoteDesktopTransport::SshTunnel);
    let subscription = state
        .ssh
        .connect(ConnectOptions {
            session_id,
            host: session.host.clone(),
            port: session.port,
            username: session.username.clone(),
            proxy_jump: session.proxy_jump.clone(),
            proxy_jump_username: session.proxy_jump_username.clone(),
            proxy_jump_authentication,
            authentication,
            terminal: session.terminal,
            keepalive_seconds: session.keepalive_seconds,
            columns,
            rows,
            initial_directory: session.initial_directory.clone(),
            startup_command: session.startup_command.clone(),
            known_host,
            proxy_jump_known_host,
        })
        .await;
    let connection_id = subscription.connection_id;
    let mut events = subscription.events;
    let ssh = state.ssh.clone();
    let credential_store = Arc::clone(&state.credentials);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let connected = matches!(
                &event,
                TerminalEvent::StateChanged(ConnectionState::Connected)
            );
            // Terminal output dominates the traffic; sending it as raw bytes
            // avoids the ~4x JSON number-array expansion and the per-element
            // decode on the webview side. Control events stay JSON.
            let send_result = match event {
                TerminalEvent::Output(bytes) => on_event.send(InvokeResponseBody::Raw(bytes)),
                event => serde_json::to_string(&event).map_or_else(
                    |error| {
                        tracing::warn!(%error, "序列化终端事件失败");
                        Ok(())
                    },
                    |json| on_event.send(InvokeResponseBody::Json(json)),
                ),
            };
            if send_result.is_err() {
                events.close();
                let _ = ssh.disconnect(connection_id).await;
                break;
            }
            if connected && (!auto_start_profiles.is_empty() || auto_start_remote_desktop.is_some())
            {
                let ssh = ssh.clone();
                let credentials = Arc::clone(&credential_store);
                let profiles = auto_start_profiles.clone();
                let remote_desktop = auto_start_remote_desktop.clone();
                tauri::async_runtime::spawn(async move {
                    for profile in profiles {
                        if let Err(error) = ssh.start_forward_profile(connection_id, profile).await
                        {
                            tracing::warn!(%error, %connection_id, "自动启动持久化端口转发失败");
                        }
                    }
                    if let Some(profile) = remote_desktop
                        && let Err(error) = start_remote_desktop_automatically(
                            &ssh,
                            &credentials,
                            connection_id,
                            &profile,
                        )
                        .await
                    {
                        tracing::warn!(%error, %connection_id, "自动启动远程桌面隧道失败");
                    }
                });
            }
        }
    });
    Ok(connection_id)
}

#[tauri::command]
async fn terminal_write(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    data: String,
) -> CommandResult<()> {
    state
        .ssh
        .send_input(connection_id, data.into_bytes())
        .await
        .map_err(display_error)
}

/// Rare path for bytes that cannot round-trip UTF-8 (xterm `onBinary`, e.g.
/// a bracketed paste of binary clipboard content).
#[tauri::command]
async fn terminal_write_binary(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    data: Vec<u8>,
) -> CommandResult<()> {
    state
        .ssh
        .send_input(connection_id, data)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn terminal_acknowledge_output(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    consumed_bytes: u64,
) -> CommandResult<()> {
    state
        .ssh
        .acknowledge_output(connection_id, consumed_bytes)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn terminal_respond_auth(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    challenge_id: Uuid,
    responses: Vec<String>,
) -> CommandResult<()> {
    if responses.len() > 16 || responses.iter().any(|response| response.len() > 4096) {
        return Err("认证响应过长或数量超限".into());
    }
    state
        .ssh
        .respond_auth(connection_id, challenge_id, responses)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn start_local_forward(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> CommandResult<ForwardInfo> {
    state
        .ssh
        .start_local_forward(
            connection_id,
            bind_host,
            bind_port,
            target_host,
            target_port,
        )
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn start_dynamic_forward(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    bind_host: String,
    bind_port: u16,
) -> CommandResult<ForwardInfo> {
    state
        .ssh
        .start_dynamic_forward(connection_id, bind_host, bind_port)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn start_remote_forward(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    bind_host: String,
    bind_port: u16,
    local_host: String,
    local_port: u16,
) -> CommandResult<ForwardInfo> {
    state
        .ssh
        .start_remote_forward(connection_id, bind_host, bind_port, local_host, local_port)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn start_forward_profile(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    profile: ForwardProfile,
) -> CommandResult<ForwardInfo> {
    state
        .ssh
        .start_forward_profile(connection_id, profile)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn stop_forward(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    forward_id: Uuid,
) -> CommandResult<()> {
    state
        .ssh
        .stop_forward(connection_id, forward_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn list_forwards(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> CommandResult<Vec<ForwardInfo>> {
    state
        .ssh
        .list_forwards(connection_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn diagnose_local_port(
    bind_host: String,
    bind_port: u16,
) -> CommandResult<LocalPortDiagnostic> {
    // Binding probes can stall on firewalled or slow machines; keep the bind
    // off the webview main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let bind_host = bind_host.trim().to_owned();
        if bind_host.is_empty() {
            return Err("监听地址不能为空".into());
        }
        if bind_port == 0 {
            return Ok(LocalPortDiagnostic {
                status: "available".into(),
                detail: "端口 0 会由系统自动分配".into(),
            });
        }
        match std::net::TcpListener::bind((bind_host.as_str(), bind_port)) {
            Ok(listener) => {
                drop(listener);
                Ok(LocalPortDiagnostic {
                    status: "available".into(),
                    detail: format!("{bind_host}:{bind_port} 当前可监听"),
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                Ok(LocalPortDiagnostic {
                    status: "occupied".into(),
                    detail: format!("{bind_host}:{bind_port} 已被本机其他程序占用"),
                })
            }
            Err(error) => Ok(LocalPortDiagnostic {
                status: "unavailable".into(),
                detail: format!("无法监听 {bind_host}:{bind_port}：{error}"),
            }),
        }
    })
    .await
    .map_err(|error| format!("XSH 本地端口诊断线程异常：{error}"))?
}

#[tauri::command]
async fn get_forward_health(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    forward_id: Uuid,
) -> CommandResult<ForwardHealth> {
    let forward = state
        .ssh
        .list_forwards(connection_id)
        .await
        .map_err(display_error)?
        .into_iter()
        .find(|forward| forward.forward_id == forward_id);
    let Some(forward) = forward else {
        return Ok(ForwardHealth {
            forward_id,
            status: "stopped".into(),
            detail: "当前 SSH 连接中未注册此隧道".into(),
        });
    };
    let (status, detail) = if forward.kind == "remote" {
        (
            "unknown",
            "远程监听已向 SSH 服务器申请；客户端无法离线探测远端目标服务".into(),
        )
    } else {
        ("running", "本地监听已在当前 SSH 连接中注册".into())
    };
    Ok(ForwardHealth {
        forward_id,
        status: status.into(),
        detail,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDesktopLaunch {
    forward: ForwardInfo,
}

#[tauri::command]
async fn start_remote_desktop(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    profile: RemoteDesktopProfile,
) -> CommandResult<RemoteDesktopLaunch> {
    profile.validate().map_err(display_error)?;
    if let Some(reference) = profile.credential_ref.as_deref() {
        ensure_session_credential_reference(reference)?;
    }
    let forward = state
        .ssh
        .start_forward_profile(connection_id, profile.forward_profile())
        .await
        .map_err(display_error)?;
    Ok(RemoteDesktopLaunch { forward })
}

struct RemoteDesktopCredentials {
    username: Option<String>,
    password: Option<zeroize::Zeroizing<String>>,
}

async fn resolve_remote_desktop_credentials(
    state: &AppState,
    profile: &RemoteDesktopProfile,
) -> CommandResult<RemoteDesktopCredentials> {
    let password = if let Some(reference) = profile.credential_ref.as_deref() {
        ensure_session_credential_reference(reference)?;
        Some(credential_get(Arc::clone(&state.credentials), reference.to_owned()).await?)
    } else {
        None
    };
    Ok(RemoteDesktopCredentials {
        username: profile.username.clone(),
        password,
    })
}

// Automatic setup creates only an owned tunnel. The frontend attaches the
// built-in desktop; legacy viewer commands are never executed.
async fn start_remote_desktop_automatically(
    ssh: &SshSessionManager,
    _credentials: &Arc<LocalCredentialStore>,
    connection_id: ConnectionId,
    profile: &RemoteDesktopProfile,
) -> Result<(), String> {
    if let Some(reference) = profile.credential_ref.as_deref() {
        ensure_session_credential_reference(reference)?;
    }
    ssh.start_forward_profile(connection_id, profile.forward_profile())
        .await
        .map_err(display_error)?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDesktopWsBridge {
    port: u16,
    token: String,
}

/// Opens a loopback WebSocket bridge for the in-app (noVNC) viewer: binary
/// WebSocket frames proxy bidirectionally to the given TCP endpoint — the
/// tunnel's local listener in SSH mode, or the direct target otherwise.
#[tauri::command]
async fn open_remote_desktop_ws_bridge(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> CommandResult<RemoteDesktopWsBridge> {
    let (ws_port, bridge) = remote_desktop_bridge::RemoteDesktopBridge::open(host, port)
        .await
        .map_err(display_error)?;
    let token = bridge.token.clone();
    state.ws_bridges.lock().await.insert(ws_port, bridge);
    Ok(RemoteDesktopWsBridge {
        port: ws_port,
        token,
    })
}

#[tauri::command]
async fn close_remote_desktop_ws_bridge(
    state: State<'_, AppState>,
    port: u16,
) -> CommandResult<()> {
    let bridge = state.ws_bridges.lock().await.remove(&port);
    if let Some(bridge) = bridge {
        bridge.close().await;
    }
    Ok(())
}

/// Hands the stored remote-desktop password to the in-app viewer: VNC auth
/// runs inside noVNC in the webview, so the secret must cross the IPC
/// boundary to the app's own frontend (never persisted there).
#[tauri::command]
async fn get_remote_desktop_password(
    state: State<'_, AppState>,
    credential_ref: String,
) -> CommandResult<String> {
    ensure_session_credential_reference(&credential_ref)?;
    let store = Arc::clone(&state.credentials);
    run_credential_operation(move || {
        use xsh_security::CredentialStore as _;
        store
            .get(&credential_ref)
            .map(|secret| secret.to_string())
            .map_err(display_error)
    })
    .await
}

#[tauri::command]
async fn terminal_resize(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    columns: u16,
    rows: u16,
) -> CommandResult<()> {
    validate_dimensions(columns, rows).map_err(display_error)?;
    state
        .ssh
        .resize(connection_id, columns, rows)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn disconnect_terminal(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> CommandResult<()> {
    state
        .ssh
        .disconnect(connection_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn connect_sftp(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> CommandResult<SftpConnectResponse> {
    let session = require_session_async(&state, session_id).await?;
    let authentication = resolve_authentication(&state, &session).await?;
    let proxy_jump_authentication = resolve_proxy_jump_authentication(&state, &session).await?;
    let known_host = find_known_host_for(&state, &session.host, session.port).await?;
    let proxy_jump_known_host =
        find_proxy_jump_known_host(&state, session.proxy_jump.as_deref()).await?;
    match state
        .sftp
        .connect(SftpConnectOptions {
            session_id: Some(session_id),
            host: session.host,
            port: session.port,
            username: session.username,
            proxy_jump: session.proxy_jump,
            proxy_jump_username: session.proxy_jump_username,
            proxy_jump_authentication,
            authentication,
            known_host,
            proxy_jump_known_host,
        })
        .await
    {
        Ok(result) => Ok(SftpConnectResponse::Connected {
            connection_id: result.connection_id,
        }),
        Err(SftpManagerError::HostKeyUnknown(challenge)) => {
            Ok(SftpConnectResponse::HostKeyUnknown { challenge })
        }
        Err(error) => Err(display_error(error)),
    }
}

#[tauri::command]
async fn disconnect_sftp(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> CommandResult<()> {
    state
        .sftp
        .disconnect(connection_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn release_sftp_connection(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> CommandResult<()> {
    state
        .sftp
        .release_connection(connection_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn list_transfers(state: State<'_, AppState>) -> CommandResult<TransferListSnapshot> {
    Ok(state.sftp.list_transfers().await)
}

#[tauri::command]
fn configure_sftp_transfers(
    state: State<'_, AppState>,
    policy: SftpTransferPolicy,
) -> CommandResult<SftpTransferPolicy> {
    state
        .sftp
        .set_transfer_policy(policy)
        .map_err(display_error)?;
    state.sftp.transfer_policy().map_err(display_error)
}

#[tauri::command]
async fn pause_transfer(
    state: State<'_, AppState>,
    transfer_id: TransferId,
) -> CommandResult<TransferEvent> {
    state
        .sftp
        .pause_transfer(transfer_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn resume_transfer(
    state: State<'_, AppState>,
    transfer_id: TransferId,
) -> CommandResult<TransferEvent> {
    state
        .sftp
        .resume_transfer(transfer_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn remove_transfer(state: State<'_, AppState>, transfer_id: TransferId) -> CommandResult<()> {
    state
        .sftp
        .remove_transfer(transfer_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn retry_transfer(
    state: State<'_, AppState>,
    transfer_id: TransferId,
    on_event: Channel<TransferEvent>,
) -> CommandResult<TransferId> {
    let subscription = state.sftp.retry_transfer(transfer_id).await.map_err(|error| {
        format!("无法重试原传输：{error}。请确认原主机连接仍可用；连接失效时需在原主机重新选择文件。")
    })?;
    let transfer_id = subscription.transfer_id;
    let mut events = subscription.events;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    Ok(transfer_id)
}

#[tauri::command]
async fn sftp_canonicalize(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    path: String,
) -> CommandResult<String> {
    state
        .sftp
        .canonicalize(connection_id, path)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn sftp_list_directory(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    path: String,
) -> CommandResult<Vec<RemoteEntry>> {
    state
        .sftp
        .list_directory(connection_id, path)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn list_local_sync_entries(
    root_path: PathBuf,
    exclude_patterns: Vec<String>,
) -> CommandResult<Vec<LocalSyncEntry>> {
    // The recursive directory walk with glob matching can take seconds on
    // large trees; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let root = root_path.canonicalize().map_err(display_error)?;
        if !root.is_dir() {
            return Err("同步本地目录不存在或不是文件夹".into());
        }
        let patterns = exclude_patterns
            .into_iter()
            .map(|pattern| pattern.trim().replace('\\', "/"))
            .filter(|pattern| !pattern.is_empty() && !pattern.starts_with('#'))
            .collect::<Vec<_>>();
        let mut entries = Vec::new();
        collect_local_sync_entries(&root, &root, &patterns, &mut entries)?;
        entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(entries)
    })
    .await
    .map_err(|error| format!("XSH 本地目录扫描线程异常：{error}"))?
}

#[tauri::command]
async fn sftp_stat(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    path: String,
) -> CommandResult<RemoteEntry> {
    state
        .sftp
        .stat(connection_id, path)
        .await
        .map_err(display_error)
}

/// A single lstat for transfer previews/conflicts, without recursively scanning a tree.
#[tauri::command]
async fn local_file_info(path: PathBuf) -> CommandResult<Option<RemoteEntry>> {
    validate_local_path(&path, "本地文件路径")?;
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取本地文件信息：{error}")),
    };
    let file_type = if metadata.is_symlink() {
        xsh_domain::RemoteFileType::Symlink
    } else if metadata.is_dir() {
        xsh_domain::RemoteFileType::Directory
    } else if metadata.is_file() {
        xsh_domain::RemoteFileType::File
    } else {
        xsh_domain::RemoteFileType::Other
    };
    Ok(Some(RemoteEntry {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        file_type,
        size: metadata.len(),
        modified_at_unix: metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_secs()),
        permissions: None,
        owner: None,
        group: None,
    }))
}

#[tauri::command]
async fn local_download_directory(app: AppHandle) -> CommandResult<PathBuf> {
    app.path().download_dir().map_err(display_error)
}

/// Shallow local listing for the optional file workspace; never walks subdirectories.
#[tauri::command]
async fn list_local_directory(path: PathBuf) -> CommandResult<Vec<RemoteEntry>> {
    validate_local_path(&path, "本地目录路径")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path).map_err(display_error)? {
            let entry = entry.map_err(display_error)?;
            if entries.len() >= 5000 {
                return Err("本地目录超过 5000 项，请选择范围更小的目录".to_owned());
            }
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(display_error)?;
            let file_type = if metadata.is_symlink() {
                xsh_domain::RemoteFileType::Symlink
            } else if metadata.is_dir() {
                xsh_domain::RemoteFileType::Directory
            } else if metadata.is_file() {
                xsh_domain::RemoteFileType::File
            } else {
                xsh_domain::RemoteFileType::Other
            };
            entries.push(RemoteEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                file_type,
                size: metadata.len(),
                modified_at_unix: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_secs()),
                permissions: None,
                owner: None,
                group: None,
            });
        }
        Ok(entries)
    })
    .await
    .map_err(|error| format!("XSH 本地目录读取线程异常：{error}"))?
}

#[tauri::command]
async fn prepare_remote_edit_path(app: AppHandle, remote_name: String) -> CommandResult<PathBuf> {
    if remote_name.is_empty()
        || remote_name == "."
        || remote_name == ".."
        || remote_name.len() > 255
        || remote_name.contains(['/', '\\'])
    {
        return Err("远程文件名无效，无法创建本地编辑副本".to_owned());
    }
    let directory = app
        .path()
        .temp_dir()
        .map_err(display_error)?
        .join("xsh")
        .join("remote-edit");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&directory).map_err(display_error)?;
        let now = std::time::SystemTime::now();
        if let Ok(entries) = std::fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                let stale = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age > Duration::from_secs(7 * 24 * 60 * 60));
                if stale && path.is_file() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        Ok(directory.join(format!("{}-{remote_name}", Uuid::new_v4())))
    })
    .await
    .map_err(|error| format!("XSH 远程编辑副本准备失败：{error}"))?
}

#[tauri::command]
async fn create_local_directory(path: PathBuf) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_local_path(&path, "本地目录路径")?;
        std::fs::create_dir_all(path).map_err(display_error)
    })
    .await
    .map_err(|error| format!("XSH 创建本地目录线程异常：{error}"))?
}

#[tauri::command]
async fn open_local_path(path: PathBuf) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_local_path(&path, "本地路径")?;
        if !path.exists() {
            return Err(format!("本地文件不存在：{}", path.display()));
        }
        let metadata = std::fs::metadata(&path).map_err(display_error)?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("指定路径不是普通文件或目录".into());
        }
        #[cfg(target_os = "macos")]
        let mut command = Command::new("open");
        #[cfg(target_os = "windows")]
        let mut command = Command::new("explorer.exe");
        #[cfg(target_os = "linux")]
        let mut command = Command::new("xdg-open");
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        return Err("当前平台不支持使用系统默认程序打开文件".to_owned());

        command
            .arg(path)
            .spawn()
            .map_err(|error| format!("无法打开本地文件：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("XSH 打开本地文件线程异常：{error}"))?
}

#[tauri::command]
async fn sftp_create_directory(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    path: String,
) -> CommandResult<()> {
    state
        .sftp
        .create_directory(connection_id, path)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    old_path: String,
    new_path: String,
) -> CommandResult<()> {
    state
        .sftp
        .rename(connection_id, old_path, new_path)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    path: String,
    is_directory: bool,
) -> CommandResult<()> {
    state
        .sftp
        .delete(connection_id, path, is_directory)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    local_path: PathBuf,
    remote_path: String,
    overwrite: bool,
    on_event: Channel<TransferEvent>,
    batch_id: Option<Uuid>,
) -> CommandResult<TransferId> {
    validate_local_path(&local_path, "上传文件路径")?;
    let metadata = tokio::fs::metadata(&local_path)
        .await
        .map_err(|error| format!("无法读取上传文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("上传路径不是普通文件".into());
    }
    let subscription = state
        .sftp
        .upload_in_batch(connection_id, local_path, remote_path, overwrite, batch_id)
        .await
        .map_err(display_error)?;
    let transfer_id = subscription.transfer_id;
    let mut events = subscription.events;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    Ok(transfer_id)
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, AppState>,
    connection_id: ConnectionId,
    remote_path: String,
    local_path: PathBuf,
    overwrite: bool,
    on_event: Channel<TransferEvent>,
    batch_id: Option<Uuid>,
) -> CommandResult<TransferId> {
    validate_local_path(&local_path, "下载文件路径")?;
    let subscription = state
        .sftp
        .download_in_batch(connection_id, remote_path, local_path, overwrite, batch_id)
        .await
        .map_err(display_error)?;
    let transfer_id = subscription.transfer_id;
    let mut events = subscription.events;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    Ok(transfer_id)
}

#[tauri::command]
async fn cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: TransferId,
) -> CommandResult<TransferEvent> {
    state
        .sftp
        .cancel_transfer(transfer_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn export_credentials_backup(
    state: State<'_, AppState>,
    target_path: PathBuf,
    password: String,
) -> CommandResult<()> {
    if password.is_empty() || password.len() > 4096 {
        return Err("备份密码不能为空且不能超过 4096 个字符".into());
    }
    let credentials = Arc::clone(&state.credentials);
    let bytes = run_credential_operation(move || {
        credentials.export_backup(&password).map_err(display_error)
    })
    .await?;
    write_export_file(&target_path, bytes).await
}

#[tauri::command]
async fn inspect_credentials_backup(
    state: State<'_, AppState>,
    source_path: PathBuf,
    password: String,
) -> CommandResult<BackupImportSummary> {
    if password.is_empty() || password.len() > 4096 {
        return Err("备份密码不能为空且不能超过 4096 个字符".into());
    }
    let bytes = read_export_file(&source_path).await?;
    let credentials = Arc::clone(&state.credentials);
    run_credential_operation(move || {
        credentials
            .inspect_backup(&bytes, &password)
            .map_err(display_error)
    })
    .await
}

#[tauri::command]
async fn import_credentials_backup(
    state: State<'_, AppState>,
    source_path: PathBuf,
    password: String,
) -> CommandResult<BackupImportSummary> {
    if password.is_empty() || password.len() > 4096 {
        return Err("备份密码不能为空且不能超过 4096 个字符".into());
    }
    let bytes = read_export_file(&source_path).await?;
    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    let credentials = Arc::clone(&state.credentials);
    run_credential_mutation(move || {
        credentials
            .import_backup(&bytes, &password)
            .map_err(display_error)
    })
    .await
}

#[tauri::command]
async fn export_sessions(
    state: State<'_, AppState>,
    target_path: PathBuf,
    password: String,
    include_known_hosts: bool,
) -> CommandResult<()> {
    export_sessions_impl(&state, target_path, password, include_known_hosts).await
}

async fn export_sessions_impl(
    state: &AppState,
    target_path: PathBuf,
    password: String,
    include_known_hosts: bool,
) -> CommandResult<()> {
    validate_export_password(&password)?;
    let bundle = {
        let repository = Arc::clone(&state.repository);
        run_storage_operation(move || {
            repository
                .export_bundle(include_known_hosts)
                .map_err(display_error)
        })
        .await?
    };
    let credential_refs = bundle
        .sessions
        .iter()
        .flat_map(session_credential_references)
        .collect::<std::collections::BTreeSet<_>>();
    let credential_refs = credential_refs.into_iter().collect::<Vec<_>>();
    for session in &bundle.sessions {
        ensure_authentication_credential_namespace(&session.authentication)?;
        if let Some(authentication) = &session.proxy_jump_authentication {
            ensure_authentication_credential_namespace(authentication)?;
        }
    }
    for reference in &credential_refs {
        ensure_session_credential_reference(reference)?;
    }
    let credentials = if credential_refs.is_empty() {
        Vec::new()
    } else {
        let credentials_store = Arc::clone(&state.credentials);
        run_credential_operation(move || {
            credentials_store
                .export_selected(&credential_refs)
                .map_err(display_error)
        })
        .await?
    };
    let payload = SessionExportPayload {
        format: SessionExportPayload::FORMAT.into(),
        schema_version: SessionExportPayload::SCHEMA_VERSION,
        bundle,
        credentials,
    };
    let payload = serde_json::to_vec(&payload).map_err(display_error)?;
    let encrypted = run_export_crypto_operation(move || {
        encrypt_export_payload(SESSION_EXPORT_MAGIC, &password, &payload).map_err(display_error)
    })
    .await?;
    write_export_file(&target_path, encrypted).await
}

#[tauri::command]
async fn import_sessions(
    state: State<'_, AppState>,
    source_path: PathBuf,
    password: String,
) -> CommandResult<ImportSummary> {
    import_sessions_impl(&state, source_path, password).await
}

async fn import_sessions_impl(
    state: &AppState,
    source_path: PathBuf,
    password: String,
) -> CommandResult<ImportSummary> {
    validate_export_password(&password)?;
    let encrypted = read_export_file(&source_path).await?;
    let json = run_export_crypto_operation(move || {
        decrypt_export_payload(SESSION_EXPORT_MAGIC, &password, &encrypted).map_err(display_error)
    })
    .await?;
    let (bundle, credentials) = match serde_json::from_slice::<SessionExportPayload>(&json) {
        Ok(payload) => {
            if payload.format != SessionExportPayload::FORMAT
                || payload.schema_version != SessionExportPayload::SCHEMA_VERSION
            {
                return Err("会话导出文件版本不受支持，请使用同版本 XSH 重新导出".into());
            }
            (payload.bundle, payload.credentials)
        }
        Err(_) => {
            // Keep importing v1 encrypted session packs created before the
            // session export started carrying credentials. They remain safe,
            // but require a separate credential backup for authentication.
            let mut bundle: SessionBundle = serde_json::from_slice(&json)
                .map_err(|_| "会话导出文件内容无效或版本过旧，请重新导出".to_owned())?;
            for session in &mut bundle.sessions {
                session.authentication = strip_credential_references(&session.authentication);
                session.proxy_jump_authentication = session
                    .proxy_jump_authentication
                    .as_ref()
                    .map(strip_credential_references);
            }
            (bundle, Vec::new())
        }
    };
    bundle.validate().map_err(display_error)?;
    // Validate the complete payload before creating any rows, so malformed
    // startup commands or credentials cannot leave a half-imported directory tree behind.
    for session in &bundle.sessions {
        validate_startup_command(session.startup_command.as_deref())?;
        ensure_authentication_credential_namespace(&session.authentication)?;
        if let Some(authentication) = &session.proxy_jump_authentication {
            ensure_authentication_credential_namespace(authentication)?;
        }
        for reference in session_credential_references(session) {
            ensure_session_credential_reference(&reference)?;
        }
    }
    for credential in &credentials {
        ensure_session_credential_reference(&credential.credential_ref)?;
        if credential.credential_ref.trim().is_empty() || credential.secret.is_empty() {
            return Err("会话导出文件包含无效凭据记录".into());
        }
    }
    let referenced_refs = bundle
        .sessions
        .iter()
        .flat_map(session_credential_references)
        .collect::<std::collections::BTreeSet<_>>();
    let provided_refs = credentials
        .iter()
        .map(|credential| credential.credential_ref.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if referenced_refs.len() != provided_refs.len()
        || referenced_refs
            .iter()
            .any(|reference| !provided_refs.contains(reference.as_str()))
    {
        return Err("会话导出文件中的登录凭据与会话配置不匹配".into());
    }

    let _credential_lifecycle = state.credential_lifecycle.lock().await;
    let group_count = bundle.groups.len();
    let session_count = bundle.sessions.len();
    let repository = Arc::clone(&state.repository);
    let groups_bundle = bundle.groups.clone();
    let group_map = run_storage_operation(move || {
        let mut group_map = HashMap::new();
        for group in &groups_bundle {
            let created = repository
                .create_group(SessionGroupDraft {
                    parent_id: None,
                    name: group.name.clone(),
                    color: group.color.clone(),
                    sort_order: group.sort_order,
                })
                .map_err(display_error)?;
            group_map.insert(group.id, created.id);
        }
        for group in &groups_bundle {
            if let Some(new_id) = group_map.get(&group.id).copied() {
                repository
                    .update_group(
                        new_id,
                        SessionGroupDraft {
                            parent_id: group.parent_id.and_then(|id| group_map.get(&id).copied()),
                            name: group.name.clone(),
                            color: group.color.clone(),
                            sort_order: group.sort_order,
                        },
                    )
                    .map_err(display_error)?;
            }
        }
        Ok(group_map)
    })
    .await?;

    let credentials_store = Arc::clone(&state.credentials);
    let credential_summary = run_credential_mutation(move || {
        credentials_store
            .import_selected(&credentials)
            .map_err(display_error)
    })
    .await?;

    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || {
        for session in &bundle.sessions {
            repository
                .create_session(SessionDraft {
                    kind: session.kind,
                    group_id: session.group_id.and_then(|id| group_map.get(&id).copied()),
                    name: session.name.clone(),
                    host: session.host.clone(),
                    port: session.port,
                    username: session.username.clone(),
                    proxy_jump: session.proxy_jump.clone(),
                    proxy_jump_username: session.proxy_jump_username.clone(),
                    proxy_jump_authentication: session.proxy_jump_authentication.clone(),
                    authentication: session.authentication.clone(),
                    terminal: session.terminal.clone(),
                    forward_profiles: session.forward_profiles.clone(),
                    remote_desktop: session.remote_desktop.clone(),
                    initial_directory: session.initial_directory.clone(),
                    startup_command: session.startup_command.clone(),
                    keepalive_seconds: session.keepalive_seconds,
                    auto_reconnect: session.auto_reconnect,
                    environment: session.environment.clone(),
                    color: session.color.clone(),
                    notes: session.notes.clone(),
                    tags: session.tags.clone(),
                    favorite: session.favorite,
                })
                .map_err(display_error)?;
        }
        Ok(())
    })
    .await?;

    Ok(ImportSummary {
        groups_created: group_count,
        sessions_created: session_count,
        credentials_imported: credential_summary.imported,
        credentials_overwritten: credential_summary.overwritten,
    })
}

#[tauri::command]
async fn export_workspaces(
    target_path: PathBuf,
    password: String,
    payload: String,
) -> CommandResult<()> {
    validate_export_password(&password)?;
    if payload.len() > 5 * 1024 * 1024 {
        return Err("工作区导出文件不能超过 5 MiB".into());
    }
    let payload_bytes = payload.into_bytes();
    let encrypted = run_export_crypto_operation(move || {
        encrypt_export_payload(WORKSPACE_EXPORT_MAGIC, &password, &payload_bytes)
            .map_err(display_error)
    })
    .await?;
    write_export_file(&target_path, encrypted).await
}

#[tauri::command]
async fn import_workspaces(source_path: PathBuf, password: String) -> CommandResult<String> {
    validate_export_password(&password)?;
    let encrypted = read_export_file(&source_path).await?;
    let payload = run_export_crypto_operation(move || {
        decrypt_export_payload(WORKSPACE_EXPORT_MAGIC, &password, &encrypted).map_err(display_error)
    })
    .await?;
    String::from_utf8(payload).map_err(|_| "工作区文件内容不是有效文本".into())
}

fn validate_export_password(password: &str) -> CommandResult<()> {
    if password.trim().is_empty() || password.len() > 4096 {
        return Err("文件密码不能为空且不能超过 4096 个字符".into());
    }
    Ok(())
}

fn validate_local_path(path: &std::path::Path, label: &str) -> CommandResult<()> {
    if path.as_os_str().is_empty() {
        return Err(format!("{label}不能为空"));
    }
    if path.as_os_str().to_string_lossy().contains('\0') {
        return Err(format!("{label}不能包含 NUL 字符"));
    }
    if !path.is_absolute() {
        return Err(format!("{label}必须使用绝对路径"));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        return Err(format!("{label}不能直接使用符号链接"));
    }
    Ok(())
}

fn set_private_file_permissions(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

async fn write_export_file(path: &PathBuf, bytes: Vec<u8>) -> CommandResult<()> {
    if path.as_os_str().is_empty() {
        return Err("文件保存路径不能为空".into());
    }
    validate_local_path(path, "文件保存路径")?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| format!("无法保存加密导出文件：{error}"))?;
    set_private_file_permissions(path).map_err(|error| format!("无法设置导出文件权限：{error}"))
}

async fn read_export_file(path: &PathBuf) -> CommandResult<Vec<u8>> {
    validate_local_path(path, "文件路径")?;
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("无法读取导出文件信息：{error}"))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("导出文件不能超过 5 MiB".into());
    }
    tokio::fs::read(path)
        .await
        .map_err(|error| format!("无法读取加密导出文件：{error}"))
}

async fn find_proxy_jump_known_host(
    state: &AppState,
    proxy_jump: Option<&str>,
) -> CommandResult<Option<KnownHost>> {
    let Some(proxy_jump) = proxy_jump else {
        return Ok(None);
    };
    let proxy = resolve_proxy_jump_async(proxy_jump)
        .await
        .map_err(display_error)?;
    let Some(proxy) = proxy else {
        return Ok(None);
    };
    find_known_host_for(state, &proxy.host, proxy.port).await
}

async fn validate_session_host_key_endpoint(
    session: &SavedSession,
    approval: &HostKeyApproval,
) -> CommandResult<()> {
    let (expected_host, expected_port) = match approval.role {
        HostKeyRole::Target => (session.host.as_str(), session.port),
        HostKeyRole::ProxyJump => {
            let proxy_jump = session
                .proxy_jump
                .as_deref()
                .ok_or_else(|| "该会话未配置 ProxyJump，不能确认此 Host Key".to_owned())?;
            let proxy = resolve_proxy_jump_async(proxy_jump)
                .await
                .map_err(display_error)?
                .ok_or_else(|| "该会话的 ProxyJump 配置为空，不能确认此 Host Key".to_owned())?;
            if approval.host != proxy.host || approval.port != proxy.port {
                return Err(format!(
                    "Host Key 端点与会话 ProxyJump 不匹配：期望 {}:{}，收到 {}:{}",
                    proxy.host, proxy.port, approval.host, approval.port
                ));
            }
            return Ok(());
        }
    };

    if approval.host != expected_host || approval.port != expected_port {
        return Err(format!(
            "Host Key 端点与会话目标不匹配：期望 {expected_host}:{expected_port}，收到 {}:{}",
            approval.host, approval.port
        ));
    }
    Ok(())
}

async fn require_session_async(
    state: &AppState,
    session_id: SessionId,
) -> CommandResult<SavedSession> {
    let repository = Arc::clone(&state.repository);
    run_storage_operation(move || {
        repository
            .get_session(session_id)
            .map_err(display_error)?
            .ok_or_else(|| format!("session not found: {session_id}"))
    })
    .await
}

/// Known-host lookups hit SQLite (and its fsync on commit), so they must ride
/// `run_storage_operation` like every other storage read on async paths.
async fn find_known_host_for(
    state: &AppState,
    host: &str,
    port: u16,
) -> CommandResult<Option<KnownHost>> {
    let repository = Arc::clone(&state.repository);
    let host = host.to_owned();
    run_storage_operation(move || {
        repository
            .find_known_host(&host, port)
            .map_err(display_error)
    })
    .await
}

async fn run_credential_operation<T, F>(operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tokio::time::timeout(
        Duration::from_secs(20),
        tauri::async_runtime::spawn_blocking(operation),
    )
    .await
    .map_err(|_| "XSH 本地凭据库操作超时，请稍后重试".to_owned())?
    .map_err(|error| format!("XSH 本地凭据库操作线程异常：{error}"))?
}

/// SQLite commits (including fsync) must not run on async workers or, for
/// sync commands, on the webview main thread.
async fn run_storage_operation<T, F>(operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tokio::time::timeout(
        Duration::from_secs(20),
        tauri::async_runtime::spawn_blocking(operation),
    )
    .await
    .map_err(|_| "XSH 本地存储操作超时，请稍后重试".to_owned())?
    .map_err(|error| format!("XSH 本地存储操作线程异常：{error}"))?
}

/// Export/import file crypto derives its key with Argon2id (~19 MiB working
/// set, tens to hundreds of milliseconds); it must stay off async workers the
/// same way vault and SQLite operations do.
async fn run_export_crypto_operation<T, F>(operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tokio::time::timeout(
        Duration::from_secs(20),
        tauri::async_runtime::spawn_blocking(operation),
    )
    .await
    .map_err(|_| "XSH 导出文件加密操作超时，请稍后重试".to_owned())?
    .map_err(|error| format!("XSH 导出文件加密线程异常：{error}"))?
}

async fn run_credential_mutation<T, F>(operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("XSH 本地凭据库操作线程异常：{error}"))?
}

async fn credential_create(
    credentials: Arc<LocalCredentialStore>,
    kind: CredentialKind,
    secret: String,
) -> CommandResult<String> {
    run_credential_mutation(move || credentials.create(kind, &secret).map_err(display_error)).await
}

async fn credential_get(
    credentials: Arc<LocalCredentialStore>,
    credential_ref: String,
) -> CommandResult<zeroize::Zeroizing<String>> {
    ensure_session_credential_reference(&credential_ref)?;
    run_credential_operation(move || credentials.get(&credential_ref).map_err(display_error)).await
}

async fn credential_delete(
    credentials: Arc<LocalCredentialStore>,
    credential_ref: String,
) -> CommandResult<()> {
    ensure_session_credential_reference(&credential_ref)?;
    run_credential_mutation(move || credentials.delete(&credential_ref).map_err(display_error))
        .await
}

async fn resolve_authentication(
    state: &AppState,
    session: &SavedSession,
) -> CommandResult<RuntimeAuthentication> {
    resolve_authentication_method(
        state,
        &format!("会话“{}”", session.name),
        &session.authentication,
    )
    .await
}

async fn resolve_proxy_jump_authentication(
    state: &AppState,
    session: &SavedSession,
) -> CommandResult<Option<RuntimeAuthentication>> {
    match session.proxy_jump_authentication.as_ref() {
        Some(authentication) => Ok(Some(
            resolve_authentication_method(
                state,
                &format!("会话“{}”的跳板机", session.name),
                authentication,
            )
            .await?,
        )),
        None => Ok(None),
    }
}

async fn resolve_authentication_method(
    state: &AppState,
    label: &str,
    authentication: &AuthenticationMethod,
) -> CommandResult<RuntimeAuthentication> {
    match authentication {
        AuthenticationMethod::Password { credential_ref }
        | AuthenticationMethod::KeyboardInteractive { credential_ref } => {
            let reference = credential_ref
                .as_ref()
                .ok_or_else(|| format!("{label}没有保存密码，请编辑会话并重新保存密码"))?;
            let secret = credential_get(Arc::clone(&state.credentials), reference.to_owned())
                .await
                .map_err(|error| {
                    format!("无法读取{label}的 XSH 本地凭据：{error}。请重新编辑会话并保存密码")
                })?;
            Ok(RuntimeAuthentication::Password(secret))
        }
        AuthenticationMethod::PrivateKey {
            private_key_path,
            passphrase_ref,
        } => {
            let passphrase = match passphrase_ref {
                Some(reference) => Some(
                    credential_get(Arc::clone(&state.credentials), reference.to_owned()).await?,
                ),
                None => None,
            };
            Ok(RuntimeAuthentication::PrivateKey {
                private_key_path: expand_user_path(private_key_path),
                passphrase,
            })
        }
        AuthenticationMethod::Agent {
            identity_fingerprint,
        } => Ok(RuntimeAuthentication::Agent {
            identity_fingerprint: identity_fingerprint.clone(),
        }),
    }
}

async fn cleanup_credentials_if_unused(state: &State<'_, AppState>, credential_refs: &[String]) {
    if credential_refs.is_empty() {
        return;
    }
    let repository = Arc::clone(&state.repository);
    let sessions = match run_storage_operation(move || {
        repository.list_sessions().map_err(display_error)
    })
    .await
    {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(%error, "无法列出会话以检查未引用凭据，跳过本轮清理");
            return;
        }
    };
    let mut checked = HashSet::new();
    let orphaned = credential_refs
        .iter()
        .filter(|credential_ref| {
            checked.insert((*credential_ref).as_str())
                && !saved_sessions_reference_credential(&sessions, credential_ref)
        })
        .cloned()
        .collect::<Vec<_>>();
    for credential_ref in orphaned {
        if let Err(error) =
            credential_delete(Arc::clone(&state.credentials), credential_ref.clone()).await
        {
            tracing::warn!(%error, credential = %credential_ref, "清理未引用的 XSH 凭据失败");
        }
    }
}

fn saved_sessions_reference_credential(sessions: &[SavedSession], credential_ref: &str) -> bool {
    sessions.iter().any(|session| {
        authentication_pair_references_credential(
            &session.authentication,
            session.proxy_jump_authentication.as_ref(),
            credential_ref,
        ) || session
            .remote_desktop
            .as_ref()
            .and_then(|profile| profile.credential_ref.as_deref())
            == Some(credential_ref)
    })
}

fn ensure_credential_unreferenced(
    sessions: &[SavedSession],
    credential_ref: &str,
) -> CommandResult<()> {
    if saved_sessions_reference_credential(sessions, credential_ref) {
        Err("该凭据仍被已保存会话引用；请先修改或删除相关会话，再删除凭据".into())
    } else {
        Ok(())
    }
}

fn authentication_pair_references_credential(
    authentication: &AuthenticationMethod,
    proxy_jump_authentication: Option<&AuthenticationMethod>,
    credential_ref: &str,
) -> bool {
    credential_reference(authentication) == Some(credential_ref)
        || proxy_jump_authentication.and_then(credential_reference) == Some(credential_ref)
}

fn session_credential_references(session: &SavedSession) -> Vec<String> {
    [
        credential_reference(&session.authentication),
        session
            .proxy_jump_authentication
            .as_ref()
            .and_then(credential_reference),
        session
            .remote_desktop
            .as_ref()
            .and_then(|profile| profile.credential_ref.as_deref()),
    ]
    .into_iter()
    .flatten()
    .map(ToOwned::to_owned)
    .collect()
}

fn credential_reference(authentication: &AuthenticationMethod) -> Option<&str> {
    match authentication {
        AuthenticationMethod::Password { credential_ref }
        | AuthenticationMethod::KeyboardInteractive { credential_ref } => credential_ref.as_deref(),
        AuthenticationMethod::PrivateKey { passphrase_ref, .. } => passphrase_ref.as_deref(),
        AuthenticationMethod::Agent { .. } => None,
    }
}

fn strip_credential_references(authentication: &AuthenticationMethod) -> AuthenticationMethod {
    match authentication {
        AuthenticationMethod::Password { .. } => AuthenticationMethod::Password {
            credential_ref: None,
        },
        AuthenticationMethod::KeyboardInteractive { .. } => {
            AuthenticationMethod::KeyboardInteractive {
                credential_ref: None,
            }
        }
        AuthenticationMethod::PrivateKey {
            private_key_path, ..
        } => AuthenticationMethod::PrivateKey {
            private_key_path: private_key_path.clone(),
            passphrase_ref: None,
        },
        AuthenticationMethod::Agent { .. } => AuthenticationMethod::Agent {
            identity_fingerprint: None,
        },
    }
}

async fn validate_session_draft(
    state: &AppState,
    draft: &SessionDraft,
    previous: Option<&SavedSession>,
) -> CommandResult<()> {
    if draft.name.trim().is_empty() {
        return Err("session name is required".into());
    }
    // Direct remote-desktop sessions never touch an SSH server, so they carry
    // no SSH endpoint; everything else requires the full endpoint.
    let uses_ssh_transport = draft.kind != xsh_domain::SessionKind::RemoteDesktop
        || draft.remote_desktop.as_ref().is_some_and(|profile| {
            profile.transport == xsh_domain::RemoteDesktopTransport::SshTunnel
        });
    if uses_ssh_transport && draft.host.trim().is_empty() {
        return Err("host is required".into());
    }
    if uses_ssh_transport && draft.username.trim().is_empty() {
        return Err("username is required".into());
    }
    if draft.port == 0 {
        return Err("SSH port must be greater than zero".into());
    }
    validate_startup_command(draft.startup_command.as_deref())?;
    if let Some(reference) = draft
        .remote_desktop
        .as_ref()
        .and_then(|profile| profile.credential_ref.as_deref())
    {
        ensure_session_credential_reference(reference)?;
    }
    validate_authentication_reference(
        state,
        &draft.authentication,
        previous.map(|session| &session.authentication),
        "SSH",
    )
    .await?;
    if let Some(authentication) = &draft.proxy_jump_authentication {
        validate_authentication_reference(
            state,
            authentication,
            previous.and_then(|session| session.proxy_jump_authentication.as_ref()),
            "ProxyJump",
        )
        .await?;
    }
    Ok(())
}

fn validate_startup_command(command: Option<&str>) -> CommandResult<()> {
    let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) else {
        return Ok(());
    };
    if command.chars().count() > 4_096 {
        return Err("连接后命令不能超过 4096 个字符".into());
    }
    if command.contains('\0') {
        return Err("连接后命令不能包含 NUL 字符".into());
    }
    let lowered = command.to_ascii_lowercase();
    let sensitive_markers = [
        "password=",
        "passwd=",
        "token=",
        "secret=",
        "authorization:",
        "bearer ",
        "-----begin",
        "private key",
        "私钥",
        "密码",
        "口令",
    ];
    if let Some(marker) = sensitive_markers
        .iter()
        .find(|marker| lowered.contains(**marker))
    {
        return Err(format!(
            "连接后命令疑似包含敏感信息（{marker}）；请改用普通初始化命令，不要保存密码、Token 或私钥"
        ));
    }
    Ok(())
}

fn collect_local_sync_entries(
    root: &std::path::Path,
    directory: &std::path::Path,
    exclude_patterns: &[String],
    entries: &mut Vec<LocalSyncEntry>,
) -> CommandResult<()> {
    for entry in std::fs::read_dir(directory).map_err(display_error)? {
        let entry = entry.map_err(display_error)?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(display_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(display_error)?
            .to_string_lossy()
            .replace('\\', "/");
        if exclude_patterns
            .iter()
            .any(|pattern| sync_glob_match(pattern, &relative_path))
        {
            continue;
        }
        let is_directory = metadata.is_dir();
        let modified_at_unix = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());
        entries.push(LocalSyncEntry {
            relative_path,
            absolute_path: path.clone(),
            is_directory,
            size: metadata.len(),
            modified_at_unix,
        });
        if is_directory {
            collect_local_sync_entries(root, &path, exclude_patterns, entries)?;
        }
    }
    Ok(())
}

fn sync_glob_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    if let Some(directory) = pattern.strip_suffix("/**")
        && value == directory
    {
        return true;
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    // Two rolling rows instead of a full (pattern x value) matrix: this runs
    // once per directory entry per exclude pattern on large sync trees.
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for pattern_index in 1..=pattern.len() {
        let mut current = vec![false; value.len() + 1];
        current[0] = previous[0] && pattern[pattern_index - 1] == '*';
        for value_index in 1..=value.len() {
            current[value_index] = match pattern[pattern_index - 1] {
                '*' => previous[value_index] || current[value_index - 1],
                '?' => previous[value_index - 1],
                character => previous[value_index - 1] && character == value[value_index - 1],
            };
        }
        previous = current;
    }
    previous[value.len()]
}

async fn validate_authentication_reference(
    state: &AppState,
    authentication: &AuthenticationMethod,
    previous: Option<&AuthenticationMethod>,
    label: &str,
) -> CommandResult<()> {
    ensure_authentication_credential_namespace(authentication)?;
    match authentication {
        AuthenticationMethod::Password { credential_ref }
        | AuthenticationMethod::KeyboardInteractive { credential_ref } => {
            let Some(reference) = credential_ref.as_ref() else {
                return Ok(());
            };
            if previous
                .and_then(credential_reference)
                .is_some_and(|previous_reference| previous_reference == reference)
                && !reference.starts_with("xsh-local/")
            {
                // Preserve legacy references during metadata-only updates. XSH
                // never resolves these references anymore; the user must
                // re-enter the secret in the editor to migrate the session.
                return Ok(());
            }
            credential_get(Arc::clone(&state.credentials), reference.to_owned())
                .await
                .map_err(|error| {
                    format!("无法读取 {label} 的 XSH 本地凭据，请重新输入并保存密码：{error}")
                })?;
        }
        AuthenticationMethod::PrivateKey { .. } | AuthenticationMethod::Agent { .. } => {}
    }
    Ok(())
}

fn ensure_session_credential_reference(reference: &str) -> CommandResult<()> {
    if ai::is_ai_credential_reference(reference) {
        return Err("AI API Key 仅能由 AI 服务设置管理，不能用于会话或通用凭据操作".into());
    }
    Ok(())
}

fn ensure_authentication_credential_namespace(
    authentication: &AuthenticationMethod,
) -> CommandResult<()> {
    let reference = match authentication {
        AuthenticationMethod::Password { credential_ref }
        | AuthenticationMethod::KeyboardInteractive { credential_ref } => credential_ref.as_deref(),
        AuthenticationMethod::PrivateKey { passphrase_ref, .. } => passphrase_ref.as_deref(),
        AuthenticationMethod::Agent { .. } => None,
    };
    if let Some(reference) = reference {
        ensure_session_credential_reference(reference)?;
    }
    Ok(())
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn show_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn expand_user_path(path: &std::path::Path) -> PathBuf {
    let value = path.to_string_lossy();
    if value == "~" {
        return user_home_directory().unwrap_or_else(|| path.to_owned());
    }
    let rest = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"));
    if let Some(rest) = rest
        && let Some(home) = user_home_directory()
    {
        return home.join(rest);
    }
    path.to_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(updates::UpdateState::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("xsh.sqlite3");
            let repository = SessionRepository::open(&database_path)?;
            let credentials =
                LocalCredentialStore::open(&database_path, data_dir.join("xsh-vault.key"))?;
            let credentials = Arc::new(credentials);
            app.manage(Arc::new(ai::AiState::new(
                data_dir.join("ai-settings.json"),
                Arc::clone(&credentials),
            )));
            app.manage(AppState {
                repository: Arc::new(repository),
                credentials,
                credential_lifecycle: tokio::sync::Mutex::new(()),
                ssh: SshSessionManager::new(),
                sftp: SftpManager::new(),
                rdp: xsh_rdp::RdpManager::default(),
                ws_bridges: tokio::sync::Mutex::new(HashMap::new()),
            });

            let show = MenuItem::with_id(app, "show", "显示 XSH", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 XSH", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("XSH")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            updates::check_for_updates,
            updates::download_update,
            updates::install_update,
            ai::ai_get_settings,
            ai::ai_save_settings,
            ai::ai_complete,
            ai::ai_stream,
            ai::ai_cancel,
            write_text_file,
            read_text_file,
            list_groups,
            create_group,
            update_group,
            delete_group,
            list_known_hosts,
            delete_known_host,
            trust_session_host_key,
            list_sessions,
            list_ssh_agent_keys,
            get_ssh_key_defaults,
            list_ssh_config_entries,
            create_session,
            update_session,
            delete_session,
            create_credential,
            delete_credential,
            diagnose_session,
            connect_terminal,
            terminal_write,
            terminal_write_binary,
            terminal_acknowledge_output,
            terminal_respond_auth,
            start_local_forward,
            start_dynamic_forward,
            start_remote_forward,
            start_forward_profile,
            stop_forward,
            list_forwards,
            diagnose_local_port,
            get_forward_health,
            start_remote_desktop,
            remote_desktop::start_rdp_desktop,
            remote_desktop::rdp_desktop_input,
            remote_desktop::acknowledge_rdp_frame,
            remote_desktop::answer_rdp_certificate,
            remote_desktop::close_rdp_desktop,
            open_remote_desktop_ws_bridge,
            close_remote_desktop_ws_bridge,
            get_remote_desktop_password,
            terminal_resize,
            disconnect_terminal,
            connect_sftp,
            disconnect_sftp,
            release_sftp_connection,
            list_transfers,
            configure_sftp_transfers,
            pause_transfer,
            resume_transfer,
            remove_transfer,
            retry_transfer,
            sftp_canonicalize,
            sftp_list_directory,
            list_local_sync_entries,
            sftp_stat,
            local_file_info,
            list_local_directory,
            local_download_directory,
            prepare_remote_edit_path,
            create_local_directory,
            open_local_path,
            sftp_create_directory,
            sftp_rename,
            sftp_delete,
            sftp_upload,
            sftp_download,
            cancel_transfer,
            export_credentials_backup,
            inspect_credentials_backup,
            import_credentials_backup,
            export_sessions,
            import_sessions,
            export_workspaces,
            import_workspaces,
        ])
        .build(tauri::generate_context!())
        .expect("error while building XSH")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }

            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use xsh_domain::RemoteDesktopKind;

    fn saved_session(
        authentication: AuthenticationMethod,
        proxy_jump_authentication: Option<AuthenticationMethod>,
    ) -> SavedSession {
        let now = Utc::now();
        SavedSession {
            id: Uuid::new_v4(),
            kind: xsh_domain::SessionKind::Ssh,
            group_id: None,
            name: "credential-reference-test".into(),
            host: "example.com".into(),
            port: 22,
            username: "tester".into(),
            proxy_jump: None,
            proxy_jump_username: None,
            proxy_jump_authentication,
            authentication,
            terminal: Default::default(),
            forward_profiles: Vec::new(),
            remote_desktop: None,
            initial_directory: None,
            startup_command: None,
            keepalive_seconds: 30,
            auto_reconnect: false,
            environment: None,
            color: None,
            notes: None,
            tags: Vec::new(),
            favorite: false,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn credential_reference_check_covers_primary_and_proxy_authentication() {
        let primary_ref = "xsh-local/password/primary";
        let proxy_ref = "xsh-local/key-passphrase/proxy";
        let session = saved_session(
            AuthenticationMethod::Password {
                credential_ref: Some(primary_ref.into()),
            },
            Some(AuthenticationMethod::PrivateKey {
                private_key_path: "~/.ssh/proxy".into(),
                passphrase_ref: Some(proxy_ref.into()),
            }),
        );

        assert!(saved_sessions_reference_credential(
            std::slice::from_ref(&session),
            primary_ref
        ));
        assert!(saved_sessions_reference_credential(
            std::slice::from_ref(&session),
            proxy_ref
        ));
        assert!(!saved_sessions_reference_credential(
            std::slice::from_ref(&session),
            "xsh-local/password/unrelated"
        ));
        assert!(
            ensure_credential_unreferenced(std::slice::from_ref(&session), primary_ref).is_err()
        );
        assert!(
            ensure_credential_unreferenced(
                std::slice::from_ref(&session),
                "xsh-local/password/unrelated"
            )
            .is_ok()
        );
    }

    fn host_key_approval(role: HostKeyRole, host: &str, port: u16) -> HostKeyApproval {
        HostKeyApproval {
            role,
            host: host.into(),
            port,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
            public_key: "ssh-ed25519 AAAA".into(),
        }
    }

    #[tokio::test]
    async fn host_key_approval_endpoint_must_match_its_session_role() {
        let mut session = saved_session(
            AuthenticationMethod::Agent {
                identity_fingerprint: None,
            },
            None,
        );
        session.proxy_jump = Some("jump-user@jump.example.com:2222".into());

        assert!(
            validate_session_host_key_endpoint(
                &session,
                &host_key_approval(HostKeyRole::Target, "example.com", 22)
            )
            .await
            .is_ok()
        );
        assert!(
            validate_session_host_key_endpoint(
                &session,
                &host_key_approval(HostKeyRole::ProxyJump, "jump.example.com", 2222)
            )
            .await
            .is_ok()
        );
        assert!(
            validate_session_host_key_endpoint(
                &session,
                &host_key_approval(HostKeyRole::Target, "jump.example.com", 2222)
            )
            .await
            .is_err()
        );
        assert!(
            validate_session_host_key_endpoint(
                &session,
                &host_key_approval(HostKeyRole::ProxyJump, "example.com", 22)
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn sftp_connect_response_serializes_as_a_discriminated_union() {
        let connection_id = Uuid::new_v4();
        let connected = serde_json::to_value(SftpConnectResponse::Connected { connection_id })
            .expect("serialize connected response");
        assert_eq!(connected["status"], "connected");
        assert_eq!(connected["connectionId"], connection_id.to_string());

        let challenge = host_key_approval(HostKeyRole::ProxyJump, "jump.example.com", 2222);
        let unknown = serde_json::to_value(SftpConnectResponse::HostKeyUnknown {
            challenge: challenge.clone(),
        })
        .expect("serialize challenge response");
        assert_eq!(unknown["status"], "hostKeyUnknown");
        assert_eq!(unknown["challenge"]["role"], "proxyJump");
        assert_eq!(unknown["challenge"]["host"], challenge.host);
    }

    #[test]
    fn local_path_validation_requires_absolute_non_symlink_paths() {
        assert!(validate_local_path(std::path::Path::new("relative.txt"), "文件").is_err());
        assert!(validate_local_path(std::path::Path::new("/tmp/file\0.txt"), "文件").is_err());
        let absolute_path = std::env::temp_dir().join(format!("xsh-path-test-{}", Uuid::new_v4()));
        assert!(validate_local_path(&absolute_path, "文件").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn local_path_validation_rejects_final_symlink() {
        let root = std::env::temp_dir().join(format!("xsh-path-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let real = root.join("real.txt");
        let link = root.join("link.txt");
        std::fs::write(&real, "safe").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert!(validate_local_path(&link, "文件").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn scratch_app_state(label: &str) -> (AppState, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("xsh-import-test-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = directory.join("xsh.sqlite3");
        let repository = SessionRepository::open(&database).unwrap();
        let credentials =
            LocalCredentialStore::open(&database, directory.join("vault.key")).unwrap();
        (
            AppState {
                repository: Arc::new(repository),
                credentials: Arc::new(credentials),
                credential_lifecycle: tokio::sync::Mutex::new(()),
                ssh: SshSessionManager::new(),
                sftp: SftpManager::new(),
                rdp: xsh_rdp::RdpManager::default(),
                ws_bridges: tokio::sync::Mutex::new(HashMap::new()),
            },
            directory,
        )
    }

    #[tokio::test]
    async fn remote_desktop_resolvers_reject_ai_keys_before_viewer_or_tunnel_launch() {
        let (state, directory) = scratch_app_state("ai-remote-desktop-isolation");
        let reference = state
            .credentials
            .create(CredentialKind::AiApiKey, "ai-only-key")
            .unwrap();
        let profile = RemoteDesktopProfile {
            kind: RemoteDesktopKind::Rdp,
            transport: xsh_domain::RemoteDesktopTransport::Direct,
            target_host: "127.0.0.1".into(),
            target_port: None,
            auto_start: false,
            launch_viewer: true,
            viewer_command: None,
            username: Some("desktop-user".into()),
            credential_ref: Some(reference.clone()),
            forward_profile_id: None,
        };
        assert!(
            resolve_remote_desktop_credentials(&state, &profile)
                .await
                .is_err()
        );
        let error = start_remote_desktop_automatically(
            &state.ssh,
            &state.credentials,
            Uuid::new_v4(),
            &profile,
        )
        .await
        .unwrap_err();
        assert!(error.contains("AI API Key"));
        assert_eq!(
            state.credentials.get(&reference).unwrap().as_str(),
            "ai-only-key"
        );
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn export_bundle_fixture(session: SavedSession) -> SessionBundle {
        SessionBundle {
            format: "xsh-session-bundle".into(),
            schema_version: 1,
            exported_at: Utc::now(),
            groups: Vec::new(),
            sessions: vec![session],
            known_hosts: Vec::new(),
        }
    }

    fn write_encrypted_export(path: &std::path::Path, password: &str, payload: &[u8]) {
        let encrypted = encrypt_export_payload(SESSION_EXPORT_MAGIC, password, payload).unwrap();
        std::fs::write(path, encrypted).unwrap();
    }

    #[tokio::test]
    async fn import_sessions_v1_pack_strips_credential_references() {
        let (state, directory) = scratch_app_state("v1");
        let session = saved_session(
            AuthenticationMethod::Password {
                credential_ref: Some("xsh-local/password/legacy".into()),
            },
            Some(AuthenticationMethod::PrivateKey {
                private_key_path: "~/.ssh/legacy".into(),
                passphrase_ref: Some("xsh-local/key-passphrase/legacy".into()),
            }),
        );
        let bundle = export_bundle_fixture(session);
        let export_path = directory.join("v1.xshpack");
        // v1 packs are the bare bundle without the credential envelope.
        write_encrypted_export(
            &export_path,
            "test-password",
            &serde_json::to_vec(&bundle).unwrap(),
        );

        let summary = import_sessions_impl(&state, export_path, "test-password".into())
            .await
            .expect("import v1 pack");

        assert_eq!(summary.groups_created, 0);
        assert_eq!(summary.sessions_created, 1);
        assert_eq!(summary.credentials_imported, 0);
        assert_eq!(summary.credentials_overwritten, 0);

        let imported = state
            .repository
            .list_sessions()
            .unwrap()
            .into_iter()
            .next()
            .expect("imported session");
        assert!(matches!(
            imported.authentication,
            AuthenticationMethod::Password {
                credential_ref: None
            }
        ));
        assert!(matches!(
            imported.proxy_jump_authentication,
            Some(AuthenticationMethod::PrivateKey {
                passphrase_ref: None,
                ..
            })
        ));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[tokio::test]
    async fn import_sessions_v2_restores_credentials_and_rejects_mismatches() {
        let (source, source_directory) = scratch_app_state("v2-source");
        let (target, target_directory) = scratch_app_state("v2-target");

        let credential_ref_from_export = source
            .credentials
            .create(CredentialKind::Password, "secret-value")
            .unwrap();
        let session = saved_session(
            AuthenticationMethod::Password {
                credential_ref: Some(credential_ref_from_export.clone()),
            },
            None,
        );
        let bundle = export_bundle_fixture(session.clone());
        let credentials = source
            .credentials
            .export_selected(std::slice::from_ref(&credential_ref_from_export))
            .unwrap();
        let payload = SessionExportPayload {
            format: SessionExportPayload::FORMAT.into(),
            schema_version: SessionExportPayload::SCHEMA_VERSION,
            bundle,
            credentials,
        };

        let valid_path = source_directory.join("v2.xshpack");
        write_encrypted_export(
            &valid_path,
            "test-password",
            &serde_json::to_vec(&payload).unwrap(),
        );
        let summary = import_sessions_impl(&target, valid_path, "test-password".into())
            .await
            .expect("import v2 export");
        assert_eq!(summary.sessions_created, 1);
        assert_eq!(summary.credentials_imported, 1);
        let imported = target
            .repository
            .list_sessions()
            .unwrap()
            .into_iter()
            .next()
            .expect("imported session");
        assert_eq!(imported.host, session.host);
        assert!(matches!(
            imported.authentication,
            AuthenticationMethod::Password { ref credential_ref } if credential_ref.as_deref() == Some(credential_ref_from_export.as_str())
        ));
        assert!(target.credentials.get(&credential_ref_from_export).is_ok());

        // A payload whose credentials do not cover every referenced ref is
        // rejected before anything is written.
        let mut mismatched = payload;
        mismatched.credentials = Vec::new();
        mismatched.bundle.sessions = vec![saved_session(
            AuthenticationMethod::Password {
                credential_ref: Some("xsh-local/password/missing".into()),
            },
            None,
        )];
        let mismatch_path = source_directory.join("v2-mismatch.xshpack");
        write_encrypted_export(
            &mismatch_path,
            "test-password",
            &serde_json::to_vec(&mismatched).unwrap(),
        );
        let error = import_sessions_impl(&target, mismatch_path, "test-password".into())
            .await
            .expect_err("credential/session mismatch must fail");
        assert!(error.contains("不匹配"));
        assert_eq!(target.repository.list_sessions().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&source_directory);
        let _ = std::fs::remove_dir_all(&target_directory);
    }
}
