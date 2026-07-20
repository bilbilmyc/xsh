use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use xsh_domain::{
    AuthenticationMethod, ConnectionId, KnownHost, RemoteEntry, SavedSession, SessionBundle,
    SessionDraft, SessionGroup, SessionGroupDraft, SessionId, TerminalEvent, TransferEvent,
    TransferId,
};
use xsh_security::{CredentialKind, CredentialStore, LocalCredentialStore};
use xsh_sftp::{SftpConnectOptions, SftpManager};
use xsh_ssh::config::SshConfigEntry;
use xsh_ssh::known_hosts::read_user_known_host;
use xsh_ssh::{
    ConnectOptions, ForwardInfo, RuntimeAuthentication, SshAgentKey, SshDiagnosticReport,
    SshSessionManager, diagnose_connection, list_agent_keys, validate_dimensions,
};
use xsh_storage::SessionRepository;

struct AppState {
    repository: Arc<SessionRepository>,
    credentials: Arc<LocalCredentialStore>,
    ssh: SshSessionManager,
    sftp: SftpManager,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportSummary {
    groups_created: usize,
    sessions_created: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTreeEntry {
    local_path: String,
    relative_path: String,
    is_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshKeyDefaults {
    ssh_directory: String,
    default_key_path: Option<String>,
}

type CommandResult<T> = Result<T, String>;

#[tauri::command]
fn clipboard_write(text: String) -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("pbcopy");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            "$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
        ]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xclip");
    #[cfg(target_os = "linux")]
    command.args(["-selection", "clipboard"]);

    let mut child = command
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法访问系统剪贴板：{error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "无法打开系统剪贴板写入通道".to_owned())?
        .write_all(text.as_bytes())
        .map_err(|error| format!("无法写入系统剪贴板：{error}"))?;
    let status = child
        .wait()
        .map_err(|error| format!("系统剪贴板进程失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("系统剪贴板进程退出码：{}", status))
    }
}

#[tauri::command]
fn clipboard_read() -> CommandResult<String> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("pbpaste");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-STA",
            "-Command",
            "[Console]::Out.Write((Get-Clipboard -Raw))",
        ]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xclip");
    #[cfg(target_os = "linux")]
    command.args(["-selection", "clipboard", "-o"]);

    let output = command
        .output()
        .map_err(|error| format!("无法读取系统剪贴板：{error}"))?;
    if !output.status.success() {
        return Err(format!("系统剪贴板进程退出码：{}", output.status));
    }
    String::from_utf8(output.stdout).map_err(|error| format!("系统剪贴板内容不是有效文本：{error}"))
}

#[tauri::command]
async fn write_text_file(target_path: PathBuf, contents: String) -> CommandResult<()> {
    if target_path.as_os_str().is_empty() {
        return Err("文件保存路径不能为空".into());
    }
    tokio::fs::write(target_path, contents)
        .await
        .map_err(|error| format!("无法保存文本文件：{error}"))
}

#[tauri::command]
async fn read_text_file(source_path: PathBuf) -> CommandResult<String> {
    if source_path.as_os_str().is_empty() {
        return Err("文件路径不能为空".into());
    }
    let metadata = tokio::fs::metadata(&source_path)
        .await
        .map_err(|error| format!("无法读取文件信息：{error}"))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("文本文件不能超过 5 MiB".into());
    }
    tokio::fs::read_to_string(source_path)
        .await
        .map_err(|error| format!("无法读取文本文件：{error}"))
}

#[tauri::command]
fn list_groups(state: State<'_, AppState>) -> CommandResult<Vec<SessionGroup>> {
    state.repository.list_groups().map_err(display_error)
}

#[tauri::command]
fn create_group(
    state: State<'_, AppState>,
    draft: SessionGroupDraft,
) -> CommandResult<SessionGroup> {
    state.repository.create_group(draft).map_err(display_error)
}

#[tauri::command]
fn update_group(
    state: State<'_, AppState>,
    id: Uuid,
    draft: SessionGroupDraft,
) -> CommandResult<SessionGroup> {
    state
        .repository
        .update_group(id, draft)
        .map_err(display_error)
}

#[tauri::command]
async fn delete_group(state: State<'_, AppState>, id: Uuid) -> CommandResult<Vec<SessionId>> {
    let deleted_sessions = state.repository.delete_group(id).map_err(display_error)?;
    let deleted_ids = deleted_sessions.iter().map(|session| session.id).collect();
    for session in deleted_sessions {
        for credential_ref in session_credential_references(&session) {
            cleanup_credential_if_unused(&state, &credential_ref).await;
        }
    }
    Ok(deleted_ids)
}

