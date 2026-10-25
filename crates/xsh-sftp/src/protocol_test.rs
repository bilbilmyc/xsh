use super::*;
use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, Status, StatusCode, Version};
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
    reject_open: Option<u64>,
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
            reject_open: None,
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
        if self.reject_open == Some(self.next_handle - 1) {
            return Err(StatusCode::Failure);
        }
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
    connect_read_handler(handler).await
}

async fn connect_read_handler(
    handler: ReadServer,
) -> (SftpSession, Arc<StdMutex<Vec<ReadObservation>>>) {
    let observations = Arc::clone(&handler.observations);
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    russh_sftp::server::run(server_stream, handler).await;
    let session = SftpSession::new(client_stream)
        .await
        .expect("initialize in-process SFTP client");
    (session, observations)
}

#[tokio::test]
async fn managed_retry_events_keep_lineage_and_original_write_policy() {
    let (session, _) = connect_read_server(Arc::new(vec![1, 2, 3]), 1024, None).await;
    let manager = SftpManager::new();
    let directory = std::env::temp_dir().join(format!("xsh-retry-events-{}", Uuid::new_v4()));
    let local_path = directory.join("output.bin");
    let lease = manager
        .reserve_destination(TransferDestination::local(&local_path))
        .unwrap();
    let original_id = Uuid::new_v4();
    let batch_id = Uuid::new_v4();
    let mut subscription = manager
        .submit_managed_transfer(
            ManagedTransferParams {
                connection_id: Uuid::new_v4(),
                direction: TransferDirection::Download,
                local_path,
                remote_path: REMOTE_PATH.into(),
                total_bytes: 3,
                scheduler_host_key: "fixture.example.com:22".into(),
                destination_lease: lease,
                session: Arc::new(session),
                overwrite: false,
                retry_of: Some(original_id),
                retry_count: 2,
                batch_id: Some(batch_id),
            },
            |_session, _control, _gate, sink| async move {
                (Err(anyhow::anyhow!("injected retry failure")), sink)
            },
        )
        .await
        .unwrap();
    let events = tokio::time::timeout(PROTOCOL_TEST_TIMEOUT, async {
        let mut events = Vec::new();
        while let Some(event) = subscription.events.recv().await {
            let ended = event.status == TransferStatus::Failed;
            events.push(event);
            if ended {
                break;
            }
        }
        events
    })
    .await
    .expect("managed worker timed out");
    assert!(events.len() >= 2);
    assert!(
        events
            .iter()
            .all(|event| event.retry_of == Some(original_id) && event.retry_count == 2)
    );
    assert!(events.iter().all(|event| event.batch_id == Some(batch_id)));
    assert_eq!(
        events.last().unwrap().error.as_deref(),
        Some("injected retry failure")
    );
    let transfers = manager.inner.transfers.lock().await;
    let transfer = transfers.get(&subscription.transfer_id).unwrap();
    assert!(!transfer.overwrite);
    assert!(transfer_keeps_connection(transfer));
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
async fn protocol_download_reads_each_byte_once() {
    let data = fixture_bytes(4 * 1024 * 1024 + 137);
    let (session, observations) =
        connect_read_server(Arc::clone(&data), DOWNLOAD_CHUNK_BYTES, None).await;
    let directory = TestDirectory::new("download-wire-bytes").await;
    let destination = directory.join("archive.bin");
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &session,
            download_request(&destination, data.len() as u64),
            &mut control,
            &mut transfer_run_gate(),
            |_| {},
        ),
    )
    .await
    .expect("download timed out")
    .unwrap();
    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(tokio::fs::read(&destination).await.unwrap(), *data);
    let observations = observations.lock().unwrap().clone();
    let mut ranges = observations
        .iter()
        .filter_map(|read| read.returned.map(|bytes| (read.offset, bytes)))
        .collect::<Vec<_>>();
    ranges.sort_unstable();
    let returned_bytes: usize = ranges.iter().map(|(_, bytes)| bytes).sum();
    assert_eq!(
        returned_bytes,
        data.len(),
        "remote file data must not be downloaded repeatedly"
    );
    let mut expected_offset = 0;
    for (offset, bytes) in ranges {
        assert_eq!(
            offset, expected_offset,
            "download ranges must not overlap or skip bytes"
        );
        expected_offset += bytes as u64;
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_download_bounds_chunks_until_the_writer_consumes_them() {
    let data = fixture_bytes(64 * DOWNLOAD_CHUNK_BYTES);
    let (session, _) = connect_read_server(data.clone(), DOWNLOAD_CHUNK_BYTES, None).await;
    let (_control, control) = watch::channel(TransferControl::Running);
    let mut pipeline = spawn_download_pipeline(
        &session,
        REMOTE_PATH,
        0,
        data.len() as u64,
        TransferScheduler::default(),
        control,
    )
    .await
    .unwrap();
    let mut held = Vec::new();
    for _ in 0..DOWNLOAD_PIPELINE_HANDLES * 2 {
        let message = tokio::time::timeout(PROTOCOL_TEST_TIMEOUT, pipeline.receiver.recv())
            .await
            .expect("download stalled before reaching the buffer limit")
            .unwrap();
        assert!(matches!(message, DownloadReadMessage::Chunk { .. }));
        held.push(message);
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), pipeline.receiver.recv())
            .await
            .is_err(),
        "queued and out-of-order chunks must share one memory budget",
    );
    held.pop();
    let next = tokio::time::timeout(PROTOCOL_TEST_TIMEOUT, pipeline.receiver.recv())
        .await
        .expect("consuming a chunk must unblock its reader")
        .unwrap();
    assert!(matches!(next, DownloadReadMessage::Chunk { .. }));
    drop(pipeline);
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_download_recovers_when_the_first_handle_open_is_rejected() {
    let data = fixture_bytes(4 * DOWNLOAD_CHUNK_BYTES + 91);
    let mut handler = ReadServer::new(
        data.clone(),
        32 * 1024,
        None,
        Arc::new(StdMutex::new(Vec::new())),
    );
    handler.reject_open = Some(0);
    let (session, _) = connect_read_handler(handler).await;
    let directory = TestDirectory::new("download-rejected-open").await;
    let destination = directory.join("archive.bin");
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &session,
            download_request(&destination, data.len() as u64),
            &mut control,
            &mut transfer_run_gate(),
            |_| {},
        ),
    )
    .await
    .expect("a rejected handle must not stall the download")
    .unwrap();
    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(tokio::fs::read(destination).await.unwrap(), *data);
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_download_drop_releases_paused_readers() {
    let data = fixture_bytes(32 * DOWNLOAD_CHUNK_BYTES);
    let (session, _) = connect_read_server(data.clone(), DOWNLOAD_CHUNK_BYTES, None).await;
    let (control, receiver) = watch::channel(TransferControl::Paused);
    let pipeline = spawn_download_pipeline(
        &session,
        REMOTE_PATH,
        0,
        data.len() as u64,
        TransferScheduler::default(),
        receiver,
    )
    .await
    .unwrap();
    assert!(control.receiver_count() > 0);
    drop(pipeline);
    tokio::time::timeout(PROTOCOL_TEST_TIMEOUT, async {
        while control.receiver_count() > 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropping the writer left paused readers alive");
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_download_cancellation_preserves_only_the_contiguous_checkpoint() {
    let data = fixture_bytes(32 * DOWNLOAD_CHUNK_BYTES);
    let (session, _) = connect_read_server(data.clone(), 32 * 1024, None).await;
    let directory = TestDirectory::new("download-cancel").await;
    let destination = directory.join("archive.bin");
    let (sender, mut control) = watch::channel(TransferControl::Running);
    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &session,
            download_request(&destination, data.len() as u64),
            &mut control,
            &mut transfer_run_gate(),
            |bytes| {
                if bytes >= DOWNLOAD_CHUNK_BYTES as u64 {
                    sender.send_replace(TransferControl::Cancelled);
                }
            },
        ),
    )
    .await
    .expect("cancelled download did not stop")
    .unwrap();
    assert_eq!(status, TransferStatus::Cancelled);
    assert!(!tokio::fs::try_exists(&destination).await.unwrap());
    let partial = tokio::fs::read(download_temporary_path(&destination))
        .await
        .unwrap();
    assert!(!partial.is_empty() && partial.len() < data.len());
    assert_eq!(partial, data[..partial.len()]);
    tokio::time::timeout(PROTOCOL_TEST_TIMEOUT, async {
        while sender.receiver_count() > 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled download left background readers alive");
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_download_early_eof_does_not_deadlock_on_buffer_credit() {
    let data = fixture_bytes(2 * DOWNLOAD_CHUNK_BYTES + 17);
    let (session, _) = connect_read_server(data.clone(), 32 * 1024, None).await;
    let directory = TestDirectory::new("download-short-file").await;
    let destination = directory.join("archive.bin");
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let result = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        download_file(
            &session,
            download_request(&destination, (32 * DOWNLOAD_CHUNK_BYTES) as u64),
            &mut control,
            &mut transfer_run_gate(),
            |_| {},
        ),
    )
    .await
    .expect("an early EOF exhausted the buffer budget and deadlocked");
    assert!(result.is_err());
    assert!(!tokio::fs::try_exists(destination).await.unwrap());
    session.close().await.unwrap();
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

#[derive(Debug, Clone, PartialEq)]
struct WriteObservation {
    path: String,
    offset: u64,
    length: usize,
}

type RemoteTestFiles = Arc<StdMutex<HashMap<String, Vec<u8>>>>;

/// An in-memory SFTP server that records every data write. It backs the
/// upload pipeline's protocol-level tests the same way `ReadServer` backs the
/// download tests: real `SftpSession` traffic over an in-process duplex, with
/// controllable failure injection.
struct WriteServer {
    files: RemoteTestFiles,
    /// Reject renaming onto an existing path, like SFTP servers without the
    /// posix-rename extension; this is what makes finalize engage the
    /// journaled remote-replace path.
    reject_rename_onto_existing: bool,
    fail_after_writes: Option<usize>,
    writes_served: usize,
    observations: Arc<StdMutex<Vec<WriteObservation>>>,
    open_handles: HashMap<String, String>,
    next_handle: u64,
}

impl WriteServer {
    fn new(
        files: RemoteTestFiles,
        reject_rename_onto_existing: bool,
        fail_after_writes: Option<usize>,
        observations: Arc<StdMutex<Vec<WriteObservation>>>,
    ) -> Self {
        Self {
            files,
            reject_rename_onto_existing,
            fail_after_writes,
            writes_served: 0,
            observations,
            open_handles: HashMap::new(),
            next_handle: 0,
        }
    }
}

fn remote_file_attributes(len: u64) -> FileAttributes {
    FileAttributes {
        size: Some(len),
        permissions: Some(0o100_644),
        ..FileAttributes::empty()
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: StatusCode::Ok.to_string(),
        language_tag: "en-US".to_owned(),
    }
}

impl Handler for WriteServer {
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
        let exists = self.files.lock().unwrap().contains_key(&filename);
        if pflags.contains(OpenFlags::READ) && !exists {
            return Err(StatusCode::NoSuchFile);
        }
        if pflags.contains(OpenFlags::EXCLUDE) && exists {
            return Err(StatusCode::Failure);
        }
        if pflags.contains(OpenFlags::CREATE) {
            self.files
                .lock()
                .unwrap()
                .entry(filename.clone())
                .or_default();
        } else if !exists {
            return Err(StatusCode::NoSuchFile);
        }
        let handle = format!("write-{}", self.next_handle);
        self.next_handle += 1;
        self.open_handles.insert(handle.clone(), filename);
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, _id: u32, handle: String) -> Result<Status, Self::Error> {
        self.open_handles.remove(&handle);
        Ok(ok_status(_id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let Some(path) = self.open_handles.get(&handle).cloned() else {
            return Err(StatusCode::NoSuchFile);
        };
        let files = self.files.lock().unwrap();
        let Some(file) = files.get(&path) else {
            return Err(StatusCode::NoSuchFile);
        };
        let start = usize::try_from(offset).map_err(|_| StatusCode::Eof)?;
        if start >= file.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(file.len());
        Ok(Data {
            id,
            data: file[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let Some(path) = self.open_handles.get(&handle).cloned() else {
            return Err(StatusCode::NoSuchFile);
        };
        self.writes_served += 1;
        if self
            .fail_after_writes
            .is_some_and(|limit| self.writes_served > limit)
        {
            return Err(StatusCode::ConnectionLost);
        }
        self.observations.lock().unwrap().push(WriteObservation {
            path: path.clone(),
            offset,
            length: data.len(),
        });
        let mut files = self.files.lock().unwrap();
        let file = files.entry(path).or_default();
        let end = offset as usize + data.len();
        if file.len() < end {
            file.resize(end, 0);
        }
        file[offset as usize..end].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        match self.files.lock().unwrap().get(&path) {
            Some(file) => Ok(Attrs {
                id,
                attrs: remote_file_attributes(file.len() as u64),
            }),
            None => Err(StatusCode::NoSuchFile),
        }
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.lstat(id, path).await
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        self.files
            .lock()
            .unwrap()
            .remove(&filename)
            .map(|_| ok_status(id))
            .ok_or(StatusCode::NoSuchFile)
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let mut files = self.files.lock().unwrap();
        if self.reject_rename_onto_existing && files.contains_key(&newpath) {
            return Err(StatusCode::Failure);
        }
        match files.remove(&oldpath) {
            Some(data) => {
                files.insert(newpath, data);
                Ok(ok_status(id))
            }
            None => Err(StatusCode::NoSuchFile),
        }
    }
}

async fn connect_write_server_over(
    files: RemoteTestFiles,
    reject_rename_onto_existing: bool,
    fail_after_writes: Option<usize>,
) -> (SftpSession, Arc<StdMutex<Vec<WriteObservation>>>) {
    let observations = Arc::new(StdMutex::new(Vec::new()));
    let handler = WriteServer::new(
        files,
        reject_rename_onto_existing,
        fail_after_writes,
        Arc::clone(&observations),
    );
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    russh_sftp::server::run(server_stream, handler).await;
    let session = SftpSession::new(client_stream)
        .await
        .expect("initialize in-process SFTP client");
    (session, observations)
}

async fn connect_write_server(
    reject_rename_onto_existing: bool,
    fail_after_writes: Option<usize>,
) -> (
    SftpSession,
    RemoteTestFiles,
    Arc<StdMutex<Vec<WriteObservation>>>,
) {
    let files: RemoteTestFiles = Arc::new(StdMutex::new(HashMap::new()));
    let (session, observations) = connect_write_server_over(
        Arc::clone(&files),
        reject_rename_onto_existing,
        fail_after_writes,
    )
    .await;
    (session, files, observations)
}

async fn write_local_fixture(
    directory: &TestDirectory,
    data: &[u8],
) -> (PathBuf, UploadResumeMetadata) {
    let local_path = directory.join("upload.bin");
    tokio::fs::write(&local_path, data).await.unwrap();
    let metadata = tokio::fs::metadata(&local_path).await.unwrap();
    let expected = make_upload_resume_metadata(&local_path, REMOTE_PATH, &metadata);
    (local_path, expected)
}

#[tokio::test]
async fn protocol_upload_writes_the_full_file_and_finalizes() {
    let data = fixture_bytes(1024 * 1024 + 300);
    let directory = TestDirectory::new("protocol-upload").await;
    let (local_path, expected) = write_local_fixture(&directory, &data).await;
    let (session, files, observations) = connect_write_server(false, None).await;
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let mut run_gate = transfer_run_gate();
    let mut progress = Vec::new();

    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        upload_file(
            UploadFileRequest {
                session: &session,
                local_path: &local_path,
                remote_path: REMOTE_PATH,
                overwrite: false,
                expected_metadata: &expected,
            },
            &mut control,
            &mut run_gate,
            |transferred| progress.push(transferred),
        ),
    )
    .await
    .expect("upload protocol test timed out")
    .expect("upload through the in-process SFTP server");

    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(progress.first(), Some(&0));
    assert_eq!(progress.last(), Some(&(data.len() as u64)));
    {
        let files = files.lock().unwrap();
        assert_eq!(files.get(REMOTE_PATH).unwrap(), data.as_slice());
        assert!(!files.contains_key(&upload_temporary_path(REMOTE_PATH)));
        assert!(!files.contains_key(&upload_metadata_path(REMOTE_PATH)));
        assert!(!files.contains_key(&format!("{}.tmp", upload_metadata_path(REMOTE_PATH))));
    }

    let observations = observations.lock().unwrap().clone();
    let temporary_path = upload_temporary_path(REMOTE_PATH);
    let data_writes: Vec<&WriteObservation> = observations
        .iter()
        .filter(|write| write.path == temporary_path)
        .collect();
    assert!(!data_writes.is_empty());
    for (write, next) in data_writes.iter().zip(data_writes.iter().skip(1)) {
        assert_eq!(write.offset + write.length as u64, next.offset);
    }
    assert_eq!(
        data_writes
            .last()
            .map(|write| write.offset + write.length as u64),
        Some(data.len() as u64)
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_upload_resumes_from_a_remote_checkpoint() {
    const CHECKPOINT_BYTES: usize = 5 * 256 * 1024 + 123;

    let data = fixture_bytes(2 * 1024 * 1024 + 65);
    let directory = TestDirectory::new("protocol-upload-resume").await;
    let (local_path, expected) = write_local_fixture(&directory, &data).await;
    let (session, files, observations) = connect_write_server(false, None).await;
    {
        let mut files = files.lock().unwrap();
        files.insert(
            upload_temporary_path(REMOTE_PATH),
            data[..CHECKPOINT_BYTES].to_vec(),
        );
        files.insert(
            upload_metadata_path(REMOTE_PATH),
            serde_json::to_vec(&expected).unwrap(),
        );
    }
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let mut run_gate = transfer_run_gate();
    let mut progress = Vec::new();

    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        upload_file(
            UploadFileRequest {
                session: &session,
                local_path: &local_path,
                remote_path: REMOTE_PATH,
                overwrite: false,
                expected_metadata: &expected,
            },
            &mut control,
            &mut run_gate,
            |transferred| progress.push(transferred),
        ),
    )
    .await
    .expect("upload resume protocol test timed out")
    .expect("resume upload from a remote checkpoint");

    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(progress.first(), Some(&(CHECKPOINT_BYTES as u64)));
    assert_eq!(progress.last(), Some(&(data.len() as u64)));
    assert_eq!(
        files.lock().unwrap().get(REMOTE_PATH).unwrap(),
        data.as_slice()
    );

    let observations = observations.lock().unwrap().clone();
    assert!(
        observations
            .iter()
            .filter(|write| write.path == upload_temporary_path(REMOTE_PATH))
            .all(|write| write.offset >= CHECKPOINT_BYTES as u64)
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_upload_failure_leaves_a_resumable_checkpoint() {
    let data = fixture_bytes(1024 * 1024 + 21);
    let directory = TestDirectory::new("protocol-upload-failure").await;
    let (local_path, expected) = write_local_fixture(&directory, &data).await;
    let temporary_path = upload_temporary_path(REMOTE_PATH);
    let metadata_path = upload_metadata_path(REMOTE_PATH);

    let (failed_session, files, _failed_observations) = connect_write_server(false, Some(4)).await;
    let (_failed_control, mut failed_control) = watch::channel(TransferControl::Running);
    let mut failed_gate = transfer_run_gate();
    let failure = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        upload_file(
            UploadFileRequest {
                session: &failed_session,
                local_path: &local_path,
                remote_path: REMOTE_PATH,
                overwrite: false,
                expected_metadata: &expected,
            },
            &mut failed_control,
            &mut failed_gate,
            |_| {},
        ),
    )
    .await
    .expect("upload failure protocol test timed out")
    .expect_err("injected write failure must fail the upload");
    drop(failed_gate);
    assert!(
        format!("{failure:#}").contains("Connection lost"),
        "unexpected upload failure text: {failure:#}"
    );

    let checkpoint_bytes = files.lock().unwrap().get(&temporary_path).map(Vec::len);
    let checkpoint_bytes = checkpoint_bytes.expect("partial upload checkpoint");
    assert!(checkpoint_bytes > 0);
    assert_eq!(
        files.lock().unwrap().get(&temporary_path).unwrap(),
        &data[..checkpoint_bytes]
    );
    assert!(files.lock().unwrap().contains_key(&metadata_path));
    failed_session.close().await.unwrap();

    let (resumed_session, resumed_observations) =
        connect_write_server_over(Arc::clone(&files), false, None).await;
    let (_resumed_control, mut resumed_control) = watch::channel(TransferControl::Running);
    let mut resumed_gate = transfer_run_gate();
    let mut resumed_progress = Vec::new();
    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        upload_file(
            UploadFileRequest {
                session: &resumed_session,
                local_path: &local_path,
                remote_path: REMOTE_PATH,
                overwrite: false,
                expected_metadata: &expected,
            },
            &mut resumed_control,
            &mut resumed_gate,
            |transferred| resumed_progress.push(transferred),
        ),
    )
    .await
    .expect("upload failure resume protocol test timed out")
    .expect("resume upload after an injected write failure");

    assert_eq!(status, TransferStatus::Completed);
    assert_eq!(resumed_progress.first(), Some(&(checkpoint_bytes as u64)));
    assert_eq!(resumed_progress.last(), Some(&(data.len() as u64)));
    assert_eq!(
        files.lock().unwrap().get(REMOTE_PATH).unwrap(),
        data.as_slice()
    );
    let observations = resumed_observations.lock().unwrap().clone();
    assert!(
        observations
            .iter()
            .filter(|write| write.path == temporary_path)
            .all(|write| write.offset >= checkpoint_bytes as u64)
    );
    resumed_session.close().await.unwrap();
}

#[tokio::test]
async fn protocol_upload_replace_flow_overwrites_when_rename_is_rejected() {
    let data = fixture_bytes(512 * 1024 + 17);
    let directory = TestDirectory::new("protocol-upload-replace").await;
    let (local_path, expected) = write_local_fixture(&directory, &data).await;
    let (session, files, _observations) = connect_write_server(true, None).await;
    files
        .lock()
        .unwrap()
        .insert(REMOTE_PATH.to_owned(), b"stale-destination".to_vec());
    let (_control, mut control) = watch::channel(TransferControl::Running);
    let mut run_gate = transfer_run_gate();

    let status = tokio::time::timeout(
        PROTOCOL_TEST_TIMEOUT,
        upload_file(
            UploadFileRequest {
                session: &session,
                local_path: &local_path,
                remote_path: REMOTE_PATH,
                overwrite: true,
                expected_metadata: &expected,
            },
            &mut control,
            &mut run_gate,
            |_| {},
        ),
    )
    .await
    .expect("upload replace protocol test timed out")
    .expect("overwrite through the journaled remote-replace flow");

    assert_eq!(status, TransferStatus::Completed);
    {
        let files = files.lock().unwrap();
        assert_eq!(files.get(REMOTE_PATH).unwrap(), data.as_slice());
        let replace_paths = remote_replace::RemoteReplacePaths::new(REMOTE_PATH);
        for artifact in replace_paths.lease_artifacts() {
            assert!(
                !files.contains_key(artifact),
                "remote-replace artifact {artifact} must be cleaned up"
            );
        }
        assert!(!files.contains_key(&upload_temporary_path(REMOTE_PATH)));
        assert!(!files.contains_key(&upload_metadata_path(REMOTE_PATH)));
    }
    session.close().await.unwrap();
}
