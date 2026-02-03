# Recovery Engine Tuning Guide

## Overview

The Recovery Engine handles automatic state restoration on container startup. This document covers configuration options for tuning recovery behavior.

## Environment Variables

### Loop Detection

```bash
# Maximum failures before entering degraded mode
BEAUVOIR_LOOP_MAX_FAILURES=3  # default

# Time window for counting failures (minutes)
BEAUVOIR_LOOP_WINDOW_MINUTES=10  # default
```

**Tuning Guidance:**

| Scenario | Recommended Settings |
|----------|---------------------|
| Production (stable) | `MAX_FAILURES=3`, `WINDOW=10` |
| Development (fast iteration) | `MAX_FAILURES=5`, `WINDOW=5` |
| High-reliability | `MAX_FAILURES=2`, `WINDOW=15` |
| Recovery testing | `MAX_FAILURES=10`, `WINDOW=1` |

### Restore Sources

```bash
# R2 mount path (primary restore source)
R2_MOUNT=/data/moltbot

# Git repository (fallback)
LOA_GIT_REPO=https://github.com/org/repo.git
LOA_GIT_BRANCH=main
LOA_GIT_LOCAL_PATH=/workspace

# Grimoires directory
GRIMOIRES_DIR=/workspace/grimoires

# WAL directory
WAL_DIR=/data/wal
```

## Loop Detection Algorithm

The loop detector counts **failures**, not attempts:

```
Loop detected when:
  failures >= BEAUVOIR_LOOP_MAX_FAILURES
  AND all failures within BEAUVOIR_LOOP_WINDOW_MINUTES
```

### What Counts as a Failure

| Event | Counts as Failure |
|-------|-------------------|
| Manifest signature invalid | ✅ Yes |
| File checksum mismatch | ✅ Yes |
| R2 download error | ✅ Yes |
| Git clone/pull timeout | ✅ Yes |
| Template init error | ✅ Yes |
| R2 not available | ❌ No (expected) |
| Git not configured | ❌ No (expected) |

### Degraded Mode

When loop is detected:
1. `BEAUVOIR_DEGRADED=1` environment variable is set
2. Recovery engine stops attempting restores
3. After 1 hour, failures are reset and recovery retries

**Checking degraded status:**

```typescript
if (process.env.BEAUVOIR_DEGRADED === '1') {
  console.log('Running in degraded mode');
}
```

## Recovery Cascade

The engine tries sources in order:

```
START → CHECK_INTEGRITY → [OK] → RUNNING
                        ↓ [FAIL]
                    RESTORE_R2 → [OK] → VERIFY → RUNNING
                        ↓ [FAIL]
                    RESTORE_GIT → [OK] → VERIFY → RUNNING
                        ↓ [FAIL]
                  RESTORE_TEMPLATE → VERIFY → RUNNING
                        ↓ [FAIL]
                      DEGRADED
```

### Bypass Options

**Force Git restore (skip R2):**
```bash
# Don't mount R2
unset R2_MOUNT
```

**Force template restore:**
```bash
# Disable both R2 and Git
unset R2_MOUNT
unset LOA_GIT_REPO
```

## Integrity Verification

### What's Verified

1. **Manifest signature** - Ed25519 with multi-key verification
2. **File checksums** - SHA-256 for each file in manifest
3. **File existence** - All manifest files must exist

### Checksum Storage

Checksums are stored in the manifest:

```json
{
  "version": 1,
  "files": {
    "loa/BEAUVOIR.md": {
      "sha256": "abc123...",
      "size_bytes": 4096,
      "mtime": "2026-02-03T12:00:00Z"
    }
  },
  "signature": { ... }
}
```

**Important:** ETags are NOT used for integrity (they're often MD5). Only SHA-256 checksums from signed manifests are trusted.

## Performance Tuning

### Startup Time

| Component | Typical Time |
|-----------|--------------|
| Lock acquisition | <10ms |
| Manifest load + verify | 50-100ms |
| File checksum verification | 10-50ms per file |
| R2 restore (if needed) | 1-5s depending on size |
| Git clone (if needed) | 10-60s depending on repo |

### Reducing Startup Time

1. **Keep R2 available** - Fastest restore source
2. **Minimize critical files** - Fewer files = faster verification
3. **Use shallow git clone** - `--depth 1` is default

### Memory Usage

| Component | Memory |
|-----------|--------|
| Recovery engine | ~10MB |
| Manifest verification | ~1MB |
| File checksumming | ~4KB buffer |

## Monitoring

### Key Metrics

```
beauvoir_recovery_state{state="RUNNING|DEGRADED|..."}
beauvoir_restore_count_total
beauvoir_restore_source{source="r2|git|template"}
beauvoir_loop_failures_total
```

### Logs to Watch

```
[recovery] Integrity check passed          # Good
[recovery] R2 restore complete             # Good
[recovery] DEGRADED MODE: ...              # Alert!
[recovery] Loop detected: N failures in M minutes  # Alert!
```

## Troubleshooting

### "Loop detected" on every startup

**Symptoms:** Container repeatedly enters degraded mode

**Causes:**
1. R2 data corrupted
2. Git repo has invalid manifest
3. Signing key mismatch

**Resolution:**
```bash
# Reset loop counter
unset BEAUVOIR_DEGRADED

# Force template restore to bootstrap
unset R2_MOUNT
unset LOA_GIT_REPO

# Start container
# Then reconfigure sources after successful boot
```

### "Manifest signature invalid"

**Symptoms:** Restore fails at verification step

**Causes:**
1. Signing key rotated but not updated in container
2. Manifest modified without re-signing
3. Key compromise and revocation

**Resolution:**
```bash
# Check current key ID
node -e "import('./security/manifest-signer.js').then(m => console.log(new m.ManifestSigner().getActiveKeyId()))"

# Verify manifest signature matches expected key
```

### "File checksum mismatch"

**Symptoms:** Integrity check fails for specific file

**Causes:**
1. File modified since last manifest generation
2. Incomplete sync to R2
3. Network corruption during download

**Resolution:**
1. Re-run sync from local to R2
2. Re-generate and sign manifest
3. Check R2 bucket for consistency

---

## Quick Reference

### Minimum Config (Template Only)
```bash
GRIMOIRES_DIR=/workspace/grimoires
WAL_DIR=/data/wal
BEAUVOIR_LOOP_MAX_FAILURES=3
BEAUVOIR_LOOP_WINDOW_MINUTES=10
```

### Production Config
```bash
GRIMOIRES_DIR=/workspace/grimoires
WAL_DIR=/data/wal
R2_MOUNT=/data/moltbot
LOA_GIT_REPO=https://github.com/org/repo.git
LOA_GIT_BRANCH=main
LOA_PUBLIC_KEY=<hex-encoded-public-key>
BEAUVOIR_LOOP_MAX_FAILURES=3
BEAUVOIR_LOOP_WINDOW_MINUTES=10
```

---

*Last Updated: 2026-02-03*
*Version: 1.0.0*
