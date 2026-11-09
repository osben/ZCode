# Rust app-server: Node goal completion verifier

Scope: the desktop goal of the Rust app-server (`node_desktop`, `SessionDeps::desktop_goals`). The TUI and `-p` keep the
stop-time `/goal` evaluation of `docs/specs/rust-cli/goal.md`. Parent spec: `specs/fork-rust-agent-parity.md` (Goals row).

Node sources: core `runtime/methods/target-completion-verification.ts`, `target-continuation-loop.ts`, `target.ts`;
contracts `tools/target.ts` (prompt, parse, fail-open), `events/session.events.ts` (`TargetCompletionVerificationPayload`);
bootstrap `zcode-protocol-v4/product-projection.ts` (`onTargetVerification`), `transcript-hydration.ts`.

## 1. Product rules

1. After a main turn of a session with an active (not paused) desktop goal completes, the session runs one completion
   verification before it continues the goal. It is skipped (no verification, no continuation) when:
   - the turn did not complete (interrupted or failed);
   - plan mode is on;
   - the turn is the `/goal X` control turn (its continuation is the first, unverified one, Node `verifyBeforeFirstContinue: false`);
   - queued input or a waiting background notice exists: it runs first, and the turn it opens is verified when it completes
     (Node `yieldToPendingCommands`);
   - the session is closing or shutting down.
2. The verification is a separate model request, not a stop hook: Node's prompt
   (`formatGoalCompletionVerificationPrompt`, copied verbatim into `session/src/goal_verify_text.rs`), the session's main model,
   no tools, the output limit of the model card, query source `target_completion_verification`
   (`SideSource::GoalVerification`). Context: the active history normalized like the main loop (`QueryRunner::transcript`, so the session does not
   depend on the query crate), then the prompt as the last user message. Difference kept: Node sends its full runtime system prefix; this request sends the identity block only.
3. The reply is parsed like Node `parseGoalCompletionVerificationText`: the trimmed text, a JSON string, or a Markdown
   `json` fence; the first `{` to the last `}`; `passed` is true only for the boolean `true`; an empty `reason` is
   `The completion verifier could not confirm that every goal requirement is complete.`; an empty `nextAction` is absent.
4. Fail-open like Node: a reply that is not a JSON object, or a request that fails, counts as passed (the goal becomes
   verified). The marker of a failed request is `failed` (Node `failed_closed`), the goal still `verified`.
5. Outcomes:
   - passed: the goal is met (`goal_status` met), status `verified`, no continuation;
   - not passed with a `nextAction`: `goal_status` not met with the reason, status `notSatisfied`, then a model-only
     continuation turn whose prompt carries `Completion verifier result:`, `Reason:` and `Next action:` with the verifier's
     next action (Node `formatGoalContinuationPrompt`);
   - not passed without a `nextAction`: the same `goal_status`, status `notSatisfied`, no continuation
     (Node `skipped_no_next_action`);
   - cancelled (Stop / `Interrupt`, shutdown): the goal is paused (`goal_status` paused), the marker `failed` with detail
     `cancelled`, no `verifications` item; queued input is held like a stopped turn.
6. No iteration cap (Node has none); the TUI's 8-block cap stays on the stop-hook path only. There is no `impossible`
   verdict on this path: an impossible goal is `passed: false` with the blocker in the reason, like Node.
7. While a verification runs the session is busy: input queues, `Interrupt` cancels it, `ResumeGoal` is refused
   (`activeTurn`), `PauseGoal` pauses the goal and cancels it.

## 2. State owner and interfaces

- Owner: the session actor (`session/src/goal_verify.rs`). The verification is a session `Job`
  (`JobDone::GoalVerified`), like SessionStart: `busy()` is true while it runs and `Interrupt` cancels its token.
- `kernel-api goal.rs`:
  - `GoalPhase` adds `Verifying` and `NotSatisfied` (serde `verifying`, `notSatisfied`).
  - `GoalVerification` is Node's `TargetCompletionVerificationPayload` (camelCase): `targetId`, `status`
    (`started` / `completed` / `failed_closed` / `cancelled`), `verificationId`, `verification`
    (`{passed, reason, nextAction?}`), `goalIteration`, `anchorAssistantMessageId`, `anchorTurnId`.
  - `GoalState.verifications`: the finished verifications of this goal (`iteration`, `outcome` `pass` / `notSatisfied` /
    `failed`, `atMs`, `reason`, `nextAction`), the last 20 (Node `goalVerificationsRetained`); cancelled ones are not listed.
    `GoalState.iteration` is the last verification's iteration. `session_target` does not store them (`stored_form`).
