# Session Goal

## Goal

A session-local long-running goal. The user or model persists one objective for the current session,
inspects it after resume, and marks it complete when real evidence shows it is achieved.

## Non-Goals

- A goal is not a cross-session scheduler and does not create worker sessions or fan out work.
- Continuation is runtime-triggered only when the current session is idle; it is not a wall-clock timer
  or polling loop.
- The runtime does not semantically decide that a goal is complete; completion is model/user driven.

## User Model

A goal belongs to the current session. A session has zero or one current goal. Setting a new goal
replaces the slot and creates a new stored `targetId` version. Clearing removes the slot. DB table
names, event names and ZCode app-server `_meta.zcode.target` remain target-shaped compatibility
surfaces; user-facing commands and model-visible tools use goal naming.

TUI commands:

- `/goal` reads the current goal.
- `/goal <objective>` sets the goal as `active`; an existing goal is replaced and continuation starts on
  the replacement.
- `/goal replace <objective>` is an explicit compatibility spelling of the same replacement.
- `/goal pause` sets the goal to `paused`.
- `/goal resume` sets the goal to `active`; when plan mode prevents continuation it uses the same
  explicit response note as `/goal <objective>`.
- `/goal clear` deletes the goal.

Headless prompt surface:

- `zcode --target "<objective>"` is the headless compatibility equivalent of `/goal <objective>`. It
  starts continuation through the same command-center path as the TUI command, except that headless
  keeps explicit overwrite protection for automation safety.
- `zcode --target "<objective>" --resume <sessionId>` and `--continue` apply the same semantics to the
  resumed session.
- `--target` does not combine with `--prompt`; mixed usage is rejected at the CLI boundary.
- If a goal already exists, headless requires an explicit `--target-replace`; otherwise the CLI returns a
  local error and submits no model turn.
- `--target` is a compatibility CLI flag only. It adds no `ZCODE_*` environment variable and does not
  change the goal storage contract.

Plain prompts never create goals implicitly. The user must use `/goal` or explicitly ask the model to
create one. If the model creates a goal during a normal prompt, the runtime may continue it after the
current turn completes.

## Status Model

- `active`: the goal guides future turns.
- `paused`: persisted but does not drive continuation.
- `budget_limited`: reached its configured token budget; starts no new substantive continuation work.
- `complete`: achieved; does not drive continuation.

Only user-facing control surfaces set, pause, resume, replace or clear a goal: TUI `/goal ...` and
headless `--target ...` (set/replace). Model tools may read the goal but cannot create, update or
complete it. The runtime may set `paused` on user cancellation, `budget_limited` when accounting reaches
the budget, and `complete` only after the completion verifier passes.

## Continuation

Continuation uses normal turns for work and a separate no-tool verifier request for completion
decisions. Post-turn continuation of an active goal is owned by the runtime. Bootstrap may ask the
runtime to enqueue the active goal loop for manual `/goal` continuation but does not own the loop.
Accepted user prompts and background notifications run the same loop inside the runtime command executor
after their command finishes.

When an active goal exists and the runtime is idle, the runtime first decides whether to verify the
just-finished turn. If verification is not requested (for example right after `/goal` starts the first
iteration), it injects the normal continuation prompt. If requested, it sends a no-tool verifier request
with `querySource: "target_completion_verification"` before starting another continuation turn.

Background tasks:

- While the session has running background tasks, completion verification is deferred. Task completion
  notifications are model-only synthetic user inputs and must reach the model before the verifier
  decides.
- Notifications reuse the same runtime-owned loop after their model-only notification turn completes.
  The loop reads current runtime/session facts each iteration.
- Automatic post-command loops stop before continuation when the runtime command queue already has
  pending work. A queued manual `/goal` loop owns its first queue slot and yields before later
  iterations if another command arrives.
- A notification-triggered check follows the normal loop: if the verifier fails and starts a
  continuation turn, verification continues after that turn until a verifier passes, no usable
  continuation remains, another runtime command is pending, or background work is running again.

Completion evidence: a plan, proposed plan, todo/checklist update, completed planning phase, elapsed
effort or plausible final response is not completion evidence by itself. These count only when the user
objective was explicitly to produce that plan/checklist, or when backed by concrete artifacts, command
output, test results, PR state, user confirmation or other evidence covering every objective
requirement. Before passing, the verifier must inspect todo evidence in the conversation context; if any
todo remains pending or in progress it fails verification and prioritizes finishing that todo.

Verifier result handling:

- pass: the runtime sets the goal `complete` and skips further continuation.
- fail with a usable `nextAction`: the goal stays `active` and
  `Continue working toward the active session goal. <nextAction>` is injected into the next model-only
  continuation turn.
- invalid verifier JSON: treated as a pass (no trustworthy continuation condition); the goal becomes
  `complete` and continuation stops.
