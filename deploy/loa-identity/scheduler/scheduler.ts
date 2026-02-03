/**
 * Scheduler - Periodic tasks with jitter and circuit breakers
 *
 * Manages scheduled operations like:
 * - Memory consolidation (daily)
 * - R2 sync (every 30 seconds)
 * - Git sync (hourly)
 * - Health checks (every 5 minutes)
 *
 * Features:
 * - Jitter to prevent thundering herd
 * - Circuit breakers for failing operations
 * - Mutual exclusion for conflicting tasks
 *
 * @module deploy/loa-identity/scheduler/scheduler
 */

export type TaskStatus = 'idle' | 'running' | 'circuit_open' | 'disabled';

export interface ScheduledTask {
  id: string;
  name: string;
  intervalMs: number;
  jitterMs: number; // Random jitter range
  handler: () => Promise<void>;
  status: TaskStatus;
  lastRun: Date | null;
  lastSuccess: Date | null;
  consecutiveFailures: number;
  circuitBreaker: CircuitBreakerConfig;
  mutexGroup?: string; // Tasks in same group don't run concurrently
}

export interface CircuitBreakerConfig {
  maxFailures: number;
  resetTimeMs: number;
  halfOpenRetries: number;
}

export interface SchedulerConfig {
  defaultJitterPercent?: number; // Default: 10%
  defaultCircuitBreaker?: CircuitBreakerConfig;
}

const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  maxFailures: 3,
  resetTimeMs: 5 * 60 * 1000, // 5 minutes
  halfOpenRetries: 1,
};

/**
 * Scheduler manages periodic tasks with resilience features.
 */
export class Scheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private mutexLocks: Map<string, string> = new Map(); // group -> taskId
  private config: Required<SchedulerConfig>;
  private running = false;

  constructor(config?: SchedulerConfig) {
    this.config = {
      defaultJitterPercent: config?.defaultJitterPercent ?? 10,
      defaultCircuitBreaker: config?.defaultCircuitBreaker ?? DEFAULT_CIRCUIT_BREAKER,
    };
  }

  /**
   * Register a scheduled task
   */
  register(task: {
    id: string;
    name: string;
    intervalMs: number;
    jitterMs?: number;
    handler: () => Promise<void>;
    circuitBreaker?: Partial<CircuitBreakerConfig>;
    mutexGroup?: string;
  }): void {
    const jitterMs = task.jitterMs ?? Math.floor(task.intervalMs * this.config.defaultJitterPercent / 100);

    const scheduledTask: ScheduledTask = {
      id: task.id,
      name: task.name,
      intervalMs: task.intervalMs,
      jitterMs,
      handler: task.handler,
      status: 'idle',
      lastRun: null,
      lastSuccess: null,
      consecutiveFailures: 0,
      circuitBreaker: {
        ...this.config.defaultCircuitBreaker,
        ...task.circuitBreaker,
      },
      mutexGroup: task.mutexGroup,
    };

    this.tasks.set(task.id, scheduledTask);
    console.log(`[scheduler] Registered task: ${task.name} (${task.intervalMs}ms ±${jitterMs}ms)`);
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.running) return;

    this.running = true;

    for (const task of this.tasks.values()) {
      this.scheduleTask(task);
    }

    console.log(`[scheduler] Started with ${this.tasks.size} tasks`);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.running = false;

    for (const [taskId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }

    console.log('[scheduler] Stopped');
  }

  /**
   * Schedule a task's next run
   */
  private scheduleTask(task: ScheduledTask): void {
    if (!this.running) return;
    if (task.status === 'disabled') return;

    // Calculate delay with jitter
    const jitter = Math.floor(Math.random() * task.jitterMs * 2) - task.jitterMs;
    const delay = Math.max(1000, task.intervalMs + jitter);

    const timer = setTimeout(() => this.executeTask(task.id), delay);
    this.timers.set(task.id, timer);
  }

  /**
   * Execute a task
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || !this.running) return;

    // Check circuit breaker
    if (task.status === 'circuit_open') {
      const timeSinceLastRun = task.lastRun
        ? Date.now() - task.lastRun.getTime()
        : Infinity;

      if (timeSinceLastRun < task.circuitBreaker.resetTimeMs) {
        // Still in cooldown
        this.scheduleTask(task);
        return;
      }

      // Try half-open
      console.log(`[scheduler] Circuit half-open for ${task.name}`);
    }

    // Check mutex
    if (task.mutexGroup) {
      const lockHolder = this.mutexLocks.get(task.mutexGroup);
      if (lockHolder && lockHolder !== taskId) {
        // Another task in same group is running
        console.log(`[scheduler] ${task.name} waiting for mutex (held by ${lockHolder})`);
        this.scheduleTask(task);
        return;
      }

      this.mutexLocks.set(task.mutexGroup, taskId);
    }

    task.status = 'running';
    task.lastRun = new Date();

    try {
      await task.handler();

      // Success
      task.status = 'idle';
      task.lastSuccess = new Date();
      task.consecutiveFailures = 0;

      console.log(`[scheduler] ${task.name} completed successfully`);
    } catch (e) {
      // Failure
      task.consecutiveFailures++;

      if (task.consecutiveFailures >= task.circuitBreaker.maxFailures) {
        task.status = 'circuit_open';
        console.error(
          `[scheduler] Circuit OPEN for ${task.name} after ${task.consecutiveFailures} failures`
        );
      } else {
        task.status = 'idle';
        console.warn(
          `[scheduler] ${task.name} failed (${task.consecutiveFailures}/${task.circuitBreaker.maxFailures}): ${e}`
        );
      }
    } finally {
      // Release mutex
      if (task.mutexGroup) {
        this.mutexLocks.delete(task.mutexGroup);
      }

      // Schedule next run
      this.scheduleTask(task);
    }
  }

  /**
   * Manually trigger a task
   */
  async trigger(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Clear existing timer
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }

    await this.executeTask(taskId);
    return true;
  }

  /**
   * Disable a task
   */
  disable(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'disabled';

      const timer = this.timers.get(taskId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(taskId);
      }

      console.log(`[scheduler] Disabled task: ${task.name}`);
    }
  }

  /**
   * Enable a task
   */
  enable(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'idle';
      task.consecutiveFailures = 0;

      if (this.running) {
        this.scheduleTask(task);
      }

      console.log(`[scheduler] Enabled task: ${task.name}`);
    }
  }

  /**
   * Reset circuit breaker for a task
   */
  resetCircuitBreaker(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'idle';
      task.consecutiveFailures = 0;
      console.log(`[scheduler] Reset circuit breaker for: ${task.name}`);
    }
  }

  /**
   * Get status of all tasks
   */
  getStatus(): Array<{
    id: string;
    name: string;
    status: TaskStatus;
    lastRun: string | null;
    lastSuccess: string | null;
    consecutiveFailures: number;
    nextRunIn: number | null;
  }> {
    return Array.from(this.tasks.values()).map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      lastRun: task.lastRun?.toISOString() ?? null,
      lastSuccess: task.lastSuccess?.toISOString() ?? null,
      consecutiveFailures: task.consecutiveFailures,
      nextRunIn: this.timers.has(task.id)
        ? Math.max(0, task.intervalMs - (task.lastRun ? Date.now() - task.lastRun.getTime() : 0))
        : null,
    }));
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Create a scheduler with default Beauvoir tasks
 */
