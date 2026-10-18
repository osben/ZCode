# Composer worktree setup steps

Status: implementation in progress (2026-10-15). This replaces the provisional renderer-only
chat behavior. `execution-worktree-missing-handling.md` covers runtime and health behavior for
created worktrees.

## Problem

When the empty-state “New worktree” intent is active, Send must create and open the actual
conversation session immediately. The current UI-only setup shell has no session identity, normal
conversation subscription, or authoritative navigation state until Git finishes. That makes the
preparation screen a disconnected presentation and delays the real session.

The Host must establish one durable session identity before starting worktree creation. The session
is visible and subscribable while it is preparing, but it has no AgentRuntime and cannot admit input
until the linked worktree exists. The first frozen input is admitted once, by that same session, after
runtime materialization with the worktree as its initial cwd.

## Contract

### Owners and event order

The CLI Host owns the preparing-session lifecycle and session identity. The session store persists
the session row and a typed preparation entry using existing session and session-entry storage. The
V4 gateway projects that authoritative record to the conversation topic and workspace sessions index.
The renderer owns only the frozen, uncommitted submission and its editor revision snapshot. Setup
pipeline state is scoped by workspace and prepared session; a workspace-level active-session pointer
serves the draft composer, while existing prepared conversations read their own entry. Git creation
remains in the existing worktree service flow and has no artificial delay in production; the
optional `VITE_E2E_WORKTREE_CREATION_DELAY_MS` environment gate exists only for E2E and manual
verification builds.
There is exactly one transition that materializes a runtime and admits the frozen first input.

```text
Renderer                  V4 Host / session store        Git service       AgentRuntime
   |                                |                         |                  |
   | freeze first submission       |                         |                  |
   | prepareSession(request) ----->|                         |                  |
   |                                | persist preparing row   |                  |
   |<----- sessionId ---------------| publish conversation +  |                  |
   | open normal session view       | sessions-index          |                  |
   | subscribe(sessionId) -------->|                         |                  |
   |                                |                         |                  |
   |                                | start worktree -------->| (no artificial   |
   | render progress in timeline   |                         |  delay in prod.) |
   |                                |<------ ready(path) ------|                  |
   | syncPreparedSession(path) ---->| update marker when path |                  |
   |   (only when path differs)    | differs; await acceptance|                  |
   |<---- sync accepted/rejected --|                         |                  |
   | activatePreparedSession ----->| validate preparation     |                  |
   |                                | materialize same ID with |----------------->|
   |                                | executionWorktree=path   |                  |
   |                                | accept first input once  |----------------->|
   |                                | complete preparation at   |                  |
   |                                | admission; publish conv + |                  |
   |                                | sessions-index            |                  |
   |<----- normal session events ---|                         |                  |
```

Sends that arrive while the first response is still running follow the ordinary queue/guide
rules of the already-active session; they never restart preparation or reserve another session.

A Send issued from a fresh draft ("New task") while a preparation pipeline already exists for the
same workspace must never disappear silently. A `creating` entry joins that reservation and queues
the new submission under the same prepared session; a `ready` entry routes the submission
immediately through that same prepared session — the renderer dispatches it against the ready
worktree without waiting for a store transition, activation admits it, and the entry is consumed;
a `failed` entry starts a fresh attempt on a freshly reserved session. Every such submission is
either admitted or surfaced as a visible error with a recovery record — never dropped with no
session, no recovery record, and no Host call.

When Git settles the branch at a path other than the prepared target, readiness goes through the
marker sync row above: the renderer updates the Host marker to the real path and awaits acceptance
before the entry turns ready. A rejected sync — or marker synchronization being unavailable for
that prepared session — fails the attempt with a retryable failure instead of publishing a ready
entry the Host would refuse to activate.

Every asynchronous pipeline completion carries the prepared session and attempt identity it started
for. Restoring or retrying an older preparation cannot replace another session's active pipeline, and
a stale completion cannot mutate a newer retry or another prepared session.

