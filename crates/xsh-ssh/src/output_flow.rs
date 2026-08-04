use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::Semaphore;

/// Maximum terminal output that may be in transit between SSH and xterm
/// without an acknowledgement from the renderer.
pub const TERMINAL_OUTPUT_WINDOW_BYTES: usize = 2 * 1024 * 1024;

/// Keep individual IPC messages small enough to serialize and dispatch
/// without monopolizing the renderer thread.
pub const TERMINAL_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct TerminalOutputFlow {
    available: Arc<Semaphore>,
    state: Mutex<FlowState>,
    window_bytes: usize,
}

#[derive(Debug, Default)]
struct FlowState {
    reserved_bytes: u64,
    acknowledged_bytes: u64,
    outstanding_bytes: usize,
}

impl TerminalOutputFlow {
    pub fn new(window_bytes: usize) -> Self {
        assert!(window_bytes > 0 && window_bytes <= u32::MAX as usize);
        Self {
            available: Arc::new(Semaphore::new(window_bytes)),
            state: Mutex::new(FlowState::default()),
            window_bytes,
        }
    }

    /// Reserves bytes until the renderer acknowledges previously written
    /// output. Returns false after the connection has been closed.
    pub async fn reserve(&self, bytes: usize) -> bool {
        if bytes == 0 {
            return true;
        }
        assert!(bytes <= self.window_bytes);
        let Ok(permits) = Arc::clone(&self.available)
            .acquire_many_owned(bytes as u32)
            .await
        else {
            return false;
        };
        if self.available.is_closed() {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        state.reserved_bytes = state
            .reserved_bytes
            .checked_add(bytes as u64)
            .expect("terminal output byte counter overflowed");
        state.outstanding_bytes += bytes;
        permits.forget();
        true
    }

    /// Advances the renderer's cumulative consumed-byte counter and returns
    /// credit for only the newly acknowledged range. Repeating an ACK is
    /// idempotent, and values beyond produced output are clamped.
    pub fn acknowledge(&self, consumed_bytes: u64) -> usize {
        let acknowledged = {
            let mut state = self.state.lock().unwrap();
            let consumed_bytes = consumed_bytes.min(state.reserved_bytes);
            if consumed_bytes <= state.acknowledged_bytes {
                return 0;
            }
            let acknowledged = (consumed_bytes - state.acknowledged_bytes) as usize;
            debug_assert!(acknowledged <= state.outstanding_bytes);
            state.acknowledged_bytes = consumed_bytes;
            state.outstanding_bytes -= acknowledged;
            acknowledged
        };
        self.available.add_permits(acknowledged);
        acknowledged
    }

    pub fn close(&self) {
        self.available.close();
    }

    pub fn is_closed(&self) -> bool {
        self.available.is_closed()
    }

    #[cfg(test)]
    fn outstanding_bytes(&self) -> usize {
        self.state.lock().unwrap().outstanding_bytes
    }
}

impl Default for TerminalOutputFlow {
    fn default() -> Self {
        Self::new(TERMINAL_OUTPUT_WINDOW_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn acknowledgement_releases_exactly_the_consumed_credit() {
        let flow = Arc::new(TerminalOutputFlow::new(4));
        assert!(flow.reserve(4).await);
        assert_eq!(flow.outstanding_bytes(), 4);

        let waiting = {
            let flow = Arc::clone(&flow);
            tokio::spawn(async move { flow.reserve(2).await })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());

        assert_eq!(flow.acknowledge(2), 2);
        assert!(
            timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap()
        );
        assert_eq!(flow.outstanding_bytes(), 4);
    }

    #[tokio::test]
    async fn duplicate_acknowledgements_cannot_expand_the_window() {
        let flow = Arc::new(TerminalOutputFlow::new(4));
        assert!(flow.reserve(3).await);
        assert_eq!(flow.acknowledge(3), 3);
        assert_eq!(flow.acknowledge(3), 0);

        assert!(flow.reserve(4).await);
        assert_eq!(flow.outstanding_bytes(), 4);
        assert_eq!(flow.acknowledge(3), 0);

        let waiting = {
            let flow = Arc::clone(&flow);
            tokio::spawn(async move { flow.reserve(1).await })
        };
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        assert_eq!(flow.acknowledge(7), 4);
        assert!(
            timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap()
        );
    }

    #[tokio::test]
    async fn closing_the_flow_wakes_a_blocked_producer() {
        let flow = Arc::new(TerminalOutputFlow::new(1));
        assert!(flow.reserve(1).await);
        let waiting = {
            let flow = Arc::clone(&flow);
            tokio::spawn(async move { flow.reserve(1).await })
        };
        tokio::task::yield_now().await;

        flow.close();
        assert!(
            !timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap()
        );
    }
}
