# WSL task status inconsistency: root cause and fix

Dates: 2026-08-21 (T1/T2), 2026-09-04 (T3). Status: analysis and fixes complete. Branch: `fix/wsl-status`.
Full history: git show 37b98ff8:docs/wsl-task-status-inconsistency.md (incident log timeline, full evidence tables).

## Symptom

For a WSL-connected project, the left task list and the chat area showed inconsistent task running
state, in both directions:

1. The task list spins (loading) while the chat task has finished.
2. The task list does not spin while the chat task is still running.

Environment: ZCode 3.9.0 (commit cb07e825, Windows 11, production), workspace `remote:wsl:default:/home/dev`;
evidence from a user log bundle (4 days of desktop logs, Windows-side CLI logs, `tasks-index.sqlite`).

## Conclusion (probable; root-cause mechanism confirmed)

The task list and the chat area read the same authoritative CLI state through two independent
subscription chains (sessions-index topic vs conversation topic). They diverge at the publish gate /
transport / recovery layers, and two implementation bugs violating declared invariants make the
divergence persistent:

1. **Consumer side (T1).** After the renderer `SessionsIndexStore` enters `status="error"`, it keeps the old projection, consumers do not check status, and `error` is a terminal state with no self-heal. A stale `phase=running` with no live proof keeps spinning, and once the subscription is dead new-turn running frames never arrive.
2. **Authority side (T2).** The CLI gateway silently drops phase transitions in a no-subscriber window via the `hasSubscribers()` gate, and a resubscribe that hits an existing publisher does not replay the live projection seed. Any later subscribe/resync snapshot keeps the stale phase.

The chat area has neither defect (the conversation store is rebuilt on every open; hydration
force-closes an unfinished turn as `TurnComplete(cancelled)`), so the surfaces diverge. WSL hits the
entry conditions often: that day the WSL Agent CLI changed generation 3 times (reopening the
workspace hard-kills and restarts it), sessions-index subscriptions flapped 7 rounds, and the same
transport stack's SSH bridge had one ECONNRESET. The grade is probable rather than confirmed only
because all renderer logs are no-ops in production builds (`packages/ui/src/logger.ts:38`), so the
two stores' state sequences at screenshot time cannot be replayed.

## Violated invariants (all declared in code/spec)

- "Task-list loading must be proven explicitly by the current runtime" (`packages/ui/src/lib/taskListItemPresentation.ts:28` comment; `packages/ui/src/v4/sessionsIndexStore.ts:585` dormant branch comment).
- "Reconnect recovers from snapshot / cold subscribe overwrites with the currently registered live projection" (`docs/v4-refactor/14-sessions-index.md:15,54`).
- "On CLI runtime restart, existing listeners receive the restart signal and each active store re-subscribes exactly once" (`docs/v4-refactor/04-sync-and-recovery.md:204,215-216`).

## Causal chain

```
Trigger: WSL bridge flap / user reopens the WSL workspace (CLI generation change)
   |
T1 (consumer): resync/recovery fails in the flap window
   -> failRecovery() only sets status="error"; no projection clear, no retry
      (sessionsIndexStore.ts:522-527; resync failure :459-468;
       handleFrame never moves status back to live)
   -> stale phase=running without live proof persists
   |
T2 (authority): TurnStarted/TurnComplete in a no-subscriber window dropped by the gate
      (v4-gateway.ts:816); resubscribe takes the existing branch, no live seed replay
      (v4-gateway.ts:932-940)
   -> any later snapshot keeps the old phase
   |
Downstream: useWorkspaceSessionsIndexItems consumes store.getSessions() unconditionally
      (useWorkspaceSessionsIndexItems.ts:177-191, no status check)
   -> stale running spins (symptom 1); with a dead subscription new running is invisible (symptom 2);
      the chat area shows the truth via its own conversation subscription + hydration self-heal
```

After the fix, the same failure clears the projection (no spinner claims without proof), then a
bounded-backoff fresh subscribe (`forceSnapshot`) returns the authoritative current value
(`status=live`, phase true), consistent with the chat area.

## Key evidence index

