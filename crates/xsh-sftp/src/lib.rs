mod remote_replace;

#[cfg(test)]
mod protocol_test;

use anyhow::{Context, bail};
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, load_secret_key};
use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileType, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify, mpsc, watch};
use uuid::Uuid;
use xsh_domain::{
    ConnectionId, HostKeyApproval, HostKeyRole, KnownHost, RemoteEntry, RemoteFileType,
    SftpTransferPolicy, TransferDirection, TransferEvent, TransferId, TransferListSnapshot,
    TransferRuntimeSummary, TransferStatus, TransferWaitingReason,
};
use xsh_ssh::RuntimeAuthentication;
use xsh_ssh::config::resolve_proxy_jump;

#[derive(Debug)]
pub struct SftpConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub proxy_jump: Option<String>,
    pub proxy_jump_username: Option<String>,
    pub proxy_jump_authentication: Option<RuntimeAuthentication>,
    pub authentication: RuntimeAuthentication,
    pub known_host: Option<KnownHost>,
    pub proxy_jump_known_host: Option<KnownHost>,
}

#[derive(Debug)]
pub struct SftpConnectResult {
    pub connection_id: ConnectionId,
}

#[derive(Debug)]
pub struct TransferSubscription {
    pub transfer_id: TransferId,
    pub events: mpsc::Receiver<TransferEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum SftpManagerError {
    #[error("SFTP connection not found: {0}")]
    ConnectionNotFound(ConnectionId),
    #[error("transfer not found: {0}")]
    TransferNotFound(TransferId),
    #[error("SFTP operation failed: {0}")]
    Operation(#[from] anyhow::Error),
    #[error("SFTP Host Key 尚未确认：{}:{}", .0.host, .0.port)]
    HostKeyUnknown(HostKeyApproval),
    #[error(
        "SFTP Host Key 已变化（{role:?}）：{host}:{port} 期望 {expected_fingerprint}，实际 {presented_fingerprint}"
    )]
    HostKeyChanged {
        role: HostKeyRole,
        host: String,
        port: u16,
        expected_fingerprint: String,
        presented_fingerprint: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SftpHostKeyFailure {
    Unknown(HostKeyApproval),
    Changed {
        role: HostKeyRole,
        host: String,
        port: u16,
        expected_fingerprint: String,
        presented_fingerprint: String,
    },
}

const DOWNLOAD_RESUME_METADATA_VERSION: u8 = 2;
const UPLOAD_RESUME_METADATA_VERSION: u8 = 1;
const TRANSFER_EVENT_CAPACITY: usize = 16;
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
const RESUME_VERIFICATION_BLOCK_BYTES: u64 = 64 * 1024;
const RESUME_METADATA_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct UploadResumeMetadata {
    version: u8,
    local_path: String,
    remote_path: String,
    total_bytes: u64,
    modified_at_unix_nanos: Option<u128>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DownloadResumeMetadata {
    version: u8,
    remote_path: String,
    total_bytes: u64,
    modified_at_unix: Option<u32>,
    #[serde(default)]
    source_identity: String,
}

struct DownloadFileRequest<'a> {
    remote_path: &'a str,
    local_path: &'a Path,
    overwrite: bool,
    total_bytes: u64,
    modified_at_unix: Option<u32>,
    source_identity: &'a str,
}

#[derive(Clone)]
struct TerminalTransferContext {
    transfer_id: TransferId,
    connection_id: ConnectionId,
    endpoint: String,
    submission_sequence: u64,
    direction: TransferDirection,
    local_path: PathBuf,
    remote_path: String,
    total_bytes: u64,
}

impl TerminalTransferContext {
    fn event(
        &self,
        status: TransferStatus,
        transferred_bytes: u64,
        speed_bytes_per_second: Option<u64>,
        error: Option<String>,
    ) -> TransferEvent {
        TransferEvent {
            transfer_id: self.transfer_id,
            connection_id: self.connection_id,
            endpoint: self.endpoint.clone(),
            direction: self.direction.clone(),
            local_path: self.local_path.clone(),
            remote_path: self.remote_path.clone(),
            status,
            transferred_bytes,
            total_bytes: Some(self.total_bytes),
            speed_bytes_per_second,
            error,
            submission_sequence: self.submission_sequence,
            queue_position: None,
            waiting_reason: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferControl {
    Running,
    Paused,
    Cancelled,
}

#[derive(Debug, Clone)]
struct TransferScheduler {
    inner: Arc<TransferSchedulerInner>,
}

#[derive(Debug)]
struct TransferSchedulerInner {
    state: StdMutex<TransferSchedulerState>,
    admission_notify: Notify,
    upload_bandwidth_notify: Notify,
    download_bandwidth_notify: Notify,
}

#[derive(Debug)]
struct TransferSchedulerState {
    policy: SftpTransferPolicy,
    active_global: usize,
    active_by_host: HashMap<String, usize>,
    admission_queue: VecDeque<AdmissionWaiter>,
    next_bandwidth_ticket: u64,
    upload_bandwidth: DirectionBandwidthState,
    download_bandwidth: DirectionBandwidthState,
}

#[derive(Debug, Clone)]
struct AdmissionWaiter {
    transfer_id: TransferId,
    host_key: String,
    submission_sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransferQueueObservation {
    queue_position: u32,
    waiting_reason: TransferWaitingReason,
}

#[derive(Debug, Clone)]
struct TransferSchedulerRuntimeSnapshot {
    occupied_slots: u16,
    global_limit: u16,
    queue: HashMap<TransferId, TransferQueueObservation>,
}

#[derive(Debug)]
struct DirectionBandwidthState {
    queue: VecDeque<u64>,
    rate: u64,
    tokens: f64,
    last_refill: tokio::time::Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BandwidthDirection {
    Upload,
    Download,
}

#[derive(Debug)]
enum BandwidthWaitOutcome {
    Ready(BandwidthPermit),
    Paused,
    Cancelled,
}

enum BandwidthDecision {
    WaitForTurn,
    WaitForTokens(Duration),
    Ready { bytes: usize, rate_limited: bool },
}

enum TransferBandwidthWaitOutcome {
    Ready(BandwidthPermit),
    Finished(TransferStatus),
}

enum LimitedRemoteReadOutcome {
    Complete,
    Eof,
    Finished(TransferStatus),
}

enum ResumeVerificationOutcome {
    Matches(bool),
    Finished(TransferStatus),
}

struct AdmissionWaitRegistration {
    inner: Arc<TransferSchedulerInner>,
    transfer_id: TransferId,
    submission_sequence: u64,
    armed: bool,
    requeue_at_tail: bool,
}

struct BandwidthWaitRegistration {
    inner: Arc<TransferSchedulerInner>,
    direction: BandwidthDirection,
    ticket: u64,
    armed: bool,
}

#[derive(Debug)]
struct BandwidthPermit {
    scheduler: TransferScheduler,
    direction: BandwidthDirection,
    reserved_bytes: usize,
    rate_limited: bool,
    committed: bool,
}

struct AdmissionPermit {
    inner: Arc<TransferSchedulerInner>,
    host_key: String,
}

struct TransferRunGate {
    scheduler: TransferScheduler,
    transfer_id: TransferId,
    host_key: String,
    submission_sequence: u64,
    permit: Option<AdmissionPermit>,
    status_snapshot: Option<Arc<StdMutex<TransferEvent>>>,
    status_events: Option<mpsc::Sender<TransferEvent>>,
}

const MAX_BANDWIDTH_BURST_BYTES: u64 = 16 * 1024 * 1024;

impl DirectionBandwidthState {
    fn new() -> Self {
        Self {
            queue: VecDeque::new(),
            rate: 0,
            tokens: 0.0,
            last_refill: tokio::time::Instant::now(),
        }
    }

    fn sync_rate(&mut self, rate: u64, now: tokio::time::Instant) {
        if self.rate == rate {
            self.refill(now);
            return;
        }
        if self.rate == 0 {
            self.tokens = bandwidth_burst_bytes(rate) as f64;
        } else {
            self.refill(now);
            self.tokens = self.tokens.min(bandwidth_burst_bytes(rate) as f64);
        }
        self.rate = rate;
        self.last_refill = now;
    }

    fn refill(&mut self, now: tokio::time::Instant) {
        if self.rate > 0 {
            let added = now.duration_since(self.last_refill).as_secs_f64() * self.rate as f64;
            self.tokens = (self.tokens + added).min(bandwidth_burst_bytes(self.rate) as f64);
        }
        self.last_refill = now;
    }
}

fn bandwidth_burst_bytes(rate: u64) -> u64 {
    if rate == 0 {
        return 0;
    }
    (rate / 10).clamp(
        SftpTransferPolicy::MIN_LIMIT_BYTES_PER_SECOND,
        MAX_BANDWIDTH_BURST_BYTES,
    )
}

impl Default for TransferScheduler {
    fn default() -> Self {
        Self {
            inner: Arc::new(TransferSchedulerInner {
                state: StdMutex::new(TransferSchedulerState {
                    policy: SftpTransferPolicy::default(),
                    active_global: 0,
                    active_by_host: HashMap::new(),
                    admission_queue: VecDeque::new(),
                    next_bandwidth_ticket: 0,
                    upload_bandwidth: DirectionBandwidthState::new(),
                    download_bandwidth: DirectionBandwidthState::new(),
                }),
                admission_notify: Notify::new(),
                upload_bandwidth_notify: Notify::new(),
                download_bandwidth_notify: Notify::new(),
            }),
        }
    }
}

impl TransferScheduler {
    fn policy(&self) -> anyhow::Result<SftpTransferPolicy> {
        self.inner
            .state
            .lock()
            .map(|state| state.policy)
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))
    }

    fn runtime_snapshot(&self) -> anyhow::Result<TransferSchedulerRuntimeSnapshot> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
        let global_limit = state.policy.global_concurrency;
        let global_full = state.active_global >= usize::from(global_limit);
        let queue = state
            .admission_queue
            .iter()
            .enumerate()
            .map(|(index, waiter)| {
                let host_full = state
                    .active_by_host
                    .get(&waiter.host_key)
                    .copied()
                    .unwrap_or(0)
                    >= usize::from(state.policy.per_host_concurrency);
                let waiting_reason = if global_full {
                    TransferWaitingReason::GlobalConcurrency
                } else if host_full {
                    TransferWaitingReason::PerHostConcurrency
                } else {
                    TransferWaitingReason::QueueOrder
                };
                (
                    waiter.transfer_id,
                    TransferQueueObservation {
                        queue_position: u32::try_from(index.saturating_add(1)).unwrap_or(u32::MAX),
                        waiting_reason,
                    },
                )
            })
            .collect();
        Ok(TransferSchedulerRuntimeSnapshot {
            occupied_slots: u16::try_from(state.active_global).unwrap_or(u16::MAX),
            global_limit,
            queue,
        })
    }

    fn enqueue_admission(
        &self,
        transfer_id: TransferId,
        submission_sequence: u64,
        host_key: &str,
    ) -> anyhow::Result<()> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
        if state
            .admission_queue
            .iter()
            .any(|waiter| waiter.transfer_id == transfer_id)
        {
            bail!("SFTP transfer is already queued for admission");
        }
        let waiter = AdmissionWaiter {
            transfer_id,
            host_key: host_key.to_owned(),
            submission_sequence,
        };
        if submission_sequence == 0 {
            state.admission_queue.push_back(waiter);
        } else {
            let position = state
                .admission_queue
                .iter()
                .position(|candidate| {
                    candidate.submission_sequence != 0
                        && candidate.submission_sequence > submission_sequence
                })
                .unwrap_or(state.admission_queue.len());
            state.admission_queue.insert(position, waiter);
        }
        drop(state);
        self.inner.admission_notify.notify_waiters();
        Ok(())
    }

    fn set_policy(&self, policy: SftpTransferPolicy) -> anyhow::Result<()> {
        policy.validate().map_err(anyhow::Error::msg)?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
        let now = tokio::time::Instant::now();
        state
            .upload_bandwidth
            .sync_rate(policy.upload_limit_bytes_per_second, now);
        state
            .download_bandwidth
            .sync_rate(policy.download_limit_bytes_per_second, now);
        state.policy = policy;
        drop(state);
        self.inner.admission_notify.notify_waiters();
        self.inner.upload_bandwidth_notify.notify_waiters();
        self.inner.download_bandwidth_notify.notify_waiters();
        Ok(())
    }

    fn bandwidth_notify(&self, direction: BandwidthDirection) -> &Notify {
        match direction {
            BandwidthDirection::Upload => &self.inner.upload_bandwidth_notify,
            BandwidthDirection::Download => &self.inner.download_bandwidth_notify,
        }
    }

    #[cfg(test)]
    async fn acquire_admission(
        &self,
        transfer_id: TransferId,
        host_key: &str,
        control: &mut watch::Receiver<TransferControl>,
    ) -> anyhow::Result<Option<AdmissionPermit>> {
        self.acquire_admission_with_sequence(transfer_id, host_key, control, 0)
            .await
    }

    async fn acquire_admission_with_sequence(
        &self,
        transfer_id: TransferId,
        host_key: &str,
        control: &mut watch::Receiver<TransferControl>,
        submission_sequence: u64,
    ) -> anyhow::Result<Option<AdmissionPermit>> {
        let mut registration = AdmissionWaitRegistration::new(
            Arc::clone(&self.inner),
            transfer_id,
            submission_sequence,
        );
        registration.claim_existing()?;
        loop {
            let current_control = *control.borrow_and_update();
            match current_control {
                TransferControl::Cancelled => return Ok(None),
                TransferControl::Paused => {
                    registration.remove()?;
                    registration.requeue_at_tail = true;
                    control
                        .changed()
                        .await
                        .map_err(|_| anyhow::anyhow!("transfer control channel closed"))?;
                    continue;
                }
                TransferControl::Running => {}
            }

            let notified = self.inner.admission_notify.notified();
            let acquired = {
                let mut state =
                    self.inner.state.lock().map_err(|_| {
                        anyhow::anyhow!("SFTP transfer scheduler state is unavailable")
                    })?;
                if !registration.armed {
                    let waiter = AdmissionWaiter {
                        transfer_id,
                        host_key: host_key.to_owned(),
                        submission_sequence: registration.submission_sequence,
                    };
                    if registration.requeue_at_tail || registration.submission_sequence == 0 {
                        state.admission_queue.push_back(waiter);
                    } else {
                        let position = state
                            .admission_queue
                            .iter()
                            .position(|candidate| {
                                candidate.submission_sequence != 0
                                    && candidate.submission_sequence
                                        > registration.submission_sequence
                            })
                            .unwrap_or(state.admission_queue.len());
                        state.admission_queue.insert(position, waiter);
                    }
                    registration.armed = true;
                    registration.requeue_at_tail = false;
                }
                let global_available =
                    state.active_global < usize::from(state.policy.global_concurrency);
                let next_eligible = global_available.then(|| {
                    state.admission_queue.iter().find(|waiter| {
                        state
                            .active_by_host
                            .get(&waiter.host_key)
                            .copied()
                            .unwrap_or(0)
                            < usize::from(state.policy.per_host_concurrency)
                    })
                });
                if next_eligible.flatten().map(|waiter| waiter.transfer_id) == Some(transfer_id) {
                    let position = state
                        .admission_queue
                        .iter()
                        .position(|waiter| waiter.transfer_id == transfer_id)
                        .expect("eligible transfer must still be queued");
                    state.admission_queue.remove(position);
                    registration.armed = false;
                    state.active_global += 1;
                    *state.active_by_host.entry(host_key.to_owned()).or_default() += 1;
                    true
                } else {
                    false
                }
            };
            if acquired {
                return Ok(Some(AdmissionPermit {
                    inner: Arc::clone(&self.inner),
                    host_key: host_key.to_owned(),
                }));
            }

            tokio::select! {
                _ = notified => {}
                changed = control.changed() => {
                    changed.map_err(|_| anyhow::anyhow!("transfer control channel closed"))?;
                }
            }
        }
    }

    async fn acquire_bandwidth(
        &self,
        direction: BandwidthDirection,
        maximum_bytes: usize,
        control: &mut watch::Receiver<TransferControl>,
    ) -> anyhow::Result<BandwidthWaitOutcome> {
        if maximum_bytes == 0 {
            return Ok(BandwidthWaitOutcome::Ready(BandwidthPermit::new(
                self.clone(),
                direction,
                0,
                false,
            )));
        }
        let mut registration =
            BandwidthWaitRegistration::register(Arc::clone(&self.inner), direction)?;
        self.bandwidth_notify(direction).notify_waiters();

        loop {
            let current_control = *control.borrow_and_update();
            match current_control {
                TransferControl::Cancelled => return Ok(BandwidthWaitOutcome::Cancelled),
                TransferControl::Paused => return Ok(BandwidthWaitOutcome::Paused),
                TransferControl::Running => {}
            }

            let notified = self.bandwidth_notify(direction).notified();
            let decision = {
                let mut state =
                    self.inner.state.lock().map_err(|_| {
                        anyhow::anyhow!("SFTP transfer scheduler state is unavailable")
                    })?;
                let rate = match direction {
                    BandwidthDirection::Upload => state.policy.upload_limit_bytes_per_second,
                    BandwidthDirection::Download => state.policy.download_limit_bytes_per_second,
                };
                let bandwidth = bandwidth_state_mut(&mut state, direction);
                if bandwidth.queue.front().copied() != Some(registration.ticket) {
                    BandwidthDecision::WaitForTurn
                } else {
                    let now = tokio::time::Instant::now();
                    bandwidth.sync_rate(rate, now);
                    let requested = maximum_bytes
                        .min(usize::try_from(bandwidth_burst_bytes(rate)).unwrap_or(maximum_bytes));
                    if rate == 0 {
                        bandwidth.queue.pop_front();
                        registration.armed = false;
                        BandwidthDecision::Ready {
                            bytes: maximum_bytes,
                            rate_limited: false,
                        }
                    } else if bandwidth.tokens >= requested as f64 {
                        bandwidth.tokens -= requested as f64;
                        bandwidth.queue.pop_front();
                        registration.armed = false;
                        BandwidthDecision::Ready {
                            bytes: requested,
                            rate_limited: true,
                        }
                    } else {
                        let missing = requested as f64 - bandwidth.tokens;
                        BandwidthDecision::WaitForTokens(Duration::from_secs_f64(
                            missing / rate as f64,
                        ))
                    }
                }
            };
            match decision {
                BandwidthDecision::Ready {
                    bytes,
                    rate_limited,
                } => {
                    self.bandwidth_notify(direction).notify_waiters();
                    return Ok(BandwidthWaitOutcome::Ready(BandwidthPermit::new(
                        self.clone(),
                        direction,
                        bytes,
                        rate_limited,
                    )));
                }
                BandwidthDecision::WaitForTurn => {
                    tokio::select! {
                        _ = notified => {}
                        changed = control.changed() => {
                            if changed.is_err() {
                                bail!("transfer control channel closed");
                            }
                        }
                    }
                }
                BandwidthDecision::WaitForTokens(delay) => {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = notified => {}
                        changed = control.changed() => {
                            if changed.is_err() {
                                bail!("transfer control channel closed");
                            }
                        }
                    }
                }
            }
        }
    }

    fn refund_bandwidth(&self, direction: BandwidthDirection, bytes: usize) -> anyhow::Result<()> {
        if bytes == 0 {
            return Ok(());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
        let rate = match direction {
            BandwidthDirection::Upload => state.policy.upload_limit_bytes_per_second,
            BandwidthDirection::Download => state.policy.download_limit_bytes_per_second,
        };
        if rate > 0 {
            let bandwidth = bandwidth_state_mut(&mut state, direction);
            bandwidth.sync_rate(rate, tokio::time::Instant::now());
            bandwidth.tokens =
                (bandwidth.tokens + bytes as f64).min(bandwidth_burst_bytes(rate) as f64);
        }
        drop(state);
        self.bandwidth_notify(direction).notify_waiters();
        Ok(())
    }
}

fn bandwidth_state_mut(
    state: &mut TransferSchedulerState,
    direction: BandwidthDirection,
) -> &mut DirectionBandwidthState {
    match direction {
        BandwidthDirection::Upload => &mut state.upload_bandwidth,
        BandwidthDirection::Download => &mut state.download_bandwidth,
    }
}

impl AdmissionWaitRegistration {
    fn new(
        inner: Arc<TransferSchedulerInner>,
        transfer_id: TransferId,
        submission_sequence: u64,
    ) -> Self {
        Self {
            inner,
            transfer_id,
            submission_sequence,
            armed: false,
            requeue_at_tail: false,
        }
    }

    fn claim_existing(&mut self) -> anyhow::Result<()> {
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
        self.armed = state
            .admission_queue
            .iter()
            .any(|waiter| waiter.transfer_id == self.transfer_id);
        Ok(())
    }

    fn remove(&mut self) -> anyhow::Result<()> {
        if !self.armed {
            return Ok(());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
        if let Some(position) = state
            .admission_queue
            .iter()
            .position(|waiter| waiter.transfer_id == self.transfer_id)
        {
            state.admission_queue.remove(position);
        }
        self.armed = false;
        drop(state);
        self.inner.admission_notify.notify_waiters();
        Ok(())
    }
}

impl Drop for AdmissionWaitRegistration {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut state) = self.inner.state.lock()
            && let Some(position) = state
                .admission_queue
                .iter()
                .position(|waiter| waiter.transfer_id == self.transfer_id)
        {
            state.admission_queue.remove(position);
        }
        self.inner.admission_notify.notify_waiters();
    }
}

impl BandwidthWaitRegistration {
    fn register(
        inner: Arc<TransferSchedulerInner>,
        direction: BandwidthDirection,
    ) -> anyhow::Result<Self> {
        let ticket = {
            let mut state = inner
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("SFTP transfer scheduler state is unavailable"))?;
            let ticket = state.next_bandwidth_ticket;
            state.next_bandwidth_ticket = state.next_bandwidth_ticket.wrapping_add(1);
            bandwidth_state_mut(&mut state, direction)
                .queue
                .push_back(ticket);
            ticket
        };
        Ok(Self {
            inner,
            direction,
            ticket,
            armed: true,
        })
    }
}

impl Drop for BandwidthWaitRegistration {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut state) = self.inner.state.lock() {
            let queue = &mut bandwidth_state_mut(&mut state, self.direction).queue;
            if let Some(position) = queue.iter().position(|candidate| *candidate == self.ticket) {
                queue.remove(position);
            }
        }
        match self.direction {
            BandwidthDirection::Upload => self.inner.upload_bandwidth_notify.notify_waiters(),
            BandwidthDirection::Download => self.inner.download_bandwidth_notify.notify_waiters(),
        }
    }
}