- verifier request/system error: the goal stays `active`; no continuation step is invented when there is
  no usable `nextAction`.

The verifier JSON shape is `{"passed": boolean, "reason": string, "nextAction": string}`. The parser
accepts a raw JSON object and tolerates a Markdown fenced code block with a `json` language marker. If
the verifier concludes the goal cannot be satisfied in the current session, it still returns
`passed: false`, explains the blocker in `reason`, and puts the smallest useful user-facing unblock step
in `nextAction`. `nextAction` is also projected to the ZCode app runtime snapshot so the summary panel
can replace the next iteration title. The verifier result is runtime projection data, not goal business
state. The compatibility config key `targetCompletionVerification.enabled = false` disables the verifier;
the runtime then continues the active goal until another control surface pauses, clears or replaces it.

Continuation is skipped when:

- the goal is missing, paused, complete or budget-limited;
- the runtime is in plan mode;
- another turn is active;
- the user has queued or steered input that should run first;
- the session is not persisted yet and cannot safely attach goal state.

`/goal <objective>` and `/goal replace <objective>` are both goal-setting commands and the first prompt
of long-running goal work: the command stores the objective, then asks the runtime to continue it if the
session is idle.

On cancellation an active goal is paused before the turn unwinds. On resume a paused goal is restored to
active outside plan mode, and continues only after the client explicitly asks for continuation or
submits/resumes through a surface that supports continuation events.

### Reminder timing

Goal business state and model-visible state-change reminders have different timing guarantees. The
session store update and the durable `target_changed` event stay inside the initiating command mutation
and complete before that command aborts the active turn; they are not deferred to turn finalization.

The runtime opens turn-local reminder deferral only around the regular model/tool loop. A pause in that
scope keeps one pending `goal_state_change` reminder. The loop's single `finally` first closes deferral,
then materializes the reminder after cancelled tool results are persisted and appended to live model
history but before the turn terminal event. A state change arriving after deferral closes materializes
immediately, even while the active-turn accounting lifecycle is still finishing. This prevents both a
provider-visible `tool_use -> reminder -> tool_result` sequence and a late pending reminder being
discarded with the active turn. The reminder stays a normal persisted attachment; provider projection
owns only its MCS-versus-legacy representation and must not reorder this reminder to compensate for an
early producer write.

The pending reminder is in-memory and scoped to the active model/tool loop. A hard process exit before
loop finalization may omit that transition notice, while the paused goal stays durable and cold resume
still injects the current goal state. Materialization is best-effort: a synthetic notice persistence
failure is logged and does not suppress the turn terminal event, since the target store and
`target_changed` event have already committed. There is no retry or reminder cursor. Stop followed by
resume after turn finalization stays append-only: both pause and resume reminders are retained.

### Reminder finalization boundaries

- The only interrupting goal mutations exposed by the protocol are `/goal pause` and `session/stop`.
  They update the target store, register the reminder, persist `target_changed`, and only then abort the
  active controller. Resume, clear, set and replace remain rejected while a prompt is active; duplicate
  status writes register no further reminder. One turn-local pending slot is therefore sufficient, with
  no cursor or request-boundary state machine.
- Deferral belongs only to a regular model/tool loop. Idle mutations and changes during manual compact
  or rewind materialize immediately. A late pause after the loop closes also materializes immediately
  rather than staying on an active-turn object that is still finishing accounting.
- Once an assistant tool call is in history, cancellation goes through the existing tool executor. A
  handler that has not started receives a synthetic cancelled result and is not invoked. Each result
  part is persisted and appended to live history; cancellation from an optional file-mutation
  checkpoint is rethrown only after all sibling results are closed. The loop `finally` then
  materializes the pending reminder before the terminal event.
- Persistence, cold hydration, compact selection and provider projection keep using the shared synthetic
  attachment path. `goal_state_change` stays model-only in UI projections, and the provider layer still
  decides MCS `system` versus legacy `<system-reminder>` representation without goal-specific ordering.
- The protocol keeps `activeAbortController` until `sendInput` completes turn finalization, so a
  desktop-continuous prompt or web-remote-replayable host-queue item cannot overtake the cancelled tool
  results or pending reminder. No `clientMode`, `deliveryKind`, workspace identity or renderer queue
  behavior is involved.

## Events

Every successful goal mutation emits a durable compatibility `target_changed` session event after the
session store write succeeds. It is the stable notification surface for TUI, ZCode app-server, replay,
debug and future session projection consumers; clients must not infer goal state by parsing command
text or model-visible tool output.

`/goal clear` is idempotent for client synchronization. If the store already has no goal, the command may
still emit a `cleared` event with `target: null` and `previousTarget: null`, so clients that restored
stale local goal metadata converge back to the authoritative empty state.

