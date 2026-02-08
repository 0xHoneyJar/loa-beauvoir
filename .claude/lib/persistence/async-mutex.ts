/**
 * Promise-chain mutex for serializing async operations.
 * Shared by audit trail and resilient store; no external dependencies.
 */

export class MutexTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutexTimeoutError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class AsyncMutex {
  private queue: Waiter[] = [];
  private locked = false;
  private acquiredAt = 0;
  private leaseTimer?: NodeJS.Timeout;
  private readonly warnFn: (msg: string) => void;

  constructor(
    private readonly timeoutMs = 30000,
    private readonly maxHoldMs = 60000,
    private readonly now: () => number = Date.now,
    warn?: (msg: string) => void,
  ) {
    this.warnFn = warn ?? ((msg: string) => console.warn(msg));
  }

  async acquire(timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this.timeoutMs;

    if (!this.locked) {
      this.locked = true;
      this.acquiredAt = this.now();
      this.startLeaseTimer();
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new MutexTimeoutError(`Mutex acquire timeout after ${timeout}ms`));
      }, timeout);
      timer.unref();

      this.queue.push({ resolve, reject, timer });
    });
  }

  release(): void {
    if (!this.locked) return;

    this.stopLeaseTimer();
    this.locked = false;
    this.acquiredAt = 0;

    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      this.locked = true;
      this.acquiredAt = this.now();
      this.startLeaseTimer();
      next.resolve();
    }
  }

  isHeld(): boolean {
    return this.locked;
  }

  holdDuration(): number {
    return this.locked ? this.now() - this.acquiredAt : 0;
  }

  private startLeaseTimer(): void {
    this.leaseTimer = setTimeout(() => {
      // Warn only — never auto-release, as it would break mutual exclusion
      // and corrupt crash-safe protocols (audit trail, resilient store).
      this.warnFn(
        `AsyncMutex: lock held for ${this.holdDuration()}ms (maxHoldMs=${this.maxHoldMs}ms). ` +
          `Not auto-releasing to preserve safety.`,
      );
      // Re-arm to continue surfacing the issue
      this.startLeaseTimer();
    }, this.maxHoldMs);
    this.leaseTimer.unref();
  }

  private stopLeaseTimer(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = undefined;
    }
  }
}
