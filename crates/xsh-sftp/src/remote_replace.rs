use anyhow::{Context, bail};
use futures::join;
use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileType, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

const REMOTE_REPLACE_MAGIC: &str = "xsh-sftp-remote-replace";
const REMOTE_REPLACE_VERSION: u8 = 1;
const REMOTE_REPLACE_RECORD_MAX_BYTES: u64 = 64 * 1024;
const REMOTE_REPLACE_SAMPLE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RecoveryOutcome {
    Ready,
    InstalledCurrent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RemoteFileFingerprint {
    size: u64,
    sample_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RemoteReplacePaths {
    pub(super) destination: String,
    pub(super) temporary: String,
    pub(super) backup: String,
    pub(super) journal: String,
    pub(super) journal_temporary: String,
    pub(super) installed: String,
    pub(super) installed_temporary: String,
}

impl RemoteReplacePaths {
    pub(super) fn new(destination: &str) -> Self {
        Self {
            destination: destination.to_owned(),
            temporary: format!("{destination}.xsh-part"),
            backup: format!("{destination}.xsh-replace-backup"),
            journal: format!("{destination}.xsh-replace-journal"),
            journal_temporary: format!("{destination}.xsh-replace-journal.tmp"),
            installed: format!("{destination}.xsh-replace-installed"),
            installed_temporary: format!("{destination}.xsh-replace-installed.tmp"),
        }
    }

    pub(super) fn lease_artifacts(&self) -> [&str; 5] {
        [
            &self.backup,
            &self.journal,
            &self.journal_temporary,
            &self.installed,
            &self.installed_temporary,
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteReplaceRecord {
    magic: String,
    version: u8,
    transaction_id: Uuid,
    destination_path: String,
    temporary_path: String,
    backup_path: String,
    original: RemoteFileFingerprint,
    replacement: RemoteFileFingerprint,
    upload_source_token: String,
}

impl RemoteReplaceRecord {
    fn new(
        paths: &RemoteReplacePaths,
        original: RemoteFileFingerprint,
        replacement: RemoteFileFingerprint,
        upload_source_token: &str,
    ) -> Self {
        Self {
            magic: REMOTE_REPLACE_MAGIC.to_owned(),
            version: REMOTE_REPLACE_VERSION,
            transaction_id: Uuid::new_v4(),
            destination_path: paths.destination.clone(),
            temporary_path: paths.temporary.clone(),
            backup_path: paths.backup.clone(),
            original,
            replacement,
            upload_source_token: upload_source_token.to_owned(),
        }
    }

    fn validate(&self, paths: &RemoteReplacePaths) -> anyhow::Result<()> {
        if self.magic != REMOTE_REPLACE_MAGIC || self.version != REMOTE_REPLACE_VERSION {
            bail!("unrecognized SFTP remote replacement record format");
        }
        let recorded_paths = RemoteReplacePaths::new(&self.destination_path);
        if self.transaction_id.is_nil()
            || !super::remote_destinations_match(&self.destination_path, &paths.destination)
            || self.temporary_path != recorded_paths.temporary
            || self.backup_path != recorded_paths.backup
            || !super::remote_destinations_match(&self.temporary_path, &paths.temporary)
            || !super::remote_destinations_match(&self.backup_path, &paths.backup)
            || !valid_sample_digest(&self.original.sample_sha256)
            || !valid_sample_digest(&self.replacement.sample_sha256)
            || self.upload_source_token.is_empty()
        {
            bail!("SFTP remote replacement record does not belong to this destination");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RemoteFileInfo {
    file_type: FileType,
    len: u64,
}

fn valid_sample_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sample_digest(size: u64, first: &[u8], last: &[u8]) -> String {
    let mut sampled = Vec::with_capacity(32 + first.len() + last.len());
    sampled.extend_from_slice(b"xsh-sftp-sample-v1\0");
    sampled.extend_from_slice(&size.to_be_bytes());
    sampled.extend_from_slice(&(first.len() as u64).to_be_bytes());
    sampled.extend_from_slice(first);
    sampled.extend_from_slice(&(last.len() as u64).to_be_bytes());
    sampled.extend_from_slice(last);
    let digest = ssh_key::HashAlg::Sha256.digest(&sampled);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

trait RemoteReplaceIo: Sync {
    async fn lstat(&self, path: &str) -> anyhow::Result<Option<RemoteFileInfo>>;
    async fn read_limited(&self, path: &str, limit: u64) -> anyhow::Result<Vec<u8>>;
    async fn read_range(&self, path: &str, offset: u64, len: u64) -> anyhow::Result<Vec<u8>>;
    async fn create_exclusive(&self, path: &str, data: &[u8]) -> anyhow::Result<()>;
    async fn sync_file(&self, path: &str) -> anyhow::Result<()>;
    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()>;
    async fn remove_file(&self, path: &str) -> anyhow::Result<()>;
}

struct SftpRemoteReplaceIo<'a> {
    session: &'a SftpSession,
}

impl RemoteReplaceIo for SftpRemoteReplaceIo<'_> {
    async fn lstat(&self, path: &str) -> anyhow::Result<Option<RemoteFileInfo>> {
        match self.session.symlink_metadata(path.to_owned()).await {
            Ok(metadata) => Ok(Some(RemoteFileInfo {
                file_type: metadata.file_type(),
                len: metadata.len(),
            })),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn read_limited(&self, path: &str, limit: u64) -> anyhow::Result<Vec<u8>> {
        let remote = self.session.open(path.to_owned()).await?;
        let mut limited = remote.take(limit + 1);
        let mut raw = Vec::new();
        limited.read_to_end(&mut raw).await?;
        if raw.len() as u64 > limit {
            bail!("SFTP remote replacement record exceeds the size limit: {path}");
        }
        Ok(raw)
    }

    async fn read_range(&self, path: &str, offset: u64, len: u64) -> anyhow::Result<Vec<u8>> {
        let mut remote = self.session.open(path.to_owned()).await?;
        remote.seek(SeekFrom::Start(offset)).await?;
        let mut limited = remote.take(len);
        let mut raw = Vec::with_capacity(len as usize);
        limited.read_to_end(&mut raw).await?;
        if raw.len() as u64 != len {
            bail!(
                "SFTP remote replacement artifact changed while sampling: {path}; expected {len} bytes at offset {offset}, read {}",
                raw.len()
            );
        }
        Ok(raw)
    }

    async fn create_exclusive(&self, path: &str, data: &[u8]) -> anyhow::Result<()> {
        let mut remote = self
            .session
            .open_with_flags(
                path.to_owned(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await?;
        remote.write_all(data).await?;
        remote.flush().await?;
        remote.sync_all().await?;
        remote.shutdown().await?;
        Ok(())
    }

    async fn sync_file(&self, path: &str) -> anyhow::Result<()> {
        let mut remote = self
            .session
            .open_with_flags(path.to_owned(), OpenFlags::WRITE)
            .await?;
        remote.sync_all().await?;
        remote.shutdown().await?;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.session
            .rename(from.to_owned(), to.to_owned())
            .await
            .map_err(Into::into)
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        self.session
            .remove_file(path.to_owned())
            .await
            .map_err(Into::into)
    }
}

#[derive(Debug, Default)]
struct ProtocolRecords {
    journal: Option<RemoteReplaceRecord>,
    journal_temporary: Option<RemoteReplaceRecord>,
    installed: Option<RemoteReplaceRecord>,
    installed_temporary: Option<RemoteReplaceRecord>,
}

impl ProtocolRecords {
    fn common(&self) -> anyhow::Result<Option<&RemoteReplaceRecord>> {
        let records = [
            self.journal.as_ref(),
            self.journal_temporary.as_ref(),
            self.installed.as_ref(),
            self.installed_temporary.as_ref(),
        ];
        let Some(first) = records.into_iter().flatten().next() else {
            return Ok(None);
        };
        if records.into_iter().flatten().any(|record| record != first) {
            bail!(
                "SFTP remote replacement control files disagree; all artifacts were left untouched"
            );
        }
        Ok(Some(first))
    }
}

#[derive(Debug, Clone, Copy)]
struct ReplaceSnapshot {
    destination: Option<RemoteFileInfo>,
    temporary: Option<RemoteFileInfo>,
    backup: Option<RemoteFileInfo>,
}

pub(super) async fn recover_remote_replace(
    session: &SftpSession,
    destination: &str,
    current_source_token: &str,
) -> anyhow::Result<RecoveryOutcome> {
    let io = SftpRemoteReplaceIo { session };
    recover_remote_replace_with(&io, destination, current_source_token).await
}

pub(super) async fn fingerprint_remote_file(
    session: &SftpSession,
    path: &str,
    expected_size: u64,
) -> anyhow::Result<RemoteFileFingerprint> {
    let io = SftpRemoteReplaceIo { session };
    let info = io
        .lstat(path)
        .await?
        .with_context(|| format!("SFTP remote file disappeared before sampling: {path}"))?;
    if info.file_type != FileType::File || info.len != expected_size {
        bail!("SFTP remote file is not the expected regular file before sampling: {path}");
    }
    fingerprint_file(&io, path, info).await
}

pub(super) async fn verify_remote_file_fingerprint(
    session: &SftpSession,
    path: &str,
    expected: &RemoteFileFingerprint,
) -> anyhow::Result<bool> {
    let io = SftpRemoteReplaceIo { session };
    let Some(info) = io.lstat(path).await? else {
        return Ok(false);
    };
    if info.file_type != FileType::File || info.len != expected.size {
        return Ok(false);
    }
    Ok(fingerprint_file(&io, path, info).await? == *expected)
}

pub(super) async fn replace_remote_file(
    session: &SftpSession,
    destination: &str,
    replacement: &RemoteFileFingerprint,
    upload_source_token: &str,
    initial_error: &str,
) -> anyhow::Result<()> {
    let io = SftpRemoteReplaceIo { session };
    replace_remote_file_with(
        &io,
        destination,
        replacement,
        upload_source_token,
        initial_error,
    )
    .await
}

async fn recover_remote_replace_with<I: RemoteReplaceIo>(
    io: &I,
    destination: &str,
    current_source_token: &str,
) -> anyhow::Result<RecoveryOutcome> {
    let paths = RemoteReplacePaths::new(destination);
    let (records, backup) = join!(load_protocol_records(io, &paths), io.lstat(&paths.backup));
    let records = records?;
    let backup = backup?;
    let record = records.common()?.cloned();

    if records.journal.is_none() && records.installed.is_none() {
        if backup.is_some() {
            bail!(
                "SFTP remote replacement backup is not owned by a valid journal: {}; it was left untouched",
                paths.backup
            );
        }
        if records.installed_temporary.is_some() {
            bail!(
                "SFTP remote replacement installed marker temporary file has no journal; all artifacts were left untouched"
            );
        }
        if records.journal_temporary.is_some() {
            remove_known_file(io, &paths.journal_temporary)
                .await
                .with_context(|| {
                    format!(
                        "failed to remove an unpublished SFTP replacement journal {}",
                        paths.journal_temporary
                    )
                })?;
        }
        return Ok(RecoveryOutcome::Ready);
    }

    let record = record.context("SFTP remote replacement record is missing")?;
    if records.installed.is_some() {
        if records.journal_temporary.is_some() || records.installed_temporary.is_some() {
            bail!(
                "SFTP remote replacement installed marker conflicts with a control temporary file; all artifacts were left untouched"
            );
        }
        validate_installed_state(io, &paths, &record).await?;
        return finish_recovered_install(io, &paths, &record, current_source_token, &records).await;
    }

    let snapshot = load_snapshot(io, &paths).await?;
    validate_regular_entries(&paths, &snapshot)?;
    let state = (
        snapshot.destination.is_some(),
        snapshot.temporary.is_some(),
        snapshot.backup.is_some(),
    );

    if records.installed_temporary.is_some()
        && state != (true, false, true)
        && state != (true, false, false)
    {
        bail!(
            "SFTP remote replacement installed marker was prepared in an inconsistent state; all artifacts were left untouched"
        );
    }
    if records.journal_temporary.is_some() {
        bail!(
            "SFTP remote replacement journal and its temporary file both exist; all artifacts were left untouched"
        );
    }

    match state {
        (true, true, false) => {
            expect_fingerprint(
                io,
                &paths.destination,
                snapshot.destination,
                &record.original,
            )
            .await?;
            expect_fingerprint(
                io,
                &paths.temporary,
                snapshot.temporary,
                &record.replacement,
            )
            .await?;
            abandon_journal(io, &paths).await?;
            Ok(RecoveryOutcome::Ready)
        }
        (false, true, true) => {
            expect_fingerprint(
                io,
                &paths.temporary,
                snapshot.temporary,
                &record.replacement,
            )
            .await?;
            expect_fingerprint(io, &paths.backup, snapshot.backup, &record.original).await?;
            install_with_backup(io, &paths, &record, "recovering interrupted replacement").await?;
            finish_recovered_install(
                io,
                &paths,
                &record,
                current_source_token,
                &load_protocol_records(io, &paths).await?,
            )
            .await
        }
        (true, false, true) => {
            expect_fingerprint(
                io,
                &paths.destination,
                snapshot.destination,
                &record.replacement,
            )
            .await?;
            expect_fingerprint(io, &paths.backup, snapshot.backup, &record.original).await?;
            persist_installed_marker(io, &paths, &record).await?;
            finish_recovered_install(
                io,
                &paths,
                &record,
                current_source_token,
                &load_protocol_records(io, &paths).await?,
            )
            .await
        }
        (false, false, true) => {
            expect_fingerprint(io, &paths.backup, snapshot.backup, &record.original).await?;
            restore_backup(io, &paths, &record).await?;
            abandon_journal(io, &paths).await?;
            Ok(RecoveryOutcome::Ready)
        }
        (true, false, false) => {
            let destination_info = snapshot.destination.expect("checked above");
            let destination = fingerprint_file(io, &paths.destination, destination_info).await?;
            if destination != record.original && destination != record.replacement {
                bail!(
                    "SFTP remote replacement destination no longer matches its journal; all artifacts were left untouched"
                );
            }
            if records.installed_temporary.is_some() {
                if destination != record.replacement {
                    bail!(
                        "SFTP remote replacement installed marker does not match the destination; all artifacts were left untouched"
                    );
                }
                persist_installed_marker(io, &paths, &record).await?;
                return finish_recovered_install(
                    io,
                    &paths,
                    &record,
                    current_source_token,
                    &load_protocol_records(io, &paths).await?,
                )
                .await;
            }
            abandon_journal(io, &paths).await?;
            Ok(RecoveryOutcome::Ready)
        }
        (false, true, false) => {
            expect_fingerprint(
                io,
                &paths.temporary,
                snapshot.temporary,
                &record.replacement,
            )
            .await?;
            install_without_backup(io, &paths, &record).await?;
            finish_recovered_install(
                io,
                &paths,
                &record,
                current_source_token,
                &load_protocol_records(io, &paths).await?,
            )
            .await
        }
        (true, true, true) | (false, false, false) => bail!(
            "SFTP remote replacement is in an inconsistent state; all artifacts were left untouched"
        ),
    }
}

async fn replace_remote_file_with<I: RemoteReplaceIo>(
    io: &I,
    destination: &str,
    replacement: &RemoteFileFingerprint,
    upload_source_token: &str,
    initial_error: &str,
) -> anyhow::Result<()> {
    let paths = RemoteReplacePaths::new(destination);
    let records = load_protocol_records(io, &paths).await?;
    if records.common()?.is_some() || io.lstat(&paths.backup).await?.is_some() {
        bail!(
            "SFTP remote replacement artifacts already exist for {destination}; they were left untouched"
        );
    }

    let snapshot = load_snapshot(io, &paths).await?;
    validate_regular_entries(&paths, &snapshot)?;
    let destination_info = snapshot.destination.with_context(|| {
        format!("remote destination disappeared after replace failed: {initial_error}")
    })?;
    let temporary_info = snapshot.temporary.with_context(|| {
        format!("remote upload temporary file disappeared after replace failed: {initial_error}")
    })?;
    if snapshot.backup.is_some() {
        bail!(
            "SFTP remote replacement backup is already occupied: {}; it was left untouched",
            paths.backup
        );
    }
    if temporary_info.len != replacement.size {
        bail!(
            "SFTP upload temporary file changed before replacement: expected {} bytes, found {}",
            replacement.size,
            temporary_info.len
        );
    }
    let actual_replacement = fingerprint_file(io, &paths.temporary, temporary_info).await?;
    if actual_replacement != *replacement {
        bail!(
            "SFTP upload temporary file content changed before replacement; it was left untouched"
        );
    }
    let original = fingerprint_file(io, &paths.destination, destination_info).await?;

    let record =
        RemoteReplaceRecord::new(&paths, original, replacement.clone(), upload_source_token);
    publish_record(
        io,
        &paths,
        &record,
        &paths.journal_temporary,
        &paths.journal,
        "journal",
    )
    .await?;

    if io.lstat(&paths.backup).await?.is_some() {
        abandon_journal(io, &paths).await.with_context(|| {
            "the SFTP replacement backup was occupied before any data was moved, but journal cleanup failed"
        })?;
        bail!(
            "SFTP remote replacement backup was occupied after journal publication: {}; it was left untouched",
            paths.backup
        );
    }
    let preserve_result = io.rename(&paths.destination, &paths.backup).await;
    let after_preserve = load_snapshot(io, &paths).await?;
    validate_regular_entries(&paths, &after_preserve)?;
    match (
        after_preserve.destination.is_some(),
        after_preserve.temporary.is_some(),
        after_preserve.backup.is_some(),
    ) {
        (false, true, true) => {
            expect_fingerprint(
                io,
                &paths.temporary,
                after_preserve.temporary,
                &record.replacement,
            )
            .await?;
            expect_fingerprint(io, &paths.backup, after_preserve.backup, &record.original).await?;
        }
        (true, true, false) => {
            let preserve_error = preserve_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "rename reported success but made no change".to_owned());
            abandon_journal(io, &paths).await.with_context(|| {
                format!(
                    "failed to preserve remote destination ({preserve_error}) and could not remove its recovery journal"
                )
            })?;
            bail!(
                "failed to preserve remote destination after direct replace failed ({initial_error}): {preserve_error}"
            );
        }
        _ => {
            let detail = preserve_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "rename reported success".to_owned());
            bail!(
                "remote destination preservation had an ambiguous result ({detail}); journal and artifacts were left for recovery"
            );
        }
    }

    install_with_backup(io, &paths, &record, initial_error).await?;
    let records = load_protocol_records(io, &paths).await?;
    validate_installed_state(io, &paths, &record).await?;
    if let Err(error) = cleanup_installed(io, &paths, &record, &records).await {
        tracing::warn!(
            destination = %paths.destination,
            %error,
            "remote replacement was installed but its recovery artifacts could not be fully cleaned"
        );
    }
    Ok(())
}

async fn load_protocol_records<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
) -> anyhow::Result<ProtocolRecords> {
    // The four control files are probed concurrently: on the no-recovery fast
    // path this is the bulk of the per-upload fixed cost on high-latency links.
    let (journal, journal_temporary, installed, installed_temporary) = join!(
        read_optional_record(io, &paths.journal, paths),
        read_optional_record(io, &paths.journal_temporary, paths),
        read_optional_record(io, &paths.installed, paths),
        read_optional_record(io, &paths.installed_temporary, paths),
    );
    let records = ProtocolRecords {
        journal: journal?,
        journal_temporary: journal_temporary?,
        installed: installed?,
        installed_temporary: installed_temporary?,
    };
    records.common()?;
    Ok(records)
}

async fn read_optional_record<I: RemoteReplaceIo>(
    io: &I,
    path: &str,
    paths: &RemoteReplacePaths,
) -> anyhow::Result<Option<RemoteReplaceRecord>> {
    let Some(info) = io.lstat(path).await? else {
        return Ok(None);
    };
    if info.file_type != FileType::File {
        bail!(
            "SFTP remote replacement control path is not a regular file: {path}; it was left untouched"
        );
    }
    if info.len > REMOTE_REPLACE_RECORD_MAX_BYTES {
        bail!("SFTP remote replacement control file is too large: {path}; it was left untouched");
    }
    let raw = io
        .read_limited(path, REMOTE_REPLACE_RECORD_MAX_BYTES)
        .await
        .with_context(|| format!("failed to read SFTP remote replacement record {path}"))?;
    let record = serde_json::from_slice::<RemoteReplaceRecord>(&raw).with_context(|| {
        format!(
            "SFTP remote replacement control file is not recognized: {path}; it was left untouched"
        )
    })?;
    record.validate(paths).with_context(|| {
        format!("SFTP remote replacement control file is invalid: {path}; it was left untouched")
    })?;
    Ok(Some(record))
}

async fn publish_record<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
    temporary_path: &str,
    final_path: &str,
    label: &str,
) -> anyhow::Result<()> {
    if let Some(existing) = read_optional_record(io, final_path, paths).await? {
        if existing == *record && io.lstat(temporary_path).await?.is_none() {
            return Ok(());
        }
        bail!(
            "SFTP remote replacement {label} path is occupied: {final_path}; it was left untouched"
        );
    }
    let encoded = serde_json::to_vec(record)
        .with_context(|| format!("failed to encode SFTP remote replacement {label}"))?;
    if encoded.len() as u64 > REMOTE_REPLACE_RECORD_MAX_BYTES {
        bail!("SFTP remote replacement {label} exceeds the size limit and was not written");
    }
    match read_optional_record(io, temporary_path, paths).await? {
        Some(existing) if existing == *record => {
            io.sync_file(temporary_path).await.with_context(|| {
                format!(
                    "failed to sync the existing SFTP remote replacement {label} temporary file {temporary_path}"
                )
            })?;
        }
        Some(_) => bail!(
            "SFTP remote replacement {label} temporary path is occupied: {temporary_path}; it was left untouched"
        ),
        None => io
            .create_exclusive(temporary_path, &encoded)
            .await
            .with_context(|| {
                format!(
                    "failed to persist SFTP remote replacement {label} temporary file {temporary_path}"
                )
            })?,
    }
    let saved = read_optional_record(io, temporary_path, paths)
        .await?
        .with_context(|| format!("SFTP remote replacement {label} temporary file disappeared"))?;
    if saved != *record {
        bail!("SFTP remote replacement {label} temporary file changed; it was left untouched");
    }

    let rename_result = io.rename(temporary_path, final_path).await;
    let final_record = read_optional_record(io, final_path, paths).await?;
    let temporary_record = read_optional_record(io, temporary_path, paths).await?;
    if final_record.as_ref() == Some(record) && temporary_record.is_none() {
        return Ok(());
    }
    let rename_error = rename_result
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "rename reported success but state did not change".to_owned());
    bail!(
        "failed to publish SFTP remote replacement {label} ({rename_error}); control files were left untouched"
    )
}

async fn persist_installed_marker<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
) -> anyhow::Result<()> {
    publish_record(
        io,
        paths,
        record,
        &paths.installed_temporary,
        &paths.installed,
        "installed marker",
    )
    .await
}

async fn load_snapshot<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
) -> anyhow::Result<ReplaceSnapshot> {
    Ok(ReplaceSnapshot {
        destination: io.lstat(&paths.destination).await?,
        temporary: io.lstat(&paths.temporary).await?,
        backup: io.lstat(&paths.backup).await?,
    })
}

async fn fingerprint_file<I: RemoteReplaceIo>(
    io: &I,
    path: &str,
    info: RemoteFileInfo,
) -> anyhow::Result<RemoteFileFingerprint> {
    if info.file_type != FileType::File {
        bail!("SFTP remote replacement artifact is not a regular file: {path}");
    }
    let sample_len = info.len.min(REMOTE_REPLACE_SAMPLE_BYTES);
    // Head and tail samples are independent reads; issuing them together keeps
    // the fingerprint at one round trip instead of two on every upload.
    let (first, last) = if info.len > sample_len {
        let tail_offset = info.len - sample_len;
        let (first, last) = join!(
            io.read_range(path, 0, sample_len),
            io.read_range(path, tail_offset, sample_len)
        );
        (first?, last?)
    } else {
        (io.read_range(path, 0, sample_len).await?, Vec::new())
    };
    Ok(RemoteFileFingerprint {
        size: info.len,
        sample_sha256: sample_digest(info.len, &first, &last),
    })
}

fn validate_regular_entries(
    paths: &RemoteReplacePaths,
    snapshot: &ReplaceSnapshot,
) -> anyhow::Result<()> {
    for (path, info) in [
        (&paths.destination, snapshot.destination),
        (&paths.temporary, snapshot.temporary),
        (&paths.backup, snapshot.backup),
    ] {
        if info.is_some_and(|info| info.file_type != FileType::File) {
            bail!(
                "SFTP remote replacement artifact is not a regular file: {path}; all artifacts were left untouched"
            );
        }
    }
    Ok(())
}

async fn expect_fingerprint<I: RemoteReplaceIo>(
    io: &I,
    path: &str,
    info: Option<RemoteFileInfo>,
    expected: &RemoteFileFingerprint,
) -> anyhow::Result<()> {
    let info = info.context("SFTP remote replacement artifact disappeared")?;
    if info.len != expected.size {
        bail!(
            "SFTP remote replacement artifact changed size: {path}; expected {} bytes, found {}; all artifacts were left untouched",
            expected.size,
            info.len
        );
    }
    if fingerprint_file(io, path, info).await? != *expected {
        bail!(
            "SFTP remote replacement artifact content fingerprint changed: {path}; all artifacts were left untouched"
        );
    }
    Ok(())
}

async fn install_with_backup<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
    initial_error: &str,
) -> anyhow::Result<()> {
    let replace_result = io.rename(&paths.temporary, &paths.destination).await;
    let after_replace = load_snapshot(io, paths).await?;
    validate_regular_entries(paths, &after_replace)?;
    match (
        after_replace.destination.is_some(),
        after_replace.temporary.is_some(),
        after_replace.backup.is_some(),
    ) {
        (true, false, true) => {
            expect_fingerprint(
                io,
                &paths.destination,
                after_replace.destination,
                &record.replacement,
            )
            .await?;
            expect_fingerprint(io, &paths.backup, after_replace.backup, &record.original).await?;
            persist_installed_marker(io, paths, record).await?;
            Ok(())
        }
        (false, true, true) => {
            let replace_error = replace_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "rename reported success but made no change".to_owned());
            let rollback_result = io.rename(&paths.backup, &paths.destination).await;
            let after_rollback = load_snapshot(io, paths).await?;
            validate_regular_entries(paths, &after_rollback)?;
            match (
                after_rollback.destination.is_some(),
                after_rollback.temporary.is_some(),
                after_rollback.backup.is_some(),
            ) {
                (true, true, false) => {
                    expect_fingerprint(
                        io,
                        &paths.destination,
                        after_rollback.destination,
                        &record.original,
                    )
                    .await?;
                    expect_fingerprint(
                        io,
                        &paths.temporary,
                        after_rollback.temporary,
                        &record.replacement,
                    )
                    .await?;
                    abandon_journal(io, paths).await.with_context(|| {
                        "replacement failed and the original was restored, but recovery journal cleanup failed"
                    })?;
                    bail!(
                        "failed to replace remote destination after direct replace failed ({initial_error}); original file was restored: {replace_error}"
                    );
                }
                (false, true, true) => {
                    let rollback_error = rollback_result
                        .err()
                        .map(|error| error.to_string())
                        .unwrap_or_else(|| {
                            "rollback reported success but made no change".to_owned()
                        });
                    bail!(
                        "failed to replace remote destination ({replace_error}) and failed to restore {} ({rollback_error}); journal and backup were preserved",
                        paths.backup
                    );
                }
                _ => bail!(
                    "remote replacement rollback had an ambiguous result; journal and artifacts were preserved"
                ),
            }
        }
        _ => {
            let detail = replace_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "rename reported success".to_owned());
            bail!(
                "remote replacement had an ambiguous result ({detail}); journal and artifacts were preserved"
            )
        }
    }
}

async fn install_without_backup<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
) -> anyhow::Result<()> {
    let rename_result = io.rename(&paths.temporary, &paths.destination).await;
    let snapshot = load_snapshot(io, paths).await?;
    validate_regular_entries(paths, &snapshot)?;
    if snapshot.destination.is_some() && snapshot.temporary.is_none() && snapshot.backup.is_none() {
        expect_fingerprint(
            io,
            &paths.destination,
            snapshot.destination,
            &record.replacement,
        )
        .await?;
        persist_installed_marker(io, paths, record).await?;
        return Ok(());
    }
    let detail = rename_result
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "rename reported success but state did not change".to_owned());
    bail!(
        "failed to install the only remaining SFTP replacement temporary file ({detail}); journal was preserved"
    )
}

