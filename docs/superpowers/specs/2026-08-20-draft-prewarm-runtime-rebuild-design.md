# Rebuilding the Draft Prewarm Session after a Runtime Generation Change

- Date: 2026-08-20
- Branch: `fix/draft-prewarm-runtime-rebuild` (based on `feat/cua-merge-0819`)
- Status: design confirmed, pending implementation

## Background

The user reported two symptoms; root-cause diagnosis shows they are two ends of one chain:

1. **Images cannot be uploaded** (dev): the attachment sits idle in the input box and can only be removed; the
   log has no `attachmentBeginV4`.
2. **After upload completes and Computer Use turns green, sending fails** (production): the image uploaded
   successfully but sending failed.

### Root cause

CUA Helper readiness unconditionally triggers an agent runtime recycle (the design comment at
`packages/services/src/node.ts:1094-1102` says this recycles stranded agents that got `BROKER_UNAVAILABLE`).
The recycle also flushes the just-created, not yet persisted session in generation 1:

```
10:42:46.139  attachmentCommitV4 OK                     image upload done (gen1)
10:42:46.340  cua helper ready pid=33314                "Computer Use turns green"
10:42:46.991  agent process exited pid=33308            recycle stranded agent
10:42:49.531  agent process started runtimeGeneration=2 new runtime
10:42:50.091  attachmentBeginV4 FAIL  sessionNotFound: sess_e0b036a8
10:42:50.129  subscribeConversationV4 FAIL  sessionNotFound: sess_e0b036a8
```

In draft state `effectiveSessionId = sessionId ?? prewarmSessionId` (`SessionPane.tsx:1487`); with
`sessionId === null` everything depends on the prewarm session. After the prewarm session disappears:

- `SessionPane.tsx:1637` calls `prewarmBinding.discard()` on a subscribe error;
- `discard()` sets `blockedInvalidationVersion = current.invalidationVersion`
  (`useDraftSessionPrewarm.ts:354`);
- `reconcile()` returns immediately when `blockedInvalidationVersion === requestedVersion` (`:313-315`), so it
  **does not rebuild for the same version**;
- `prewarmSessionId` stays null forever and the attachment is stuck in `waitingSession`: symptom 1.

On cold start, `createSession` failing with `ZCode Protocol client disposed` (`useDraftSessionPrewarm.ts:139-144`
only warns, no retry) reaches the same terminal state.

## Design choice

Confirmed in discussion: **tolerate the recycle and compensate afterwards**, rather than avoiding the recycle
on the services side.

