# Todo100 Investigation: Account/Provider/Effective Selection — Status and Convergence Direction

> 2026-09-09; pure investigation, no product fixes. Corresponds to [Todo100](../steps/todo-100-account-provider-selection-architecture-investigation.md). Baseline: `86bbe157c88e8e599694afb53c39f6dac125ac08`. No product code, tests, real accounts, remote configs, or deployments were modified.

## 1. Conclusions

The gap is neither "no public architecture at all" nor "add one sync field and everything works." Public Registry snapshots, the effective-selection algorithm, and UI subscriptions already exist; the gaps are in assembly and consumption boundaries.

Priorities:

1. Execution processes must receive complete Account facts, and sync confirmations must reflect the snapshot actually applied.
2. Entry points that still create models from original selections (explicit Subagents and similar) must connect to the existing public resolution; do not write a parallel algorithm.
3. Check whether effective selection is lost between parsing and dispatch. Task adapters with attachments were found to leak the selection; Bot follow-up messages on existing tasks do not re-resolve.
4. Distinguish "new intent parsing" from "already-fixed execution" at call boundaries; ModelFactory must not silently swap models on its own.

Temporary sync mechanisms do not justify large refactors. Fix completeness, application confirmation, and lifecycle only; public model-selection semantics must not depend on the temporary sync long-term. The independent terminal CLI keeps its simpler account assembly per the user's standing ruling.

Evidence grading: **Confirmed** = explicit code chain or reproduced; **Conditional gap** = branch behavior is determinable but real-user/product-boundary exposure unverified; **Risk** = cannot yet be asserted as a bug. Not every un-invoked resolver location is reported as a bug.

## 2. Current Layering and State Ownership

```text
Host of one execution environment
  Settings / OAuth / Team queries / Built-in / Personal
       |                    |
       v                    v
  AccountProviderService   ConfigService
  Overlay + states         Built-in + Personal
       |                    |
       +----------+---------+
                  v
        ProviderRegistryService
        [config + account + resolution + registry] applied snapshot
                  |
          +-------+--------------------+
          v                            v
  ProviderSettingsFacade       ModelSelectionFacade
  Display/edit facts            Original Selection -> Effective Selection

Workers managed by Host (normal / Wiki, etc.)
  This process's Config Source <---- same-environment config files/refresh
  Mutable Account Source <-- current temporary Account protocol
                  |
                  v
        Same ProviderRegistryService / Resolver
                  |
                  v
        ModelFactory -> frozen models -> request-time authentication
        ^
        Baseline: explicit Subagents not connected to public effective selection
```

Easily confused points:

- `providerFamilyConnectionSelections` are user-persistent selections; Account `current` is a runtime fact. No new persistent "current" was added.
- Account Overlays and Account states are two projections of one account computation; states are not credentials and must not be dropped cross-process "because they are not request configs."
- Workers and Hosts share Provider core code, but **injected data and entry-point assembly differ**. Sharing the same Resolver does not guarantee identical results.
- `ModelSelectionFacade` is a pure public layer: reading the same applied snapshot, it returns candidates and effective selections for a given input; business code does not need to know personal/Team/Start specifics.
- Host network account orchestration lives in services; independent CLIs assemble only simpler personal-plan sources. This is not "algorithms must depend on Host" — service assembly has not been aligned.

### SSH / Phones Are Not a Second Business Algorithm

```text
Desktop environment -- initial/change provisioning --> remote environment config storage
                                      |
                                      v
                                 Remote Host
                                 /       \
                            View services  Remote Workers

Phones / remote -- shared-host attachment --> existing target Host
```

Desktop→remote provisioning and Host→Worker Account syncing are different edges. Do not build runtimes for phones to fix the latter, and do not add a sync barrier before every normal Desktop send. Service targets, caches, and response ownership stay isolated by `workspaceIdentity?.trim() || workspacePath`; actual file operations still use workspacePath.

## 3. Existing Correct Mechanisms: Retain, Do Not Rewrite

