# Filesystem Requirements

## Overview

The Beauvoir Resilience system requires specific filesystem characteristics for reliable operation of the Write-Ahead Log (WAL), atomic file operations, and crash recovery.

## Supported Filesystems

### Fully Supported

| Filesystem | Notes |
|------------|-------|
| **ext4** | Primary target. Full POSIX semantics, reliable fsync, atomic rename. |
| **xfs** | Well-tested. Excellent performance for large files. |
| **overlayfs** | Docker default. Supported via underlying ext4/xfs. |
| **btrfs** | Supported. Copy-on-write may affect fsync behavior. |

### Conditionally Supported

| Filesystem | Notes |
|------------|-------|
| **APFS** | macOS. Supported for development. Not recommended for production. |
| **ZFS** | Supported. Ensure `sync=standard` for correct fsync behavior. |
| **tmpfs** | For ephemeral testing only. Data lost on restart. |

### Not Supported

| Filesystem | Reason |
|------------|--------|
| **NFS** | No atomic rename across directories, unreliable flock. |
| **CIFS/SMB** | No POSIX semantics, unreliable locking. |
| **Windows NTFS** | Different rename semantics, potential locking issues. |
| **FAT32/exFAT** | No POSIX permissions, no fsync guarantee. |

## Required Operations

The WAL system depends on these filesystem operations behaving correctly:

### 1. Atomic Rename

```
write(temp_file)
fsync(temp_file)
rename(temp_file, target_file)  # Must be atomic
```

**Requirement**: Rename must be atomic - either the old file or the new file exists, never neither.

### 2. Append-Only Writes

```
append(wal_segment, entry)
fsync(wal_segment)
```

**Requirement**: Appended data must be durably written after fsync returns.

### 3. File Locking

```
flock(lock_file, LOCK_EX)  # Exclusive lock
```

**Requirement**: Exclusive locks must prevent concurrent access.

### 4. Directory fsync

After creating files in a directory, the directory itself should be fsynced to ensure the directory entry is durable.

## Docker/Container Considerations

### Overlay Filesystem

Docker's default storage driver uses overlayfs. The WAL system works correctly because:

1. WAL directory is mounted as a volume (bypasses overlay)
2. Volume mounts go directly to the underlying filesystem
3. The underlying filesystem (typically ext4) handles durability

### Recommended Volume Configuration

```yaml
# docker-compose.yml
services:
  beauvoir:
    volumes:
      # WAL volume - use named volume for reliability
      - wal_data:/data/wal

      # Grimoires - can be bind mount for git integration
      - ./grimoires:/workspace/grimoires

volumes:
  wal_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /var/lib/beauvoir/wal
```

### Volume Driver Requirements

- **local**: Default, works with ext4/xfs
- **overlay2**: Works correctly for volumes
- **devicemapper**: Supported, ensure direct-lvm mode
- **btrfs**: Supported with default subvolume settings

## Verification

### Runtime Check

The WAL manager performs a filesystem verification on startup:

```typescript
async function verifyFilesystem(path: string): Promise<{
  supported: boolean;
  filesystem: string;
  warnings: string[];
}>;
```

### Manual Check

```bash
# Check filesystem type
df -T /data/wal

# Expected output for supported filesystem:
# Filesystem     Type  ...
# /dev/sda1      ext4  ...

# Test atomic rename
touch /data/wal/test.tmp
sync
mv /data/wal/test.tmp /data/wal/test.final
rm /data/wal/test.final
```

## Integration Test Matrix

The following matrix should be tested before deployment:

| Scenario | ext4 | xfs | overlayfs | NFS |
|----------|------|-----|-----------|-----|
| WAL append + fsync | ✅ | ✅ | ✅ | ❌ |
| Atomic rename | ✅ | ✅ | ✅ | ❌ |
| flock exclusive | ✅ | ✅ | ✅ | ⚠️ |
| PID lockfile | ✅ | ✅ | ✅ | ⚠️ |
| Crash recovery | ✅ | ✅ | ✅ | ❌ |
| Segment rotation | ✅ | ✅ | ✅ | ❌ |

Legend: ✅ Supported | ⚠️ Unreliable | ❌ Not Supported

## Troubleshooting

### "WAL is locked by process X"

Another process holds the WAL lock. Either:
1. Another instance is running (expected)
2. Previous instance crashed without cleanup

**Resolution**: Check if process X is still running. If not, remove `/data/wal/wal.pid`.

### "Checksum mismatch during replay"

Data corruption detected during WAL replay.

**Resolution**: The WAL manager truncates to the last valid entry. Check for:
- Filesystem full conditions during previous run
- Hardware issues (failing disk)
- Improper shutdown (container killed without graceful stop)

### "fsync returned error"

The filesystem cannot guarantee durability.

**Resolution**: Check:
- Disk space (`df -h`)
- Disk health (`smartctl -a /dev/sda`)
- Filesystem type (ensure supported)

### Slow Rotation

Segment rotation taking too long.

**Resolution**:
- Increase `maxSegmentSize` if segments fill quickly
- Check disk I/O with `iostat`
- Consider SSD for WAL directory

## Performance Considerations

### Optimal Configuration

```
/data/wal/           # On fast storage (SSD preferred)
  ├── checkpoint.json
  ├── wal.pid
  ├── wal.lock
  └── segment-*.wal  # Append-only segments
```

### fsync Frequency

The WAL manager calls fsync:
- After each entry append (durability guarantee)
- After checkpoint writes
- Before segment rotation

For high-throughput scenarios, consider batching entries with a small delay (e.g., 10ms) to reduce fsync calls.

### Segment Sizing

| Workload | Recommended Size | Rotation Period |
|----------|------------------|-----------------|
| Low | 10MB | 1 hour |
| Medium | 50MB | 1 hour |
| High | 100MB | 30 minutes |

---

*Last Updated: 2026-02-03*
*Version: 1.0.0*