async fn restore_backup<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
) -> anyhow::Result<()> {
    let rename_result = io.rename(&paths.backup, &paths.destination).await;
    let snapshot = load_snapshot(io, paths).await?;
    validate_regular_entries(paths, &snapshot)?;
    if snapshot.destination.is_some() && snapshot.temporary.is_none() && snapshot.backup.is_none() {
        expect_fingerprint(
            io,
            &paths.destination,
            snapshot.destination,
            &record.original,
        )
        .await?;
        return Ok(());
    }
    let detail = rename_result
        .err()
        .map(|error| error.to_string())
        .unwrap_or_else(|| "rename reported success but state did not change".to_owned());
    bail!(
        "failed to restore SFTP replacement backup {} ({detail}); journal and backup were preserved",
        paths.backup
    )
}

async fn validate_installed_state<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
) -> anyhow::Result<()> {
    let records = load_protocol_records(io, paths).await?;
    if records.installed.as_ref() != Some(record) {
        bail!(
            "SFTP remote replacement installed marker is missing or mismatched; all artifacts were left untouched"
        );
    }
    let snapshot = load_snapshot(io, paths).await?;
    validate_regular_entries(paths, &snapshot)?;
    if snapshot.destination.is_none() || snapshot.temporary.is_some() {
        bail!(
            "SFTP remote replacement installed marker conflicts with remote data; all artifacts were left untouched"
        );
    }
    expect_fingerprint(
        io,
        &paths.destination,
        snapshot.destination,
        &record.replacement,
    )
    .await?;
    if snapshot.backup.is_some() {
        expect_fingerprint(io, &paths.backup, snapshot.backup, &record.original).await?;
    }
    Ok(())
}

