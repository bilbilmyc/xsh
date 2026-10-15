use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct StreamingFixture {
    base_url: String,
    received: tokio::sync::oneshot::Receiver<String>,
    server: tokio::task::JoinHandle<()>,
}

async fn fixture(
    status: &str,
    content_type: &str,
    chunks: Vec<(Duration, Vec<u8>)>,
    include_length: bool,
) -> StreamingFixture {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let status = status.to_owned();
    let content_type = content_type.to_owned();
    let (sender, received) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                return;
            }
            received.extend_from_slice(&buffer[..count]);
            if let Some(boundary) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&received[..boundary]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|length| length.parse::<usize>().ok())
                    .unwrap_or(0);
                if received.len() >= boundary + 4 + length {
                    break;
                }
            }
        }
        let _ = sender.send(String::from_utf8(received).unwrap());
        let length = if include_length {
            format!(
                "Content-Length: {}\r\n",
                chunks.iter().map(|(_, bytes)| bytes.len()).sum::<usize>()
            )
        } else {
            String::new()
        };
        let headers = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n{length}Connection: close\r\n\r\n"
        );
        if socket.write_all(headers.as_bytes()).await.is_err() {
            return;
        }
        for (delay, bytes) in chunks {
            tokio::time::sleep(delay).await;
            if socket.write_all(&bytes).await.is_err() {
                return;
            }
        }
    });
    StreamingFixture {
        base_url: format!("http://{address}/v1"),
        received,
        server,
    }
}

fn request() -> AiCompletionRequest {
    AiCompletionRequest {
        mode: AiMode::Diagnose,
        prompt: "继续检查文件权限".into(),
        context: "token=only-test-secret\nPermission denied".into(),
        history: Vec::new(),
    }
}

fn history(role: &str, content: &str) -> AiHistoryMessage {
    AiHistoryMessage {
        role: role.into(),
        content: content.into(),
    }
}

fn settings(base_url: String) -> SavedAiSettings {
    SavedAiSettings {
        enabled: true,
        base_url,
        model: "isolated-test-model".into(),
        credential_ref: None,
    }
}

fn sse(content: &str) -> Vec<u8> {
    format!(
        "data: {}\r\n\r\n",
        serde_json::json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":null}]})
    )
    .into_bytes()
}

fn finish() -> Vec<u8> {
    b"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n".to_vec()
}

#[test]
fn default_history_is_backward_compatible_and_sanitized() {
    let request: AiCompletionRequest = serde_json::from_value(serde_json::json!({
        "mode":"explain", "prompt":"question", "context":"context"
    }))
    .unwrap();
    assert!(request.history.is_empty());
    let mut request = request;
    request.history = vec![
        history("user", "Permission denied\npassword=history-secret"),
        history("assistant", "先检查目录权限"),
    ];
    let messages = request_messages(&request).unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[2]["role"], "assistant");
    assert_eq!(messages[3]["role"], "user");
    assert!(
        !messages[1]["content"]
            .as_str()
            .unwrap()
            .contains("history-secret")
    );
}

#[test]
fn history_rejects_invalid_pairs_roles_and_all_byte_bounds() {
    for entries in [
        vec![history("user", "odd")],
        vec![history("system", "bad"), history("assistant", "bad")],
        vec![history("user", "bad"), history("tool", "bad")],
        vec![history("assistant", "bad"), history("user", "bad")],
        vec![history("user", "  "), history("assistant", "bad")],
        vec![
            history("user", &"x".repeat(MAX_HISTORY_BYTES + 1)),
            history("assistant", "ok"),
        ],
        vec![
            history("user", &"x".repeat(MAX_HISTORY_BYTES)),
            history("assistant", "x"),
        ],
        (0..14)
            .map(|index| history(if index % 2 == 0 { "user" } else { "assistant" }, "ok"))
            .collect(),
    ] {
        let mut request = request();
        request.history = entries;
        assert!(request_messages(&request).is_err());
    }
    let mut request = request();
    request.history = (0..12)
        .map(|index| {
            history(
                if index % 2 == 0 { "user" } else { "assistant" },
                "完整问答",
            )
        })
        .collect();
    assert!(request_messages(&request).is_ok());
    request.prompt = "x".repeat(64 * 1024 + 1);
    assert!(request_messages(&request).is_err());
}

