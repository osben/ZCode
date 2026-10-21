# First submission: instant chat UX (target)

Status: **product target for implementation** (2026-10-21). This document tells
agents **how the experience should feel** and what to optimize for. It does **not**
replace durability, identity, or recovery rules in
[`first-submission-lifecycle.md`](./first-submission-lifecycle.md) (FSL) or worktree
contracts in [`composer-worktree-setup-steps.md`](./composer-worktree-setup-steps.md)
and [`ui-draft-send-path.md`](./ui-draft-send-path.md). Those specs remain the
source of truth for **correctness**; this spec is the source of truth for
**perceived speed and non-blocking interaction**.

## North star (one sentence)

After the user passes synchronous eligibility checks and clicks Send, they must
**immediately** feel they are **in the conversation** with their **full message
visible as sent**, while the composer stays **free for the next draft**; everything
before the model (session reservation, worktree, uploads, runtime, admission) runs
**in the background** with clear status under the message, without holding the Send
button hostage for the whole pipeline.

## Three clocks (do not conflate them)

| Clock | User question | Target |
| ----- | ------------- | ------ |
| **P1 — Perceive** | “Did my message go in?” | **&lt; 1 frame after click** (same React commit): full text (+ attachments/context chips) appears as the **primary user turn** in the conversation column, not a secondary preview strip. |
| **P2 — Navigate** | “Am I in this task/chat?” | **Immediately after P1** (first async beat — see *P2 bind moment* below): pane binds to a **stable session identity** (real `sessionId`), normal chat chrome (header, timeline, composer dock), sidebar may lag but **must not gate** opening the conversation (FSL bind rule). |
| **P3 — Model** | “When does the agent answer?” | **Whenever preparation + admission complete**; TTFT and setup are **not** part of P1/P2. Show preparation under the message; never block P1/P2 on LLM or runtime ready. |

**P2 bind moment (single write point, decided 2026-10-21).** The pane binds when
the Host reservation identity — `{sessionId, commandId}` — is durably recorded:
the plain path binds at the `createSession` dispatch envelope (the session id is
client-proposed and stable across the ACK), the worktree path at the reservation
ACK. The bind is the only write point and is gated by navigation ownership
(FSL rule 7): a late identity never steals focus, and a pane returning to the
draft reconciles from the persisted first-submission record. IUX01's "same frame"
promises the user turn and the chat chrome (centered draft gone) in the click
commit; the real `sessionId` lands at P2, not in the same frame.

Reference apps (e.g. Craft Agents / PI Desktop in Harness) optimize by treating P1+P2
as **optimistic local truth** and reconciling with the server later. ZCode must reach
the **same user-visible outcome** while keeping FSL invariants (one session per
submission, command-id reconciliation, no duplicate dispatch).

## What “cool” means (product)

1. **No “dead Send”** — The submit control must not stay in a global `pending` state
   for the entire Host/Git/runtime chain. At most a brief local ack (one frame) or a
   per-submission status line; the user can start typing the **next** message right
   away (FSL rule 7).
2. **No draft limbo** — Avoid leaving the user on the centered “new task” empty state
   with only a header preview while `sessionId === null`. P2 should flip to bound
   session in the **same turn** as P1, before any network round-trip when possible
   (synchronous local session slot or immediate navigation to reserved id).
3. **One message, one identity** — Optimistic UI is allowed; **two user bubbles**
   for the same submission is not. Reconcile by `submissionId` / `commandId` (FSL
   rule 6), not by text match.
4. **Forks are honest** — Worktree, incognito, attachments, branch checkout, and
   queue choice are **visible preparation**, not silent blocking. Errors sit **under
   the frozen message** with Retry on the **same** session (FSL rule 4).
5. **Sidebar is async** — Task list rows remain Host-owned; a missing sidebar line
   must not mean “still on draft screen.” Conversation bind uses Host reservation
   identity directly (FSL owners section).

## Target flow (all first-send variants)

