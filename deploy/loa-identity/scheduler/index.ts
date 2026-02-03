/**
 * Scheduler Module - Periodic tasks with resilience
 *
 * Includes operational hardening components (FR-6 to FR-11).
 *
 * @module deploy/loa-identity/scheduler
 */

export {
  Scheduler,
  createBeauvoirScheduler,
  type ScheduledTask,
  type TaskStatus,
  type CircuitBreakerConfig,
  type SchedulerConfig,
} from './scheduler.js';

// Timeout Enforcement (FR-6)
export {
  TimeoutEnforcer,
  createTimeoutEnforcer,
  type TimeoutConfig,
  type TrustedModel,
  type TimeoutValidationResult,
  type TimeoutAuditEntry,
} from './timeout-enforcer.js';

// Bloat Audit (FR-7)
export {
  BloatAuditor,
  createBloatAuditor,
  type BloatThresholds,
  type BloatAuditResult,
  type BloatViolation,
  type CronOverlap,
} from './bloat-auditor.js';

// MECE Validation (FR-8)
export {
  MECEValidator,
  createMECEValidator,
  type MECEConfig,
  type TaskCandidate,
  type MECEViolation,
  type MECEValidationResult,
} from './mece-validator.js';

// Notification Sink (FR-11)
export {
  CompositeNotificationSink,
  NullNotificationSink,
  createNotificationSink,
  createNotificationSinkFromEnv,
  type NotificationSink,
  type NotificationConfig,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationResult,
  type Severity,
} from './notification-sink.js';

// Meta-Scheduler Monitor (FR-9)
export {
  MetaSchedulerMonitor,
  createMetaMonitor,
  type MetaMonitorConfig,
  type OwnershipMode,
  type SchedulerHealthStatus,
  type HeartbeatData,
  type MonitorAuditEntry,
} from './meta-monitor.js';