Reason: the services-layer recycle semantics (introduced deliberately in this branch to fix "CUA tools never
load") stay untouched and risk concentrates in the renderer; the cost is that the user sees one short
re-upload.

Rejected/deferred alternatives:
- Distinguish the trigger source on the recycle side (`onHelperHealthy` cold-start first ready vs
  `onHelperCredentialsRotated`) so a workspace being served is not recycled.
- Give `ZCodeAgentService` an active-turn query and really wire up `hasActiveTurnRef` (`node.ts:1467`, currently
  `() => false`).

Neither conflicts with this design; they can be pursued separately later.

**The recycle has more than one trigger source**, which is the key reason to choose "compensate afterwards"
over "block at the recycle side". Besides the cold-start first ready, the liveness watchdog recovery path also
recycles. Dev log of 2026-08-20 12:26:

```
12:26:43.617  cua helper liveness: Helper unreachable (attempt 3); triggering resolver recovery
12:26:44.980  cua helper ready pid=97629
12:26:45.489  ZCode agent cleanup ... reason='workspace-dispose'
              runtimeIdentity: /Users/dev/.zcode/workspace/default:4:57273
```

The recycle fired 509ms after helper ready, and that workspace was already at generation 4. Blocking at the
recycle side would need to cover `onHelperHealthy`, `onHelperCredentialsRotated` and the liveness recovery,
a much larger change than renderer-side compensation.

## Goals

- After a runtime generation change, the draft state automatically obtains a prewarm session valid in the new
  runtime.
- Sending is disabled during the change and re-enabled on rebuild success or timeout.
- Attachments are automatically re-uploaded to the new session after the change, with no manual redo.

## Non-goals

- No change to the services-side recycle semantics; `hasActiveTurn` is not touched.
- No recovery for the formal session state (`sessionId !== null`): that path belongs to the CLI's
  `cold-session-resume.ts`.
- No change to the external interface of `useDraftSessionPrewarm`.

## Design

### 1. Trigger and rebuild chain

Reuse the existing path; no new subscription:

```
transport.onRuntimeRestart                         SessionPane props:446, already filtered by workspaceKey
  → new effect (only sessionId === null)
  → invalidateDraftRuntime(workspacePath, workspaceIdentity)    exists: zcodeSessionStoreWorkspaceSlice.ts:408
  → draftRuntimeInvalidationVersion + 1
  → reconcile(): clear blockedInvalidationVersion → retireCurrent → startCurrent
  → onReady → new binding → prewarmSessionId → effectiveSessionId
```

The only new code in **this section** is that effect in SessionPane (the gate and attachment changes are in
sections 2, 3 and 4). Rebuild, unblocking, single flight and old-session cleanup are existing coordinator logic:

- `reconcile()` clears `blockedInvalidationVersion` when `requestedVersion` changes
  (`useDraftSessionPrewarm.ts:297-302`), lifting the permanent block set by `discard()`;
- `retireCurrent()` → `controller.dispose()`, and `dispose()` calls `deleteSession` only when
  `promotionState === "draft"` (`:169`). **A session whose send is in progress (`pending`) is not wrongly
  deleted by a generation change**; this protection already exists.

**The formal session state does not trigger**: with `sessionId !== null`, `invalidateDraftRuntime` is not
called.

### 2. Send gate

SessionPane keeps a `draftRebuilding` state without changing the hook interface (`binding === null` cannot
tell "rebuilding" from "permanent fallback", but SessionPane knows whether it triggered the invalidation).

- Set `true` on invalidate.
- Set `false` when a new `prewarmBinding` arrives.
- Set `false` after a **5s timeout**, falling back to the existing "create the formal session on send" path
  (the `beginPromotion` branch at `SessionPane.tsx:1829` / `:1886`).
- A generation change during rebuild resets the timer.
- Wired into the `disabled` computation at `SessionPane.tsx:3494`.
- A hint text is shown so the button is not silently greyed out.

Timeout basis: measured agent `start → ready` is about 550-650ms, `createSession` takes a few hundred ms more;
5s leaves ample margin without making the user wait long.

**Permanent disabling is not allowed**: rebuild failure must fall back, otherwise the user cannot send any
message while the runtime stays abnormal.

Timeout and rebuild success are not mutually exclusive: after the timeout lifts the disable, a late
`prewarmBinding` still arrives normally and updates `effectiveSessionId`, waking attachments for re-upload.
The timeout only lifts the gate and does not cancel the rebuild.

### 3. Attachment re-upload race

On a generation change two chains touch attachments at once:

- the `onRuntimeRestart` callback at `useComposerAttachments.ts:461`: clears refs, `autoRetryCount + 1`,
  enqueues by `target.sessionId`;
- the effect at `:441`: when `attachmentSessionId` becomes truthy, re-enqueues `waitingSession`.

The problem is that `:461` reads `targetsRef.current`, a **stale value written during render** (`:192-199`).
When the generation-change event arrives it still holds the invalidated sessionId and enqueues with the old
id; this caused the `sessionNotFound` in the log.

Decouple the two chains:

- `:461` no longer decides to enqueue from `target.sessionId`; it **always sets `waitingSession`** (the old id
  is certainly invalid after a generation change) and `:441` wakes them uniformly;
- add `restartEpoch` (hook-internal state, incremented in the `onRuntimeRestart` callback) to the dependencies
  of the `:441` effect, forcing a rescan of `waitingSession` and enqueue after a generation change.

`restartEpoch` is required: in the formal session state `attachmentSessionId` does not change after a runtime
restart, so an effect depending only on it would not rerun and attachments would stay in `waitingSession`
forever.

Two attachment kinds are unaffected (already skipped at `:470-476`):
- `localZeroCopy` (local file drag-in whose `ref` is the local path and is never uploaded); this explains why
  the problem concentrates on pasted/screenshot images, which have no `localPath`;
- `referenceOwnership === "session"` (already sent with a message).

### 4. Re-upload quota

`:481` currently marks `failed` when `autoRetryCount >= 1`. A re-upload after a generation change is not
"retrying a failed upload" but "uploading again for a different session"; sharing the counter would let a
generation change burn the user-visible upload retry quota.

**Use two separate counters:**

- `autoRetryCount` keeps its original semantics (automatic retry of a failed upload itself), limit stays 1;
- new `runtimeRebuildRetryCount`, incremented only when a draft-state generation change triggers a re-upload,
  limit 5.

The counters are not merged because generation changes occur more often than first estimated: the dev log of
2026-08-20 12:26 shows the same workspace already at `runtimeGeneration=4` (3 changes), and the recycle trigger
source is not unique (see "Design choice"), so a single counter limited to 3 would be exhausted in normal use
and report false failures.

`restartEpoch` dedupes so **one generation change triggers only one re-upload**; the limit 5 is only a
safety net for a repeatedly crashing helper.

### 5. Tests

| Layer | Cases |
| --- | --- |
| coordinator | on `invalidationVersion` increment, retire + rebuild; `blockedInvalidationVersion` is cleared |
| controller | `dispose()` does not delete the session in `pending` state (regression protection) |
| attachments | after a generation change set `waitingSession`; enqueue once a new sessionId arrives; `restartEpoch` wakes them even when the formal-state sessionId does not change |
| attachments | no repeated re-upload within one `restartEpoch`; `failed` only when `runtimeRebuildRetryCount` reaches 5, without affecting `autoRetryCount` |
| gate | disabled while rebuilding; lifted when the new binding arrives; lifted on timeout with fallback |

Two known local pitfalls:

- If the timeout timer is `unref`ed, a defect is masked by the vitest runner (the runner itself keeps the event
  loop alive); a tsx subprocess probe is needed to verify, not just a unit test.
- Desktop-side `test/*.test.ts` belongs to no tsconfig, so the root `pnpm typecheck` does not cover it; verify
  separately when a change touches desktop.

## Boundaries and failure modes

| Case | Behavior |
| --- | --- |
| Another generation change during rebuild | `invalidationVersion` +1 again, reconcile retires + rebuilds again; gate timer resets |
| Generation change while a send is in progress | `promotionState === "pending"`, `dispose()` does not delete the session; the formal session is handled by cold-resume |
| Switching workspace | `invalidateDraftRuntime` targets by `workspacePath` / `workspaceIdentity`, other workspaces unaffected |
| Rebuild failure / timeout | lift the disable, fall back to the no-prewarm send path; attachments stay `waitingSession` until a valid session exists |
| Old session cleanup fails | harmless: the old session vanished with the runtime, and the `deleteCreatedSession` catch already ignores failure |

## Risks

- **Re-upload visibility**: the user sees the attachment progress bar return to 0 and upload once more. This is
  expected; make sure the copy (`chat.attachments.upload.runtimeRestarted`) does not read like an error.
- **Gate false alarm**: if `onRuntimeRestart` fires wrongly in a non-draft state it would needlessly disable
  sending for 5s. The effect is tightened with `sessionId === null` and covered in tests.
- **This design does not remove the recycle itself**: CUA Helper cold start still recycles the agent and the
  user still experiences one session generation change. Removing it fully needs one of the deferred
  alternatives above.
