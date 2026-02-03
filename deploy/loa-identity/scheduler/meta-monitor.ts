/**
 * MetaSchedulerMonitor - Scheduler Health Monitoring (FR-9)
 *
 * Detects and recovers from scheduler stalls by monitoring heartbeat
 * files and auto-restarting when stalled beyond threshold.
 *
 * Supports two ownership modes:
 * - standalone: Manages scheduler process directly
 * - systemd_notify: Integrates with systemd watchdog
 *
 * @module deploy/loa-identity/scheduler/meta-monitor
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, appendFile, mkdir, stat } from 'fs/promises';
import * as path from 'path';
import {
  NotificationSink,
  createNotificationSinkFromEnv,
  NullNotificationSink,
} from './notification-sink';

const execAsync = promisify(exec);

// =============================================================================
// Security: Allowlisted Restart Commands (CRIT-002 remediation)
// =============================================================================

/**
 * Allowlist of safe restart commands.
 * Only these exact commands or their arguments can be executed.
 */
const ALLOWED_RESTART_COMMANDS = new Set([
  'systemctl restart loa-scheduler',
  'systemctl restart loa-scheduler.service',
  'supervisorctl restart loa-scheduler',
  'pm2 restart loa-scheduler',
  '/usr/local/bin/restart-loa-scheduler.sh',
]);

/**
 * Check if a restart command is in the allowlist.
 */
function isRestartCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_RESTART_COMMANDS.has(trimmed);
}

/**
 * Add a command to the runtime allowlist.
 * This should only be called during trusted initialization.
 */
export function allowRestartCommand(command: string): void {
  ALLOWED_RESTART_COMMANDS.add(command.trim());
}

// =============================================================================
// Interfaces
// =============================================================================

export type OwnershipMode = 'standalone' | 'systemd_notify';

export interface MetaMonitorConfig {
  /** Check interval in minutes (default: 15) */
  checkIntervalMinutes: number;
  /** Stall threshold in minutes (default: 30) */
  stallThresholdMinutes: number;
  /** Restart command (default: systemctl restart loa-scheduler) */
  restartCommand: string;
  /** Ownership mode (default: standalone) */
  ownershipMode: OwnershipMode;
  /** Grace period before SIGKILL in seconds (default: 30) */
  gracePeriodSeconds: number;
  /** Maximum restart attempts before alerting (default: 3) */
  maxRestartAttempts: number;
  /** Reset restart counter after this many minutes of stability (default: 60) */
  stableMinutesReset: number;
}

export interface SchedulerHealthStatus {
  healthy: boolean;
  stalledMinutes: number;
  action: string | null;
  lastHeartbeat: Date | null;
  restartAttempts: number;
}

export interface HeartbeatData {
  timestamp: string;
  pid?: number;
  taskCount?: number;
  memoryMB?: number;
}

export interface MonitorAuditEntry {
  timestamp: string;
  event:
    | 'check'
    | 'stall_detected'
    | 'restart_attempted'
    | 'restart_success'
    | 'restart_failed'
    | 'heartbeat_recorded'
    | 'systemd_notify';
  details: Record<string, unknown>;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: MetaMonitorConfig = {
  checkIntervalMinutes: 15,
  stallThresholdMinutes: 30,
  restartCommand: 'systemctl restart loa-scheduler',
  ownershipMode: 'standalone',
  gracePeriodSeconds: 30,
  maxRestartAttempts: 3,
  stableMinutesReset: 60,
};

// =============================================================================
// MetaSchedulerMonitor Class
// =============================================================================

export class MetaSchedulerMonitor {
  private config: MetaMonitorConfig;
  private heartbeatPath: string;
  private auditLogPath: string;
  private notesPath: string;
  private notificationSink: NotificationSink;
  private restartAttempts = 0;
  private lastRestartTime: Date | null = null;

