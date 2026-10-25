use crate::{CertificateChallenge, ConnectOptions, Event, Input, Output, SessionContext};
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::NonNull;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use uuid::Uuid;
use zeroize::Zeroizing;

#[repr(C)]
struct Config {
    host: *const c_char,
    server_name: *const c_char,
    config_dir: *const c_char,
    username: *const c_char,
    domain: *const c_char,
    password: *const c_char,
    port: u32,
    width: u32,
    height: u32,
}

#[repr(C)]
struct Callbacks {
    frame: unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32, u32, u32, *const u8, u32),
    certificate: unsafe extern "C" fn(
        *mut c_void,
        *const c_char,
        u32,
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        u32,
    ) -> c_int,
    clipboard: unsafe extern "C" fn(*mut c_void, *const u8, usize),
    cursor: unsafe extern "C" fn(*mut c_void, u32, u32, u32, u32, u32, *const u8),
    capabilities: unsafe extern "C" fn(*mut c_void, u32, u64),
}

unsafe extern "C" {
    fn xsh_rdp_global_init() -> c_int;
    fn xsh_rdp_new(
        config: *const Config,
        callbacks: *const Callbacks,
        user: *mut c_void,
    ) -> *mut c_void;
    fn xsh_rdp_connect(rdp: *mut c_void) -> c_int;
    fn xsh_rdp_step(rdp: *mut c_void, timeout_ms: u32) -> c_int;
    fn xsh_rdp_abort(rdp: *mut c_void);
    fn xsh_rdp_disconnect(rdp: *mut c_void);
    fn xsh_rdp_free(rdp: *mut c_void);
    fn xsh_rdp_error(rdp: *mut c_void) -> *const c_char;
    fn xsh_rdp_snapshot(rdp: *mut c_void);
    fn xsh_rdp_key(rdp: *mut c_void, scan: u32, down: c_int, extended: c_int) -> c_int;
    fn xsh_rdp_unicode(rdp: *mut c_void, code: u16, down: c_int) -> c_int;
    fn xsh_rdp_mouse(rdp: *mut c_void, flags: u16, x: u16, y: u16) -> c_int;
    fn xsh_rdp_resize(rdp: *mut c_void, width: u32, height: u32) -> c_int;
    fn xsh_rdp_clipboard(rdp: *mut c_void, data: *const u8, len: usize) -> c_int;
}

pub(super) struct Engine {
    pointer: NonNull<c_void>,
    context: Arc<SessionContext>,
}

impl Engine {
    pub fn new(options: &ConnectOptions, context: &Arc<SessionContext>) -> Result<Self, String> {
        static INITIALIZED: OnceLock<bool> = OnceLock::new();
        if !*INITIALIZED.get_or_init(|| unsafe { xsh_rdp_global_init() != 0 }) {
            return Err("无法初始化内置 RDP 通道。".into());
        }
        let string = |value: &str| CString::new(value).map_err(|_| "RDP 配置含空字符。".to_owned());
        let host = string(&options.host)?;
        let server_name = string(&options.server_name)?;
        let config_dir = string(&options.config_dir.to_string_lossy())?;
        let (domain, username) = options
            .username
            .split_once('\\')
            .unwrap_or(("", &options.username));
        let domain = string(domain)?;
        let username = string(username)?;
        let mut password = Zeroizing::new(options.password.as_bytes().to_vec());
        password.push(0);
        let config = Config {
            host: host.as_ptr(),
            server_name: server_name.as_ptr(),
            config_dir: config_dir.as_ptr(),
            username: username.as_ptr(),
            domain: domain.as_ptr(),
            password: password.as_ptr().cast(),
            port: options.port.into(),
            width: options.width,
            height: options.height,
        };
        let callbacks = Callbacks {
            frame: on_frame,
            certificate: on_certificate,
            clipboard: on_clipboard,
            cursor: on_cursor,
            capabilities: on_capabilities,
        };
        // SAFETY: the native constructor copies the configuration and callbacks.
        // context is kept alive until after native disconnect/free.
        let pointer =
            unsafe { xsh_rdp_new(&config, &callbacks, Arc::as_ptr(context).cast_mut().cast()) };
        let pointer = NonNull::new(pointer).ok_or("无法初始化内置 RDP 引擎。")?;
        *context.native_pointer.lock().unwrap() = Some(pointer.as_ptr() as usize);
        Ok(Self {
            pointer,
            context: Arc::clone(context),
        })
    }

    pub fn connect(&self) -> Result<(), String> {
        if unsafe { xsh_rdp_connect(self.pointer.as_ptr()) } == 0 {
            Err(self.error())
        } else {
            Ok(())
        }
    }

    pub fn step(&self) -> Result<bool, String> {
        match unsafe { xsh_rdp_step(self.pointer.as_ptr(), 20) } {
            value if value < 0 => Err(self.error()),
            0 => Ok(false),
            _ => Ok(true),
        }
    }

    pub fn snapshot(&self) {
        unsafe { xsh_rdp_snapshot(self.pointer.as_ptr()) };
    }

