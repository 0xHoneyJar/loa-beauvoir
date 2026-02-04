/**
 * Loop Detector Tests
 *
 * Unit tests for recovery loop detection logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLoopDetector, getLoopDetectorConfig } from '../state/loop-detector.js';

describe('LoopDetector', () => {
  beforeEach(() => {
    // Clear environment variables
    delete process.env.LOA_RECOVERY_WINDOW_MS;
    delete process.env.LOA_RECOVERY_MAX_ATTEMPTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createLoopDetector', () => {
    it('should not detect loop with no attempts', () => {
      const detector = createLoopDetector();

      expect(detector.isInLoop()).toBe(false);
      expect(detector.getAttemptCount()).toBe(0);
    });

    it('should not detect loop with single attempt', () => {
      const detector = createLoopDetector();

      detector.recordAttempt();

      expect(detector.isInLoop()).toBe(false);
      expect(detector.getAttemptCount()).toBe(1);
    });

    it('should detect loop when max attempts reached', () => {
      const detector = createLoopDetector();

      // Default max attempts is 5
      for (let i = 0; i < 5; i++) {
        detector.recordAttempt();
      }

      expect(detector.isInLoop()).toBe(true);
      expect(detector.getAttemptCount()).toBe(5);
    });

    it('should reset on reset() call', () => {
      const detector = createLoopDetector();

      for (let i = 0; i < 3; i++) {
        detector.recordAttempt();
      }

      expect(detector.getAttemptCount()).toBe(3);

      detector.reset();

      expect(detector.isInLoop()).toBe(false);
      expect(detector.getAttemptCount()).toBe(0);
    });
  });

  describe('getLoopDetectorConfig', () => {
    it('should return defaults when no env vars set', () => {
      const config = getLoopDetectorConfig();

      expect(config.windowMs).toBe(120000);
      expect(config.maxAttempts).toBe(5);
    });

    it('should read custom window from env var', () => {
      process.env.LOA_RECOVERY_WINDOW_MS = '60000';

      const config = getLoopDetectorConfig();

      expect(config.windowMs).toBe(60000);
    });

    it('should read custom max attempts from env var', () => {
      process.env.LOA_RECOVERY_MAX_ATTEMPTS = '3';

      const config = getLoopDetectorConfig();

      expect(config.maxAttempts).toBe(3);
    });

    it('should ignore invalid env values', () => {
      process.env.LOA_RECOVERY_WINDOW_MS = 'invalid';
      process.env.LOA_RECOVERY_MAX_ATTEMPTS = '-1';

      const config = getLoopDetectorConfig();

      expect(config.windowMs).toBe(120000);
      expect(config.maxAttempts).toBe(5);
    });
  });

  describe('window expiration', () => {
    it('should reset count when window expires', () => {
      vi.useFakeTimers();

      const detector = createLoopDetector();

      // Record 3 attempts
      for (let i = 0; i < 3; i++) {
        detector.recordAttempt();
      }

      expect(detector.getAttemptCount()).toBe(3);

      // Advance time past window (default 120s)
      vi.advanceTimersByTime(130000);

      // Count should reset to 0 (window expired)
      expect(detector.getAttemptCount()).toBe(0);
      expect(detector.isInLoop()).toBe(false);

      vi.useRealTimers();
    });
  });
});
