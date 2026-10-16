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
remains in the existing worktree service flow and keeps its five-second delay unchanged.
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
   |                                | start worktree -------->| (5s delay kept)  |
   | render progress in timeline   |                         |                  |
   |                                |<------ ready(path) ------|                  |
   | activatePreparedSession ----->| validate preparation     |                  |
   |                                | materialize same ID with |----------------->|
   |                                | executionWorktree=path   |                  |
   |                                | accept first input once  |----------------->|
   |<----- normal session events ---|                         |                  |
```

Every asynchronous pipeline completion carries the prepared session and attempt identity it started
for. Restoring or retrying an older preparation cannot replace another session's active pipeline, and
a stale completion cannot mutate a newer retry or another prepared session.

The renderer must not create a replacement session, send to a parent-cwd runtime, mutate cwd after
runtime creation, or own an accepted-input queue. The Host activation operation is idempotent by
session ID and preparation token: duplicate activation returns the existing result and cannot admit
the first input twice. Runtime creation is gated on a validated, existing worktree directory.

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
- `active` means the runtime was constructed with that path and the first input was admitted once.
- `failed` preserves the same session identity and a recoverable error. Retry reuses the session ID
  and preparation token rules; it does not create another session.
- `cancelled` drops the frozen submission and safely restores it to the editor if its revision has
  not changed. It does not delete a worktree that Git may have finished creating.

The preparation marker and state must survive Host restart/reconnect sufficiently to render a
recoverable preparation session. If the Host restarts while Git may still be running, recovery checks
the target worktree by branch/path and settles to `ready` or `failed`; it never starts a runtime until
the path is validated. The renderer stores the frozen text/editor draft in a local recovery scope
keyed to the prepared session, restores it into that session's editable draft after reload, and must
not resubmit automatically after a reconnect unless Host activation confirms that the first input was
not admitted. Attachments backed by in-memory `File` objects remain subject to the existing composer
draft persistence limitation.

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
- On failure or cancellation, restore frozen text, attachments, and references only when the editor
  revision still matches the frozen revision. Never overwrite newer text. A failed session retains
  its setup error and Retry action.
- Navigation away, tab unmount, and reconnect detach the renderer-local callback, restore the frozen
  draft, and keep Host-owned preparation running. Returning to the session ID resumes the same
  progress state. Explicit Cancel is the only user action that abandons the queued submission.
- Attachments-only submissions follow the same lifecycle without a text preview.
- The attachment IDs in a queued submission are frozen at queue time; attachments added while Git
  setup runs remain in the next draft and are not sent with the queued message.

### Existing worktree and branch-list behavior

Existing worktrees reuse the same prepared session and activate in place; do not transfer the draft
to a second workspace or create a second directory. Before retrying a non-active prepared session
with different frozen parameters, update its Host marker to the new branch, target path, and base
branch so activation validates against the same values Git used. A missing or failed branch list
degrades to base=HEAD, with a visible note; it does not block Send. Invalid custom/global target
locations remain synchronous failures before the session starts Git creation.

The Command Center “New task in worktree” action remains its separate Start-driven flow and opens its
own workspace. Its branch-name collision avoidance and shared `executeWorktreeCreation` request
semantics remain intact.

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
   acquired before awaiting Host session reservation, so concurrent composers join one reservation.
6. Failure and explicit Cancel preserve the session ID and safely restore frozen editor content,
   attachments, and references without replacing newer edits.
7. Restart during preparation recovers the same session ID, reconstructs renderer pipeline state
   from Host branch/path/base-branch metadata, and checks Git state. It settles to ready when that worktree
   exists, or to a retryable failed state when it is absent or Git state cannot be read, without creating a runtime at the parent
   cwd. Live subscribers receive preparation state changes through a refreshed conversation
   snapshot. A reconnecting subscriber with an older transcript sequence also receives a fresh
   snapshot whenever the session has had Host-owned preparation metadata, including after activation
   clears the marker, because metadata changes do not advance the conversation sequence.
   If metadata changes while a subscribe/resync frame is awaiting ACK/outbox admission, preserve that
   reservation; after it commits, send the updated snapshot before any later deltas.
8. Existing matching worktree activates in the same session without creating a second directory.
9. Missing/failed branch list uses HEAD and notes the default; invalid destination fails before Git
   creation; the five-second delay remains unchanged.
10. Plain sessions, palette Start, per-worktree Git Tools, sibling non-Git destination visibility,
    merge-status badge behavior, and the separate merged-session chat WIP retain their current
    behavior.
11. Reload during worktree creation restores the frozen text/editor state as an editable draft on
    the same prepared session; the Host reconciliation settles setup independently and does not
    dispatch the restored draft until the user sends it.
12. Two prepared sessions in one workspace keep independent pipeline entries: restoring an older
    failed session while a newer creation is running does not replace it, and only the matching
    session/attempt can settle its asynchronous result.

## Validation

- Add a Host/runtime integration regression with a deferred Git promise. It must observe a real
  session ID and conversation subscription before resolving Git; then prove the same ID materializes
  one runtime at the worktree cwd and admits one first input.
- Cover Host restart/reconnect, activation idempotency, failed/cancelled preparation, plain-session
  regression, and existing-worktree reuse at the owning boundaries.
- Update the pending desktop E2E candidate to assert real identity before setup completes, and keep
  it in manual-review/pending until the repository's fixture review/promotion process is satisfied.
- Run root typecheck, lint, architecture check, targeted tests, desktop E2E typecheck, and fixture
  validation. Report live E2E execution separately if it is not safe to run alongside the user's
  active development server.
