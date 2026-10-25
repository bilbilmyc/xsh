//! Exercises the production native client against a peer in the same process.
//! No operating-system RDP service, external viewer or executable is involved.
use super::*;
use std::ffi::{c_int, c_void};

#[derive(Debug, Default)]
#[repr(C)]
struct Trace {
    post: u32,
    frames: u32,
    inputs: u32,
    auth: u32,
}

#[derive(Debug, Clone, PartialEq)]
struct PeerInput {
    kind: u32,
    flags: u32,
    code: u32,
    x: u32,
    y: u32,
    text: Option<String>,
}

unsafe extern "C" {
    fn xsh_rdp_test_peer_run(
        socket: usize,
        mode: u32,
        input: unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32, u32),
        clipboard: unsafe extern "C" fn(*mut c_void, *const u8, usize),
        user: *mut c_void,
        trace: *mut Trace,
    ) -> c_int;
}

unsafe extern "C" fn received_input(
    user: *mut c_void,
    kind: u32,
    flags: u32,
    code: u32,
    x: u32,
    y: u32,
) {
    let sender = unsafe { &*user.cast::<mpsc::UnboundedSender<PeerInput>>() };
    let _ = sender.send(PeerInput {
        kind,
        flags,
        code,
        x,
        y,
        text: None,
    });
}

unsafe extern "C" fn received_clipboard(user: *mut c_void, data: *const u8, length: usize) {
    let sender = unsafe { &*user.cast::<mpsc::UnboundedSender<PeerInput>>() };
    let text = String::from_utf8(unsafe { std::slice::from_raw_parts(data, length) }.to_vec())
        .expect("fixture clipboard must be UTF-8");
    let _ = sender.send(PeerInput {
        kind: 5,
        flags: 0,
        code: 0,
        x: 0,
        y: 0,
        text: Some(text),
    });
}

async fn native_peer(
    listener: tokio::net::TcpListener,
    sender: mpsc::UnboundedSender<PeerInput>,
) -> (c_int, Trace) {
    native_peer_mode(listener, sender, 0).await
}

async fn native_peer_mode(
    listener: tokio::net::TcpListener,
    sender: mpsc::UnboundedSender<PeerInput>,
    mode: u32,
) -> (c_int, Trace) {
    let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let stream = stream.into_std().unwrap();
    stream.set_nonblocking(false).unwrap();
    #[cfg(windows)]
    let socket = {
        use std::os::windows::io::IntoRawSocket;
        stream.into_raw_socket() as usize
    };
    #[cfg(unix)]
    let socket = {
        use std::os::fd::IntoRawFd;
        stream.into_raw_fd() as usize
    };
    tokio::task::spawn_blocking(move || {
        let mut trace = Trace::default();
        let status = unsafe {
            xsh_rdp_test_peer_run(
                socket,
                mode,
                received_input,
                received_clipboard,
                (&sender as *const mpsc::UnboundedSender<PeerInput>)
                    .cast_mut()
                    .cast(),
                &mut trace,
            )
        };
        (status, trace)
    })
    .await
    .unwrap()
}

fn options(port: u16, config_dir: &std::path::Path) -> ConnectOptions {
    ConnectOptions {
        host: "127.0.0.1".into(),
        server_name: "localhost".into(),
        port,
        config_dir: config_dir.to_path_buf(),
        username: "fixture".into(),
        password: Zeroizing::new("fixture".into()),
        width: 320,
        height: 240,
    }
}

async fn next(receiver: &mut mpsc::UnboundedReceiver<Output>) -> Output {
    tokio::time::timeout(Duration::from_secs(8), receiver.recv())
        .await
        .expect("native RDP event timeout")
        .expect("native RDP output closed")
}