| #  | Fact                                                                                   | Location                                                                                              |
| -- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1  | List spinner trusts only sessions-index live phase, not persisted status               | `packages/ui/src/v4/taskListRowActivity.ts:35`, `packages/ui/src/lib/taskListItemPresentation.ts:24` |
| 2  | `error` keeps the old projection with no exit; only dormant clears correctly           | `packages/ui/src/v4/sessionsIndexStore.ts:522-527,459-468` (compare :585-590)                         |
| 3  | Consumer ignores status; error excluded from hydrating                                 | `packages/ui/src/v4/useWorkspaceSessionsIndexItems.ts:85-91,177-191`                                  |
| 4  | Store is a long-lived workspace-level object; tab switch/panel close do not rebuild it | `packages/ui/src/v4/sessionsIndexRegistry.ts:88-142`                                                  |
| 5  | CLI no-subscriber gate + existing publisher does not replay the seed                   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:816,932-960`                   |
| 6  | `flushIndex` is a no-op with no subscribers; deltaLog is bounded (removing the gate is safe) | `v4-gateway.ts:845-850`, `sessions-index-publisher.ts:93-99`                                    |
| 7  | sessions-index is a narrow downstream projection of conversation (same source)         | `v4-gateway.ts:817-822`                                                                               |
| 8  | Cold-start seed is unconditionally completedSuccess (never publishes running)          | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1239-1250`                         |
| 9  | Hydration closes an unfinished turn as cancelled (chat self-heals)                     | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:786-788`             |
| 10 | Remote lifecycle/restart passes through two RPC hops implicitly, no explicit relay; RepoWiki had a prior failure | `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts:173,300-307`          |
| 11 | Conversation-side generation change uses `ReplaceableConversationTransport.replace()`; each open builds fresh | `packages/ui/src/v4/workspaceConnectionRegistry.ts:167-189`                              |
| 12 | Production renderer logs are all no-ops (largest diagnostic blind spot)                | `packages/ui/src/logger.ts:38-41`                                                                     |

## Excluded candidate causes

- CLI cold start publishes persisted running as-is: refuted, the cold seed forces `completedSuccess` (v4-bridge.ts:1239).
- Persisted `status=running` in the sqlite tasks-index causes the spinner: refuted, UI does not trust persisted status.
- The two surfaces are two state machines on the CLI side: refuted, sessions-index is a downstream projection of the conversation snapshot.
- 30-150 ms conversation frame debounce skew: sub-second, cannot explain a screenshot-able persistent inconsistency.
- Mobile remote-control interference: screenshot was desktop; web-remote bridge logs point only at local test workspaces.
- Remote lifecycle events not forwarded at all: refuted, the per-remote-session attachment channel + ProxyChannel lazy-discovery branch can pass them through (`packages/rpc/src/proxy-channel.ts:64-80`), and the Local Host itself consumed remote lifecycle (`zcodeAgentConnectionScope.ts:627-645`). Reliability is not covered by e2e; open follow-up.

## Fix (two complementary root-cause repairs)

**R-A: `packages/ui/src/v4/sessionsIndexStore.ts`, loading needs live proof and eventual convergence.**
1. `failRecovery`, the resync-failure branch and the non-transient `connect` failure branch clear the projection when entering `error`, same as `dormant` (`this.state = EMPTY_SESSIONS_INDEX_STATE; this.cachedList = null`).
2. `error` is no longer terminal: after entering it, automatically start a fresh `connect(transport, { forceSnapshot: true })` with bounded backoff (5s/15s/60s, capped, looping). A runtime-unavailable error goes `dormant` through the existing branch (no reconnect storm; lifecycle available wakes it).

**R-B: `apps/zcode-cli/.../v4-gateway.ts` `publishCurrentSummaryToIndex`, reduced state stays faithful.**
Remove `!indexPublisher.hasSubscribers()` from the early-return condition (keep `!indexPublisher`). `flushIndex` no-ops on an empty subscriber set; frame semantics, seq accounting and schema are unchanged. Every later subscribe/resync snapshot reflects the authoritative current phase.

**Follow-up in the same invariant (found in review of commit `41ef87616e`).** `v4-gateway.ts` `cleanupSessionRuntime` (session delete path) still had `if (indexPublisher?.hasSubscribers() && indexPublisher.removeSession(sessionId))`. A session deleted in a no-subscriber window kept its reduced entry and "revived" (possibly with phase=running) in the resubscribe snapshot. `hasSubscribers() &&` was removed there too, with a regression test that cleanup in an unsubscribed window leaves the session out of the resubscribe snapshot. `hasConversationSubscribers` (~:1898) is conversation-side resident reclaim, unrelated.

Implementation notes (verified in review): the `failAndScheduleRecovery` retry callback has `closed` / transport reference / generation guards so any external connect / replaceTransport / generation change invalidates old timers; after clearing, `subscriptionId = null` so `handleFrame` rejects late frames of the dead subscription; the retry chain threads `errorRecoveryRetryAttempt` (only an external connect resets it) and is independent of the transient (EBUSY) retry backoff; runtime-unavailable in connect/resync failures goes through `handleRuntimeUnavailable()` to dormant, which also fixed the earlier residue "connect failure enters dormant without clearing the projection"; the `notOwned` special case, dormant->available wake and restart backoff are intact.

**Not part of the fix (decisions / follow-ups):**
- R-C (defense in depth, strongly recommended): production renderer `logger.ts` should let at least `warn/error` through the bridge to disk. It is the largest diagnostic blind spot and the prerequisite to upgrade probable to confirmed. Not implemented.
- Remote two-hop event pass-through lacks an explicit relay contract (RepoWiki precedent): add a cross-bridge lifecycle e2e assertion.
- Workspace-dispose hard-killing the agent leaves persisted running+activeTurnId; chat hydration closes it and the cold seed is completedSuccess. Hygiene, not the root cause.
- A sessions-index keepalive/watermark frame was judged deferrable at the time, but see D2 below, which overturns the premise.

## Root-cause elimination (repair-sufficiency gate)

1. Eliminated transitions: T1 = "after a recovery failure the store rests in a non-self-healing terminal state carrying stale running" (R-A: no proof means cleared, and always retried); T2 = "phase transitions in a no-subscriber window are permanently absent from the reduced state" (R-B: reduced state follows the live projection unconditionally).
2. The invariant holds before any recovery/fallback runs: R-A clears in the same synchronous path that enters `error` (before retry); R-B corrects at event ingest (before any subscribe/resync read).
3. It holds even with the added retry removed: R-A's clearing alone removes the stale-running spinner; with R-B alone every snapshot is the then-current truth.
4. No visible failure becomes silent corruption: `status=error` stays observable; clearing only withdraws the unproven running claim, and persisted task rows continue to show from tasks-index.
5. Both are needed: R-A alone may retry into a stale snapshot (T2); R-B alone leaves the error dead end plus stale running rendering (T1).

## Risk

- No protocol, schema, persistence format or public RPC contract change; the two changes are independent and separately revertible.
- R-A tightens only the `error` branch and adds backoff retry; `live/connecting/dormant` paths are untouched; a failed retry falls into the existing dormant branch.
- R-B only lets the reduced state advance with no subscribers: CPU is a summariesEqual-level comparison (ModelStreaming excluded), memory is bounded by `maxDeltaLog`; the host syncer and mobile path benefit equally.
- Desktop continuous and mobile replayable boundaries are untouched (no stream/snapshot/queue semantic change).

## Tests (written first)

1. `packages/ui/test/sessionsIndexStore.test.ts` (red before the fix): store live with `phase=running` -> inject recovery fail-closed -> assert projection cleared and no running; advance fake timers -> assert automatic fresh subscribe succeeds, `status=live` and projection is the new snapshot. Also non-transient subscribe failure backoff 5s/15s.
2. `apps/zcode-cli/packages/bootstrap/tests/v4-gateway-sessions-index.test.ts` (red before the fix): first subscribe -> all unsubscribe -> inject TurnStarted+TurnComplete in the no-subscriber window -> resubscribe -> snapshot phase is the current truth (running after TurnStarted). Plus the session-cleanup resubscribe case above.
3. Invariants: every error entry path (failRecovery / resync failure / non-transient connect failure) leaves no sessions; no-subscriber ingest sends no frame and deltaLog stays under its cap.
4. Adjacent: `notOwned` self-heal, dormant->available wake, a retry hitting runtime-unavailable turns dormant without looping.
5. Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit:affected`. In review: red on the parent commit `dc810f6df8` (2 new + 1 new tests fail), green on the fix (28 + 16 passed); root `pnpm typecheck` passed, `pnpm lint` 0 errors; local bootstrap `tsc --noEmit` showed 3 pre-existing/environment errors in files not touched (`product-projection.ts:2457`, `workspace-model-catalog.ts:22-23`), CI authoritative.
6. Runtime replay (green after the fix): connect WSL -> long task -> reopen the workspace while running (reproduces the 19:32 generation sequence) -> within 30 s list spinner and chat converge; once R-C logging exists, assert the store converged via fresh subscribe rather than a fallback path.

