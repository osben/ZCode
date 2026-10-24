# Todo 71: Composer Draft Persistence and Submission State Closeout

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implementation and phase acceptance done (2026-09-04).
>
> Source: in an existing Session, after switching mode the Composer was overwritten by the old Agent Session Snapshot value, so the menu appeared unable to switch.
>
> Depends on: Todo 68 (Active Model execution fact); Todo 70 (historical Session Selection migration boundary).
>
> Latest ruling: an existing selection that is missing/invalid is left empty, with no auto-switch to a default model and no invalidation notice (same rule as Todo 70).

## 1. Problem

The Composer expresses "what the next submission will send", but its state was scattered: text and Lexical state in `V4ComposerDraft`; `mode` and `modelSelection` only in React `draftConfig`; the Workspace Store kept `draftPreferredModel`, `draftPreferredMode`, `draftPreferredThoughtLevel`; mode also had a global localStorage preference; an existing Session's Toolbar kept reading the Agent Session Snapshot; submission merged Snapshot, Draft and the Preferred states on the fly. The Renderer had no single stable Composer fact source:

```text
existing Session Snapshot.mode = yolo -> Composer shows yolo
user picks build -> React draftConfig.mode = build
re-render -> reads Snapshot.mode = yolo again -> menu looks like it failed to switch
```

Not a dropdown component problem: pre-send state was continuously reverse-driven by an already-running Agent Session.

## 2. Target state

The existing Composer Draft is extended to be the only persistent carrier. Renderer in-memory state handles immediate interaction, the persisted Draft handles restart, page switch and Session restore; the Agent Session Snapshot is no longer a live input while the Composer is alive.

```text
open / restore Composer
  -> Persisted Composer Draft { text/editor state, mode, modelSelection }
  -> Composer In-memory State (sole UI fact before send)
        user edits -> persist
        submit -> immutable Submission { prompt/attachments, mode, modelSelection }
               -> Agent admission -> Session execution state -> immutable Active Model
```

Principles: the Composer maintains the complete state of "the next submission" only; a Submission freezes its state at creation and never reads back Composer or Session; Agent Session state may record execution facts of accepted Submissions but is no longer continuously projected back to the Renderer Composer; Active Model stays under Todo 68 and is not persisted by the Composer; no `LastSubmittedState`, `SessionComposerState`, Context Model Snapshot or new Provider/Model DTO.

