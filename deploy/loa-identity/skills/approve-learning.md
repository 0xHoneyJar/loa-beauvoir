# /approve-learning

Approve a pending self-improvement learning.

## Usage

```
/approve-learning <learning-id>
```

## Description

Self-improvement learnings (target: 'loa') require human approval before activation. This skill approves a pending learning and activates it.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `learning-id` | Yes | UUID of the pending learning |

## Behavior

1. Validates the learning exists in `pending-self/`
2. Verifies it hasn't already been approved
3. Moves learning to active store with status 'active'
4. Records approval timestamp and approver
5. Removes from pending-self directory

## Example

```
/approve-learning abc12345-6789-...

✅ Learning abc12345... approved and activated

Trigger: When container fails to start due to missing env vars
Pattern: Check required environment variables early in startup
Solution: Add validation function at start of start-loa.sh

This learning will now be applied to future Loa improvements.
```

## Safety

- Only self-improvement learnings require approval
- Other targets (devcontainer, moltworker, openclaw) are auto-activated
- Approved learnings can be reverted with `/revert-learning`

## Related

- `/revert-learning` - Revert an activated learning
- `/state-status` - View all pending learnings