The renderer must not create a replacement session, send to a parent-cwd runtime, mutate cwd after
runtime creation, or own an accepted-input queue. The Host activation operation is idempotent by
session ID and preparation token: duplicate activation returns the existing result and cannot admit
the first input twice. Runtime creation is gated on a validated, existing worktree directory.

Preparation completes at the admission boundary of the first frozen input. Once Core admits that
input (accepted or queued), the Host persists `active`, evicts its in-memory preparation, and
republishes the conversation snapshot and sessions-index immediately — before the model response
finishes. Turn-completion callbacks are not the activation trigger, and deferred-to-immediate
persistence promotion is not evidence of admission. If activation fails before admission, the
preparation entry stays `preparing` with its session identity, so the frozen submission remains
recoverable and one retry can admit it exactly once.

Retry-admission is a renderer obligation, not only a Host one. The frozen submission's armed
continuation survives the first-send view promotion (the draft composer becomes the prepared
session's composer) — including when that promotion unmounts the draft composer instance and the
prepared session's composer mounts as a different instance: the armed continuation lives outside
any composer instance (renderer-owned continuation storage keyed by workspace and prepared
session), and the composer instance bound to the prepared session adopts it — and follows the
prepared session across retries by rebinding to the new attempt id. After a successful Retry settles `ready`, that same prepared session must be activated and the
frozen submission admitted exactly once, with no further user action. Draft-scope intent changes —
including the empty-state worktree toggle unmounting when the view promotes — must not withdraw the
armed submission; only an explicit user withdraw or cancel abandons it, recorded as the pipeline
entry's orphaned/cancelled state. A `ready` entry that admits nothing is a contract violation, not a
terminal state.

The durable preparation entry reaching `active` for a given attempt is the receipt of a completed
activation. A repeat activation with the same session, attempt, workspace, and worktree returns the
existing session without creating a second runtime, re-applying startup configuration, or admitting
the first input again — including after a Host restart while no runtime is live. A different
workspace, a mismatched path or branch, or a stale attempt is rejected. When the durable admission
result of the original activation is unknown, callers reconcile through the existing command
receipts (command inbox and the session-input ledger); the Host never re-sends the frozen input
under a new command id.

Host preparation updates are authoritative even when a renderer pipeline entry already exists. A
newer Host attempt replaces the renderer's stale attempt for that session only; Host cancellation
stops local delivery (the queued submission is restored while its recovery record is kept); a late
Git result for a replaced or cancelled attempt cannot restore `ready`. For the same attempt, a
locally settled `ready` stays visible until the Host reports a terminal state for that attempt.
Snapshot-driven restore never starts Git creation by itself, and a consumed or discarded entry is
never resurrected from stale metadata.

"Newer" is decided by supersession, not by inequality: attempt ids are opaque, so a Host attempt
that differs from the entry's attempt is newer only when the renderer has not itself replaced it.
The pipeline store is the single owner of this rule: whenever a session's entry is replaced by
another attempt — Retry, a Send that restarts a failed prepared session, or a newer Host attempt —
the replaced attempt is recorded on the entry before Git restarts, and a Host preparation seed
carrying a superseded attempt is stale and is ignored. The Host accepts the retry before its
snapshot reaches the renderer, so the seed for the failed attempt is still live when the retry
turns the entry `creating`; treating it as newer rolled the entry back to `failed` for one render,
which made the queued-send effect abandon the armed submission and left the later `ready` admitting
nothing (BUG-GWT-005, RT4-C5). A genuinely newer Host attempt (for example another client's retry)
still replaces the entry and inherits its superseded set, adding the attempt it replaced.
The renderer that issued Retry is the single owner of starting Git for the attempt the Host
acknowledged; snapshot restore still never starts Git. The Host snapshot for the retried attempt may
reach the renderer before the Retry acknowledgement, in which case restore adopts that attempt as
`creating` (superseding the failed one) before the handler resumes. The Retry handler therefore
proceeds from either `failed` for the attempt it retried, or `creating` for exactly the attempt the
Host acknowledged with no runner in flight; any other entry state means another owner already moved
the session on, and the handler starts nothing. While the acknowledgement is pending, the runner
marks the session as having a pending retry, and the stale-creating reconcile neither starts nor
settles that session (it re-checks the pending retry and the in-flight runner after each of its own
awaits); otherwise it would report the adopted attempt as failed to the Host before Git started. If
the handler ends without starting a runner while the entry is `creating` (the acknowledgement threw
or named another attempt), it hands the session back to the stale-creating reconcile once the
pending mark is cleared.

```text
Renderer entry (session S)     Setup-steps reconcile           Host snapshot seed
failed(A)                      seed = failed(A)
Retry → Host accepts B
startPipeline creating(B),
  superseded = {A}  ----------> seed failed(A): A ∈ superseded
                                → ignored (no rollback)
Git ready → ready(B)                                           preparing(B) arrives
  → armed submission dispatched -> seed preparing(B): same attempt
    once, entry consumed            → keep local ready
```

Snapshot before acknowledgement (same session S):

```text
Retry handler / runner         Setup-steps reconcile           Host snapshot seed
failed(A)                      seed = failed(A)
mark retry pending(S)
updateWorktreePreparation ...                                  preparing(B) arrives
                               restore: creating(B),
                                 superseded = {A}
                               stale-creating reconcile:
                                 retry pending(S) → skip
ack = B; entry creating(B),
  no runner → start Git for B
clear retry pending(S)
Git ready → ready(B)
  → armed submission dispatched once, entry consumed
```

### Preparation states

```text
absent → preparing → ready → active
             │          │
             ├→ failed  └→ failed
             └→ cancelled
```

- `preparing` has a stable session ID, parent workspace identity, preparation token, branch and
  target metadata, but no runtime and no accepted user message.
- `ready` records the resolved worktree path and whether an existing worktree was reused.
- `active` means the runtime was constructed with that path and the first input was admitted once;
  the state is recorded at that input's admission boundary, before its turn completes.
- `failed` preserves the same session identity and a recoverable error. Retry reuses the session ID
  and preparation token rules; it does not create another session.
- `cancelled` detaches delivery and retains a recovery record per submission. Recovery is explicit
  and available only with an empty editor; newer text is never merged or overwritten. It does not delete a worktree that Git may have finished creating.

The preparation marker and state must survive Host restart/reconnect sufficiently to render a
recoverable preparation session. If the Host restarts while Git may still be running, recovery checks
the target worktree by branch/path and settles to `ready` or `failed`; it never starts a runtime until
the path is validated. The renderer stores the frozen submission in a local recovery scope keyed to
the prepared session and submission id and offers an explicit recovery card after reload. It never
resubmits automatically after reconnect. Until reservation returns an ID, recovery remains visible
in the original draft scope; transferring it to the session is a single storage write.

The recovery record is a typed snapshot of the entire frozen submission — text, editor state, the
attachment manifest, and the contexts actually included in it: conversation quotes, code comments,
web-element, PPTX and plugin contexts, plus shared context. Restore re-establishes exactly that
submission: restored contexts replace the target scope's contexts and never merge with a newer
draft's contexts, and the emptiness check for restore (and for send gating) considers text, context
chips, and attachments together. Records written before the context snapshot existed remain
readable; ephemeral resources that no longer exist require explicit reattachment or removal, like
missing in-memory `File` sources.

### Submission and editor behavior

- Checking “Worktree” records intent only; no Git IO starts until Send.
- On Send, freeze text, prepared attachment/upload references, conversation quotes, and the current
  content revision. Ask the Host to create the preparing session and open that session immediately.
- The ordinary session header, navigation, timeline subscription, and composer are bound to this
  session ID during preparation. Progress, failure, Retry, and Cancel render inside its timeline.
- Do not render the frozen submission as a sent user message while preparation is pending. Keep the
  editor responsive for newer text; newer text is a separate draft and must survive first-input
  admission or recovery.
- After Git reports a ready path, activate the same session with the frozen submission. The Host
  validates and constructs the runtime with `executionWorktree` as its initial execution directory,
  then admits that submission exactly once. The normal authoritative user row appears before model
  output. Telemetry and TTFT start when the input enters the real runtime, so setup wait is excluded
  from send latency.
- On failure or cancellation, retain frozen text and the attachment manifest in a separate recovery
  record. Restore requires an empty editor and never overwrites newer text. A failed session retains
  its setup error and Retry action. Retry/Discard carry the expected attempt and cannot overlap;
  terminal local state follows the Host ACK for that attempt.
- Navigation away, tab unmount, and reconnect detach the renderer-local callback, save the frozen
  recovery record, and keep Host-owned preparation running. Returning to the session ID resumes the same
  progress state. Explicit Cancel is the only user action that abandons the queued submission.
- Attachments-only submissions follow the same lifecycle without a text preview.
- The attachment IDs in a queued submission are frozen at queue time; attachments added while Git
  setup runs remain in the next draft and are not sent with the queued message.

### Timeline presentation

Worktree preparation is timeline context, not an empty-state greeting: render it in the timeline's
persistent header slot above the message history so the creation status remains at the top after the
first user or assistant row appears. Once Host activation clears the preparation marker, keep a
compact created-worktree row in that same position from the live session-index execution-worktree
fact. Present these rows as restrained tool activity with a clear status icon, branch/path detail,
and consistent message-column alignment.

### Existing worktree and branch-list behavior

Existing worktrees reuse the same prepared session and activate in place; do not transfer the draft
to a second workspace or create a second directory. Branch occupation reuses the same path: when
`branch-in-other-worktree` reports the branch checked out elsewhere and the requested target is
absent, the creation flow resolves that registered worktree and adopts it, exactly like the
`target-path-exists` case, instead of failing. Before retrying a non-active prepared session
with different frozen parameters, update its Host marker to the new branch, target path, and base
branch so activation validates against the same values Git used. The same realignment applies when
Git settles the branch worktree at a directory other than the frozen target (WT-04 reuse, or a
recovery reconcile that finds the worktree elsewhere): update the Host marker's target path to the
directory Git actually used before the entry turns ready, so the strict activation check
(`executionWorktree.path === prepared.targetPath`) accepts the path being activated. If that update
is rejected, settle the entry as a retryable failure instead of exposing a ready entry the Host will
refuse to activate. A missing or failed branch list degrades to base=HEAD, with a visible note; it
does not block Send. Invalid custom/global target locations remain synchronous failures before the
session starts Git creation.

Before any entry turns `ready` — or is offered as an existing worktree — the real directory and its
Git binding are verified through the Git service of the target Host. A stale registration whose
directory was removed, or a directory that is not a usable worktree checkout, settles as a
recoverable failure; the flow never prunes registrations, deletes branches, or creates a second
directory on its own.

A failed creation names its cause in the `{reason}` of the failed row (and in the Command Center
error, which shares `executeWorktreeCreation`). A rejection Git did not classify (`unknown`) shows
Git's own failure line — the first `fatal:`/`error:` line of its output with that prefix removed,
for example `could not create leading directories of '…': Permission denied` — instead of only the
generic "Could not create the worktree"; without Git output the generic text stays. A
`target-branch-not-found` rejection also reminds the user that a repository without commits has no
branches yet, because an unborn HEAD reports the default branch as missing.

The Command Center “New task in worktree” action remains its separate Start-driven flow and opens its
own workspace. Its branch-name collision avoidance and shared `executeWorktreeCreation` request
semantics remain intact.

Command Center worktree deletion treats a prepared, not-yet-cancelled session (preparing or failed)
as using its target path and branch: the controller row projection carries the preparation fact as
an optional typed field, the deletion guard re-checks protection immediately before both normal and
forced removal, and force-confirming a dirty directory never bypasses the guard for a worktree a
prepared session still owns. These projections are in-memory only; no new setting keys persist them.

### Persistence boundary

Use the existing session row and session-entry tables for the preparing marker and lifecycle state.
Do not add a database migration for this flow unless current storage contracts prove insufficient;
any required new migration needs a separate concrete design decision before implementation. The
frozen prompt and attachments remain renderer draft data until Host activation admits them, avoiding
early transcript persistence or a second accepted-input store.

## Acceptance scenarios

1. First Send returns and opens a real session ID before the deferred Git promise resolves; a normal
   conversation subscription and session navigation target that ID while setup is visible.
2. During preparation no runtime or provider request exists, and no user message appears as sent.
3. After the worktree becomes ready, the Host constructs the runtime under the same ID with the
   worktree path as its initial cwd, then admits the frozen first input exactly once.
4. The authoritative user message appears in that session before agent output; the session remains
   indexed under the parent workspace and Git Tools resolve against its scoped execution worktree.
   Worktree Review reads its scoped repository while workspace-level Git summaries and plain-session
   panes continue to describe the parent checkout, including when both sessions are split onscreen.
5. Repeated activation, duplicate Send, navigation, remount, and reconnect do not create another
   session, runtime, worktree, or first-input admission. The per-workspace idempotency guard is
   acquired before awaiting Host session reservation, so concurrent composers with different
   submission IDs in one workspace join one reservation; the winning submission ID remains in
   recovery metadata.
6. Failure and explicit Cancel preserve the session ID and safely restore frozen editor content,
   attachments, and references without replacing newer edits.
7. Restart during preparation recovers the same session ID, reconstructs renderer pipeline state
   from Host branch/path/base-branch metadata, and checks Git state. It settles to ready when that worktree
   exists, or to a retryable failed state when it is absent or Git state cannot be read, without creating a runtime at the parent
   cwd. Live subscribers receive preparation state changes through a refreshed conversation
   snapshot. A reconnecting subscriber with an older transcript sequence also receives a fresh
   snapshot whenever the session has had Host-owned preparation metadata, including after activation
   clears the marker, because metadata changes do not advance the conversation sequence.
   Same-subscription resync must also return that authoritative snapshot, even when the client base
   matches the current transcript sequence.
   If metadata changes while a subscribe/resync frame is awaiting ACK/outbox admission, preserve that
   reservation; after it commits, send the updated snapshot before any later deltas.
8. Existing matching worktree activates in the same session without creating a second directory,
   including when the found path differs from the originally requested target — including the
   occupied-branch case where the requested target is absent: the Host preparation
   marker is realigned to the real path before activation, and a rejected realignment — or marker
   synchronization being unavailable for that prepared session — leaves a retryable failure instead
   of a ready entry the Host refuses. A stale Git registration whose directory is gone is a
   recoverable failure, never a ready entry; only `ENOENT` and `ENOTDIR` mean a missing path, while
   other filesystem errors propagate to the caller.
9. Missing/failed branch list uses HEAD and notes the default; invalid destination fails before Git
   creation; creation has no artificial delay in production (the optional
   `VITE_E2E_WORKTREE_CREATION_DELAY_MS` gate applies only to E2E/manual verification builds).
10. Plain sessions, palette Start, per-worktree Git Tools, sibling non-Git destination visibility,
    merge-status badge behavior, and the separate merged-session chat WIP retain their current
    behavior.
11. Reload during worktree creation restores the frozen text/editor state as an editable draft on
    the same prepared session; the Host reconciliation settles setup independently and does not
    dispatch the restored draft until the user sends it.
12. Two prepared sessions in one workspace keep independent pipeline entries: restoring an older
    failed session while a newer creation is running does not replace it, and only the matching
    session/attempt can settle its asynchronous result.
13. While the first response is still running, a second Send targets the already-active session
    through the ordinary queue/guide rules: preparation is already complete (conversation snapshot
    and sessions-index no longer carry the preparation marker), exactly one runtime exists, and no
    second reservation is attempted.
14. Repeat activation of the same session and attempt — including from a fresh Host process after
    restart — returns the existing session, creates no second runtime, and admits the frozen input
    at most once. A different workspace, a mismatched path or branch, or a stale attempt is
    rejected without side effects; an unknown original admission result is resolved through
    command reconciliation, never by re-sending the input under a new command id.
15. Navigating from draft A to chat B before the reservation ACK keeps B active and untouched: the
    late ACK still stores prepared session A and its recovery record, but does not switch the
    active chat, promote or overwrite B's draft, or move B's attachments. Submission ownership
    reflects only committed workspace/scope changes: an abandoned render cannot advance its epoch
    or invalidate a pending ACK, and a committed owner change advances the epoch once.
16. Deleting a worktree owned by a prepared, not-yet-cancelled session is refused in Command
    Center, including the force-confirmation path; cancelling the preparation releases the guard.
17. Failed creation → Retry through the setup-steps button while the Host seed still reports the
    failed attempt: the entry never rolls back to the failed attempt, the retried creation turns
    `ready`, the frozen submission is dispatched exactly once against the retry attempt with no
    further user action, the entry is consumed, and its recovery record is cleared so the
    "Unsent message saved" card disappears (BUG-GWT-005).
18. Same as 17, but the Host snapshot for the retried attempt reaches the renderer before the Retry
    acknowledgement resolves: restore adopts the retried attempt as `creating`, the stale-creating
    reconcile does not settle it while the acknowledgement is pending, the Retry handler starts Git
    for exactly the acknowledged attempt, the frozen submission is dispatched exactly once against
    it, and the Host is never told that attempt failed (BUG-GWT-005 Wave 4).

## Validation

- Add a Host/runtime integration regression with a deferred Git promise and a controllably deferred
  first model response. It must observe a real session ID and conversation subscription before
  resolving Git; then prove the same ID materializes one runtime at the worktree cwd, admits one
  first input, and completes preparation while the first response is still held — with the second
  message routed through the ordinary queue/guide.
- Cover Host restart/reconnect, activation idempotency (including durable `active` receipts and
  cold Hosts), failed/cancelled preparation, plain-session regression, and existing-worktree reuse
  at the owning boundaries.
- Renderer regressions for the composer use mounted component tests that assert actions and
  outcomes — late reservation ACK after navigation, restore of the full frozen submission including
  contexts, authoritative preparation updates over existing pipeline entries — rather than
  source-string checks.
- Update the pending desktop E2E candidate to assert real identity before setup completes, and keep
  it in manual-review/pending until the repository's fixture review/promotion process is satisfied.
- Run root typecheck, lint, architecture check, targeted tests, desktop E2E typecheck, and fixture
  validation. Report live E2E execution separately if it is not safe to run alongside the user's
  active development server.

## Reliability revision (2026-10-17)

The persisted marker and sessions-index summary carry the same optional attempt id. Preparing,
failed and cancelled worktree sessions remain listable while ordinary uncommitted drafts stay
hidden. The Host serializes attempt checks with marker writes and activation. Reopening a prepared
session can retry and activate that identity without the original empty-state intent control.
Recovery records and attachment ownership are scoped by session and submission id; multiple
failed submissions cannot overwrite each other. See review-reliability-fixes.md for the test matrix.

## Lifecycle completion revision (2026-10-17)

Six decisions closed by the worktree lifecycle review:

1. Preparation turns `active` at the admission boundary of the first frozen input, published to the
   conversation snapshot and sessions-index immediately; turn completion is no longer the trigger
   and persistence promotion is not admission evidence.
2. Activation is idempotent against the durable `active` receipt of the same attempt, including on
   a cold Host; unknown admission results reconcile through existing command receipts and the
   frozen input is never re-sent under a new command id.
3. Renderer pipeline entries accept authoritative Host preparation updates even when an entry
   already exists: newer attempts replace stale ones for the same session only, cancellation stops
   delivery, late Git results cannot restore `ready`, and same-attempt local `ready` survives until
   a terminal Host state.
4. Recovery records snapshot the full frozen submission — contexts included — and restore
   re-establishes exactly that submission without merging newer drafts.
5. Command Center deletion protects worktrees of prepared, not-yet-cancelled sessions and
   re-checks the guard immediately before normal and forced removal.
6. Occupied branches and `target-path-exists` both reuse an existing registered worktree, but only
   after the real directory and its Git binding are verified on the target Host; stale
   registrations fail recoverably without pruning.