  constructor(
    config?: Partial<MetaMonitorConfig>,
    options?: {
      heartbeatPath?: string;
      auditLogPath?: string;
      notesPath?: string;
      notificationSink?: NotificationSink;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.heartbeatPath = options?.heartbeatPath ?? '/workspace/.loa/scheduler-heartbeat';
    this.auditLogPath = options?.auditLogPath ?? '/workspace/.loa/meta-monitor.log';
    this.notesPath = options?.notesPath ?? '/workspace/grimoires/loa/NOTES.md';
    this.notificationSink = options?.notificationSink ?? new NullNotificationSink();
  }

  /**
   * Check scheduler health (called by external cron/systemd timer).
   */
  async check(): Promise<SchedulerHealthStatus> {
    const heartbeat = await this.readHeartbeat();

    // Reset restart counter if stable for configured period
    if (
      this.lastRestartTime &&
      this.restartAttempts > 0 &&
      Date.now() - this.lastRestartTime.getTime() > this.config.stableMinutesReset * 60 * 1000
    ) {
      this.restartAttempts = 0;
      this.lastRestartTime = null;
    }

    // No heartbeat file
    if (!heartbeat) {
      await this.logAudit({
        timestamp: new Date().toISOString(),
        event: 'check',
        details: { status: 'no_heartbeat' },
      });

      await this.notificationSink.notify(
        'warning',
        'No scheduler heartbeat file found - scheduler may never have started',
        { heartbeatPath: this.heartbeatPath }
      );

      return {
        healthy: false,
        stalledMinutes: Infinity,
        action: 'No heartbeat file found - scheduler may never have started',
        lastHeartbeat: null,
        restartAttempts: this.restartAttempts,
      };
    }

    const heartbeatTime = new Date(heartbeat.timestamp);
    const stalledMinutes = (Date.now() - heartbeatTime.getTime()) / (1000 * 60);

    // Check if stalled
    if (stalledMinutes > this.config.stallThresholdMinutes) {
      await this.logAudit({
        timestamp: new Date().toISOString(),
        event: 'stall_detected',
        details: {
          lastHeartbeat: heartbeat.timestamp,
          stalledMinutes: Math.round(stalledMinutes),
          pid: heartbeat.pid,
        },
      });

      await this.notificationSink.notify(
        'warning',
        `Scheduler stalled for ${Math.round(stalledMinutes)} minutes`,
        {
          stalledMinutes: Math.round(stalledMinutes),
          lastHeartbeat: heartbeat.timestamp,
          threshold: this.config.stallThresholdMinutes,
        }
      );

      // Check restart attempt limit
      if (this.restartAttempts >= this.config.maxRestartAttempts) {
        await this.notificationSink.notify(
          'critical',
          `Scheduler restart attempts exhausted (${this.restartAttempts}/${this.config.maxRestartAttempts}) - manual intervention required`,
          { restartAttempts: this.restartAttempts }
        );

        await this.writeToNotes(
          `[META-MONITOR] CRITICAL: Restart attempts exhausted (${this.restartAttempts}) - MANUAL INTERVENTION REQUIRED`
        );

        return {
          healthy: false,
          stalledMinutes,
          action: `Restart attempts exhausted (${this.restartAttempts}/${this.config.maxRestartAttempts}) - manual intervention required`,
          lastHeartbeat: heartbeatTime,
          restartAttempts: this.restartAttempts,
        };
      }

      // Attempt auto-restart
      return await this.attemptRestart(heartbeatTime, stalledMinutes);
    }

    // Healthy
    await this.logAudit({
      timestamp: new Date().toISOString(),
      event: 'check',
      details: {
        status: 'healthy',
        stalledMinutes: Math.round(stalledMinutes * 10) / 10,
        pid: heartbeat.pid,
      },
    });

    return {
      healthy: true,
      stalledMinutes,
      action: null,
      lastHeartbeat: heartbeatTime,
      restartAttempts: this.restartAttempts,
    };
  }

  /**
   * Attempt to restart the scheduler.
   */
  private async attemptRestart(
    lastHeartbeat: Date,
    stalledMinutes: number
  ): Promise<SchedulerHealthStatus> {
    this.restartAttempts++;
    this.lastRestartTime = new Date();

    await this.logAudit({
      timestamp: new Date().toISOString(),
      event: 'restart_attempted',
      details: {
        attempt: this.restartAttempts,
        ownershipMode: this.config.ownershipMode,
        restartCommand: this.config.restartCommand,
      },
    });

    try {
      await this.restartScheduler();

      await this.logAudit({
        timestamp: new Date().toISOString(),
        event: 'restart_success',
        details: { attempt: this.restartAttempts },
      });

      await this.notificationSink.notify(
        'info',
        `Scheduler auto-restarted after ${Math.round(stalledMinutes)} minutes stall`,
        {
          stalledMinutes: Math.round(stalledMinutes),
          restartAttempt: this.restartAttempts,
        }
      );

      await this.writeToNotes(
        `[META-MONITOR] Scheduler stalled ${Math.round(stalledMinutes)}min, auto-restarted (attempt ${this.restartAttempts})`
      );

      return {
        healthy: false,
        stalledMinutes,
        action: `Auto-restarted scheduler (attempt ${this.restartAttempts})`,
        lastHeartbeat,
        restartAttempts: this.restartAttempts,
      };
    } catch (error) {
      await this.logAudit({
        timestamp: new Date().toISOString(),
        event: 'restart_failed',
        details: {
          attempt: this.restartAttempts,
          error: String(error),
        },
      });

      await this.notificationSink.notify(
        'critical',
        `Scheduler restart FAILED (attempt ${this.restartAttempts})`,
        {
          error: String(error),
          restartAttempt: this.restartAttempts,
        }
      );

      await this.writeToNotes(
        `[META-MONITOR] Scheduler restart FAILED (attempt ${this.restartAttempts}): ${error}`
      );

      return {
        healthy: false,
        stalledMinutes,
        action: `Restart failed: ${error}`,
        lastHeartbeat,
        restartAttempts: this.restartAttempts,
      };
    }
  }

  /**
   * Execute scheduler restart based on ownership mode.
   * Security: CRIT-002 remediation - validates command against allowlist.
   */
  private async restartScheduler(): Promise<void> {
    if (this.config.ownershipMode === 'systemd_notify') {
      // In systemd_notify mode, use spawn with args array (no shell)
      await this.spawnRestart('systemctl', ['restart', 'loa-scheduler']);
    } else {
      // Validate command against allowlist before execution
      if (!isRestartCommandAllowed(this.config.restartCommand)) {
        const error = new Error(
          `Restart command not in allowlist: "${this.config.restartCommand}". ` +
          `Add via allowRestartCommand() during trusted initialization.`
        );
        await this.logAudit({
          timestamp: new Date().toISOString(),
          event: 'restart_failed',
          details: {
            reason: 'command_not_allowed',
            command: this.config.restartCommand,
          },
        });
        throw error;
      }

      // Parse command safely and use spawn
      const parts = this.config.restartCommand.trim().split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);
      await this.spawnRestart(cmd, args);
    }
  }