export function createBeauvoirScheduler(handlers: {
  consolidateMemory: () => Promise<void>;
  syncToR2: () => Promise<void>;
  syncToGit: () => Promise<void>;
  healthCheck: () => Promise<void>;
  rotateKeys?: () => Promise<void>;
}): Scheduler {
  const scheduler = new Scheduler();

  // R2 sync - every 30 seconds with ±5 second jitter
  scheduler.register({
    id: 'r2_sync',
    name: 'R2 Sync',
    intervalMs: 30 * 1000,
    jitterMs: 5 * 1000,
    handler: handlers.syncToR2,
    mutexGroup: 'sync',
  });

  // Git sync - every hour with ±5 minute jitter
  scheduler.register({
    id: 'git_sync',
    name: 'Git Sync',
    intervalMs: 60 * 60 * 1000,
    jitterMs: 5 * 60 * 1000,
    handler: handlers.syncToGit,
    mutexGroup: 'sync',
  });

  // Memory consolidation - daily with ±30 minute jitter
  scheduler.register({
    id: 'consolidate',
    name: 'Memory Consolidation',
    intervalMs: 24 * 60 * 60 * 1000,
    jitterMs: 30 * 60 * 1000,
    handler: handlers.consolidateMemory,
    mutexGroup: 'memory',
  });

  // Health check - every 5 minutes with ±30 second jitter
  scheduler.register({
    id: 'health_check',
    name: 'Health Check',
    intervalMs: 5 * 60 * 1000,
    jitterMs: 30 * 1000,
    handler: handlers.healthCheck,
  });

  // Key rotation check - weekly with ±1 hour jitter
  if (handlers.rotateKeys) {
    scheduler.register({
      id: 'key_rotation',
      name: 'Key Rotation Check',
      intervalMs: 7 * 24 * 60 * 60 * 1000,
      jitterMs: 60 * 60 * 1000,
      handler: handlers.rotateKeys,
    });
  }

  return scheduler;
}
