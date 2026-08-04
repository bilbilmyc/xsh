use super::*;
use russh_sftp::protocol::{Data, FileAttributes, Handle, Status, Version};
use russh_sftp::server::Handler;
use std::collections::{HashMap, HashSet};

const REMOTE_PATH: &str = "/fixtures/archive.bin";
const SOURCE_IDENTITY: &str = "fixture.example.com:22:SHA256:test";
const MODIFIED_AT_UNIX: u32 = 1_700_000_000;
const PROTOCOL_TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
struct ReadObservation {
    handle: String,
    offset: u64,
    requested: usize,
    returned: Option<usize>,
    status: Option<StatusCode>,
}

struct ReadServer {
    data: Arc<Vec<u8>>,
    max_chunk: usize,
    fail_at_or_after: Option<u64>,
    observations: Arc<StdMutex<Vec<ReadObservation>>>,
    open_handles: HashSet<String>,
    next_handle: u64,
}

impl ReadServer {
    fn new(
        data: Arc<Vec<u8>>,
        max_chunk: usize,
        fail_at_or_after: Option<u64>,
        observations: Arc<StdMutex<Vec<ReadObservation>>>,
    ) -> Self {
        Self {
            data,
            max_chunk: max_chunk.max(1),
            fail_at_or_after,
            observations,
            open_handles: HashSet::new(),
            next_handle: 0,
        }
    }

    fn record_read(&self, observation: ReadObservation) {
        self.observations
            .lock()
            .expect("read observation lock")
            .push(observation);
    }
}