```text
User: Send (eligibility OK)
  │
  ├─ P1+P2 (sync, renderer): freeze submission snapshot; show user turn; bind pane to sessionId
  │     (reserve id locally or from last prewarm slot; persist recovery scope)
  │
  ├─ Composer: clear only the *submitted* snapshot; leave editor usable (next draft)
  │
  └─ Background pipeline (async, per variant):
        plain → submissionPreparation + config + admission
        worktree → worktreePreparation + Git + marker sync + activate + admission
        incognito → create route + reupload + admission
        then → CommandInbox → runtime → LLM (P3)
```

Worktree and plain paths should **feel the same** at P1+P2 even if background steps
differ. Today worktree is closer to this target than plain durable send; **plain
must catch up**, not worktree regressing to slower plain behavior.

## Comparison anchor (Harness / Craft / PI — patterns only)

| Pattern | Adopt for ZCode | Do not copy blindly |
| ------- | ----------------- | ------------------- |
| Empty or immediate `sessionId` before first text | Yes — user always “in a chat” after Send | Our prewarm/incognito/worktree markers differ; use `ui-draft-send-path` routes |
| Optimistic user row in timeline | Yes — satisfies P1 | Must reconcile with V4 projection + `commandId`; no second queue in UI |
| `optimisticMessageId`-style correlation | Yes — conceptually `submissionId` + `commandId` | Protocol already has command ledger; do not bypass CommandInbox |
| Clear composer before network returns | Yes — for **submitted** slice only | FSL: next draft must not be wiped; functional updates / separate scope |
| `await sendMessage` for whole UI | **No** — that is the anti-pattern to remove | Keep await only inside background worker, not on submit button |

## Anti-patterns (current gaps agents should fix)

These are **UX bugs relative to this target**, not permission to violate FSL:

1. **Bind chat only after `sendText` accepted** on the plain durable path — violates P2.
2. **`pending === true` for full `runSend`** — violates “no dead Send”.
3. **`submissionReady` false for entire active first submission** — blocks next draft;
   conflicts with FSL rule 7 unless worktree-only exception.
4. **Preview in `headerSlot` without authoritative user row** — acceptable only as
   **sub-millisecond** bridge; if it persists past P2, P1 is not met.
5. **Centered draft layout while `hasFirstSubmission`** — user is neither in empty
   state nor full chat; minimize duration to zero.

## Invariants (must not break while optimizing UX)

Carry forward from FSL and related specs without reinterpretation:

- One first submission per workspace identity + `submissionId`; no double Send.
- Unknown command outcome → reconcile original `commandId`; no auto re-send with new id.
- Worktree: runtime only in verified execution cwd; single admission of frozen input.
- Incognito: no incompatible prewarm; profile frozen at creation.
- Remote: `workspaceIdentity` end to end; no path-only matching.
- No new `setting.json` keys; fork storage rules unchanged.
- Desktop continuous vs mobile replayable semantics preserved.

## Acceptance (user-observable)

Agents should add or extend **mounted UI tests** and desktop E2E candidates for
these; unit tests alone are insufficient for P1/P2.

| ID | Action | Must observe |
| -- | ------ | ------------ |
| IUX01 | Plain text, first Send on draft | Same frame: user turn visible + chat chrome without the centered draft (`sessionId` binds at the P2 moment, first async beat); typing the next draft is never blocked; a second Send follows ordinary session readiness (`runtimeReady`), never an active-first-submission lock |
| IUX02 | Double-click Send | One session, one user turn, one admission attempt |
| IUX03 | Type next message during worktree Git | First message frozen; second draft intact; no owner steal |
| IUX04 | Navigate away before background ACK | Focus unchanged; return shows same session + message; no duplicate send |
| IUX05 | Slow Host (held reservation) | User still in chat with message; status “preparing” under message, not blank draft screen |
| IUX06 | Admission ACK before projection | At most one user turn; brief “syncing” ok; no second bubble |
| IUX07 | Preparation failure | Same session, message remains, Retry works; composer not globally locked |
| IUX08 | Sidebar slow | Conversation usable before sidebar row appears |
| IUX09 | Restart mid-preparation | Recovery without auto-dispatch; explicit continue |