## Remaining risk

- State at screenshot time is not replayable (no renderer logs), so the grade stays probable until R-C lands.
- On the next repro also export the in-WSL `~/.zcode/cli/log` (the bundle held only Windows-side CLI logs).
- Remote two-hop pass-through reliability is not e2e-covered; tracked separately.

## Second incident (2026-09-04, ZCode 3.11.1): Settings overlay on a remote workspace displaces the sidebar sessions-index subscription (T3)

### Symptom and grade

The same user reported "left task spins, chat finished" again on 3.11.1 (commit 87a07145), one task
only, symptom 1 only. Grade confirmed (Windows desktop log + WSL-side CLI log + code path agree).
R-A/R-B cover only "has error" and "no-subscriber gate"; this is a third mechanism, **T3: the
subscription is silently replaced**, with no error at all, so R-A's retry never fires.

### Causal chain

```
remote workspace (remote:wsl:default:root:/root/src/plancov, remoteSessionId df0312a2...) active, user opens the Settings tab
  -> Root.resolveRootWorkspaceShellTarget takes the fallback: identity kept, workspaceRemoteSessionId=undefined
     (packages/ui/src/root/rootWorkspaceShellTarget.ts; commit a38a37f862 only added identity)
  -> App.useWorkspaceTerminalTaskNotifications scope has no endpointKey
     -> sessionsIndexRegistry key "__base__\0<identity>" != sidebar useWorkspaceTaskLists key "<remoteSessionId>\0<identity>"
     -> a second SessionsIndexStore + transport subscribes the same topic (subscribeSessionsIndexV4)
  -> both subscriptions reach the CLI through the same host-rpc facade / relay facade with the same connectionId
     -> SessionsIndexPublisher.subscribeReserved "one subscription per connection": the sidebar's subscription is deleted, with no signal
  -> closing Settings -> the notification hook's store unsubscribes -> that attachment's subscriptions on the topic drop to zero
  -> the sidebar store stays status=live but never receives frames: a task running at freeze time spins forever with time stuck at the Settings-open moment;
     tasks created later do not exist in the store, rows fall back to tasks-index -> running tasks do not spin, waiting-input has no badge
```