impl BandwidthPermit {
    fn new(
        scheduler: TransferScheduler,
        direction: BandwidthDirection,
        reserved_bytes: usize,
        rate_limited: bool,
    ) -> Self {
        Self {
            scheduler,
            direction,
            reserved_bytes,
            rate_limited,
            committed: false,
        }
    }

    fn bytes(&self) -> usize {
        self.reserved_bytes
    }

    fn commit(mut self, actual_bytes: usize) -> anyhow::Result<()> {
        if actual_bytes > self.reserved_bytes {
            bail!("SFTP bandwidth permit was exceeded");
        }
        let unused = self.reserved_bytes - actual_bytes;
        self.committed = true;
        if self.rate_limited {
            self.scheduler.refund_bandwidth(self.direction, unused)?;
        }
        Ok(())
    }
}

impl Drop for BandwidthPermit {
    fn drop(&mut self) {
        if !self.committed && self.rate_limited {
            let _ = self
                .scheduler
                .refund_bandwidth(self.direction, self.reserved_bytes);
        }
    }
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.active_global = state.active_global.saturating_sub(1);
            if let Some(active) = state.active_by_host.get_mut(&self.host_key) {
                *active = active.saturating_sub(1);
                if *active == 0 {
                    state.active_by_host.remove(&self.host_key);
                }
            }
        }
        self.inner.admission_notify.notify_waiters();
    }
}

impl TransferRunGate {
    fn new(scheduler: TransferScheduler, transfer_id: TransferId, host_key: String) -> Self {
        Self {
            scheduler,
            transfer_id,
            host_key,
            submission_sequence: 0,
            permit: None,
            status_snapshot: None,
            status_events: None,
        }
    }

    fn set_submission_sequence(&mut self, submission_sequence: u64) {
        self.submission_sequence = submission_sequence;
    }

    fn attach_status_reporter(
        &mut self,
        snapshot: Arc<StdMutex<TransferEvent>>,
        events: mpsc::Sender<TransferEvent>,
    ) {
        self.status_snapshot = Some(snapshot);
        self.status_events = Some(events);
    }

    async fn wait_until_running(
        &mut self,
        control: &mut watch::Receiver<TransferControl>,
    ) -> anyhow::Result<Option<TransferStatus>> {
        loop {
            let current_control = *control.borrow_and_update();
            match current_control {
                TransferControl::Cancelled => {
                    self.permit.take();
                    return Ok(Some(TransferStatus::Cancelled));
                }
                TransferControl::Paused => {
                    self.permit.take();
                    control
                        .changed()
                        .await
                        .map_err(|_| anyhow::anyhow!("transfer control channel closed"))?;
                }
                TransferControl::Running if self.permit.is_some() => {
                    self.publish_running_status();
                    if *control.borrow_and_update() == TransferControl::Running {
                        return Ok(None);
                    }
                }
                TransferControl::Running => {
                    let permit = self
                        .scheduler
                        .acquire_admission_with_sequence(
                            self.transfer_id,
                            &self.host_key,
                            control,
                            self.submission_sequence,
                        )
                        .await?;
                    let Some(permit) = permit else {
                        return Ok(Some(TransferStatus::Cancelled));
                    };
                    self.permit = Some(permit);
                }
            }
        }
    }

    fn publish_running_status(&self) {
        let (Some(snapshot), Some(events)) = (&self.status_snapshot, &self.status_events) else {
            return;
        };
        let event = {
            let Ok(mut current) = snapshot.lock() else {
                return;
            };
            if current.status != TransferStatus::Queued {
                return;
            }
            current.status = TransferStatus::Running;
            current.speed_bytes_per_second = None;
            current.queue_position = None;
            current.waiting_reason = None;
            current.clone()
        };
        let _ = events.try_send(event);
    }

    fn release(&mut self) {
        self.permit.take();
    }
}

struct ManagedTransfer {
    connection_id: ConnectionId,
    control: watch::Sender<TransferControl>,
    snapshot: Arc<StdMutex<TransferEvent>>,
    worker_finished: Arc<AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum TransferArtifact {
    Local(String),
    Remote {
        source_identity: String,
        remote_path: String,
    },
    RemoteTree {
        source_identity: String,
        remote_path: String,
    },
}

#[derive(Debug, Clone)]
enum TransferDestination {
    Local(PathBuf),
    Remote {
        source_identity: String,
        remote_path: String,
    },
}

impl TransferDestination {
    fn local(path: &Path) -> Self {
        Self::Local(path.to_owned())
    }

    fn remote(source_identity: String, remote_path: String) -> Self {
        Self::Remote {
            source_identity,
            remote_path,
        }
    }

    fn artifacts(&self) -> anyhow::Result<Vec<TransferArtifact>> {
        match self {
            Self::Local(path) => {
                let final_path = normalize_local_destination(path)?;
                let temporary_path = format!("{final_path}.xsh-part");
                let metadata_path = format!("{temporary_path}.meta");
                Ok(vec![
                    TransferArtifact::Local(final_path),
                    TransferArtifact::Local(temporary_path),
                    TransferArtifact::Local(metadata_path.clone()),
                    TransferArtifact::Local(format!("{metadata_path}.tmp")),
                ])
            }
            Self::Remote {
                source_identity,
                remote_path,
            } => {
                let final_path = normalize_remote_destination(remote_path);
                let temporary_path = format!("{final_path}.xsh-part");
                let metadata_path = format!("{temporary_path}.meta");
                let replace_paths = remote_replace::RemoteReplacePaths::new(&final_path);
                let mut artifacts = vec![
                    TransferArtifact::Remote {
                        source_identity: source_identity.clone(),
                        remote_path: final_path,
                    },
                    TransferArtifact::Remote {
                        source_identity: source_identity.clone(),
                        remote_path: temporary_path,
                    },
                    TransferArtifact::Remote {
                        source_identity: source_identity.clone(),
                        remote_path: metadata_path.clone(),
                    },
                    TransferArtifact::Remote {
                        source_identity: source_identity.clone(),
                        remote_path: format!("{metadata_path}.tmp"),
                    },
                ];
                artifacts.extend(replace_paths.lease_artifacts().into_iter().map(|path| {
                    TransferArtifact::Remote {
                        source_identity: source_identity.clone(),
                        remote_path: path.to_owned(),
                    }
                }));
                Ok(artifacts)
            }
        }
    }
}

fn normalize_local_destination(path: &Path) -> anyhow::Result<String> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .context("failed to resolve the current directory for a transfer destination")?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }
    let normalized = normalized.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let normalized = normalized.to_lowercase();
    Ok(normalized)
}

fn normalize_remote_destination(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|part| *part != "..") => {
                parts.pop();
            }
            ".." if !absolute => parts.push(part),
            ".." => {}
            _ => parts.push(part),
        }
    }
    let normalized = parts.join("/");
    if absolute {
        format!("/{normalized}")
    } else if normalized.is_empty() {
        ".".to_owned()
    } else {
        normalized
    }
}

fn remote_destinations_match(left: &str, right: &str) -> bool {
    normalize_remote_destination(left) == normalize_remote_destination(right)
}

fn remote_path_is_within(path: &str, parent: &str) -> bool {
    if path == parent {
        return true;
    }
    if parent == "/" {
        return path.starts_with('/');
    }
    if parent == "." {
        return !path.starts_with('/');
    }
    path.strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn transfer_artifacts_overlap(left: &TransferArtifact, right: &TransferArtifact) -> bool {
    match (left, right) {
        (TransferArtifact::Local(left), TransferArtifact::Local(right)) => left == right,
        (
            TransferArtifact::Remote {
                source_identity: left_source,
                remote_path: left_path,
            },
            TransferArtifact::Remote {
                source_identity: right_source,
                remote_path: right_path,
            },
        ) => left_source == right_source && left_path == right_path,
        (
            TransferArtifact::RemoteTree {
                source_identity: tree_source,
                remote_path: tree_path,
            },
            TransferArtifact::Remote {
                source_identity: path_source,
                remote_path: path,
            },
        )
        | (
            TransferArtifact::Remote {
                source_identity: path_source,
                remote_path: path,
            },
            TransferArtifact::RemoteTree {
                source_identity: tree_source,
                remote_path: tree_path,
            },
        ) => tree_source == path_source && remote_path_is_within(path, tree_path),
        (
            TransferArtifact::RemoteTree {
                source_identity: left_source,
                remote_path: left_path,
            },
            TransferArtifact::RemoteTree {
                source_identity: right_source,
                remote_path: right_path,
            },
        ) => {
            left_source == right_source
                && (remote_path_is_within(left_path, right_path)
                    || remote_path_is_within(right_path, left_path))
        }
        _ => false,
    }
}

struct TransferDestinationLease {
    inner: Arc<SftpManagerInner>,
    artifacts: Vec<TransferArtifact>,
}

impl Drop for TransferDestinationLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.inner.active_destinations.lock() {
            for artifact in &self.artifacts {
                active.remove(artifact);
            }
        }
    }
}

fn update_transfer_snapshot(snapshot: &StdMutex<TransferEvent>, event: TransferEvent) {
    if let Ok(mut current) = snapshot.lock() {
        *current = event;
    }
}

struct TransferProgressReporter {
    events: mpsc::Sender<TransferEvent>,
    context: TerminalTransferContext,
    snapshot: Arc<StdMutex<TransferEvent>>,
    last_speed_sample: Instant,
    last_speed_bytes: u64,
    last_sent_at: Option<Instant>,
}

impl TransferProgressReporter {
    fn new(
        events: mpsc::Sender<TransferEvent>,
        context: TerminalTransferContext,
        snapshot: Arc<StdMutex<TransferEvent>>,
    ) -> Self {
        Self {
            events,
            context,
            snapshot,
            last_speed_sample: Instant::now(),
            last_speed_bytes: 0,
            last_sent_at: None,
        }
    }

    fn report(&mut self, transferred_bytes: u64) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_speed_sample);
        let speed_bytes_per_second = if elapsed.is_zero() {
            None
        } else {
            let bytes = transferred_bytes.saturating_sub(self.last_speed_bytes);
            Some((bytes as f64 / elapsed.as_secs_f64()) as u64)
        };
        self.last_speed_sample = now;
        self.last_speed_bytes = transferred_bytes;
        let event = {
            let Ok(mut current) = self.snapshot.lock() else {
                return;
            };
            let (status, speed) = match &current.status {
                TransferStatus::Queued | TransferStatus::Running => {
                    (TransferStatus::Running, speed_bytes_per_second)
                }
                TransferStatus::Paused => (TransferStatus::Paused, Some(0)),
                TransferStatus::Cancelling => (TransferStatus::Cancelling, Some(0)),
                TransferStatus::Cancelled => (TransferStatus::Cancelled, Some(0)),
                TransferStatus::Completed | TransferStatus::Failed => return,
            };
            let event = self
                .context
                .event(status, transferred_bytes, speed, current.error.clone());
            *current = event.clone();
            event
        };
        if self
            .last_sent_at
            .is_some_and(|last_sent| now.duration_since(last_sent) < TRANSFER_PROGRESS_INTERVAL)
        {
            return;
        }
        self.last_sent_at = Some(now);
        let _ = self.events.try_send(event);
    }
}

struct SftpHostKeyHandler {
    role: HostKeyRole,
    host: String,
    port: u16,
    known_host: Option<KnownHost>,
    failure: Arc<Mutex<Option<SftpHostKeyFailure>>>,
}

impl client::Handler for SftpHostKeyHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let public_key = server_public_key
            .to_openssh()
            .context("could not encode SFTP server key")?;
        let key_type = server_public_key.algorithm().as_str().to_owned();
        match &self.known_host {
            Some(known) if known.fingerprint == fingerprint && known.public_key == public_key => {
                Ok(true)
            }
            Some(known) => {
                *self.failure.lock().await = Some(SftpHostKeyFailure::Changed {
                    role: self.role,
                    host: self.host.clone(),
                    port: self.port,
                    expected_fingerprint: known.fingerprint.clone(),
                    presented_fingerprint: fingerprint,
                });
                Ok(false)
            }
            None => {
                *self.failure.lock().await = Some(SftpHostKeyFailure::Unknown(HostKeyApproval {
                    role: self.role,
                    host: self.host.clone(),
                    port: self.port,
                    key_type,
                    fingerprint,
                    public_key,
                }));
                Ok(false)
            }
        }
    }
}

async fn sftp_connect_error(
    error: anyhow::Error,
    failure: &Arc<Mutex<Option<SftpHostKeyFailure>>>,
    context: String,
) -> SftpManagerError {
    match failure.lock().await.take() {
        Some(SftpHostKeyFailure::Unknown(challenge)) => SftpManagerError::HostKeyUnknown(challenge),
        Some(SftpHostKeyFailure::Changed {
            role,
            host,
            port,
            expected_fingerprint,
            presented_fingerprint,
        }) => SftpManagerError::HostKeyChanged {
            role,
            host,
            port,
            expected_fingerprint,
            presented_fingerprint,
        },
        None => SftpManagerError::Operation(error.context(context)),
    }
}