| Mechanism                    | Finding                                                                                                                                                                                | Evidence (baseline)                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Registry full application    | Concurrent config/account reads check refresh generation; keeps the previous complete snapshot when Account's based-on Built-in does not match                                        | `packages/provider/src/registry-service.ts:180`                                   |
| Facade same-snapshot parsing | Candidates Registry and Account states come from one `getSnapshot()`; not two separately fetched latest values stitched together                                                      | `packages/provider/src/facades.ts:483`                                            |
| Account revision             | Identity already covers Built-in source, Overlays, and states; only a current change changes the revision — no need to rebuild the revision system                                    | `packages/provider/src/sources.ts:60`                                             |
| Account refresh              | Merges pending reasons, runs serially; failures keep the previous result; events arriving during a failure continue processing; only the initial failure fails the account closed      | `packages/provider/src/account-provider-service.ts:95`                            |
| Account scope isolation      | Resolvers reuse prior results per identity/connection scope; a failed query for one account does not inherit another account's available facts                                        | `packages/services/src/model-provider/accountProviderConnectionResolver.ts:76`    |
| UI async isolation           | Public hook owns generation/owner handling and stale responses; common change notifications re-read the View with the original selection                                              | `packages/ui/src/hooks/useModelSelectionView.ts`                                  |
| Composer original intent     | Drafts save original intent; display/submit derive effective selection; read failures do not clear persisted original intent; accepted write-back has independent boundaries           | `packages/ui/src/v4/composer/useDraftConfigControl.ts:173`                        |
| Final model creation         | Validates the given Provider/Model/tiers precisely before creating frozen-config models; never falls back to the plan's first model                                                   | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts:43` |

So the "unified mid-state solution" is neither locking the whole repository nor deleting these correct mechanisms. Clarify instead: Accounts publish complete results; Registries publish complete applied results; every consumer needing combined facts reads the latter; asymmetric source productions still need targeted scope-consistency guarantees.

## 4. Confirmed Issues and Impacts

### P100-01: States Lost Cross-Process, Execution Eligibility Inconsistent (Confirmed, Priority Fix)

Host Account revisions include states, but envelopes sent from `zcodeAgentService.ts:1169` carry only revision, basedOnZCodeBuiltinRevision, and providers. Baseline protocol and Worker receive paths do not connect states either.

Resolvers test `accountStates?.[providerId]?.current !== false`. That is correct for ordinary Providers/Off-Peak that never define `current`, but non-current ordinary Accounts also pass when the state is lost in transit.

```text
Host:   entitled=true, current=false -> Plan models must not enter the execution Registry
Sync:   keeps entitled=true, drops states
Worker: entitled=true, current=undefined -> current condition passes
```

Impact is not limited to Subagents: precise model creation, protocol model validation, and every other consumer of this Worker Registry are affected. Later authentication may still reject the request, but a late failure must not be treated as earlier correctness.

The opposite direction is also broken: connecting Workers to public effective selection without delivering states makes ordinary account selections resolve to empty (no unique current). Both fixes must be validated as a set.

Recommendation: pass complete same snapshots through the current temporary protocol; Worker boundaries clearly define "fail-closed initialization" and "complete account facts" so leaked states are not misread as normal executable state. Do not make `current` required for all Providers, and do not add `current` for Off-Peak.

### P100-02: Received ≠ Applied, ACK Can Report the Wrong Version (Reproduced in Memory, Priority Fix)

Chain:

- `bootstrap/src/zcode-protocol-entrypoint.ts:239` replaces Account Sources and awaits a Registry refresh but does not verify the returned applied snapshot.
- `bootstrap/src/zcode-protocol/account-provider-config.ts` unconditionally replies with the input `snapshot.revision` as `appliedRevision`.
- The Host stores that in the per-Client confirmation cache and skips same revisions afterwards.
- Registries may return an old snapshot when the Built-in source does not match — that is **correct Registry behavior**.

```text
Worker using A
  -> receives Account B while the matching Built-in B has not arrived yet
  -> Account Source=B; Registry still complete A
  -> protocol replies appliedRevision=B       [error occurs here]
  -> Host considers B applied, stops sending it
```

A 2026-09-09 in-memory run of `ProviderRegistryService` (no real accounts) produced:

```json
{
  "sourceAccount": "account-B",
  "refreshReturnedAccount": "account-A",
  "appliedAccount": "account-A",
  "oldHandlerWouldAck": "account-B"
}
```

The first three items are actual execution results; the last is deduced from the baseline handler logic, not from a full old-protocol run.

