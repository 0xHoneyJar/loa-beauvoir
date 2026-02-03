#!/bin/bash
#
# health-check.sh - Non-LLM Health Check (FR-11)
#
# PURPOSE: Non-LLM health check to reduce API usage
# OWNER: operational-hardening
# DOES NOT: Invoke LLM for routine status checks
#
# Exit codes:
#   0   = healthy
#   1   = unhealthy (requires LLM triage)
#   2   = degraded (log warning, continue)
#   124 = timeout (script took too long)
#
# Usage:
#   ./health-check.sh              # Run all checks
#   ./health-check.sh --quick      # Quick check (R2 + heartbeat only)
#   ./health-check.sh --json       # Output JSON summary
#

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-30}"
WORKSPACE="${WORKSPACE:-/workspace}"
HEALTH_LOG="${WORKSPACE}/.loa/health.log"
ANOMALY_FILE="${WORKSPACE}/.loa/health-anomaly.json"
HEARTBEAT_FILE="${WORKSPACE}/.loa/scheduler-heartbeat"
MANIFEST_FILE="${WORKSPACE}/grimoires/loa/.loa-state-manifest.json"
WAL_DIR="/data/wal"
WAL_SIZE_WARN_MB="${WAL_SIZE_WARN_MB:-50}"
HEARTBEAT_STALE_MINUTES="${HEARTBEAT_STALE_MINUTES:-30}"

# =============================================================================
# Timeout Protection (Flatline Review IMP-005/SKP-005)
# =============================================================================

# Self-timeout wrapper - re-exec with timeout if not already wrapped
if [[ "${HEALTH_CHECK_WRAPPED:-}" != "true" ]]; then
    export HEALTH_CHECK_WRAPPED=true
    exec timeout "$HEALTH_CHECK_TIMEOUT" "$0" "$@"
fi

# =============================================================================
# Parse Arguments
# =============================================================================

QUICK_MODE=false
JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quick|-q)
            QUICK_MODE=true
            shift
            ;;
        --json|-j)
            JSON_OUTPUT=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--quick] [--json]"
            echo ""
            echo "Options:"
            echo "  --quick, -q    Quick check (R2 + heartbeat only)"
            echo "  --json, -j     Output JSON summary"
            echo ""
            echo "Exit codes:"
            echo "  0   = healthy"
            echo "  1   = unhealthy (requires LLM triage)"
            echo "  2   = degraded (log warning, continue)"
            echo "  124 = timeout (script took too long)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# =============================================================================
# Utility Functions
# =============================================================================

log() {
    local timestamp
    timestamp=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)
    echo "[$timestamp] $*" >> "$HEALTH_LOG"
}

ensure_log_dir() {
    mkdir -p "$(dirname "$HEALTH_LOG")" 2>/dev/null || true
}

write_anomaly() {
    local check="$1"
    local status="$2"
    shift 2
    local extra="$*"

    local json="{\"check\":\"$check\",\"status\":\"$status\",\"timestamp\":\"$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)\"$extra}"
    echo "$json" > "$ANOMALY_FILE"
}

# =============================================================================
# Health Checks
# =============================================================================

check_r2_mount() {
    # Check if R2/S3 is mounted via s3fs or rclone
    if mount | grep -qE '(s3fs|rclone|fuse\.s3fs)'; then
        return 0
    fi

    # Also check if /data/r2 exists and is accessible
    if [[ -d "/data/r2" ]] && [[ -r "/data/r2" ]]; then
        return 0
    fi

    write_anomaly "r2_mount" "failed" ",\"message\":\"R2 not mounted\""
    return 1
}

check_wal_size() {
    if [[ ! -d "$WAL_DIR" ]]; then
        # WAL directory doesn't exist - not necessarily an error
        return 0
    fi

    local size_mb
    size_mb=$(du -sm "$WAL_DIR" 2>/dev/null | cut -f1 || echo 0)

    if [[ "$size_mb" -gt "$WAL_SIZE_WARN_MB" ]]; then
        write_anomaly "wal_size" "warning" ",\"size_mb\":$size_mb,\"threshold_mb\":$WAL_SIZE_WARN_MB"
        return 2
    fi

    return 0
}

check_scheduler_heartbeat() {
    if [[ ! -f "$HEARTBEAT_FILE" ]]; then
        write_anomaly "scheduler" "failed" ",\"message\":\"No heartbeat file\""
        return 1
    fi

    # Calculate heartbeat age in minutes
    local now
    local heartbeat_time
    local age_minutes

    now=$(date +%s)

    # Try to get file modification time
    if [[ "$(uname)" == "Darwin" ]]; then
        heartbeat_time=$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
    else
        heartbeat_time=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
    fi

    if [[ "$heartbeat_time" -eq 0 ]]; then
        write_anomaly "scheduler" "warning" ",\"message\":\"Cannot read heartbeat timestamp\""
        return 2
    fi

    age_minutes=$(( (now - heartbeat_time) / 60 ))

    if [[ "$age_minutes" -gt "$HEARTBEAT_STALE_MINUTES" ]]; then
        write_anomaly "scheduler" "failed" ",\"stalled_minutes\":$age_minutes,\"threshold_minutes\":$HEARTBEAT_STALE_MINUTES"
        return 1
    fi

    return 0
}

