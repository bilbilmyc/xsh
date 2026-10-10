//! A local mock SSH+SFTP server for exercising XSH end to end without a
//! real remote host: password auth accepts anything, the shell answers a few
//! commands (`echo`, `ping`, `flood <MiB>` for output-backpressure testing),
//! and the `sftp` subsystem is backed by a real directory on disk. The host
//! key is static so TOFU trust survives restarts.
//!
//! Run with: cargo run -p xsh-sftp --example mock_sshd -- --port 2222 --root C:/tmp/mock-root

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::decode_secret_key;
use russh::server::{Auth, Msg, Server as _};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use russh_sftp::server::Handler as SftpHandler;
use tokio::sync::Mutex;

// ssh-keygen -t ed25519 (no passphrase); embedded so the example needs no
// rand dependency and the fingerprint is stable.
const HOST_KEY_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAYqUsCFfdDEPu+bzYFy9DtM3a+rEkRQl9z9QcZOPnuGAAAAJif7gdcn+4H
XAAAAAtzc2gtZWQyNTUxOQAAACAYqUsCFfdDEPu+bzYFy9DtM3a+rEkRQl9z9QcZOPnuGA
AAAEChj0y+gd7GA87FigcZeiUAP/DDSSPgV7wwTNUgSZTj/BipSwIV90MQ+75vNgXL0O0z
dr6sSRFCX3P1Bxk4+e4YAAAAFVNvcmVuQERFU0tUT1AtNVI4NEZPRA==
-----END OPENSSH PRIVATE KEY-----";

const BANNER: &str =
    "\r\nXSH mock sshd ready.\r\nCommands: echo <text> | ping | flood <MiB>\r\n\r\n";

#[derive(Clone)]
struct Server {
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
    sftp_channels: Arc<Mutex<std::collections::HashSet<ChannelId>>>,
    root: PathBuf,
    pending_line: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut port: u16 = 2222;
    let mut root = std::env::temp_dir().join("xsh-mock-sshd-root");
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--port" => port = args.next().and_then(|v| v.parse().ok()).unwrap_or(port),
            "--root" => {
                root = args
                    .next()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| root.clone())
            }
            _ => {}
        }
    }
    std::fs::create_dir_all(&root)?;

    let config = russh::server::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        auth_rejection_time: Duration::from_millis(100),
        auth_rejection_time_initial: Some(Duration::from_millis(100)),
        keys: vec![decode_secret_key(HOST_KEY_PEM, None)?],
        ..Default::default()
    };

    let mut server = Server {
        channels: Arc::new(Mutex::new(HashMap::new())),
        sftp_channels: Arc::new(Mutex::new(std::collections::HashSet::new())),
        root,
        pending_line: String::new(),
    };
    eprintln!(
        "mock sshd listening on 127.0.0.1:{port}, sftp root: {}",
        server.root.display()
    );
    server
        .run_on_address(Arc::new(config), ("127.0.0.1", port))
        .await?;
    Ok(())
}

impl russh::server::Server for Server {
    type Handler = Self;

    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self::Handler {
        self.clone()
    }
}

impl russh::server::Handler for Server {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, BANNER.as_bytes().to_vec())?;
        session.data(channel, b"mock$ ".to_vec())?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let command = String::from_utf8_lossy(data).trim().to_owned();
        self.run_shell_command(channel, command, session).await?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        let Some(channel) = self.channels.lock().await.remove(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        session.channel_success(channel.id())?;
        // Binary channel: incoming data must reach only the SFTP stream. The
        // handler-level data() callback still fires for it in russh, so it is
        // excluded from terminal handling.
        self.sftp_channels.lock().await.insert(channel.id());
        let handler = MockSftp {
            root: self.root.clone(),
            handles: HashMap::new(),
            next_handle: 0,
        };
        russh_sftp::server::run(channel.into_stream(), handler).await;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        if self.sftp_channels.lock().await.contains(&channel) {
            return Ok(());
        }
        for byte in data {
            let text = *byte as char;
            if text == '\r' || text == '\n' {
                let line = std::mem::take(&mut self.pending_line);
                self.run_shell_command(channel, line, session).await?;
            } else {
                self.pending_line.push(text);
            }
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.close(channel)?;
        Ok(())
    }
}

