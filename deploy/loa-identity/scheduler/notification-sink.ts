/**
 * NotificationSink - Unified Alerting Interface (FR-11)
 *
 * Provides unified alerting for critical operational events across
 * multiple channels (Slack, Discord, webhook, log).
 *
 * @module deploy/loa-identity/scheduler/notification-sink
 */

// =============================================================================
// Security Utilities
// =============================================================================

/**
 * Sanitize a webhook URL for safe logging by masking the path/token portion.
 * Security: HIGH-002 remediation - prevents webhook token exposure in logs.
 *
 * @example
 * sanitizeWebhookUrl('https://hooks.slack.com/services/T00/B00/xxxx')
 * // => 'https://hooks.slack.com/services/***MASKED***'
 */
function sanitizeWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Mask everything after the host
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length > 1) {
      // Keep first path segment, mask the rest
      return `${parsed.protocol}//${parsed.host}/${pathParts[0]}/***MASKED***`;
    }
    return `${parsed.protocol}//${parsed.host}/***MASKED***`;
  } catch {
    // If URL parsing fails, just return a generic masked value
    return '***INVALID_URL***';
  }
}

// =============================================================================
// Types and Interfaces
// =============================================================================

export type Severity = 'info' | 'warning' | 'critical';

export interface NotificationSink {
  notify(
    severity: Severity,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
}

export interface NotificationConfig {
  enabled: boolean;
  channels: NotificationChannel[];
  minSeverity: Severity;
}

export interface NotificationChannel {
  type: 'slack' | 'discord' | 'webhook' | 'log';
  url?: string;
  channel?: string;
  /** Optional name for this channel (for logging) */
  name?: string;
}

export interface NotificationPayload {
  timestamp: string;
  severity: Severity;
  message: string;
  context?: Record<string, unknown>;
  source: string;
}

export interface NotificationResult {
  channel: string;
  success: boolean;
  error?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: NotificationConfig = {
  enabled: true,
  channels: [{ type: 'log' }],
  minSeverity: 'info',
};

// =============================================================================
// CompositeNotificationSink Class
// =============================================================================

export class CompositeNotificationSink implements NotificationSink {
  private config: NotificationConfig;
  private severityOrder: Record<Severity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
  };
  private source: string;

  constructor(config?: Partial<NotificationConfig>, source?: string) {
    this.config = {
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      channels: config?.channels ?? DEFAULT_CONFIG.channels,
      minSeverity: config?.minSeverity ?? DEFAULT_CONFIG.minSeverity,
    };
    this.source = source ?? 'loa-beauvoir';
  }

  /**
   * Send notification to all configured channels.
   *
   * @param severity - Notification severity level
   * @param message - Human-readable message
   * @param context - Optional additional context
   */
  async notify(
    severity: Severity,
    message: string,
    context?: Record<string, unknown>
  ): Promise<void> {
    // Check if notifications are enabled
    if (!this.config.enabled) {
      return;
    }

    // Filter by minimum severity
    if (this.severityOrder[severity] < this.severityOrder[this.config.minSeverity]) {
      return;
    }

    const payload: NotificationPayload = {
      timestamp: new Date().toISOString(),
      severity,
      message,
      context,
      source: this.source,
    };

    // Send to all configured channels
    const results = await Promise.allSettled(
      this.config.channels.map((channel) => this.sendToChannel(channel, payload))
    );

    // Log any failures (without exposing webhook URLs - HIGH-002 remediation)
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const channel = this.config.channels[index];
        const safeUrl = channel.url ? sanitizeWebhookUrl(channel.url) : 'N/A';
        const errorMessage =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        // Log only safe information, not the full error or URL
        console.error(
          `[notification-sink] Failed to send to ${channel.type} (${safeUrl}): ${errorMessage}`
        );
      }
    });
  }

  /**
   * Route notification to appropriate channel handler.
   */
  private async sendToChannel(
    channel: NotificationChannel,
    payload: NotificationPayload
  ): Promise<void> {
    switch (channel.type) {
      case 'slack':
        await this.sendSlack(channel, payload);
        break;
      case 'discord':
        await this.sendDiscord(channel, payload);
        break;
      case 'webhook':
        await this.sendWebhook(channel, payload);
        break;
      case 'log':
        this.sendLog(payload);
        break;
      default:
        console.warn(`[notification-sink] Unknown channel type: ${(channel as NotificationChannel).type}`);
    }
  }

  /**
   * Send notification to Slack webhook.
   */
  private async sendSlack(
    channel: NotificationChannel,
    payload: NotificationPayload
  ): Promise<void> {
    if (!channel.url) {
      throw new Error('Slack channel requires url');
    }

    const emoji =
      payload.severity === 'critical'
        ? ':rotating_light:'
        : payload.severity === 'warning'
        ? ':warning:'
        : ':information_source:';

    const slackPayload = {
      text: `${emoji} *${payload.severity.toUpperCase()}*: ${payload.message}`,
      attachments: payload.context
        ? [
            {
              color:
                payload.severity === 'critical'
                  ? '#ff0000'
                  : payload.severity === 'warning'
                  ? '#ffaa00'
                  : '#00aaff',
              fields: Object.entries(payload.context).map(([key, value]) => ({
                title: key,
                value: String(value),
                short: true,
              })),
              footer: `${payload.source} | ${payload.timestamp}`,
            },
          ]
        : undefined,
      channel: channel.channel,
    };

    const response = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Send notification to Discord webhook.
   */
  private async sendDiscord(
    channel: NotificationChannel,
    payload: NotificationPayload
  ): Promise<void> {
    if (!channel.url) {
      throw new Error('Discord channel requires url');
    }

    const color =
      payload.severity === 'critical'
        ? 0xff0000
        : payload.severity === 'warning'
        ? 0xffaa00
        : 0x00aaff;

    const discordPayload = {
      embeds: [
        {
          title: `${payload.severity.toUpperCase()}: ${payload.source}`,
          description: payload.message,
          color,
          fields: payload.context
            ? Object.entries(payload.context).map(([key, value]) => ({
                name: key,
                value: String(value),
                inline: true,
              }))
            : undefined,
          timestamp: payload.timestamp,
          footer: {
            text: payload.source,
          },
        },
      ],
    };

    const response = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload),
    });

    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Send notification to generic webhook.
   */
  private async sendWebhook(
    channel: NotificationChannel,
    payload: NotificationPayload
  ): Promise<void> {
    if (!channel.url) {
      throw new Error('Webhook channel requires url');
    }

    const response = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook error: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Log notification to console.
   */
  private sendLog(payload: NotificationPayload): void {
    const prefix = `[${payload.timestamp}] [${payload.severity.toUpperCase()}]`;
    const message = `${prefix} ${payload.message}`;

    if (payload.severity === 'critical') {
      console.error(message, payload.context ?? '');
    } else if (payload.severity === 'warning') {
      console.warn(message, payload.context ?? '');
    } else {
      console.log(message, payload.context ?? '');
    }
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<NotificationConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(updates: Partial<NotificationConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
    };
  }

  /**
   * Add a notification channel.
   */
  addChannel(channel: NotificationChannel): void {
    this.config.channels.push(channel);
  }

  /**
   * Remove a notification channel by type and optionally URL.
   */
  removeChannel(type: NotificationChannel['type'], url?: string): boolean {
    const initialLength = this.config.channels.length;
    this.config.channels = this.config.channels.filter(
      (ch) => !(ch.type === type && (url === undefined || ch.url === url))
    );
    return this.config.channels.length < initialLength;
  }
}

