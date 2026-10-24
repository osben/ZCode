# Todo158: Full access in the permission dialog and queued-mode sync

> Status (2026-09-17): implementation and desktop acceptance done; overall acceptance not fully closed.
> Existing workspace changes were preserved; the CLI lint / baseline test failures and the phone
> end-to-end gap are in section 9.

## 1. Goal and latest decision

Reduce repeated approvals during tool execution: the permission dialog offers "Full access", and one
explicit action makes the current task, that task's Composer and all pending queued messages use `mode=yolo`.

- **Only the dialog's "Full access" triggers the batch sync**; the ordinary Composer permission menu still edits only the draft of the next Submission.
- Runtime, Composer and each queue item keep their own `planEnabled`; it is not overwritten with the Runtime's Plan and switching permission never leaves Plan.
- The action targets the current task: not the project default permission, other tasks or the new-task default; no extra user message, no stopping or restarting the current turn.
- The queue changes only the permission field; body, attachments, model, thinking level, Plan, identity, order and delivery mode keep their values.
- The current tool approval is released only after the batch update completes; failure must not show full success, and repeated clicks or cross-end duplicate answers must not repeat side effects.

This continues [Todo71](./todo-71-persistent-composer-draft-and-submission-state.md) and
[Todo151](./todo-151-independent-plan-state-draft.md); it adds only the explicit exception that the
dialog's full access changes queued permissions, and does not reopen model selection or ordinary queue
semantics. Historical conflict: [C26](../design-v2/evidence-and-contradictions.md#c26-can-approval-dialog-full-access-modify-permissions-of-an-accepted-queue).

## 2. Dialog options and display

Ordinary command approval lists, default still the 1st item:

| No. | Option                            | Meaning and effect                                                                                                |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Allow                             | allow this once; existing allow_once semantics                                                                    |
| 2   | Always allow this command         | project scope, same command not asked again; existing allow_project rule generation/matching kept                 |
| 3   | Full access                       | grant the Agent full access with no more confirmation; performs this Todo's current-task, Composer and queue sync |
| 4   | Deny                              | deny this operation; existing Deny behavior                                                                       |
| 5   | Tell the model what to do next... | the separate input row for feedback with denial and its submit method kept                                        |

- Number shortcuts, arrows, Tab, Enter, focus and the confirm button follow the actual option layout; `5` focuses feedback without submitting; IME behavior and phone input compat kept. The feedback row still requires the request to declare feedback support (no fake feedback response for entries lacking it).
- Item 2 keeps showing the Agent's real prefix/exact scope (a title wording change must not change matching or widen authorization). File, network, MCP and official CUA approvals sharing the surface keep their tool-scope wording and trusted capability-group semantics (not renamed "command").
- Full access does not turn off Plan: `yolo + planEnabled=true` still obeys the planning-tool rules. AskUserQuestion, ExitPlanMode and other user Q&A are never auto-answered by the new option. Desktop and phone share components, semantics and i18n; protocol responses are never derived from option position.

## 3. Code facts and problems

| Fact                                                                                       | Implication                                                                                                                    | Entry                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| The Composer menu only edits the current scope's draft                                     | reusing the menu callback cannot resolve the pending approval                                                                  | `packages/ui/src/v4/SessionPane.tsx`, `useDraftConfigControl.ts` |
| The instant mode-switch command is still used by Bot, automation, CLI/TUI and compat paths | not dead code, and approval batch sync must not spread to all callers                                                          | `zcodeTaskServiceAdapter.ts`, `session-facade.ts`                |
| `app.setMode()` updates Runtime and also writes project `permission/mode`                  | the task-level grant must not inherit the project-preference side effect                                                       | `session-facade.ts`, `runtime-config.ts`                         |
| Passing only `mode=yolo` normalizes to `planEnabled=false`                                 | the approval-specific update must keep Plan explicitly; the shared compat decode rule is not changed blindly                   | `packages/shared/src/execution-state.ts`                         |
| Each tool call reads Runtime mode at start; an approval waits in a broker                  | a running task can switch, but pending approvals are not auto-resolved and calls that already read the old mode are not redone | `call-runner.ts`, `permission-flow.ts`                           |
| Queue items carry their own mode/Plan and re-apply on consume                              | changing only Runtime or UI lets the next dequeue switch back                                                                  | `product-projection.ts`, `turn-model.ts`                         |

`permission/mode` is the project-mode fallback when creating an Agent; `permission/ruleset` is the rule set
of "always allow this command"; Session execution state and Composer Recent are separate fact sources. This
Todo merges none of them and writes no project default or new permission rule. With the existing
`resolveExecutionState()`: `build + Plan=true` with only `mode=yolo` becomes `yolo + Plan=false`; explicitly
carrying the original Plan keeps it true.

## 4. State ownership, queue boundary and order

```text
Desktop continuous / Mobile replayable
  -> dialog picks "Full access" (session + interaction + command identity)
  -> the same Agent owner validates the request is still valid and coordinates the answer winner and queue dequeue order
  -> update current Runtime.mode=yolo, keep Runtime.planEnabled
  -> update all accepted-but-unexecuted queue items to mode=yolo (each keeps its planEnabled / modelSelection / content / order / delivery)
  -> publish the authoritative result and queue projection; the matching Session Composer is updated in a targeted way to mode=yolo, keeping the rest of the draft
  -> release the current approval request; the original Turn continues
```

Queue boundary:

- The affected queue is determined by the Agent's serial order when it accepts the approval action: pending inputs during the run, paused/held queues and not-yet-consumed Guide.
- It coordinates with reserve/promote/drain; during the batch update the target item may not start with old config; already-started messages are not turned back into queue items and history is not rewritten.
- The authoritative execution data is changed and the needed input records and events/projections are synced so memory, queries and edit-back never read the old value (not only the renderer display or snapshot).
- After the update, auto-dequeue, "send now" and edit-back use the new mode; queue IDs, order, pause state and other config are kept. It is a one-time explicit update, with no permanent override layer; later new submissions follow their own explicit Submission and server admission order. The current Composer sends with yolo after sync.

```text
Runtime build + Plan=true -> yolo + Plan=true     Composer edit + Plan=false -> yolo + Plan=false
queue A build + Plan=true -> yolo + Plan=true     queue B edit + Plan=false -> yolo + Plan=false
```

Approval, failure and cross-end:

- One explicit approval action folds the permission switch, queue change and current answer together; the UI does not send two unrelated commands and assume atomic success. It reuses the existing Runtime state update, interaction broker and command idempotency; the Agent is the owner of queue and permission (no second accepted queue in Renderer, Host or Relay).
- Interaction and task/session ownership are validated; a late action cannot expand permission after the request was denied, cancelled or handled by another end; a Hook racing a user answer still has a unique winner.
- Any failure of state save, queue update or event commit gives a reconcilable result and an idempotent retry path (no approving the tool before discovering the queue did not finish); the commit point, failure recovery and fault-injection evidence are explicit (several `await`s are not a transaction).
- The Composer is handled by the existing draft owner in a targeted way for this explicit result; same-task cross-end and reconnect avoid duplicate application; ordinary snapshots still never keep overwriting the draft; a late result never changes another scope. The action writes no Composer Recent; a later accepted real Submission follows the existing Recent rule.
- For sub-agent approvals taken over by the parent, origin, broker and the actual executing Runtime are checked; changing only the display Runtime does not claim the child takes effect; other tasks and independent children do not gain authorization from static call relations. Changing the inheritance contract needs a recorded impact first.

## 5. Slices and compatibility

- [x] Rules read for directories, architecture-governance, runtime boundaries and tool change chain; protocol, owner and consumers confirmed.
- [x] Schema, commit/recovery contract and minimal state matrix written in this Working Memory; regression tests that prove the expectations first, then implementation (existing contracts reused, no duplicate interface).
- [x] Agent implementation: Plan-keeping task-level permission update, batch update of pending inputs and approval-answer orchestration; necessary fixes of the ordinary mode API are stated separately and Bot, automation and CLI defaults are not rewritten in passing.
- [x] UI: new option, Composer targeted sync, shortcuts, feedback-row numbering, i18n and error/retry display.
- [x] Old client / old Agent differences handled explicitly: unsupported full action shows no usable entry and unknown options are not mapped to plain allow; legacy TUI/Bot silently get no new batch semantics.
- [ ] Mark overall completion once all necessary verification gates close (remaining baseline failures / phone end-to-end in section 9).

Only approving the current request is in scope; other already-pending independent permission requests are not assumed handled. Not extended to task-level grant options, rule management/revocation UI, Bash matching optimization or project default-mode cleanup.

## 6. Acceptance cases

| Case     | Scenario                                                             | Must prove                                                                                                                                              |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PA158-01 | Ordinary command approval                                            | five rows in order, default allow-once, 1-4 and row-5 feedback navigation; no fake input when feedback is not declared                                  |
| PA158-02 | Running build/edit task awaiting approval, pick full access          | no turn stop, no new message; Runtime becomes yolo, the current tool runs, later tools judged by the new permission                                     |
| PA158-03 | Runtime, Composer and queue with different Plan                      | all targets become yolo, each keeping true/false; yolo+Plan still obeys planning constraints                                                            |
| PA158-04 | Several ordinary queue items, held queue and unconsumed Guide        | all targets updated; config/attachments/order/pause state unchanged; auto-consume and "send now" never write back the old mode                          |
| PA158-05 | Edit-back of an updated queue item                                   | Composer gets the item's updated permission and original Plan/model/body; other items unchanged                                                         |
| PA158-06 | Batch update interleaved with new submissions, reserve/promote/drain | boundary decided by owner order; no missed target, no double execution, no override of a later-accepted independent user choice                         |
| PA158-07 | Multi-end clicks, Hook answer, deny/cancel, lost ACK                 | a unique answer winner, expired action gives no privilege, retry reconciles without duplicate side effects                                              |
| PA158-08 | Faults in save / queue update / event commit                         | no false full success and no early tool release; facts consistent after recovery or retry                                                               |
| PA158-09 | Ordinary menu, allow once, project always-allow, deny/feedback       | original behavior; the ordinary menu does not batch-update the queue; project rule scope not widened                                                    |
| PA158-10 | Desktop, phone reconnect and scope switch                            | continuous/replayable verified separately; same-task results consistent, drafts not overwritten by ordinary snapshots, no workspaceIdentity/session mix |
| PA158-11 | Task/project preferences and shared callers                          | the action writes no project mode/ruleset or Recent and changes no other task; Bot/automation/CLI regress-free                                          |
| PA158-12 | Sub-agent-origin approval and old-version combinations               | origin routing matches actual execution permission; unsupported full action neither wrongly grants nor extends to unrelated tasks                       |

Required verification: root `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected
tests; CLI per its child rules. UI covers desktop/phone, light/dark and zh/en; interaction needs matching
E2E; browser-local verification does not stand in for native or phone remote-control chains; cases that
fail admission are not auto-promoted. After checks pass, self-review the diff and commit only this change;
Push/MR is triggered separately by the user.

## 7. Delivery and open items

- Full access runs through the original `resolveInteraction`, registry, Runtime owner and SQLite transaction; the tool is released after the V4 projection confirms. The ordinary mode API keeps its project-preference behavior and this action does not call it.
- UI: full capability entry, five-row keyboard navigation, error retry and one-time Composer sync; edit-back keeps the grant-handled marker. Old UI/Agent stay compatible via the separate `fullAccessOption` field; child-origin and independent Q&A/confirmations do not declare the incomplete capability.
- The formal contract is distilled into the [permission approval doc](../../../permission-project-approval.md); test layers and gaps stay in the coverage matrix; pending is not auto-promoted.

## 8. Implementation contract (2026-09-17)

Impact: presentation, validation, commit-effect, persistence, recovery.

| Scenario / entry                | Shared implementation                   | Draft / default         | Validation and commit                                                     | Authority / save                                               | Boundary and isolation                           |
| ------------------------------- | --------------------------------------- | ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Desktop/phone ordinary approval | PermissionDialog / V4InteractionDialogs | default allow once      | Agent declares the fullAccess option; original-command resolveInteraction | interaction registry -> Runtime -> session store atomic commit | continuous/replayable keep their original chains |
| Ordinary Composer menu          | useDraftConfigControl                   | independent scope draft | original draft callback                                                   | Renderer draft                                                 | no queue batch change                            |
| Project always-allow            | existing option builder                 | Agent prefix/exact      | original permissionUpdates                                                | project ruleset                                                | no rule widening                                 |
| Sub-agent / legacy              | original approval surface               | original options        | does not declare the full fullAccess capability                           | actual child broker                                            | no wrong parent switch, no fake child success    |

Must check: the registry/broker's unique answer, Core pendingInputs/held projection, SQLite `session_input`
and execution entry, V4 mode/queue patch, Composer targeted sync. Regressions: Plan, Guide, reserve/promote,
edit-back, Hook, command retry. Bot/TUI/ordinary mode API are isolation invariants. No code-graph tool in
this environment (direct reference checks along entry -> owner -> save/projection); the feature graph lacked
the approval-full-access semantic edge and was supplemented; the old queue-domain mapping claiming renderer/host
hold the accepted queue conflicts with the current CommandInbox owner and was not used.

Commit, race and recovery:

- Reuse `resolveInteraction`; the stable option ID is `fullAccess` (never derived from position). Only an Agent with atomic-save capability declares it, for ordinary main-task permission requests; sub-agents, Q&A, Plan approval and workflows requiring independent tool confirmation do not claim support.
- The Registry validates session, request type and option capability and takes the answer right. Core's permission responder race provides a broker claim: a Hook that already won blocks the claim; after a claim the Hook withdraws. On failure the approval is kept and may be explicitly retried/denied, never auto-released.
- Runtime locks the target queue's consume/promote within the task; an existing Guide consumption or reserve returns a retryable failure; the fixed ID set of accepted, unconsumed items is taken; CommandInbox's serial admission bounds later submissions. Each item's own Plan and other fields are kept.
- SessionStore's atomic commit writes the current execution state, target `session_input` permissions and a receipt deduped by interactionId, in existing tables (no new schema). A failure before commit leaves memory unchanged; a post-commit publish failure keeps the receipt and a retry only completes memory/events without re-fetching the queue or overwriting later inputs. Later mode changes and queue consumption first complete unpublished commits; a projection failure is retried by rebuilding from the original log, keeping event order.
- A single SessionModeChanged event carries an explicit permission-grant marker and the queue IDs; Core/V4 projection syncs the permission and the original history is not rewritten. Before ACK, the authoritative projection is awaited; the current tool gets allow only after all updates succeed.
- The Composer consumes only the explicit grant ID and persists the handled marker; each scope applies once, keeps its own Plan, and later manual changes are not repeatedly overwritten by ordinary snapshots. Reconnect reads the same grant marker; a process restart keeps the current execution state and the queue still follows the existing restart-discard contract.

```text
resolveInteraction(fullAccess) -> session FIFO -> registry claim (Hook withdraws)
 -> Runtime queue consume barrier -> SQLite atomic execution + inputs + receipt
 -> Runtime memory + single event -> V4 config/queue -> Composer applies once by grant ID
 -> current broker allow -> tool continues -> ACK/query reconciliation
failure before commit -> keep original state and approval; failure after commit -> receipt retry completes publication
```

Dimensions follow PA158-01..12 (answer winner, transaction stage, queue lifecycle, per-item Plan, scope,
delivery; no tool x model permutations). Sub-agents without the full action drop fullAccess, keep the
original approval and verify no parent mis-privilege. Regression layers: SQLite atomic fault tests,
Core/runtime/race, V4 schema/projection/handler, UI draft/navigation; the desktop pending E2E uses a
controlled tool approval and queue window; phone replayable is verified separately. Unobtained evidence
stays pending (not auto-promoted). No open product question.

## 9. Evidence and completion gates

Temporary logs are in `/tmp/zcode-todo158/`.

| Verification                                                            | Result                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Root `pnpm typecheck`, CLI `pnpm --dir apps/zcode-cli typecheck`        | pass; CLI 28 tasks succeed                                                                                        |
| Root `pnpm lint`, `pnpm architecture:check --changed`                   | pass; lint has pre-existing warnings, architecture 0 violations                                                   |
| SQLite transaction / fixed targets / rollback / cancel / task isolation | 3 pass (`adapters/tests/permission-full-access.test.ts`)                                                          |
| Core permission / Hook claim / Plan                                     | 24 pass (`permission-full-access`, `permission-responder-race`, `independent-plan-state`)                         |
| Contracts event reducer                                                 | 27 pass                                                                                                           |
| Bootstrap broker / registry / projection / original approval chain      | 120 pass                                                                                                          |
| Bootstrap queue reserve/promote/edit-back                               | 34 pass (`v4-native-queue.test.ts`)                                                                               |
| V4 continuous / replayable post-commit recovery                         | 2 new pass; 1 old-revision baseline failure in the same file                                                      |
| UI approval / shortcuts / compat capability / Composer                  | 67 pass; 1 SHARE32 baseline failure reproduced separately and not in the targeted result                          |
| UI queue edit-back / Plan transition                                    | 22 pass; the new regression failed first (restores queue item mode/Plan/model/reasoning)                          |
| Desktop E2E types and fixture check                                     | pass; the fixture's queued text is only for enqueue/edit-back with no model request, so the matcher warning stays |
| CLI lint                                                                | fails: baseline max-lines errors (telemetry/debug/bootstrap etc.), not refactored in passing                      |

Baseline isolation: at `/tmp/zcode-todo158/baseline` (same HEAD plus the saved pre-existing patch) the
SHARE32 failure, the gateway old-revision assertion, the background-notification timing assertion and the
CLI lint failure reproduce; the feature's own cases are listed separately; no claim that the whole repo is green.

Not obtained: a real phone shared-host reconnect / cross-device repeated-click E2E, Windows/macOS runs.
continuous/replayable evidence is real-protocol subscription and fault-recovery unit tests on the same
Gateway, not the phone chain. Sub-agents not offering full access is tested; their inheritance contract is not extended.

Desktop run: Linux Electron 1/1 passed, run `desktop-e2e-20260917101937381-p869276-572a8de9c7ed2705`,
exit 0: the original Write tool wrote the file, same-turn output continued, two queue items kept order and
body, and after edit-back they were `yolo + Plan=true/false`. The E2E exposed and fixed a gap in the
existing edit-back path that restored only body/attachments: it now restores the item's recorded mode, Plan
and modelSelection (including reasoning); old items without recorded fields keep the existing draft. The
test goes through the real UI (first-run guide), waits on a controlled SSE window and fabricates no
business snapshot; it stays in manual-review/pending.

Shared-component browser run: `permission-full-access.test.mjs` **4/4** (390/1200 x light/dark; 390 uses
Chinese and `isWebRemoteControl=true`, 1200 English) verifies five-row copy, number `5` focusing feedback
without submit, number `3` + Enter returning the stable fullAccess ID, no horizontal overflow; screenshots
in `packages/desktop/.e2e-artifacts/permission-full-access-browser/` — shared-component/mobile-width
evidence only, not a real phone relay E2E.

Pre-existing uncommitted changes were kept separately; the overlapping catalog/matrix only append PA158 and
Composer draft storage only adds the grant-handled marker. On 2026-09-17 the user explicitly asked to merge
the latest staging, commit, push and open an MR; delivered as asked while keeping the baseline failures and
the phone-chain gap, without marking overall acceptance passed.

After merging the latest `origin/staging` (2026-09-17), the delivered version excluding pre-existing
changes passed root/CLI typecheck, root lint, architecture; UI 79, Core 24, SQLite 3, Contracts 27,
Bootstrap approval/queue 154, Gateway PA158 2, and the four browser combinations. Linux Electron re-ran 1/1,
run `desktop-e2e-20260917120736651-p895163-873605a2d4994754`. The first build was blocked by a stale local
Zod caught by staging's version check; aligning the local install to the repo's 4.6.5 made build and E2E
succeed (no manifest or lockfile change). CLI lint is still the baseline max-lines failure. Feature graph
new nodes/seeds/edges raise no new issues; two missing endpoints (`capability.mcp-oauth-authorization`,
`persistence.desktop-user-data-root`) are recorded as baseline gaps. Pre-push `ZCODE_PRE_PUSH_BASE=origin/staging pnpm verify:pre-push`
passed (lint, architecture, changed and related tests); Zod 4.6.5 exposed a newly added compat test missing
`detail`, which was fixed with no product-logic change.

### CR-01 / CR-02 fix recheck (2026-09-17)

- CR-01: each fullAccess attempt has an independent failure notification; commit/projection failure releases a legacy answer or timeout already waiting; a retry builds a new barrier and success still awaits the V4 answer. New regressions: failure arriving before/after, resolve/reject, retry and cancel; the old implementation reproduced 8 failures, after the fix broker/registry/original approval chain 128 pass.
- CR-02: on restore, old grant markers are cleared; corrupt, future-field and cross-session receipts are logged and skipped, while history and saved execution state still restore; idempotent grant retry still rejects a corrupt receipt strictly. Restore, grant, Hook race and independent Plan: 30 pass. The extra `runtime-unbound-resume` has 1 pre-existing error-text assertion failure, reproduced in an unmodified isolated baseline.
- CLI typecheck 28 tasks, root lint and architecture pass. CLI lint stays the baseline max-lines failure. Root typecheck did not finish this round (Node heap out of memory; even at 8 GB and per-project it OOMs in the unmodified services stage) and is not marked passed.
- Linux Electron approval E2E 1/1 passed, run `desktop-e2e-20260917130117737-p944581-034f7d67ab10c80c`, exit 0 (original tool, queue, per-item Plan and edit-back chain); phone shared-host, cross-device ACK and Windows/macOS keep the unverified boundary above.
- Logs: `/tmp/zcode-todo158/cr-*.log`. The user explicitly asked to fix and push, so this round's changes were committed with the verification limits kept; the original MR !2718 was already merged and these fixes are follow-up commits on the same branch.
