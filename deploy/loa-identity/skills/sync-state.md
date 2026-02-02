# /sync-state

Force immediate state synchronization to R2 and Git.

## Usage

```
/sync-state [--r2-only | --git-only]
```

## Description

Triggers immediate synchronization of grimoire state. By default, syncs to both R2 and Git. Useful before container shutdown or when you want to ensure state is persisted.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--r2-only` | No | Sync only to R2 |
| `--git-only` | No | Sync only to Git |

## Behavior

1. Flushes any pending WAL entries
2. Syncs to R2 (if not --git-only)
3. Commits and pushes to Git (if not --r2-only)
4. Reports sync status

## Example

```
/sync-state

🔄 Syncing state...

WAL: 5 pending entries flushed
R2: 5 files synced (last sync: just now)
Git: Committed and pushed (abc1234)

✅ State synchronized successfully
```

## Sync Intervals

Normal operation syncs automatically:
- **WAL → R2**: Every 30 seconds
- **R2 → Git**: On conversation end or hourly

Use `/sync-state` for immediate sync outside these intervals.

## Use Cases

- Before shutting down the container
- After critical updates to grimoires
- Before pulling upstream updates
- When switching contexts

## Related

- `/state-status` - View current sync status
