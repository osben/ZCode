# Todo151: Independent Plan state, input marker, Queue submission-field fidelity and save/restore

Status: in progress (2026-09-15; the user approved the discussion and started implementation). This Todo
also supersedes the Todo152 `prePlanMode` hotfix (the superseded Todo152 draft was removed; full history:
`git show 45f808f7:docs/working-memory/provider-refactor/steps/todo-152-plan-approval-mode-restoration-hotfix.md`);
the file name is kept for existing references.

## Final decisions

- User permission is `mode: build | edit | yolo`; Plan is a separate `planEnabled: boolean`. The Runtime-internal `auto` is not refactored here.
- Permission and Plan are independent: `yolo + Plan=true` is legal and still applies the existing planning-tool limits. Approval only turns Plan off and does not restore/rewrite permission; the new path no longer depends on `prePlanMode`.
- Plan and Goal stay mutually exclusive. Approval continues the current Turn and does not auto-send a new user message.
- No visible history hint for entering/leaving Plan and no new event type for it; running state is still delivered to clients through the existing config-sync chain.
- System prompt text, MCS transport and existing tool capability rules are unchanged; only the trigger basis of the existing planning/exit reminders changes.

## UI and draft

- The selection menu keeps four items: "Plan" at the top, a divider, then the three permissions (existing order). The three permissions change only permission; "Plan" toggles by its checked state (unchecked -> enable, checked -> click again to disable), never overrides permission, with no extra permanent entry.
- The marker sits right of the permission, separated by an independent 12px-high vertical line with `gap-1` (4px) on both sides; icon plus English "Plan" / Chinese "计划" form one button reusing the adjacent menu-button ghost style, 28px height, font size and padding. Text uses the `@xl/composer` container breakpoint and the toolbar decides by actual space (permission collapses first, then provider prefix, Computer and Plan): narrow = icon only, both permission and Plan buttons are 28x28 squares (`size-7 p-0`); wide = auto width with text; the whole button is always closable with an accessible name; both states use the shared toolbar Tooltip ("关闭计划模式" / "Turn off Plan mode") on hover or keyboard focus. Text and icon use `text-foreground-subtle`, kept on hover. Default shows a light bulb; hover/keyboard focus swaps it in place for a close icon (no trailing x); on touch the bulb stays and clicking the whole button closes Plan. Closing only clears the draft Plan and changes no permission or model request. DESIGN.md, themes and i18n apply.
- `/plan` reuses the enable-marker logic; the permission-cycle shortcut cycles only the three permissions; other Agents' mode support is unaffected.
- The marker is not cleared by submit success, Guide send or turn end — only by the user's explicit close, or when this plan's approval has been processed.
- Rejection/feedback does not touch the draft (the marker stays if present; if the user already closed it, it is not auto-restored); general Runtime snapshots must not keep overwriting the draft.
- Body, attachments, model and permission are not cleared by approval. The user accepted a simplification (2026-09-15): the first arrival of the previous approval result still closes the marker even if the user re-selected Plan meanwhile; the same tool result applies only once.
- When the model really enters via EnterPlanMode, the draft marker of that session is enabled in a targeted way; the result applies directly on first arrival (no ignored-tool list collection, no association with a draft revision). General snapshots still do not keep overwriting the draft; reject/feedback produce no marker transition.
- Menu Plan is an independent checked state; the three permissions below the divider are mutually exclusive single-select. Following old staging V4, the EnterPlanMode tool row stays hidden; the existing "Plan Mode on" component is not re-shown as history.

## Submission and Runtime

```text
menu permission/Plan choice or marker close -> update the input draft only
  -> at submit freeze mode + planEnabled
  -> normal message / queue / Guide consumed -> apply Runtime permission and Plan separately
accept plan -> Agent handles approval -> Runtime Plan=false, mode unchanged
  -> clear the matching draft marker -> continue current Turn
```