async fn authenticate_password_fallback(
    session: &mut client::Handle<SftpHostKeyHandler>,
    username: &str,
    password: &str,
) -> anyhow::Result<bool> {
    let password_result = session
        .authenticate_password(username.to_owned(), password.to_owned())
        .await
        .context("SFTP password authentication exchange failed")?;
    if password_result.success() {
        return Ok(true);
    }

    let mut response = session
        .authenticate_keyboard_interactive_start(username.to_owned(), None)
        .await
        .context("SFTP keyboard-interactive authentication exchange failed")?;

    for _ in 0..8 {
        response = match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let responses = prompts
                    .into_iter()
                    .map(|prompt| {
                        if prompt.echo {
                            String::new()
                        } else {
                            password.to_owned()
                        }
                    })
                    .collect();
                session
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .context("SFTP keyboard-interactive authentication exchange failed")?
            }
        };
    }

    bail!("SFTP keyboard-interactive authentication exceeded the prompt limit")
}

async fn authenticate_sftp_session(
    session: &mut client::Handle<SftpHostKeyHandler>,
    username: &str,
    authentication: RuntimeAuthentication,
) -> anyhow::Result<bool> {
    match authentication {
        RuntimeAuthentication::Password(password) => {
            authenticate_password_fallback(session, username, password.as_str()).await
        }
        RuntimeAuthentication::PrivateKey {
            private_key_path,
            passphrase,
        } => {
            let key = load_secret_key(
                &private_key_path,
                passphrase.as_ref().map(|value| value.as_str()),
            )
            .context("无法读取或解密 OpenSSH 私钥")?;
            let hash_algorithm = session
                .best_supported_rsa_hash()
                .await
                .context("failed to negotiate RSA signature algorithm")?
                .flatten();
            Ok(session
                .authenticate_publickey(
                    username.to_owned(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_algorithm),
                )
                .await
                .context("SFTP public-key authentication failed")?
                .success())
        }
        RuntimeAuthentication::Agent {
            identity_fingerprint,
        } => {
            xsh_ssh::authenticate_with_agent(session, username, identity_fingerprint.as_deref())
                .await
        }
    }
}

struct ActiveSftpConnection {
    sftp: Arc<SftpSession>,
    download_source_identity: String,
    scheduler_host_key: String,
    _ssh: client::Handle<SftpHostKeyHandler>,
    _proxy_ssh: Option<client::Handle<SftpHostKeyHandler>>,
}

#[derive(Default)]
struct SftpManagerInner {
    connections: Mutex<HashMap<ConnectionId, ActiveSftpConnection>>,
    transfers: Mutex<HashMap<TransferId, ManagedTransfer>>,
    released_connections: Mutex<HashSet<ConnectionId>>,
    active_destinations: StdMutex<HashSet<TransferArtifact>>,
    scheduler: TransferScheduler,
    next_submission_sequence: AtomicU64,
}

#[derive(Clone, Default)]
pub struct SftpManager {
    inner: Arc<SftpManagerInner>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn transfer_policy(&self) -> Result<SftpTransferPolicy, SftpManagerError> {
        self.inner
            .scheduler
            .policy()
            .map_err(SftpManagerError::Operation)
    }

    pub fn set_transfer_policy(&self, policy: SftpTransferPolicy) -> Result<(), SftpManagerError> {
        self.inner
            .scheduler
            .set_policy(policy)
            .map_err(SftpManagerError::Operation)
    }

