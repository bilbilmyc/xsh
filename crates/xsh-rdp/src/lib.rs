//! Owned, in-process RDP sessions. FreeRDP and its TLS dependencies are bundled
//! libraries; this module never launches a viewer or other executable.
mod native;
#[cfg(all(test, feature = "test-peer"))]
mod peer_tests;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc as sync_mpsc};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MAX_PIXELS: u64 = 4096 * 2160;
pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
const MAX_SESSIONS: usize = 8;
const FRAME_HEADER: usize = 32;
const FRAME_MAGIC: u32 = 0x4448_5358; // XSHD, little endian.
const CURSOR_MAGIC: u32 = 0x4348_5358; // XSHC, little endian.
const MAX_CURSOR_SIZE: u32 = 384;

#[derive(Debug, thiserror::Error)]
pub enum RdpError {
    #[error("{0}")]
    Invalid(String),
    #[error("远程桌面会话已关闭。")]
    Closed,
    #[error("远程桌面输入队列暂时繁忙，请稍后重试。")]
    Busy,
    #[error("同时最多打开 {MAX_SESSIONS} 个 RDP 桌面。")]
    Limit,
}

pub struct ConnectOptions {
    pub host: String,
    pub server_name: String,
    pub config_dir: std::path::PathBuf,
    pub port: u16,
    pub username: String,
    pub password: Zeroizing<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateChallenge {
    pub challenge_id: Uuid,
    pub host: String,
    pub port: u32,
    pub subject: String,
    pub issuer: String,
    pub fingerprint: String,
    pub previous_fingerprint: String,
    pub flags: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum Event {
    StateChanged {
        state: String,
        message: Option<String>,
    },
    Certificate(CertificateChallenge),
    Clipboard {
        text: String,
    },
    Capabilities {
        clipboard: bool,
        resize: bool,
        #[serde(rename = "maxPixels")]
        max_pixels: u64,
    },
    Warning {
        message: String,
    },
}

pub enum Output {
    Event(Event),
    Frame(Vec<u8>),
    Cursor(Vec<u8>),
}

pub type OutputSink = Arc<dyn Fn(Output) -> bool + Send + Sync>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Input {
    CtrlAltDel,
    Key {
        scan: u8,
        down: bool,
        extended: bool,
    },
    Text {
        text: String,
    },
    Mouse {
        flags: u16,
        x: u16,
        y: u16,
    },
    Resize {
        width: u32,
        height: u32,
    },
    Clipboard {
        text: String,
    },
}

pub fn validate_size(width: u32, height: u32) -> Result<(), RdpError> {
    if !(200..=8192).contains(&width)
        || !(200..=8192).contains(&height)
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(RdpError::Invalid(
            "桌面尺寸需为 200–8192 像素，总像素数不能超过 4096×2160。".into(),
        ));
    }
    Ok(())
}

impl ConnectOptions {
    fn validate(&self) -> Result<(), RdpError> {
        validate_size(self.width, self.height)?;
        if self.host.trim().is_empty()
            || self.username.trim().is_empty()
            || self.port == 0
            || [
                &self.host,
                &self.server_name,
                &self.username,
                &self.password,
            ]
            .iter()
            .any(|value| value.contains('\0'))
        {
            return Err(RdpError::Invalid("RDP 主机、端口或登录信息无效。".into()));
        }
        Ok(())
    }
}

struct FrameCredit {
    in_flight: AtomicU32,
    sequence: AtomicU32,
    needs_snapshot: AtomicBool,
}

impl Default for FrameCredit {
    fn default() -> Self {
        Self {
            in_flight: AtomicU32::new(0),
            sequence: AtomicU32::new(1),
            needs_snapshot: AtomicBool::new(false),
        }
    }
}

impl FrameCredit {
    fn reserve(&self) -> Option<(u32, bool)> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed).max(1);
        if self
            .in_flight
            .compare_exchange(0, sequence, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.needs_snapshot.store(true, Ordering::Release);
            return None;
        }
        Some((sequence, self.needs_snapshot.swap(false, Ordering::AcqRel)))
    }

    fn acknowledge(&self, sequence: u32) {
        if sequence != 0 {
            let _ =
                self.in_flight
                    .compare_exchange(sequence, 0, Ordering::AcqRel, Ordering::Acquire);
        }
    }

    fn should_snapshot(&self) -> bool {
        self.needs_snapshot.load(Ordering::Acquire) && self.in_flight.load(Ordering::Acquire) == 0
    }
}