async fn finish_recovered_install<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
    current_source_token: &str,
    records: &ProtocolRecords,
) -> anyhow::Result<RecoveryOutcome> {
    validate_installed_state(io, paths, record).await?;
    let cleanup_result = cleanup_installed(io, paths, record, records).await;
    if record.upload_source_token == current_source_token {
        if let Err(error) = cleanup_result {
            tracing::warn!(
                destination = %paths.destination,
                %error,
                "current upload was installed but its remote replacement artifacts could not be fully cleaned"
            );
        }
        return Ok(RecoveryOutcome::InstalledCurrent);
    }
    cleanup_result.with_context(|| {
        format!(
            "a previous upload was installed at {}, but its recovery artifacts could not be cleaned before the new upload",
            paths.destination
        )
    })?;
    Ok(RecoveryOutcome::Ready)
}

async fn cleanup_installed<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
    record: &RemoteReplaceRecord,
    records: &ProtocolRecords,
) -> anyhow::Result<()> {
    if records.installed.as_ref() != Some(record) {
        bail!("SFTP remote replacement installed marker changed before cleanup");
    }
    if let Some(backup) = io.lstat(&paths.backup).await? {
        expect_fingerprint(io, &paths.backup, Some(backup), &record.original).await?;
        remove_known_file(io, &paths.backup).await?;
    }
    if records.journal.is_some() {
        remove_known_file(io, &paths.journal).await?;
    }
    remove_known_file(io, &paths.installed).await?;
    Ok(())
}

