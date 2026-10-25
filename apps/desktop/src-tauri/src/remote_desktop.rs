use crate::{
    AppState, CommandResult, display_error, ensure_session_credential_reference,
    resolve_remote_desktop_credentials,
};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};
use uuid::Uuid;
use xsh_domain::{ConnectionId, RemoteDesktopKind, RemoteDesktopProfile, RemoteDesktopTransport};
use xsh_rdp::{ConnectOptions, Input, Output};
use zeroize::Zeroizing;

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_rdp_desktop(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    profile: RemoteDesktopProfile,
    connection_id: Option<ConnectionId>,
    username: String,
    password: Option<String>,
    width: u32,
    height: u32,
    on_event: Channel<InvokeResponseBody>,
) -> CommandResult<Uuid> {
    profile.validate().map_err(display_error)?;
    xsh_rdp::validate_size(width, height).map_err(display_error)?;
    if profile.kind != RemoteDesktopKind::Rdp {
        return Err("该会话不是 RDP 桌面。".into());
    }
    if let Some(reference) = profile.credential_ref.as_deref() {
        ensure_session_credential_reference(reference)?;
    }
    let stored = resolve_remote_desktop_credentials(&state, &profile).await?;
    let username = if username.trim().is_empty() {
        stored.username.unwrap_or_default()
    } else {
        username.trim().to_owned()
    };
    let password = password
        .map(Zeroizing::new)
        .or(stored.password)
        .unwrap_or_default();
    let (host, port) = match profile.transport {
        RemoteDesktopTransport::Direct => {
            (profile.target_host.clone(), profile.resolved_target_port())
        }
        RemoteDesktopTransport::SshTunnel => {
            let id = connection_id.ok_or("SSH 加密通道尚未就绪。")?;
            let forward = state
                .ssh
                .start_forward_profile(id, profile.forward_profile())
                .await
                .map_err(display_error)?;
            (forward.bind_host, forward.bind_port)
        }
    };
    let config_dir = app
        .path()
        .app_data_dir()
        .map_err(display_error)?
        .join("rdp");
    tokio::fs::create_dir_all(&config_dir)
        .await
        .map_err(display_error)?;
    state
        .rdp
        .start(
            ConnectOptions {
                host,
                server_name: profile.target_host,
                config_dir,
                port,
                username,
                password,
                width,
                height,
            },
            Arc::new(move |output| {
                let body = match output {
                    Output::Frame(bytes) | Output::Cursor(bytes) => InvokeResponseBody::Raw(bytes),
                    Output::Event(event) => match serde_json::to_string(&event) {
                        Ok(json) => InvokeResponseBody::Json(json),
                        Err(_) => return false,
                    },
                };
                on_event.send(body).is_ok()
            }),
        )
        .map_err(display_error)
}

#[tauri::command]
pub fn rdp_desktop_input(
    state: State<'_, AppState>,
    desktop_id: Uuid,
    input: Input,
) -> CommandResult<()> {
    state.rdp.input(desktop_id, input).map_err(display_error)
}

#[tauri::command]
pub fn acknowledge_rdp_frame(state: State<'_, AppState>, desktop_id: Uuid, sequence: u32) {
    state.rdp.acknowledge_frame(desktop_id, sequence);
}

#[tauri::command]
pub fn answer_rdp_certificate(
    state: State<'_, AppState>,
    desktop_id: Uuid,
    challenge_id: Uuid,
    accepted: bool,
) -> CommandResult<()> {
    state
        .rdp
        .answer_certificate(desktop_id, challenge_id, accepted)
        .map_err(display_error)
}

#[tauri::command]
pub async fn close_rdp_desktop(state: State<'_, AppState>, desktop_id: Uuid) -> CommandResult<()> {
    state.rdp.close(desktop_id).await;
    Ok(())
}