  /**
   * Execute a restart using spawn (no shell interpolation).
   */
  private spawnRestart(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: 'inherit',
        timeout: this.config.gracePeriodSeconds * 1000,
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Restart command exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Record a heartbeat (called by the scheduler).
   */
  async recordHeartbeat(extra?: Partial<HeartbeatData>): Promise<void> {
    const data: HeartbeatData = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ...extra,
    };

    // Ensure directory exists
    await mkdir(path.dirname(this.heartbeatPath), { recursive: true });

    await writeFile(this.heartbeatPath, JSON.stringify(data, null, 2));

    // In systemd_notify mode, also notify systemd watchdog
    if (this.config.ownershipMode === 'systemd_notify') {
      await this.notifySystemd();
    }
  }

  /**
   * Notify systemd watchdog (for systemd_notify mode).
   */
  private async notifySystemd(): Promise<void> {
    try {
      // sd_notify WATCHDOG=1
      const notifySocket = process.env.NOTIFY_SOCKET;
      if (notifySocket) {
        // Use systemd-notify command
        await execAsync('systemd-notify WATCHDOG=1');

        await this.logAudit({
          timestamp: new Date().toISOString(),
          event: 'systemd_notify',
          details: { success: true },
        });
      }
    } catch {
      // systemd-notify may not be available, ignore
    }
  }