```ts
interface TargetChangedPayload {
  action: "set" | "status_updated" | "cleared" | "usage_accounted" | "summary_updated";
  source: "command" | "tool" | "runtime";
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}
```

Mutation sources:

- `command`: `/goal ...`, headless `--target ...`, and ZCode app-server command equivalents.
- `tool`: legacy historical events only; current model-visible goal tools do not mutate goal state.
- `runtime`: cancellation pause, resume activation, usage accounting, budget limiting, completion
  verifier completion, and generated goal summary title writeback.

`set` covers first creation and replacement. `cleared` sets `target` to `null` and includes
`previousTarget` when one existed. `usage_accounted` is emitted only when accounting applies to the same
`targetId` that started the turn. A verifier pass emits a `status_updated` event from `runtime` when the
goal becomes `complete`. `summary_updated` is emitted after the async title sidecar writes
`summaryTitle`; it does not reset verifier state.

ZCode app-server projects `target_changed` as a standard `session_info_update` with private legacy
`_meta.zcode.target`. TUI may render a transient line, but durable business state stays in core/session
events and `SessionProjection.target` until a future protocol migration.

## Storage

The session store owns goal persistence. The TUI must not hold goal state as business state.

SQLite migration `0004_session_target` creates:

```sql
create table if not exists session_target (
  session_id text primary key references session(id) on delete cascade,
  target_id text not null,
  objective text not null,
  summary_title text,
  status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
  token_budget integer,
  tokens_used integer not null default 0,
  time_used_seconds integer not null default 0,
  time_created integer not null,
  time_updated integer not null
);
```

`session_id` is the relationship key (`session 1 -> 0..1 goal`). `target_id` is a retained DB column and
version identifier so automatic continuation/accounting can reject stale updates after the user replaces
the goal.

Migration `0005_session_target_accounting` rebuilds the table to add `budget_limited`, token budget,
token usage and elapsed-time accounting, preserving existing rows.

Migration `0011_session_target_summary_title` adds nullable `summary_title`: display metadata generated
from the user-provided objective with the same prompt as session titles. It is not injected into goal or
verifier prompts. The async writeback is guarded by `session_id + target_id`, so a title generated for a
replaced/cleared goal cannot overwrite the current goal.

## Tool Contract

Built-in model tool: `GoalRead` reads the current session goal. It is read-only. Creation, replacement,
pause/resume, clear and completion are control/runtime operations, not model tool mutations.

## Completion Verification

Goal creation only validates shape: the objective is non-empty and within the length limit. The working
model keeps implementing and verifying real evidence (files, command output, tests, PR state, user
confirmation) but does not mark completion itself.

When verification is enabled, the runtime issues a separate no-tool verifier model request after a turn
ends and before injecting the next continuation prompt. Continuation uses normal turns for work; the
verifier is the runtime gate that decides completion.

Verifier model options: the verifier binds the Session ModelSelection once when verification starts. It
inherits that Model's reasoning options and requests `optionSpecs.maxOutputTokens.max`, like a normal
Turn. It does not use the low-cost auxiliary-call policy (lowest reasoning / 5,000-token cap). Retries
and usage attribution keep the same Model even if the Session selection changes; no verifier-specific
options are persisted back to the Session. Title and other auxiliary calls keep their own policy.

## Goal Iterations

Iterations are bounded only by the verifier lifecycle. User prompts, manual continue actions,
TodoWrite calls, assistant message boundaries and model-only `goal-continuation` turns do not create
iterations by themselves.

Ownership rules:

- Before the first verifier runs, all active-goal work belongs to iteration 1.
- Verifier N closes iteration N.
- If verifier N passes, the goal becomes `complete` and no iteration N+1 opens.
- If verifier N fails, is cancelled, or fails closed with a usable continuation action, later
  active-goal work belongs to iteration N+1 until verifier N+1 closes it.
- Visible user prompts sent between verifier boundaries, and the resulting assistant/tool work, stay in
  the currently open iteration.
- Creating or replacing a goal resets iteration ownership for the new `targetId`; old verifier and todo
  ownership must not leak across replacement.

The UI-facing model distinguishes:

- `verifiedIterationCount`: how many verifier lifecycle records have closed or attempted to close an
  iteration.
- `activeIteration`: the iteration new active-goal work belongs to; 1 before the first verifier and
  `verifiedIterationCount + 1` after a non-passing verifier that continues the goal.

`goalStats.iterationCount` must not be used as a hard clamp that forces post-failure work back into the
last verified iteration. Any snapshot or summary projection needing an upper bound uses the active
iteration boundary, not only the completed verifier count.

### Iteration Titles

Titles are display metadata and do not affect model prompts or verification.

- If the first visible user query creates the goal and the session title generator produces a title from
  it, iteration 1 uses that session title.
- If the session title is unavailable, iteration 1 may fall back to the goal `summaryTitle`, then to a
  compact objective-derived label.