#[tauri::command]
fn list_known_hosts(state: State<'_, AppState>) -> CommandResult<Vec<KnownHost>> {
    state.repository.list_known_hosts().map_err(display_error)
}

#[tauri::command]
fn delete_known_host(state: State<'_, AppState>, host: String, port: u16) -> CommandResult<()> {
    state
        .repository
        .delete_known_host(&host, port)
        .map_err(display_error)
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> CommandResult<Vec<SavedSession>> {
    state.repository.list_sessions().map_err(display_error)
}

#[tauri::command]
async fn list_ssh_agent_keys() -> CommandResult<Vec<SshAgentKey>> {
    list_agent_keys().await.map_err(display_error)
}

#[tauri::command]
fn get_ssh_key_defaults() -> CommandResult<SshKeyDefaults> {
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
}

#[tauri::command]
fn list_ssh_config_entries() -> CommandResult<Vec<SshConfigEntry>> {
    SshConfigEntry::read_user_config().map_err(display_error)
}

#[tauri::command]
async fn create_session(
    state: State<'_, AppState>,
    draft: SessionDraft,
) -> CommandResult<SavedSession> {
    validate_session_draft(&state, &draft, None).await?;
    state
        .repository
        .create_session(draft)
        .map_err(display_error)
}

#[tauri::command]
async fn update_session(
    state: State<'_, AppState>,
    id: SessionId,
    draft: SessionDraft,
) -> CommandResult<SavedSession> {
    let previous = require_session(&state, id)?;
    validate_session_draft(&state, &draft, Some(&previous)).await?;
    let updated = state
        .repository
        .update_session(id, draft)
        .map_err(display_error)?;
    let previous_refs = session_credential_references(&previous);
    let updated_refs = session_credential_references(&updated);
    for credential_ref in previous_refs
        .into_iter()
        .filter(|credential_ref| !updated_refs.iter().any(|current| current == credential_ref))
    {
        cleanup_credential_if_unused(&state, &credential_ref).await;
    }
    Ok(updated)
}

#[tauri::command]
async fn delete_session(state: State<'_, AppState>, id: SessionId) -> CommandResult<()> {
    let session = require_session(&state, id)?;
    state.repository.delete_session(id).map_err(display_error)?;
    for credential_ref in session_credential_references(&session) {
        cleanup_credential_if_unused(&state, &credential_ref).await;
    }
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
    credential_delete(Arc::clone(&state.credentials), credential_ref).await
}

#[tauri::command]
async fn diagnose_session(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> CommandResult<SshDiagnosticReport> {
    let session = require_session(&state, session_id)?;
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
    trust_unknown_host: bool,
    on_event: Channel<TerminalEvent>,
) -> CommandResult<ConnectionId> {
    validate_dimensions(columns, rows).map_err(display_error)?;
    let session = require_session(&state, session_id)?;
    let authentication = resolve_authentication(&state, &session).await?;
    let proxy_jump_authentication = resolve_proxy_jump_authentication(&state, &session).await?;
    let known_host = state
        .repository
        .find_known_host(&session.host, session.port)
        .map_err(display_error)?
        .or_else(|| {
            // Reuse the user's OpenSSH trust database when XSH has not seen
            // this host yet. A malformed or unreadable system file should not
            // prevent a normal first connection, so this lookup is best-effort.
            read_user_known_host(&session.host, session.port)
                .ok()
                .flatten()
        });
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
            trust_unknown_host,
        })
        .await;
    let connection_id = subscription.connection_id;
    let repository = Arc::clone(&state.repository);
    let mut events = subscription.events;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if trust_unknown_host
                && let TerminalEvent::HostKeyUnknown {
                    host,
                    port,
                    key_type,
                    fingerprint,
                    public_key,
                } = &event
            {
                let now = Utc::now();
                let _ = repository.save_known_host(KnownHost {
                    host: host.clone(),
                    port: *port,
                    key_type: key_type.clone(),
                    fingerprint: fingerprint.clone(),
                    public_key: public_key.clone(),
                    first_seen: now,
                    last_seen: now,
                });
            }
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    Ok(connection_id)
}