#[tokio::test]
async fn tls_peer_confirms_certificate_decodes_real_pixels_and_receives_inputs() {
    let directory = std::env::temp_dir().join(format!("xsh-rdp-peer-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (input_sender, mut input_receiver) = mpsc::unbounded_channel();
    let peer = tokio::spawn(native_peer(listener, input_sender));
    let manager = RdpManager::default();
    let (send, mut receive) = mpsc::unbounded_channel();
    let id = manager
        .start(
            options(port, &directory),
            Arc::new(move |output| send.send(output).is_ok()),
        )
        .unwrap();
    let mut certificate_seen = false;
    loop {
        match next(&mut receive).await {
            Output::Event(Event::Certificate(challenge)) => {
                assert_eq!(challenge.host, "localhost");
                assert!(challenge.subject.contains("localhost"));
                assert_eq!(challenge.fingerprint.len(), 95);
                assert_eq!(
                    challenge.flags & 0x80,
                    0,
                    "matching certificate name was rejected"
                );
                certificate_seen = true;
                manager
                    .answer_certificate(id, challenge.challenge_id, true)
                    .unwrap();
            }
            Output::Event(Event::StateChanged { state, message }) => {
                assert_ne!(state, "failed", "{message:?}")
            }
            Output::Frame(bytes) => {
                let value = |index: usize| {
                    u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
                };
                manager.acknowledge_frame(id, value(1));
                let (x, y, width, height) = (value(4), value(5), value(6), value(7));
                if x <= 32 && y <= 32 && x + width > 32 && y + height > 32 {
                    let offset = FRAME_HEADER + (((32 - y) * width + 32 - x) * 4) as usize;
                    if bytes[offset..offset + 4] == [0xc0, 0x80, 0x20, 255] {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    assert!(
        certificate_seen,
        "self-signed TLS must never bypass certificate confirmation"
    );
    for input in [
        Input::Key {
            scan: 0x1e,
            down: true,
            extended: false,
        },
        Input::Key {
            scan: 0x1e,
            down: false,
            extended: false,
        },
        Input::Text { text: "中".into() },
        Input::Mouse {
            flags: 0x0800,
            x: 20,
            y: 30,
        },
        Input::Mouse {
            flags: 0x9000,
            x: 20,
            y: 30,
        },
        Input::Mouse {
            flags: 0x1000,
            x: 20,
            y: 30,
        },
        Input::CtrlAltDel,
    ] {
        manager.input(id, input).unwrap();
    }
    let mut received = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while received
            .iter()
            .filter(|input: &&PeerInput| input.kind <= 3)
            .count()
            < 13
        {
            received.push(input_receiver.recv().await.unwrap());
        }
    })
    .await
    .expect("peer did not receive native input packets");
    assert!(
        received
            .iter()
            .any(|input| input.kind == 1 && input.code == 0x1e && input.flags & 0x8000 != 0)
    );
    assert!(
        received
            .iter()
            .any(|input| input.kind == 2 && input.code == 0x4e2d)
    );
    assert!(
        received.iter().any(|input| input.kind == 3
            && input.flags == 0x9000
            && input.x == 20
            && input.y == 30)
    );
    let secure_attention: Vec<_> = received
        .iter()
        .filter(|input| input.kind == 1)
        .skip(2)
        .map(|input| (input.code, input.flags & 0x8100))
        .collect();
    assert_eq!(
        secure_attention,
        [
            (0x1d, 0),
            (0x38, 0),
            (0x53, 0x100),
            (0x53, 0x8100),
            (0x38, 0x8000),
            (0x1d, 0x8000)
        ]
    );
    tokio::time::timeout(Duration::from_secs(3), manager.close(id))
        .await
        .unwrap();
    let (status, trace) = tokio::time::timeout(Duration::from_secs(3), peer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 0, "{trace:?}");
    assert_eq!(trace.post, 1);
    assert_eq!(trace.frames, 1);
    assert!(
        !directory
            .join(format!("server/localhost_{port}.pem"))
            .exists(),
        "trust-once must not persist a server certificate"
    );
    std::fs::remove_dir_all(directory).unwrap();
}

async fn finish_without_trusting_certificate(reject: bool) {
    let directory = std::env::temp_dir().join(format!("xsh-rdp-reject-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (input_sender, _) = mpsc::unbounded_channel();
    let peer = tokio::spawn(native_peer(listener, input_sender));
    let manager = RdpManager::default();
    let (send, mut receive) = mpsc::unbounded_channel();
    let id = manager
        .start(
            options(port, &directory),
            Arc::new(move |output| send.send(output).is_ok()),
        )
        .unwrap();
    let mut certificate_seen = false;
    loop {
        match next(&mut receive).await {
            Output::Event(Event::Certificate(challenge)) => {
                certificate_seen = true;
                if reject {
                    manager
                        .answer_certificate(id, challenge.challenge_id, false)
                        .unwrap();
                } else {
                    tokio::time::timeout(Duration::from_secs(3), manager.close(id))
                        .await
                        .unwrap();
                    break;
                }
            }
            Output::Event(Event::StateChanged { state, .. }) if state == "failed" => break,
            Output::Event(Event::StateChanged { state, .. }) => assert_ne!(state, "connected"),
            Output::Frame(_) => panic!("untrusted server sent a rendered frame"),
            _ => {}
        }
    }
    assert!(certificate_seen);
    manager.close(id).await;
    let (status, trace) = tokio::time::timeout(Duration::from_secs(3), peer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 0, "{trace:?}");
    assert_eq!(trace.post, 0);
    assert_eq!(trace.frames, 0);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn rejecting_a_real_tls_certificate_never_activates_the_peer() {
    finish_without_trusting_certificate(true).await;
}

#[tokio::test]
async fn closing_during_certificate_confirmation_interrupts_both_native_peers() {
    finish_without_trusting_certificate(false).await;
}

#[tokio::test]
async fn channels_exchange_unicode_clipboard_resize_pixels_and_cached_cursors() {
    let directory = std::env::temp_dir().join(format!("xsh-rdp-channels-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (input_sender, mut input_receiver) = mpsc::unbounded_channel();
    let peer = tokio::spawn(native_peer_mode(listener, input_sender, 1));
    let manager = RdpManager::default();
    let (send, mut receive) = mpsc::unbounded_channel();
    let id = manager
        .start(
            options(port, &directory),
            Arc::new(move |output| send.send(output).is_ok()),
        )
        .unwrap();
    let mut clipboard_ready = false;
    let mut resize_ready = false;
    let mut shape = None;
    let mut clipboard = None;
    while !clipboard_ready || !resize_ready || shape.is_none() || clipboard.is_none() {
        let output = tokio::time::timeout(Duration::from_secs(8), receive.recv()).await
            .unwrap_or_else(|_| panic!("channel negotiation timeout: clipboard={clipboard_ready}, resize={resize_ready}, cursor={}, remote_text={}", shape.is_some(), clipboard.is_some()))
            .expect("RDP output closed during channel negotiation");
        match output {
            Output::Event(Event::Certificate(challenge)) => {
                manager
                    .answer_certificate(id, challenge.challenge_id, true)
                    .unwrap();
            }
            Output::Event(Event::StateChanged { state, message }) => {
                assert_ne!(state, "failed", "{message:?}");
            }
            Output::Event(Event::Capabilities {
                clipboard,
                resize,
                max_pixels,
            }) => {
                clipboard_ready = clipboard;
                resize_ready = resize;
                if resize {
                    assert_eq!(max_pixels, MAX_PIXELS);
                }
            }
            Output::Event(Event::Clipboard { text }) => clipboard = Some(text),
            Output::Cursor(bytes) => shape = Some(bytes),
            Output::Frame(bytes) => manager.acknowledge_frame(id, u32_at(&bytes, 1)),
            _ => {}
        }
    }
    assert_eq!(clipboard.as_deref(), Some("远端🧪\r\nclip"));
    let shape = shape.unwrap();
    assert_eq!(
        (0..6).map(|i| u32_at(&shape, i)).collect::<Vec<_>>(),
        [CURSOR_MAGIC, 2, 16, 16, 3, 5]
    );
    assert_eq!(shape.len(), 24 + 16 * 16 * 4);
    assert!(
        shape[24..]
            .as_chunks::<4>()
            .0
            .iter()
            .all(|pixel| *pixel == [0xcc, 0x88, 0x44, 0xff])
    );

    let local_text = "本地🦀\r\nsecond line";
    manager
        .input(
            id,
            Input::Clipboard {
                text: local_text.into(),
            },
        )
        .unwrap();
    manager
        .input(
            id,
            Input::Resize {
                width: 640,
                height: 480,
            },
        )
        .unwrap();
    let mut local_seen = false;
    let mut resize_seen = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !local_seen || !resize_seen {
            let input = input_receiver.recv().await.unwrap();
            if input.kind == 5 {
                assert_eq!(input.text.as_deref(), Some(local_text));
                local_seen = true;
            }
            if input.kind == 6 {
                assert_eq!((input.x, input.y), (640, 480));
                resize_seen = true;
            }
        }
    })
    .await
    .expect("server channel did not receive clipboard and monitor layout");
    loop {
        match next(&mut receive).await {
            Output::Frame(bytes) => {
                manager.acknowledge_frame(id, u32_at(&bytes, 1));
                if (u32_at(&bytes, 2), u32_at(&bytes, 3)) == (640, 480) {
                    assert_eq!((u32_at(&bytes, 4), u32_at(&bytes, 5)), (0, 0));
                    break;
                }
            }
            Output::Event(Event::StateChanged { state, message }) => {
                assert_eq!(state, "connected", "{message:?}")
            }
            _ => {}
        }
    }
    // Exercise system/null and cached pointers through real RDP updates.
    for (scan, kind) in [(0x3b, 1), (0x3c, 0), (0x3d, 2)] {
        manager
            .input(
                id,
                Input::Key {
                    scan,
                    down: true,
                    extended: false,
                },
            )
            .unwrap();
        manager
            .input(
                id,
                Input::Key {
                    scan,
                    down: false,
                    extended: false,
                },
            )
            .unwrap();
        loop {
            match next(&mut receive).await {
                Output::Cursor(bytes) => {
                    if u32_at(&bytes, 1) != kind {
                        continue;
                    }
                    if kind == 2 {
                        assert_eq!(bytes, shape);
                    } else {
                        assert_eq!(bytes.len(), 24);
                    }
                    break;
                }
                Output::Frame(bytes) => manager.acknowledge_frame(id, u32_at(&bytes, 1)),
                Output::Event(Event::StateChanged { state, message }) => {
                    assert_eq!(state, "connected", "{message:?}")
                }
                _ => {}
            }
        }
    }
    tokio::time::timeout(Duration::from_secs(3), manager.close(id))
        .await
        .unwrap();
    let (status, trace) = tokio::time::timeout(Duration::from_secs(3), peer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, 0, "{trace:?}");
    assert!(trace.frames >= 2, "{trace:?}");
    std::fs::remove_dir_all(directory).unwrap();
}

fn u32_at(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap())
}

fn contains_fixture_pixel(bytes: &[u8]) -> bool {
    let (x, y, width, height) = (
        u32_at(bytes, 4),
        u32_at(bytes, 5),
        u32_at(bytes, 6),
        u32_at(bytes, 7),
    );
    if x > 32 || y > 32 || x + width <= 32 || y + height <= 32 {
        return false;
    }
    let offset = FRAME_HEADER + (((32 - y) * width + 32 - x) * 4) as usize;
    bytes[offset..offset + 4] == [0xc0, 0x80, 0x20, 255]
}

#[test]
fn nla_requires_server_pixels_instead_of_the_initial_snapshot() {
    let mut snapshot = vec![0; FRAME_HEADER + 64 * 64 * 4];
    snapshot[24..28].copy_from_slice(&64_u32.to_le_bytes());
    snapshot[28..32].copy_from_slice(&64_u32.to_le_bytes());
    assert!(!contains_fixture_pixel(&snapshot));
    let offset = FRAME_HEADER + (32 * 64 + 32) * 4;
    snapshot[offset..offset + 4].copy_from_slice(&[0xc0, 0x80, 0x20, 255]);
    assert!(contains_fixture_pixel(&snapshot));
    snapshot[16..20].copy_from_slice(&40_u32.to_le_bytes());
    assert!(!contains_fixture_pixel(&snapshot));
}

#[tokio::test]
async fn nla_authentication_accepts_valid_credentials_and_rejects_bad_passwords() {
    // WinPR caches its SSPI backend once per process. A child test process
    // chooses the portable backend before initialization, without changing
    // system accounts or the production client's native Windows SSPI backend.
    if std::env::var_os("XSH_RDP_NLA_FIXTURE_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "peer_tests::nla_authentication_accepts_valid_credentials_and_rejects_bad_passwords", "--nocapture"])
            .env("XSH_RDP_NLA_FIXTURE_CHILD", "1")
            .env("WINPR_NATIVE_SSPI", "0")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "isolated NLA test failed:\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    for (username, password_ok) in [
        ("fixture", true),
        ("XSH\\fixture", true),
        ("fixture", false),
    ] {
        let directory = std::env::temp_dir().join(format!("xsh-rdp-nla-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (input_sender, _) = mpsc::unbounded_channel();
        let peer = tokio::spawn(native_peer_mode(listener, input_sender, 2));
        let manager = RdpManager::default();
        let (send, mut receive) = mpsc::unbounded_channel();
        let mut config = options(port, &directory);
        config.username = username.into();
        if !password_ok {
            config.password = Zeroizing::new("incorrect-fixture-password".into());
        }
        let id = manager
            .start(config, Arc::new(move |output| send.send(output).is_ok()))
            .unwrap();
        let mut certificate_seen = false;
        let mut connected = false;
        let mut frame_seen = false;
        loop {
            match next(&mut receive).await {
                Output::Event(Event::Certificate(challenge)) => {
                    certificate_seen = true;
                    manager
                        .answer_certificate(id, challenge.challenge_id, true)
                        .unwrap();
                }
                Output::Event(Event::StateChanged { state, message }) => {
                    if password_ok {
                        assert_ne!(state, "failed", "{message:?}");
                        if state == "connected" {
                            connected = true;
                        }
                    } else {
                        assert_ne!(state, "connected", "invalid NLA credentials were accepted");
                        if state == "failed" {
                            assert!(message.is_some(), "failed NLA needs a user-facing error");
                            break;
                        }
                    }
                }
                Output::Frame(bytes) => {
                    assert!(password_ok && certificate_seen);
                    manager.acknowledge_frame(id, u32_at(&bytes, 1));
                    // The client also emits an initial empty snapshot. Closing
                    // on that frame races the server's PostConnect callback.
                    frame_seen |= contains_fixture_pixel(&bytes);
                }
                _ => {}
            }
            if connected && frame_seen {
                break;
            }
        }
        assert!(
            certificate_seen,
            "NLA must still verify the TLS certificate"
        );
        tokio::time::timeout(Duration::from_secs(3), manager.close(id))
            .await
            .unwrap();
        let (status, trace) = tokio::time::timeout(Duration::from_secs(3), peer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status, 0, "{trace:?}");
        assert_eq!(trace.post, u32::from(password_ok), "{trace:?}");
        assert_eq!(trace.frames > 0, password_ok, "{trace:?}");
        assert_eq!(
            trace.auth, 1,
            "NLA must exercise NTLM proof verification: {trace:?}"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
