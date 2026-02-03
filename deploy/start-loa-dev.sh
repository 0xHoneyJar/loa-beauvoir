#!/bin/bash
# =============================================================================
# Loa Development Startup Script - Hot-Reload with File Watching
# =============================================================================
# Uses entr -r pattern: single process that restarts on file changes.
# No race conditions between watcher and gateway processes.
#
# Usage: Called by docker-compose.dev.yml
# Watches: deploy/loa-identity/**/*.ts
# =============================================================================

# Don't use set -e with entr (it exits on file changes by design)

echo "[loa-dev] =============================================="
echo "[loa-dev] Loa Development Mode"
echo "[loa-dev] =============================================="
echo "[loa-dev] BEAUVOIR_DEV_MODE=${BEAUVOIR_DEV_MODE:-not set}"
echo "[loa-dev] CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-not set}"
echo "[loa-dev] Started at: $(date -Iseconds)"

# Skip recovery engine in dev mode
if [ "${BEAUVOIR_DEV_MODE:-0}" = "1" ]; then
    echo "[loa-dev] Skipping recovery engine (dev mode enabled)"
else
    echo "[loa-dev] WARNING: BEAUVOIR_DEV_MODE not set, recovery engine may run"
fi

# Create workspace directories if needed
mkdir -p /workspace/deploy/loa-identity
mkdir -p /workspace/.claude
mkdir -p /workspace/grimoires/loa

# Verify entr is installed
if ! command -v entr &>/dev/null; then
    echo "[loa-dev] WARNING: entr not installed, running without hot-reload"
    echo "[loa-dev] Changes will require manual container restart"
    echo "[loa-dev] Starting gateway..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi

# Verify clawdbot is installed
if ! command -v clawdbot &>/dev/null; then
    echo "[loa-dev] ERROR: clawdbot not found"
    echo "[loa-dev] Installing clawdbot..."
    npm install -g clawdbot@2026.1.24-3 || {
        echo "[loa-dev] FATAL: Failed to install clawdbot"
        exit 1
    }
fi

echo "[loa-dev] clawdbot version: $(clawdbot --version 2>/dev/null || echo 'unknown')"
echo "[loa-dev] entr version: $(entr 2>&1 | head -1 || echo 'unknown')"
echo "[loa-dev] ----------------------------------------------"
echo "[loa-dev] Watching for .ts changes in deploy/loa-identity/"
echo "[loa-dev] Edit files to trigger automatic restart"
echo "[loa-dev] Press Ctrl+C to stop"
echo "[loa-dev] ----------------------------------------------"

# Single process pattern: entr -r restarts the command on file changes
# -d: track directories for new files (exit when new file added)
# -r: reload mode (restart command on change, send SIGTERM first)
#
# The outer loop handles the case where entr exits due to new files (-d flag)
while true; do
    # Find all .ts files in loa-identity directory
    ts_files=$(find /workspace/deploy/loa-identity -name "*.ts" 2>/dev/null)

    if [ -z "$ts_files" ]; then
        echo "[loa-dev] No .ts files found in deploy/loa-identity/"
        echo "[loa-dev] Starting gateway without file watching..."
        exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind lan
    fi

    # Watch files and restart gateway on changes
    echo "$ts_files" | entr -d -r sh -c '
        echo "[loa-dev] $(date -Iseconds) File change detected, restarting gateway..."
        clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind lan
    '

    # entr exits when a new file is added (-d flag)
    # Loop back to rescan for new files
    echo "[loa-dev] $(date -Iseconds) Rescanning for new/deleted files..."
    sleep 1
done