impl Server {
    async fn run_shell_command(
        &mut self,
        channel: ChannelId,
        line: String,
        session: &mut russh::server::Session,
    ) -> Result<(), russh::Error> {
        let line = line.trim();
        let (command, argument) = line.split_once(' ').unwrap_or((line, ""));
        match command {
            "" => {}
            "ping" => {
                session.data(channel, b"pong\r\n".to_vec())?;
            }
            "echo" => {
                let mut reply = argument.as_bytes().to_vec();
                reply.extend_from_slice(b"\r\n");
                session.data(channel, reply)?;
            }
            "flood" => {
                let megabytes: u64 = argument.trim().parse().unwrap_or(8);
                let total = megabytes * 1024 * 1024;
                let pattern =
                    b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-*#.\r\n";
                let mut sent: u64 = 0;
                let mut index: usize = 0;
                // Async channel writes pace on the SSH window, so the client
                // renderer's acknowledgement/backpressure is what limits the
                // rate — exactly what this command exists to exercise.
                let channel_handle = match self.channels.lock().await.remove(&channel) {
                    Some(handle) => handle,
                    None => return Ok(()),
                };
                let mut remaining = total;
                while remaining > 0 {
                    let chunk_len = remaining.min(32 * 1024) as usize;
                    let mut chunk = Vec::with_capacity(chunk_len);
                    for _ in 0..chunk_len {
                        chunk.push(pattern[index % pattern.len()]);
                        index = index.wrapping_add(1);
                    }
                    channel_handle.data_bytes(chunk).await?;
                    remaining -= chunk_len as u64;
                    sent += chunk_len as u64;
                }
                channel_handle
                    .data(format!("\r\n[flood] sent {sent} bytes\r\n").as_bytes())
                    .await?;
                self.channels.lock().await.insert(channel, channel_handle);
            }
            "exit" => {
                session.close(channel)?;
                return Ok(());
            }
            unknown => {
                session.data(
                    channel,
                    format!("mock sshd: unknown command: {unknown}\r\n")
                        .as_bytes()
                        .to_vec(),
                )?;
            }
        }
        session.data(channel, b"mock$ ".to_vec())?;
        Ok(())
    }
}

struct MockSftp {
    root: PathBuf,
    handles: HashMap<String, SftpHandle>,
    next_handle: u64,
}

enum SftpHandle {
    Read { file: std::fs::File },
    Write { file: std::fs::File },
    Dir { entries: std::vec::IntoIter<File> },
}

impl MockSftp {
    fn resolve(&self, path: &str) -> Result<PathBuf, StatusCode> {
        let mut resolved = self.root.clone();
        for component in path.replace('\\', "/").split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    if !resolved.pop() {
                        return Err(StatusCode::PermissionDenied);
                    }
                }
                value => resolved.push(value),
            }
        }
        Ok(resolved)
    }

    fn virtual_path(&self, path: &Path) -> String {
        let relative = path
            .strip_prefix(&self.root)
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        format!("/{relative}")
    }

    fn attrs_of(metadata: &std::fs::Metadata) -> FileAttributes {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as u32);
        FileAttributes {
            size: Some(metadata.len()),
            permissions: Some(if metadata.is_dir() {
                0o040_755
            } else {
                0o100_644
            }),
            atime: modified,
            mtime: modified,
            ..FileAttributes::empty()
        }
    }

    fn ok_status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "ok".into(),
            language_tag: "en-US".into(),
        }
    }

    fn next_handle(&mut self, id: u32) -> Handle {
        let handle = format!("h{}", self.next_handle);
        self.next_handle += 1;
        Handle { id, handle }
    }
}

