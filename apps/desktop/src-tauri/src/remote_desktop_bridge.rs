use futures::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use uuid::Uuid;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BRIDGE_CONNECTIONS: usize = 16;

/// Owns the loopback listener AND all established or handshaking connections.
pub struct RemoteDesktopBridge {
    pub token: String,
    listener: JoinHandle<()>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl RemoteDesktopBridge {
    pub async fn open(host: String, port: u16) -> std::io::Result<(u16, Self)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();
        let token = Uuid::new_v4().simple().to_string();
        let listener_token = token.clone();
        let (shutdown, mut stopped) = oneshot::channel();
        let listener = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    _ = connections.join_next(), if !connections.is_empty() => {}
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        if connections.len() >= MAX_BRIDGE_CONNECTIONS {
                            continue;
                        }
                        let host = host.clone();
                        let token = listener_token.clone();
                        connections.spawn(async move {
                            bridge_websocket_to_tcp(stream, host, port, &token).await;
                        });
                    }
                }
            }
            connections.shutdown().await;
        });
        Ok((
            local_port,
            Self {
                token,
                listener,
                shutdown: Some(shutdown),
            },
        ))
    }

    pub async fn close(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = (&mut self.listener).await;
    }
}

impl Drop for RemoteDesktopBridge {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

// tungstenite fixes the handshake callback's error type to an HTTP Response.
#[allow(clippy::result_large_err)]
async fn bridge_websocket_to_tcp(stream: TcpStream, host: String, port: u16, token: &str) {
    // Authenticate the application-owned bridge before opening the target.
    let path = format!("/{token}");
    let handshake = tokio_tungstenite::accept_hdr_async(
        stream,
        move |request: &Request, response: Response| {
            let origin_allowed = request.headers().get("origin").is_none_or(|origin| {
                matches!(
                    origin.to_str().unwrap_or(""),
                    "tauri://localhost"
                        | "http://tauri.localhost"
                        | "https://tauri.localhost"
                        | "http://localhost:1420"
                        | "http://127.0.0.1:1420"
                )
            });
            if request.uri().path() != path || !origin_allowed {
                return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("Invalid desktop session".to_owned()))
                    .unwrap());
            }
            Ok(response)
        },
    );
    let ws = match timeout(CONNECT_TIMEOUT, handshake).await {
        Ok(Ok(ws)) => ws,
        _ => return,
    };
    let tcp = match timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(tcp)) => tcp,
        _ => return,
    };
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_sink, mut ws_stream_rx) = ws.split();
    let to_tcp = async move {
        while let Some(Ok(message)) = ws_stream_rx.next().await {
            match message {
                Message::Binary(data) => {
                    if tokio::io::AsyncWriteExt::write_all(&mut tcp_write, &data)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    let to_viewer = async move {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = tokio::io::AsyncReadExt::read(&mut tcp_read, &mut buffer).await;
            let chunk = match read {
                Ok(0) | Err(_) => break,
                Ok(n) => buffer[..n].to_vec(),
            };
            if ws_sink.send(Message::Binary(chunk.into())).await.is_err() {
                break;
            }
        }
    };
    // No detached writer: dropping the other future closes both socket halves,
    // including when the bridge owner cancels this connection task.
    tokio::select! {
        _ = to_tcp => {}
        _ = to_viewer => {}
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    #[tokio::test]
    async fn closing_or_dropping_bridge_closes_established_connections() {
        timeout(TEST_TIMEOUT, async {
            for explicit_close in [true, false] {
                let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
                let (port, bridge) = RemoteDesktopBridge::open(
                    "127.0.0.1".into(),
                    target.local_addr().unwrap().port(),
                )
                .await
                .unwrap();
                let (viewer, remote) = tokio::join!(
                    tokio_tungstenite::connect_async(format!(
                        "ws://127.0.0.1:{port}/{}",
                        bridge.token
                    )),
                    target.accept(),
                );
                let (mut viewer, _) = viewer.unwrap();
                let (mut remote, _) = remote.unwrap();
                viewer
                    .send(Message::Binary(vec![1, 2, 3].into()))
                    .await
                    .unwrap();
                let mut received = [0; 3];
                remote.read_exact(&mut received).await.unwrap();
                assert_eq!(received, [1, 2, 3]);
                if explicit_close {
                    bridge.close().await;
                } else {
                    drop(bridge);
                }
                assert_eq!(remote.read(&mut received).await.unwrap(), 0);
            }
        })
        .await
        .expect("closing the bridge left an established connection alive");
    }

    #[tokio::test]
    async fn viewer_disconnect_finishes_the_idle_proxy() {
        timeout(TEST_TIMEOUT, async {
            let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let target_port = target.local_addr().unwrap().port();
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                bridge_websocket_to_tcp(stream, "127.0.0.1".into(), target_port, "test-token")
                    .await;
            });
            let (viewer, remote) = tokio::join!(
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/test-token")),
                target.accept(),
            );
            let (mut viewer, _) = viewer.unwrap();
            let (mut remote, _) = remote.unwrap();
            remote.write_all(&[4, 5, 6]).await.unwrap();
            assert_eq!(
                viewer.next().await.unwrap().unwrap().into_data().as_ref(),
                &[4, 5, 6]
            );
            viewer.close(None).await.unwrap();
            task.await.unwrap();
        })
        .await
        .expect("viewer disconnect left the TCP reader waiting forever");
    }

    #[tokio::test]
    async fn target_disconnect_finishes_the_proxy_without_a_viewer_reply() {
        timeout(TEST_TIMEOUT, async {
            let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let target_port = target.local_addr().unwrap().port();
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let task = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                bridge_websocket_to_tcp(stream, "127.0.0.1".into(), target_port, "test-token")
                    .await;
            });
            let (viewer, remote) = tokio::join!(
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/test-token")),
                target.accept(),
            );
            let (_viewer, _) = viewer.unwrap();
            let (remote, _) = remote.unwrap();
            drop(remote);
            task.await.unwrap();
        })
        .await
        .expect("target disconnect left the proxy waiting for a viewer reply");
    }

    #[tokio::test]
    async fn closing_bridge_cancels_an_unfinished_websocket_handshake() {
        timeout(TEST_TIMEOUT, async {
            let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let (port, bridge) =
                RemoteDesktopBridge::open("127.0.0.1".into(), target.local_addr().unwrap().port())
                    .await
                    .unwrap();
            let mut viewer = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            bridge.close().await;
            let mut byte = [0];
            match viewer.read(&mut byte).await {
                Ok(0) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                    ) => {}
                result => panic!("closed handshake socket remained live: {result:?}"),
            }
            assert!(
                timeout(Duration::from_millis(50), target.accept())
                    .await
                    .is_err()
            );
            // Rebinding checks listener cleanup without Windows' delayed
            // connection-refused retries consuming the test's deadline.
            let _rebound = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        })
        .await
        .expect("closing the bridge left a handshake or listener alive");
    }

    #[tokio::test]
    async fn bridge_rejects_another_session_or_web_origin_before_connecting_the_target() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        timeout(TEST_TIMEOUT, async {
            let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let (port, bridge) = RemoteDesktopBridge::open(
                "127.0.0.1".into(), target.local_addr().unwrap().port(),
            ).await.unwrap();
            for (token, origin) in [("wrong-token", "http://tauri.localhost"), (bridge.token.as_str(), "https://example.com")] {
                let mut request = format!("ws://127.0.0.1:{port}/{token}").into_client_request().unwrap();
                request.headers_mut().insert("Origin", origin.parse().unwrap());
                let error = tokio_tungstenite::connect_async(request).await.unwrap_err();
                assert!(matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403));
            }
            assert!(timeout(Duration::from_millis(50), target.accept()).await.is_err());
            bridge.close().await;
        }).await.unwrap();
    }
}
