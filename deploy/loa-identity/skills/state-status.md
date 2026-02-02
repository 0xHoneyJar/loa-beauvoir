# /state-status

Show WAL, R2, and Git sync status along with learning statistics.

## Usage

```
/state-status
```

## Description

Displays the current state of the persistence layer and compound learning system.

## Output

```
📊 Loa Cloud Stack State Status

═══════════════════════════════════════════
WAL (Write-Ahead Log)
═══════════════════════════════════════════
  Entries pending R2:    3
  Entries pending Git:   5
  Last write:            2 minutes ago
  WAL file size:         12.4 KB

═══════════════════════════════════════════
R2 Storage
═══════════════════════════════════════════
  Connected:             ✅ Yes
  Last sync:             30 seconds ago
  Bytes synced:          1.2 MB

═══════════════════════════════════════════
Git Backup
═══════════════════════════════════════════
  Last sync:             45 minutes ago
  Last commit:           abc1234
  Pending changes:       5

═══════════════════════════════════════════
Compound Learning
═══════════════════════════════════════════
  Total learnings:       12
  Active:                8
  Archived:              3
  Pending approval:      1

By Target:
  - loa:           3 (1 pending)
  - devcontainer:  2
  - moltworker:    4
  - openclaw:      3

═══════════════════════════════════════════
Pending Self-Improvements (require approval)
═══════════════════════════════════════════
  abc12345...  When container fails to start...
               Created: 2 hours ago
               Gates: D:7 R:6 T:8 V:5 (Total: 26)

Use /approve-learning <id> to activate
Use /revert-learning <id> to reject
```

## Sections

### WAL (Write-Ahead Log)
Shows the local journal state and pending entries.

### R2 Storage
Shows cloud storage connectivity and sync status.

### Git Backup
Shows the cold backup sync state.

### Compound Learning
Shows learning statistics and pending approvals.

## Related

- `/sync-state` - Force immediate sync
- `/approve-learning` - Approve pending learnings
- `/revert-learning` - Revert activated learnings