impl SftpHandler for MockSftp {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = self.resolve(&filename)?;
        let handle = self.next_handle(id);
        if pflags.contains(OpenFlags::READ) {
            let file = std::fs::File::open(&path).map_err(|_| StatusCode::NoSuchFile)?;
            self.handles
                .insert(handle.handle.clone(), SftpHandle::Read { file });
        } else if pflags.contains(OpenFlags::CREATE) {
            let file = if pflags.contains(OpenFlags::EXCLUDE) {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
            } else {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .open(&path)
            }
            .map_err(|_| StatusCode::Failure)?;
            self.handles
                .insert(handle.handle.clone(), SftpHandle::Write { file });
        } else {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(|_| StatusCode::NoSuchFile)?;
            self.handles
                .insert(handle.handle.clone(), SftpHandle::Write { file });
        }
        Ok(handle)
    }

    async fn close(&mut self, _id: u32, handle: String) -> Result<Status, Self::Error> {
        self.handles.remove(&handle);
        Ok(Self::ok_status(_id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let Some(SftpHandle::Read { file }) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| StatusCode::Failure)?;
        let mut buffer = vec![0_u8; len as usize];
        let read = file.read(&mut buffer).map_err(|_| StatusCode::Failure)?;
        if read == 0 {
            return Err(StatusCode::Eof);
        }
        buffer.truncate(read);
        Ok(Data { id, data: buffer })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        let Some(SftpHandle::Write { file }) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| StatusCode::Failure)?;
        file.write_all(&data).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let resolved = self.resolve(&path)?;
        let metadata = std::fs::symlink_metadata(&resolved).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(russh_sftp::protocol::Attrs {
            id,
            attrs: Self::attrs_of(&metadata),
        })
    }

    async fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        self.lstat(id, path).await
    }

    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(Self::ok_status(id))
    }

    async fn fsetstat(
        &mut self,
        id: u32,
        _handle: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(Self::ok_status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let resolved = self.resolve(&path)?;
        let entries = std::fs::read_dir(&resolved).map_err(|_| StatusCode::NoSuchFile)?;
        let mut files = Vec::new();
        for entry in entries.flatten() {
            let metadata = entry.metadata().ok();
            let attrs = metadata.as_ref().map(Self::attrs_of).unwrap_or_default();
            files.push(File {
                filename: entry.file_name().to_string_lossy().into_owned(),
                longname: String::new(),
                attrs,
            });
        }
        let handle = self.next_handle(id);
        self.handles.insert(
            handle.handle.clone(),
            SftpHandle::Dir {
                entries: files.into_iter(),
            },
        );
        Ok(handle)
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let Some(SftpHandle::Dir { entries }) = self.handles.get_mut(&handle) else {
            return Err(StatusCode::NoSuchFile);
        };
        let files: Vec<File> = entries.take(512).collect();
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Name { id, files })
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&filename)?;
        std::fs::remove_file(&resolved).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Self::ok_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&path)?;
        std::fs::create_dir(&resolved).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let resolved = self.resolve(&path)?;
        std::fs::remove_dir(&resolved).map_err(|_| StatusCode::Failure)?;
        Ok(Self::ok_status(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let resolved = self.resolve(&path)?;
        let virtual_path = if resolved == self.root {
            "/".to_owned()
        } else {
            self.virtual_path(&resolved)
        };
        Ok(Name {
            id,
            files: vec![File::dummy(virtual_path)],
        })
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let from = self.resolve(&oldpath)?;
        let to = self.resolve(&newpath)?;
        // SFTP-reject-on-existing semantics, so XSH's journaled remote
        // replace flow gets exercised against this server too.
        if to.exists() {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(&from, &to).map_err(|_| StatusCode::NoSuchFile)?;
        Ok(Self::ok_status(id))
    }
}
