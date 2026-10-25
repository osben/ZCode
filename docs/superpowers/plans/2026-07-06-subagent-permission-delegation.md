# Subagent Blocking Interaction Delegate

> Historical implementation plan (2026-07-06) with a 2026-07-24 V4 projection regression
> revision, kept for the subagent blocking interaction delegate contract. The runtime surface
> is also recorded in
> `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`.

**Goal:** When a child runtime raises a blocking interaction — a normal permission ask,
`AskUserQuestion`, or `ExitPlanMode` approval — the parent-visible interaction channel shows
it and returns the response, with child/subagent attribution kept in the payload. Without
this delegation, subagent Bash/AskUserQuestion/ExitPlanMode paths wait for user input with no
popup and hang (incident ticket `ZCT-2073779059361222656`).

## Architecture

- A core subagent interaction broker delegate
  (`createSubagentInteractionBroker`,
  `apps/zcode-cli/packages/core/src/runtime/helpers/subagent-interaction-broker.ts`)
  rewrites the outward `sessionId` of child `PermissionBrokerPort` blocking requests to the
  parent session id and attaches `origin.kind="subagent"` metadata
  (`parentSessionId`, `childSessionId`, `agentId`, `agentType`, `description`,
  `parentToolCallId`, `parentTurnId`, `childTurnId`).
- bootstrap keeps routing by toolName to `interaction/requestPermission` or
  `interaction/requestUserInput`; service/task/UI keep routing pending permissions and
  elicitations by parent task/session; user responses return to the child tool executor
  along the existing protocol request promise.
- Provider runtime headers (including the official-version security validation) already route
  through the existing parent-routed wrapper
  (`createSubagentProviderRuntimeHeadersPort()`); they are regression-verified only, not
  redesigned.

## Rules

- Routing identity is the parent session/task; child identity appears only in `origin`
  metadata. The UI never subscribes to child sessions and never renders a child task row.
- Child runtime events, model-io and the event store keep the child session id.
- `toolCallId` keeps the child tool call id; the parent `Agent` tool call id goes to
  `origin.parentToolCallId`, so child tool result backfill is not broken.
- Permission policy stays owned by the child runtime; the delegate only proxies
  ask/user-input routing and never replaces child permission decisions with parent ones.
- `childMode === "yolo"` keeps `createDenyPermissionBroker()` (no popups).
- Service pending keys stay `workspace + sessionId + requestId` on the parent-routed session
  id; `respondPermission()` / `respondElicitation()` keep `sessionId: params.taskId`; no
  child-session response fallback and no child session event emission.
- Desktop `desktop-continuous` and web remote `web-remote-replayable` boundaries are
  unchanged: pending permissions and elicitations project onto the parent task
  snapshot/event, and mobile `/remote` recovers parent task state through replayable.
- Multiple subagents or multiple pending child requests are handled independently by
  `requestId`; parent stop/cancel aborts child pending permission/elicitation instead of
  awaiting forever.
- Protocol schemas in `packages/shared/src/zcode-protocol/index.ts` stay strict and keep
  `origin` optional so all pre-existing permission/user-input requests are unaffected.

## 2026-07-24 V4 Authoritative Projection Regression

After V4 became the authoritative conversation UI source, popups can no longer rely only on
the reverse RPC and the task-local pending map: `ProductProjection` must first see
`PermissionRequested` in the parent conversation topic. `mirrorSubagentToolEvent()` mirrored
only the normal tool lifecycle and missed `PermissionRequested`, `PermissionResolved` and
`PermissionDenied`, so the broker promise was already waiting while the main task had no
renderable, submittable pending interaction (child `permission_requested` events only reached
the child event chain).

Authoritative chain:

```text
child AgentRuntime
  -> child PermissionRequested(toolCallId=childTool) -> child event store / child projection
  -> parent live mirror (sessionId=parentSession, toolCallId=mirroredParentTool,
     origin={kind:subagent, childSessionId, parentSessionId, ...})
  -> parent ProductProjection.pendingInteractions
  -> V4InteractionDialogs (main task)
  -> resolveInteraction(requestId)
  -> parent-routed interaction registry / broker promise
  -> child PermissionResolved
  -> parent live mirror clears the parent pending interaction
```

Key owners: `apps/zcode-cli/packages/core/src/subagent/tool-event-mirror.ts`
(`mirrorSubagentToolEvent`), `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
(`ProductProjection.onPermissionRequested` / `settlePermission`),
`packages/ui/src/v4/V4InteractionDialogs.tsx`.

### Must-Preserve Invariants

- `requestId` is never rewritten; the child broker response settles the original request
  promise.
- Child tool call ids never enter parent tool rows; the parent mirror uses a stable mirrored
  id and keeps attribution in `childToolCallId` / `origin`.
- The parent mirror goes only to the live sink and is not re-persisted into the parent event
  store; raw child interaction events keep writing to the child session only.
- Legacy reverse RPC and V4 `resolveInteraction` keep racing idempotently; no second response
  route may be added.
- Desktop continuous and mobile replayable consume the same parent canonical projection, with
  recovery pacing kept isolated by the existing `clientMode` / `deliveryKind` boundaries.

### Coverage Status

- T01 (child `AskUserQuestion` parent projection) and T02 (child Bash permission) share the
  same permission event mirror; representative tests only. Child `ExitPlanMode` shares the
  same broker chain; no separate E2E state permutation.
- Concurrent/background child cases and mobile reconnect were pruned: the event mirror works
  by agent/tool/request identity, and no replay/snapshot schema change was made.
- No new conversation E2E case was created in that revision: the coverage matrix entries were
  corrected from an incorrect `covered` to `partial`, and `SD` stayed in
  `manual-review/pending` behind core mirror tests until its later promotion to
  `packages/desktop/test/e2e/conversation-session/conversation-session-subagent-interaction-delegate.test.ts`
  and the formal gate (see the coverage matrix `SD` group).

## Non-Goals

- No new stdio permission wire protocol; the existing
  `interaction/requestPermission` / `interaction/requestUserInput` protocol requests stay.
- No change to `AskUserQuestion` / `ExitPlanMode` product interaction semantics, permission
  ruleset, project approval persistence format, or the permission decision algorithm.
- No durable permission outbox; the protocol request promise and the service pending map
  stay.
- No teammate/swarm/worktree isolation/TaskOutput/TaskStop/full SDK control protocol in this
  scope.