type CertificateReply = Option<(Uuid, sync_mpsc::SyncSender<bool>)>;

pub(crate) struct SessionContext {
    cancelled: AtomicBool,
    // Only native::Engine::abort may use this pointer from another thread.
    // Engine clears it under this lock before freeing the native context.
    native_pointer: Mutex<Option<usize>>,
    frames: FrameCredit,
    certificate_reply: Mutex<CertificateReply>,
    sink: OutputSink,
}

impl SessionContext {
    fn emit(&self, output: Output) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        if !(self.sink)(output) {
            self.cancel();
            return false;
        }
        true
    }

    fn state(&self, state: &str, message: Option<String>) {
        self.emit(Output::Event(Event::StateChanged {
            state: state.to_owned(),
            message,
        }));
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(pointer) = *self.native_pointer.lock().unwrap() {
            // SAFETY: Engine publishes/clears its live pointer under this lock;
            // the native abort function is specifically safe during connect/IO.
            unsafe { native::abort(pointer) };
        }
    }

    fn certificate(&self, challenge: CertificateChallenge) -> bool {
        let (send, receive) = sync_mpsc::sync_channel(1);
        let id = challenge.challenge_id;
        *self.certificate_reply.lock().unwrap() = Some((id, send));
        if !self.emit(Output::Event(Event::Certificate(challenge))) {
            self.certificate_reply.lock().unwrap().take();
            return false;
        }
        let deadline = Instant::now() + Duration::from_secs(120);
        let accepted = loop {
            if self.cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                break false;
            }
            match receive.recv_timeout(Duration::from_millis(50)) {
                Ok(accepted) => break accepted,
                Err(sync_mpsc::RecvTimeoutError::Disconnected) => break false,
                Err(sync_mpsc::RecvTimeoutError::Timeout) => {}
            }
        };
        let mut pending = self.certificate_reply.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|(pending_id, _)| *pending_id == id)
        {
            pending.take();
        }
        accepted
    }
}

struct Session {
    context: Arc<SessionContext>,
    input: mpsc::Sender<Input>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.context.cancel();
    }
}

#[derive(Default)]
pub struct RdpManager {
    sessions: Mutex<HashMap<Uuid, Session>>,
}

