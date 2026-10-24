# Web Replayable Task Model Readonly Restore Design

Mobile `web-remote-replayable` opens historical tasks via snapshot restore. `getTaskSnapshot` backfills the historical model from the task index when no explicit model is given and then calls `session/resume`; if that exact provider/model is gone from the registry, the service throws `ZCODE_RUNTIME_MODEL_UNAVAILABLE`. Desktop `desktop-continuous` already degrades in a UI helper (restore the history, ask the user to pick an available model); mobile had no equivalent — the first snapshot failed and surfaced as a plain chat error banner. This spec fixes only the mobile replayable open path; desktop behavior is unchanged.

Design:

- Task snapshot parameters gain `resumeModelPolicy: "task-index" | "ui-resolved-only"` (mobile-specific). Default `"task-index"` keeps existing behavior.
- Only when `clientMode === "web-remote-replayable"` and the policy is `"ui-resolved-only"` does `zcodeTaskServiceAdapter.getTaskSnapshot` skip task-index model backfill.
- `useTaskRestore` (mobile replayable branch) uses `"ui-resolved-only"` for the first-screen snapshot when: pre-restore resolution says the historical model is unavailable with no visible-model fallback; the provider snapshot is not yet hydrated (the UI cannot reliably judge availability, so no old-model hint may reach the runtime — the toolbar re-evaluates after hydration and auto-switches to the first visible available model); or the provider snapshot is hydrated but the task meta is not yet in the UI store (task meta source `missing`) — in all cases the host must be blocked from backfilling the old model before the UI fallback decision.
- The readonly restore branch also skips the follow-up `resumeTask` (it would backfill the same unavailable model). The UI renders history from snapshot meta and keeps the task-scoped `ZCODE_RUNTIME_MODEL_UNAVAILABLE` state.
- Later readonly snapshot syncs on the mobile replayable path (stream events, session events, gap recovery) also use `"ui-resolved-only"`: they only calibrate UI messages, queue, and runtime state, and must not re-backfill the historical model after the user has switched.
- Once the toolbar auto-switches or the user picks a model, subsequent sends go through the existing task config model restore chain.

Boundaries: `zcodeAgentService.resolveRuntimeModelConfig` keeps its hard historical-session validation; no silent switch to the registry's first model; desktop snapshot/resume/queue/stream semantics unchanged; no task/model business state sinks into relay or desktop main.

Verification: UI tests cover the readonly snapshot carrying `resumeModelPolicy: "ui-resolved-only"` (including the not-hydrated and meta-missing cases, with desktop never using it) and follow-up syncs carrying it; service tests cover no task-index backfill under the policy and that default `web-remote-replayable` still backfills.