## Suggested architecture direction (for implementers)

Order matters; later steps assume earlier ones.

1. **Split submit transaction** — Synchronous: freeze the submission snapshot,
   **claim the draft** (editor cleared in the same commit, persist echo suppressed),
   render the optimistic user turn, fire the background chain. `pending` UI state
   covers only this synchronous phase; the repeat-submit idempotency ref stays
   armed until bind/remount or restore. Asynchronous (one closure that survives
   composer unmount): reservation → uploads → `sendText` → scope moves, reading
   only the frozen snapshot, module draft stores, and the reserved session id —
   never the composer's live owner/scope.
2. **Unify P1+P2 across plain and worktree** — Same navigation moment; background
   pipeline injects only timeline status rows.
3. **Authoritative projection as reconcile, not gate** — Hide the optimistic row
   only when a real `realUser` row is visible in the window: strict
   `sourceCommandId` match first, with the fresh-session fallback (any `realUser`
   row in this session's window — the first submission is definitionally the
   first user row of a fresh session; guards against optional `sourceCommandId`
   in projected rows). Queue-item visibility alone must NOT hide the row (that
   was the header-preview blink); during the admitted-queue phase the row shows
   the synchronizing status. Never show two bubbles for one submission.
4. **Composer pending scope** — `pending` only for the synchronous submit phase
   plus the repeat-submit idempotency guard, not for the entire pipeline. Next
   draft uses separate scope/generation (already in the draft store).
5. **Reservation before await** — Fire `createSession(submissionPreparation)` or
   worktree preparation without awaiting completion before P2; bind once at the
   P2 moment; handle failure on the bound session's timeline.
6. **Telemetry** — Keep TTFT from admission/runtime; do not attribute setup wait
   to “Send latency” in product analytics. This change audits existing points
   only; no new instrumentation.

## Flag lifetimes (decided 2026-10-21)

| Flag | Set | Cleared |
| ---- | --- | ------- |
| `pending` (UI) | freeze | background chain fired (same tick) |
| repeat-submit idempotency ref | freeze | bind/remount, restore, or chain end |
| `activeFirstSubmissions` entry | freeze | real-row projection accept or failure restore |
| optimistic user row | P1 commit | reconcile predicate above |
| first-submission `submissionReady` lock | — | removed; ordinary session readiness gates the next Send |

## Verification

- `pnpm typecheck`, `pnpm lint`, architecture check on touched modules.
- Focused tests: `firstSubmissionPreview`, `firstSubmissionProjection`, late ACK /
  worktree dispatch harnesses, SessionPane bind tests — updated for IUX01–IUX09.
- Report any E2E not run.

## Related documents

- [`first-submission-lifecycle.md`](./first-submission-lifecycle.md) — durability,
  recovery, bind semantics.
- [`ui-draft-send-path.md`](./ui-draft-send-path.md) — prewarm vs create routes.
- [`composer-worktree-setup-steps.md`](./composer-worktree-setup-steps.md) — Git and
  activation pipeline.
- [`docs/task-first-submit-visibility.md`](../docs/task-first-submit-visibility.md)
  — historical sidebar timing (superseded for visibility by FSL).

## Agent handoff prompt (paste into task)

When implementing first-send UX, read this file and FSL together. **Goal:** P1+P2
instant, P3 async. **Do not** wait for `sendText` accepted to bind the pane on plain
send. **Do not** hold `pending` across the full Host pipeline. **Do** show one user
turn immediately, bind `sessionId` immediately, free the composer for the next draft,
run reservation/worktree/upload/runtime in the background, reconcile projection by
`commandId`, and keep all FSL failure/retry/identity rules.