- A new Submission carries both values explicitly; `false` means off and is not the same as a missing field; old requests missing fields are handled at the compatibility entry.
- Guide is not special: carrying true enters/keeps Plan, false leaves/keeps non-Plan. Closing the marker itself does not change execution immediately; it applies when a later submission is consumed.
- Accepted queue items keep their submit-time state and are not rewritten by later drafts or approval results. Queue admission, consumption timing and ownership are unchanged; executed operations are not withdrawn.
- Submission, EnterPlanMode and ExitPlanMode share one Plan-transition logic; the first permission decision and re-validation after parameter changes both read it so yolo cannot release early; existing MCP and memory-file special cases stay.
- Runtime state change and draft change are separate. Rejection keeps today's behavior (ends the turn without actively leaving Plan); feedback continues planning; neither writes the draft. An approval not delivered/processed must not be claimed approved; the marker is not cleared only after a later model request or whole-task success.
- Existing full/short planning reminders read `planEnabled`; on a real exit the existing exit reminder is attached (both Guide and tool exit) so the model does not keep following the old planning instructions after permission is lifted. Prompt text unchanged.
- SessionModePort, tool state-transition return types, Enter/ExitPlanMode return Schema, handlers and consumers change together so a switched state is not rejected by an old `mode=plan` return validation. Historical tool results display compatibly and are not rewritten.
- Old requests convert once at the admission boundary: explicit `planEnabled` (including false) wins; only old mode=plan -> Plan on and the current base permission kept; only an old non-Plan mode -> switch permission by the old semantics and Plan off; neither present -> freeze the current execution state. Queue execution never re-reads current state to guess.

## Queue submission-field fidelity (part of this change)

Root cause: `onTurnSteerQueued()` in `product-projection.ts` hand-built the QueueItem and dropped `mode`,
`modelSelection`, `sharedContextRefs` and `provenance`. The QueueItem schema already reuses
`ConversationInputIntent` but the fields are optional, so the omission was not rejected; queued promotion
then rebuilds the intent from the QueueItem, losing submitted permission/model facts (not only display).

```text
Composer freezes the submission -> Command payload -> Runtime intent -> pending input
  -> QueueItem -> intent at promotion -> Runtime applies; the same submission facts throughout, never re-reading the composer
```

- Reuse the existing public input facts and protocol adapter entry, centralizing intent <-> QueueItem conversion; no second nested Submission protocol and no full sendText payload in the queue. Temporary `modelExecution` auth material never enters the persisted queue.
- Pass existing model selection, permission, attachment/shared-context references, provenance and delivery/order info completely; complete the reverse conversion of provenance; the new `planEnabled` flows through too, preserving `false` (no truthy checks).
- Queue, in-place edit, reorder, automatic and manual promotion keep submission fields the operation did not explicitly change; a text-only edit must not clear model/permission/Plan. Queue order, admission/consumption timing, command dedupe and provenance ID semantics unchanged.
- No SQL migration; existing records with missing fields use the existing compatibility handling and never guess from the current draft.
- Normal Guide validates its original intent consumption; a Guide that falls back to queueing validates the Queue round trip. Fixed-execution-model tasks still restrict model switching but must not skip the permission/Plan state explicitly requested (split the application boundary rather than deleting the fixed-model protection).

## Persistence: no bulk migration of old data

Old baseline `staging_backup @ 790884b1ce4b990583ab40625b5f283e2169eb36`: `prePlanMode` was memory-only; the default `SessionModeChanged` is also an in-memory event, not reliable SQLite history. `session.permission.mode` is creation-time info, `local_setting` is project preference, and App `tasks.mode/meta_json` is a task-index snapshot; none may be mixed as the latest session state or pre-Plan permission.