impl RdpManager {
    pub fn start(&self, options: ConnectOptions, sink: OutputSink) -> Result<Uuid, RdpError> {
        options.validate()?;
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, session| !session.worker.as_ref().is_none_or(JoinHandle::is_finished));
        if sessions.len() >= MAX_SESSIONS {
            return Err(RdpError::Limit);
        }
        let id = Uuid::new_v4();
        let context = Arc::new(SessionContext {
            cancelled: AtomicBool::new(false),
            native_pointer: Mutex::new(None),
            frames: FrameCredit::default(),
            certificate_reply: Mutex::new(None),
            sink,
        });
        let (input, receiver) = mpsc::channel(64);
        let worker_context = Arc::clone(&context);
        let worker = tokio::task::spawn_blocking(move || {
            run_session(options, receiver, &worker_context);
        });
        sessions.insert(
            id,
            Session {
                context,
                input,
                worker: Some(worker),
            },
        );
        Ok(id)
    }

    pub fn input(&self, id: Uuid, input: Input) -> Result<(), RdpError> {
        match &input {
            Input::Text { text } if text.len() > 64 * 1024 || text.contains('\0') => {
                return Err(RdpError::Invalid("单次输入文本过长或含无效字符。".into()));
            }
            Input::Clipboard { text }
                if text.len() > MAX_CLIPBOARD_BYTES || text.contains('\0') =>
            {
                return Err(RdpError::Invalid(
                    "剪贴板文本不能超过 1 MiB 或含空字符。".into(),
                ));
            }
            Input::Resize { width, height } => validate_size(*width, *height)?,
            _ => {}
        }
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or(RdpError::Closed)?;
        session.input.try_send(input).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => RdpError::Busy,
            mpsc::error::TrySendError::Closed(_) => RdpError::Closed,
        })
    }

    pub fn acknowledge_frame(&self, id: Uuid, sequence: u32) {
        if let Some(session) = self.sessions.lock().unwrap().get(&id) {
            session.context.frames.acknowledge(sequence);
        }
    }

    pub fn answer_certificate(
        &self,
        id: Uuid,
        challenge: Uuid,
        accepted: bool,
    ) -> Result<(), RdpError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or(RdpError::Closed)?;
        let mut pending = session.context.certificate_reply.lock().unwrap();
        if !pending.as_ref().is_some_and(|(id, _)| *id == challenge) {
            return Err(RdpError::Invalid("证书确认已过期。".into()));
        }
        if let Some((_, reply)) = pending.take() {
            let _ = reply.try_send(accepted);
        }
        Ok(())
    }

    pub async fn close(&self, id: Uuid) {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            session.context.cancel();
            if let Some(worker) = session.worker.take() {
                let _ = worker.await;
            }
        }
    }
}

fn run_session(
    options: ConnectOptions,
    mut input: mpsc::Receiver<Input>,
    context: &Arc<SessionContext>,
) {
    context.state("connecting", None);
    let mut connected = false;
    let result = (|| {
        let engine = native::Engine::new(&options, context)?;
        if context.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        engine.connect()?;
        connected = true;
        context.state("connected", None);
        engine.snapshot();
        while !context.cancelled.load(Ordering::Acquire) {
            for _ in 0..64 {
                match input.try_recv() {
                    Ok(value) => engine.input(value)?,
                    Err(mpsc::error::TryRecvError::Empty) => break,
                    Err(mpsc::error::TryRecvError::Disconnected) => return Ok(()),
                }
            }
            if context.frames.should_snapshot() {
                engine.snapshot();
            }
            if !engine.step()? {
                return Ok(());
            }
        }
        Ok::<_, String>(())
    })();
    if !context.cancelled.load(Ordering::Acquire) {
        match result {
            Ok(()) => context.state("disconnected", None),
            Err(message) => context.state(
                if connected { "disconnected" } else { "failed" },
                Some(message),
            ),
        }
    }
}