Recommendation: derive ACKs from the snapshot actually applied; "received but not yet applied" must be distinguishable and never recorded as success. This does not prescribe blocking waits for the latest, nor rely on unbounded waits/delays. How to express accepted-but-not-applied is the minimal protocol adjustment for the implementation spec.

### P100-03: Explicit Subagents Not Connected to Public Resolution (Confirmed, Consumption-Layer Focus)

Baseline `core/src/runtime/methods/subagent.ts`'s same-name effective helper only takes profile.modelSelection or the parent selection, without calling `packages/provider/src/effective-model-selection.ts`; it then uses precise ModelFactories.

Consequence: an old intent for a personal Provider does not auto-remap when the same model exists in the current Team. With states lost (P100-01) it may first pass the Registry wrongly; after states are delivered it will fail more visibly. "Problems become more obvious after sync is fixed" is not a reason to restore loose gates.

Recommendation: inject the same-process public read/resolve capability when explicit profiles start new executions, using the Worker's already-applied complete snapshot. Profiles do not write back. Nested children and workflow/script children must propagate the same dependency. Implicit inheritance and internal overrides do not go through this re-resolution.

### P100-04: Bot Follow-Up Messages on Existing Tasks Do Not Re-resolve (Conditional Gap, Consumption Boundary Must Be Defined)

`botsService.ts:4842` initial task creation reads the View with the original selection and creates the task with effectiveSelection — correct.

But the existing-activeTask branch at `botsService.ts:4934` is resume + send. `sendPromptInBackground:4764` passes no modelSelection; task adapters add no resolution; Core `turn.ts:105` freezes the Session-saved selection when the intent is missing.

Conclusion: if a Bot task sits idle while the user switches personal→Team and then sends the next message, this path does **not** auto-remap to the same model from the Account update. "ActiveTask" here means long-lived reused task IDs, not necessarily mid-round execution.

Recommendation: new messages to idle tasks are new dispatches and must obtain an effective selection; already-admitted inputs, already-fixed executions, retries, and running guidance must not be re-resolved wholesale. Which established boundary Bot busy inputs freeze at follows the existing CommandInbox semantics; do not rebuild Host queues. Define the boundary; do not flip all follow-up inputs to one behavior.

### P100-05: Task Send Attachment Branch Drops Selections (Confirmed Branch Gap, No Real-Machine Reproduction)

`zcodeTaskServiceAdapter.ts:363` `sendPromptToAgent` receives modelSelection/modelExecution.

- Without attachments: sends V4 sendText carrying both.
- With attachments: calls the old `zcodeAgentService.sendPrompt`, rebuilding arguments without either.

This does not necessarily error on every attachment send — if the Session already holds the same selection, behavior looks normal. But when callers rely on this selection to override or on execution-scoped context, the attachment branch cannot preserve equal semantics. "The upper layer already called getView" does not prove final execution correctness.

Recommendation: restore equivalent transmission using actual protocol capabilities and define the execution-only boundary; do not call setModel globally on running Sessions. Completing the whole attachment protocol migration is not required this round.

## 5. Per-Entry Consumption Review