    pub fn input(&self, input: Input) -> Result<(), String> {
        let pointer = self.pointer.as_ptr();
        let success = match input {
            Input::CtrlAltDel => {
                let mut success = true;
                for (scan, extended, down) in [
                    (0x1d, 0, 1),
                    (0x38, 0, 1),
                    (0x53, 1, 1),
                    (0x53, 1, 0),
                    (0x38, 0, 0),
                    (0x1d, 0, 0),
                ] {
                    success &= unsafe { xsh_rdp_key(pointer, scan, down, extended) != 0 };
                }
                success
            }
            Input::Key {
                scan,
                down,
                extended,
            } => unsafe { xsh_rdp_key(pointer, scan.into(), down.into(), extended.into()) != 0 },
            Input::Text { text } => {
                let mut success = true;
                for code in text.encode_utf16() {
                    if self.context.cancelled.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    success &= unsafe { xsh_rdp_unicode(pointer, code, 1) != 0 };
                    success &= unsafe { xsh_rdp_unicode(pointer, code, 0) != 0 };
                }
                success
            }
            Input::Mouse { flags, x, y } => unsafe { xsh_rdp_mouse(pointer, flags, x, y) != 0 },
            Input::Resize { width, height } => {
                if unsafe { xsh_rdp_resize(pointer, width, height) } == 0 {
                    self.context.emit(Output::Event(Event::Warning {
                        message: "服务器未接受新的桌面尺寸，请检查服务器的分辨率限制。".into(),
                    }));
                }
                true
            }
            Input::Clipboard { text } => {
                if unsafe { xsh_rdp_clipboard(pointer, text.as_ptr(), text.len()) } == 0 {
                    self.context.emit(Output::Event(Event::Warning {
                        message: "剪贴板同步失败，请重试或检查服务器的剪贴板策略。".into(),
                    }));
                }
                true
            }
        };
        if success { Ok(()) } else { Err(self.error()) }
    }

    fn error(&self) -> String {
        let message = unsafe { xsh_rdp_error(self.pointer.as_ptr()) };
        if message.is_null() {
            "RDP 连接失败。".into()
        } else {
            format!(
                "RDP：{}",
                unsafe { CStr::from_ptr(message) }.to_string_lossy()
            )
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Serialize against the only operation allowed on a second thread.
        *self.context.native_pointer.lock().unwrap() = None;
        unsafe {
            xsh_rdp_disconnect(self.pointer.as_ptr());
            xsh_rdp_free(self.pointer.as_ptr());
        }
    }
}

pub(super) unsafe fn abort(pointer: usize) {
    unsafe { xsh_rdp_abort(pointer as *mut c_void) };
}

#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn on_frame(
    user: *mut c_void,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    data: *const u8,
    stride: u32,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        crate::frame(
            &*user.cast::<SessionContext>(),
            width,
            height,
            x,
            y,
            w,
            h,
            data,
            stride,
        );
    }));
}

#[allow(clippy::too_many_arguments)]
unsafe extern "C" fn on_certificate(
    user: *mut c_void,
    host: *const c_char,
    port: u32,
    subject: *const c_char,
    issuer: *const c_char,
    fingerprint: *const c_char,
    old: *const c_char,
    flags: u32,
) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        let string = |value: *const c_char| {
            if value.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(value) }
                    .to_string_lossy()
                    .into_owned()
            }
        };
        let context = unsafe { &*user.cast::<SessionContext>() };
        context
            .certificate(CertificateChallenge {
                challenge_id: Uuid::new_v4(),
                host: string(host),
                port,
                subject: string(subject),
                issuer: string(issuer),
                fingerprint: string(fingerprint),
                previous_fingerprint: string(old),
                flags,
            })
            .into()
    }))
    .unwrap_or(0)
}

unsafe extern "C" fn on_clipboard(user: *mut c_void, data: *const u8, length: usize) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if data.is_null() || length > crate::MAX_CLIPBOARD_BYTES {
            return;
        }
        let context = unsafe { &*user.cast::<SessionContext>() };
        if context.cancelled.load(Ordering::Acquire) {
            return;
        }
        let bytes = unsafe { std::slice::from_raw_parts(data, length) };
        if let Ok(text) = std::str::from_utf8(bytes) {
            context.emit(Output::Event(Event::Clipboard { text: text.into() }));
        }
    }));
}

unsafe extern "C" fn on_capabilities(user: *mut c_void, flags: u32, max_pixels: u64) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let context = unsafe { &*user.cast::<SessionContext>() };
        if !context.cancelled.load(Ordering::Acquire) {
            context.emit(Output::Event(Event::Capabilities {
                clipboard: flags & 1 != 0,
                resize: flags & 2 != 0,
                max_pixels: max_pixels.min(crate::MAX_PIXELS),
            }));
        }
    }));
}

unsafe extern "C" fn on_cursor(
    user: *mut c_void,
    kind: u32,
    width: u32,
    height: u32,
    hotspot_x: u32,
    hotspot_y: u32,
    data: *const u8,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let context = unsafe { &*user.cast::<SessionContext>() };
        if context.cancelled.load(Ordering::Acquire) {
            return;
        }
        let shape = kind == 2;
        if kind > 2
            || (shape
                && (width == 0
                    || height == 0
                    || width > crate::MAX_CURSOR_SIZE
                    || height > crate::MAX_CURSOR_SIZE
                    || hotspot_x >= width
                    || hotspot_y >= height
                    || data.is_null()))
            || (!shape && (width != 0 || height != 0 || hotspot_x != 0 || hotspot_y != 0))
        {
            return;
        }
        let length = if shape {
            (width * height * 4) as usize
        } else {
            0
        };
        let mut bytes = Vec::with_capacity(24 + length);
        for value in [
            crate::CURSOR_MAGIC,
            kind,
            width,
            height,
            hotspot_x,
            hotspot_y,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        if shape {
            bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(data, length) });
        }
        context.emit(Output::Cursor(bytes));
    }));
}