  /**
   * Read the heartbeat file.
   */
  private async readHeartbeat(): Promise<HeartbeatData | null> {
    try {
      const content = await readFile(this.heartbeatPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Log audit entry to file.
   */
  private async logAudit(entry: MonitorAuditEntry): Promise<void> {
    try {
      await mkdir(path.dirname(this.auditLogPath), { recursive: true });
      await appendFile(this.auditLogPath, JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('[meta-monitor] Failed to write audit log:', error);
    }
  }

  /**
   * Write entry to NOTES.md.
   */
  private async writeToNotes(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = `| ${timestamp} | meta-monitor | ${message} |\n`;

    try {
      await appendFile(this.notesPath, entry);
    } catch (error) {
      console.error('[meta-monitor] Failed to write to NOTES.md:', error);
    }
  }

  /**
   * Get heartbeat file age in minutes.
   */
  async getHeartbeatAge(): Promise<number | null> {
    try {
      const stats = await stat(this.heartbeatPath);
      return (Date.now() - stats.mtime.getTime()) / (1000 * 60);
    } catch {
      return null;
    }
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<MetaMonitorConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(updates: Partial<MetaMonitorConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Reset restart counter (for manual intervention).
   */
  resetRestartCounter(): void {
    this.restartAttempts = 0;
    this.lastRestartTime = null;
  }

  /**
   * Get current restart attempt count.
   */
  getRestartAttempts(): number {
    return this.restartAttempts;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a MetaSchedulerMonitor from environment variables.
 *
 * Environment variables:
 * - LOA_META_CHECK_INTERVAL: Check interval in minutes
 * - LOA_META_STALL_THRESHOLD: Stall threshold in minutes
 * - LOA_META_RESTART_COMMAND: Restart command
 * - LOA_META_OWNERSHIP_MODE: 'standalone' or 'systemd_notify'
 * - LOA_META_GRACE_PERIOD: Grace period in seconds
 */
export function createMetaMonitor(
  configOverrides?: Partial<MetaMonitorConfig>
): MetaSchedulerMonitor {
  const envConfig: Partial<MetaMonitorConfig> = {};

  const checkInterval = process.env.LOA_META_CHECK_INTERVAL;
  const stallThreshold = process.env.LOA_META_STALL_THRESHOLD;
  const restartCommand = process.env.LOA_META_RESTART_COMMAND;
  const ownershipMode = process.env.LOA_META_OWNERSHIP_MODE as OwnershipMode | undefined;
  const gracePeriod = process.env.LOA_META_GRACE_PERIOD;

  if (checkInterval) envConfig.checkIntervalMinutes = parseInt(checkInterval, 10);
  if (stallThreshold) envConfig.stallThresholdMinutes = parseInt(stallThreshold, 10);
  if (restartCommand) envConfig.restartCommand = restartCommand;
  if (ownershipMode) envConfig.ownershipMode = ownershipMode;
  if (gracePeriod) envConfig.gracePeriodSeconds = parseInt(gracePeriod, 10);

  return new MetaSchedulerMonitor(
    { ...envConfig, ...configOverrides },
    { notificationSink: createNotificationSinkFromEnv('meta-monitor') }
  );
}

// =============================================================================
// Default Export
// =============================================================================

export default MetaSchedulerMonitor;
