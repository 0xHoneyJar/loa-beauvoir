#!/bin/bash
# =============================================================================
# Loa Cloud Stack - Container Entrypoint
# =============================================================================
# This script initializes the Loa-powered OpenClaw deployment.
#
# IDENTITY GUARANTEE:
# - Moltworker's AGENTS.md is NEVER loaded
# - CLAUDE_CONFIG_DIR points to /workspace/.claude (Loa System Zone)
# - Only infrastructure functions are used from moltworker
#
# Phases:
# 1. Infrastructure Setup (R2 mount, channel tokens)
# 2. State Recovery (WAL → R2 → Git)
# 3. Loa Identity Initialization
# 4. Start Gateway
# =============================================================================

set -euo pipefail

echo "[loa] =================================================="
echo "[loa] Starting Loa Cloud Stack"
echo "[loa] =================================================="

# Check if gateway is already running
if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "[loa] OpenClaw gateway is already running, exiting."
    exit 0
fi

# Source infrastructure functions (from moltworker, NO identity setup)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../deploy/loa-identity/infra-lib.sh" ]; then
    source "$SCRIPT_DIR/../deploy/loa-identity/infra-lib.sh"
elif [ -f "/workspace/deploy/loa-identity/infra-lib.sh" ]; then
    source "/workspace/deploy/loa-identity/infra-lib.sh"
else
    echo "[loa] Warning: infra-lib.sh not found, using defaults"
fi

# =============================================================================
# PHASE 1: Infrastructure Setup
# =============================================================================
echo "[loa] Phase 1: Infrastructure Setup"

# Restore OpenClaw config from R2 if available
restore_config_from_r2 || echo "[loa] No R2 config to restore, will create fresh"

# Configure channels from environment variables
configure_channels_from_env

# =============================================================================
# PHASE 2: State Recovery (WAL → R2 → Git)
# =============================================================================
echo "[loa] Phase 2: State Recovery"

WORKSPACE="/workspace"
WAL_DIR="/data/wal"
BACKUP_DIR="/data/moltbot"

# Check WAL for uncommitted changes
if [ -d "$WAL_DIR" ] && [ -n "$(ls -A $WAL_DIR 2>/dev/null)" ]; then
    echo "[loa] WAL directory has entries, replaying..."
    # WAL replay will be implemented in Sprint 3
    # For now, just note that entries exist
    echo "[loa] WAL replay not yet implemented (Sprint 3)"
fi

# Restore grimoires from R2
restore_grimoires_from_r2 || {
    echo "[loa] No R2 grimoires, checking git..."
    # If no R2 state, grimoires from container image are used
    if [ ! -d "$WORKSPACE/grimoires/loa" ]; then
        echo "[loa] Creating grimoires structure..."
        mkdir -p "$WORKSPACE/grimoires/loa"
    fi
}

# Restore .beads from R2
restore_beads_from_r2 || {
    echo "[loa] No R2 .beads, starting fresh"
    mkdir -p "$WORKSPACE/.beads"
}

# =============================================================================
# PHASE 3: Loa Identity Initialization
# =============================================================================
echo "[loa] Phase 3: Loa Identity Initialization"

# CRITICAL: Set CLAUDE_CONFIG_DIR to Loa System Zone
# This is the identity isolation guarantee - moltworker's AGENTS.md is NEVER loaded
export CLAUDE_CONFIG_DIR="/workspace/.claude"

# Verify Loa System Zone exists
if [ ! -d "$CLAUDE_CONFIG_DIR" ]; then
    echo "[loa] ERROR: Loa System Zone not found at $CLAUDE_CONFIG_DIR"
    echo "[loa] Container image may be corrupted - System Zone should be baked in"
    exit 1
fi

# Verify key Loa files
if [ ! -f "$CLAUDE_CONFIG_DIR/AGENTS.md" ]; then
    echo "[loa] Warning: Loa AGENTS.md not found, system may not function correctly"
fi

# Ensure grimoires are linked/present
if [ ! -d "$WORKSPACE/grimoires/loa" ]; then
    mkdir -p "$WORKSPACE/grimoires/loa"
fi

# Check for Loa version manifest
if [ -f "$WORKSPACE/.loa-version.json" ]; then
    LOA_VERSION=$(jq -r '.framework_version // "unknown"' "$WORKSPACE/.loa-version.json" 2>/dev/null || echo "unknown")
    echo "[loa] Loa Framework version: $LOA_VERSION"
else
    echo "[loa] Warning: .loa-version.json not found"
fi

echo "[loa] Loa identity initialized successfully"
echo "[loa] CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"

# =============================================================================
# PHASE 4: Start Background Sync Jobs
# =============================================================================
echo "[loa] Phase 4: Starting background jobs"

# WAL sync to R2 (every 30 seconds) - will be implemented in Sprint 3
# For now, just a placeholder
# start_wal_sync &

# Git sync (hourly) - will be implemented in Sprint 3
# start_git_sync &

echo "[loa] Background sync jobs scheduled (Sprint 3 implementation)"

# =============================================================================
# PHASE 5: Start Gateway
# =============================================================================
echo "[loa] Phase 5: Starting OpenClaw Gateway"

# Clean up stale lock files
rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f /root/.openclaw/gateway.lock 2>/dev/null || true

# Determine bind mode
BIND_MODE="lan"

# Gateway token (support both new and legacy env var names)
GATEWAY_TOKEN="${GATEWAY_TOKEN:-${CLAWDBOT_GATEWAY_TOKEN:-}}"

echo "[loa] Gateway port: 3000"
echo "[loa] Bind mode: $BIND_MODE"
echo "[loa] Token auth: $([ -n "$GATEWAY_TOKEN" ] && echo "enabled" || echo "disabled (device pairing)")"

cd "$WORKSPACE"

if [ -n "$GATEWAY_TOKEN" ]; then
    echo "[loa] Starting gateway with token auth..."
    exec openclaw gateway --port 3000 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$GATEWAY_TOKEN"
else
    echo "[loa] Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 3000 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