- `KernelEvent::GoalVerification { verification, at_ms }`: one per lifecycle step, for the timeline marker.
- `Fact::GoalVerificationRecorded { verification, at_ms }`: node-store writes one Node `session_entry`
  (`type = "target_completion_verification"`, `data = {eventId, payload, sequenceNumber, turnId}`), so Node reads Rust
  sessions; `LoadedSession::goal_verifications` reads them back, latest step per (`targetId`, `goalIteration`).
- Iteration: `max(goalIteration of this target's recorded verifications) + 1`, starting at 1.
- `verificationId`: a fresh id per request.

## 3. Event order

```
turn N completes ── TurnFinished
   actor: goal Verifying(k) ── GoalChanged ── GoalVerification(started) + Fact(started) ── spawn job
job done ── actor:
   passed      ── GoalVerification(completed) + Fact ── goal_status met ── GoalChanged(verified) ── start_next
   not passed  ── GoalVerification(completed) + Fact ── goal_status not met ── GoalChanged(notSatisfied)
               ── nextAction? TurnStarted(goal continuation, model-only) : start_next
   failed      ── GoalVerification(failed_closed) + Fact ── goal_status met ── GoalChanged(verified) ── start_next
   cancelled   ── GoalVerification(cancelled) + Fact ── goal_status paused ── GoalChanged(paused) ── queue held
```

The goal row in `session_target` keeps `active` while verifying and after `notSatisfied` (Node has no such stored status).

## 4. Protocol projection

- Marker row: `timelineMarker`, lane `turnTailBoundary`, `marker: {type: "goalVerify", iteration, outcome, detail?}`,
  key `goal_verify:<targetId>_<iteration>` in the anchor turn (`anchorTurnId`, else the latest turn). `started` appends
  `running`; a terminal step upserts `pass` / `notSatisfied` / `failed` (detail: the reason, or `cancelled`), or appends
  when no started row exists.
- Control while running: `phase: running`, `canStop: true`, `stopState: stoppable`, `stopTargetKind: goalVerifier`,
  `activeWorks: [{kind: "goalVerifier", startedAt}]`; `inputRouting` is `enqueue` with reason code
  `goalVerifierAcceptsFutureInput`. Terminal: `completedSuccess`, `completedInterrupted` for cancelled,
  `error` for failed (Node).
- Snapshot `goal.verifications` from `GoalState.verifications` (`at` = `atMs`, `anchorRowId` = the marker row id).
- Cold: each finished verification of the goal (`GoalState.verifications`) is a marker row right after its anchor
  assistant message (`anchorAssistantMessageId`), or at the end when that message is no longer in the active history.
  Difference kept: a cancelled or never-finished verification has no cold marker (Node shows it as `failed`).

## 5. Acceptance scenarios

1. A goal turn completes, the verifier replies `{"passed": true, ...}`: marker `running` then `pass`, goal `verified`,
   no continuation, one session entry per step.
2. The verifier replies `{"passed": false, "reason": "R", "nextAction": "A"}`: marker `notSatisfied` with detail `R`, goal
   `notSatisfied` with a `verifications` item, then a continuation turn whose meta message contains `Next action: A`; that
   turn is verified again with iteration 2.
3. Not passed without `nextAction`: no continuation, the session is idle.
4. Reply `not json`: goal `verified` (fail-open); request error: marker `failed`, goal `verified`.
5. `Interrupt` while verifying: goal `paused`, marker `failed` / `cancelled`, the session idle.
6. Input submitted while verifying is queued and runs after the verification (before any continuation).
7. Reopen: markers and `verifications` come back from the session entries.
8. Plan on, an interrupted turn, or the control turn: no verification.
9. The TUI / `-p` `/goal` keeps the stop-time evaluation (`goal.md`), unchanged.