- Iteration N+1 uses verifier N's `nextAction` as its title when verifier N did not pass.
- The title belongs to the next work iteration, not to the verifier divider that closed the previous one.
- Passing verifiers create no next-iteration title.

### Iteration Persistence

Verifier lifecycle is durable business state. Reopening a session, rebuilding a snapshot and replayable
remote recovery must restore the same iteration boundaries and divider rows without renderer memory or a
live in-process event store.

Preferred storage is the existing `session_entry` table with typed entries for
`target_completion_verification` lifecycle data; no SQLite schema migration is needed. If implementation
finds `session_entry` unsuitable and needs a new table or columns, that migration must be specified
before code changes.

Persisted lifecycle records include:

- `sessionId`
- `targetId`
- `verificationId`
- lifecycle status: `started`, `completed`, `failed_closed` or `cancelled`
- `goalIteration`
- `startedAt` and `updatedAt`
- optional verifier result: `passed`, `reason`, `nextAction`

Snapshot builders reconstruct `goalVerificationTimeline` from persisted records on cold resume. Live
event-store projection may remain an optimization but cannot be the only source of truth.

## Goal Todo Ownership

Todo ownership is based on where the todo first appears, not where it is later completed.

In goal sessions:

- Each TodoWrite snapshot is evaluated against the active iteration at the time of the assistant/tool
  message.
- A todo is assigned to the iteration where its content first appears.
- Later snapshots may update its status or priority, but it stays displayed under its original
  iteration; completing it in a later iteration does not move it.
- A todo appears under only one iteration for a given `targetId`.
- Todo identity is the normalized content fingerprint, for compatibility with TodoWrite data that has no
  stable todo id.

The fingerprint is stable across common formatting noise: trim leading/trailing whitespace, collapse
internal whitespace, compare ASCII text case-insensitively, preserve non-ASCII content after whitespace
normalization.

Grouped todo display keeps all statuses visible: completed (done), in-progress (doing), pending
(planned or upcoming).

In non-goal sessions:

- TodoWrite works as a standalone session plan; todos are not assigned to iterations.
- The UI still shows completed, in-progress and pending todos instead of hiding completed items.
- Existing session-level todo recovery stays valid.

When a goal is replaced, todo ownership for the new target starts fresh. Historical todo groups for old
targets may remain in history, but current goal summaries filter by the active `targetId`.

## Resume Context

On session resume the runtime reads the current goal and injects a system-reminder style user message
into model history, mirroring the todo recovery path, so goal continuity needs no TUI-owned state.

## Error Behavior

- Empty objective and objective over the configured limit are rejected before storage mutation.
- Model-visible `GoalCreate` and `GoalUpdate` tools are not registered.
- With verification enabled and a failing verifier, the goal stays active and the verifier `nextAction`
  is injected into the next continuation turn.
- With verification disabled, the runtime skips the verifier and continues the active goal.
- Active goals are paused when a turn is cancelled.
- Active-turn pause reminders are materialized after cancelled tool results and before the turn terminal
  event; idle goal reminders stay immediate.
- Budget-limited goals start no new continuation turns.
- Pause, resume and clear are TUI/control operations only.

## Test Coverage

- The migration list includes `0004_session_target`, `0005_session_target_accounting` and
  `0011_session_target_summary_title`, and is reopen-idempotent.
- The store can set, read, update status, update summary title, reject stale summary title writes,
  replace with a new `targetId`, and clear goals.
- The tool registry exposes `GoalRead` only; create/update completion tools are not registered.
- Goal prompts escape user-provided objectives before embedding them in system-reminder XML and say that
  plans, todos, checklists, proxy signals and elapsed effort are not completion evidence by themselves.
  The verifier prompt also requires unfinished todos to be completed before the goal can pass.
- Successful mutations emit `target_changed`; projection updates `SessionProjection.target`; ZCode
  app-server forwards the event through `_meta.zcode.target`.
- The runtime verifies post-turn completion through a separate no-tool model request; tests cover
  verifier pass, fail continuation, disabled verifier, and prompt/query source projection.
- Malformed verifier JSON is treated as pass so an unparseable response cannot leave a finished goal
  active without a continuation condition.
- Resume injects goal state into model history.
- The runtime accounts goal usage for turns that started with an active goal.
- The runtime generates goal summary titles with the title sidecar and emits `summary_updated` without
  blocking continuation.
- The command center parses `/goal` commands locally, then starts continuation for set/resume when
  available.
- Headless `--target ...` reuses `/goal ...` semantics and rejects silent replacement without
  `--target-replace`.
- Active-turn pause coverage asserts that all completed/cancelled sibling tool results persist before
  `goal_state_change`, the reminder persists before `TurnComplete(cancelled)`, and a subsequent request
  retains append-only pause/resume reminders.