async fn abandon_journal<I: RemoteReplaceIo>(
    io: &I,
    paths: &RemoteReplacePaths,
) -> anyhow::Result<()> {
    if io.lstat(&paths.installed_temporary).await?.is_some() {
        bail!("cannot abandon an SFTP replacement journal with an installed marker in progress");
    }
    if io.lstat(&paths.journal_temporary).await?.is_some() {
        remove_known_file(io, &paths.journal_temporary).await?;
    }
    remove_known_file(io, &paths.journal).await
}

async fn remove_known_file<I: RemoteReplaceIo>(io: &I, path: &str) -> anyhow::Result<()> {
    match io.remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) => match io.lstat(path).await {
            Ok(None) => Ok(()),
            Ok(Some(_)) => Err(error),
            Err(observe_error) => Err(error).with_context(|| {
                format!(
                    "could not determine whether {path} was removed after the server returned an error: {observe_error}"
                )
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::Mutex;

    const DESTINATION: &str = "/srv/archive.tar";
    const CURRENT_TOKEN: &str = r#"{"source":"current"}"#;
    const PREVIOUS_TOKEN: &str = r#"{"source":"previous"}"#;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum FakeEntry {
        File(Vec<u8>),
        Other,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Mutation {
        Create(String),
        Sync(String),
        Rename(String, String),
        Remove(String),
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FaultTiming {
        Before,
        After,
    }

    #[derive(Debug, Clone)]
    struct Fault {
        mutation: Mutation,
        timing: FaultTiming,
    }

    #[derive(Debug, Default)]
    struct FakeState {
        entries: BTreeMap<String, FakeEntry>,
        faults: VecDeque<Fault>,
        mutations: Vec<Mutation>,
    }

    #[derive(Debug, Default)]
    struct FakeRemoteFs {
        state: Mutex<FakeState>,
    }

    impl FakeRemoteFs {
        fn with_upload() -> Self {
            let fake = Self::default();
            fake.put_file(DESTINATION, b"old");
            fake.put_file(&RemoteReplacePaths::new(DESTINATION).temporary, b"new-data");
            fake
        }

        fn put_file(&self, path: &str, data: &[u8]) {
            self.state
                .lock()
                .unwrap()
                .entries
                .insert(path.to_owned(), FakeEntry::File(data.to_vec()));
        }

        fn put_other(&self, path: &str) {
            self.state
                .lock()
                .unwrap()
                .entries
                .insert(path.to_owned(), FakeEntry::Other);
        }

        fn file(&self, path: &str) -> Option<Vec<u8>> {
            match self.state.lock().unwrap().entries.get(path) {
                Some(FakeEntry::File(data)) => Some(data.clone()),
                _ => None,
            }
        }

        fn exists(&self, path: &str) -> bool {
            self.state.lock().unwrap().entries.contains_key(path)
        }

        fn fail(&self, mutation: Mutation, timing: FaultTiming) {
            self.state
                .lock()
                .unwrap()
                .faults
                .push_back(Fault { mutation, timing });
        }

        fn mutations(&self) -> Vec<Mutation> {
            self.state.lock().unwrap().mutations.clone()
        }

        fn clear_faults(&self) {
            self.state.lock().unwrap().faults.clear();
        }

        fn take_fault(state: &mut FakeState, mutation: &Mutation) -> Option<FaultTiming> {
            if state
                .faults
                .front()
                .is_some_and(|fault| fault.mutation == *mutation)
            {
                state.faults.pop_front().map(|fault| fault.timing)
            } else {
                None
            }
        }
    }

    impl RemoteReplaceIo for FakeRemoteFs {
        async fn lstat(&self, path: &str) -> anyhow::Result<Option<RemoteFileInfo>> {
            Ok(match self.state.lock().unwrap().entries.get(path) {
                Some(FakeEntry::File(data)) => Some(RemoteFileInfo {
                    file_type: FileType::File,
                    len: data.len() as u64,
                }),
                Some(FakeEntry::Other) => Some(RemoteFileInfo {
                    file_type: FileType::Other,
                    len: 0,
                }),
                None => None,
            })
        }

        async fn read_limited(&self, path: &str, limit: u64) -> anyhow::Result<Vec<u8>> {
            match self.state.lock().unwrap().entries.get(path) {
                Some(FakeEntry::File(data)) if data.len() as u64 <= limit => Ok(data.clone()),
                Some(FakeEntry::File(_)) => bail!("size limit exceeded"),
                Some(FakeEntry::Other) => bail!("not a file"),
                None => bail!("missing file"),
            }
        }

        async fn read_range(&self, path: &str, offset: u64, len: u64) -> anyhow::Result<Vec<u8>> {
            match self.state.lock().unwrap().entries.get(path) {
                Some(FakeEntry::File(data)) => {
                    let start = usize::try_from(offset).context("offset overflow")?;
                    let len = usize::try_from(len).context("length overflow")?;
                    let end = start.checked_add(len).context("range overflow")?;
                    data.get(start..end)
                        .map(<[u8]>::to_vec)
                        .context("range outside fake file")
                }
                Some(FakeEntry::Other) => bail!("not a file"),
                None => bail!("missing file"),
            }
        }

        async fn create_exclusive(&self, path: &str, data: &[u8]) -> anyhow::Result<()> {
            let mutation = Mutation::Create(path.to_owned());
            let mut state = self.state.lock().unwrap();
            state.mutations.push(mutation.clone());
            let fault = Self::take_fault(&mut state, &mutation);
            if fault == Some(FaultTiming::Before) {
                bail!("injected create failure");
            }
            if state.entries.contains_key(path) {
                bail!("path already exists");
            }
            state
                .entries
                .insert(path.to_owned(), FakeEntry::File(data.to_vec()));
            if fault == Some(FaultTiming::After) {
                bail!("injected create response loss");
            }
            Ok(())
        }

        async fn sync_file(&self, path: &str) -> anyhow::Result<()> {
            let mutation = Mutation::Sync(path.to_owned());
            let mut state = self.state.lock().unwrap();
            state.mutations.push(mutation.clone());
            let fault = Self::take_fault(&mut state, &mutation);
            if fault == Some(FaultTiming::Before) {
                bail!("injected sync failure");
            }
            if !matches!(state.entries.get(path), Some(FakeEntry::File(_))) {
                bail!("missing sync target {path}");
            }
            if fault == Some(FaultTiming::After) {
                bail!("injected sync response loss");
            }
            Ok(())
        }

        async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
            let mutation = Mutation::Rename(from.to_owned(), to.to_owned());
            let mut state = self.state.lock().unwrap();
            state.mutations.push(mutation.clone());
            let fault = Self::take_fault(&mut state, &mutation);
            if fault == Some(FaultTiming::Before) {
                bail!("injected rename failure");
            }
            if state.entries.contains_key(to) {
                bail!("destination exists");
            }
            let entry = state
                .entries
                .remove(from)
                .with_context(|| format!("missing rename source {from}"))?;
            state.entries.insert(to.to_owned(), entry);
            if fault == Some(FaultTiming::After) {
                bail!("injected rename response loss");
            }
            Ok(())
        }

        async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
            let mutation = Mutation::Remove(path.to_owned());
            let mut state = self.state.lock().unwrap();
            state.mutations.push(mutation.clone());
            let fault = Self::take_fault(&mut state, &mutation);
            if fault == Some(FaultTiming::Before) {
                bail!("injected remove failure");
            }
            state
                .entries
                .remove(path)
                .with_context(|| format!("missing remove target {path}"))?;
            if fault == Some(FaultTiming::After) {
                bail!("injected remove response loss");
            }
            Ok(())
        }
    }

    fn test_record(paths: &RemoteReplacePaths, token: &str) -> RemoteReplaceRecord {
        RemoteReplaceRecord::new(
            paths,
            fingerprint_bytes(b"old"),
            replacement_fingerprint(),
            token,
        )
    }

    fn fingerprint_bytes(data: &[u8]) -> RemoteFileFingerprint {
        let sample_len = data.len().min(REMOTE_REPLACE_SAMPLE_BYTES as usize);
        let first = &data[..sample_len];
        let last = if data.len() > sample_len {
            &data[data.len() - sample_len..]
        } else {
            &[]
        };
        RemoteFileFingerprint {
            size: data.len() as u64,
            sample_sha256: sample_digest(data.len() as u64, first, last),
        }
    }

    fn replacement_fingerprint() -> RemoteFileFingerprint {
        fingerprint_bytes(b"new-data")
    }

    fn put_record(fake: &FakeRemoteFs, path: &str, record: &RemoteReplaceRecord) {
        fake.put_file(path, &serde_json::to_vec(record).unwrap());
    }

    #[tokio::test]
    async fn normal_replace_publishes_journal_before_preserving_destination() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);

        replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap();

        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
        for artifact in [
            &paths.temporary,
            &paths.backup,
            &paths.journal,
            &paths.journal_temporary,
            &paths.installed,
            &paths.installed_temporary,
        ] {
            assert!(!fake.exists(artifact));
        }
        let mutations = fake.mutations();
        let journal_publish = mutations
            .iter()
            .position(|mutation| {
                mutation
                    == &Mutation::Rename(paths.journal_temporary.clone(), paths.journal.clone())
            })
            .unwrap();
        let preserve = mutations
            .iter()
            .position(|mutation| {
                mutation == &Mutation::Rename(paths.destination.clone(), paths.backup.clone())
            })
            .unwrap();
        assert!(journal_publish < preserve);
    }

    #[tokio::test]
    async fn prepared_transaction_is_abandoned_without_moving_data() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::Ready);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.journal));
    }

    #[tokio::test]
    async fn equivalent_destination_alias_can_recover_the_same_journal() {
        let fake = FakeRemoteFs::with_upload();
        let current_paths = RemoteReplacePaths::new(DESTINATION);
        let recorded_paths = RemoteReplacePaths::new("/srv/staging/../archive.tar");
        let record = test_record(&recorded_paths, CURRENT_TOKEN);
        put_record(&fake, &current_paths.journal, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::Ready);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&current_paths.temporary).unwrap(), b"new-data");
        assert!(!fake.exists(&current_paths.journal));
    }

    #[tokio::test]
    async fn unpublished_valid_journal_temporary_is_cleaned_without_moving_data() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal_temporary, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::Ready);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.journal_temporary));
    }

    #[tokio::test]
    async fn recovery_finishes_after_destination_was_moved_to_backup() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(&paths.temporary, b"new-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::InstalledCurrent);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
        assert!(!fake.exists(&paths.installed));
    }

    #[tokio::test]
    async fn recovery_finishes_after_temporary_was_installed() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(DESTINATION, b"new-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::InstalledCurrent);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
    }

    #[tokio::test]
    async fn recovery_restores_backup_when_the_staged_file_was_lost() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::Ready);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
    }

    #[tokio::test]
    async fn prepared_installed_marker_is_published_during_recovery() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(DESTINATION, b"new-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);
        put_record(&fake, &paths.installed_temporary, &record);

        let outcome = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap();

        assert_eq!(outcome, RecoveryOutcome::InstalledCurrent);
        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
        assert!(!fake.exists(&paths.installed));
        assert!(!fake.exists(&paths.installed_temporary));
    }

    #[tokio::test]
    async fn second_rename_failure_rolls_back_and_keeps_upload_temporary() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Rename(paths.temporary.clone(), paths.destination.clone()),
            FaultTiming::Before,
        );

        let error = replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("original file was restored"));
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
    }

    #[tokio::test]
    async fn first_rename_failure_abandons_the_published_journal() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Rename(paths.destination.clone(), paths.backup.clone()),
            FaultTiming::Before,
        );

        let error = replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("failed to preserve"));
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
    }

    #[tokio::test]
    async fn oversized_source_token_is_rejected_before_control_files_are_written() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        let oversized_token = "x".repeat(REMOTE_REPLACE_RECORD_MAX_BYTES as usize);

        let error = replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            &oversized_token,
            "overwrite denied",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("exceeds the size limit"));
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"new-data");
        assert!(fake.mutations().is_empty());
    }

    #[tokio::test]
    async fn rollback_failure_preserves_backup_and_journal_for_recovery() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Rename(paths.temporary.clone(), paths.destination.clone()),
            FaultTiming::Before,
        );
        fake.fail(
            Mutation::Rename(paths.backup.clone(), paths.destination.clone()),
            FaultTiming::Before,
        );

        let error = replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("failed to restore"));
        assert!(!fake.exists(DESTINATION));
        assert!(fake.exists(&paths.temporary));
        assert!(fake.exists(&paths.backup));
        assert!(fake.exists(&paths.journal));

        fake.clear_faults();
        assert_eq!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .unwrap(),
            RecoveryOutcome::InstalledCurrent
        );
        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
    }

    #[tokio::test]
    async fn rename_response_loss_is_classified_from_remote_state() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Rename(paths.destination.clone(), paths.backup.clone()),
            FaultTiming::After,
        );
        fake.fail(
            Mutation::Rename(paths.temporary.clone(), paths.destination.clone()),
            FaultTiming::After,
        );

        replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap();

        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
    }

    #[tokio::test]
    async fn control_file_publish_response_loss_is_classified_from_state() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Rename(paths.journal_temporary.clone(), paths.journal.clone()),
            FaultTiming::After,
        );
        fake.fail(
            Mutation::Rename(paths.installed_temporary.clone(), paths.installed.clone()),
            FaultTiming::After,
        );

        replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap();

        assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.journal));
        assert!(!fake.exists(&paths.installed));
    }

    #[tokio::test]
    async fn control_file_write_error_never_starts_destructive_renames() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Create(paths.journal_temporary.clone()),
            FaultTiming::After,
        );

        let error = replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("failed to persist"));
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"new-data");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
        assert!(fake.exists(&paths.journal_temporary));
        assert!(!fake.mutations().iter().any(|mutation| matches!(
            mutation,
            Mutation::Rename(from, _) if from == &paths.destination
        )));

        assert_eq!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .unwrap(),
            RecoveryOutcome::Ready
        );
    }

    #[tokio::test]
    async fn recovered_marker_temporary_must_sync_before_publication() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(DESTINATION, b"new-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);
        put_record(&fake, &paths.installed_temporary, &record);
        fake.fail(
            Mutation::Sync(paths.installed_temporary.clone()),
            FaultTiming::Before,
        );

        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert!(fake.exists(&paths.backup));
        assert!(fake.exists(&paths.journal));
        assert!(fake.exists(&paths.installed_temporary));
        assert!(!fake.exists(&paths.installed));

        fake.clear_faults();
        assert_eq!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .unwrap(),
            RecoveryOutcome::InstalledCurrent
        );
    }

    #[tokio::test]
    async fn rollback_response_loss_is_still_reported_as_restored() {
        let fake = FakeRemoteFs::with_upload();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.fail(
            Mutation::Rename(paths.temporary.clone(), paths.destination.clone()),
            FaultTiming::Before,
        );
        fake.fail(
            Mutation::Rename(paths.backup.clone(), paths.destination.clone()),
            FaultTiming::After,
        );

        let error = replace_remote_file_with(
            &fake,
            DESTINATION,
            &replacement_fingerprint(),
            CURRENT_TOKEN,
            "overwrite denied",
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("original file was restored"));
        assert_eq!(fake.file(DESTINATION).unwrap(), b"old");
        assert!(!fake.exists(&paths.backup));
        assert!(!fake.exists(&paths.journal));
    }

    #[tokio::test]
    async fn cleanup_failures_leave_proof_but_current_upload_is_completed() {
        for failed_path in ["backup", "journal", "installed"] {
            let fake = FakeRemoteFs::with_upload();
            let paths = RemoteReplacePaths::new(DESTINATION);
            let path = match failed_path {
                "backup" => &paths.backup,
                "journal" => &paths.journal,
                "installed" => &paths.installed,
                _ => unreachable!(),
            };
            fake.fail(Mutation::Remove(path.clone()), FaultTiming::Before);

            replace_remote_file_with(
                &fake,
                DESTINATION,
                &replacement_fingerprint(),
                CURRENT_TOKEN,
                "overwrite denied",
            )
            .await
            .unwrap();

            assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
            assert!(fake.exists(&paths.installed));
            match failed_path {
                "backup" => {
                    assert!(fake.exists(&paths.backup));
                    assert!(fake.exists(&paths.journal));
                }
                "journal" => {
                    assert!(!fake.exists(&paths.backup));
                    assert!(fake.exists(&paths.journal));
                }
                "installed" => {
                    assert!(!fake.exists(&paths.backup));
                    assert!(!fake.exists(&paths.journal));
                }
                _ => unreachable!(),
            }

            fake.clear_faults();
            assert_eq!(
                recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                    .await
                    .unwrap(),
                RecoveryOutcome::InstalledCurrent
            );
            assert!(!fake.exists(&paths.installed));
        }
    }

    #[tokio::test]
    async fn cleanup_response_loss_is_treated_as_success_after_absence_is_observed() {
        for failed_path in ["backup", "journal", "installed"] {
            let fake = FakeRemoteFs::with_upload();
            let paths = RemoteReplacePaths::new(DESTINATION);
            let path = match failed_path {
                "backup" => &paths.backup,
                "journal" => &paths.journal,
                "installed" => &paths.installed,
                _ => unreachable!(),
            };
            fake.fail(Mutation::Remove(path.clone()), FaultTiming::After);

            replace_remote_file_with(
                &fake,
                DESTINATION,
                &replacement_fingerprint(),
                CURRENT_TOKEN,
                "overwrite denied",
            )
            .await
            .unwrap();

            assert_eq!(fake.file(DESTINATION).unwrap(), b"new-data");
            assert!(!fake.exists(&paths.backup));
            assert!(!fake.exists(&paths.journal));
            assert!(!fake.exists(&paths.installed));
        }
    }

    #[tokio::test]
    async fn previous_upload_cleanup_must_finish_before_new_upload() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(DESTINATION, b"new-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, PREVIOUS_TOKEN);
        put_record(&fake, &paths.journal, &record);
        put_record(&fake, &paths.installed, &record);
        fake.fail(Mutation::Remove(paths.backup.clone()), FaultTiming::Before);

        let error = recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("previous upload"));
        assert!(fake.exists(&paths.backup));
        assert!(fake.exists(&paths.journal));
        assert!(fake.exists(&paths.installed));

        fake.clear_faults();
        assert_eq!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .unwrap(),
            RecoveryOutcome::Ready
        );
    }

    #[tokio::test]
    async fn invalid_control_files_and_orphan_backup_are_preserved() {
        let paths = RemoteReplacePaths::new(DESTINATION);
        for path in [
            &paths.journal,
            &paths.journal_temporary,
            &paths.installed,
            &paths.installed_temporary,
        ] {
            let fake = FakeRemoteFs::with_upload();
            fake.put_file(path, b"not a journal");
            let before = fake.state.lock().unwrap().entries.clone();
            assert!(
                recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                    .await
                    .is_err()
            );
            assert_eq!(fake.state.lock().unwrap().entries, before);
            assert!(fake.mutations().is_empty());
        }

        let fake = FakeRemoteFs::with_upload();
        fake.put_file(&paths.backup, b"unowned");
        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert_eq!(fake.file(&paths.backup).unwrap(), b"unowned");
        assert!(fake.mutations().is_empty());
    }

    #[tokio::test]
    async fn mismatched_records_and_installed_state_collisions_are_preserved() {
        let paths = RemoteReplacePaths::new(DESTINATION);
        let fake = FakeRemoteFs::with_upload();
        let mut wrong_path = test_record(&paths, CURRENT_TOKEN);
        wrong_path.destination_path = "/srv/other.tar".to_owned();
        put_record(&fake, &paths.journal, &wrong_path);
        let before = fake.state.lock().unwrap().entries.clone();
        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert_eq!(fake.state.lock().unwrap().entries, before);
        assert!(fake.mutations().is_empty());

        let fake = FakeRemoteFs::default();
        fake.put_file(DESTINATION, b"new-data");
        fake.put_file(&paths.temporary, b"new-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);
        put_record(&fake, &paths.installed, &record);
        let before = fake.state.lock().unwrap().entries.clone();
        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert_eq!(fake.state.lock().unwrap().entries, before);
        assert!(fake.mutations().is_empty());
    }

    #[tokio::test]
    async fn special_backup_is_never_removed_even_with_valid_marker() {
        let fake = FakeRemoteFs::default();
        let paths = RemoteReplacePaths::new(DESTINATION);
        fake.put_file(DESTINATION, b"new-data");
        fake.put_other(&paths.backup);
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.installed, &record);

        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert!(fake.exists(&paths.backup));
        assert!(fake.exists(&paths.installed));
        assert!(fake.mutations().is_empty());
    }

    #[tokio::test]
    async fn same_size_content_collisions_are_preserved() {
        let paths = RemoteReplacePaths::new(DESTINATION);

        let fake = FakeRemoteFs::default();
        fake.put_file(DESTINATION, b"bad-data");
        fake.put_file(&paths.backup, b"old");
        let record = test_record(&paths, CURRENT_TOKEN);
        put_record(&fake, &paths.journal, &record);
        put_record(&fake, &paths.installed, &record);
        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert_eq!(fake.file(DESTINATION).unwrap(), b"bad-data");
        assert_eq!(fake.file(&paths.backup).unwrap(), b"old");
        assert!(fake.mutations().is_empty());

        let fake = FakeRemoteFs::default();
        fake.put_file(DESTINATION, b"new-data");
        fake.put_file(&paths.backup, b"bad");
        put_record(&fake, &paths.journal, &record);
        put_record(&fake, &paths.installed, &record);
        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert_eq!(fake.file(&paths.backup).unwrap(), b"bad");
        assert!(fake.mutations().is_empty());

        let fake = FakeRemoteFs::default();
        fake.put_file(DESTINATION, b"old");
        fake.put_file(&paths.temporary, b"bad-data");
        put_record(&fake, &paths.journal, &record);
        assert!(
            recover_remote_replace_with(&fake, DESTINATION, CURRENT_TOKEN)
                .await
                .is_err()
        );
        assert_eq!(fake.file(&paths.temporary).unwrap(), b"bad-data");
        assert!(fake.exists(&paths.journal));
        assert!(fake.mutations().is_empty());
    }
}