Relation to the prompt cache: the persisted Draft does not decide server-side cache hits (those depend on the real request's Provider, Model, Options and Prefix). It keeps the user's current mode/ModelSelection stable across page switch, restart and Snapshot re-render, so the prefix is not changed by accident. It is a product-state precondition of cache stability, not a new cache config layer.

## 3. Composer Draft contract

```ts
interface V4ComposerDraft {
  text: string;
  editorStateJson?: string;
  mention?: ComposerMentionPrefill;
  mode?: CollaborationMode;
  modelSelection?: ModelSelection;
  updatedAt: number;
}
```

The optional fields serve persistence compatibility and initialization only. After initialization the in-memory state holds a complete submit-ready `mode`; whether `modelSelection` is empty is decided by the current `ModelSelectionView` and initialization/invalidation rules, and an invalid existing selection never falls back.

The localStorage key and file header stay `v1` (the added `mode/modelSelection` leaves are optional backward-compatible, no key migration), but the Reader must validate the Draft and the new leaves item by item rather than asserting the `JSON.parse()` result's `scopes` as the current type. An old Draft with only text/editor reads normally and runs the missing-field initialization once per §4.

### 3.1 Not written to the Draft

- `maxOutputTokens` (belongs neither to ModelSelection nor Composer Draft; the Agent framework passes it explicitly per request, and selecting `optionSpecs.maxOutputTokens.max` is a legal explicit decision).
- Endpoint, API Schema, credentials, Properties and Option Specs (resolved by the target Host Registry at execution).
- Active Model.
- Flat aliases such as `provider/model/thoughtLevel`.

### 3.2 Attachment boundary

Logically the Composer state includes attachments and a Submission freezes this submission's attachments, but current attachments contain a `File`, `objectUrl` and local-path ownership that cannot be safely restored across restart. No attachment serialization protocol is invented here: while the Composer is alive the in-memory attachment state holds them; at submit they enter the Submission with prompt, mode and ModelSelection; persistence covers only existing safely serializable fields plus `mode/modelSelection`; cross-restart attachment recovery needs its own design and never writes a stale object URL or unvalidated local path into the persisted Draft.

> 2026-10-14 update: empty-body persistence and initialization rules are superseded by [Composer text-draft-only persistence](../../../ui/composer-text-draft-persistence.md). The "write the Draft immediately" and "keep config on empty text" parts of the historical design below are no longer the current implementation contract.

## 4. Initialization rules

Initialization runs once when a Composer is created, the Workspace/Session scope switches or on restore; afterwards ordinary React renders never re-merge Session Snapshot and defaults.

### 4.1 Existing Session

```text
persisted Composer Draft of the current Session scope
  +-- exists --> restore; invalid selection left empty per §7
  `-- absent --> initialize once from Session Selection + Session mode, write the Draft immediately
```

Session Selection and mode are only the seed for an old Session's first Composer Draft; later Agent Snapshot updates cannot overwrite a Composer being edited. When Todo 70 returns an unbound selection the Draft keeps an empty model or empty Reasoning (no default-model initialization, no notice). An old Draft with only text/editor may run the missing-field initialization once, but a Draft already initialized and left empty by invalidation is not an "old Draft" and must not be refilled from Session/Recent/preferred after remount, page switch or restart. A legal `mode` in the Draft marks initialization complete (initialization always saves mode, including an explicitly empty model; old text drafts have none). Do not decide by `modelSelection === undefined`, and add no separate business state library or initialization flag.

### 4.2 New Session / blank task

```text
Root Draft (scope = __draft__)
  +-- exists --> restore; invalid selection left empty per §7
  `-- absent --> workspace App Recent still valid in the current View
                 -> else Host preferredSelection
mode: an existing Root Draft wins; a brand-new Root Draft reads the current workspace Composer Recent.mode; missing/illegal falls to build
```

Host `preferredSelection` already contains the unified Configured Default + Registry fallback result; the Renderer neither copies that algorithm nor infers by Provider, model name or Account type. Recent/preferred are only for genuinely first-time tasks with no persisted Draft and never repair an empty selection of an existing Draft. When the user actively picks a new model, the level is initialized by the normal selection rule; that does not auto-fill an invalid saved Reasoning.

### 4.2.1 ZCT-2098314627607224320: new task inherits the latest submitted permission

Cause: moving a Root Draft into a Session and deleting the source is correct task isolation, but a fixed `build` for the new Root lost next-task permission inheritance. The existing App Recent is extended into Composer Recent, saving model and mode side by side (the shared ModelSelection type is untouched; no second global mode preference). Recent stays isolated by `workspaceIdentity?.trim() || workspacePath` (same path on different remotes must not mix). Desktop and mobile each hold their own Renderer Recent.

```text
user choice -> current-scope Draft (persisted immediately)
user submit -> freeze modelSelection + mode -> CLI accepted -> write Composer Recent once
new task -> existing Root Draft wins; else initialize once from Recent -> current-scope Draft
later Snapshot / Recent updates -X-> an initialized Draft
```

- "Accepted" includes queued, without waiting for execution; a later execution failure does not retract an accepted selection.
- Unsent, rejected/failed, empty-session prewarm, history restore and duplicate ACK do not refresh Recent.
- Per Renderer/workspace, candidates are recorded in actual command-issue order and only a newer accepted command may overwrite Recent. A late ACK never reads the current menu and never overwrites the user's newer draft.
- The existing Recent key is reused, reading old plain-ModelSelection records; modelSelection and mode are validated independently (a bad model keeps a legal mode and vice versa).
- A Recent write failure only logs a UI logger warning and does not report the accepted send as failed. Existing drafts and historical Sessions are not bulk rewritten.
- Only App Composer initialization and the post-acceptance preference save change; the Desktop continuous and mobile replayable trusted attachment, shared-host, owner, CommandInbox and recovery protocol is unchanged.
- The regression must really click New Task and prove toolbar, persisted Draft and later tool-execution permission agree, while keeping Session/Root unsent-intent isolation.

### 4.3 Constraints after initialization

The result goes into the same in-memory Composer state and is persisted immediately (no UI-only half state); mode and modelSelection follow the same read principle; priorities are not recomputed on every render, Snapshot event or submit. Prompt CLI, TUI, Automation, Repo Wiki, Subagent and Off-Peak keep their own Draft/Config/Record and do not reuse the App Composer Draft.

## 5. User edits and persistence

```text
click menu item -> update Composer in-memory state immediately
                -> close the dropdown
                -> persist the full Draft of the current scope
```

- The UI does not wait for Host/Agent ack; mode and ModelSelection are low-frequency discrete actions and persist immediately; text keeps the existing debounced write.
- Empty text is not an empty Composer: if the scope is initialized and holds mode or ModelSelection, normal persistence must keep the record. Deleting a whole scope goes only through an explicit cleanup interface, never "text and editorStateJson are empty".
- A persistence failure logs one diagnosable entry and never rolls the UI back to the Agent Snapshot.
- Consecutive edits within a scope follow latest-intent-wins; a stale async result cannot overwrite newer in-memory state.
- Key uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`; scope is the Session ID or `__draft__`.

No cross-window distributed lock or new Host Repository; localStorage remains. Multi-window co-editing of one Session would be a separate sync design.

### 5.1 Draft capacity

Composer Drafts are no longer trimmed by scope count under the old temporary-text limit: model selection is long-lived user state and must not be silently deleted. Removal happens only on explicit scope cleanup or when storage itself rejects the write. (Tests: 51 scopes not evicted; 500 kept; the 501st evicts the oldest scope by update time keeping the new write; records holding only mode/modelSelection or an empty selection round-trip within capacity and are not deleted for empty text.)

## 6. Submission sequence

### 6.1 Creating a Submission

A Submission is copied once from the same-moment Composer in-memory state (prompt, attachments, mode, modelSelection) into one immutable object. The submit function must not supplement fields from the Agent Session Snapshot, Workspace `draftPreferred*`, the global mode localStorage or any model state queried just before submit.

### 6.2 Submission accepted

After acceptance only the sent content is cleared; the execution selection stays:

```text
before: text="请修复问题", attachments=[...], mode=build, modelSelection=DeepSeek/high
after:  text="", attachments=[] (memory only), mode=build, modelSelection=DeepSeek/high
```

- Existing Session: save the cleared Draft in the original Session scope.
- New task creating a real Session from `__draft__`: transfer the kept mode/ModelSelection to the new Session scope, then delete the old Root scope.
- Composer Recent is saved once after App accepts the Submission (the frozen modelSelection and mode), not by menu click, empty-Session prewarm or history restore.
- Agent Session execution state updates at the acceptance/start boundary, never earlier than Submission success.

Post-acceptance cleanup carries the submission's local revision/token so a late result cannot clear new input the user produced while waiting:

```text
Submission A created from Composer revision R -> waits for Agent admission
user keeps typing / switches model, Composer advances to R+1
A accepted -> only clear content still belonging to R; never R+1 text, attachments, mode or ModelSelection
```

This is a local comparison for one submission, not a `LastSubmittedState`. With or without concurrent edits, after success the Composer's mode/ModelSelection follow the latest in-memory state.

### 6.3 Submission failed

If not accepted, restore/keep the pre-submit text, attachments, mode and ModelSelection (never restore only the prompt); a late cleanup cannot overwrite the restore; no `LastSubmittedState` (the pre-submit snapshot is local rollback material for this async operation). Root scope transfer follows latest-intent-wins too: write the target Session scope first, delete the Root scope only after success; if the Root Composer changed during acceptance, move only the state of the accepted content, never overwrite the updated Composer with an old snapshot.

## 7. Registry update and selection invalidation

When the Registry revision changes, the current Composer Draft's ModelSelection is validated against the new `ModelSelectionView`, only when the View is truly Ready and the revision advanced (loading/error/unavailable are not invalidation).

```text
persisted / in-memory ModelSelection + Ready ModelSelectionView(revision N) -> validate by level
  +-- all valid -> keep as is
  +-- Provider or Model invalid
  |     -> whole Selection emptied; no Host preferredSelection; no notice; submit forbidden until the user completes it
  `-- Provider/Model valid, Reasoning missing or invalid
        -> keep providerId/modelId, clear only reasoningLevel; no auto level; no notice; submit forbidden
```

- Same validator, different levels: Provider/Model nonexistent or unselectable voids the whole Selection; a saved reasoning no longer in the model's ordered `values`, or one missing where the submission contract requires it, clears only `reasoningLevel`.
- No auto-replacement by Recent, Configured Default or Host preferred; a Reasoning failure never auto-fills highest/lowest/Configured Default and never touches a valid Provider/Model.
- Empty model or Reasoning is expressed only by the control empty state and a non-submittable state; no Toast, dialog or banner, and notification and de-dup logic are deleted.
- The cleared state updates memory and persistence immediately; later render, revision, page switch and restart never refill it. A brand-new draft with no persisted Draft and no prior selection initializes normally.
- `ModelSelection` persistence already allows `reasoningLevel` to be temporarily missing, so no `PartialModelSelection` or `ComposerModelChoice` DTO is added. The unfinished state lives only in Composer Draft and the history-restore boundary; creating a Submission must pass integrity validation first, and ModelFactory only receives a complete executable Selection.
- Todo 70 handles migration/unbound state when restoring a historical Session; this section handles a normally opened Composer after a Registry update. Both unify as empty, no auto-replacement, no notice, no scenario-specific fallback. Genuine request failures, submit failures and persistence faults still get normal error feedback.

## 8. Queue, Guide and execution boundary

Queue and Guide product semantics are unchanged; only the shared Submission boundary is fixed:

- A Queue item stores the full Submission at enqueue; at dequeue it reads neither Composer nor the latest Session Selection; clicking "now" still uses that item's own Submission.
- A Guide accepted by the current Loop updates Session execution state at the existing atomic boundary and uses the new Active Model from a legal model-step.
- If a Registry change after queuing makes a Queue item's Selection non-executable, fail explicitly and keep the input, never silently route to another Provider/Model/Reasoning.
- Desktop `continuous` and Mobile `replayable` carry only the same committed Submission, derive no defaults of their own and build no second accepted-input queue in the Renderer.

The larger product semantics of queuing vs "immediate guidance" remain deferred; `sendQueuedNow` and the default immediate behavior are not touched.

## 9. Cleanup of the existing implementation

- Merge Composer state: extend `composerDraftStore.ts` so read, save, clear and scope transfer keep mode/ModelSelection; `ConversationComposer`, `SessionPane`, Toolbar and mode/model controls read the Composer in-memory state; successful submission changes from "delete the whole Draft" to "clear submitted content, keep mode/ModelSelection"; Root Draft to Session creation gets an explicit scope-transfer test.
- Remove second fact sources, after reference audit proves no other product consumer: `draftPreferredModel`; `draftPreferredMode`; `draftPreferredThoughtLevel`; the Renderer-global `draftModePreference` fallback for the current Composer; the Snapshot + Draft + Initial Config merge in `resolveCurrentComposerSubmission()`; Toolbar reading current mode/model from `snapshot.config`; the Agent config CAS path as confirmation of mode/model menu clicks. If `draftPreferred*` still serves a non-Composer product, split the consumers first and do not delete shared state mechanically.
- Keep but re-bound: Session Selection (persistent model intent for later Agent execution, not rendered by the Composer directly); Session mode/runtime config (permissions, tool behavior, restore, protocol execution; seeds the Composer once when no Draft exists); Prewarm (may receive the current complete Composer config for startup performance/readiness but is not a UI fact source, and the first formal Submission must still carry mode/ModelSelection atomically); settings outside this model/mode scope such as `followupMode` are not deleted mechanically.

## 10. Naming

`draftConfig` becomes `composerState` or `composerDraftState`; `resolveCurrentComposerSubmission` becomes a name expressing "build a Submission from a Composer snapshot" (for example `createSubmissionFromComposer`); the Agent-side `getModelSelection()` becomes `getSessionModelSelection()` per Todo 68; stop using `currentModel` / `currentMode` for values that could be either Composer or Agent Runtime. Final names follow the real responsibility; no wrapper layer or compatibility alias.

## 11. Cross-layer impact

| Layer             | Change                                              | Must not happen                              |
| ----------------- | --------------------------------------------------- | -------------------------------------------- |
| UI / Composer     | complete in-memory state, menus, selection empty state | re-reading Session Snapshot every render  |
| Draft persistence | persist text/editor/mode/ModelSelection             | persist Active Model, credentials or Option Specs |
| Submission        | copy the full Composer state once                   | fill mode/model from Session after submit    |
| App Recent        | save latest Submission Selection + mode on acceptance | update Recent on menu click                |
| Agent Session     | record execution state after acceptance             | act as the Renderer Composer's live store    |
| Registry          | provide Ready View, preferred and Selection validation | Renderer copying the fallback algorithm   |
| Queue / Guide     | keep the frozen Submission                          | re-read Composer at execution                |
| Remote            | pass the same Submission and workspace identity     | Relay/Main holding Composer business state   |

Automation, Repo Wiki, Subagent, Off-Peak, Bot, Prompt CLI and TUI are not moved into the App Composer Draft; only verify they are not hurt by cleaning shared helpers.

## 12. Test plan (written first)

- **Draft Store unit**: mode and complete ModelSelection JSON round-trip; `workspaceIdentity` over `workspacePath` isolation; Session scope vs `__draft__` do not mix; a Draft with only mode/ModelSelection and empty text is kept; clearing submitted content keeps mode/ModelSelection; Root to new Session scope transfer leaves no duplicate; an old text/editor-only Draft reads and initializes once; capacity cases from §5.1.
- **Composer component**: existing Session mode click shows the new value and closes the menu, Snapshot re-render does not overwrite; after switching Model/Reasoning, UI, Draft and final Submission agree; app restart/remount restores the same mode/ModelSelection; successful Submission clears text but keeps mode/ModelSelection; failed Submission restores the full pre-submit state; Chinese input, attachments and existing send interactions do not regress.
- **Registry invalidation**: Provider/Model invalid empties the whole Selection even when the View has `preferredSelection`; unbound old session, invalid existing Draft and restart restore all stay empty while a genuine first new task may use preferred; Reasoning missing/invalid keeps Provider/Model, clears only Reasoning, no auto level; submit forbidden until re-selected, then a complete Submission is built; no notice on clearing, repeated revision or remount; loading/error/LKG switches do not misreport; the empty state is persisted and neither restores the stale value nor fills a default after restart.
- **Submission / Queue / Agent integration**: a Submission carries prompt, attachments, mode, ModelSelection atomically; editing the Composer after submit does not change an already queued Submission; Queue dequeue and "now" do not re-read Composer/Session; after admission Session state matches the Submission; Todo 68's Active Model is created from that Submission Selection with no one-turn lag in Context/Tools/Request; a queued Selection that later becomes invalid fails explicitly and keeps the input.
- **App E2E / MacBook Pro**: switch an existing conversation from "full access" to "auto edit" (menu closes, correct display); switching tasks and back keeps the selection; app restart keeps it; after a successful send text clears but mode, Provider/Model and reasoning do not jump back; consecutive switches among same-modelId different Providers send the first request with the current Composer Selection; a Registry update invalidating Provider/Model empties the model, Reasoning invalidation alone keeps Provider/Model and clears the level, neither shows a notice, both stay empty after restart and the user can re-select and send; Desktop continuous and Mobile remote replayable receive the same Submission config. New cases enter pending first; automation passing does not mean manual promotion.

## 13. Documentation to keep in sync

`design/interaction/selection-state.md` (success clears content only, Composer execution selection kept; attachment persistence boundary); `design/interaction/interaction.md` (Session state joins initialization once only when no Draft exists); `design/interaction/submission-delivery.md` (Submission created from the complete Composer snapshot); Conversation Protocol / Product State Space / Case Catalog (Composer state owner, success cleanup, Queue freeze cases); Feature Graph (remove the old edge where the Renderer continuously projects mode/model from the Session Snapshot); Todo 68 (only Agent-side Active Model/Context facts); Todo 70 (same validator, unify empty/no-replace/no-notice, drop the restore vs active-Draft strategy fork). If Case Catalog I50/I51/I52 still describe the model/mode menu as an Agent config CAS, review them: keep "immediate UI intent, latest intent wins, first-Submission readiness barrier" and drop the "Agent Snapshot is the Composer confirmation source" assumption.

## 14. Not part of this Todo

Queue and Guide/"now" product semantics; `outputStyle` consistency within one Turn; attachment cross-restart serialization; Provider Config, Account Overlay, Registry or ModelFactory domain structure; Automation, Repo Wiki, Subagent, Off-Peak selection inheritance; new timeouts, polling or a Session/Renderer two-way sync protocol; moving Composer state into Desktop Main, Relay or Remote Host.

## 15. Completion criteria

- Composer text/editor/mode/ModelSelection is expressed by one in-memory state and one persisted Draft; the existing Session's Agent Snapshot initializes once and never overwrites a live Composer.
- mode/model menu clicks take effect immediately, close the menu and survive page switch and restart.
- A Submission freezes Composer state atomically; success clears only sent content, failure restores completely.
- Registry invalidation uses the unified validator: Provider/Model invalid empties, Reasoning invalid clears only the level; no auto-replacement and no notice; empty survives restart.
- Queue, Guide, Desktop continuous and Mobile replayable do not re-read the Composer or create a second selection fact.
- Redundant paths (`draftPreferred*`, dynamic Snapshot merge, old mode preference) are reference-audited and removed where possible; Todo 68/70 and design docs agree on state ownership.
- Unit, Bootstrap integration, Desktop E2E, `pnpm typecheck`, `pnpm lint`, format check and `git diff --check` pass; the original problem is reproduced on the MacBook Pro and fixed-state runtime evidence collected.

## 16. Implementation record

Left unfilled in the source ("to be added after execution") even though the status line says done; see the report.
