#!/bin/bash
# =============================================================================
# Loa Cloud Stack - Startup Script
# Called by Worker via sandbox.startProcess('/usr/local/bin/start-moltbot.sh')
# (symlinked from start-loa.sh)
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

echo "[loa] Starting Loa Cloud Stack"
echo "[loa] Config directory: $CONFIG_DIR"
echo "[loa] Workspace: $WORKSPACE"

# Create directories
mkdir -p "$CONFIG_DIR"
mkdir -p "$WORKSPACE"
mkdir -p "$BACKUP_DIR"

# Set Loa identity - critical for isolation from moltbot
export CLAUDE_CONFIG_DIR="/workspace/.claude"

# Restore from R2 backup if available
if [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    echo "[loa] Restoring config from R2 backup..."
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
