# Local automations

`AutomationSpecV1` describes unattended coding work without broadening Vibe's
security model. New records default to plan mode, a read-only/network-off
sandbox, no branch mutation, a bounded timeout and spend ceiling, and `skip`
for both overlap and missed-run policy. Saving execute, write-enabled, branch,
or worktree automation requires an explicit mutation confirmation.

`AutomationStore` persists exact specs, history, and leases in a private
machine-local JSON file. A short cross-process lock serializes claims. Each due
time has a stable idempotency key; an active lease causes overlap to be recorded
as skipped, and an expired lease becomes an interrupted historical run during
restart recovery before new work can be claimed. Interval and five-field UTC
cron triggers are bounded and missed backlogs are not replayed.

The store does not execute prompts itself. A runtime supervisor must consume a
claim, enforce its timeout/spend/permission/sandbox/worktree contract, heartbeat
the lease, and report completion or cancellation. That separation keeps durable
scheduling independent from the engine and presentation shells.
