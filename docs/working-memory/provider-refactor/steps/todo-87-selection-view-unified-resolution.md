# Todo 87: Unified Model-Selection Resolution Driven by the Selection View

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass. The old deferral for explicit Subagent was superseded by the Todo99 implementation; the Off-Peak Ticket exception and the rule of adding no pre-send sync are unchanged.

> Status: implemented and verified/committed in groups, 2026-09-07; new E2E stays pending for manual promotion. Original intent is separated from the current effective result; evidence is in the Todo85 restoration audit table. Explicit Subagent and off-peak cross-account/Ticket migration are explicitly excluded.
> Source: D02 of Todo 85. This is not a restoration of the old Family auto-switch helper but the equivalent experience in the current selection architecture.
>
> 2026-09-08 follow-up: [Todo96](todo-96-selection-offline-migration-and-resolution-consolidation.md) turns ordinary legacy Selection migration into offline deterministic conversion and audits all original-intent-to-View entries; the Host execution resolution of explicit Subagent is a separate protocol ruling and the backend must not be claimed unified until then. The off-peak Ticket exclusion is unchanged. User Markdown format and migration scope continue in Todo97.

## 1. Goal and ruling

Account connection, Personal Config and Built-in Config updates all flow through the existing refresh chain into new selection facts. The caller passes its own saved original ModelSelection (while editing, the user's latest intent) and gets from one entry a View carrying `effectiveSelection`. Automatic recomputation never overwrites the original intent; Composer, scheduled tasks, Bot, off-peak tasks and others must not each write their own account replacement or invalidation handling.

```text
Account / Personal / Built-in update
  -> target Host publishes consistent selection facts (model candidates, levels, account connection, one revision)
original ModelSelection -> unified read/resolve entry -> View with effectiveSelection
     transient display / prepare execution           explicit save / submit-success boundary
        -> fix this execution -> ModelFactory           -> only then may the original selection be written back
```

- **Ordinary Provider**: only check the original Provider/Model; an invalid model is emptied, an invalid level clears only the level; no other vendor is looked for.
- **Ordinary account-plan Provider**: map to the target Provider by the target Host's current account connection, preferring the identical modelId and reasoningLevel; no same level empties the level, no same model empties the model selection.
- Levels match by value, never by Chinese display name, array position or "looks similar"; models match by formal ID, no case normalization, display name or unique-model-name guess across vendors.
- Missing values are not filled with highest/lowest; when the original intent is empty, effectiveSelection is empty and preferredSelection does not fill it. Genuinely new draft initialization is unchanged. A non-empty original intent with an empty transient result keeps the original; once config recovers it should resolve valid again.
- No observed account-switch event is required: cold start and reuse of an old task also resolve against the current View. Even if the original account Provider is still among candidates, the current-account mapping rule is not skipped.
- **Off-Peak**: no cross-account automatic replacement this round; an existing selection only checks the original Provider/Model/level, never mapping to another Off-Peak of the current account; an ordinary account selection never lands on Off-Peak. Off-peak gets only read-only resolution and original-intent protection; Ticket lifecycle follows fixed staging's mechanism. Template instances and custom Providers introduce no `current`.
- No remote config sync or wait is added before send. The View readable on the target Host at that time is used and the final execution is still validated by the target Registry.

## 2. Implementation location and interface

### 2.1 One external entry

`getSelectionView({ selection })` (provisional), evolved on the existing `IModelSelectionService` with no new cross-business state service; the target Host is determined by the existing service binding. Returns revision, candidate models/levels, preferredSelection, plus the effectiveSelection for this input and the minimal incomplete reason.

- UI uses the public `useModelSelectionView({ target, selection })` for first read, subscription, recomputation on input change, read recovery and stale-response isolation; pages must not read a View and call the resolver themselves.
- Background scheduled tasks / Bot call the same service entry for the current effective result before dispatching; no long-lived subscription and no hand-assembled account context.
- preferredSelection is still used only for existing new-selection initialization and never fills an empty effectiveSelection.
- Shared candidate snapshots may be shared; the return value carrying effectiveSelection belongs to one input and cannot be cached as a Host-global selection. Cache/response correlation includes target service and input generation, not View revision alone (users can change the selection under the same revision).
- Ordinary menus still hide hidden Providers. The Off-Peak product entry reuses the existing restricted hidden projection for selection; the ordinary View does not get all hidden models to force matches, and the off-peak effective selection is resolved inside the service from the same authoritative facts.

### 2.2 One pure resolution algorithm

`packages/provider` owns the pure algorithm: consistent snapshot + original Selection -> current effective Selection. The read service/RPC wraps it; the algorithm does no IO, no writes, no input mutation and no user notification; a hook recomputing locally from an arrived snapshot must reuse the same algorithm.

Identity classification is centralized in one internal entry. The service assembly reuses `isBuiltinModelProviderId` and `OFF_PEAK_PROVIDER_IDS` to inject the `ordinary / account-plan / account-offpeak` classification into the Provider Facade, without copying ID tables or importing the whole shared package into the Provider pure module. Ordinary Providers and Off-Peak both keep the original identity; Off-Peak may resolve restricted hidden candidates while ordinary hidden Providers cannot mix into general selection. No guessing by prefix/URL/name; an unknown ID not found is incomplete.

```text
original providerId -> central classification
  ordinary -> original Provider
  account-plan -> ordinary plan Provider of the current account connection
  account-offpeak -> original Off-Peak Provider (no cross-account replacement this round)
 -> exact modelId match -> check original reasoningLevel
```

Identification cannot depend on the current selectable list (a formal old account Provider may no longer be a candidate); only current formal IDs are recognized, with no legacy alias or runtime migration. The ordinary plan's current target is determined from same-snapshot account facts, supports Z.AI/BigModel domain change, and is never the first list item or a model-name guess; Off-Peak keeps its original identity and does not cross the ordinary-plan boundary.

### 2.3 Snapshot and final execution boundary

`ModelSelectionView` had only revision, providers, preferredSelection. The resolution layer needs the Host's authoritative account context; ordinary callers must not read Settings/credentials themselves. The added data are runtime facts with no credentials and no user-file writes. Candidates and account facts come from one applied Account/Registry snapshot (never an old list with a new connection); an account fact change with unchanged candidates must still drive necessary re-resolution; unknown states follow existing source lifecycles and never fabricate a "confirmed no model" snapshot. ModelFactory still only validates an explicit Selection; successful resolution does not promise future execution, and the execution layer never swaps model/level secretly. The Decoder's legacy-structure migration is not part of the normal resolution path.

## 3. State, saving and execution timing

### 3.1 Original intent vs effective result

- The original selection stays the existing persisted field (while editing, the user's latest intent). effectiveSelection is held transiently and every automatic recomputation starts from the original intent, never from the previous auto-emptied/replaced result.
- Ordinary config or account changes alter only the effective result; they must not clear or replace the original selection through the Composer's existing Draft auto-save, and text/attachment edits must keep saving the original selection intent.
- A user's explicit model/level pick or explicit clear forms a new intent per the original edit/save semantics; after clearing, Recent/Session do not refill it. A pick must not produce a nonexistent "target Provider + old model/level" combination.
- Original intent non-empty -> result empty -> config recovers -> result valid again is expected (not "restore from old field"). No persisted shadow or extra compatibility field is added.
- Initialization of a new draft is separate from resolving an existing selection; mode selection, text edits and Snapshot arrival never trigger a default-model fallback.

### 3.2 First-read failure recovery

The read layer keeps loading/unavailable/error/ready; the pure result gets no generic "temporarily cannot resolve". Normal results are only complete or incomplete valid selections (model or level may be empty, with a minimal reason); a read error never masquerades as model invalidation.

```text
public hook: subscribe first, then first read
  config/account change -> new facts arrive -> recompute
  user intent change -> recompute with current facts
  target reconnect -> rebind/subscribe/read
  first read fails temporarily with no new event -> bounded retry in the public read layer
     -> still failing: show the error, manual reload possible
```

A hook that keeps its subscription after a failed first read would not recover without later events; a service init failure clears startPromise so it can be read again, so "wait for onDidChange" alone is not enough. The public read layer allows one bounded, cancellable automatic read retry using the existing retry utility with unified count/interval, with no per-page timers; it does not retry ordinary incomplete results, config writes, claims or dispatches. It retries only recoverable read failures (no target, disposed, auth/explicit config errors are not retried). A new successful View, target/input generation change or unmount cancels old responses and timers; after a first failure, a recovered snapshot with unchanged revision exits the error state; a reconnect may start a new read cycle and an exhausted retry is not cached as permanent failure. A one-shot background read failure returns to the existing scheduling/task-prepare error flow with no separate long-lived subscription or task retry. Source-query unknown and disconnect must not authorize wrongly; same-account last-known-good follows existing source rules and a changed identity does not reuse old entitlement. Explicit pending / no entitlement / Ready empty candidates may yield an incomplete result with the original intent kept.

### 3.3 Explicit write-back and fixing time

- Automatic resolution never writes back. Only existing success boundaries (user save on an edit page, a submit authoritatively accepted) may adopt the effective value; prepare failure/send failure/cancelled edit never overwrites the original intent.
- Before implementation, list the exact success event per entry (an RPC dispatch or optimistic display is not success; not generically "send success"); prefer existing accept/save boundaries, do not wait for the whole generation to finish; if the original contract has no clear boundary, record and discuss.
- Write-back is tied to that input and target; if the user edits the intent while a submit succeeds, the older effective value must not overwrite the new intent. Recent, Draft and Session keep their own authority boundaries and are not written together by View updates.
- A scheduled task's long-term config and this run are two records: the first background resolution result fixes this run only, not the long-term config; only a normal edit-save changes task config.
- Once the run, Submission and Active Model are fixed, there is no re-resolution; retries of the same run do not switch account; the next independent run resolves again. History shows the real executed selection and is not reinterpreted by the current account.
- Off-peak creation fetches a Ticket immediately (`offPeakTaskService.createTask`), so queued does not mean identity is unfixed. No cross-account automatic replacement of off-peak selection this round, and no task cancel/ticket exchange/rebuild or credential-snapshot persistence after an account switch. The existing pre-execution model/account checks and ticket requests stay; the existing expiry/3102 ticket-exchange resume works as before, with no promise of cross-account resume or cross-account reuse of the original ticket. A read-only effective selection cannot overwrite bound execution facts.
- Composer shows no empty-state error; tasks that may still execute keep the incomplete notice/block, finished off-peak tasks get no new error. Controls may show the current effective result, the run record stores the actually adopted value; no global per-item notification is added.

## 4. Impact and entry wiring

This is an option-source, validation, draft-default and commit-effect change; no storage schema change, no migration, no background bulk rewrite.

| Entry / level | Current fact and code seed | Wiring and write-back boundary |
| --- | --- | --- |
| Public layer, must-inspect | `packages/provider/src/facades.ts`; `packages/services/src/model-provider/providerFacadeServices.ts`; `packages/ui/src/hooks/useModelSelectionView.ts` | input original selection, return a View with transient effectiveSelection; public subscription + bounded read retry; read-only and input-isolated; Host/RPC types consistent |
| Composer, must-inspect | `packages/ui/src/v4/composer/useDraftConfigControl.ts`; `packages/ui/src/lib/composerRecent.ts` | the current revision check cleared `draft.modelSelection` and auto-persisted; must become transient derivation; text edits do not write the effective result; success write-back guards against stale submits overwriting new intent |
| Scheduled task edit, must-inspect | `packages/ui/src/settings/AutomationEditView.tsx` | already reads the target Host via useModelSelectionView; form resolution, prompts and save use one result; cancel writes nothing |
| Scheduled task background, must-inspect | `packages/desktop/src/scheduler/index.ts`; `packages/desktop/src/host/index.ts`; `packages/services/src/session/automationRepo.ts` | currently fixes `automation.modelSelection` into the run before dispatch; resolution on the target Host must complete before the first fix (or adjust where the existing chain fixes it); not only in the page, and account rules do not move into scheduler/Main |
| Bot, must-inspect | `packages/services/src/bots/botsService.ts` | draft candidates already read the target ModelSelectionService; unify resolution for display and first submit, keeping Bot's own context/save boundary |
| Wiki, should-inspect | `packages/ui/src/repo-wiki/RepoWikiPane.tsx`; `packages/services/src/repo-wiki` | explicit generation selection reuses the rules; check background start points; generation config and current chat selection do not modify each other |
| Subagent, conditional | `packages/ui/src/settings/SubagentsSection.tsx`; target execution layer | check explicit-override selection entries; with no override keep inheriting the Parent Active Model, never the current account default; if execution cannot get the same selection fact, report the boundary without pushing a temporary alias down |
| Off-Peak, must-inspect | `packages/services/src/model-provider/offPeakModelSelectionView.ts`; `packages/services/src/session/offPeakTaskService.ts` | no cross-account auto replacement or Ticket migration; an unavailable original Provider yields only a transient incomplete result with execution protection kept; the existing list/get/sync `repairLegacyModelSelections` invalidates (writes to the database) an existing new Selection that does not match, and that path automatically destroying original intent must be cut; true legacy-structure migration stays separate; history/Ticket not reinterpreted |

Desktop and Web reuse the resolution algorithm without changing continuous/replayable delivery. An unready remote View does not fall back to the Local Host; isolation follows `workspaceIdentity`, `remoteSessionId` and the existing service owner; account switching does not become a second remote sync.

## 5. Relation to other Todos

- **Explicit Subagent ruling (2026-09-07, later superseded by Todo99)**: this round keeps explicit Subagent original-model validation and does not map automatically from the settings page. Agent `runtime/methods/subagent.ts` fixes the child model from `profile.modelSelection` or the parent Runtime selection; it had no Host Account State, so full mapping needed a separate protocol design. The inherit-Parent-Active-Model path is unchanged (no account default, no runtime alias). It was an explicit exclusion, not counted as implemented unified mapping.
- Todo 85: D01 ruled no pre-send sync; D02's experience is carried here and the old SessionPane switch command is not restored. Other Todo 85 restorations can be reviewed/committed independently; 87 not implemented must not be written as D02 delivered.
- Todo 83/85 provide the correct Account State, Overlay and current account identity as input.
- Todo 86 owns how source refresh drives the View reliably; this Todo owns how a selection resolves once the View arrives; they connect, 87 builds no refresh framework and does not wait for the unruled 86.
- Todo 70/71/72/81/84 keep empty controls on invalidation, no level fill, unchanged committed execution facts, etc. This Todo explicitly replaces "auto-clear and overwrite the original saved Selection" with a transient empty effective result without losing the original intent. Cross-account mapping covers ordinary plans only (Off-Peak excluded this round); legacy structure migration and rollback file strategy are unchanged.

## 6. Order and completion

Update the formal `design/interaction/selection-state.md` and the case catalog/matrix first (noting current behavior vs this Todo's semantics; freeze the read-only input/result interface, account context, per-entry success write-back event and run-fixing location; keep the shared Off-Peak "no silent cross-Family migration" constraint, Ticket mechanism untouched). Write original-intent protection, public resolution, View consistency and first-read recovery tests before the algorithm, read interface and public hook; then wire Composer and scheduled-task editing (separating intent from derived result), then background scheduled tasks, Bot and Off-Peak, then check Wiki and explicit Subagent, especially existing auto-write paths and frozen identity boundaries. Review each step's call chain, reverse-check for UI-only effects or background consumers of unresolved selections, run typecheck, lint, unit tests and isolated MacBook Air interaction E2E (Composer, background scheduled tasks without opening the edit page, Off-Peak selection/ticket boundaries) with evidence of the real request identity/level and file-unchanged or no-request, and commit independently with an implementation report listing wiring points and uncovered entries.

## 7. Acceptance cases (contract; actual coverage per the coverage matrix)

| ID | Setup and action | Must prove | Evidence |
| --- | --- | --- | --- |
| SR87-01 | personal/Team switch, new Provider has the same model/level | only Provider changes; model/level kept; ordinary DeepSeek untouched | public unit test + Composer E2E request |
| SR87-02 | target lacks only the level or the model | only the effective result is emptied per layer; original intent and file unchanged; no default pick, no level-index mapping | unit + control/submit block + file |
| SR87-03 | Personal/Built-in updates level, model enabled or members | same resolution entry as account updates; valid selection unchanged, invalid parts emptied | config/View integration + UI |
| SR87-04 | View late, unknown, Host switch while the user edits the selection | no false clearing, no Host mixing, no overwrite of the user's latest selection; only a Ready authoritative empty candidate set is invalid | state/service tests |
| SR87-05 | restart reads an old account selection with no switch event | account mapping from the current View alone; legacy structures still belong to the Decoder | public/restore integration |
| SR87-06 | scheduled task saved with an old-account model, switch, trigger without opening the edit page | first run fixes the right selection; real request matches; same-run retry does not re-switch | Air E2E + run record/request |
| SR87-07 | Bot old draft, Wiki explicit setting reused | reuse resolution; each record does not pollute Composer/Recent | business integration; E2E per accepted cases |
| SR87-08 | inheriting Subagent, running/finished records | not replaced by the current account, no history/executing object rewrite | targeted invariant tests |
| SR87-09 | send a remote request right after config sync is incomplete | no pre-send sync barrier added; the target Host validates itself | existing sync tests + call-boundary check |
| SR87-10 | original selection temporarily invalid, edit text, config recovers | text save does not clear the original; effective result recovers; an explicit user clear is not restored | Draft/file tests + Composer E2E |
| SR87-11 | first read fails temporarily then recovers with unchanged revision, no change event | bounded read retry recovers; exhaustion allows reload; target change/disposal cancels; incomplete resolution is not retried | Hook/service tests with controlled faults |
| SR87-12 | two consumers pass different selections; same revision with changed input or edit after submit | effectiveSelection not shared; stale responses/old submit success do not overwrite new intent; failure does not write back | public read and submit tests |
| SR87-13 | Z.AI/BigModel domain switch, saved Off-Peak selection mismatches the current account | no auto Provider change; read-only incomplete result, original intent unchanged, pre-execution checks keep blocking; no auto ticket exchange on account switch | public/service tests + Air mock interaction and no-dispatch evidence |
| SR87-14 | existing off-peak Ticket/queued/resume; list/get/sync; switching back to the original account | reads/polling do not clear a new Selection or rebind another account from old repair fields; switching back can recompute a valid model result (Ticket validity not promised); history unchanged; existing expiry/3102 handling kept | service/storage/Ticket integration tests |

Combination pruning: no full permutation by color, vendor brand or reasoning tier; personal/Team gets connection-change representatives, Start gets pending/empty-model representatives, Off-Peak gets Z.AI/BigModel domain switch + original-intent + execution-block representatives, ordinary Providers get config-change representatives; remote gets identity isolation + read recovery; inheriting Subagent gets invariants only. Excluded explicitly: picking the first model of the same model, guessing levels by Chinese name/position, automatic bulk disk writes, off-peak cross-account auto replacement or ticket migration.

E2E handoff: after registering the SR87 mapping in the case catalog/coverage matrix, prepare case-local account/Provider fixtures per e2e-case-lifecycle; no real quota claims, no real Bot messages, no change to the Air's daily config; wait on View revision / run-record conditions, not fixed sleeps; not every public function combination needs a desktop E2E.

## 8. Risks, commits and the off-peak ruling

A medium-to-large cross-entry change, not a single helper; no hard obstacle requiring architecture change or schema migration. Difficulty clusters in: splitting Composer original intent from the effective result and preventing other edits from auto-writing; the background scheduled task fixing the run first; off-peak creation taking a ticket at once with list/get writing invalid state; first-read recovery with no later event. Open situations to discuss with concrete facts (no fuzzy aliases, data scans, auto re-ticketing or request-layer fallbacks): the account target cannot be determined uniquely; a different formal modelId is needed for correspondence; the background fixing point cannot be wired within the existing Host boundary; a task with a bound Ticket should resume across domains. Commits: public layer `cd6c4ff87c`, Composer `ac00daec9c`, Wiki `a3517b732f`, Automation/Off-Peak `e401dbcbb4`, Bot `f0047c4430`; not pushed.

### 2026-09-07 ruling: off-peak cross-account resume is not extended

Against the then-merged fixed staging `16d999f6a48b180b691a4d909479c063580d2ad0`: staging already takes a Ticket at task creation and later requests re-resolve the current account credentials (no per-Ticket original credentials are persisted; `offPeakServerClient.ts` has no diff from that baseline); tasks saved only the old model/thought and built the model at dispatch, with no "compare a new Selection's Provider when reading a task and clear the database" behavior; staging has expiry re-ticketing and model-request 3102 ticket-exchange resume, but the ticket-query not_found branch lacks a complete cross-account recovery flow, and existing client evidence proves neither that a ticket is invalid after a Z.AI/BigModel switch nor that it can be reused (no real ticket API was called). The current `offPeakTaskService.repairLegacyModelSelections()` in list/get/sync invalidates (`offPeakTaskRepo.invalidateModelSelection()` writes `model_selection=NULL, schedulable=0`) an existing new Selection that mismatches; an existing new field must no longer take this clear-then-rebind path, while true legacy-data migration stays separate.

```text
saved off-peak selection + current account/config
 -> only check the original Provider's current validity, no cross-account Provider change
    usable -> keep pre-execution checks | unusable -> transient incomplete, block execution
 -> the persisted original selection is not rewritten by reading
```

Decision: cross-account resume is not extended and the existing selection is not destroyed; the Ticket mechanism is unchanged, no long-term ticket identity storage, no cancel/rebuild of user tasks; best-effort same-model/same-level resolution for ordinary account plans is unaffected.

### Ruling status (not equal to development done)

| Item | Conclusion |
| --- | --- |
| Todo 85 D01: pre-send remote config sync | explicitly not restored |
| Todo 85 D02: selection after account switch | unified resolution per this Todo; no old event-driven bulk rewrite |
| off-peak cross-account and Ticket | no cross-account auto replacement / ticket migration; fix reads that destroy original intent |
| Todo 86: refresh responsibilities | independent draft, still to be discussed; does not block Todo 85 wrap-up |

At the time of writing the final review, commits of the uncommitted restoration group and Todo 87 implementation were still pending, so the incident could not be declared closed; a real boundary conflict from the open situations above is discussed with concrete facts.
