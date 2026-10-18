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

## Custom subagent edit form (`SubagentForm`)

The same sync rule applies to the user-agent edit form (`SubagentForm` in `packages/ui/src/settings/SubagentsSection.tsx`).

- **Persisted value:** the agent Markdown file, projected through `subagentsService.list` into `agents`. The section passes `currentEditingAgent` (looked up by id in `agents` on every refresh) to the form as `initial`.
- **Draft:** the form's local field state (name, description, color, model, thought level, AGENTS.md injection, tools, system prompt). It has two write paths:
  1. user edits, which only change the draft until Save;
  2. a server sync, which replaces the whole draft (and clears validation errors) with a snapshot of `initial`. It runs only when the snapshot **value** (`createSubagentFormInitialStateKey`: agent id + every form field) differs from the one last adopted.
- **Policy:** a refresh that returns the same value with new object identity keeps the draft. A refresh that returns a different value (the file changed elsewhere) replaces the draft. Save closes the form, so the post-save refresh never reaches an open form.

Server sync runs during render, not in a passive `useEffect`:

```
list() resolves ─▶ setAgents ─▶ render(form, initial') ─▶ commit
                                   │
                                   ├─ key unchanged? keep draft (no queued write)
                                   └─ key changed? replace draft before commit
user edit after that commit ─▶ applied on top of the adopted snapshot
```

### Why

The previous sync was a passive effect keyed on `[initial, initialFormStateKey]` and guarded by a ref holding the last key. The guard made it a no-op on mount and on same-value refreshes. When the value did change, the effect wrote the snapshot _after_ commit. That commit still showed the old draft. An edit landing between that commit and the passive flush was queued before the effect's setters, so the effect overwrote it. A real trigger is the late plugin-inventory refresh (`initialize` resolving after the first `list()`) picking up an agent file changed elsewhere while the form is open.

### Acceptance scenarios

- An edit made before the form's mount effects flush is kept.
- A refresh that returns the same agent value with new object identity keeps every draft field.
- A refresh that returns a changed agent value replaces the draft.
- An edit made in the commit that delivers a changed snapshot, before passive effects flush, is applied on top of the new snapshot and kept.

Regression coverage: `packages/ui/test/subagentsSection.test.ts`.