| Entry                                       | Baseline Behavior                                                                                                                          | Conclusion / Owner                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Composer new and existing session drafts    | Hooks read target services with original selections, derive draftConfig; only accepted write-back persists effective selection              | Public algorithm connected; keep scope/request-race protections; do not continuously re-inject Session snapshots                                                    |
| Normal Core turns                           | Freezes passed-in intents or Session selections before admission; then creates models precisely                                             | Execution layer must not remap silently; upstream new-intent entries must pass complete results                                                                    |
| Scheduled task initial dispatch             | `automationModelSelection.ts` getView(input) with original selection; dispatch returns result                                               | Correct; do not verify only editors — keep this backend chain                                                                                                      |
| Scheduled task fixed runs / retries         | fixedSelection branches return directly; callers use the run selection                                                                     | Correct exception; do not remap accounts                                                                                                                           |
| Bot draft display / initial creation        | Displays returned effective copy; creation resolves and submits effective values                                                           | Connected; P100-04 is the separate existing-task branch                                                                                                            |
| Bot existing-task new messages              | Continue on Session selections                                                                                                             | P100-04; distinguish idle new rounds from accepted running inputs                                                                                                 |
| Task adapter attachment branch              | Does not forward selection/execution context                                                                                              | P100-05; attachment and non-attachment must reach the same selection contract                                                                                      |
| Wiki new generations                        | `resolveGenerationConfig` reads original selections from target Views, validates issues, fixes generation config                           | Connected to public resolution; `repoWikiModelClient.ts:95`                                                                                                        |
| Wiki fixed-generation retries               | `resolveConfig` no longer re-interprets account selections                                                                                 | Correct exception; do not turn retries into getView + plan switch                                                                                                 |
| Explicit Subagents                          | Original profile selections go straight to factories                                                                                       | P100-03; actual execution entries, built-in JSON overrides, and user Markdown parse results treated uniformly                                                       |
| Implicit Subagents                          | Inherit parent active models with frozen factories                                                                                         | Correct exception; background current updates must not switch child models                                                                                         |
| Workflow / script children                  | Independent child runtime assemblies; dependencies must propagate                                                                          | Cover assemblies when connecting public capabilities; do not write separate matching tables                                                                        |
| Titles / Goal titles                        | `title-generation-sidecar.ts:103` reads title config or Session selection, then creates models precisely                                   | Not UI consumption; independent explicit config is a potential missed connection. Host currently creates only a title on/off, no normal UI independent model selection entry — not claimed as a confirmed user-facing fault |
| Compacts                                    | Inherits when the input carries a selection; otherwise creates Session models precisely                                                    | Keep running inheritance; distinguish manual independent Compact new intents from frozen executions at the entry; do not re-resolve every internal model step      |
| Memory extraction / Dreams                  | `project-memory-agent.ts:34` prefers input models, otherwise creates from Sessions                                                         | Extraction inheritance correct; the Dream default path must clarify new work vs. inherited work in the entry spec; do not force-upgrade to the latest account        |
| Connection testing                          | Tests explicit settings Providers/Models, checks actual models in Workers                                                                  | Must not be remapped to another plan through ordinary accounts. Sync correctness applies; public "current plan correspondence" does not apply unconditionally       |
| Off-Peak                                    | Takes a Ticket on creation; dispatch validates and uses the Ticket request context                                                         | Keep original binding, domain, and execution scopes; do not fold into ordinary account auto-remap; P100-05 must not lose execution context                         |
| Phone remote control                        | Shares the target Host's services/task commands; UI shares public hooks                                                                   | No phone-side Account computation needed; keep replayable recovery, workspaceIdentity, and attachment boundaries                                                    |
| Independent terminal CLI                    | Same Provider cores, simplified Account sources, incomplete Team/Start assembly                                                           | Excluded by user ruling; recording the difference is enough                                                                                                       |

### Request-Time Authentication Is Not a Second Model Selector

`accountProviderRequestAuthService.ts` / `accountProviderConnectionResolver.ts:253` obtains current credentials by static access family/mode; mode mismatches reject. The request layer must not change a personal Provider into a Team Provider. API Key/JWT/one-time security-verification material is not static model config.

What is frozen here is **Provider/Model/static request config plus this execution's selection**, not an OAuth token frozen forever. Current code allows compatible family/mode request material to refresh per request (including current Team scopes); that is deliberately weaker than "the same model stays bound to the original account forever." Do not add old-account/team locks here, and do not push tokens through the complete snapshots. Off-Peak has separate Ticket binding rules; ordinary request behavior must not be generalized to it.

## 6. Temporary Sync: Fix Correctness, Do Not Build a Second Platform

### Timing, Frequency, Lifecycle

| Item                    | Current facts                                                                                                                                       | Judgment                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream invalidation   | Family/connection/endpoint setting changes, config source changes, login/logout/purchase explicit refreshes trigger                                  | Event-driven; Account reads usually hit caches, not remote queries each time                                                          |
| Hot push                | Traverse `activeClientsByWorkspaceKey` after Account changes                                                                                        | Normal Workers only; not a process-wide broadcast                                                                                     |
| On-demand checks        | Session create/recover, some reads/subscriptions, generateText, connection testing, startup readiness                                                | Already share one sync helper; strategy entries are scattered                                                                         |
| Normal V4 sends         | Synchronous check at createSession branches; no forced Desktop→SSH sync on every sendText                                                           | Keep the ruling: no global send barrier                                                                                               |
| Deduplication           | Per-Client WeakMap of confirmed revisions; same value skips                                                                                         | Can stay once completeness/ACK correctness are fixed; revision is content identity, not an orderable number                           |
| Serialization           | Per-Client Promise queues; failures do not poison the next task                                                                                     | Exists; no extra queue layer. Snapshots are read before enqueueing — order-discard claims via revision strings alone are insufficient |
| Worker reconstruction   | Confirmation caches keyed by Client objects; new objects inherit nothing; WeakMaps hold no permanent references                                      | Do not add permanent workspace confirmation tables                                                                                   |
| Wiki Workers            | Independent process managers; Host handlers wired; not on the normal active map hot push; check before generateText                                  | Not "completely unsynced." Old complete snapshots allowed; future self-initiated work needs defined init/refresh scopes               |
| Plugin/MCP workers      | Dedicated managers doing plugin/MCP management                                                                                                      | Do not force pure-read capabilities to wait for account readiness "for uniformity"                                                    |