The incident log confirmed a single process, single workspace key and no agent restart, ruling out a
stalled CLI projection.

### Fix

- `packages/ui/src/root/rootWorkspaceShellTarget.ts`: `resolveRootWorkspaceShellTarget` takes a new `workspaceTabs` parameter; with a Settings overlay it finds the covered workspace tab by `workspaceKey` and backfills its `remoteSessionId`, so the shell target equals the tab's active state exactly. If the tab is disconnected or closed it stays `undefined` (same as active-state semantics).
- `packages/ui/src/Root.tsx`: the call site passes all workspace tabs of the window (existing memo, renamed `windowWorkspaceTabs`).
- Registry, facade, CLI publisher and UI display rules are unchanged: in Settings mode the notification hook and the sidebar get the same registry key, `acquireSessionsIndex` takes the `refCount++` branch, and the second subscription is never created.

Elimination: the shell target no longer outputs a partial identity under a Settings overlay; the
invariant holds at acquire time, before any recovery logic (the CLI's replace statement never runs);
no fallback is needed (without R-A retry, heartbeat or UI override rules the scenario still does not
occur); closing Settings is only `refCount - 1`, so the sidebar subscription survives.

### Tests

- `packages/ui/test/rootWorkspaceShellTarget.test.ts`: corrected the old case (it had locked `workspaceRemoteSessionId: undefined` as expected); added by-identity match, tab not connected, tab closed, local tab. 2 red before the fix.
- `packages/ui/test/rootSettingsSessionsIndexSubscription.test.ts`: single-connection CLI replacement mock; sidebar scope + Root-resolved notification scope produce exactly 1 subscribe; after closing Settings the sidebar still receives running -> completedSuccess. Red before the fix (second store subscribed as `six-2`, `six-1` replaced).
- e2e `SSH-P0-TASK-03` (pending, `manual-review/pending/conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts`): continuation response delayed 15 s, toggle Settings while running, assert the sidebar spins first and converges after completion; fixture contract check passed; awaiting a real SSH run.

### Beyond this fix (separate decisions)

- D1 observability (implemented, separate commit): `acquireSessionsIndex` looks up the remote session its agentService object belongs to (`findRemoteWorkspaceSessionIdForAgentService`); when the scope `endpointKey` (default `__base__`) disagrees, it logs `v4.sessions_index.scope_endpoint_mismatch` via `logger.lifecycle.warn` (endpointKey / remoteSessionId / workspaceKey / workspacePath), once per scope. It only records; no key or subscription change. Test: `packages/ui/test/sessionsIndexRegistryEndpointMismatch.test.ts`.
- D2 design decision (open): CLI "one subscription per connection, replacement without notification" (10 §3.1) plus the attachment facade's unified connectionId lets any second subscription that bypasses the registry silently kill the first. The earlier premise that keepalive is deferrable (failures surface as error) is overturned. Candidates: the CLI sends a `subscription.replaced` fault to the connection of the replaced subscription (plugs directly into R-A's error -> fresh subscribe), or the facade notifies the old owner when `remember()` evicts an owned entry.
- D3 mitigation (not recommended): letting a newer terminal tasks-index row override a stale running activity would mask the symptom and contradicts "loading must be proven by runtime".
- Found in passing (separate ticket): twelve `zcode-agent.createSession FAIL` between 14:50:36 and 14:51:38, where a local workspace key was routed to a WSL remote service.