// =============================================================================
// Null Sink (for testing or disabled notifications)
// =============================================================================

export class NullNotificationSink implements NotificationSink {
  async notify(): Promise<void> {
    // No-op
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a notification sink from configuration.
 */
export function createNotificationSink(
  config?: Partial<NotificationConfig>,
  source?: string
): NotificationSink {
  if (config?.enabled === false) {
    return new NullNotificationSink();
  }
  return new CompositeNotificationSink(config, source);
}

/**
 * Create a notification sink from environment variables.
 *
 * Environment variables:
 * - LOA_NOTIFY_ENABLED: 'true' or 'false'
 * - LOA_NOTIFY_MIN_SEVERITY: 'info', 'warning', or 'critical'
 * - LOA_NOTIFY_SLACK_URL: Slack webhook URL
 * - LOA_NOTIFY_DISCORD_URL: Discord webhook URL
 * - LOA_NOTIFY_WEBHOOK_URL: Generic webhook URL
 */
export function createNotificationSinkFromEnv(source?: string): NotificationSink {
  const enabled = process.env.LOA_NOTIFY_ENABLED !== 'false';

  // Validate severity against allowed values (MED-004 remediation)
  const validSeverities: Severity[] = ['info', 'warning', 'critical'];
  const envSeverity = process.env.LOA_NOTIFY_MIN_SEVERITY;
  let minSeverity: Severity = 'warning';
  if (envSeverity) {
    if (validSeverities.includes(envSeverity as Severity)) {
      minSeverity = envSeverity as Severity;
    } else {
      console.warn(
        `[notification-sink] Invalid LOA_NOTIFY_MIN_SEVERITY="${envSeverity}", using default "warning"`
      );
    }
  }

  const channels: NotificationChannel[] = [];

  // Always add log channel
  channels.push({ type: 'log' });

  // Add Slack if configured
  const slackUrl = process.env.LOA_NOTIFY_SLACK_URL;
  if (slackUrl) {
    channels.push({
      type: 'slack',
      url: slackUrl,
      channel: process.env.LOA_NOTIFY_SLACK_CHANNEL,
    });
  }

  // Add Discord if configured
  const discordUrl = process.env.LOA_NOTIFY_DISCORD_URL;
  if (discordUrl) {
    channels.push({
      type: 'discord',
      url: discordUrl,
    });
  }

  // Add generic webhook if configured
  const webhookUrl = process.env.LOA_NOTIFY_WEBHOOK_URL;
  if (webhookUrl) {
    channels.push({
      type: 'webhook',
      url: webhookUrl,
    });
  }

  return createNotificationSink({ enabled, channels, minSeverity }, source);
}

// =============================================================================
// Default Export
// =============================================================================

export default CompositeNotificationSink;