#[tauri::command]
async fn terminal_write(
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
    trust_unknown_host: bool,
) -> CommandResult<ConnectionId> {
    let session = require_session(&state, session_id)?;
    let authentication = resolve_authentication(&state, &session).await?;
    let proxy_jump_authentication = resolve_proxy_jump_authentication(&state, &session).await?;
    let known_host = state
        .repository
        .find_known_host(&session.host, session.port)
        .map_err(display_error)?
        .or_else(|| {
            // Reuse the user's OpenSSH trust database when XSH has not seen
            // this host yet. A malformed or unreadable system file should not
            // prevent a normal first connection, so this lookup is best-effort.
            read_user_known_host(&session.host, session.port)
                .ok()
                .flatten()
        });
    let result = state
        .sftp
        .connect(SftpConnectOptions {
            host: session.host,
            port: session.port,
            username: session.username,
            proxy_jump: session.proxy_jump,
            proxy_jump_username: session.proxy_jump_username,
            proxy_jump_authentication,
            authentication,
            known_host,
            trust_unknown_host,
        })
        .await
        .map_err(display_error)?;
    for presented in result.trusted_host_keys {
        let now = Utc::now();
        state
            .repository
            .save_known_host(KnownHost {
                host: presented.host,
                port: presented.port,
                key_type: presented.key_type,
                fingerprint: presented.fingerprint,
                public_key: presented.public_key,
                first_seen: now,
                last_seen: now,
            })
            .map_err(display_error)?;
    }
    Ok(result.connection_id)
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

#[tauri::command]
fn prepare_remote_edit_path(app: AppHandle, remote_name: String) -> CommandResult<PathBuf> {
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
}

#[tauri::command]
fn list_local_tree(root: PathBuf) -> CommandResult<Vec<LocalTreeEntry>> {
    if !root.is_dir() {
        return Err("选择的本地路径不是目录".to_owned());
    }
    let mut entries = Vec::new();
    collect_local_tree(&root, &root, &mut entries)?;
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(entries)
}

fn collect_local_tree(
    root: &std::path::Path,
    directory: &std::path::Path,
    entries: &mut Vec<LocalTreeEntry>,
) -> CommandResult<()> {
    let children = std::fs::read_dir(directory)
        .map_err(|error| format!("无法读取本地目录 {}：{error}", directory.display()))?;
    for child in children {
        let child = child.map_err(display_error)?;
        let file_type = child.file_type().map_err(display_error)?;
        if file_type.is_symlink() {
            continue;
        }
        let path = child.path();
        let relative_path = path
            .strip_prefix(root)
            .map_err(display_error)?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(LocalTreeEntry {
            local_path: path.to_string_lossy().into_owned(),
            relative_path,
            is_directory: file_type.is_dir(),
        });
        if file_type.is_dir() {
            collect_local_tree(root, &path, entries)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn create_local_directory(path: PathBuf) -> CommandResult<()> {
    std::fs::create_dir_all(path).map_err(display_error)
}

#[tauri::command]
fn open_local_path(path: PathBuf) -> CommandResult<()> {
    if !path.exists() {
        return Err(format!("本地文件不存在：{}", path.display()));
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
) -> CommandResult<TransferId> {
    let subscription = state
        .sftp
        .upload(connection_id, local_path, remote_path, overwrite)
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
) -> CommandResult<TransferId> {
    let subscription = state
        .sftp
        .download(connection_id, remote_path, local_path, overwrite)
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
async fn cancel_transfer(state: State<'_, AppState>, transfer_id: TransferId) -> CommandResult<()> {
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
    let bytes = state
        .credentials
        .export_backup(&password)
        .map_err(display_error)?;
    tokio::fs::write(target_path, bytes)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn import_credentials_backup(
    state: State<'_, AppState>,
    source_path: PathBuf,
    password: String,
) -> CommandResult<usize> {
    if password.is_empty() || password.len() > 4096 {
        return Err("备份密码不能为空且不能超过 4096 个字符".into());
    }
    let bytes = tokio::fs::read(source_path).await.map_err(display_error)?;
    state
        .credentials
        .import_backup(&bytes, &password)
        .map_err(display_error)
}

#[tauri::command]
async fn export_sessions(
    state: State<'_, AppState>,
    target_path: PathBuf,
    include_known_hosts: bool,
) -> CommandResult<()> {
    let bundle = state
        .repository
        .export_bundle(include_known_hosts)
        .map_err(display_error)?;
    let json = serde_json::to_vec_pretty(&bundle).map_err(display_error)?;
    tokio::fs::write(target_path, json)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn import_sessions(
    state: State<'_, AppState>,
    source_path: PathBuf,
) -> CommandResult<ImportSummary> {
    let json = tokio::fs::read(source_path).await.map_err(display_error)?;
    let bundle: SessionBundle = serde_json::from_slice(&json).map_err(display_error)?;
    bundle.validate().map_err(display_error)?;

    let mut group_map = HashMap::new();
    for group in &bundle.groups {
        let created = state
            .repository
            .create_group(SessionGroupDraft {
                parent_id: None,
                name: group.name.clone(),
                color: group.color.clone(),
                sort_order: group.sort_order,
            })
            .map_err(display_error)?;
        group_map.insert(group.id, created.id);
    }
    for group in &bundle.groups {
        if let Some(new_id) = group_map.get(&group.id).copied() {
            state
                .repository
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

    for session in &bundle.sessions {
        validate_startup_command(session.startup_command.as_deref())?;
        state
            .repository
            .create_session(SessionDraft {
                group_id: session.group_id.and_then(|id| group_map.get(&id).copied()),
                name: session.name.clone(),
                host: session.host.clone(),
                port: session.port,
                username: session.username.clone(),
                proxy_jump: session.proxy_jump.clone(),
                proxy_jump_username: session.proxy_jump_username.clone(),
                proxy_jump_authentication: session
                    .proxy_jump_authentication
                    .as_ref()
                    .map(strip_credential_references),
                authentication: strip_credential_references(&session.authentication),
                terminal: session.terminal.clone(),
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

    Ok(ImportSummary {
        groups_created: bundle.groups.len(),
        sessions_created: bundle.sessions.len(),
    })
}

fn require_session(state: &AppState, session_id: SessionId) -> CommandResult<SavedSession> {
    state
        .repository
        .get_session(session_id)
        .map_err(display_error)?
        .ok_or_else(|| format!("session not found: {session_id}"))
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

async fn credential_create(
    credentials: Arc<LocalCredentialStore>,
    kind: CredentialKind,
    secret: String,
) -> CommandResult<String> {
    run_credential_operation(move || credentials.create(kind, &secret).map_err(display_error)).await
}

async fn credential_get(
    credentials: Arc<LocalCredentialStore>,
    credential_ref: String,
) -> CommandResult<zeroize::Zeroizing<String>> {
    run_credential_operation(move || credentials.get(&credential_ref).map_err(display_error)).await
}

async fn credential_delete(
    credentials: Arc<LocalCredentialStore>,
    credential_ref: String,
) -> CommandResult<()> {
    run_credential_operation(move || credentials.delete(&credential_ref).map_err(display_error))
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
                private_key_path: private_key_path.clone(),
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

async fn cleanup_credential_if_unused(state: &State<'_, AppState>, credential_ref: &str) {
    let Ok(sessions) = state.repository.list_sessions() else {
        return;
    };
    if !sessions.iter().any(|session| {
        session_credential_references(session)
            .iter()
            .any(|reference| reference == credential_ref)
    }) {
        let _ = credential_delete(Arc::clone(&state.credentials), credential_ref.to_owned()).await;
    }
}

fn session_credential_references(session: &SavedSession) -> Vec<String> {
    [
        credential_reference(&session.authentication),
        session
            .proxy_jump_authentication
            .as_ref()
            .and_then(credential_reference),
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
    if draft.host.trim().is_empty() {
        return Err("host is required".into());
    }
    if draft.username.trim().is_empty() {
        return Err("username is required".into());
    }
    if draft.port == 0 {
        return Err("SSH port must be greater than zero".into());
    }
    validate_startup_command(draft.startup_command.as_deref())?;
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

async fn validate_authentication_reference(
    state: &AppState,
    authentication: &AuthenticationMethod,
    previous: Option<&AuthenticationMethod>,
    label: &str,
) -> CommandResult<()> {
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

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn user_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    { env::var_os("HOME").map(PathBuf::from) }.or_else(|| env::var_os("HOME").map(PathBuf::from))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("xsh.sqlite3");
            let repository = SessionRepository::open(&database_path)?;
            let credentials =
                LocalCredentialStore::open(&database_path, data_dir.join("xsh-vault.key"))?;
            app.manage(AppState {
                repository: Arc::new(repository),
                credentials: Arc::new(credentials),
                ssh: SshSessionManager::new(),
                sftp: SftpManager::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clipboard_write,
            clipboard_read,
            write_text_file,
            read_text_file,
            list_groups,
            create_group,
            update_group,
            delete_group,
            list_known_hosts,
            delete_known_host,
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
            terminal_respond_auth,
            start_local_forward,
            start_dynamic_forward,
            start_remote_forward,
            stop_forward,
            list_forwards,
            terminal_resize,
            disconnect_terminal,
            connect_sftp,
            disconnect_sftp,
            sftp_canonicalize,
            sftp_list_directory,
            sftp_stat,
            prepare_remote_edit_path,
            list_local_tree,
            create_local_directory,
            open_local_path,
            sftp_create_directory,
            sftp_rename,
            sftp_delete,
            sftp_upload,
            sftp_download,
            cancel_transfer,
            export_credentials_backup,
            import_credentials_backup,
            export_sessions,
            import_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running XSH");
}