impl Handler for ReadServer {
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
        if filename != REMOTE_PATH {
            return Err(StatusCode::NoSuchFile);
        }
        if !pflags.contains(OpenFlags::READ) {
            return Err(StatusCode::PermissionDenied);
        }
        let handle = format!("read-{}", self.next_handle);
        self.next_handle += 1;
        self.open_handles.insert(handle.clone());
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.open_handles.remove(&handle);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: StatusCode::Ok.to_string(),
            language_tag: "en-US".to_owned(),
        })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        if !self.open_handles.contains(&handle) {
            return Err(StatusCode::NoSuchFile);
        }
        let requested = len as usize;
        if self
            .fail_at_or_after
            .is_some_and(|failure_offset| offset >= failure_offset)
        {
            self.record_read(ReadObservation {
                handle,
                offset,
                requested,
                returned: None,
                status: Some(StatusCode::ConnectionLost),
            });
            return Err(StatusCode::ConnectionLost);
        }
        let start = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
        if start >= self.data.len() {
            return Err(StatusCode::Eof);
        }
        let returned = requested
            .min(self.max_chunk)
            .min(self.data.len().saturating_sub(start));
        self.record_read(ReadObservation {
            handle,
            offset,
            requested,
            returned: Some(returned),
            status: None,
        });
        Ok(Data {
            id,
            data: self.data[start..start + returned].to_vec(),
        })
    }
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    async fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("xsh-sftp-{label}-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&path)
            .await
            .expect("create test directory");
        Self(path)
    }

    fn join(&self, path: &str) -> PathBuf {
        self.0.join(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn connect_read_server(
    data: Arc<Vec<u8>>,
    max_chunk: usize,
    fail_at_or_after: Option<u64>,
) -> (SftpSession, Arc<StdMutex<Vec<ReadObservation>>>) {
    let observations = Arc::new(StdMutex::new(Vec::new()));
    let handler = ReadServer::new(data, max_chunk, fail_at_or_after, Arc::clone(&observations));
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    russh_sftp::server::run(server_stream, handler).await;
    let session = SftpSession::new(client_stream)
        .await
        .expect("initialize in-process SFTP client");
    (session, observations)
}

fn fixture_bytes(len: usize) -> Arc<Vec<u8>> {
    Arc::new(
        (0..len)
            .map(|index| ((index.wrapping_mul(31).wrapping_add(17)) % 251) as u8)
            .collect(),
    )
}

fn transfer_run_gate() -> TransferRunGate {
    TransferRunGate::new(
        TransferScheduler::default(),
        Uuid::new_v4(),
        SOURCE_IDENTITY.to_owned(),
    )
}

fn download_request(destination: &Path, total_bytes: u64) -> DownloadFileRequest<'_> {
    DownloadFileRequest {
        remote_path: REMOTE_PATH,
        local_path: destination,
        overwrite: false,
        total_bytes,
        modified_at_unix: Some(MODIFIED_AT_UNIX),
        source_identity: SOURCE_IDENTITY,
    }
}

#[tokio::test]
async fn protocol_download_handles_repeated_short_reads_without_truncation() {
    let data = fixture_bytes(2 * 1024 * 1024 + 137);
    let (session, observations) = connect_read_server(Arc::clone(&data), 32 * 1024, None).await;
    let directory = TestDirectory::new("protocol-short-read").await;
    let destination = directory.join("archive.bin");
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let mut run_gate = transfer_run_gate();
    let mut progress = Vec::new();

    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &session,
            download_request(&destination, data.len() as u64),
            &mut control,
            &mut run_gate,
            |transferred| progress.push(transferred),
        ),
    )
    .await
    .expect("short-read protocol test timed out")
    .expect("download through short-reading SFTP server");

    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        data.as_ref().as_slice()
    );
    assert_eq!(progress.first(), Some(&0));
    assert_eq!(progress.last(), Some(&(data.len() as u64)));
    assert!(
        !tokio::fs::try_exists(download_temporary_path(&destination))
            .await
            .unwrap()
    );
    assert!(
        !tokio::fs::try_exists(download_metadata_path(&destination))
            .await
            .unwrap()
    );

    let observations = observations.lock().unwrap().clone();
    assert!(
        observations
            .iter()
            .all(|read| read.returned.is_none_or(|bytes| bytes <= 32 * 1024))
    );
    assert!(observations.iter().any(|read| {
        read.returned
            .is_some_and(|returned| read.requested > returned && returned == 32 * 1024)
    }));
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_download_resumes_after_an_injected_connection_loss() {
    const MAX_CHUNK: usize = 32 * 1024;
    const FAILURE_OFFSET: u64 = (5 * MAX_CHUNK) as u64;

    let data = fixture_bytes(1024 * 1024 + 91);
    let directory = TestDirectory::new("protocol-resume").await;
    let destination = directory.join("archive.bin");
    let temporary = download_temporary_path(&destination);
    let metadata_path = download_metadata_path(&destination);

    let (failed_session, failed_observations) =
        connect_read_server(Arc::clone(&data), MAX_CHUNK, Some(FAILURE_OFFSET)).await;
    let (_failed_control, mut failed_control) = watch::channel(TransferControl::Running);
    let mut failed_gate = transfer_run_gate();
    tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &failed_session,
            download_request(&destination, data.len() as u64),
            &mut failed_control,
            &mut failed_gate,
            |_| {},
        ),
    )
    .await
    .expect("connection-loss protocol test timed out")
    .expect_err("injected connection loss must fail the first attempt");
    drop(failed_gate);

    assert!(!tokio::fs::try_exists(&destination).await.unwrap());
    assert_eq!(
        tokio::fs::read(&temporary).await.unwrap(),
        data[..FAILURE_OFFSET as usize]
    );
    let saved_metadata: DownloadResumeMetadata =
        serde_json::from_slice(&tokio::fs::read(&metadata_path).await.unwrap()).unwrap();
    assert_eq!(
        saved_metadata,
        DownloadResumeMetadata {
            version: DOWNLOAD_RESUME_METADATA_VERSION,
            remote_path: REMOTE_PATH.to_owned(),
            total_bytes: data.len() as u64,
            modified_at_unix: Some(MODIFIED_AT_UNIX),
            source_identity: SOURCE_IDENTITY.to_owned(),
        }
    );
    assert!(failed_observations.lock().unwrap().iter().any(|read| {
        read.offset == FAILURE_OFFSET && read.status == Some(StatusCode::ConnectionLost)
    }));
    failed_session.close().await.unwrap();

    let (resumed_session, resumed_observations) =
        connect_read_server(Arc::clone(&data), MAX_CHUNK, None).await;
    let (_resumed_control, mut resumed_control) = watch::channel(TransferControl::Running);
    let mut resumed_gate = transfer_run_gate();
    let mut resumed_progress = Vec::new();
    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &resumed_session,
            download_request(&destination, data.len() as u64),
            &mut resumed_control,
            &mut resumed_gate,
            |transferred| resumed_progress.push(transferred),
        ),
    )
    .await
    .expect("resume protocol test timed out")
    .expect("resume download through a new SFTP session");

    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(resumed_progress.first(), Some(&FAILURE_OFFSET));
    assert_eq!(resumed_progress.last(), Some(&(data.len() as u64)));
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        data.as_ref().as_slice()
    );
    assert!(!tokio::fs::try_exists(&temporary).await.unwrap());
    assert!(!tokio::fs::try_exists(&metadata_path).await.unwrap());

    let observations = resumed_observations.lock().unwrap().clone();
    let resumed_handle = observations
        .iter()
        .find(|read| read.offset == FAILURE_OFFSET && read.returned.is_some())
        .map(|read| read.handle.as_str())
        .expect("main download must resume at the checkpoint offset");
    assert!(
        !observations
            .iter()
            .any(|read| { read.handle == resumed_handle && read.offset < FAILURE_OFFSET })
    );
    resumed_session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_resume_restarts_when_remote_samples_no_longer_match() {
    const PARTIAL_BYTES: usize = 5 * 32 * 1024;

    let data = fixture_bytes(1024 * 1024 + 47);
    let directory = TestDirectory::new("protocol-resume-mismatch").await;
    let destination = directory.join("archive.bin");
    let temporary = download_temporary_path(&destination);
    let metadata_path = download_metadata_path(&destination);
    let mut stale_partial = data[..PARTIAL_BYTES].to_vec();
    stale_partial[0] ^= 0xff;
    stale_partial[PARTIAL_BYTES - 1] ^= 0xff;
    tokio::fs::write(&temporary, stale_partial).await.unwrap();
    write_download_resume_metadata(
        &metadata_path,
        &DownloadResumeMetadata {
            version: DOWNLOAD_RESUME_METADATA_VERSION,
            remote_path: REMOTE_PATH.to_owned(),
            total_bytes: data.len() as u64,
            modified_at_unix: Some(MODIFIED_AT_UNIX),
            source_identity: SOURCE_IDENTITY.to_owned(),
        },
    )
    .await
    .unwrap();

    let (session, observations) = connect_read_server(Arc::clone(&data), 32 * 1024, None).await;
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let mut run_gate = transfer_run_gate();
    let mut progress = Vec::new();
    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &session,
            download_request(&destination, data.len() as u64),
            &mut control,
            &mut run_gate,
            |transferred| progress.push(transferred),
        ),
    )
    .await
    .expect("resume-mismatch protocol test timed out")
    .expect("restart download after resume sample mismatch");

    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(progress.first(), Some(&0));
    assert_eq!(progress.last(), Some(&(data.len() as u64)));
    assert_eq!(
        tokio::fs::read(&destination).await.unwrap(),
        data.as_ref().as_slice()
    );
    assert!(!tokio::fs::try_exists(&temporary).await.unwrap());
    assert!(!tokio::fs::try_exists(&metadata_path).await.unwrap());

    assert!(
        observations
            .lock()
            .unwrap()
            .iter()
            .any(|read| read.offset == 0 && read.returned.is_some())
    );
    session.close().await.unwrap();
}