Minimum convergence: keep the existing sync helpers/queues; define the facts needed in the model-execution Worker init/usage contract; fix P100-01/P100-02. Do not chase eliminating every ensure call, and do not add account checks to unrelated RPCs. Deleting the transport later must not change effective-selection algorithms or persistence semantics.

## 7. Mid-States: The Levels That Actually Need Unifying

```text
Source reads / Account queries (async, may fail)
             |
             v
Complete same-scope Account results
             |
             v
Registry checks source matching -> publishes complete applied snapshot
             |
       +-----+----------------+
       v                      v
Settings/candidates/effective     Sync application confirmations
selection read this result       confirm what was actually applied
```

"Global consistency" does not mean all processes switch to B simultaneously. Old complete A snapshots may keep serving; new self-inconsistent combinations must not be published.

Registry protection at this level is confirmed; Facades consume it correctly. **Not yet proven: the Account async upstream is inherently self-consistent.** Settings are read at query start; identities and API material arrive later. AccountService refreshes serially, but unlike the Registry it does not discard stale query results by update generation. No real account switch has reproduced an "old selections + new identities/responses" mix yet.

This is targeted production-side race risk **R100-01**, not "everything is globally broken." Minimum validation: controllable-delayed identity/entitlement ports; switch connections or accounts mid-query; observe whether published scopes, currents, models, and LKGs belong to one round. If they do not, fix production-side scope capture/stale-result publishing — do not bolt timeouts onto the UI.

**R100-02:** synchronized snapshots are read before enqueueing and channels compare values only, not order. Account reads are cached snapshots and Client requests serialize; no reverse-order application was reproduced. Do not introduce a second global version clock for a hypothetical risk; validate via delayed-read/reconnect scenarios.

## 8. What the Reconstruction Should Look Like

The target is not making each feature "know how to sync" but letting each feature state only what input it provides:

```text
Saved configs / current drafts            Fixed Selections / Active Models / Tickets
        |                                        |
        v                                        |  used as-is
Public selection read entries                  |
  = same applied snapshot + original intent     |
        |                                       |
        v                                       |
effectiveSelection + issues + Views             |
        |                                       |
        +------------> new dispatch boundaries <-------------
                              |
                              v
                       precise ModelFactory
                       fixes this model
                              |
                       request-time legal authentication
```

Responsibilities:

- `packages/provider`: keeps owning Account orchestration abstractions, Registry applied snapshots, and pure effective-selection rules. Imports no Host/network/files, persists no business selections.
- Environment assembly layers: provide config sources, Account fact sources, identity classifiers; Host and managed Workers assemble the same selection capabilities. Temporary transports are just one Account source adapter.
- Core: resolves **explicit new intents** through dependency ports; dependencies pass from parent runtimes to children. No dependency on concrete service Runtimes, no per-resolution reverse RPC.
- UI: keep the public hooks; do not copy account mapping/refresh/stale-response handling.
- Bots/Automations/Wikis: each owns intents and execution records; return public rule values that features consume at established new-dispatch points. getView must not become a scan-and-rewrite of task files.
- Factories/adapters: precise execution, no secret fallbacks, no model re-selection on each HTTP retry.

Input types favor clear functions/ports and existing execution scopes over generic "large context objects" or a rebuilt state framework. Moving Account services to another process is a future deployment decision, not a prerequisite for pure resolution algorithms.

## 9. Fix Order and Pending Rulings (Suggestions, Not Authorized Implementations)

