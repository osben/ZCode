# PermissionRequest Hook and Approval Interaction Race (Permission Responder Race)

Maturity: `L3 Implementation Contract`. This document revises the execution order of decision priority
items 7/8 of `hooks.md` and step 4 of the runtime flow in `permission-broker.md`; this document wins over
both.

## Background (incident root cause)

Incident on a real machine, 2026-08-26: the user configured a synchronous `PermissionRequest` command
hook (vibe-island bridge, matcher `.*`) that forwards the permission request to an external UI and
**blocks until the external click**. Under the old order this deadlocked:

```
core (permission-flow)            UI (v4)                     hook (vibe-island)
──────────────────────            ───────                     ──────────────────
emitPermissionRequested ────────► confirmation window rendered
                                  (reply channel not yet set up)
await runPermissionRequestHooks ────────────────────────────► external UI shown, blocks
        │                         user clicks Start
        │                         resolveInteraction ──► ✗ no pending interaction (silently dropped)
        ▼
(only after the hook returns with no decision)
permissionBroker.requestPermission ► registers reply deferred  ← channel only set up here
```

Three stacked defects:

1. **Ordering defect (fixed here)**: between the confirmation window becoming visible
   (`emitPermissionRequested` sent) and the reply channel being set up (broker registers the interaction
   deferred), an unbounded third-party hook sat in series. Every reply inside that window was silently
   dropped by `resolveInteraction` under idempotent semantics.
2. A stuck hook has no escape: the confirmation window is dead forever and the turn hangs forever. Tools
   with `alwaysAsk` (`CreateWorkflow`) take the ask path in every permission mode, so they always
   expose it.
3. Residual risk (not fixed here, see the end): the runner `await`s the `HookRunStarted` event before
   running the hook callback (`runner.ts`); that await is not covered by the hook timeout, so a stuck
   event pipeline defeats even the 60s timeout.

## Design decisions

| Fork | Decision |
|---|---|
| Hook semantics | Keep decision power (allow/deny/modify); do **not** turn it into a notification-only async hook, because the click in an external UI could then never return a decision |
| Execution order | The hook chain and the broker wait **race concurrently**; the first decision wins |
| First decision | A single settled latch; the late side's result is void |
| Loser handling | Abort immediately (AbortSignal propagates to the hook child process / broker reverse RPC) and **do not wait** for its cleanup; waiting would make a stuck hook a blocking point again |
| Hook chain failure/timeout | Treated as "that responder withdraws": warn log and keep waiting for the broker; it is **no longer** turned into deny. A fault in an auxiliary responder must not make the deny decision for the user |
| No hook configured | The race degrades to a one-sided broker wait, byte-for-byte equivalent to the old path |
| Policy-type forced deny | Belongs to the `PreToolUse` hook (can deny before the confirmation window appears and takes no part in the race); the `PermissionRequest` hook is narrowed to "another reply surface" |
| Loser external UI cleanup | v1 relies on abort → child process termination only; external integrations should read "terminated" as "already answered elsewhere". A separate notification-type `PermissionResolved` hook event is left for later |

## New order

```
core (permission-flow)            UI (v4 / TUI)               hook (external reply surface)
──────────────────────            ─────────────               ──────────────────
emitPermissionRequested ────────► confirmation window rendered
        │
        ├─ start broker wait concurrently ─► reply deferred registered (clicks reach it at any time)
        ├─ start hook chain concurrently ─────────────────────► external UI shown
        │
        └─ await first of {hook decision, broker reply, broker timeout/cancel}
                                  user clicks Start
                                  resolveInteraction ──► ✓ hits the deferred, race closes
        abort loser ──────────────────────────────────────────► hook child process receives abort
emitPermissionResolved ─────────► confirmation window removed  (the external UI should dismiss itself)
```

State machine (race latch of one ask):

```
            ┌─────────────── racing ───────────────┐
            │  hookPending: true   brokerPending: true │
            └──┬───────────┬───────────┬────────────┘
 hook decision first│ broker reply first│ broker reject/timeout/cancel│
               ▼               ▼                     ▼
        settled(hook)    settled(broker)      throw (old catch → deny)
        abort broker     abort hook           abort hook
               │               │
   hook no decision/failure: no transition, only the broker wait remains (hookPending: false)
```

