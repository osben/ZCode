# First submission: immediate conversation and durable failed preparation

Status: accepted implementation contract, 2026-10-20. Applies to ordinary,
incognito, execution-worktree and combined first sends on Desktop and shared Web
UI. This supersedes the visibility timing in `docs/task-first-submit-visibility.md`
and the failed-empty-incognito cleanup rule in `specs/ui-draft-send-path.md`.

**UX target (instant chat, non-blocking composer):**
[`first-submission-instant-ux.md`](./first-submission-instant-ux.md) — perceived
speed and P1/P2/P3 clocks; does not relax the durability rules below.

## Product rules

1. After synchronous eligibility checks pass, capture the text, attachment IDs,
   context, model/mode, incognito profile and workspace identity as one submission.
   Show the conversation with the complete user message before awaiting Host,
   branch/worktree, upload, configuration or runtime work. Preparation failures
   and unresolved outcomes appear below the message; ordinary in-progress
   preparation shows no extra label (the message itself is the feedback; worktree
   setup keeps its step rows). Do not clamp the submitted text.
2. Before Host identity exists this is a recoverable local intent, not an accepted
   prompt or an invented sidebar row. The sidebar continues to use real Host rows.
   Binding the Host session must preserve the same visible message and composer.
3. Once Host creates a submitted session, keep it through Git, upload and runtime
   errors, navigation and restart. An unsubmitted prewarm may still be deleted.
   Runtime readiness and prompt acceptance are separate facts from reservation.
4. Errors remain below the original message. Explicit Retry reuses the reserved
   session and frozen submission. It may retry preparation known not to have
   admitted input. An unknown command outcome must be reconciled by the original
   command ID, never automatically resent with a new command/session ID.
   A failure before any reservation keeps no recovery record, so there is no
   error row: the text returns to the editor and the failure is announced with a
   notice (`chat.error.sendFailed`). A Send refused by the submit predicate
   (`resolveComposerSubmitBlockReason`) with content names its reason in a notice;
   it never returns silently.
5. Restart restores a non-running recovery state and offers explicit continuation;
   restoring a record never automatically dispatches the saved prompt.
6. Reconcile the pending message by accepted input/command identity, not matching
   text. Either arrival order of ACK and projection must produce one user message.
7. A second click cannot create another first submission. The user may compose the
   next draft while preparation proceeds; settlement cannot erase newer text/files.
   Navigating away detaches navigation ownership: a late ACK cannot steal focus.
8. Cancelled validation/checkout confirmation leaves the input recoverable. Invalid
   input never becomes a durable submitted session. User deletion remains explicit.
9. Worktree runtime starts only in its verified execution cwd. Incognito profile is
   frozen before runtime startup. No reuse of an incompatible ordinary prewarm.
10. A prewarm `createSession` (no `firstInput`) is config-only: it does not own the pending
   task draft and does not record a command for it. Its project scope is the one captured when its
   generation started (see `specs/sidebar-new-task-outside-project.md`, Draft lifetime).

Ordinary messages and attachment/context-bearing input use this lifecycle. Native
control slash commands retain their existing command-specific admission semantics.
Binary File contents are not stored in localStorage: after renderer restart, a
saved file manifest may require explicit reattachment; clipboard-text files retain
the existing local rehydration path. A saved session and its message text remain.

## Owners and event order