1. **Minimal state closure together**: P100-01 complete facts + P100-02 real application confirmations. Cover only current changes, Builtin mismatch, new Clients, and post-failure retries; do not replace cross-end Registry comparisons with optional-field round-trips.
2. **Connect the public consumption chain**: P100-03 explicit Subagent real model calls and all child assemblies; failed original tiers / non-same-models must report per public rules — parent models must not be inherited to mask failure.
3. **Fix dispatch losses and new rounds**: P100-05 attachment protocol transmission; P100-04 Bot idle new inputs. Strictly keep fixed runs, busy admissions, and Tickets; do not rewrite accepted inputs.
4. **Production-side race evidence**: R100-01 delayed query scopes; whether identity changes and Config refreshes can publish mixed results. If confirmed, fix upstream and keep the Registry/hook protections.
5. **Only then structural simplification**: public Facade assemblies, Worker execution-capability initialization. Thorough temporary-sync unification is not a prerequisite.

Product boundaries still needing discussion: Bot busy/queued inputs and independent titles, manual Compacts, Dreams "new work vs. inherit current work". Implicit children, in-run Compacts/extractions, fixed Wiki runs, and Off-Peak need no new rulings.

Out of scope for the minimal fix: independent CLI account services, deleting temporary sync, full-end instant consistency, persisted-structure rework.

## 10. Verification, Paused Experiments, Coverage Limits

### Executed

- Workspace freshness passed; baseline pinned `86bbe157c8`.
- Read-only tracing of the entry points, Host/Worker assemblies, protocol, request authentication, and model factories; no product files modified.
- Registry/Resolver unit tests: 2 files, 21 passing. Facade/AccountService/Account-resolution unit tests: 3 files, 31 passing (52 total — verify the existing public mechanisms, not end-to-end transmission or fixed gaps).
- P100-02 reproduced purely in memory; no real requests, credentials, or user data. One early run named a non-existent `effective-model-selection.test.ts`; the recorded files/cases above are the actually executed set.

### Todo99 Paused Experiments: Still Paused

Workspace trial modifications (states transmission, shared Facade assembly, Core optional resolution port, explicit Subagent helper) cover parts of P100-01/P100-03, but:

- P100-02 ACK not fixed; complete-snapshot end-to-end application unproven.
- Optional-states strictness/missing semantics not contracted.
- P100-04/P100-05 and auxiliary consumer boundaries uncovered.
- Mock-helper success is not proof that real children emit correct requests; workflows, implicit inheritance, and overrides need joint proof.
- Earlier bootstrap test failures (old fixture schemas, stale dependency artifacts) were not fixed; the experiments are not submittable.

Stay paused: neither auto-adopt nor auto-rollback; keep reusable parts for a later ruling. Experiment changes must not be mixed into this "pure investigation complete."

### Not Executed / Future Acceptance Requirements

- No real multi-plan/account switches, real SSH machines, phone attachments, Bot attachments with multiple rounds, or real Subagent network requests.
- R100-01/R100-02 unproven in production; not reproducible incidents.
- After implementation, verify the actual Provider/Model/tiers and execution scope of requests, not just UI text/Schema reception; in-flight switches must not change old models; the next explicit new work must remap.
- Docs-only round: no repo-wide typecheck/lint or E2E results may back the paused experiments.

## 11. Impact Mapping / Graph Rewrite Suggestions

feature-boundary-planner impact-only paths; codegraph tools unavailable — functional graph seeds plus targeted file/call searches, not a claimed repo-wide automatic reference audit.

Main nodes: AccountProviderService → ProviderRegistryService → ModelSelectionFacade → UI hooks / backend new dispatches / implicit children → ModelFactory; the temporary Account transport is a source edge, not an effective-selection rule owner.

Graph facts to update when real implementations land:

- "Explicit Subagents must extend Host parsing RPC" is not a necessary constraint; pure Facades can reuse a Worker's locally applied snapshot.
- "Bots connected to public resolution" splits into drafts/initial creation (done) and existing-task follow-ups (P100-04); the former does not represent full coverage.
- "Workers share Resolvers" does not imply equally complete Account states; the transmission gap is marked separately.
- "Sync success" must distinguish source reception from Registry application; existing applied snapshots are the evidence source.

Investigation completion means itemized conclusions and traceable evidence exist — not that the system has no other bugs, and not authorization to resume Todo99 automatically.