## Contract

New core-internal module `packages/core/src/tool/executor/permission-responder-race.ts`:

```ts
interface PermissionResponderRaceInput {
  /** Hook chain: resolving undefined means no decision (withdraw); throwing is also a withdrawal and calls onHookFailure. */
  runHooks: (signal: AbortSignal) => Promise<PermissionBrokerResult | undefined>;
  /** Broker wait: registering the reply deferred must finish synchronously inside this call (existing contract). */
  requestBroker: (signal: AbortSignal) => Promise<PermissionBrokerResult>;
  signal?: AbortSignal;          // outer turn cancellation, aborts both sides
  onHookFailure?: (error: unknown) => void;   // called when the hook chain throws while the broker still waits (warn log)
}

interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}
```

Detailed semantics:

- When `requestBroker` rejects (timeout, cancel, no-broker fail-closed) and the hook has not won, the
  rejection is rethrown unchanged and the hook chain is aborted; the error shape matches the old
  catch → deny path.
- A rejection produced by aborting the broker after the hook wins must be swallowed (it is our own
  cancellation); the same holds in reverse.
- The loser's promise is not awaited: a `catch` must be attached to prevent unhandled rejection; its
  cleanup is bounded by the hook timeout (60s default) and abort propagation.
- A `modify` decision can come only from a winning hook (the broker's modify uses the existing path) and
  reuses the post-modification input recheck of `recheckPermissionHookModifiedInput`.

## Compatibility and behavior changes

1. **A hook chain error no longer denies** (intentional behavior change): the old
   `runPermissionRequestHooks` throwing → catch → the whole call failed as deny. The new path logs warn
   and keeps waiting for the user. Reason: the runner already collapses a single hook failure/timeout
   into "no decision"; what can still throw to this layer is infrastructure faults (event pipeline,
   admission crash), unrelated to the user's approval intent.
2. **The TUI prompt may appear first and then be dismissed by a hook decision**: in the old path the hook
   ran first, so with a hook decision the TUI never saw a prompt. In the new path the broker starts
   immediately; the prompt appears first and is dismissed by `PermissionResolved` once a hook decision
   arrives. The v4 desktop already rendered first (event sent first), so this only aligns both client
   types. The broker implementation must keep honoring the existing contract "support AbortSignal, abort
   cleans the pending prompt" (`permission-broker.md`).
3. **Policy semantics**: a user click may beat a hook's deny decision. A forced deny the user must not be
   able to override has to use a `PreToolUse` hook (effective before ask) or a permission deny rule; the
   `PermissionRequest` hook no longer guarantees to precede the user's reply.

## Test requirements

Executor level (`packages/core/tests/permission-responder-race.test.ts`):

- When the hook chain never returns, the broker `requestPermission` is still called immediately (the
  reply channel is set up before the hook finishes; direct regression of the incident).
- Broker replies allow while the hook is undecided: the tool runs and the hook chain receives abort.
- Hook decision allow/deny first: the broker receives abort, the result closes per the hook decision,
  and the `PermissionResolved` event is emitted normally.
- Hook decision modify first: the modified input takes effect (reusing the recheck path).
- Hook chain with no decision (returns undefined): fully degrades to the one-sided broker wait.
- Hook chain throws: the warn callback fires, the broker reply still takes effect, no deny is produced.
- Broker rejection (no-broker fail-closed / timeout / outer cancel): error shape matches the old path
  and the hook chain receives abort.
- Both sides decide in the same tick: only one winner, no duplicate `PermissionResolved`.

Runner level (existing coverage, nothing new): hook timeout/cancel distinction is pinned by
`hook-runner-lifecycle.test.ts`.

## Residual risk (recorded, not fixed here)

- `InMemoryHookRunner.run` does `await emitHookEvent(HookRunStarted)` before the hook callback; the
  await is not covered by the hook timeout, so a stuck event pipeline freezes the whole hook chain. The
  race keeps the confirmation window from freezing (the broker side works as usual), but the hook
  chain's own observability events go missing. Lifecycle event emission can later be made bounded or
  non-blocking.
- External reply surfaces (vibe-island type) get only a process termination signal on the loser path,
  with no structured "already answered elsewhere" notification; a notification-type `PermissionResolved`
  hook event is left as a later proposal.