#[tokio::test]
async fn http_stream_emits_before_completion_and_sends_bounded_history() {
    let service = fixture(
        "200 OK",
        "text/event-stream; charset=utf-8",
        vec![
            (Duration::ZERO, sse("先检查")),
            (Duration::from_millis(250), sse("目录权限")),
            (Duration::ZERO, finish()),
        ],
        false,
    )
    .await;
    let mut request = request();
    request.history = vec![
        history("user", "token=history-private\n先前的问题"),
        history("assistant", "先前的回答"),
    ];
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let operation = tokio::spawn(stream_completion(
        settings(service.base_url),
        None,
        request,
        move |delta| {
            sender.send(delta).unwrap();
            Ok(())
        },
    ));
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(200), events.recv())
            .await
            .unwrap()
            .unwrap(),
        "先检查"
    );
    assert!(!operation.is_finished());
    assert_eq!(operation.await.unwrap().unwrap(), "先检查目录权限");
    let sent = service.received.await.unwrap();
    assert!(sent.contains("\"stream\":true"));
    assert!(!sent.contains("history-private"));
    assert!(!sent.contains("only-test-secret"));
    assert!(!sent.to_lowercase().contains("authorization:"));
    let body = sent.split_once("\r\n\r\n").unwrap().1;
    let payload: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(payload["messages"].as_array().unwrap().len(), 4);
    service.server.await.unwrap();
}

#[tokio::test]
async fn http_stream_shields_key_fragments_before_every_event() {
    let secret = "fixture-secret-key";
    let service = fixture(
        "200 OK",
        "text/event-stream",
        vec![
            (Duration::ZERO, sse("before fixture-")),
            (Duration::ZERO, sse("secret-")),
            (Duration::ZERO, sse("key after")),
            (Duration::ZERO, finish()),
        ],
        false,
    )
    .await;
    let mut emitted = Vec::new();
    let reply = stream_completion(
        settings(service.base_url),
        Some(Zeroizing::new(secret.into())),
        request(),
        |delta| {
            assert!(!delta.contains("fixture-"));
            assert!(!delta.contains("secret-"));
            emitted.push(delta);
            Ok(())
        },
    )
    .await
    .unwrap();
    assert_eq!(reply, "before [已隐藏 API Key] after");
    assert_eq!(emitted.concat(), reply);
    assert!(
        service
            .received
            .await
            .unwrap()
            .contains("Bearer fixture-secret-key")
    );
    service.server.await.unwrap();
}

#[tokio::test]
async fn http_stream_eof_or_abnormal_finish_never_completes_partial_text() {
    for tail in [
        Vec::new(),
        b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n".to_vec(),
        b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}\n\n".to_vec(),
    ] {
        let service = fixture(
            "200 OK",
            "text/event-stream",
            vec![
                (Duration::ZERO, sse("not-complete")),
                (Duration::from_millis(10), tail),
            ],
            false,
        )
        .await;
        let mut emitted = Vec::new();
        let result = stream_completion(settings(service.base_url), None, request(), |delta| {
            emitted.push(delta);
            Ok(())
        })
        .await;
        assert!(result.is_err());
        assert_eq!(emitted.concat(), "not-complete");
        service.server.await.unwrap();
    }
}

#[tokio::test]
async fn http_stream_json_fallback_is_single_bounded_reply_without_retry() {
    let body = serde_json::json!({"choices":[{"message":{"content":"JSON兼容回复"},"finish_reason":"stop"}]}).to_string();
    let service = fixture(
        "200 OK",
        "application/json",
        vec![(Duration::ZERO, body.into_bytes())],
        true,
    )
    .await;
    let mut events = Vec::new();
    assert_eq!(
        stream_completion(settings(service.base_url), None, request(), |delta| {
            events.push(delta);
            Ok(())
        })
        .await
        .unwrap(),
        "JSON兼容回复"
    );
    assert_eq!(events, ["JSON兼容回复"]);
    assert!(service.received.await.unwrap().contains("\"stream\":true"));
    service.server.await.unwrap();
}

#[tokio::test]
async fn http_stream_rejects_http_errors_redirects_and_large_bodies_without_leaking_them() {
    for status in ["401 Unauthorized", "307 Temporary Redirect"] {
        let service = fixture(
            status,
            "application/json",
            vec![(Duration::ZERO, b"fixture-private-error-body".to_vec())],
            true,
        )
        .await;
        let error = stream_completion(settings(service.base_url), None, request(), |_| Ok(()))
            .await
            .unwrap_err();
        assert!(error.contains(status.split_once(' ').unwrap().0));
        assert!(!error.contains("fixture-private-error-body"));
        service.server.await.unwrap();
    }
    for include_length in [true, false] {
        let service = fixture(
            "200 OK",
            "text/event-stream",
            vec![(Duration::ZERO, vec![b'x'; MAX_RESPONSE_BYTES + 1])],
            include_length,
        )
        .await;
        assert!(
            stream_completion(settings(service.base_url), None, request(), |_| Ok(()))
                .await
                .unwrap_err()
                .contains("256 KiB")
        );
        service.server.await.unwrap();
    }
}