    fn next_submission_sequence(&self) -> u64 {
        self.inner
            .next_submission_sequence
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1)
    }

    pub async fn connect(
        &self,
        options: SftpConnectOptions,
    ) -> Result<SftpConnectResult, SftpManagerError> {
        let target_host_key_failure = Arc::new(Mutex::new(None));
        let proxy_target = options
            .proxy_jump
            .as_deref()
            .map(resolve_proxy_jump)
            .transpose()
            .map_err(SftpManagerError::Operation)?
            .flatten();
        let target_handler = SftpHostKeyHandler {
            role: HostKeyRole::Target,
            host: options.host.clone(),
            port: options.port,
            known_host: options.known_host.clone(),
            failure: Arc::clone(&target_host_key_failure),
        };
        let mut proxy_ssh = None;
        let mut ssh = if let Some(proxy) = proxy_target {
            let proxy_host_key_failure = Arc::new(Mutex::new(None));
            let proxy_handler = SftpHostKeyHandler {
                role: HostKeyRole::ProxyJump,
                host: proxy.host.clone(),
                port: proxy.port,
                known_host: options.proxy_jump_known_host.clone(),
                failure: Arc::clone(&proxy_host_key_failure),
            };
            let jump_result = client::connect(
                Arc::new(sftp_client_config()),
                (proxy.host.as_str(), proxy.port),
                proxy_handler,
            )
            .await;
            let mut jump = match jump_result {
                Ok(jump) => jump,
                Err(error) => {
                    return Err(sftp_connect_error(
                        error,
                        &proxy_host_key_failure,
                        format!(
                            "failed to connect to SFTP ProxyJump {}:{}",
                            proxy.host, proxy.port
                        ),
                    )
                    .await);
                }
            };
            let proxy_username = options
                .proxy_jump_username
                .as_deref()
                .or(proxy.username.as_deref())
                .unwrap_or(&options.username);
            let proxy_authentication = options
                .proxy_jump_authentication
                .clone()
                .unwrap_or_else(|| options.authentication.clone());
            let authenticated =
                authenticate_sftp_session(&mut jump, proxy_username, proxy_authentication)
                    .await
                    .context("SFTP ProxyJump authentication failed")?;
            if !authenticated {
                return Err(SftpManagerError::Operation(anyhow::anyhow!(
                    "the SFTP ProxyJump server rejected authentication"
                )));
            }
            let channel = jump
                .channel_open_direct_tcpip(
                    options.host.clone(),
                    options.port.into(),
                    "127.0.0.1",
                    0,
                )
                .await
                .with_context(|| {
                    format!(
                        "SFTP ProxyJump could not open {}:{} through {}:{}",
                        options.host, options.port, proxy.host, proxy.port
                    )
                })?;
            proxy_ssh = Some(jump);
            let target_result = client::connect_stream(
                Arc::new(sftp_client_config()),
                channel.into_stream(),
                target_handler,
            )
            .await;
            match target_result {
                Ok(connection) => connection,
                Err(error) => {
                    return Err(sftp_connect_error(
                        error,
                        &target_host_key_failure,
                        format!(
                            "failed to connect to SFTP target {}:{} through ProxyJump",
                            options.host, options.port
                        ),
                    )
                    .await);
                }
            }
        } else {
            let target_result = client::connect(
                Arc::new(sftp_client_config()),
                (options.host.as_str(), options.port),
                target_handler,
            )
            .await;
            match target_result {
                Ok(connection) => connection,
                Err(error) => {
                    return Err(sftp_connect_error(
                        error,
                        &target_host_key_failure,
                        format!("failed to connect to {}:{}", options.host, options.port),
                    )
                    .await);
                }
            }
        };

        let authenticated =
            authenticate_sftp_session(&mut ssh, &options.username, options.authentication).await?;
        if !authenticated {
            return Err(SftpManagerError::Operation(anyhow::anyhow!(
                "the server rejected SFTP authentication"
            )));
        }

        let channel = ssh
            .channel_open_session()
            .await
            .context("failed to open SFTP channel")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("the server rejected the SFTP subsystem")?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("failed to initialize the SFTP protocol")?;
        sftp.set_timeout(30);

        let target_fingerprint = options
            .known_host
            .as_ref()
            .map(|known_host| known_host.fingerprint.as_str())
            .unwrap_or("unverified");
        let download_source_identity =
            format!("{}:{}:{target_fingerprint}", options.host, options.port);
        let scheduler_host_key = format!("{}:{}", options.host.to_ascii_lowercase(), options.port);
        let connection_id = Uuid::new_v4();
        self.inner.connections.lock().await.insert(
            connection_id,
            ActiveSftpConnection {
                sftp: Arc::new(sftp),
                download_source_identity,
                scheduler_host_key,
                _ssh: ssh,
                _proxy_ssh: proxy_ssh,
            },
        );
        Ok(SftpConnectResult { connection_id })
    }

    pub async fn disconnect(&self, connection_id: ConnectionId) -> Result<(), SftpManagerError> {
        self.inner
            .released_connections
            .lock()
            .await
            .remove(&connection_id);
        self.close_connection(connection_id).await
    }

    pub async fn release_connection(
        &self,
        connection_id: ConnectionId,
    ) -> Result<(), SftpManagerError> {
        let has_active_transfers = self
            .inner
            .transfers
            .lock()
            .await
            .values()
            .filter(|transfer| transfer.connection_id == connection_id)
            .any(|transfer| !transfer.worker_finished.load(Ordering::Acquire));
        if has_active_transfers {
            self.inner
                .released_connections
                .lock()
                .await
                .insert(connection_id);
            return Ok(());
        }
        self.close_connection(connection_id).await
    }

    pub async fn list_transfers(&self) -> TransferListSnapshot {
        let transfers = {
            let transfers = self.inner.transfers.lock().await;
            transfers
                .values()
                .filter_map(|transfer| {
                    transfer
                        .snapshot
                        .lock()
                        .ok()
                        .map(|snapshot| snapshot.clone())
                })
                .collect::<Vec<_>>()
        };
        let scheduler = self
            .inner
            .scheduler
            .runtime_snapshot()
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "could not read the SFTP scheduler runtime snapshot");
                TransferSchedulerRuntimeSnapshot {
                    occupied_slots: 0,
                    global_limit: SftpTransferPolicy::default().global_concurrency,
                    queue: HashMap::new(),
                }
            });
        build_transfer_list_snapshot(transfers, scheduler)
    }

    pub async fn pause_transfer(
        &self,
        transfer_id: TransferId,
    ) -> Result<TransferEvent, SftpManagerError> {
        self.update_transfer_control(transfer_id, TransferControl::Paused)
            .await
    }

    pub async fn resume_transfer(
        &self,
        transfer_id: TransferId,
    ) -> Result<TransferEvent, SftpManagerError> {
        self.update_transfer_control(transfer_id, TransferControl::Running)
            .await
    }

    pub async fn cancel_transfer(
        &self,
        transfer_id: TransferId,
    ) -> Result<TransferEvent, SftpManagerError> {
        self.update_transfer_control(transfer_id, TransferControl::Cancelled)
            .await
    }

    pub async fn remove_transfer(&self, transfer_id: TransferId) -> Result<(), SftpManagerError> {
        let connection_id = {
            let mut transfers = self.inner.transfers.lock().await;
            let transfer = transfers
                .get(&transfer_id)
                .ok_or(SftpManagerError::TransferNotFound(transfer_id))?;
            if !transfer.worker_finished.load(Ordering::Acquire) {
                return Err(SftpManagerError::Operation(anyhow::anyhow!(
                    "cannot remove an active transfer"
                )));
            }
            transfers
                .remove(&transfer_id)
                .map(|transfer| transfer.connection_id)
        };
        if let Some(connection_id) = connection_id {
            self.close_released_connection_if_idle(connection_id)
                .await?;
        }
        Ok(())
    }

    async fn update_transfer_control(
        &self,
        transfer_id: TransferId,
        control: TransferControl,
    ) -> Result<TransferEvent, SftpManagerError> {
        let transfers = self.inner.transfers.lock().await;
        let transfer = transfers
            .get(&transfer_id)
            .ok_or(SftpManagerError::TransferNotFound(transfer_id))?;
        let mut snapshot = transfer.snapshot.lock().map_err(|_| {
            SftpManagerError::Operation(anyhow::anyhow!("transfer state lock poisoned"))
        })?;
        if !transfer_is_active(&snapshot.status) {
            return Ok(snapshot.clone());
        }
        if snapshot.status == TransferStatus::Cancelling {
            return Ok(snapshot.clone());
        }
        match control {
            TransferControl::Running => {
                if snapshot.status == TransferStatus::Paused {
                    snapshot.status = TransferStatus::Queued;
                    snapshot.speed_bytes_per_second = None;
                }
            }
            TransferControl::Paused => {
                if snapshot.status == TransferStatus::Running
                    || snapshot.status == TransferStatus::Queued
                {
                    snapshot.status = TransferStatus::Paused;
                    snapshot.speed_bytes_per_second = Some(0);
                }
            }
            TransferControl::Cancelled => {
                snapshot.status = TransferStatus::Cancelling;
                snapshot.speed_bytes_per_second = Some(0);
            }
        }
        snapshot.queue_position = None;
        snapshot.waiting_reason = (snapshot.status == TransferStatus::Paused)
            .then_some(TransferWaitingReason::UserPaused);
        let event = snapshot.clone();
        transfer
            .control
            .send(control)
            .map_err(|error| SftpManagerError::Operation(anyhow::anyhow!(error.to_string())))?;
        Ok(event)
    }

    async fn close_connection(&self, connection_id: ConnectionId) -> Result<(), SftpManagerError> {
        let connection = self
            .inner
            .connections
            .lock()
            .await
            .remove(&connection_id)
            .ok_or(SftpManagerError::ConnectionNotFound(connection_id))?;
        connection
            .sftp
            .close()
            .await
            .context("failed to close SFTP session")?;
        Ok(())
    }

    async fn close_released_connection_if_idle(
        &self,
        connection_id: ConnectionId,
    ) -> Result<(), SftpManagerError> {
        let has_active_transfers = self
            .inner
            .transfers
            .lock()
            .await
            .values()
            .filter(|transfer| transfer.connection_id == connection_id)
            .any(|transfer| !transfer.worker_finished.load(Ordering::Acquire));
        if has_active_transfers {
            return Ok(());
        }
        if self
            .inner
            .released_connections
            .lock()
            .await
            .remove(&connection_id)
        {
            self.close_connection(connection_id).await?;
        }
        Ok(())
    }

    pub async fn canonicalize(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<String, SftpManagerError> {
        self.session(connection_id)
            .await?
            .canonicalize(path)
            .await
            .context("failed to canonicalize remote path")
            .map_err(Into::into)
    }

    pub async fn list_directory(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<Vec<RemoteEntry>, SftpManagerError> {
        let session = self.session(connection_id).await?;
        let mut entries = session
            .read_dir(path)
            .await
            .context("failed to read remote directory")?
            .map(|entry| {
                let metadata = entry.metadata();
                RemoteEntry {
                    name: entry.file_name(),
                    path: entry.path(),
                    file_type: map_file_type(entry.file_type()),
                    size: metadata.len(),
                    modified_at_unix: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions,
                    owner: metadata.user,
                    group: metadata.group,
                }
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            entry_rank(&left.file_type)
                .cmp(&entry_rank(&right.file_type))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn stat(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<RemoteEntry, SftpManagerError> {
        let session = self.session(connection_id).await?;
        let metadata = session
            .metadata(path.clone())
            .await
            .context("failed to read remote metadata")?;
        let name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or(&path)
            .to_owned();
        Ok(RemoteEntry {
            name,
            path,
            file_type: map_file_type(metadata.file_type()),
            size: metadata.len(),
            modified_at_unix: metadata.mtime.map(u64::from),
            permissions: metadata.permissions,
            owner: metadata.user,
            group: metadata.group,
        })
    }

    pub async fn create_directory(
        &self,
        connection_id: ConnectionId,
        path: String,
    ) -> Result<(), SftpManagerError> {
        let (session, source_identity, _) = self.transfer_connection(connection_id).await?;
        let _mutation_lease = self.reserve_remote_mutation(&source_identity, [&path], true)?;
        session
            .create_dir(path)
            .await
            .context("failed to create remote directory")?;
        Ok(())
    }

    pub async fn rename(
        &self,
        connection_id: ConnectionId,
        old_path: String,
        new_path: String,
    ) -> Result<(), SftpManagerError> {
        let (session, source_identity, _) = self.transfer_connection(connection_id).await?;
        let _mutation_lease =
            self.reserve_remote_mutation(&source_identity, [&old_path, &new_path], true)?;
        session
            .rename(old_path, new_path)
            .await
            .context("failed to rename remote path")?;
        Ok(())
    }

    pub async fn delete(
        &self,
        connection_id: ConnectionId,
        path: String,
        is_directory: bool,
    ) -> Result<(), SftpManagerError> {
        let (session, source_identity, _) = self.transfer_connection(connection_id).await?;
        let _mutation_lease =
            self.reserve_remote_mutation(&source_identity, [&path], is_directory)?;
        if is_directory {
            session
                .remove_dir(path)
                .await
                .context("failed to delete remote directory")?;
        } else {
            session
                .remove_file(path)
                .await
                .context("failed to delete remote file")?;
        }
        Ok(())
    }

    pub async fn upload(
        &self,
        connection_id: ConnectionId,
        local_path: PathBuf,
        remote_path: String,
        overwrite: bool,
    ) -> Result<TransferSubscription, SftpManagerError> {
        let submission_sequence = self.next_submission_sequence();
        let (session, source_identity, scheduler_host_key) =
            self.transfer_connection(connection_id).await?;
        let local_metadata = tokio::fs::metadata(&local_path)
            .await
            .with_context(|| format!("failed to read {}", local_path.display()))?;
        let total_bytes = local_metadata.len();
        let upload_metadata =
            make_upload_resume_metadata(&local_path, &remote_path, &local_metadata);
        let destination = TransferDestination::remote(source_identity, remote_path.clone());
        let destination_lease = self.reserve_destination(destination)?;
        let transfer_id = Uuid::new_v4();
        self.inner
            .scheduler
            .enqueue_admission(transfer_id, submission_sequence, &scheduler_host_key)
            .map_err(SftpManagerError::Operation)?;
        let (event_tx, event_rx) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let (control_tx, control_rx) = watch::channel(TransferControl::Running);
        let context = TerminalTransferContext {
            transfer_id,
            connection_id,
            endpoint: scheduler_host_key.clone(),
            submission_sequence,
            direction: TransferDirection::Upload,
            local_path: local_path.clone(),
            remote_path: remote_path.clone(),
            total_bytes,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        let worker_finished = Arc::new(AtomicBool::new(false));
        self.inner.transfers.lock().await.insert(
            transfer_id,
            ManagedTransfer {
                connection_id,
                control: control_tx,
                snapshot: Arc::clone(&snapshot),
                worker_finished: Arc::clone(&worker_finished),
            },
        );
        let _ = event_tx.try_send(
            snapshot
                .lock()
                .map(|event| event.clone())
                .unwrap_or_else(|_| context.event(TransferStatus::Queued, 0, None, None)),
        );
        let manager = self.clone();

        tokio::spawn(async move {
            let destination_lease = destination_lease;
            let mut control_rx = control_rx;
            let mut run_gate = TransferRunGate::new(
                manager.inner.scheduler.clone(),
                transfer_id,
                scheduler_host_key,
            );
            run_gate.set_submission_sequence(context.submission_sequence);
            run_gate.attach_status_reporter(Arc::clone(&snapshot), event_tx.clone());
            let mut latest_transferred = 0;
            let mut reporter = TransferProgressReporter::new(
                event_tx.clone(),
                context.clone(),
                Arc::clone(&snapshot),
            );
            let result = async {
                if let Some(status) = run_gate.wait_until_running(&mut control_rx).await? {
                    return Ok(status);
                }
                upload_file(
                    UploadFileRequest {
                        session: &session,
                        local_path: &local_path,
                        remote_path: &remote_path,
                        overwrite,
                        expected_metadata: &upload_metadata,
                    },
                    &mut control_rx,
                    &mut run_gate,
                    |transferred| {
                        latest_transferred = transferred;
                        reporter.report(transferred);
                    },
                )
                .await
            }
            .await;
            let terminal_event = terminal_transfer_event(context, latest_transferred, result);
            update_transfer_snapshot(&snapshot, terminal_event.clone());
            drop(destination_lease);
            worker_finished.store(true, Ordering::Release);
            let _ = event_tx.send(terminal_event).await;
            let _ = manager
                .close_released_connection_if_idle(connection_id)
                .await;
        });

        Ok(TransferSubscription {
            transfer_id,
            events: event_rx,
        })
    }

    pub async fn download(
        &self,
        connection_id: ConnectionId,
        remote_path: String,
        local_path: PathBuf,
        overwrite: bool,
    ) -> Result<TransferSubscription, SftpManagerError> {
        let submission_sequence = self.next_submission_sequence();
        let (session, source_identity, scheduler_host_key) =
            self.transfer_connection(connection_id).await?;
        let remote_metadata = session
            .metadata(remote_path.clone())
            .await
            .context("failed to read remote file metadata")?;
        let total_bytes = remote_metadata.len();
        let modified_at_unix = remote_metadata.mtime;
        let destination = TransferDestination::local(&local_path);
        let destination_lease = self.reserve_destination(destination)?;
        let transfer_id = Uuid::new_v4();
        self.inner
            .scheduler
            .enqueue_admission(transfer_id, submission_sequence, &scheduler_host_key)
            .map_err(SftpManagerError::Operation)?;
        let (event_tx, event_rx) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let (control_tx, control_rx) = watch::channel(TransferControl::Running);
        let context = TerminalTransferContext {
            transfer_id,
            connection_id,
            endpoint: scheduler_host_key.clone(),
            submission_sequence,
            direction: TransferDirection::Download,
            local_path: local_path.clone(),
            remote_path: remote_path.clone(),
            total_bytes,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        let worker_finished = Arc::new(AtomicBool::new(false));
        self.inner.transfers.lock().await.insert(
            transfer_id,
            ManagedTransfer {
                connection_id,
                control: control_tx,
                snapshot: Arc::clone(&snapshot),
                worker_finished: Arc::clone(&worker_finished),
            },
        );
        let _ = event_tx.try_send(
            snapshot
                .lock()
                .map(|event| event.clone())
                .unwrap_or_else(|_| context.event(TransferStatus::Queued, 0, None, None)),
        );
        let manager = self.clone();

        tokio::spawn(async move {
            let destination_lease = destination_lease;
            let mut control_rx = control_rx;
            let mut run_gate = TransferRunGate::new(
                manager.inner.scheduler.clone(),
                transfer_id,
                scheduler_host_key,
            );
            run_gate.set_submission_sequence(context.submission_sequence);
            run_gate.attach_status_reporter(Arc::clone(&snapshot), event_tx.clone());
            let mut latest_transferred = 0;
            let mut reporter = TransferProgressReporter::new(
                event_tx.clone(),
                context.clone(),
                Arc::clone(&snapshot),
            );
            let result = async {
                if let Some(status) = run_gate.wait_until_running(&mut control_rx).await? {
                    return Ok(status);
                }
                download_file(
                    &session,
                    DownloadFileRequest {
                        remote_path: &remote_path,
                        local_path: &local_path,
                        overwrite,
                        total_bytes,
                        modified_at_unix,
                        source_identity: &source_identity,
                    },
                    &mut control_rx,
                    &mut run_gate,
                    |transferred| {
                        latest_transferred = transferred;
                        reporter.report(transferred);
                    },
                )
                .await
            }
            .await;
            let terminal_event = terminal_transfer_event(context, latest_transferred, result);
            update_transfer_snapshot(&snapshot, terminal_event.clone());
            drop(destination_lease);
            worker_finished.store(true, Ordering::Release);
            let _ = event_tx.send(terminal_event).await;
            let _ = manager
                .close_released_connection_if_idle(connection_id)
                .await;
        });

        Ok(TransferSubscription {
            transfer_id,
            events: event_rx,
        })
    }

    async fn session(
        &self,
        connection_id: ConnectionId,
    ) -> Result<Arc<SftpSession>, SftpManagerError> {
        self.inner
            .connections
            .lock()
            .await
            .get(&connection_id)
            .map(|connection| Arc::clone(&connection.sftp))
            .ok_or(SftpManagerError::ConnectionNotFound(connection_id))
    }

    async fn transfer_connection(
        &self,
        connection_id: ConnectionId,
    ) -> Result<(Arc<SftpSession>, String, String), SftpManagerError> {
        self.inner
            .connections
            .lock()
            .await
            .get(&connection_id)
            .map(|connection| {
                (
                    Arc::clone(&connection.sftp),
                    connection.download_source_identity.clone(),
                    connection.scheduler_host_key.clone(),
                )
            })
            .ok_or(SftpManagerError::ConnectionNotFound(connection_id))
    }

    fn reserve_destination(
        &self,
        destination: TransferDestination,
    ) -> Result<TransferDestinationLease, SftpManagerError> {
        let artifacts = destination
            .artifacts()
            .map_err(SftpManagerError::Operation)?;
        self.reserve_artifacts(artifacts)
    }

    fn reserve_remote_mutation<'a>(
        &self,
        source_identity: &str,
        paths: impl IntoIterator<Item = &'a String>,
        include_descendants: bool,
    ) -> Result<TransferDestinationLease, SftpManagerError> {
        let artifacts = paths
            .into_iter()
            .map(|path| {
                let remote_path = normalize_remote_destination(path);
                if include_descendants {
                    TransferArtifact::RemoteTree {
                        source_identity: source_identity.to_owned(),
                        remote_path,
                    }
                } else {
                    TransferArtifact::Remote {
                        source_identity: source_identity.to_owned(),
                        remote_path,
                    }
                }
            })
            .collect();
        self.reserve_artifacts(artifacts)
    }

    fn reserve_artifacts(
        &self,
        artifacts: Vec<TransferArtifact>,
    ) -> Result<TransferDestinationLease, SftpManagerError> {
        let mut active =
            self.inner.active_destinations.lock().map_err(|_| {
                SftpManagerError::Operation(anyhow::anyhow!("传输目标租约状态不可用"))
            })?;
        if artifacts.iter().any(|artifact| {
            active
                .iter()
                .any(|active| transfer_artifacts_overlap(artifact, active))
        }) {
            return Err(SftpManagerError::Operation(anyhow::anyhow!(
                "已有传输任务或文件操作正在使用同一远端目标，请等待其完成或先取消"
            )));
        }
        active.extend(artifacts.iter().cloned());
        drop(active);
        Ok(TransferDestinationLease {
            inner: Arc::clone(&self.inner),
            artifacts,
        })
    }
}

fn build_transfer_list_snapshot(
    mut transfers: Vec<TransferEvent>,
    runtime: TransferSchedulerRuntimeSnapshot,
) -> TransferListSnapshot {
    let mut summary = TransferRuntimeSummary {
        occupied_slots: runtime.occupied_slots,
        global_limit: runtime.global_limit,
        ..TransferRuntimeSummary::default()
    };

    for transfer in &mut transfers {
        match &transfer.status {
            TransferStatus::Queued => {
                summary.queued = summary.queued.saturating_add(1);
                if let Some(observation) = runtime.queue.get(&transfer.transfer_id) {
                    transfer.queue_position = Some(observation.queue_position);
                    transfer.waiting_reason = Some(observation.waiting_reason);
                } else {
                    transfer.queue_position = None;
                    transfer.waiting_reason = None;
                }
            }
            TransferStatus::Running => {
                summary.running = summary.running.saturating_add(1);
                transfer.queue_position = None;
                transfer.waiting_reason = None;
                if let Some(speed) = transfer.speed_bytes_per_second {
                    match transfer.direction {
                        TransferDirection::Upload => {
                            summary.aggregate_upload_bytes_per_second = summary
                                .aggregate_upload_bytes_per_second
                                .saturating_add(speed);
                        }
                        TransferDirection::Download => {
                            summary.aggregate_download_bytes_per_second = summary
                                .aggregate_download_bytes_per_second
                                .saturating_add(speed);
                        }
                    }
                }
            }
            TransferStatus::Paused => {
                summary.paused = summary.paused.saturating_add(1);
                transfer.queue_position = None;
                transfer.waiting_reason = Some(TransferWaitingReason::UserPaused);
            }
            TransferStatus::Cancelling => {
                summary.cancelling = summary.cancelling.saturating_add(1);
                transfer.queue_position = None;
                transfer.waiting_reason = None;
            }
            TransferStatus::Completed | TransferStatus::Cancelled | TransferStatus::Failed => {
                transfer.queue_position = None;
                transfer.waiting_reason = None;
            }
        }
    }

    transfers.sort_by(|left, right| {
        left.submission_sequence
            .cmp(&right.submission_sequence)
            .then_with(|| left.transfer_id.cmp(&right.transfer_id))
    });
    TransferListSnapshot { transfers, summary }
}

async fn wait_for_transfer_bandwidth(
    run_gate: &mut TransferRunGate,
    control: &mut watch::Receiver<TransferControl>,
    direction: BandwidthDirection,
    maximum_bytes: usize,
) -> anyhow::Result<TransferBandwidthWaitOutcome> {
    let scheduler = run_gate.scheduler.clone();
    loop {
        if let Some(status) = run_gate.wait_until_running(control).await? {
            return Ok(TransferBandwidthWaitOutcome::Finished(status));
        }
        match scheduler
            .acquire_bandwidth(direction, maximum_bytes, control)
            .await?
        {
            BandwidthWaitOutcome::Ready(permit) => {
                return Ok(TransferBandwidthWaitOutcome::Ready(permit));
            }
            BandwidthWaitOutcome::Paused => run_gate.release(),
            BandwidthWaitOutcome::Cancelled => {
                run_gate.release();
                return Ok(TransferBandwidthWaitOutcome::Finished(
                    TransferStatus::Cancelled,
                ));
            }
        }
    }
}

async fn read_remote_exact_with_bandwidth<R: AsyncRead + Unpin>(
    remote: &mut R,
    buffer: &mut [u8],
    control: &mut watch::Receiver<TransferControl>,
    run_gate: &mut TransferRunGate,
) -> anyhow::Result<LimitedRemoteReadOutcome> {
    let mut offset = 0;
    while offset < buffer.len() {
        let permit = match wait_for_transfer_bandwidth(
            run_gate,
            control,
            BandwidthDirection::Download,
            buffer.len() - offset,
        )
        .await?
        {
            TransferBandwidthWaitOutcome::Ready(permit) => permit,
            TransferBandwidthWaitOutcome::Finished(status) => {
                return Ok(LimitedRemoteReadOutcome::Finished(status));
            }
        };
        let read = remote
            .read(&mut buffer[offset..offset + permit.bytes()])
            .await?;
        permit.commit(read)?;
        if read == 0 {
            return Ok(LimitedRemoteReadOutcome::Eof);
        }
        offset += read;
    }
    Ok(LimitedRemoteReadOutcome::Complete)
}

struct UploadFileRequest<'a> {
    session: &'a SftpSession,
    local_path: &'a Path,
    remote_path: &'a str,
    overwrite: bool,
    expected_metadata: &'a UploadResumeMetadata,
}

async fn upload_file(
    request: UploadFileRequest<'_>,
    control: &mut watch::Receiver<TransferControl>,
    run_gate: &mut TransferRunGate,
    mut progress: impl FnMut(u64),
) -> anyhow::Result<TransferStatus> {
    let UploadFileRequest {
        session,
        local_path,
        remote_path,
        overwrite,
        expected_metadata,
    } = request;
    let upload_source_token = serde_json::to_string(expected_metadata)
        .context("failed to encode the SFTP upload source token")?;
    if remote_replace::recover_remote_replace(session, remote_path, &upload_source_token).await?
        == remote_replace::RecoveryOutcome::InstalledCurrent
    {
        progress(expected_metadata.total_bytes);
        cleanup_recovered_upload_metadata(
            session,
            &upload_metadata_path(remote_path),
            expected_metadata,
        )
        .await;
        return Ok(TransferStatus::Completed);
    }

    if let Some(destination) = remote_symlink_metadata_if_exists(session, remote_path).await? {
        if destination.file_type() != FileType::File {
            bail!("remote destination is not a regular file and cannot be overwritten");
        }
        if !overwrite {
            bail!("remote destination already exists");
        }
    }

    let local_metadata = tokio::fs::metadata(local_path).await?;
    let actual_metadata = make_upload_resume_metadata(local_path, remote_path, &local_metadata);
    if &actual_metadata != expected_metadata {
        bail!("local source changed before upload started");
    }

    let temporary_path = upload_temporary_path(remote_path);
    let metadata_path = upload_metadata_path(remote_path);
    let resumable_bytes =
        resumable_upload_bytes(session, &temporary_path, &metadata_path, expected_metadata).await?;
    let mut transferred = resumable_bytes.unwrap_or(0);
    let resume_matches = if transferred == 0 {
        true
    } else {
        match verify_upload_resume_samples(
            session,
            local_path,
            &temporary_path,
            transferred,
            control,
            run_gate,
        )
        .await?
        {
            ResumeVerificationOutcome::Matches(matches) => matches,
            ResumeVerificationOutcome::Finished(status) => return Ok(status),
        }
    };
    if resumable_bytes.is_none() || !resume_matches {
        remove_remote_file_if_exists(session, &temporary_path).await?;
        remove_remote_file_if_exists(session, &metadata_path).await?;
        write_upload_resume_metadata(session, &metadata_path, expected_metadata).await?;
        transferred = 0;
    }
    progress(transferred);

    let mut local = tokio::fs::File::open(local_path).await?;
    if transferred > 0 {
        local.seek(SeekFrom::Start(transferred)).await?;
    }

    let mut remote = session
        .open_with_flags(temporary_path.clone(), OpenFlags::CREATE | OpenFlags::WRITE)
        .await?;
    if transferred > 0 {
        remote.seek(SeekFrom::Start(transferred)).await?;
    }

    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        if let Some(status) = run_gate.wait_until_running(control).await? {
            remote.flush().await.ok();
            remote.shutdown().await.ok();
            return Ok(status);
        }
        let Some(chunk_size) =
            remaining_transfer_chunk_size(expected_metadata.total_bytes, transferred, buffer.len())
        else {
            break;
        };
        let permit = match wait_for_transfer_bandwidth(
            run_gate,
            control,
            BandwidthDirection::Upload,
            chunk_size,
        )
        .await?
        {
            TransferBandwidthWaitOutcome::Ready(permit) => permit,
            TransferBandwidthWaitOutcome::Finished(status) => {
                remote.flush().await.ok();
                remote.shutdown().await.ok();
                return Ok(status);
            }
        };
        let read = local.read(&mut buffer[..permit.bytes()]).await?;
        if read == 0 {
            permit.commit(0)?;
            break;
        }
        permit.commit(read)?;
        remote.write_all(&buffer[..read]).await?;
        transferred += read as u64;
        progress(transferred);
    }

    remote.flush().await?;
    remote.shutdown().await?;
    drop(remote);
    if let Some(status) = run_gate.wait_until_running(control).await? {
        return Ok(status);
    }
    if transferred != expected_metadata.total_bytes {
        bail!(
            "local file changed during upload: expected {} bytes, read {transferred} bytes",
            expected_metadata.total_bytes
        );
    }

    let final_local_metadata = tokio::fs::metadata(local_path).await?;
    let final_expected_metadata =
        make_upload_resume_metadata(local_path, remote_path, &final_local_metadata);
    if &final_expected_metadata != expected_metadata {
        bail!("local source changed during upload");
    }

    finalize_upload(
        session,
        &temporary_path,
        &metadata_path,
        remote_path,
        overwrite,
        expected_metadata.total_bytes,
        &upload_source_token,
    )
    .await?;
    Ok(TransferStatus::Completed)
}

fn upload_temporary_path(remote_path: &str) -> String {
    format!("{remote_path}.xsh-part")
}

fn upload_metadata_path(remote_path: &str) -> String {
    format!("{remote_path}.xsh-part.meta")
}

fn make_upload_resume_metadata(
    local_path: &Path,
    remote_path: &str,
    local_metadata: &std::fs::Metadata,
) -> UploadResumeMetadata {
    UploadResumeMetadata {
        version: UPLOAD_RESUME_METADATA_VERSION,
        local_path: local_path.to_string_lossy().into_owned(),
        remote_path: normalize_remote_destination(remote_path),
        total_bytes: local_metadata.len(),
        modified_at_unix_nanos: local_metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
    }
}

fn can_resume_upload(
    saved: &UploadResumeMetadata,
    expected: &UploadResumeMetadata,
    partial_bytes: u64,
) -> bool {
    upload_resume_metadata_matches(saved, expected) && partial_bytes <= expected.total_bytes
}

fn upload_resume_metadata_matches(
    saved: &UploadResumeMetadata,
    expected: &UploadResumeMetadata,
) -> bool {
    saved.version == expected.version
        && saved.local_path == expected.local_path
        && remote_destinations_match(&saved.remote_path, &expected.remote_path)
        && saved.total_bytes == expected.total_bytes
        && saved.modified_at_unix_nanos == expected.modified_at_unix_nanos
}

async fn resumable_upload_bytes(
    session: &SftpSession,
    temporary_path: &str,
    metadata_path: &str,
    expected: &UploadResumeMetadata,
) -> anyhow::Result<Option<u64>> {
    let temporary_metadata = remote_symlink_metadata_if_exists(session, temporary_path).await?;
    let resume_metadata = remote_symlink_metadata_if_exists(session, metadata_path).await?;
    let Some(resume_metadata) = resume_metadata else {
        if temporary_metadata.is_some() {
            bail!(
                "SFTP upload checkpoint collision at {temporary_path}; its metadata is missing, so the existing file was left untouched"
            );
        }
        return Ok(None);
    };
    if resume_metadata.file_type() != FileType::File {
        bail!(
            "SFTP upload checkpoint metadata is not a regular file: {metadata_path}; it was left untouched"
        );
    }
    if resume_metadata.len() > RESUME_METADATA_MAX_BYTES {
        bail!(
            "SFTP upload checkpoint metadata is too large: {metadata_path}; it was left untouched"
        );
    }
    let raw_metadata = read_remote_resume_metadata(session, metadata_path)
        .await
        .with_context(|| {
            format!("failed to read SFTP upload checkpoint metadata {metadata_path}")
        })?;
    let saved = serde_json::from_slice::<UploadResumeMetadata>(&raw_metadata).with_context(|| {
        format!(
            "SFTP upload checkpoint metadata is not recognized: {metadata_path}; existing artifacts were left untouched"
        )
    })?;
    if saved.version != UPLOAD_RESUME_METADATA_VERSION
        || !remote_destinations_match(&saved.remote_path, &expected.remote_path)
    {
        bail!(
            "SFTP upload checkpoint metadata does not belong to {remote_path}; existing artifacts were left untouched",
            remote_path = expected.remote_path.as_str()
        );
    }

    let Some(temporary_metadata) = temporary_metadata else {
        return Ok(None);
    };
    if temporary_metadata.file_type() != FileType::File {
        bail!(
            "SFTP upload checkpoint is not a regular file: {temporary_path}; it was left untouched"
        );
    }
    let partial_bytes = temporary_metadata.len();

    Ok(can_resume_upload(&saved, expected, partial_bytes).then_some(partial_bytes))
}

async fn verify_upload_resume_samples(
    session: &SftpSession,
    local_path: &Path,
    temporary_path: &str,
    partial_bytes: u64,
    control: &mut watch::Receiver<TransferControl>,
    run_gate: &mut TransferRunGate,
) -> anyhow::Result<ResumeVerificationOutcome> {
    let sample_bytes = partial_bytes.min(RESUME_VERIFICATION_BLOCK_BYTES) as usize;
    for offset in resume_sample_offsets(partial_bytes) {
        let mut local = tokio::fs::File::open(local_path).await?;
        local.seek(SeekFrom::Start(offset)).await?;
        let mut remote = session.open(temporary_path.to_owned()).await?;
        remote.seek(SeekFrom::Start(offset)).await?;
        let mut local_sample = vec![0_u8; sample_bytes];
        let mut remote_sample = vec![0_u8; sample_bytes];
        if local.read_exact(&mut local_sample).await.is_err() {
            return Ok(ResumeVerificationOutcome::Matches(false));
        }
        match read_remote_exact_with_bandwidth(&mut remote, &mut remote_sample, control, run_gate)
            .await?
        {
            LimitedRemoteReadOutcome::Complete => {}
            LimitedRemoteReadOutcome::Eof => {
                return Ok(ResumeVerificationOutcome::Matches(false));
            }
            LimitedRemoteReadOutcome::Finished(status) => {
                return Ok(ResumeVerificationOutcome::Finished(status));
            }
        }
        if local_sample != remote_sample {
            return Ok(ResumeVerificationOutcome::Matches(false));
        }
    }
    Ok(ResumeVerificationOutcome::Matches(true))
}

async fn write_upload_resume_metadata(
    session: &SftpSession,
    metadata_path: &str,
    metadata: &UploadResumeMetadata,
) -> anyhow::Result<()> {
    let temporary_metadata_path = format!("{metadata_path}.tmp");
    if let Some(existing) =
        remote_symlink_metadata_if_exists(session, &temporary_metadata_path).await?
    {
        if existing.file_type() != FileType::File || existing.len() > RESUME_METADATA_MAX_BYTES {
            bail!(
                "SFTP upload checkpoint metadata temporary path is occupied: {temporary_metadata_path}; it was left untouched"
            );
        }
        let raw = read_remote_resume_metadata(session, &temporary_metadata_path).await?;
        let saved = serde_json::from_slice::<UploadResumeMetadata>(&raw).ok();
        if !saved
            .as_ref()
            .is_some_and(|saved| upload_resume_metadata_matches(saved, metadata))
        {
            bail!(
                "SFTP upload checkpoint metadata temporary path contains unrecognized data: {temporary_metadata_path}; it was left untouched"
            );
        }
        session.remove_file(temporary_metadata_path.clone()).await?;
    }
    let encoded =
        serde_json::to_vec(metadata).context("failed to encode upload resume metadata")?;
    let mut remote = session
        .open_with_flags(
            temporary_metadata_path.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        )
        .await?;
    let write_result = async {
        remote.write_all(&encoded).await?;
        remote.flush().await?;
        remote.shutdown().await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    drop(remote);
    if let Err(error) = write_result {
        let _ = session.remove_file(temporary_metadata_path).await;
        return Err(error);
    }
    if let Err(error) = session
        .rename(temporary_metadata_path.clone(), metadata_path.to_owned())
        .await
    {
        let _ = session.remove_file(temporary_metadata_path).await;
        return Err(error.into());
    }
    Ok(())
}

async fn finalize_upload(
    session: &SftpSession,
    temporary_path: &str,
    metadata_path: &str,
    remote_path: &str,
    overwrite: bool,
    replacement_size: u64,
    upload_source_token: &str,
) -> anyhow::Result<()> {
    if let Some(destination) = remote_symlink_metadata_if_exists(session, remote_path).await? {
        if destination.file_type() != FileType::File {
            bail!("远程目标不是普通文件，不能执行覆盖");
        }
        if !overwrite {
            bail!("remote destination already exists");
        }
    }
    let replacement_fingerprint =
        remote_replace::fingerprint_remote_file(session, temporary_path, replacement_size).await?;
    match session
        .rename(temporary_path.to_owned(), remote_path.to_owned())
        .await
    {
        Ok(()) => {}
        Err(rename_error) => {
            let destination = remote_symlink_metadata_if_exists(session, remote_path)
                .await
                .with_context(|| {
                    format!(
                        "failed to inspect the remote destination after rename failed: {rename_error}"
                    )
                })?;
            let temporary = remote_symlink_metadata_if_exists(session, temporary_path)
                .await
                .with_context(|| {
                    format!(
                        "failed to inspect the upload temporary file after rename failed: {rename_error}"
                    )
                })?;
            match (destination, temporary) {
                (Some(destination), None) if destination.file_type() == FileType::File => {
                    if destination.len() != replacement_size
                        || !remote_replace::verify_remote_file_fingerprint(
                            session,
                            remote_path,
                            &replacement_fingerprint,
                        )
                        .await?
                    {
                        bail!(
                            "remote rename returned an error and the destination fingerprint is ambiguous: {rename_error}"
                        );
                    }
                }
                (Some(destination), Some(temporary))
                    if overwrite
                        && destination.file_type() == FileType::File
                        && temporary.file_type() == FileType::File =>
                {
                    let initial_error = rename_error.to_string();
                    remote_replace::replace_remote_file(
                        session,
                        remote_path,
                        &replacement_fingerprint,
                        upload_source_token,
                        &initial_error,
                    )
                    .await?;
                }
                (Some(destination), _) if destination.file_type() != FileType::File => {
                    bail!("远程目标不是普通文件，不能执行覆盖");
                }
                (_, Some(temporary)) if temporary.file_type() != FileType::File => {
                    bail!(
                        "SFTP upload temporary path is not a regular file: {temporary_path}; it was left untouched"
                    );
                }
                _ => return Err(rename_error.into()),
            }
        }
    }
    if let Err(error) = remove_remote_file_if_exists(session, metadata_path).await {
        tracing::warn!(path = %metadata_path, %error, "could not remove completed upload metadata");
    }
    Ok(())
}

async fn remove_remote_file_if_exists(session: &SftpSession, path: &str) -> anyhow::Result<()> {
    if session.try_exists(path.to_owned()).await? {
        session.remove_file(path.to_owned()).await?;
    }
    Ok(())
}

async fn cleanup_recovered_upload_metadata(
    session: &SftpSession,
    metadata_path: &str,
    expected: &UploadResumeMetadata,
) {
    for path in [metadata_path.to_owned(), format!("{metadata_path}.tmp")] {
        let existing = match remote_symlink_metadata_if_exists(session, &path).await {
            Ok(existing) => existing,
            Err(error) => {
                tracing::warn!(%path, %error, "could not inspect recovered upload metadata");
                continue;
            }
        };
        let Some(existing) = existing else {
            continue;
        };
        if existing.file_type() != FileType::File || existing.len() > RESUME_METADATA_MAX_BYTES {
            tracing::warn!(
                %path,
                "recovered upload metadata is not a recognized regular file and was left untouched"
            );
            continue;
        }
        let matches = match read_remote_resume_metadata(session, &path).await {
            Ok(raw) => serde_json::from_slice::<UploadResumeMetadata>(&raw)
                .is_ok_and(|saved| upload_resume_metadata_matches(&saved, expected)),
            Err(error) => {
                tracing::warn!(%path, %error, "could not read recovered upload metadata");
                false
            }
        };
        if !matches {
            tracing::warn!(
                %path,
                "recovered upload metadata does not match the installed source and was left untouched"
            );
            continue;
        }
        if let Err(error) = session.remove_file(path.clone()).await {
            tracing::warn!(%path, %error, "could not remove recovered upload metadata");
        }
    }
}

async fn remote_symlink_metadata_if_exists(
    session: &SftpSession,
    path: &str,
) -> anyhow::Result<Option<russh_sftp::client::fs::Metadata>> {
    match session.symlink_metadata(path.to_owned()).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn read_remote_resume_metadata(session: &SftpSession, path: &str) -> anyhow::Result<Vec<u8>> {
    let remote = session.open(path.to_owned()).await?;
    let mut limited = remote.take(RESUME_METADATA_MAX_BYTES + 1);
    let mut raw = Vec::new();
    limited.read_to_end(&mut raw).await?;
    if raw.len() as u64 > RESUME_METADATA_MAX_BYTES {
        bail!("SFTP resume metadata exceeds the size limit: {path}");
    }
    Ok(raw)
}

async fn download_file(
    session: &SftpSession,
    request: DownloadFileRequest<'_>,
    control: &mut watch::Receiver<TransferControl>,
    run_gate: &mut TransferRunGate,
    mut progress: impl FnMut(u64),
) -> anyhow::Result<TransferStatus> {
    if tokio::fs::try_exists(request.local_path).await? && !request.overwrite {
        bail!("local destination already exists");
    }
    if let Some(parent) = request.local_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let temporary_path = download_temporary_path(request.local_path);
    let metadata_path = download_metadata_path(request.local_path);
    let expected_metadata = DownloadResumeMetadata {
        version: DOWNLOAD_RESUME_METADATA_VERSION,
        remote_path: request.remote_path.to_owned(),
        total_bytes: request.total_bytes,
        modified_at_unix: request.modified_at_unix,
        source_identity: request.source_identity.to_owned(),
    };
    let partial_bytes =
        resumable_partial_bytes(&temporary_path, &metadata_path, &expected_metadata).await?;

    if partial_bytes.is_none() {
        remove_file_if_exists(&temporary_path).await?;
        remove_file_if_exists(&metadata_path).await?;
        write_download_resume_metadata(&metadata_path, &expected_metadata).await?;
    }
    let mut transferred = partial_bytes.unwrap_or(0);
    let resume_matches = if transferred == 0 {
        true
    } else {
        match verify_download_resume_samples(
            session,
            request.remote_path,
            &temporary_path,
            transferred,
            control,
            run_gate,
        )
        .await?
        {
            ResumeVerificationOutcome::Matches(matches) => matches,
            ResumeVerificationOutcome::Finished(status) => return Ok(status),
        }
    };
    if !resume_matches {
        remove_file_if_exists(&temporary_path).await?;
        remove_file_if_exists(&metadata_path).await?;
        write_download_resume_metadata(&metadata_path, &expected_metadata).await?;
        transferred = 0;
    }
    progress(transferred);

    if transferred == request.total_bytes {
        finalize_download(
            &temporary_path,
            &metadata_path,
            request.local_path,
            request.overwrite,
        )
        .await?;
        return Ok(TransferStatus::Completed);
    }

    let mut remote = session.open(request.remote_path.to_owned()).await?;
    if transferred > 0 {
        remote.seek(SeekFrom::Start(transferred)).await?;
    }
    let mut local = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temporary_path)
        .await?;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        if let Some(status) = run_gate.wait_until_running(control).await? {
            local.flush().await.ok();
            local.shutdown().await.ok();
            return Ok(status);
        }
        let Some(chunk_size) =
            remaining_transfer_chunk_size(request.total_bytes, transferred, buffer.len())
        else {
            break;
        };
        let permit = match wait_for_transfer_bandwidth(
            run_gate,
            control,
            BandwidthDirection::Download,
            chunk_size,
        )
        .await?
        {
            TransferBandwidthWaitOutcome::Ready(permit) => permit,
            TransferBandwidthWaitOutcome::Finished(status) => {
                local.flush().await.ok();
                local.shutdown().await.ok();
                return Ok(status);
            }
        };
        let read = remote.read(&mut buffer[..permit.bytes()]).await?;
        permit.commit(read)?;
        if read == 0 {
            break;
        }
        local.write_all(&buffer[..read]).await?;
        transferred += read as u64;
        progress(transferred);
    }
    local.flush().await?;
    local.shutdown().await?;
    drop(local);
    drop(remote);
    if transferred != request.total_bytes {
        bail!(
            "remote file ended early: expected {} bytes, received {transferred} bytes",
            request.total_bytes
        );
    }
    finalize_download(
        &temporary_path,
        &metadata_path,
        request.local_path,
        request.overwrite,
    )
    .await?;
    Ok(TransferStatus::Completed)
}

fn download_temporary_path(local_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.xsh-part", local_path.to_string_lossy()))
}

fn download_metadata_path(local_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.xsh-part.meta", local_path.to_string_lossy()))
}

fn can_resume_download(
    saved: &DownloadResumeMetadata,
    expected: &DownloadResumeMetadata,
    partial_bytes: u64,
) -> bool {
    saved == expected && partial_bytes <= expected.total_bytes
}

fn remaining_transfer_chunk_size(
    total_bytes: u64,
    transferred_bytes: u64,
    maximum: usize,
) -> Option<usize> {
    let remaining = total_bytes.saturating_sub(transferred_bytes);
    (remaining > 0).then(|| maximum.min(usize::try_from(remaining).unwrap_or(usize::MAX)))
}

async fn resumable_partial_bytes(
    temporary_path: &Path,
    metadata_path: &Path,
    expected: &DownloadResumeMetadata,
) -> anyhow::Result<Option<u64>> {
    let temporary_metadata = local_symlink_metadata_if_exists(temporary_path).await?;
    let resume_metadata = local_symlink_metadata_if_exists(metadata_path).await?;
    let Some(resume_metadata) = resume_metadata else {
        if temporary_metadata.is_some() {
            bail!(
                "download checkpoint collision at {}; its metadata is missing, so the existing file was left untouched",
                temporary_path.display()
            );
        }
        return Ok(None);
    };
    if !resume_metadata.is_file() {
        bail!(
            "download checkpoint metadata is not a regular file: {}; it was left untouched",
            metadata_path.display()
        );
    }
    if resume_metadata.len() > RESUME_METADATA_MAX_BYTES {
        bail!(
            "download checkpoint metadata is too large: {}; it was left untouched",
            metadata_path.display()
        );
    }
    let raw_metadata = read_local_resume_metadata(metadata_path)
        .await
        .with_context(|| {
            format!(
                "failed to read download checkpoint metadata {}",
                metadata_path.display()
            )
        })?;
    let saved = serde_json::from_slice::<DownloadResumeMetadata>(&raw_metadata).with_context(|| {
        format!(
            "download checkpoint metadata is not recognized: {}; existing artifacts were left untouched",
            metadata_path.display()
        )
    })?;
    if saved.version != DOWNLOAD_RESUME_METADATA_VERSION {
        bail!(
            "download checkpoint metadata version is unsupported at {}; existing artifacts were left untouched",
            metadata_path.display()
        );
    }

    let Some(temporary_metadata) = temporary_metadata else {
        return Ok(None);
    };
    if !temporary_metadata.is_file() {
        bail!(
            "download checkpoint is not a regular file: {}; it was left untouched",
            temporary_path.display()
        );
    }
    let partial_bytes = temporary_metadata.len();

    Ok(can_resume_download(&saved, expected, partial_bytes).then_some(partial_bytes))
}

async fn local_symlink_metadata_if_exists(
    path: &Path,
) -> anyhow::Result<Option<std::fs::Metadata>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn read_local_resume_metadata(path: &Path) -> anyhow::Result<Vec<u8>> {
    let local = tokio::fs::File::open(path).await?;
    let mut limited = local.take(RESUME_METADATA_MAX_BYTES + 1);
    let mut raw = Vec::new();
    limited.read_to_end(&mut raw).await?;
    if raw.len() as u64 > RESUME_METADATA_MAX_BYTES {
        bail!("resume metadata exceeds the size limit: {}", path.display());
    }
    Ok(raw)
}

fn resume_sample_offsets(partial_bytes: u64) -> Vec<u64> {
    if partial_bytes == 0 {
        return Vec::new();
    }
    let sample_bytes = partial_bytes.min(RESUME_VERIFICATION_BLOCK_BYTES);
    let tail_offset = partial_bytes - sample_bytes;
    if tail_offset == 0 {
        vec![0]
    } else {
        vec![0, tail_offset]
    }
}

async fn verify_download_resume_samples(
    session: &SftpSession,
    remote_path: &str,
    temporary_path: &Path,
    partial_bytes: u64,
    control: &mut watch::Receiver<TransferControl>,
    run_gate: &mut TransferRunGate,
) -> anyhow::Result<ResumeVerificationOutcome> {
    let sample_bytes = partial_bytes.min(RESUME_VERIFICATION_BLOCK_BYTES) as usize;
    for offset in resume_sample_offsets(partial_bytes) {
        let mut remote = session.open(remote_path.to_owned()).await?;
        remote.seek(SeekFrom::Start(offset)).await?;
        let mut local = tokio::fs::File::open(temporary_path).await?;
        local.seek(SeekFrom::Start(offset)).await?;
        let mut remote_sample = vec![0_u8; sample_bytes];
        let mut local_sample = vec![0_u8; sample_bytes];
        match read_remote_exact_with_bandwidth(&mut remote, &mut remote_sample, control, run_gate)
            .await?
        {
            LimitedRemoteReadOutcome::Complete => {}
            LimitedRemoteReadOutcome::Eof => {
                return Ok(ResumeVerificationOutcome::Matches(false));
            }
            LimitedRemoteReadOutcome::Finished(status) => {
                return Ok(ResumeVerificationOutcome::Finished(status));
            }
        }
        if local.read_exact(&mut local_sample).await.is_err() || remote_sample != local_sample {
            return Ok(ResumeVerificationOutcome::Matches(false));
        }
    }
    Ok(ResumeVerificationOutcome::Matches(true))
}

async fn write_download_resume_metadata(
    metadata_path: &Path,
    metadata: &DownloadResumeMetadata,
) -> anyhow::Result<()> {
    let temporary_metadata_path = PathBuf::from(format!("{}.tmp", metadata_path.to_string_lossy()));
    if let Some(existing) = local_symlink_metadata_if_exists(&temporary_metadata_path).await? {
        if !existing.is_file() || existing.len() > RESUME_METADATA_MAX_BYTES {
            bail!(
                "download checkpoint metadata temporary path is occupied: {}; it was left untouched",
                temporary_metadata_path.display()
            );
        }
        let raw = read_local_resume_metadata(&temporary_metadata_path).await?;
        let saved = serde_json::from_slice::<DownloadResumeMetadata>(&raw).ok();
        if saved.as_ref() != Some(metadata) {
            bail!(
                "download checkpoint metadata temporary path contains unrecognized data: {}; it was left untouched",
                temporary_metadata_path.display()
            );
        }
        tokio::fs::remove_file(&temporary_metadata_path).await?;
    }
    let encoded =
        serde_json::to_vec(metadata).context("failed to encode download resume metadata")?;
    let mut temporary_metadata = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary_metadata_path)
        .await
        .with_context(|| {
            format!(
                "download checkpoint metadata temporary path is already occupied or unavailable: {}; existing data was left untouched",
                temporary_metadata_path.display()
            )
        })?;
    let write_result = async {
        temporary_metadata.write_all(&encoded).await?;
        temporary_metadata.flush().await?;
        temporary_metadata.shutdown().await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    drop(temporary_metadata);
    if let Err(error) = write_result {
        let _ = tokio::fs::remove_file(&temporary_metadata_path).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&temporary_metadata_path, metadata_path).await {
        let _ = tokio::fs::remove_file(&temporary_metadata_path).await;
        return Err(error.into());
    }
    Ok(())
}

async fn finalize_download(
    temporary_path: &Path,
    metadata_path: &Path,
    local_path: &Path,
    overwrite: bool,
) -> anyhow::Result<()> {
    let destination_exists = match tokio::fs::symlink_metadata(local_path).await {
        Ok(metadata) if metadata.is_file() => true,
        Ok(_) => bail!("本地目标不是普通文件，不能执行覆盖"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if destination_exists && !overwrite {
        bail!("local destination already exists");
    }
    if destination_exists {
        replace_local_file(temporary_path, local_path).await?;
    } else if overwrite {
        tokio::fs::rename(temporary_path, local_path).await?;
    } else {
        install_local_file_without_overwrite(temporary_path, local_path).await?;
    }
    if let Err(error) = remove_file_if_exists(metadata_path).await {
        tracing::warn!(path = %metadata_path.display(), %error, "could not remove completed download metadata");
    }
    Ok(())
}

async fn install_local_file_without_overwrite(
    temporary_path: &Path,
    local_path: &Path,
) -> anyhow::Result<()> {
    tokio::fs::hard_link(temporary_path, local_path).await?;
    if let Err(error) = tokio::fs::remove_file(temporary_path).await {
        tracing::warn!(path = %temporary_path.display(), %error, "could not remove installed download checkpoint");
    }
    Ok(())
}

async fn replace_local_file(temporary_path: &Path, local_path: &Path) -> anyhow::Result<()> {
    tokio::fs::rename(temporary_path, local_path).await?;
    Ok(())
}

async fn remove_file_if_exists(path: &Path) -> anyhow::Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn terminal_transfer_event(
    context: TerminalTransferContext,
    last_transferred_bytes: u64,
    result: anyhow::Result<TransferStatus>,
) -> TransferEvent {
    let (status, error, transferred_bytes) = match result {
        Ok(status) => {
            let transferred = if status == TransferStatus::Completed {
                context.total_bytes
            } else {
                last_transferred_bytes
            };
            (status, None, transferred)
        }
        Err(error) => (
            TransferStatus::Failed,
            Some(format!("{error:#}")),
            last_transferred_bytes,
        ),
    };
    context.event(status, transferred_bytes, Some(0), error)
}

fn transfer_is_active(status: &TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Queued
            | TransferStatus::Running
            | TransferStatus::Paused
            | TransferStatus::Cancelling
    )
}

fn map_file_type(file_type: FileType) -> RemoteFileType {
    match file_type {
        FileType::Dir => RemoteFileType::Directory,
        FileType::File => RemoteFileType::File,
        FileType::Symlink => RemoteFileType::Symlink,
        FileType::Other => RemoteFileType::Other,
    }
}

fn entry_rank(file_type: &RemoteFileType) -> u8 {
    match file_type {
        RemoteFileType::Directory => 0,
        RemoteFileType::Symlink => 1,
        RemoteFileType::File => 2,
        RemoteFileType::Other => 3,
    }
}

fn sftp_client_config() -> client::Config {
    client::Config {
        nodelay: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_host_handler_captures_the_presented_key_and_role() {
        const ED25519_KEY: &str =
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
        let public_key = PublicKey::from_openssh(&format!("ssh-ed25519 {ED25519_KEY}"))
            .expect("test public key");
        let failure = Arc::new(Mutex::new(None));
        let mut handler = SftpHostKeyHandler {
            role: HostKeyRole::ProxyJump,
            host: "jump.example.com".into(),
            port: 2222,
            known_host: None,
            failure: Arc::clone(&failure),
        };

        assert!(
            !client::Handler::check_server_key(&mut handler, &public_key)
                .await
                .unwrap()
        );
        let captured = failure.lock().await.take().expect("host key challenge");
        let SftpHostKeyFailure::Unknown(captured) = captured else {
            panic!("expected an unknown Host Key challenge");
        };
        assert_eq!(captured.role, HostKeyRole::ProxyJump);
        assert_eq!(captured.host, "jump.example.com");
        assert_eq!(captured.port, 2222);
        assert_eq!(captured.key_type, "ssh-ed25519");
        assert_eq!(
            captured.fingerprint,
            public_key.fingerprint(HashAlg::Sha256).to_string()
        );
        assert_eq!(captured.public_key, public_key.to_openssh().unwrap());
    }

    #[tokio::test]
    async fn handshake_error_returns_the_exact_structured_host_key_challenge() {
        let challenge = HostKeyApproval {
            role: HostKeyRole::ProxyJump,
            host: "jump.example.com".into(),
            port: 2222,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
            public_key: "ssh-ed25519 AAAA".into(),
        };
        let presented = Arc::new(Mutex::new(Some(SftpHostKeyFailure::Unknown(
            challenge.clone(),
        ))));

        let error = sftp_connect_error(
            anyhow::anyhow!("russh rejected the key"),
            &presented,
            "outer connection context".into(),
        )
        .await;

        assert!(matches!(
            error,
            SftpManagerError::HostKeyUnknown(value) if value == challenge
        ));
        assert!(presented.lock().await.is_none());
    }

    #[tokio::test]
    async fn changed_host_key_keeps_the_role_endpoint_and_both_fingerprints() {
        const ED25519_KEY: &str =
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
        let public_key = PublicKey::from_openssh(&format!("ssh-ed25519 {ED25519_KEY}"))
            .expect("test public key");
        let failure = Arc::new(Mutex::new(None));
        let mut handler = SftpHostKeyHandler {
            role: HostKeyRole::Target,
            host: "target.example.com".into(),
            port: 22,
            known_host: Some(
                serde_json::from_str(
                    r#"{"host":"target.example.com","port":22,"keyType":"ssh-ed25519","fingerprint":"SHA256:expected","publicKey":"ssh-ed25519 AAAAexpected","firstSeen":"2026-01-01T00:00:00Z","lastSeen":"2026-01-01T00:00:00Z"}"#,
                )
                .unwrap(),
            ),
            failure: Arc::clone(&failure),
        };

        assert!(
            !client::Handler::check_server_key(&mut handler, &public_key)
                .await
                .unwrap()
        );
        let error = sftp_connect_error(
            anyhow::anyhow!("russh rejected the changed key"),
            &failure,
            "outer connection context".into(),
        )
        .await;

        assert!(matches!(
            error,
            SftpManagerError::HostKeyChanged {
                role: HostKeyRole::Target,
                host,
                port: 22,
                expected_fingerprint,
                presented_fingerprint,
            } if host == "target.example.com"
                && expected_fingerprint == "SHA256:expected"
                && presented_fingerprint == public_key.fingerprint(HashAlg::Sha256).to_string()
        ));
    }

    #[tokio::test]
    async fn ordinary_handshake_error_keeps_its_context() {
        let presented = Arc::new(Mutex::new(None));
        let error = sftp_connect_error(
            anyhow::anyhow!("connection reset"),
            &presented,
            "target handshake failed".into(),
        )
        .await;

        assert!(matches!(&error, SftpManagerError::Operation(_)));
        assert!(error.to_string().contains("target handshake failed"));
    }

    fn test_transfer_event(
        transfer_id: TransferId,
        sequence: u64,
        status: TransferStatus,
        direction: TransferDirection,
        speed: Option<u64>,
    ) -> TransferEvent {
        TerminalTransferContext {
            transfer_id,
            connection_id: Uuid::new_v4(),
            endpoint: "files.example.com:22".into(),
            submission_sequence: sequence,
            direction,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        }
        .event(status, 512, speed, None)
    }

    #[test]
    fn transfer_list_snapshot_sorts_by_submission_and_aggregates_directional_speed() {
        let running_upload = Uuid::from_u128(1);
        let queued_download = Uuid::from_u128(2);
        let paused_upload = Uuid::from_u128(3);
        let mut queue = HashMap::new();
        queue.insert(
            queued_download,
            TransferQueueObservation {
                queue_position: 1,
                waiting_reason: TransferWaitingReason::PerHostConcurrency,
            },
        );
        let snapshot = build_transfer_list_snapshot(
            vec![
                test_transfer_event(
                    queued_download,
                    2,
                    TransferStatus::Queued,
                    TransferDirection::Download,
                    None,
                ),
                test_transfer_event(
                    paused_upload,
                    3,
                    TransferStatus::Paused,
                    TransferDirection::Upload,
                    Some(0),
                ),
                test_transfer_event(
                    running_upload,
                    1,
                    TransferStatus::Running,
                    TransferDirection::Upload,
                    Some(u64::MAX),
                ),
            ],
            TransferSchedulerRuntimeSnapshot {
                occupied_slots: 1,
                global_limit: 2,
                queue,
            },
        );

        assert_eq!(
            snapshot
                .transfers
                .iter()
                .map(|transfer| transfer.submission_sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        let queued = &snapshot.transfers[1];
        assert_eq!(queued.queue_position, Some(1));
        assert_eq!(
            queued.waiting_reason,
            Some(TransferWaitingReason::PerHostConcurrency)
        );
        assert_eq!(
            snapshot.transfers[2].waiting_reason,
            Some(TransferWaitingReason::UserPaused)
        );
        assert_eq!(snapshot.summary.occupied_slots, 1);
        assert_eq!(snapshot.summary.global_limit, 2);
        assert_eq!(snapshot.summary.running, 1);
        assert_eq!(snapshot.summary.queued, 1);
        assert_eq!(snapshot.summary.paused, 1);
        assert_eq!(snapshot.summary.aggregate_upload_bytes_per_second, u64::MAX);
        assert_eq!(snapshot.summary.aggregate_download_bytes_per_second, 0);
    }

    #[test]
    fn scheduler_runtime_snapshot_explains_global_and_per_host_waiters() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 2,
                per_host_concurrency: 1,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let host_a_waiter = Uuid::from_u128(11);
        let host_c_waiter = Uuid::from_u128(12);
        {
            let mut state = scheduler.inner.state.lock().unwrap();
            state.active_global = 2;
            state.active_by_host.insert("host-a:22".into(), 1);
            state.active_by_host.insert("host-b:22".into(), 1);
            state.admission_queue.push_back(AdmissionWaiter {
                transfer_id: host_a_waiter,
                host_key: "host-a:22".into(),
                submission_sequence: 0,
            });
            state.admission_queue.push_back(AdmissionWaiter {
                transfer_id: host_c_waiter,
                host_key: "host-c:22".into(),
                submission_sequence: 0,
            });
        }

        let full = scheduler.runtime_snapshot().unwrap();
        assert_eq!(full.queue[&host_a_waiter].queue_position, 1);
        assert_eq!(
            full.queue[&host_a_waiter].waiting_reason,
            TransferWaitingReason::GlobalConcurrency
        );
        assert_eq!(
            full.queue[&host_c_waiter].waiting_reason,
            TransferWaitingReason::GlobalConcurrency
        );

        {
            let mut state = scheduler.inner.state.lock().unwrap();
            state.active_global = 1;
        }
        let host_limited = scheduler.runtime_snapshot().unwrap();
        assert_eq!(
            host_limited.queue[&host_a_waiter].waiting_reason,
            TransferWaitingReason::PerHostConcurrency
        );
        assert_eq!(
            host_limited.queue[&host_c_waiter].waiting_reason,
            TransferWaitingReason::QueueOrder
        );
    }

    #[tokio::test]
    async fn pre_registered_admission_is_released_when_worker_is_cancelled_before_start() {
        let scheduler = TransferScheduler::default();
        let transfer_id = Uuid::from_u128(21);
        let earlier_transfer_id = Uuid::from_u128(22);
        scheduler
            .enqueue_admission(transfer_id, 2, "host-a:22")
            .unwrap();
        scheduler
            .enqueue_admission(earlier_transfer_id, 1, "host-a:22")
            .unwrap();
        assert_eq!(
            scheduler.runtime_snapshot().unwrap().queue[&earlier_transfer_id].queue_position,
            1
        );
        assert_eq!(
            scheduler.runtime_snapshot().unwrap().queue[&transfer_id].queue_position,
            2
        );

        let (control, mut receiver) = watch::channel(TransferControl::Cancelled);
        let result = scheduler
            .acquire_admission(transfer_id, "host-a:22", &mut receiver)
            .await
            .unwrap();
        assert!(result.is_none());
        drop(control);
        assert_eq!(
            scheduler.runtime_snapshot().unwrap().queue[&earlier_transfer_id].queue_position,
            1
        );

        let (earlier_control, mut earlier_receiver) = watch::channel(TransferControl::Cancelled);
        assert!(
            scheduler
                .acquire_admission(earlier_transfer_id, "host-a:22", &mut earlier_receiver,)
                .await
                .unwrap()
                .is_none()
        );
        drop(earlier_control);
        assert!(scheduler.runtime_snapshot().unwrap().queue.is_empty());
    }

    #[test]
    fn submission_sequence_is_monotonic_and_one_based() {
        let manager = SftpManager::new();
        assert_eq!(manager.next_submission_sequence(), 1);
        assert_eq!(manager.next_submission_sequence(), 2);
        assert_eq!(manager.next_submission_sequence(), 3);
    }

    fn resume_metadata(remote_path: &str, total_bytes: u64) -> DownloadResumeMetadata {
        DownloadResumeMetadata {
            version: DOWNLOAD_RESUME_METADATA_VERSION,
            remote_path: remote_path.to_owned(),
            total_bytes,
            modified_at_unix: Some(1_700_000_000),
            source_identity: "files.example.com:22:SHA256:expected".into(),
        }
    }

    #[test]
    fn transfer_progress_is_throttled_before_the_event_queue() {
        let (events, mut received) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let context = TerminalTransferContext {
            transfer_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            endpoint: "files.example.com:22".into(),
            submission_sequence: 0,
            direction: TransferDirection::Upload,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        let mut reporter = TransferProgressReporter::new(events, context, snapshot);

        reporter.report(0);
        reporter.report(1_024);

        assert_eq!(received.try_recv().unwrap().transferred_bytes, 0);
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn transfer_progress_cannot_overwrite_paused_or_cancelled_state() {
        let (events, _received) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let context = TerminalTransferContext {
            transfer_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            endpoint: "files.example.com:22".into(),
            submission_sequence: 0,
            direction: TransferDirection::Upload,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Paused,
            512,
            Some(0),
            None,
        )));
        let mut reporter = TransferProgressReporter::new(events, context, Arc::clone(&snapshot));

        reporter.report(1_024);
        {
            let paused = snapshot.lock().unwrap();
            assert_eq!(paused.status, TransferStatus::Paused);
            assert_eq!(paused.transferred_bytes, 1_024);
            assert_eq!(paused.speed_bytes_per_second, Some(0));
        }

        snapshot.lock().unwrap().status = TransferStatus::Cancelling;
        reporter.report(1_536);
        let cancelling = snapshot.lock().unwrap();
        assert_eq!(cancelling.status, TransferStatus::Cancelling);
        assert_eq!(cancelling.transferred_bytes, 1_536);
        assert_eq!(cancelling.speed_bytes_per_second, Some(0));
    }

    #[test]
    fn terminal_transfer_event_preserves_terminal_status() {
        let context = TerminalTransferContext {
            transfer_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            endpoint: "files.example.com:22".into(),
            submission_sequence: 0,
            direction: TransferDirection::Download,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let event = terminal_transfer_event(context, 1_024, Ok(TransferStatus::Completed));
        assert_eq!(event.status, TransferStatus::Completed);
        assert_eq!(event.transferred_bytes, 2_048);
        assert_eq!(event.speed_bytes_per_second, Some(0));
    }

    #[tokio::test]
    async fn scheduler_enforces_global_and_per_host_limits_without_head_of_line_blocking() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 2,
                per_host_concurrency: 1,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let (_control_a1, mut receiver_a1) = watch::channel(TransferControl::Running);
        let permit_a1 = scheduler
            .acquire_admission(Uuid::new_v4(), "host-a:22", &mut receiver_a1)
            .await
            .unwrap()
            .unwrap();

        let (control_a2, mut receiver_a2) = watch::channel(TransferControl::Running);
        let transfer_a2 = Uuid::new_v4();
        let mut waiting_a2 =
            Box::pin(scheduler.acquire_admission(transfer_a2, "host-a:22", &mut receiver_a2));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting_a2)
                .await
                .is_err()
        );

        let (_control_b, mut receiver_b) = watch::channel(TransferControl::Running);
        let permit_b = scheduler
            .acquire_admission(Uuid::new_v4(), "host-b:22", &mut receiver_b)
            .await
            .unwrap()
            .unwrap();

        let (_control_c, mut receiver_c) = watch::channel(TransferControl::Running);
        let mut waiting_c =
            Box::pin(scheduler.acquire_admission(Uuid::new_v4(), "host-c:22", &mut receiver_c));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting_c)
                .await
                .is_err()
        );
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 3,
                per_host_concurrency: 1,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let permit_c = tokio::time::timeout(Duration::from_millis(100), &mut waiting_c)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        control_a2.send(TransferControl::Cancelled).unwrap();
        assert!(waiting_a2.await.unwrap().is_none());
        drop((permit_a1, permit_b, permit_c));
    }

    #[tokio::test]
    async fn lowering_concurrency_waits_for_running_tasks_to_drain() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 3,
                per_host_concurrency: 3,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let (_control_a, mut receiver_a) = watch::channel(TransferControl::Running);
        let (_control_b, mut receiver_b) = watch::channel(TransferControl::Running);
        let (_control_c, mut receiver_c) = watch::channel(TransferControl::Running);
        let permit_a = scheduler
            .acquire_admission(Uuid::new_v4(), "host-a:22", &mut receiver_a)
            .await
            .unwrap()
            .unwrap();
        let permit_b = scheduler
            .acquire_admission(Uuid::new_v4(), "host-b:22", &mut receiver_b)
            .await
            .unwrap()
            .unwrap();
        let permit_c = scheduler
            .acquire_admission(Uuid::new_v4(), "host-c:22", &mut receiver_c)
            .await
            .unwrap()
            .unwrap();
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 1,
                per_host_concurrency: 1,
                ..SftpTransferPolicy::default()
            })
            .unwrap();

        let (_waiting_control, mut waiting_receiver) = watch::channel(TransferControl::Running);
        let mut waiting = Box::pin(scheduler.acquire_admission(
            Uuid::new_v4(),
            "host-d:22",
            &mut waiting_receiver,
        ));
        drop(permit_a);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        drop(permit_b);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        drop(permit_c);
        let permit_d = tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .expect("new transfer should run after active count reaches the lower limit")
            .unwrap()
            .unwrap();
        drop(permit_d);
    }

    #[tokio::test]
    async fn paused_run_gate_releases_its_host_slot_and_requeues_on_resume() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 1,
                per_host_concurrency: 1,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let (control_a, mut receiver_a) = watch::channel(TransferControl::Running);
        let mut gate = TransferRunGate::new(scheduler.clone(), Uuid::new_v4(), "host-a:22".into());
        assert!(
            gate.wait_until_running(&mut receiver_a)
                .await
                .unwrap()
                .is_none()
        );

        control_a.send(TransferControl::Paused).unwrap();
        let mut paused_gate = Box::pin(gate.wait_until_running(&mut receiver_a));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut paused_gate)
                .await
                .is_err()
        );
        let (_control_b, mut receiver_b) = watch::channel(TransferControl::Running);
        let permit_b = scheduler
            .acquire_admission(Uuid::new_v4(), "host-a:22", &mut receiver_b)
            .await
            .unwrap()
            .unwrap();
        drop(permit_b);

        control_a.send(TransferControl::Cancelled).unwrap();
        assert_eq!(paused_gate.await.unwrap(), Some(TransferStatus::Cancelled));
    }

    #[tokio::test]
    async fn run_gate_publishes_running_with_transfer_ownership() {
        let scheduler = TransferScheduler::default();
        let transfer_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let context = TerminalTransferContext {
            transfer_id,
            connection_id,
            endpoint: "files.example.com:22".into(),
            submission_sequence: 0,
            direction: TransferDirection::Download,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2048,
        };
        let snapshot = Arc::new(StdMutex::new(context.event(
            TransferStatus::Queued,
            0,
            None,
            None,
        )));
        let (events, mut received) = mpsc::channel(TRANSFER_EVENT_CAPACITY);
        let mut gate = TransferRunGate::new(scheduler, transfer_id, context.endpoint.clone());
        gate.attach_status_reporter(Arc::clone(&snapshot), events);
        let (_control, mut receiver) = watch::channel(TransferControl::Running);

        assert!(
            gate.wait_until_running(&mut receiver)
                .await
                .unwrap()
                .is_none()
        );
        let running = snapshot.lock().unwrap().clone();
        assert_eq!(running.status, TransferStatus::Running);
        assert_eq!(running.connection_id, connection_id);
        assert_eq!(running.endpoint, context.endpoint);
        assert_eq!(received.try_recv().unwrap(), running);
    }

    #[tokio::test]
    async fn aggregate_bandwidth_wait_is_directional_dynamic_and_cancellable() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: 1024,
                download_limit_bytes_per_second: 0,
                ..SftpTransferPolicy::default()
            })
            .unwrap();

        let (_initial_control, mut initial_receiver) = watch::channel(TransferControl::Running);
        let initial = match scheduler
            .acquire_bandwidth(BandwidthDirection::Upload, 64 * 1024, &mut initial_receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected an initial bandwidth permit, got {outcome:?}"),
        };
        assert_eq!(initial.bytes(), 1024);
        initial.commit(1024).unwrap();

        let (_download_control, mut download_receiver) = watch::channel(TransferControl::Running);
        let download = match scheduler
            .acquire_bandwidth(
                BandwidthDirection::Download,
                64 * 1024,
                &mut download_receiver,
            )
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected an unlimited download permit, got {outcome:?}"),
        };
        assert_eq!(download.bytes(), 64 * 1024);
        download.commit(64 * 1024).unwrap();

        let (cancel, mut receiver) = watch::channel(TransferControl::Running);
        let mut waiting =
            Box::pin(scheduler.acquire_bandwidth(BandwidthDirection::Upload, 1024, &mut receiver));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        cancel.send(TransferControl::Cancelled).unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_millis(100), &mut waiting)
                .await
                .unwrap()
                .unwrap(),
            BandwidthWaitOutcome::Cancelled
        ));

        let (_control, mut receiver) = watch::channel(TransferControl::Running);
        let mut dynamic =
            Box::pin(scheduler.acquire_bandwidth(BandwidthDirection::Upload, 1024, &mut receiver));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut dynamic)
                .await
                .is_err()
        );
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: 0,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let dynamic = tokio::time::timeout(Duration::from_millis(100), &mut dynamic)
            .await
            .unwrap()
            .unwrap();
        let BandwidthWaitOutcome::Ready(dynamic) = dynamic else {
            panic!("expected a dynamic bandwidth permit");
        };
        dynamic.commit(1024).unwrap();
    }

    #[tokio::test]
    async fn bandwidth_wait_preserves_elapsed_time_across_queue_notifications() {
        tokio::time::pause();
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: 0,
                download_limit_bytes_per_second: 1024,
                ..SftpTransferPolicy::default()
            })
            .unwrap();

        let (_initial_control, mut initial_receiver) = watch::channel(TransferControl::Running);
        let initial = match scheduler
            .acquire_bandwidth(BandwidthDirection::Download, 1024, &mut initial_receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected an initial bandwidth permit, got {outcome:?}"),
        };
        initial.commit(1024).unwrap();

        let download_scheduler = scheduler.clone();
        let (_download_control, mut download_receiver) = watch::channel(TransferControl::Running);
        let download = tokio::spawn(async move {
            download_scheduler
                .acquire_bandwidth(BandwidthDirection::Download, 1024, &mut download_receiver)
                .await
                .unwrap()
        });
        tokio::task::yield_now().await;
        assert!(!download.is_finished());

        tokio::time::advance(Duration::from_millis(400)).await;
        let (_upload_control, mut upload_receiver) = watch::channel(TransferControl::Running);
        let upload = match scheduler
            .acquire_bandwidth(BandwidthDirection::Upload, 64 * 1024, &mut upload_receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected an unlimited upload permit, got {outcome:?}"),
        };
        upload.commit(64 * 1024).unwrap();
        scheduler
            .bandwidth_notify(BandwidthDirection::Download)
            .notify_waiters();

        tokio::time::advance(Duration::from_millis(700)).await;
        tokio::task::yield_now().await;
        assert!(download.is_finished());
        let BandwidthWaitOutcome::Ready(download) = download.await.unwrap() else {
            panic!("expected the queued download permit");
        };
        download.commit(1024).unwrap();
    }

    #[tokio::test]
    async fn bandwidth_permit_refunds_a_short_read() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                download_limit_bytes_per_second: 1024,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let (_first_control, mut first_receiver) = watch::channel(TransferControl::Running);
        let first = match scheduler
            .acquire_bandwidth(BandwidthDirection::Download, 1024, &mut first_receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected the initial download permit, got {outcome:?}"),
        };
        first.commit(512).unwrap();

        let (_second_control, mut second_receiver) = watch::channel(TransferControl::Running);
        let second = tokio::time::timeout(
            Duration::from_millis(20),
            scheduler.acquire_bandwidth(BandwidthDirection::Download, 512, &mut second_receiver),
        )
        .await
        .expect("unused reservation should be immediately reusable")
        .unwrap();
        let BandwidthWaitOutcome::Ready(second) = second else {
            panic!("expected the refunded download permit");
        };
        second.commit(512).unwrap();
    }

    #[tokio::test]
    async fn upload_tail_reserves_only_the_remaining_bytes() {
        tokio::time::pause();
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: 1024,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let total_bytes = 1025;
        let mut transferred = 0;
        let (_control, mut receiver) = watch::channel(TransferControl::Running);

        let first_maximum =
            remaining_transfer_chunk_size(total_bytes, transferred, 64 * 1024).unwrap();
        let first = match scheduler
            .acquire_bandwidth(BandwidthDirection::Upload, first_maximum, &mut receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected the initial upload permit, got {outcome:?}"),
        };
        assert_eq!(first.bytes(), 1024);
        transferred += first.bytes() as u64;
        first.commit(1024).unwrap();

        let tail_maximum =
            remaining_transfer_chunk_size(total_bytes, transferred, 64 * 1024).unwrap();
        assert_eq!(tail_maximum, 1);
        let tail_scheduler = scheduler.clone();
        let tail = tokio::spawn(async move {
            tail_scheduler
                .acquire_bandwidth(BandwidthDirection::Upload, tail_maximum, &mut receiver)
                .await
                .unwrap()
        });
        tokio::task::yield_now().await;
        assert!(!tail.is_finished());
        tokio::time::advance(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        let BandwidthWaitOutcome::Ready(tail) = tail.await.unwrap() else {
            panic!("expected the upload tail permit");
        };
        assert_eq!(tail.bytes(), 1);
        transferred += 1;
        tail.commit(1).unwrap();
        assert_eq!(
            remaining_transfer_chunk_size(total_bytes, transferred, 64 * 1024),
            None
        );
    }

    #[tokio::test]
    async fn remote_resume_reads_share_the_download_bandwidth_limit() {
        tokio::time::pause();
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                download_limit_bytes_per_second: 1024,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let (mut writer, reader) = tokio::io::duplex(4096);
        let expected = vec![0x5a; 2048];
        writer.write_all(&expected).await.unwrap();
        writer.shutdown().await.unwrap();

        let read_scheduler = scheduler.clone();
        let read = tokio::spawn(async move {
            let mut reader = reader;
            let mut buffer = vec![0_u8; 2048];
            let mut gate = TransferRunGate::new(read_scheduler, Uuid::new_v4(), "host-a:22".into());
            let (_control, mut receiver) = watch::channel(TransferControl::Running);
            let outcome = read_remote_exact_with_bandwidth(
                &mut reader,
                &mut buffer,
                &mut receiver,
                &mut gate,
            )
            .await
            .unwrap();
            (outcome, buffer)
        });
        tokio::task::yield_now().await;
        assert!(!read.is_finished());
        tokio::time::advance(Duration::from_millis(999)).await;
        tokio::task::yield_now().await;
        assert!(!read.is_finished());
        tokio::time::advance(Duration::from_millis(2)).await;
        tokio::task::yield_now().await;

        let (outcome, actual) = read.await.unwrap();
        assert!(matches!(outcome, LimitedRemoteReadOutcome::Complete));
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn high_bandwidth_limit_uses_a_multi_chunk_burst() {
        tokio::time::pause();
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: SftpTransferPolicy::MAX_LIMIT_BYTES_PER_SECOND,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let started_at = tokio::time::Instant::now();
        let (_control, mut receiver) = watch::channel(TransferControl::Running);
        for _ in 0..256 {
            let permit = match scheduler
                .acquire_bandwidth(BandwidthDirection::Upload, 64 * 1024, &mut receiver)
                .await
                .unwrap()
            {
                BandwidthWaitOutcome::Ready(permit) => permit,
                outcome => panic!("expected a high-rate permit, got {outcome:?}"),
            };
            assert_eq!(permit.bytes(), 64 * 1024);
            permit.commit(64 * 1024).unwrap();
        }
        assert_eq!(tokio::time::Instant::now(), started_at);
    }

    #[tokio::test]
    async fn dropped_admission_and_bandwidth_waiters_do_not_block_successors() {
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 1,
                per_host_concurrency: 1,
                upload_limit_bytes_per_second: 1024,
                ..SftpTransferPolicy::default()
            })
            .unwrap();

        let (_active_control, mut active_receiver) = watch::channel(TransferControl::Running);
        let active = scheduler
            .acquire_admission(Uuid::new_v4(), "host-a:22", &mut active_receiver)
            .await
            .unwrap()
            .unwrap();
        let (_abandoned_control, mut abandoned_receiver) = watch::channel(TransferControl::Running);
        let mut abandoned = Box::pin(scheduler.acquire_admission(
            Uuid::new_v4(),
            "host-a:22",
            &mut abandoned_receiver,
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut abandoned)
                .await
                .is_err()
        );
        drop(abandoned);
        drop(active);

        let (_successor_control, mut successor_receiver) = watch::channel(TransferControl::Running);
        let successor = tokio::time::timeout(
            Duration::from_millis(100),
            scheduler.acquire_admission(Uuid::new_v4(), "host-a:22", &mut successor_receiver),
        )
        .await
        .expect("dropped admission waiter must be removed")
        .unwrap()
        .unwrap();
        drop(successor);

        let (_initial_control, mut initial_receiver) = watch::channel(TransferControl::Running);
        let initial = match scheduler
            .acquire_bandwidth(BandwidthDirection::Upload, 1024, &mut initial_receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected the initial upload permit, got {outcome:?}"),
        };
        initial.commit(1024).unwrap();
        let (_abandoned_control, mut abandoned_receiver) = watch::channel(TransferControl::Running);
        let mut abandoned = Box::pin(scheduler.acquire_bandwidth(
            BandwidthDirection::Upload,
            1024,
            &mut abandoned_receiver,
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut abandoned)
                .await
                .is_err()
        );
        drop(abandoned);
        scheduler
            .set_policy(SftpTransferPolicy {
                global_concurrency: 1,
                per_host_concurrency: 1,
                upload_limit_bytes_per_second: 0,
                ..SftpTransferPolicy::default()
            })
            .unwrap();

        let (_successor_control, mut successor_receiver) = watch::channel(TransferControl::Running);
        let successor = tokio::time::timeout(
            Duration::from_millis(100),
            scheduler.acquire_bandwidth(BandwidthDirection::Upload, 1024, &mut successor_receiver),
        )
        .await
        .expect("dropped bandwidth ticket must be removed")
        .unwrap();
        let BandwidthWaitOutcome::Ready(successor) = successor else {
            panic!("expected the successor bandwidth permit");
        };
        successor.commit(1024).unwrap();
    }

    #[tokio::test]
    async fn nonzero_bandwidth_policy_changes_preserve_earned_tokens() {
        tokio::time::pause();
        let scheduler = TransferScheduler::default();
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: 1024,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        let (_initial_control, mut initial_receiver) = watch::channel(TransferControl::Running);
        let initial = match scheduler
            .acquire_bandwidth(BandwidthDirection::Upload, 1024, &mut initial_receiver)
            .await
            .unwrap()
        {
            BandwidthWaitOutcome::Ready(permit) => permit,
            outcome => panic!("expected the initial upload permit, got {outcome:?}"),
        };
        initial.commit(1024).unwrap();

        let wait_scheduler = scheduler.clone();
        let (_control, mut receiver) = watch::channel(TransferControl::Running);
        let waiting = tokio::spawn(async move {
            wait_scheduler
                .acquire_bandwidth(BandwidthDirection::Upload, 1024, &mut receiver)
                .await
                .unwrap()
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(400)).await;
        scheduler
            .set_policy(SftpTransferPolicy {
                upload_limit_bytes_per_second: 2048,
                ..SftpTransferPolicy::default()
            })
            .unwrap();
        tokio::time::advance(Duration::from_millis(299)).await;
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        tokio::time::advance(Duration::from_millis(2)).await;
        tokio::task::yield_now().await;
        assert!(waiting.is_finished());
        let BandwidthWaitOutcome::Ready(waiting) = waiting.await.unwrap() else {
            panic!("expected the adjusted bandwidth permit");
        };
        waiting.commit(1024).unwrap();
    }

    #[tokio::test]
    async fn manager_updates_paused_transfer_snapshot() {
        let manager = SftpManager::new();
        let transfer_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        let context = TerminalTransferContext {
            transfer_id,
            connection_id,
            endpoint: "files.example.com:22".into(),
            submission_sequence: 0,
            direction: TransferDirection::Upload,
            local_path: PathBuf::from("C:/tmp/archive.tar"),
            remote_path: "/tmp/archive.tar".into(),
            total_bytes: 2_048,
        };
        let (control, _control_receiver) = watch::channel(TransferControl::Running);
        let worker_finished = Arc::new(AtomicBool::new(false));
        manager.inner.transfers.lock().await.insert(
            transfer_id,
            ManagedTransfer {
                connection_id,
                control,
                worker_finished: Arc::clone(&worker_finished),
                snapshot: Arc::new(StdMutex::new(context.event(
                    TransferStatus::Running,
                    512,
                    Some(42),
                    None,
                ))),
            },
        );

        let paused = manager.pause_transfer(transfer_id).await.unwrap();
        assert_eq!(paused.status, TransferStatus::Paused);
        assert_eq!(paused.speed_bytes_per_second, Some(0));
        assert_eq!(paused.queue_position, None);
        assert_eq!(
            paused.waiting_reason,
            Some(TransferWaitingReason::UserPaused)
        );
        let resumed = manager.resume_transfer(transfer_id).await.unwrap();
        assert_eq!(resumed.status, TransferStatus::Queued);
        assert_eq!(resumed.speed_bytes_per_second, None);
        assert_eq!(resumed.queue_position, None);
        assert_eq!(resumed.waiting_reason, None);
        assert_eq!(
            manager.cancel_transfer(transfer_id).await.unwrap().status,
            TransferStatus::Cancelling
        );
        assert!(manager.remove_transfer(transfer_id).await.is_err());
        worker_finished.store(true, Ordering::Release);
        assert!(manager.remove_transfer(transfer_id).await.is_ok());
    }

    #[test]
    fn manager_rejects_overlapping_local_transfer_artifacts_and_path_aliases() {
        let manager = SftpManager::new();
        let directory = std::env::temp_dir().join("xsh-sftp-lease-tests");
        let path = directory.join("archive.tar");
        let destination = TransferDestination::local(&path);

        let local_lease = manager.reserve_destination(destination.clone()).unwrap();
        assert!(manager.reserve_destination(destination.clone()).is_err());
        assert!(
            manager
                .reserve_destination(TransferDestination::local(&download_temporary_path(&path)))
                .is_err()
        );
        assert!(
            manager
                .reserve_destination(TransferDestination::local(&download_metadata_path(&path)))
                .is_err()
        );
        assert!(
            manager
                .reserve_destination(TransferDestination::local(&PathBuf::from(format!(
                    "{}.tmp",
                    download_metadata_path(&path).to_string_lossy()
                ))))
                .is_err()
        );
        assert!(
            manager
                .reserve_destination(TransferDestination::local(
                    &directory.join("unused").join("..").join("archive.tar")
                ))
                .is_err()
        );

        drop(local_lease);
        let _replacement_lease = manager.reserve_destination(destination).unwrap();
    }

    #[test]
    fn manager_rejects_overlapping_remote_transfer_artifacts_and_path_aliases() {
        let manager = SftpManager::new();
        let source_identity = "files.example.com:22:SHA256:key";

        let remote = TransferDestination::remote(source_identity.into(), "/tmp/archive.tar".into());
        let _remote_lease = manager.reserve_destination(remote.clone()).unwrap();
        assert!(manager.reserve_destination(remote).is_err());
        assert!(
            manager
                .reserve_destination(TransferDestination::remote(
                    source_identity.into(),
                    "/tmp/archive.tar.xsh-part".into(),
                ))
                .is_err()
        );
        assert!(
            manager
                .reserve_destination(TransferDestination::remote(
                    source_identity.into(),
                    "/tmp/archive.tar.xsh-part.meta".into(),
                ))
                .is_err()
        );
        assert!(
            manager
                .reserve_destination(TransferDestination::remote(
                    source_identity.into(),
                    "/tmp/archive.tar.xsh-part.meta.tmp".into(),
                ))
                .is_err()
        );
        for artifact in [
            "/tmp/archive.tar.xsh-replace-backup",
            "/tmp/archive.tar.xsh-replace-journal",
            "/tmp/archive.tar.xsh-replace-journal.tmp",
            "/tmp/archive.tar.xsh-replace-installed",
            "/tmp/archive.tar.xsh-replace-installed.tmp",
        ] {
            assert!(
                manager
                    .reserve_destination(TransferDestination::remote(
                        source_identity.into(),
                        artifact.into(),
                    ))
                    .is_err()
            );
        }
        assert!(
            manager
                .reserve_destination(TransferDestination::remote(
                    source_identity.into(),
                    "/tmp/unused/../archive.tar".into(),
                ))
                .is_err()
        );
        let _other_remote_lease = manager
            .reserve_destination(TransferDestination::remote(
                "other.example.com:22:SHA256:key".into(),
                "/tmp/archive.tar".into(),
            ))
            .unwrap();
    }

    #[test]
    fn remote_mutations_and_transfer_artifacts_share_the_same_lease_space() {
        let manager = SftpManager::new();
        let source_identity = "files.example.com:22:SHA256:key";
        let destination = "/tmp/archive.tar".to_owned();
        let journal = "/tmp/archive.tar.xsh-replace-journal".to_owned();
        let parent = "/tmp".to_owned();
        let unrelated = "/var/tmp/other.tar".to_owned();
        let transfer = manager
            .reserve_destination(TransferDestination::remote(
                source_identity.into(),
                destination.clone(),
            ))
            .unwrap();

        assert!(
            manager
                .reserve_remote_mutation(source_identity, [&destination], false)
                .is_err()
        );
        assert!(
            manager
                .reserve_remote_mutation(source_identity, [&journal], false)
                .is_err()
        );
        assert!(
            manager
                .reserve_remote_mutation(source_identity, [&parent], true)
                .is_err()
        );
        let unrelated_mutation = manager
            .reserve_remote_mutation(source_identity, [&unrelated], true)
            .unwrap();

        drop(unrelated_mutation);
        drop(transfer);
        let mutation = manager
            .reserve_remote_mutation(source_identity, [&destination], false)
            .unwrap();
        assert!(
            manager
                .reserve_destination(TransferDestination::remote(
                    source_identity.into(),
                    destination,
                ))
                .is_err()
        );
        let _other_source = manager
            .reserve_destination(TransferDestination::remote(
                "other.example.com:22:SHA256:key".into(),
                "/tmp/archive.tar".into(),
            ))
            .unwrap();
        drop(mutation);
    }

    #[tokio::test]
    async fn completed_download_replaces_existing_file_without_deleting_first() {
        let directory = std::env::temp_dir().join(format!("xsh-sftp-finalize-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let destination = directory.join("archive.tar");
        let temporary = download_temporary_path(&destination);
        let metadata = download_metadata_path(&destination);
        tokio::fs::write(&destination, b"old contents")
            .await
            .unwrap();
        tokio::fs::write(&temporary, b"new contents").await.unwrap();
        tokio::fs::write(&metadata, b"metadata").await.unwrap();

        finalize_download(&temporary, &metadata, &destination, true)
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read(&destination).await.unwrap(),
            b"new contents"
        );
        assert!(!tokio::fs::try_exists(&temporary).await.unwrap());
        assert!(!tokio::fs::try_exists(&metadata).await.unwrap());
        let mut entries = tokio::fs::read_dir(&directory).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        assert_eq!(names, vec!["archive.tar"]);

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn completed_download_never_replaces_a_directory() {
        let directory = std::env::temp_dir().join(format!("xsh-sftp-finalize-{}", Uuid::new_v4()));
        let destination = directory.join("existing-directory");
        tokio::fs::create_dir_all(&destination).await.unwrap();
        let temporary = download_temporary_path(&destination);
        let metadata = download_metadata_path(&destination);
        tokio::fs::write(&temporary, b"new contents").await.unwrap();
        tokio::fs::write(&metadata, b"metadata").await.unwrap();

        assert!(
            finalize_download(&temporary, &metadata, &destination, true)
                .await
                .is_err()
        );
        assert!(tokio::fs::metadata(&destination).await.unwrap().is_dir());
        assert!(tokio::fs::try_exists(&temporary).await.unwrap());

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn no_overwrite_install_is_atomic_against_a_concurrent_destination() {
        let directory =
            std::env::temp_dir().join(format!("xsh-sftp-no-clobber-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let destination = directory.join("archive.tar");
        let temporary = download_temporary_path(&destination);
        tokio::fs::write(&temporary, b"downloaded contents")
            .await
            .unwrap();
        tokio::fs::write(&destination, b"concurrent contents")
            .await
            .unwrap();

        assert!(
            install_local_file_without_overwrite(&temporary, &destination)
                .await
                .is_err()
        );
        assert_eq!(
            tokio::fs::read(&destination).await.unwrap(),
            b"concurrent contents"
        );
        assert_eq!(
            tokio::fs::read(&temporary).await.unwrap(),
            b"downloaded contents"
        );

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[test]
    fn upload_resume_metadata_round_trips_and_validates_checkpoint() {
        let source = std::env::temp_dir().join(format!("xsh-sftp-upload-test-{}", Uuid::new_v4()));
        std::fs::write(&source, b"partial upload contents").expect("create upload fixture");
        let file_metadata = std::fs::metadata(&source).expect("stat upload fixture");
        let expected = make_upload_resume_metadata(&source, "/tmp/archive.tar", &file_metadata);
        let encoded = serde_json::to_vec(&expected).expect("encode upload metadata");
        let decoded: UploadResumeMetadata =
            serde_json::from_slice(&encoded).expect("decode upload metadata");

        assert_eq!(decoded, expected);
        assert!(can_resume_upload(&decoded, &expected, 0));
        assert!(can_resume_upload(&decoded, &expected, expected.total_bytes));
        let mut equivalent_alias = decoded.clone();
        equivalent_alias.remote_path = "/tmp/staging/../archive.tar".into();
        assert!(can_resume_upload(
            &equivalent_alias,
            &expected,
            expected.total_bytes
        ));
        assert_eq!(expected.remote_path, "/tmp/archive.tar");
        assert!(!can_resume_upload(
            &decoded,
            &expected,
            expected.total_bytes + 1
        ));

        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn changed_upload_source_or_destination_cannot_resume() {
        let source = std::env::temp_dir().join(format!("xsh-sftp-upload-test-{}", Uuid::new_v4()));
        std::fs::write(&source, b"upload contents").expect("create upload fixture");
        let file_metadata = std::fs::metadata(&source).expect("stat upload fixture");
        let expected = make_upload_resume_metadata(&source, "/tmp/archive.tar", &file_metadata);

        let mut changed_source = expected.clone();
        changed_source.local_path.push_str(".renamed");
        assert!(!can_resume_upload(&changed_source, &expected, 4));

        let mut changed_destination = expected.clone();
        changed_destination.remote_path = "/tmp/other.tar".into();
        assert!(!can_resume_upload(&changed_destination, &expected, 4));

        let mut changed_size = expected.clone();
        changed_size.total_bytes += 1;
        assert!(!can_resume_upload(&changed_size, &expected, 4));

        let _ = std::fs::remove_file(source);
    }

    #[test]
    fn upload_checkpoint_paths_are_stable_and_separate() {
        let temporary = upload_temporary_path("/var/tmp/archive.tar");
        let metadata = upload_metadata_path("/var/tmp/archive.tar");
        assert_eq!(temporary, "/var/tmp/archive.tar.xsh-part");
        assert_eq!(metadata, "/var/tmp/archive.tar.xsh-part.meta");
        assert_ne!(temporary, metadata);
    }

    #[test]
    fn directories_sort_before_files() {
        assert!(entry_rank(&RemoteFileType::Directory) < entry_rank(&RemoteFileType::File));
    }

    #[test]
    fn matching_partial_download_can_resume() {
        let metadata = resume_metadata("/logs/archive.tar", 2_048);
        assert!(can_resume_download(&metadata, &metadata, 1_024));
        assert!(can_resume_download(&metadata, &metadata, 2_048));
    }

    #[test]
    fn changed_remote_file_cannot_resume() {
        let expected = resume_metadata("/logs/archive.tar", 2_048);

        let mut changed_path = expected.clone();
        changed_path.remote_path = "/logs/other.tar".into();
        assert!(!can_resume_download(&changed_path, &expected, 1_024));

        let mut changed_size = expected.clone();
        changed_size.total_bytes = 4_096;
        assert!(!can_resume_download(&changed_size, &expected, 1_024));

        let mut changed_time = expected.clone();
        changed_time.modified_at_unix = Some(1_800_000_000);
        assert!(!can_resume_download(&changed_time, &expected, 1_024));

        let mut changed_source = expected.clone();
        changed_source.source_identity = "other.example.com:22:SHA256:other".into();
        assert!(!can_resume_download(&changed_source, &expected, 1_024));
    }

    #[tokio::test]
    async fn unrecognized_download_checkpoint_is_preserved() {
        let directory =
            std::env::temp_dir().join(format!("xsh-sftp-checkpoint-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let destination = directory.join("archive.tar");
        let temporary = download_temporary_path(&destination);
        let metadata = download_metadata_path(&destination);
        tokio::fs::write(&temporary, b"user partial file")
            .await
            .unwrap();
        tokio::fs::write(&metadata, b"not xsh metadata")
            .await
            .unwrap();

        assert!(
            resumable_partial_bytes(
                &temporary,
                &metadata,
                &resume_metadata("/logs/archive.tar", 2_048),
            )
            .await
            .is_err()
        );
        assert_eq!(
            tokio::fs::read(&temporary).await.unwrap(),
            b"user partial file"
        );
        assert_eq!(
            tokio::fs::read(&metadata).await.unwrap(),
            b"not xsh metadata"
        );

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn download_partial_without_metadata_is_preserved() {
        let directory =
            std::env::temp_dir().join(format!("xsh-sftp-checkpoint-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let destination = directory.join("archive.tar");
        let temporary = download_temporary_path(&destination);
        let metadata = download_metadata_path(&destination);
        tokio::fs::write(&temporary, b"user partial file")
            .await
            .unwrap();

        assert!(
            resumable_partial_bytes(
                &temporary,
                &metadata,
                &resume_metadata("/logs/archive.tar", 2_048),
            )
            .await
            .is_err()
        );
        assert_eq!(
            tokio::fs::read(&temporary).await.unwrap(),
            b"user partial file"
        );

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn download_metadata_temporary_collision_is_preserved() {
        let directory =
            std::env::temp_dir().join(format!("xsh-sftp-checkpoint-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let metadata = directory.join("archive.tar.xsh-part.meta");
        let temporary_metadata = PathBuf::from(format!("{}.tmp", metadata.to_string_lossy()));
        tokio::fs::write(&temporary_metadata, b"user temporary file")
            .await
            .unwrap();

        assert!(
            write_download_resume_metadata(
                &metadata,
                &resume_metadata("/logs/archive.tar", 2_048),
            )
            .await
            .is_err()
        );
        assert_eq!(
            tokio::fs::read(&temporary_metadata).await.unwrap(),
            b"user temporary file"
        );
        assert!(!tokio::fs::try_exists(&metadata).await.unwrap());

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn matching_download_metadata_temporary_file_is_recovered() {
        let directory =
            std::env::temp_dir().join(format!("xsh-sftp-checkpoint-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let metadata_path = directory.join("archive.tar.xsh-part.meta");
        let temporary_metadata = PathBuf::from(format!("{}.tmp", metadata_path.to_string_lossy()));
        let metadata = resume_metadata("/logs/archive.tar", 2_048);
        tokio::fs::write(&temporary_metadata, serde_json::to_vec(&metadata).unwrap())
            .await
            .unwrap();

        write_download_resume_metadata(&metadata_path, &metadata)
            .await
            .unwrap();

        assert!(!tokio::fs::try_exists(&temporary_metadata).await.unwrap());
        assert_eq!(
            serde_json::from_slice::<DownloadResumeMetadata>(
                &tokio::fs::read(&metadata_path).await.unwrap()
            )
            .unwrap(),
            metadata
        );

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[test]
    fn download_resume_samples_cover_the_start_and_tail() {
        assert_eq!(resume_sample_offsets(0), Vec::<u64>::new());
        assert_eq!(resume_sample_offsets(512), vec![0]);
        assert_eq!(
            resume_sample_offsets(RESUME_VERIFICATION_BLOCK_BYTES + 512),
            vec![0, 512]
        );
    }

    #[test]
    fn oversized_partial_download_cannot_resume() {
        let metadata = resume_metadata("/logs/archive.tar", 2_048);
        assert!(!can_resume_download(&metadata, &metadata, 2_049));
    }

    #[tokio::test]
    async fn missing_connection_is_reported() {
        let manager = SftpManager::new();
        let result = manager.list_directory(Uuid::new_v4(), "/".into()).await;
        assert!(matches!(
            result,
            Err(SftpManagerError::ConnectionNotFound(_))
        ));
    }
}