// The native callback provides the full, decoded RGBA framebuffer plus a dirty
// rectangle. A single outstanding frame bounds IPC payloads; skipped refreshes
// require a complete snapshot so that no accumulated dirty region is lost.
#[allow(clippy::too_many_arguments)]
pub(crate) unsafe fn frame(
    context: &SessionContext,
    width: u32,
    height: u32,
    mut x: u32,
    mut y: u32,
    mut w: u32,
    mut h: u32,
    data: *const u8,
    stride: u32,
) {
    if validate_size(width, height).is_err()
        || data.is_null()
        || stride < width * 4
        || x.checked_add(w).is_none_or(|right| right > width)
        || y.checked_add(h).is_none_or(|bottom| bottom > height)
        || w == 0
        || h == 0
    {
        return;
    }
    let Some((sequence, full)) = context.frames.reserve() else {
        return;
    };
    if full {
        x = 0;
        y = 0;
        w = width;
        h = height;
    }
    let mut bytes = Vec::with_capacity(FRAME_HEADER + w as usize * h as usize * 4);
    for value in [FRAME_MAGIC, sequence, width, height, x, y, w, h] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for row in y..y + h {
        let offset = row as usize * stride as usize + x as usize * 4;
        // SAFETY: the native GDI callback guarantees a live height*stride buffer;
        // validated dimensions keep each copied row within that framebuffer.
        let pixels = unsafe { std::slice::from_raw_parts(data.add(offset), w as usize * 4) };
        let start = bytes.len();
        bytes.extend_from_slice(pixels);
        for alpha in bytes[start + 3..].iter_mut().step_by(4) {
            *alpha = 255;
        }
    }
    context.emit(Output::Frame(bytes));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(sink: OutputSink) -> SessionContext {
        SessionContext {
            cancelled: AtomicBool::new(false),
            native_pointer: Mutex::new(None),
            frames: FrameCredit::default(),
            certificate_reply: Mutex::new(None),
            sink,
        }
    }

    #[test]
    fn frame_credit_requires_exact_ack_and_accumulates_skipped_updates() {
        let credit = FrameCredit::default();
        let (sequence, full) = credit.reserve().unwrap();
        assert!(!full);
        assert!(credit.reserve().is_none());
        credit.acknowledge(sequence + 1);
        assert!(!credit.should_snapshot());
        credit.acknowledge(sequence);
        assert!(credit.should_snapshot());
        assert!(credit.reserve().unwrap().1);
        assert!(!credit.should_snapshot());
    }

    #[test]
    fn dirty_frame_copies_packed_rows_and_a_skipped_update_forces_full_snapshot() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&output);
        let context = context(Arc::new(move |value| {
            if let Output::Frame(bytes) = value {
                capture.lock().unwrap().push(bytes);
            }
            true
        }));
        let stride = 200 * 4 + 8;
        let mut pixels = vec![0_u8; stride * 200];
        pixels[stride + 8..stride + 16].copy_from_slice(&[9, 8, 7, 0, 6, 5, 4, 0]);
        unsafe {
            frame(
                &context,
                200,
                200,
                2,
                1,
                2,
                1,
                pixels.as_ptr(),
                stride as u32,
            )
        };
        let first = output.lock().unwrap()[0].clone();
        assert_eq!(&first[FRAME_HEADER..], &[9, 8, 7, 255, 6, 5, 4, 255]);
        let sequence = u32::from_le_bytes(first[4..8].try_into().unwrap());
        unsafe {
            frame(
                &context,
                200,
                200,
                0,
                3,
                1,
                1,
                pixels.as_ptr(),
                stride as u32,
            )
        };
        assert_eq!(output.lock().unwrap().len(), 1);
        context.frames.acknowledge(sequence);
        unsafe {
            frame(
                &context,
                200,
                200,
                9,
                9,
                1,
                1,
                pixels.as_ptr(),
                stride as u32,
            )
        };
        let frames = output.lock().unwrap();
        assert_eq!(frames[1].len(), FRAME_HEADER + 200 * 200 * 4);
        assert_eq!(&frames[1][16..24], &[0; 8]);
    }

    #[tokio::test]
    async fn closing_a_session_interrupts_a_server_stalled_during_handshake() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let manager = RdpManager::default();
        let id = manager
            .start(
                ConnectOptions {
                    host: "127.0.0.1".into(),
                    server_name: "localhost".into(),
                    config_dir: std::env::temp_dir().join("xsh-rdp-handshake-test"),
                    port: listener.local_addr().unwrap().port(),
                    username: "test".into(),
                    password: Zeroizing::new("test".into()),
                    width: 800,
                    height: 600,
                },
                Arc::new(|_| true),
            )
            .unwrap();
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut header = [0_u8; 4];
        tokio::time::timeout(Duration::from_secs(2), socket.read_exact(&mut header))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            header[0], 3,
            "native engine must send a real TPKT handshake"
        );
        tokio::time::timeout(Duration::from_secs(3), manager.close(id))
            .await
            .unwrap();
        let mut remaining = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut remaining))
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn desktop_size_budget_allows_4k_and_rejects_unbounded_surfaces() {
        assert!(validate_size(3840, 2160).is_ok());
        assert!(validate_size(8192, 8192).is_err());
        assert!(validate_size(u32::MAX, 2160).is_err());
    }
}
