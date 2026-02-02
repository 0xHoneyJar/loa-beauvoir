#!/bin/bash
# =============================================================================
# Loa Cloud Stack - Startup Script
# Called by Worker via sandbox.startProcess('/usr/local/bin/start-moltbot.sh')
# (symlinked from start-loa.sh)
# =============================================================================
#
# BEAUVOIR RESILIENCE PROTOCOL:
# This script implements auto-recovery so Beauvoir never stops and waits
# for a human when encountering problems it can solve.
# =============================================================================

set -e

# Check if gateway is already running
if pgrep -f "clawdbot gateway" > /dev/null 2>&1; then
    echo "[loa] Gateway is already running, exiting."
    exit 0
fi

# Paths
CONFIG_DIR="/root/.clawdbot"
CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
WORKSPACE="/root/clawd"
BACKUP_DIR="/data/moltbot"
LOA_WORKSPACE="/workspace"
GRIMOIRE_DIR="$LOA_WORKSPACE/grimoires/loa"

echo "[loa] Starting Loa Cloud Stack"
echo "[loa] Config directory: $CONFIG_DIR"
echo "[loa] Workspace: $WORKSPACE"
echo "[loa] Loa workspace: $LOA_WORKSPACE"

# Create directories
mkdir -p "$CONFIG_DIR"
mkdir -p "$WORKSPACE"
mkdir -p "$BACKUP_DIR"
mkdir -p "$GRIMOIRE_DIR/memory"

# Set Loa identity - critical for isolation from moltbot
export CLAUDE_CONFIG_DIR="/workspace/.claude"

# =============================================================================
# BEAUVOIR STATE RECOVERY PROTOCOL
# "I exist to help. Stopping and waiting for permission to exist is not helpful."
# =============================================================================

log_recovery() {
    local action="$1"
    local timestamp=$(date -Iseconds)
    local notes_file="$GRIMOIRE_DIR/NOTES.md"

    # Append to Session Continuity section if NOTES.md exists
    if [ -f "$notes_file" ]; then
        echo "| $timestamp | startup | [Recovery] $action |" >> "$notes_file"
    fi
    echo "[loa] Recovery: $action"
}

# Check Loa state integrity
check_state_integrity() {
    local missing=0

    # Critical files for Beauvoir identity
    [ ! -f "$GRIMOIRE_DIR/NOTES.md" ] && missing=$((missing + 1))
    [ ! -f "$GRIMOIRE_DIR/BEAUVOIR.md" ] && missing=$((missing + 2))
    [ ! -d "$LOA_WORKSPACE/.claude" ] && missing=$((missing + 4))

    echo $missing
}

# Restore from R2 backup (hot state)
restore_from_r2() {
    if [ -d "$BACKUP_DIR/grimoires/loa" ]; then
        echo "[loa] Restoring grimoires from R2 backup..."
        cp -a "$BACKUP_DIR/grimoires/loa/." "$GRIMOIRE_DIR/" 2>/dev/null || true
        log_recovery "Restored grimoires from R2"
        return 0
    fi
    return 1
}

# State integrity check and auto-recovery
STATE_ISSUES=$(check_state_integrity)
if [ "$STATE_ISSUES" -gt 0 ]; then
    echo "[loa] State issues detected (code: $STATE_ISSUES), initiating recovery..."

    # Try R2 first (hot backup)
    if ! restore_from_r2; then
        echo "[loa] R2 backup not available, using container defaults"
        log_recovery "Using container defaults (no backup available)"
    fi
fi

# Restore gateway config from R2 backup if available
if [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    echo "[loa] Restoring gateway config from R2 backup..."
    cp -a "$BACKUP_DIR/clawdbot/." "$CONFIG_DIR/" 2>/dev/null || true
fi

# Create config if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[loa] Creating initial config..."
    cat > "$CONFIG_FILE" << 'EOF'
{
  "agents": {
    "defaults": {
      "workspace": "/root/clawd"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOF
fi

# Update config from environment variables
node << 'EOFNODE'
const fs = require('fs');

const configPath = '/root/.clawdbot/clawdbot.json';
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('[loa] Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

// Set gateway token if provided
if (process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.CLAWDBOT_GATEWAY_TOKEN;
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('[loa] Configuration updated');
EOFNODE

# Clean up stale locks
rm -f /tmp/clawdbot-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

# Start gateway
echo "[loa] Starting gateway on port 18789..."

BIND_MODE="lan"
if [ -n "$CLAWDBOT_GATEWAY_TOKEN" ]; then
    echo "[loa] Starting with token auth..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$CLAWDBOT_GATEWAY_TOKEN"
else
    echo "[loa] Starting with device pairing..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
