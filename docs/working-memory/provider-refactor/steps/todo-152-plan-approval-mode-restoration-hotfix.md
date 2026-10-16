# Todo152: Restore Permission Mode After Plan Approval and Sync the Composer (Hotfix)

Status: Superseded by Todo151; do not execute this separately. On 2026-09-15, the user chose to split permission state from Plan directly. The post-approval UI residue was incorporated into [Todo151](./todo-151-independent-plan-state-draft.md). The following preserves the historical proposal from 2026-09-14 and is not the current decision—especially, do not rebuild the `prePlanMode` restoration path based on this item.

## Required Fix

1. After `ExitPlanMode` is genuinely approved and exits successfully, the input must no longer retain this Plan. It shows the permission mode restored by the execution side; the next ordinary message must not re-enter Plan from an old draft.
2. Restore the permission mode from before entering Plan. For an existing session, reuse the explicit permission mode held before entering in that session. For a new session, use the permission mode determined before entering Plan during ordinary task creation, including an explicit user choice. Do not always fall back to `build` regardless of source, and do not always elevate to `yolo`.
3. Both sides restore the same target permission mode. The UI must not show restoration while Runtime still executes in another mode. Approval continues the current Turn and does not create a user Submission; denial/feedback does not exit Plan.

```text
Existing-session permission / new-task initialized or explicitly selected permission
                                   ↓ save return target for this Plan
                               submit Plan
                                   ↓ approved and exited successfully
                 Runtime restores target → Composer syncs exit from this Plan
```

## Verified Code Facts and Implementation Constraints

- `core/src/runtime/session-mode-port.ts` keeps an in-memory `prePlanMode` and falls back to `build` when absent. `methods/config.ts` remembers the previous value for ordinary mode switches, but when the initial config is already Plan or on cold recovery, the previous value may not exist.
- `ui/src/v4/composer/useDraftConfigControl.ts` initializes the draft from Session only once and does not follow the subsequent exit; this leaves the draft in Plan after the execution side has exited.
- `newTaskDraft.ts` chooses `recent.mode ?? build` for ordinary new tasks. `composerRecent.ts` also writes Plan to recent after a Submission is accepted. Therefore, preserve the return target before entering/submitting Plan; do not read `recent` at approval after Plan has overwritten it, and do not assume a new Runtime's default `build` expresses the user's intent.
- Do not identify an existing session solely by presence of `sessionId`: a pre-created session before first submission does not imply a history of explicit permission choices.
- Prefer the existing return-target mechanism. Refine the minimum information needed through entry points or persistence during implementation. If legacy records truly have no permission facts, conservatively use `build`; do not guess full access.
- Synchronize only this real exit. Do not clear message body, model, or attachments; do not let general snapshot updates continuously overwrite the user's draft; do not overwrite a new permission/Plan choice explicitly made later by the user. Repeated/replayed events must not consume the exit effect a second time.
- Do not split mode, change system prompts, alter Plan/Goal mutual exclusion or tool permissions. Desktop local and mobile shared-host must use the authoritative exit result; do not add a queue or cross-client broadcast of a permission default.

## Acceptance

- Existing sessions entering Plan from `build`, `edit`, and `yolo` restore consistently in Runtime, input, and subsequent ordinary Submission after approval, without requiring another message to exit.
- A new session entering Plan from the recent permission or an explicit user choice retains its return target, including when the first run is already Plan. A recent value overwritten by Plan cannot change the return target.
- Denial and feedback keep the user in Plan. Updating the next draft before/after approval is not overwritten by a stale exit event; body and model selection remain unchanged.
- Check remount, cold recovery, duplicate events, and mobile reconnection. Missing historical facts do not crash or elevate permission.
- Add unit and interaction E2E tests before implementation; afterward review and run type, lint, and architecture checks, documenting unverified environments. This document is historical only and does not indicate that the above acceptance has passed.