check_grimoire_integrity() {
    if [[ ! -f "$MANIFEST_FILE" ]]; then
        write_anomaly "integrity" "warning" ",\"message\":\"No state manifest found\""
        return 2
    fi

    # Security: HIGH-003 remediation - validate path is within expected directory
    # Resolve to canonical path and check it's under WORKSPACE
    local canonical_path
    canonical_path=$(realpath -m "$MANIFEST_FILE" 2>/dev/null || echo "")

    if [[ -z "$canonical_path" ]]; then
        write_anomaly "integrity" "warning" ",\"message\":\"Cannot resolve manifest path\""
        return 2
    fi

    # Ensure path is under workspace (prevents path traversal)
    local canonical_workspace
    canonical_workspace=$(realpath -m "$WORKSPACE" 2>/dev/null || echo "$WORKSPACE")

    if [[ ! "$canonical_path" == "$canonical_workspace"/* ]]; then
        write_anomaly "integrity" "failed" ",\"message\":\"Manifest path outside workspace - possible path traversal\""
        return 1
    fi

    # Use jq only for JSON validation (not python3 - avoids arbitrary file read)
    if ! jq empty "$MANIFEST_FILE" 2>/dev/null; then
        write_anomaly "integrity" "warning" ",\"message\":\"Manifest is not valid JSON\""
        return 2
    fi

    return 0
}

check_disk_space() {
    local workspace_usage
    workspace_usage=$(df -P "$WORKSPACE" 2>/dev/null | tail -1 | awk '{print $5}' | tr -d '%' || echo 0)

    if [[ "$workspace_usage" -gt 90 ]]; then
        write_anomaly "disk_space" "failed" ",\"usage_percent\":$workspace_usage,\"message\":\"Disk nearly full\""
        return 1
    elif [[ "$workspace_usage" -gt 80 ]]; then
        write_anomaly "disk_space" "warning" ",\"usage_percent\":$workspace_usage"
        return 2
    fi

    return 0
}

check_process_count() {
    # Check for runaway process spawning
    local loa_processes
    loa_processes=$(pgrep -f "loa|claude" 2>/dev/null | wc -l || echo 0)

    if [[ "$loa_processes" -gt 50 ]]; then
        write_anomaly "processes" "warning" ",\"count\":$loa_processes,\"message\":\"Many Loa processes\""
        return 2
    fi

    return 0
}

# =============================================================================
# Main
# =============================================================================

ensure_log_dir
rm -f "$ANOMALY_FILE"

exit_code=0
checks_run=0
checks_passed=0
checks_warned=0
checks_failed=0

run_check() {
    local name="$1"
    local fn="$2"

    ((checks_run++)) || true

    local result
    if $fn; then
        result=0
        ((checks_passed++)) || true
    else
        result=$?
    fi

    case $result in
        0)
            [[ "$JSON_OUTPUT" != "true" ]] && log "PASS: $name"
            ;;
        1)
            ((checks_failed++)) || true
            log "FAIL: $name"
            exit_code=1
            ;;
        2)
            ((checks_warned++)) || true
            log "WARN: $name"
            [[ "$exit_code" -eq 0 ]] && exit_code=2
            ;;
    esac
}

log "Starting health check (timeout: ${HEALTH_CHECK_TIMEOUT}s, mode: ${QUICK_MODE:+quick}${QUICK_MODE:-full})"

# Always run critical checks
run_check "R2 mount" check_r2_mount
run_check "Scheduler heartbeat" check_scheduler_heartbeat

# Skip remaining checks in quick mode
if [[ "$QUICK_MODE" != "true" ]]; then
    run_check "WAL size" check_wal_size
    run_check "Grimoire integrity" check_grimoire_integrity
    run_check "Disk space" check_disk_space
    run_check "Process count" check_process_count
fi

# Log final status
case $exit_code in
    0)
        log "All checks passed ($checks_passed/$checks_run)"
        ;;
    1)
        log "UNHEALTHY - LLM triage required ($checks_failed failed, $checks_warned warnings)"
        ;;
    2)
        log "DEGRADED - continuing with warnings ($checks_warned warnings)"
        ;;
esac

# Output JSON summary if requested
if [[ "$JSON_OUTPUT" == "true" ]]; then
    cat <<EOF
{
  "timestamp": "$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)",
  "status": "$(case $exit_code in 0) echo "healthy";; 1) echo "unhealthy";; 2) echo "degraded";; esac)",
  "exit_code": $exit_code,
  "checks": {
    "run": $checks_run,
    "passed": $checks_passed,
    "warned": $checks_warned,
    "failed": $checks_failed
  },
  "mode": "${QUICK_MODE:+quick}${QUICK_MODE:-full}",
  "timeout_seconds": $HEALTH_CHECK_TIMEOUT
}
EOF
fi

exit $exit_code
