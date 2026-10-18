# Subagent model override sync

## Contract

The built-in / plugin subagent model + reasoning control (`SubagentModelOverrideControl` in `packages/ui/src/settings/SubagentsSection.tsx`) keeps a local `config` that is optimistic while a write is pending. Its owners:

- **Persisted value:** the subagents service (`setBuiltInModelOverride` / `setPluginAgentModelOverride`), projected back through `subagentsService.list` into `agent.modelSelectionOverride`.
- **Displayed value:** the control's local `config`. It has two write paths:
  1. a user edit (`persistConfig`), which sets the optimistic value, then commits it or rolls back to the previous value on write failure;
  2. a server sync, which adopts `agent.modelSelectionOverride` only when the override **value** (model value + reasoning level) differs from the one last adopted.

Server sync is derived during render (React's "adjust state when a prop changes" pattern), not in a passive `useEffect`:

```
list() resolves ─▶ setAgents ─▶ render(row) ─▶ commit
                                   │
                                   └─ override key unchanged? keep config (no queued write)
user edit ─▶ setConfig(optimistic), setPending(true) ─▶ write ─▶ refresh ─▶ render(row)
                                                                    └─ key changed? adopt server value
```

## Why

The previous sync ran as `useEffect(() => setConfig(fromOverride), [agent.modelSelectionOverride])`. A passive effect always runs on mount and whenever the override object identity changes, and it runs _after_ commit on a Scheduler task. Two failures followed:

- When a user edit landed between the row's commit and the deferred flush of its mount effect, React flushed the effect first during the edit's render and the effect's `setConfig(fromOverride)` was queued after the optimistic `setConfig`. The control showed `disabled: true` with the old value. Under CI load this made `packages/ui/test/subagentsSection.test.ts` flaky ("keeps the committed built-in config when the follow-up refresh fails", "restores the previous built-in model config when persistence fails").
- Any list refresh during a pending write (manual Refresh, plugin-inventory refresh) produced new override objects with the old value and reverted the optimistic display.

## Acceptance scenarios

- A thought-level or model edit shows the new value immediately, disabled while the write is pending, even if the user acts before the row's mount effects have flushed.
- A list refresh that returns the same persisted override while a write is pending does not revert the optimistic value.
- After a successful write, the control shows the committed value; a failed follow-up refresh does not roll it back.
- A failed write restores the previous value.
- A refresh that returns a different persisted override (changed elsewhere) is adopted.

Regression coverage: `packages/ui/test/subagentsSection.test.ts`.
