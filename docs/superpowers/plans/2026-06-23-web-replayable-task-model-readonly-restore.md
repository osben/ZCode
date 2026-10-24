# Web Replayable Task Model Readonly Restore

> Historical implementation record (2026-06-23), kept for the `resumeModelPolicy` semantics. The
> current restore authority for conversations is the V4 projection/snapshot; the old UI entry
> points (`useTaskRestore`, `useTaskStreamEvents`) have been deleted and are not new-feature
> entry points. `resumeModelPolicy` is still retained by the task compatibility adapter
> (`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`).

**Goal:** let mobile `web-remote-replayable` open historical tasks whose exact model is
unavailable without breaking desktop `desktop-continuous`.

## Policy Semantics

- Snapshot params accept `resumeModelPolicy?: "task-index" | "ui-resolved-only"`.
- The mobile replayable restore path sets `"ui-resolved-only"` when the historical model is known
  unavailable with no resolved fallback, when the provider snapshot has not hydrated yet, or when
  task meta has not reached UI state yet. Desktop restore never sets it.
- With the policy set, `zcodeTaskServiceAdapter.getTaskSnapshot` skips task-index resume hints
  only when `clientMode` is `web-remote-replayable`; `agent.resumeSession` is called without a
  model even if task index meta has one. The follow-up `resumeTask` is skipped for that read-only
  open and `snapshot.meta` serves as the restored meta.
- Post-open web replayable snapshot sync also passes `resumeModelPolicy: "ui-resolved-only"` so
  event/gap/terminal snapshot alignment cannot reintroduce the unavailable task-index model after
  model switching.
- The policy is part of the UI snapshot dedupe/cache key.
