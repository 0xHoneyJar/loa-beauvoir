/**
 * Tests for AsyncMutex: concurrent access, FIFO ordering, timeouts, lease auto-release.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncMutex, MutexTimeoutError } from "../async-mutex";

describe("AsyncMutex", () => {
  let mutex: AsyncMutex;
  let mockNow: ReturnType<typeof vi.fn>;
  let currentTime: number;

  beforeEach(() => {
    currentTime = 1000;
    mockNow = vi.fn(() => currentTime);
    mutex = new AsyncMutex(30000, 60000, mockNow);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("basic acquire and release", () => {
    it("should acquire lock immediately when unlocked", async () => {
      await mutex.acquire();
      expect(mutex.isHeld()).toBe(true);
    });

    it("should release lock correctly", async () => {
      await mutex.acquire();
      mutex.release();
      expect(mutex.isHeld()).toBe(false);
    });

    it("should not deadlock on release without acquire", () => {
      expect(() => mutex.release()).not.toThrow();
      expect(mutex.isHeld()).toBe(false);
    });

    it("should handle multiple releases gracefully", async () => {
      await mutex.acquire();
      mutex.release();
      mutex.release();
      mutex.release();
      expect(mutex.isHeld()).toBe(false);
    });
  });

  describe("concurrent access and FIFO ordering", () => {
    it("should serialize concurrent acquire calls", async () => {
      vi.useFakeTimers();
      const order: number[] = [];

      const worker = async (id: number, delayMs: number) => {
        await mutex.acquire();
        order.push(id);
        await vi.advanceTimersByTimeAsync(delayMs);
        mutex.release();
      };

      const p1 = worker(1, 100);
      await vi.advanceTimersByTimeAsync(10);
      const p2 = worker(2, 100);
      await vi.advanceTimersByTimeAsync(10);
      const p3 = worker(3, 100);

      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([1, 2, 3]);
    });

    it("should maintain FIFO order under contention", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const order: number[] = [];
      const waiters = [1, 2, 3, 4, 5].map((id) =>
        mutex.acquire().then(() => {
          order.push(id);
          mutex.release();
        }),
      );

      await vi.advanceTimersByTimeAsync(10);
      mutex.release();

      await vi.advanceTimersByTimeAsync(100);
      await Promise.all(waiters);

      expect(order).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe("timeout handling", () => {
    it("should reject with MutexTimeoutError after timeout", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const promise = mutex.acquire(1000).catch((err) => err);
      await vi.advanceTimersByTimeAsync(1001);

      const result = await promise;
      expect(result).toBeInstanceOf(MutexTimeoutError);
      expect(result.message).toBe("Mutex acquire timeout after 1000ms");
    });

    it("should use default timeout when not specified", async () => {
      vi.useFakeTimers();
      const shortMutex = new AsyncMutex(500, 60000, mockNow);
      await shortMutex.acquire();

      const promise = shortMutex.acquire().catch((err) => err);
      await vi.advanceTimersByTimeAsync(501);

      const result = await promise;
      expect(result).toBeInstanceOf(MutexTimeoutError);
      expect(result.message).toContain("after 500ms");
    });

    it("should not grant lock to timed-out waiter", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const p1 = mutex.acquire(500).catch(() => {
        /* expected timeout */
      });
      const p2 = mutex.acquire(5000);

      await vi.advanceTimersByTimeAsync(501);
      await p1;

      mutex.release();
      await vi.advanceTimersByTimeAsync(10);
      await expect(p2).resolves.toBeUndefined();

      expect(mutex.isHeld()).toBe(true);
      mutex.release();
    });

    it("should remove timed-out waiter from queue", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const order: number[] = [];
      const p1 = mutex.acquire(100).catch(() => {
        /* timed out */
      });
      const p2 = mutex.acquire(5000).then(() => {
        order.push(2);
        mutex.release();
      });
      const p3 = mutex.acquire(5000).then(() => {
        order.push(3);
        mutex.release();
      });

      await vi.advanceTimersByTimeAsync(101);
      mutex.release();

      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([2, 3]);
    });
  });

  describe("lease auto-release", () => {
    it("should auto-release lock after maxHoldMs", async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const shortLeaseMutex = new AsyncMutex(30000, 1000, mockNow);

      await shortLeaseMutex.acquire();
      expect(shortLeaseMutex.isHeld()).toBe(true);

      await vi.advanceTimersByTimeAsync(1001);

      expect(shortLeaseMutex.isHeld()).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        "AsyncMutex: lease expired after 1000ms, auto-releasing",
      );

      consoleSpy.mockRestore();
    });

    it("should grant lock to next waiter after lease expires", async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const shortLeaseMutex = new AsyncMutex(30000, 500, mockNow);

      await shortLeaseMutex.acquire();

      const acquired = vi.fn();
      const waiter = shortLeaseMutex.acquire().then(() => {
        acquired();
        expect(shortLeaseMutex.isHeld()).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(501);
      await vi.advanceTimersByTimeAsync(10);

      await waiter;
      expect(acquired).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("should not auto-release if released before lease expires", async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const shortLeaseMutex = new AsyncMutex(30000, 1000, mockNow);

      await shortLeaseMutex.acquire();
      await vi.advanceTimersByTimeAsync(500);
      shortLeaseMutex.release();

      await vi.advanceTimersByTimeAsync(600);

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("owner tracking", () => {
    it("should track isHeld correctly", async () => {
      expect(mutex.isHeld()).toBe(false);
      await mutex.acquire();
      expect(mutex.isHeld()).toBe(true);
      mutex.release();
      expect(mutex.isHeld()).toBe(false);
    });

    it("should track holdDuration correctly", async () => {
      expect(mutex.holdDuration()).toBe(0);

      await mutex.acquire();
      expect(mutex.holdDuration()).toBe(0);

      currentTime += 150;
      expect(mutex.holdDuration()).toBe(150);

      currentTime += 50;
      expect(mutex.holdDuration()).toBe(200);

      mutex.release();
      expect(mutex.holdDuration()).toBe(0);
    });

    it("should reset holdDuration after release and reacquire", async () => {
      await mutex.acquire();
      currentTime += 100;
      expect(mutex.holdDuration()).toBe(100);

      mutex.release();
      expect(mutex.holdDuration()).toBe(0);

      currentTime += 50;
      await mutex.acquire();
      expect(mutex.holdDuration()).toBe(0);

      currentTime += 25;
      expect(mutex.holdDuration()).toBe(25);
    });
  });

  describe("reentrant safety", () => {
    it("should not allow the same caller to reacquire without releasing", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const reentrant = mutex.acquire(100).catch((err) => err);
      await vi.advanceTimersByTimeAsync(101);

      const result = await reentrant;
      expect(result).toBeInstanceOf(MutexTimeoutError);
    });
  });

  describe("edge cases", () => {
    it("should handle immediate acquire after release", async () => {
      await mutex.acquire();
      mutex.release();
      await mutex.acquire();
      expect(mutex.isHeld()).toBe(true);
    });

    it("should handle zero timeout (immediate rejection when locked)", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const promise = mutex.acquire(0).catch((err) => err);
      await vi.advanceTimersByTimeAsync(1);

      const result = await promise;
      expect(result).toBeInstanceOf(MutexTimeoutError);
    });

    it("should clean up all timers on release", async () => {
      vi.useFakeTimers();
      await mutex.acquire();

      const p1 = mutex.acquire(5000).then(() => {
        mutex.release();
      });

      mutex.release();
      await vi.advanceTimersByTimeAsync(10);
      await p1;

      expect(mutex.isHeld()).toBe(false);
    });
  });
});