- No scan/backfill of old sessions and no migration; compatibility is handled at the unified read entry, keeping old fields, values and unknown content.
- Use the existing session_entry to save `runtime/execution_state` with data `{mode, planEnabled}` (one record, both values, Runtime-applied state only), written on creation/real change, not by startup scan. `session.permission` data stays; cold and branch recovery are completed without letting task-index or project preference override the new session record.
- Old non-Plan mode maps to the same permission + Plan=false; old Plan maps to Plan=true, with the pre-Plan permission used only when reliable, otherwise conservatively `build` (never guess full access). Project preference / stale index cannot be taken unconditionally as the original permission.
- New/old remote protocols must not silently drop Plan and then execute; compatibility with old requests does not mean old executors may ignore new requests. Rollback verification distinguishes "old-version tasks/sessions readable" from "old version accurately restores new Plan": this change guarantees the former and new-version recovery, does not rework the old version's incomplete Plan cold recovery, and does not claim old programs understand independent Plan. If the old read contract needs compatible writing, limit it to what keeps content readable and keep evidence.
- Session content/tasks open across upgrade, rollback and re-upgrade without errors on the missing new field; unsaved old-version facts are not forced to recover. If a table/column is finally needed, confirm a structure migration with the database owner separately.
- Boundary: zero SQL structure migration and zero bulk rewrite. `session_input.payload`, message/part JSON, task index and automation startup config stay compatible with old `mode=plan` (no deleted-enum unreadable records); new inputs save the new field. localStorage drafts and recents are compatible separately: an existing task's old Plan draft keeps planning intent; an old Plan in recent preference is not given to another new task; new tasks default Plan=false; without a reliable base permission be conservative; never clear body or model alongside.

## Impact and invariants

