export type TerminalOutputAckSender = (consumedBytes: number) => Promise<void>;

export class CumulativeTerminalOutputAcknowledger {
  private consumedBytes = 0;
  private acknowledgedBytes = 0;
  private sender: TerminalOutputAckSender | null = null;
  private sendInFlight = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly retryDelayMs: number;

  constructor(retryDelayMs = 100) {
    this.retryDelayMs = retryDelayMs;
  }

  setSender(sender: TerminalOutputAckSender) {
    if (this.stopped) return;
    this.sender = sender;
    this.flush();
  }

  consume(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("terminal output acknowledgement must be a non-negative safe integer");
    }
    if (bytes === 0 || this.stopped) return;
    if (this.consumedBytes > Number.MAX_SAFE_INTEGER - bytes) {
      throw new RangeError("terminal output acknowledgement counter overflowed");
    }
    this.consumedBytes += bytes;
    this.flush();
  }

  stop() {
    this.stopped = true;
    this.sender = null;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private flush() {
    const sender = this.sender;
    if (
      this.stopped ||
      !sender ||
      this.sendInFlight ||
      this.retryTimer !== undefined ||
      this.acknowledgedBytes >= this.consumedBytes
    ) return;

    const target = this.consumedBytes;
    this.sendInFlight = true;
    void Promise.resolve()
      .then(() => sender(target))
      .then(() => {
        this.acknowledgedBytes = Math.max(this.acknowledgedBytes, target);
      })
      .catch(() => {
        if (this.stopped || this.retryTimer !== undefined) return;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.flush();
        }, this.retryDelayMs);
      })
      .finally(() => {
        this.sendInFlight = false;
        this.flush();
      });
  }
}
