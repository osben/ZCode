# Todo 99: A Reliable Transition for the Single-Connection Architecture: Account-State Delivery and Effective-Selection Consumption

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implementation and review of the ruled scope done; 2026-09-09. The five fixes, the per-entry review and two local races are closed, and Pro real Worker requests and Electron verification pass. W99-E05, the joint phone shared-host + SSH real-device acceptance, was explicitly deferred by the user (the same-version Web test page was not ready); it is not a completion gate of this round and is not claimed verified. Commits and final checks are at the end and in the review ledger.
> Baseline: 86bbe157c88e8e599694afb53c39f6dac125ac08. Factual basis: [Todo100 investigation report](../research/todo100-account-provider-selection-investigation.md). This plan supersedes the old Todo99 "only fill states/Subagent, do not adjust sync timing"; the investigation report stays as historical evidence.
> Scope reduction (user's second ruling, 2026-09-09): sync keeps its existing timing, queue, checks and failure paths; the lifecycle overhaul, new retry system, latest-merge queue and bulk removal of ensure are cancelled; only certain, local problems (missing transport fields, wrong acknowledgements) are fixed. The phases, cases and completion gate below are reduced accordingly.
> This round ships on the existing single-connection product; [Todo101 coexisting multiple Account Providers](./todo-101-concurrent-account-providers-draft.md) stays a deferred Draft, not implemented early, with no persistence/migration format change.
> Second-round per-entry review, deterministic race reproductions and ongoing verification: [Todo99 implementation review ledger](../research/todo99-implementation-review.md). Product E2E still follows the original completion gate; unit-test counts do not replace it.

## 1. Goal, non-goals and priority

Make the existing model-selection chain work reliably: complete facts, a self-consistent snapshot, correct resolution of new intent, no lost selection at dispatch, and no reinterpretation of fixed execution. Sync is temporary data transport and is not built into a second state platform.

- **Must fix**: P100-01 Account states dropped; P100-02 receipt posing as applied; P100-03 explicit Subagent bypassing public resolution; P100-05 the attachment branch dropping the selection / execution context.
- **Fill in on the existing boundary**: P100-04 Bot idle new turn on an existing task. Sync keeps its existing triggers and checks; perfecting every Worker lifecycle is not a prerequisite.
- **Verify locally, fix as far as practical**: R100-01 publish race when connection/identity switches during an account query; R100-02 timing risk of reading the snapshot before queuing. Prefer the parts covered by existing deterministic tests; a large orchestration change is recorded and deferred, not a precondition of the consumption fixes.
- **Review without mechanical rewriting**: Composer, scheduled tasks, Wiki, title, Compact, Memory, each kind of child; distinguish new intent, inherited execution and an already-accepted Submission.

Not done: multiple personal/Team connections at once, settings-page pure navigation, a new Provider identity format, persistence migration, unifying the standalone terminal CLI account capability, deleting the temporary sync, catching up to the latest config on every send, automatic Provider changes inside Factory/bind, rewriting SSH provisioning or phone attachment. The single logged-in account decides the BigModel/Z.ai off-peak domain; a bound Ticket is not rebound across account/domain; no choice of "which personal/Team plan pays for off-peak" is added.

### 1.1 Final ruling list (entry for implementation and review)

| Category / item | Confirmed problem or review target | Handling and boundary this round | Acceptance basis |
| --- | --- | --- | --- |
| fix 1 / P100-01 | Host -> Worker dropped `states`, so non-current account plans were wrongly allowed | complete transfer; do not extend `current` to ordinary Providers/Off-Peak | real Registry set and protocol round trip, W99-01/02/05 |
| fix 2 / P100-02 | input version posed as applied version; a same-value resubmit could skip the refresh after a failure | local correction of the acknowledgement semantics and re-refresh condition, no rebuild of the delivery system | Source/Registry versions checked separately, match after mismatch, failure recovery, W99-06/07/08 |
| fix 3 / P100-03 | explicit Subagent did not use the public Effective Selection | Worker-local public resolution covering direct/nested/Workflow/Script assembly; fixed, then executed exactly | real child request, original profile unchanged, inherit/override comparison, W99-03/04/12/13 |
| fix 4 / P100-05 | the attachment branch dropped Selection and `modelExecution` | carry them to the execution end with the same selection contract as plain text; no changing the Session model first to bypass | actual command/request, attachment order, execution scope/Ticket, W99-14 |
| fix 5 / P100-04 | Bot idle new turn on an existing task did not re-obtain an effective selection | resolve before dispatch and actually pass the result; no rewriting accepted busy/Guide/queue input | actual new-turn request with the original Bot config unchanged, W99-15 |
| review 1 / consumption entries | Composer, scheduled tasks, Wiki, title, Compact, Memory, each kind of child | distinguish new intent vs fixed/inherited execution; check lost results or wrongly written persisted intent; correct ones stay | §3 per-entry conclusions and W99-16; new semantics found are not mechanically changed |
| review 2 / local races | R100-01/02: mixed old/new identity, stale results/acknowledgement ownership | fix only with deterministic evidence and a low-risk local fix; record big changes as deferred | local tests/logs or an explicit unverified note, no global sync gate |

Three explicit lines: "use the old resolution result" means public resolution over the Worker's **complete old snapshot already applied**, not letting the explicit Subagent keep bypassing the public algorithm; "careful small change" tolerates insufficient sync freshness but must not recreate mixed account facts, fake success, silent model replacement or lost persisted intent here (risks needing a big change are recorded with concrete impact for a second ruling, never hidden as fixed); existing sync timing, queue, ensure and failure paths are kept: no new wait on ordinary sends, no unified lifecycle, no timer retry / latest merge, no Factory/bind change, no persistence/migration change, no Todo101 or standalone CLI account work.

## 2. The two chains to protect

### 2.1 Fact production, delivery and application

```text
Host settings/account query                 Host/Worker's own config sources
 -> one complete Account result [revision + basedOnBuiltin + overlays + states]
    -> Host Registry complete applied snapshot
    -> existing Host -> Worker sync -> Account Source (receives facts) -> Worker Registry (match source, apply as a whole)
 receivedRevision only proves delivery; the applied complete snapshot serves View/resolution/execution
```

The source matching and old-snapshot retention are existing baseline Registry mechanisms, not a new sync state machine. "Matching config" means Account's `basedOnZCodeBuiltinRevision` equals Config's `zcodeBuiltinRevision`, not identical full config content or global versions on both ends. Host applied B while the Worker temporarily applies the complete A is allowed; the Worker mixing A's models with B's account facts, and reporting B applied while A actually is, is not. With no complete usable result initially, it is explicitly unavailable and account executability is never forged. The revision reuses the existing content identity (Built-in source, Overlay, states) so a `current`-only change also yields a different result; it is not an incrementing clock, never compared by string size, and no second global revision is built.

### 2.2 New intent, fixed selection and Model creation

```text
original config / original draft / explicit subtask model intent
 -> public resolution (one applied snapshot of the target execution environment)
 -> transient effective selection + incomplete/unavailable reason
 -> complete only: enter the existing commit/dispatch boundary
 -> fix this Selection / accepted Submission
 -> ModelFactory exact validation -> create Model -> request  (no remap; no model change from background changes)
```

Resolution failure, refresh or opening a menu never clears persisted intent; write-back stays with each business's original accepted/explicit-save boundary (not unified to "write on read" or "all after send"). A fixed selection is validated exactly; a later explicit user switch/Guide is a new legal input, not permission for the background to rewrite an old request. An original account selection maps to the current ordinary Account Provider's same model/level; no same model does not pick the first model and an unsupported level is not filled; ordinary Providers keep their identity. Request-time auth and Factory's final validation stay; a resolution success does not promise the request succeeds and a failure never retries on another Provider quietly.

## 3. Impact and per-entry handling

R100-01 local publish protection: the settings and account identity read in this round are re-checked at the end of the query; if they changed the round's result is rejected and the Resolver's `previousScopes` does not advance (otherwise an unpublished result would pollute the next round's last-known-good). Existing AccountService refresh/error paths stay with no polling, retry or global transaction; only observable scope changes are kept from publishing and the global race of identity A->B->A (no monotonic identity version) is not claimed solved.

| Entry / owner | Input and result | Handling this round | Save / fix boundary |
| --- | --- | --- | --- |
| Host AccountService | settings, identity, entitlement -> Overlay + states | produce completely; check cross-scope mixing | publishes in-memory facts only, no persisted `current` |
| Host -> ordinary/Wiki Worker | complete Account envelope | existing path gets the fields and acknowledgements; trigger timing not reorganized | no user config written |
| Worker Registry / Facade | config + account -> applied snapshot | reuse source matching, generation and public resolution | published as a whole, fields not notified separately |
| Composer / UI hook | original draft -> View + effective selection | regression of subscription, target isolation, dropping stale replies | original accepted boundary; reading never alters history |
| explicit Subagent | profile structured selection -> effective selection | must change: Worker-local public resolution through child assembly | fixed before the child runs; profile/Markdown unchanged |
| implicit Subagent / internal override | parent Active Model / fixed override | keep inheritance and override priority | no remap of parent execution; inheritance never masks an explicit failure |
| scheduled task | saved selection -> new-run selection | audit/regress existing dispatch resolution | no re-resolution after the run is fixed; task config unchanged |
| Bot first creation | Bot draft -> new task | regress the public View already wired | original create/accepted boundary |
| Bot existing task idle new turn | original intent -> this turn's effective selection | add resolution and actually pass it (not validate then drop) | fixed before dispatch of the new input |
| Bot busy / Guide / queue | accepted Submission | keep CommandInbox, the original fixed selection and order | no automatic remap on enqueue/dequeue |
| task send with/without attachment | Selection + modelExecution + payload | fix the attachment branch's missing pass | no Session global model change to bypass |
| Wiki | new generation / retry after fixing | the former already uses public resolution; the latter stays fixed | retry does not re-pick the model |
| title / Compact / Memory | independent selection or inherited Model | classify each; not calling the Facade is not automatically a bug | inherited execution untouched; independent new work confirms the contract first |
| Off-Peak | selection + Ticket scope | regress that context is not lost and binding unchanged | no cross-account/domain ticket exchange |
| SSH / phone | target Host + `workspaceIdentity` | target isolation and protocol regression | no new phone runtime, no change to either delivery |

Check that the Workers consuming models receive the corrected envelope through the existing path; both ordinary and Wiki paths regress but are not forced into one lifecycle entry; no account gate is added to Plugin/MCP or read-only Clients.

## 4. Design

### A. Complete Account contract without widening `current`

1. Check Host serialization, the shared strict protocol schema, Worker decoding, Mutable Source and Registry input together (not one mock test seeing the field).
2. The envelope carries `states` explicitly; "an old Worker doesn't know it / the sender didn't send it" is never treated as complete account facts. An initial fail-closed state may have no usable plan but must not allow an `entitled=true` ordinary plan with `current` lost.
3. Ordinary templates/custom Providers and Off-Peak need no `current`; the missing check is limited to the managed Worker's ordinary-account fact contract, not a global Resolver change that hurts the standalone CLI and non-account Providers.
4. `states` are not credentials: no OAuth token or Key secret goes into new fields or logs; connection identity rides the existing trusted channel; diagnostics are sanitized.
5. With the same config base compare the final executable sets of Host/Worker; with temporarily different bases verify each complete snapshot (no instant equality required).

Main entries: `packages/provider/src` sources, registry-service, resolver; services `zcodeAgentService`; `shared/zcode-protocol`; bootstrap `process-provider-registry-runtime` and `zcode-protocol/account-provider-config`.

### B. Sync keeps the old mechanism, fix only certain local errors

Cancel the previous lifecycle-refactor plan. Keep the existing source-change push, each entry's ensure, the per-Client serial queue and revision de-dup; add no registrar, latest-merge queue, bounded-backoff retry system or bulk deletion of pre-operation checks. Ordinary message sends get no new "wait for latest account sync" barrier; existing sync checks at create/restore entries stay (not claiming all business sync dependencies are removed); the system may keep resolving over the complete old snapshot or fail explicitly if the chosen model is not yet available, never quietly changing the model or clearing the original intent.

R100-02 local timing: each Client's existing serial queue should include `Source.read`, not only the RPC; otherwise a read that started earlier but returns later inserts old results after new ones. Moving the read into the original queue adds no merging, retry or business wait entry; accepted by a deterministic delayed-Source test.

Three small fixes: (1) end-to-end delivery of full `states` (section A); (2) the receipt must not pose the input revision as `appliedRevision`: locally align it to a receipt such as `receivedRevision`, changing the cache/callers accordingly while the Registry's real applied version still comes from the existing snapshot (no reverse apply notification, wait-for-applied handshake or second state machine); (3) an unchanged Source does not mean the last Registry refresh succeeded: resubmitting the same result can still retry an unfinished refresh, failure records no fake success, and recovery follows the existing call/event entries with no timed retry. If the receipt change spreads far beyond the send/receive/cache chain, record the real impact and discuss; version/capability checks regress along the existing deployment mechanism with no automatic upgrade scheme.

```text
applied complete A
 -> Account B reaches the Source, declaring it is based on Built-in B
 -> Registry refresh: local Built-in is still A, mismatch -> keep applied A (no stitched result published)
 -> existing Config Source change: Built-in B arrives -> refresh again: source matches -> apply complete B at once
```

No multi-version queue is needed: the Account Source keeps the latest received facts, the Registry keeps the last complete applied result, and the existing change subscriptions on both sides drive refresh. If the matching config never arrives, auto-catch-up is not guaranteed and only the old complete result stays; with no old snapshot at first, no executable account is pretended. These limits are kept and not turned into an initialization wait/recovery project. Regression focus: no publish on mismatch, applies after a match, receipts do not lie, same-value resubmit refreshes; a send/apply failure promises no immediate self-heal and no unbounded wait or retry.

### C. New-intent entries reuse resolution, not pushed into Factory/bind

An explicit Subagent obtains a same-process read-only resolution port by dependency injection, internally reusing the public `ModelSelectionFacade` and the same applied snapshot; Core imports no Host service/Runtime implementation and makes no reverse Host RPC.

1. Keep the public result's effective selection and problem reason (not just a selection or null that loses the error meaning); no second DTO/algorithm.
2. The managed Worker must wire the port; a missing one may not silently bypass resolution. The standalone CLI keeps its status quo per the ruled scope (an explicit assembly difference, not decided by an accidental omission).
3. User Markdown and built-in Subagent JSON are already structured selections on entering Core and share the explicit branch; old fields are not re-read and user files not modified.
4. The direct child, nested child, workflow and script child all carry the dependency; verify the real creation chain and requests, not only a helper.
5. Implicit inheritance, internal override and fixed execution are unchanged; an explicit incomplete one fails by the original error mechanism, with no fallback to the parent model, the plan's first model or the highest level.

Priority: decide this run's internal execution override first and only then whether to resolve the profile. With an override present the profile resolver is not called, so an off-peak run or other already-fixed execution is not blocked by an unrelated invalid profile (the override itself is still validated exactly by Factory). Resuming an existing child must also validate the final execution selection (create-success does not stand for resume-success). Main entries: Core runtime/methods/subagent, Runtime deps; bootstrap create-app, protocol entrypoint, workflow/script child assembly; Factory and bind keep exact execution meaning, with no temporary "double factory".

### D. Fix consumption and dispatch breaks

**Attachments:** trace Selection/`modelExecution` along task adapter -> Agent Service -> protocol -> runtime. Same semantics as plain text, attachment order and execution scope unchanged; add protocol fields in step with the strict schema; do not `setModel` first then send to bypass the missing pass; no rewrite of the whole attachment transport. Review addition: the old background send mistook `sendInput`'s admission return for turn end, releasing the active controller and Bot/automation turn ownership early; only that lifecycle error is fixed: ACK still returns at once, the background waits for `started_turn.completion` before cleanup and handles admission rejection explicitly; Core's busy/execution constraint validation is reused with no new queue or latest-account wait.

**Bot: bind to the Session and reuse its existing mechanism, no bypass (user's final ruling):**
1. Unbound: allow creating a draft; once bound, the same Session's persisted ModelSelection is the single original intent; Bot keeps no second post-binding model config and does not override the Session with Bot defaults.
2. `/status` and the model and level menus read that Session; desktop and Bot edit the same Session; `/new` keeps its existing inheritance and is not the old "re-pick the default on every send".
3. `/model` and a standalone level change are committed Session config commands that take effect and save at once (user confirmed); not turned into a Composer-style uncommitted draft, no Bot pending selection.
4. Fix the lost complete selection: Bot already passed provider/model/reasoning, but the old `session/setModel` formatted it as a string and the Session setter kept only identity. The shared Session edit entry must validate, apply and save the complete selection; no two-step Bot patching and no fix that only changes status text while execution still drops the level.
5. An existing task's idle new message resolves a valid value from the **Session's original selection** via the public View at the established dispatch boundary and actually sends it for that input; failure changes no default model and clears no original intent; resolution writes no persisted data; saving after submit follows the Session's existing boundary.
6. Accepted busy/Guide/queue input is not reinterpreted, CLI admission is authoritative, no Host queue is added; attachments carry Selection/`modelExecution` too (no first-modify-Session bypass); remote targets keep the existing Task Service routing and `workspaceIdentity` isolation.

Read boundary: Task Service exposes a read-only `getTaskModelSelection` returning the structured original selection through the target Agent's Session read; the Session settings `model.current` keeps the complete original (including a temporarily invalid level), and candidate/display validation stays with the corresponding View; never reverse-infer the original from menu options or a filtered thoughtLevel. This adds no persisted field or second model state.

```text
unbound Bot: create draft -> public resolution -> create Session -> clean the creation draft
bound Bot: the same Session original selection
  +-> /model config command -> full validate/apply/save immediately -> existing status projection
  +-> idle new input -> public effective resolution -> fix this input -> existing admission/execution/save
fixed execution, inherited subtask, accepted input: not remapped
```

Other entries: classify each as "correct / certain gap / semantics undecided" with call chain and tests. A title, manual Compact or Dream with independent model intent first states its source and fixing boundary; not every ModelFactory call is swapped for a resolver. Bot default initialization is unchanged: "use default config" is not the model editor's smart configuration; only when creating a draft without Selection does it take the target Host `preferredSelection` (a valid configured default, else the first initializable model of the Registry order at its highest level); an existing Selection failure must not switch to `preferredSelection`; after binding a Session this initialization rule no longer overrides its selection.

### E. Keep the complete-snapshot principle, handle extra races carefully

No global transaction layer. Account's one round is published as a whole; Registry applies config/account only after they match; consumers of combined facts read one applied snapshot once. R100-01: with controllable promises, switch connection/account B during query A, interleave the identity, entitlement and config replies, and check scope/current/models/LKG; a complete old A may exist briefly but A's facts must not be labeled with B's identity; if mixing or an old reply overwriting a new scope is reproduced, capture the source in production and reject the stale commit (no UI timeout patch). R100-02: prefer existing queue/Client tests to check old-reply ownership and never treat the content revision as a timestamp; options needing a new latest-merge, lifecycle or global ordering mechanism are deferred, not an acceptance requirement. If the investigation shows only the old sync's insufficient freshness, record the limit; if mixed identity or wrong allowance is confirmed, assess a local patch; big changes are registered as unfixed risk with impact for the user's ruling and the scope is not enlarged quietly.

## 5. Order and stage exit

Each stage: check spec -> red test -> minimal implementation -> targeted verification -> review -> record. Stages: D99-0 baseline and paused-experiment cleanup; D99-1 state completeness (A + ACK/repeated refresh; W99-01/02/05/06/07/08, compare the actual Registry); D99-2 existing sync regression (reduced; W99-09/10, W99-11 deferred, no new send barrier); D99-3 explicit Subagent (C; W99-03/04/12/13 with real requests); D99-4 other consumption breaks (D: attachment, Bot idle new turn, per-entry audit; W99-14/15/16); D99-5 local risk and full-chain review (E, SSH/phone/restart regression, doc write-back; W99-17/19, W99-18 pursued if locally verifiable). **Release cannot be split:** adding states may expose explicit Subagent failures that wrong allowance masked, so D99-1 and D99-3 must be accepted together before claiming it usable. Paused experiments were reviewed: the states envelope and round-trip tests are reusable; the shared Facade/Core callbacks/child propagation are rechecked against C with one algorithm and a complete problem result; returning only a selection or null is replaced by the incomplete-result contract; old fixtures are updated to the real schema without loosening validation; others' dirty files are not rolled back or bundled.

## 6. Verification contract

W99-11 is explicitly deferred; W99-18 is a pursuable local investigation; the others follow the reduced contract. The Todo100 52 existing unit tests and ACK in-memory reproduction do not prove this fix.

| Case | Setup -> action | Must assert / evidence layer |
| --- | --- | --- |
| W99-01 | two plans entitled, only Team current -> real protocol round trip | states lossless; same-base executable sets equal at both ends, personal not allowed |
| W99-02 | change only current -> publish/deliver | revision changes; models/current come from the same applied snapshot |
| W99-03 | explicit personal selection, Team has the same model/level -> Subagent | the actual child request is Team's same model/level, profile's original intent unchanged |
| W99-04 | missing model, invalid level, unspecified, internal override -> child | the first two fail as incomplete; the last two inherit/override unchanged, no fill |
| W99-05 | bad/missing states, initial no entitlement, API, Off-Peak -> apply | a bad envelope is not allowed loosely; legal fail-closed expressible; non-account/off-peak need no `current` |
| W99-06 | applied A; Account B first, Builtin B not yet -> sync | Source B, Registry A; only received B acknowledged, no fake applied B |
| W99-07 | continuing 06, Builtin B arrives -> config notification | the complete B applies without resending Account B; Facade updates with it |
| W99-08 | replace B then refresh throws -> resubmit B; also apply-side recovery | no cached fake success; changed=false does not block recovery; the old complete result readable |
| W99-09 | existing Worker init/rebuild -> sync at the original entry | corrected fields/receipt reach a new Client; no new registrar or timers |
| W99-10 | ordinary/Wiki at the original trigger -> account sync/execution | both existing paths carry the complete states; no read-only gate, no per-send latest barrier |
| W99-11 | original plan: latest-merge queue, bounded backoff, unified lifecycle | **deferred / not done this round**; the number records the user's reduction and is not a completion gate |
| W99-12 | parent request fixed, background account switch -> implicit child/retry | original Model/scope unchanged, no quiet remap |
| W99-13 | direct/nested/workflow/script child -> explicit selection | actual assembly connected, not just a helper |
| W99-14 | same selection, with/without attachment -> runtime | Selection/`modelExecution` equivalent, attachments ordered, Ticket scope kept |
| W99-15 | Bot existing task idle, plan switched -> next message | the effective value is actually dispatched, Bot's original config unchanged; a fixed busy input is not remapped |
| W99-16 | Composer/scheduled/Wiki intent invalid or unknown -> refresh/dispatch | original intent kept, the new dispatch fails explicitly; a fixed run / Wiki retry does not change model |
| W99-17 | SSH + phone attachment + Worker restart -> send | `workspaceIdentity` not mixed, phone reuses the target Host, the two deliveries not mixed |
| W99-18 | switch connection/identity/config during a delayed query -> interleaved completion (pursuable) | record the result if locally verifiable; if a big change is needed register the risk as deferred, no global sync overhaul required |
| W99-19 | old-protocol Worker / protocol failure -> startup delivery | explicit incompatibility / existing redeploy, no silent fallback or fake acknowledgement |
| W99-20 | bound Bot `/model` across models and picking reasoning, then read state, cold restore, send | the complete Selection saves at once and the actual request agrees; an invalid explicit level yields no half-modification; no new Bot persisted selection |

Pruning and evidence: ordinary accounts use the personal -> Team same-model representative remap (different Team identities and BigModel/Z.ai are covered by centralized classification/protocol tests; no per-plan/theme/language permutation); timing uses controllable promises / fault injection (not real network luck or long sleeps); new intent, fixed Submission, implicit inheritance, internal override and Ticket must not be pruned into one passing case; UI and request/protocol/persistence assertions are joint (Bot/attachment/child helper unit tests are not E2E); representative interaction cases are registered in the [Case Catalog](../../../conversation-session-case-catalog.md) and [Coverage Matrix](../../../testing/conversation-session-e2e-coverage-matrix.md) Todo99 section (all missing/planned, not formal coverage); new E2E goes to manual-review/pending, reusing V4 helpers and case-local fixtures/manifest (ordinary text fast-text; run windows controlled-stream with the reason), promoted by the existing process only after evidence is reviewed; the E2E host is the available MacBook Air (Pro as a substitute, recording the actual host); SSH/phone wait for the environment and unrun items are kept as such (a desktop representative does not stand for all ends); isolated test data, no changes to real accounts/tasks or remote data.

## 7. Docs, graph and stage review

Check the current specs before implementation, especially Account/Registry, Model/Submission, Subagent assembly and remote-control fact docs. The conversation-protocol-declaration Model section still has old types and old readiness/fallback wording and must not be used to add sync barriers or model replacement (existing ensure is kept this round); fix only the clauses this item affects. No codegraph (Todo100 targeted call chains and the feature-graph seeds); after implementation write back the confirmed facts: Worker-local public resolution; Bot first creation vs later separate; Source received vs Registry applied separate; target design is not recorded as implemented early. Each stage review answers: root cause or stacked fallbacks, and can duplicated algorithms/temporary wiring be deleted in this change (no mandate to bulk-clean existing sync ensure); which complete facts a result comes from and whether Source-new and Registry-old were stitched; new intent or fixed execution, who saves and when and whether anything is quietly cleared/replaced; ordinary/Wiki Workers and children all covered and protocol/assembly still not dropping fields or bypassing; non-account, Ticket, `workspaceIdentity`, desktop continuous / mobile replayable and CLI scope held; which failing tests/real requests/logs prove passing and what is unverified.

## 8. Execution record and completion definition

W99-E04 real-device addition: when ModelFactory threw before the Turn's inner error handling, the old implementation only logged a background exception: the accepted command had no terminal event and the UI showed no error. A failure to create a Model is now reported through the existing Turn outcome event (same inputId), fabricating no model request, switching no selection and waiting for no account delivery; failures already handled inside are not reported twice; cancellation keeps cancellation semantics.

| Item | State | Evidence / next |
| --- | --- | --- |
| P100-01 complete state | verified | strict envelope, real Built-in Registry set, Pro Host->Worker request after switching to Team; cross-version deployment not claimed verified |
| P100-02 acknowledgement / failure refresh | verified | protocol received vs Registry applied separate; same-value refresh; Pro controlled old A -> deliver B -> fresh submit recovery |
| P100-03 explicit Subagent | verified | DI through Core/Workflow/Script; real child request, Workflow child execution, resume integration; Pro personal profile -> Team/high with parent selection and profile unchanged |
| P100-05 attachment dispatch | verified | strict protocol / Task adapter / real Worker request; attachments ordered, execution high not overriding Session low, Ticket isolation unchanged |
| P100-04 Bot idle new turn | verified | Bot input -> production Task adapter -> actual Worker Team request; `/model`, level and cold restore keep the Session authoritative |
| Bot Session authority / config command timing | verified | complete model and level validated and saved once; invalid level yields zero partial update; Pro Worker keeps it after restart |
| other consumption entries | reviewed, per-item in the ledger | Composer, scheduled, Wiki, title, Compact, Memory, each child, Bot busy, Off-Peak classified as new intent vs fixed execution, not mechanically changed |
| local race review | local fix done | R100-01 identity/settings re-check; R100-02 read in the original Client queue; global atomicity not claimed |
| W99-E05 joint multi-end real device | explicitly deferred by the user (2026-09-09) | no Web package deployed, real-device pass not recorded; stays "pending environment verification" |
| lifecycle unification / bulk ensure deletion / latest merge / timed backoff / W99-11 / global ordering overhaul | out of this round | user's second ruling: temporary sync gets careful small changes |
| Todo101 / standalone CLI | out of this round | designed separately later |

Completion requires: P100-01 to 05 closed within the agreed scope; local sync fixes with regressions and the other limits recorded; all consumption entries audited; no fake applied ACK, no new per-send gate, no remap of fixed execution; spec/tests/graph aligned. Real multi-end evidence lacking is never recorded as verified; if product semantics must widen, pause only that sub-item with impact and a recommendation.

### Implementation notes (2026-09-09)

- Changed chain: shared Account envelope/receipt -> Host delivery cache -> bootstrap Account decoding / process Runtime; sync triggers, serial queue and existing ensure unchanged, no send barrier or retry timer added. Tests failed before the fix for: missing states still accepted, old applied receipt, missing `current` allowed, same-value delivery no longer refreshing (`accountProviderSnapshotProtocol.test.ts`, `account-config-delivery.test.ts` through a real protocol Server).
- `createNodeModelSelectionFacade` reuses the Host/Worker identity classification; Core accepts only the resolution port; `EffectiveModelSelectionResult` moved to shared/model-selection (no second DTO/algorithm); a missing level keeps `selectionIssue` and blocks the child run. Real Core child-Runtime request tests cover explicit profile, implicit inheritance, internal override and explicit unavailable, plus a resume case where a completed child re-resolves the explicit profile with the original profile unchanged. Nested Core child / Script child: the current config sets `subagents.enabled=false`, so nesting is not enabled for tests; the port is passed through but a non-existent product path is not claimed run; Script's `opts.model` is a separate explicit API.
- Bot: after binding, the Session is the only model authority; `/model` and level commands save at once. The old `session/setModel` formatted the Selection as a string and the shared setter dropped reasoning; structured input is now validated as a whole and saved once (the string entry keeps identity-only semantics). Bot reads Task Service `getTaskModelSelection` (complete `settings.model.current`, unfiltered by menus, remote `workspaceIdentity` kept). An idle new input passes the public effective result into `sendPrompt`; a missing/unavailable original selection is rejected and `preferredSelection` is not a fallback.
- Attachments: the old session/send path now carries Selection/`modelExecution` under a shared strict execution-constraint schema; credentials enter only this turn's non-persisted dependencies. The old background treated admission as completion and released the controller and Bot/automation ownership early; it now waits for `started_turn.completion` while the outer ACK stays immediate and rejected goes to the failure terminal (the old `prompt_completed` fixture that posed rejected as success was corrected).
- Verification highlights: shared/Host 20, bootstrap account delivery and protocol 7, Core explicit selection / actual child / execution scope 31, `botsService.messageFlow.test.ts` 85/85, shared attachment/Task adapter/Bot config 110/110, Session selection protocol + facade + original `zcode-protocol` 112 pass / 1 fail (the existing remote Cron denylist difference, unrelated); existing Bot pending spec 5/5 under the Vitest Node harness (not Electron/real model); root typecheck, `typecheck:e2e`, Bootstrap typecheck, lint (39 existing warnings, 0 errors) and `git diff --check` pass. A wider bootstrap run had 5 existing failures (old template fixture, Standalone credential/import assertions, Cron denylist, ENOTEMPTY cleanup) not turned into new semantics; `botsService.messageFlow` once OOM'd (root cause not located). No commit/push yet; no confirmed SessionStart ID for a trailer. The protocol changed, so a release needs matching Host/Worker artifacts; an old Worker cannot loosely be treated as complete state.