Renderer owns unaccepted local intent and its preview/recovery; Host/CLI owns real
session identity and durable preparation; CommandInbox owns accepted input and
exactly-once admission. Timeline/queue are projections, not another input queue.
Binding a reserved first submission commits directly from the Host reservation
identity (scope promotion and view navigation) and never waits for the project
tree or sidebar projection of the new row: draft-workspace rows may reach that
projection late or never, and a bind stalled on them leaves the conversation
unreachable. Group placement of the new row is the exception: it stays staged on the
row becoming readable, because admitting earlier fails host-side with
`task-group.created-task-unavailable`. The bind happens when the reservation
identity is recorded — plain paths at the `createSession` dispatch envelope (the
session id is client-proposed and stable across the ACK), worktree paths at the
reservation ACK — as the single bind write point, gated by navigation ownership
(rule 7); a skipped bind is reconciled from the persisted first-submission record
when the pane returns. The submitted draft is claimed synchronously at freeze
(editor cleared, persist echo suppressed); between freeze and admission the send
closure may read only the frozen snapshot, the module draft stores, and the
reserved session id — never the composer's live owner/scope. The
active-first-submission flag clears on accepted real-row projection or failure
restore, not at send-chain completion. The reserved session's task-index row is
admitted with CLI facts at reservation (sidebar reads list only cli-admitted rows),
and the immediate bind bumps the workspace task-list version so the grouped sidebar
tree re-reads on its own subscription. The reserved session persists with the
«New session» placeholder title; the first real input replaces it with the
first_input title instead of leaving «Untitled session» forever. A promoted ordinary prewarm binding is
consumed: after first use it is detached, so a later submission in the same draft
pane reserves a fresh session instead of targeting the already-used one the CLI
must reject.
A failure or unknown outcome is persisted in the scope the user is viewing: the
reserved session scope only once the bind moved the record there, otherwise the draft
scope with the `reservation` kept inside the record, so Retry still reuses it. Every
unknown command outcome is registered in the unsettled-submission ledger and is
reconciled by its original command id (instant-UX spec, Reconciliation). A send that
ends before any Host reservation exists (cancelled checkout guard, failed preflight,
storage failure) withdraws the frozen submission at every return site: the record is
deleted, the active flag cleared, and the text returns to an empty editor; when the
editor already holds a newer draft the text is kept as a plain recovery card without
`firstSubmission`, never as a second optimistic turn.
Use `workspaceIdentity?.trim() || workspacePath` throughout; preserve remoteSessionId,
owner/lease and stale-attempt checks. Do not add setting.json keys or change frozen
upstream migrations. Desktop continuous and mobile replayable keep their delivery
and reconciliation semantics.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Composer / local submission
    participant H as Host / durable session
    participant R as Runtime / CommandInbox
    U->>C: Valid Send
    C->>C: Freeze intent; show complete message
    C->>H: Reserve submitted session
    H-->>C: Real session identity and task facts
    C->>C: Bind same view; real sidebar row
    C->>H: Prepare Git / uploads / runtime
    alt preparation fails
        H-->>C: Preserve session; observable failure
        U->>C: Explicit Retry
        C->>H: Continue same session
    end
    C->>R: Admit input with stable command ID
    R-->>C: ACK and authoritative projection, either order
    C->>C: Replace matching preview once
```

## Acceptance and verification

### Reservation interface

Capability `durableFirstSubmission` gates the generic no-runtime reservation.
`createSession({workspaceId, sessionId?, submissionPreparation: {submissionId},
incognito?})` creates a real persisted session before starting a runtime.
Activation calls `createSession({workspaceId, preparedSessionId,
expectedSubmissionId: submissionId, incognito, config, firstInput?})` and returns
the same session ID. A mismatched submission ID must reject without starting a
runtime. The optional snapshot/summary `submissionPreparation` contains
`submissionId`, `status: "preparing"`, `createdAt` and `updatedAt`; loading it never
starts execution. The profile remains frozen across reserve and activation.
Older CLI builds without the capability retain their supported creation route;
the UI must not issue an unrecognized reservation or claim durable preparation
before Host has confirmed it.

| ID    | Setup/action                                             | Required assertion                                                                           | Evidence                                        |
| ----- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| FSL01 | Hold first-create/prewarm/config ACK; send ordinary text | Full message visible before releasing any held IO; no progress label                         | Mounted UI + pending Desktop scenario           |
| FSL02 | Delay worktree reservation/Git                           | Full message precedes setup rows; no clamping; same identity after binding                   | Mounted UI + pending Desktop scenario           |
| FSL03 | Incognito attachment upload fails after session creation | Same session remains; original files/profile retained; no sendText or deleteSession          | SessionPane regression                          |
| FSL04 | Runtime/Git preparation fails                            | Durable session and pending message survive reopening/restart; explicit Retry reuses session | CLI persistence + UI + pending restart scenario |
| FSL05 | ACK/projection arrive in either order                    | One user message; stable input identity; no repeated dispatch                                | UI projection regression                        |
| FSL06 | Double Send or navigate then late ACK                    | One reservation; focus unchanged; next draft/files preserved                                 | Mounted composer regression                     |
| FSL07 | Unknown create/send outcome then recovery                | Query original command; no new automatic create/send                                         | Command recovery regression                     |
| FSL08 | Same path, different remote identities                   | Submission, failure and retry remain isolated                                                | Identity regression                             |
| FSL09 | Restart with pending saved intent                        | Recoverable display; zero automatic prompt dispatch                                          | Recovery regression + pending Desktop scenario  |

Unit/component results do not prove Desktop rendering latency or restart behavior.
Pending E2E cases remain candidates until executed and human-reviewed; no automatic
fixture promotion or Docker admission is implied.

## Implementation order

1. Record this contract and failing focused regressions, preserving unrelated work.
2. Extend the existing reservation/materialization boundary to submitted ordinary
   and incognito sessions; retain frozen profile, cwd and attempt ownership.
3. Add immediate first-submission presentation and identity reconciliation using
   existing draft/recovery owners. Render message above preparation.
4. Preserve failed reserved sessions and implement explicit same-session recovery.
5. Run focused UI/CLI regressions, `pnpm typecheck`, `pnpm lint`, architecture check
   and relevant E2E when available. Report actual failures and unexecuted coverage.

No commit, push, PR, migration application or persistent user-data deletion is
authorized by this implementation plan.