Draft init/save, switch/refresh, new-task prewarm and first-send transfer; normal send, queue, Guide; share import and other entries reusing new-task behavior; shared types and runtime schemas, command admission / input facts, config sync and snapshots, session and branch recovery (the existing `snapshot.plan` is todo steps and must not be reused as a mode switch); Goal mutual-exclusion checks both ways; CLI old Plan flag; Subagent permission declaration/inheritance; scheduled/off-peak task saving and launch parameters (each entry's existing execution and fixed-model boundary kept). Desktop, local/remote workspace and phone shared-host semantics are identical; desktop-continuous vs web-remote-replayable boundaries, workspaceIdentity isolation, remoteSessionId routing and Runtime queue authority unchanged. Provider, model resolution policy, signing, usage and other Agent implementations are out of scope; model selection only fixes the Queue pass-through loss. A new task does not inherit Plan (default off); permission follows the existing new-task rule.

## Acceptance and order

1. Fix the JSON save/compat scheme and update formal spec, feature graph, conversation case catalog and coverage matrix; correct the graph's old "/plan switches mode then sends" description.
2. Tests first: real-event Queue projection and promotion round trip asserting model, mode, planEnabled (including false), attachment/context and provenance preserved; in-place edit, reorder, auto/manual promotion and Guide fallback; regression that a yolo submission queued while running still checks tool permission as yolo.
3. Three permissions + Plan; approve, reject, feedback, manual close; Guide true/false switching and matching reminders/permission; idempotent same value; Plan applied without a model change, including fixed-execution-model tasks.
4. New-task first send, prewarm, draft transfer, queue freeze, late approval overriding the marker on first arrival while duplicate results do not re-apply, old-format missing fields, cold and branch recovery, rollback readability and no permission loosening.
5. Desktop interaction E2E (Plan on top, divider, three permissions, queued permission taking effect), touch/keyboard, theme/i18n, and phone approval/reconnect verification; no prompt changes for tests; old-data compat via isolated fixtures, never user databases.
6. After implementation: unified review, typecheck, lint, architecture check, related unit/E2E, record actual results and unverified environments, then commit. Acceptance must cover both `yolo + Plan=false` queued-then-applied permission and `yolo + Plan=true` still having planning limits and plan approval ("yolo needs no approval" is not generalized to Plan).

## Implementation record (2026-09-15; in progress, not fully accepted)

Landed locally: shared execution-state resolution, permission/Plan separation, normal input / Guide
consumption, fixed-model branch permission application; Queue projection and promotion keep the Submission's
model, permission, Plan (including false), shared context and provenance; Enter/Exit tools, first and
repeated permission checks and reminder triggers (prompt text unchanged); Composer four-item menu,
independent marker, draft saving, no Plan inheritance for new tasks, tool-transition sync; session_entry
save/cold recovery without SQL structure or backfill (history branch entry and prompt message use the same
historical state); Subagent keeps the parent base permission when inheriting Plan (Explore and explicit
permission declarations unchanged); independent-Plan capability handshake between new Host and the real
CLI (an older end must not strip the field and run with full access); V4 Goal create/resume exclusion
(failing test first).

Verification: Core 9 files / 324 pass (real Runtime Guide, persistence, branch, Subagent); Bootstrap 5 files
/ 113 (Queue and native commands); UI/draft/share/approval-receipt/server capability 8 files / 55 (counts
overlap, not cumulative coverage). Root typecheck and CLI contracts/core/bootstrap typechecks pass; root lint
0 errors / 42 warnings (CLI excluded by default, so oxlint without ignores was run on the CLI files of this
change: 0 errors, not whole-CLI lint); architecture 0 violations; `git diff --check` passes. A wider
Core/Bootstrap suite had other failures not all compared with HEAD, so no "all baseline" or "full
regression passed" claim. Linux desktop E2E failed before the test body (ChromeDriver session creation).

Simplified draft sync (2026-09-15, per user confirmation): removed `ignoredPlanToolCallIds`, message-window
tool-ID collection and related hook parameters; new tool transitions assign `planEnabled` directly;
`lastPlanTransitionId` stays so a repeated snapshot does not re-apply the same result. Verified: first
arrival of enter/exit overrides a manual re-selection, no re-clearing after re-enabling when the same
replay recurs, no transition means no draft change (4 files / 23). typecheck, lint (0 errors / 42), E2E
typecheck, approval fixture check and architecture pass.

Pro E2E (2026-09-15, dedicated MacBook Pro isolated copy `/Users/dev/Desktop/projects/Z.AI/todo151-pro.hGJ5yI/repo`,
not the Pro working tree or real user data): the approval case asserts the Plan marker before/after
entry/approval with yolo unchanged. Test-sync fixes (no product change): the Plan marker update precedes
the DropdownMenu close animation, so tests wait for the old menu to unmount before reopening; the seeded
session title request is sent asynchronously, so the empty `/plan` request count waits for it first. Final
run `desktop-e2e-20260915070056792-p63678-7820fb061f2b3987` (artifacts under that copy's
`packages/desktop/.e2e-artifacts/`): 3 specs / 6 pass (independent marker/permission/close 1, tool entry
and approval sync 1, `/plan` 4) on real Electron + CLI with model-fixture replay (not live provider
validation). Push-gate unit tests were updated for old assertions: draft compat read splits base mode and
`planEnabled`; normal submit carries false explicitly and `/plan` submit true; menu tests verify the
Dropdown's permission single-select, independent Plan check and focus return instead of mocking the removed
old component.

## Open items before full acceptance

(The user's later request to push and open an MR does not mean acceptance is done; the MR is a review draft.)

1. Recovery of an unreceived tool notification after a process restart must be verified separately, without forcing an ordinary Runtime state over an existing draft.
2. Re-check the old Goal control entry against the V4 exclusion, and the permission boundary of old/new ends and rollback reads.
3. Approve / reject / feedback / manual close, Queue Guide permission taking effect and phone reconnect interaction acceptance (the menu E2E alone does not cover the chain); the full Queue/Guide cases and phone reconnect are not tested.
4. E2E must run on the MacBook Pro (earlier Electron start failures came from the Linux workspace); remaining failures of the larger suites need attribution.