#[tokio::test]
async fn idle_timeout_rejects_partial_text_and_closes_connection() {
    let service = fixture(
        "200 OK",
        "text/event-stream",
        vec![
            (Duration::ZERO, sse("partial")),
            (Duration::from_secs(10), finish()),
        ],
        false,
    )
    .await;
    let result = stream_completion_with_idle_timeout(
        settings(service.base_url),
        None,
        request(),
        Duration::from_millis(30),
        |_| Ok(()),
    )
    .await;
    assert!(result.unwrap_err().contains("未返回数据"));
    service.server.abort();
}

fn scratch_state(base_url: String) -> (Arc<AiState>, PathBuf) {
    let directory = std::env::temp_dir().join(format!("xsh-ai-stream-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let credentials = LocalCredentialStore::open(
        directory.join("credentials.sqlite3"),
        directory.join("vault.key"),
    )
    .unwrap();
    let state = Arc::new(AiState::new(
        directory.join("ai-settings.json"),
        Arc::new(credentials),
    ));
    state
        .save(AiSettingsUpdate {
            enabled: true,
            base_url,
            model: "isolated-test-model".into(),
            api_key: None,
            clear_api_key: false,
        })
        .unwrap();
    (state, directory)
}

#[tokio::test]
async fn early_cancel_prevents_network_request_and_registry_is_bounded() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (state, directory) = scratch_state(format!("http://{}/v1", listener.local_addr().unwrap()));
    let request_id = Uuid::new_v4().to_string();
    state.cancel_request(&request_id).unwrap();
    assert!(
        registered_stream(Arc::clone(&state), request(), request_id, |_| Ok(()))
            .await
            .unwrap_err()
            .contains("已停止")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    assert!(state.requests.lock().unwrap().is_empty());
    assert_eq!(state.request_gate.available_permits(), 1);
    assert!(state.cancel_request("not-a-uuid").is_err());
    for _ in 0..MAX_CANCELLED_REQUESTS {
        state.cancel_request(&Uuid::new_v4().to_string()).unwrap();
    }
    assert!(state.cancel_request(&Uuid::new_v4().to_string()).is_err());
    assert!(state.register_request(&Uuid::new_v4().to_string()).is_err());
    drop(state);
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn active_cancel_releases_gate_and_removes_registry_without_completing_reply() {
    let service = fixture(
        "200 OK",
        "text/event-stream",
        vec![
            (Duration::ZERO, sse("partial")),
            (Duration::from_secs(10), finish()),
        ],
        false,
    )
    .await;
    let (state, directory) = scratch_state(service.base_url);
    let request_id = Uuid::new_v4().to_string();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let operation = tokio::spawn(registered_stream(
        Arc::clone(&state),
        request(),
        request_id.clone(),
        move |delta| {
            sender.send(delta).unwrap();
            Ok(())
        },
    ));
    assert_eq!(receiver.recv().await.unwrap(), "partial");
    assert_eq!(state.request_gate.available_permits(), 0);
    assert!(
        registered_stream(
            Arc::clone(&state),
            request(),
            Uuid::new_v4().to_string(),
            |_| Ok(()),
        )
        .await
        .unwrap_err()
        .contains("已有 AI 请求")
    );
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    state.cancel_request(&request_id).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(200), operation)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .contains("已停止")
    );
    assert!(state.requests.lock().unwrap().is_empty());
    assert_eq!(state.request_gate.available_permits(), 1);
    service.server.abort();
    drop(state);
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn disconnected_output_channel_releases_request_resources() {
    let service = fixture(
        "200 OK",
        "text/event-stream",
        vec![(Duration::ZERO, sse("reply")), (Duration::ZERO, finish())],
        false,
    )
    .await;
    let (state, directory) = scratch_state(service.base_url);
    assert!(
        registered_stream(
            Arc::clone(&state),
            request(),
            Uuid::new_v4().to_string(),
            |_| Err("test channel closed".into()),
        )
        .await
        .unwrap_err()
        .contains("channel closed")
    );
    assert!(state.requests.lock().unwrap().is_empty());
    assert_eq!(state.request_gate.available_permits(), 1);
    service.server.await.unwrap();
    drop(state);
    fs::remove_dir_all(directory).unwrap();
}
