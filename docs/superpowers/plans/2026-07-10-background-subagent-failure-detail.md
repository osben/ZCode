# Background Subagent Failure Detail

> Historical implementation plan (2026-07-10), implemented and archived. Kept for the
> background subagent failure-message propagation contract. Referenced as a completed
> historical plan by `docs/plans/2026-07-15-subagent-summary-side-pane-only-plan.md`.

**Goal:** Preserve a background subagent provider failure message end-to-end: task
notification, user-visible Agent result, failure hover, and snapshot restore.

## Contract

- Source selection: the background finalizer selects the child turn's structured error cause
  message once — for `Error` objects the original cause message is used unmodified (no
  whitespace normalization, no truncation; `String(error)` is kept for non-Error values).
  Trim is used only to reject empty failed errors; completed and stopped outputs remain
  byte-for-byte unchanged.
- The provider message is appended directly after
  `Agent <type> task "<description>" failed.` in the failed summary and placed in the
  notification `<error>` element (XML entities decode exactly once in the shared parser).
  It is not translated and no HTTP/code labels are synthesized.
- The shared notification parser (`packages/shared/src/background-task-notifications.ts`)
  carries the message into both desktop-continuous and web-remote-replayable projections.
  Live projections map failed notifications to `tool_call_update.error` in UI and services
  (`packages/ui/src/lib/zcodeSessionProjection.ts`,
  `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`).
- Snapshot restore: when a completed launch ACK has a matching failed notification, both
  snapshot mappers overlay failed/error; stopped/killed states and native
  `state.status === "error"` behavior are preserved.
- UI is unchanged: status copy stays `执行失败` (execution failed) with the existing
  hover/copy interaction exposing the provider message; no component, copy, i18n, or
  `ToolLayout.tsx` change.

## Out Of Scope

- The empty `finishReason=stop` subagent case and main-model 429 queue/retry semantics
  (child-only 429 is a representative failure, not the main-model behavior).

## Anchors

- Runtime: `apps/zcode-cli/packages/core/src/subagent/runner.ts`,
  `apps/zcode-cli/packages/core/src/subagent/completion-notification.ts`.
- Unit: `subagent-background.test.ts`, `backgroundTaskNotifications.test.ts`,
  `zcodeSessionProjection.test.ts`, `zcodeLegacyTaskCompatTaskIndex.test.ts`.
- E2E: `packages/desktop/test/e2e/conversation-session/conversation-session-background-subagent-rate-limit.test.ts`
  with case-local child-only 429 fixtures (`retry-after: 0`, `lastUserMessageIncludes`
  scoping so parent requests cannot match).
