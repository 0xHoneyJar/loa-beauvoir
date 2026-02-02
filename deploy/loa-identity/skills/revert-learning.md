# /revert-learning

Revert and archive a learning that has degraded performance.

## Usage

```
/revert-learning <learning-id> [reason]
```

## Description

If an activated learning causes problems or degrades system performance, use this skill to archive it. The learning is not deleted but marked as 'archived' and will no longer be applied.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `learning-id` | Yes | UUID of the learning to revert |
| `reason` | No | Reason for reverting |

## Behavior

1. Finds the learning (active store or pending-self)
2. Updates status to 'archived'
3. Records reversion timestamp and reason in trajectory
4. Learning is preserved for future analysis but not applied

## Example

```
/revert-learning abc12345-6789-... "Caused startup delays"

⏪ Learning abc12345... reverted and archived

Reason: Caused startup delays
Previous Status: active
New Status: archived

This learning will no longer be applied.
```

## When to Revert

- Learning causes errors or crashes
- Performance has degraded since activation
- Learning doesn't apply as expected
- Better solution found

## Recovery

Archived learnings are preserved in the store with status 'archived'. They can be reviewed later and potentially re-activated with modifications.

## Related

- `/approve-learning` - Approve a pending learning
- `/state-status` - View learning effectiveness stats
