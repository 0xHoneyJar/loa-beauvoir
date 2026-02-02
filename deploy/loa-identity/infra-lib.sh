#!/bin/bash
# =============================================================================
# Loa Cloud Stack - Infrastructure Functions Library
# =============================================================================
# Extracted from moltworker's start-moltbot.sh
# Contains ONLY infrastructure functions - NO identity/AGENTS.md setup
#
# Functions:
#   - should_restore_from_r2: Check if R2 backup is newer than local
#   - restore_config_from_r2: Restore OpenClaw config from R2
#   - configure_channels_from_env: Set up messaging channel tokens
#   - start_r2_sync: Start background R2 sync (cron-triggered by Worker)
# =============================================================================

# Paths
OPENCLAW_CONFIG_DIR="/root/.openclaw"
OPENCLAW_CONFIG_FILE="$OPENCLAW_CONFIG_DIR/openclaw.json"
BACKUP_DIR="/data/moltbot"
WORKSPACE="/workspace"

# Helper function to check if R2 backup is newer than local
should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$OPENCLAW_CONFIG_DIR/.last-sync"

    # If no R2 sync timestamp, don't restore
    if [ ! -f "$R2_SYNC_FILE" ]; then
        echo "[infra] No R2 sync timestamp found, skipping restore"
        return 1
    fi

    # If no local sync timestamp, restore from R2
    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        echo "[infra] No local sync timestamp, will restore from R2"
        return 0
    fi

    # Compare timestamps
    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null)
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null)

    echo "[infra] R2 last sync: $R2_TIME"
    echo "[infra] Local last sync: $LOCAL_TIME"

    # Convert to epoch seconds for comparison
    R2_EPOCH=$(date -d "$R2_TIME" +%s 2>/dev/null || echo "0")
    LOCAL_EPOCH=$(date -d "$LOCAL_TIME" +%s 2>/dev/null || echo "0")

    if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
        echo "[infra] R2 backup is newer, will restore"
        return 0
    else
        echo "[infra] Local data is newer or same, skipping restore"
        return 1
    fi
}

# Restore OpenClaw config from R2 backup
restore_config_from_r2() {
    mkdir -p "$OPENCLAW_CONFIG_DIR"

    # Check for R2 backup - support both old (clawdbot) and new (openclaw) paths
    local backup_found=false
    local backup_source=""

    if [ -f "$BACKUP_DIR/openclaw/openclaw.json" ]; then
        backup_source="$BACKUP_DIR/openclaw"
        backup_found=true
    elif [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
        # Legacy moltworker format
        backup_source="$BACKUP_DIR/clawdbot"
        backup_found=true
    fi

    if [ "$backup_found" = true ] && should_restore_from_r2; then
        echo "[infra] Restoring config from R2 backup at $backup_source..."
        cp -a "$backup_source/." "$OPENCLAW_CONFIG_DIR/"
        cp -f "$BACKUP_DIR/.last-sync" "$OPENCLAW_CONFIG_DIR/.last-sync" 2>/dev/null || true

        # Rename clawdbot.json to openclaw.json if needed
        if [ -f "$OPENCLAW_CONFIG_DIR/clawdbot.json" ] && [ ! -f "$OPENCLAW_CONFIG_FILE" ]; then
            mv "$OPENCLAW_CONFIG_DIR/clawdbot.json" "$OPENCLAW_CONFIG_FILE"
        fi

        echo "[infra] Restored config from R2 backup"
        return 0
    elif [ -d "$BACKUP_DIR" ]; then
        echo "[infra] R2 mounted at $BACKUP_DIR but no backup data found yet"
        return 1
    else
        echo "[infra] R2 not mounted, starting fresh"
        return 1
    fi
}

# Restore grimoires from R2 backup
restore_grimoires_from_r2() {
    if [ -d "$BACKUP_DIR/grimoires" ] && [ "$(ls -A $BACKUP_DIR/grimoires 2>/dev/null)" ]; then
        if should_restore_from_r2; then
            echo "[infra] Restoring grimoires from R2..."
            mkdir -p "$WORKSPACE/grimoires"
            cp -a "$BACKUP_DIR/grimoires/." "$WORKSPACE/grimoires/"
            echo "[infra] Restored grimoires from R2"
            return 0
        fi
    fi
    return 1
}

# Restore .beads from R2 backup
restore_beads_from_r2() {
    if [ -d "$BACKUP_DIR/.beads" ] && [ "$(ls -A $BACKUP_DIR/.beads 2>/dev/null)" ]; then
        if should_restore_from_r2; then
            echo "[infra] Restoring .beads from R2..."
            mkdir -p "$WORKSPACE/.beads"
            cp -a "$BACKUP_DIR/.beads/." "$WORKSPACE/.beads/"
            echo "[infra] Restored .beads from R2"
            return 0
        fi
    fi
    return 1
}

# Configure channels from environment variables
configure_channels_from_env() {
    echo "[infra] Configuring channels from environment..."

    # Create config if it doesn't exist
    if [ ! -f "$OPENCLAW_CONFIG_FILE" ]; then
        mkdir -p "$OPENCLAW_CONFIG_DIR"
        cat > "$OPENCLAW_CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/workspace"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi

    # Use Node.js to update config (same pattern as moltworker)
    node << 'EOFNODE'
const fs = require('fs');

const configPath = process.env.OPENCLAW_CONFIG_FILE || '/root/.openclaw/openclaw.json';
console.log('[infra] Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('[infra] Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided
if (process.env.GATEWAY_TOKEN || process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.GATEWAY_TOKEN || process.env.CLAWDBOT_GATEWAY_TOKEN;
}

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    config.channels.telegram.dm = config.channels.telegram.dm || {};
    config.channels.telegram.dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
}

// Discord configuration
if (process.env.DISCORD_BOT_TOKEN) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = process.env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;
    config.channels.discord.dm = config.channels.discord.dm || {};
    config.channels.discord.dm.policy = process.env.DISCORD_DM_POLICY || 'pairing';
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.botToken = process.env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = process.env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;
}

// AI Gateway base URL (optional)
const baseUrl = (process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
if (baseUrl) {
    console.log('[infra] Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    if (process.env.ANTHROPIC_API_KEY) {
        providerConfig.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    config.models.providers.anthropic = providerConfig;
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('[infra] Configuration updated successfully');
EOFNODE
}

# Export functions for use by start-loa.sh
export -f should_restore_from_r2
export -f restore_config_from_r2
export -f restore_grimoires_from_r2
export -f restore_beads_from_r2
export -f configure_channels_from_env
