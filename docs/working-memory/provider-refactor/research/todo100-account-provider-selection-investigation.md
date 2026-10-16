# Todo100 Investigation: Current Status and Convergence Direction for Account/Provider/Effective Selection

> 2026-09-09; pure investigation complete, no product fixes. Corresponds to [Todo100](../steps/todo-100-account-provider-selection-architecture-investigation.md).
> Baseline committed: `86bbe157c88e8e599694afb53c39f6dac125ac08`. Files affected by paused experiments verified with `git show HEAD:<path>`, cannot prove baselines fixed with workspace trial modifications. No product code, tests, real accounts, remote configs, or deployments modified.

## 1. Conclusions

It is not "no public architecture at all," nor is it "just add one field to sync and everything is fine." Public Registry snapshots, effective selection algorithms, and UI subscriptions already exist; the main gaps are in assembly and consumption boundaries.

Priorities:

1. Ensure actual execution processes obtain complete Account facts, and sync confirmations reflect truly applied snapshots.
2. Explicit Subagent and similar entry points that still create models from original selections should接入 existing public resolution; not write another corresponding algorithm.
3. Check whether effective selection loses from parsing to dispatch. Tasks adapters with attachments were found to leak this selection; Bot existing task next messages do not re-obtain effective selections.
4. Clearly distinguish "new intent parsing" from "already-fixed execution" at call boundaries; ModelFactory should not uniformly swap models secretly inside.

Temporary sync mechanisms are not worth doing large refactorings for first. Fix completeness, application confirmation, and lifecycle only; public model selection semantics should not depend on its long-term existence. Independent terminal CLI's complete account assembly still unchanged per user ruling.

Evidence grading: **Confirmed** means the code chain is explicit or reproduced in memory; **Conditional gaps** mean branch behaviors can be determined but whether real users trigger/product boundaries still need distinction; **Risks** mean errors cannot yet be asserted. The below does not report every un-invoked resolver location as a Bug.

## 2. Current Layering and State Ownership

```text
A single execution environment's Host
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
  This process's Config Source <---- Same-environment config files/refresh mechanisms
  Mutable Account Source <-- Current temporary Account protocol
                  |
                  v
        Same ProviderRegistryService / Resolver
                  |
                  v
        ModelFactory -> Fixed Models -> Request-period authentication
        ^
        Baseline explicit Subagents not connected to public Effective Selection
```

Several easily confused points:

- `providerFamilyConnectionSelections` are user-persistent selections; Account `current` is runtime fact, no new persistent current added.
- Account Overlays and Account states are two projections of one account calculation; states are not credentials and cannot be dropped cross-process just because "they are not request configs."
- Workers and Hosts have already shared Provider core code, but **injected data and entry point assemblies differ**. Sharing the same Resolver does not guarantee identical results.
- `ModelSelectionFacade` is a pure public layer. Reading the same applied snapshot, it returns candidates and input-corresponding effective selections; no business needs to recognize personal/Team/Start individually.
- Host network account orchestration is located in services; independent CLIs currently only assemble simpler personal plan sources. This is not "algorithms must depend on Host," but service assembly has not yet aligned.

### SSH / Phones are Not Another Set of Business Algorithms

```text
Desktop environment -- initial/changes provisioning --> remote environment config storage
                                      |
                                      v
                                 Remote Host
                                 /       \
                            View services  Remote Workers

Phones /remote -- shared-host attachment --> existing target Host
```

Desktop→remote environment provisioning and Host→Worker Account syncing are different edges. Do not build runtimes for phones just to fix the latter, nor add barriers to sync Desktop's latest configs before every normal send. Service targets, caches, and response ownership continue to be isolated by `workspaceIdentity?.trim() || workspacePath`; actual file operations still use workspacePath.

## 3. Existing Correct Mechanisms: Retain, Do Not Rewrite

| Mechanism                    | Investigation Results                                                                                                                                                                 | Evidence Entry (baseline)                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Registry full application    | Concurrent reads of config/account, check refresh generation; retains previous complete snapshot when Account's based-on Built-in does not match                                      | `packages/provider/src/registry-service.ts:180`                                   |
| Facade same-snapshot parsing | Candidates Registry and Account states come from one `getSnapshot()`; not separately fetching latest values from two services then stitching                                          | `packages/provider/src/facades.ts:483`                                            |
| Account revision             | Identifiers already include Built-in source, Overlays, and states; only current changes also change revision, no need to rebuild revision systems                                     | `packages/provider/src/sources.ts:60`                                             |
| Account refresh              | Merges pending reasons, serially runs; failures retain previous results; new events during failures continue processing; initial failures only account fail-closed                    | `packages/provider/src/account-provider-service.ts:95`                            |
| Account scope isolation      | Resolvers select reusable old results by identity/connection scope, not directly inheriting another account's available facts because one query failed                                | `packages/services/src/model-provider/accountProviderConnectionResolver.ts:76`    |
| UI async isolation           | Public Hook handles owner, input changes, request generations, old responses; receiving common change notifications with inputs re-reads View with original selection                 | `packages/ui/src/hooks/useModelSelectionView.ts`                                  |
| Composer original intent     | Drafts save original intent, display/submit derived effective selection; reading failures do not clear original intent to databases; accepted writes back have independent boundaries | `packages/ui/src/v4/composer/useDraftConfigControl.ts:173`                        |
| Final model creation         | Precisely validates already-given Provider/Model/tiers before creating frozen-configured Models; does not fall back to plan's first model                                             | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts:43` |

Therefore, the so-called "unified mid-state solution" is not locking the entire warehouse, nor deleting existing correct mechanisms. What should be clarified: Accounts publish complete results, Registries publish complete applied results, all consumers needing combined facts read the latter; asymmetric source productions still need targeted scope consistency guarantees.

## 4. Confirmed Issues and Impacts

### P100-01: States Lost Cross-Process, Execution Eligibility Inconsistent (Confirmed, Priority Fix)

Host Account revisions already include states, but envelopes sent from `zcodeAgentService.ts:1169` contain only revision, basedOnZCodeBuiltinRevision, and providers. Baseline protocols and Worker receive paths also do not connect states.

Resolvers use `accountStates?.[providerId]?.current !== false`. This has established uses for ordinary Providers/Off-Peak that do not define current, but non-current ordinary Accounts also pass when information is lost.

```text
Host:   entitled=true, current=false -> Plan models do not enter execution Registry
Transfer: only retains entitled=true, drops states
Worker: entitled=true, current=undefined -> current condition passes
```

Impacts are not just Subagents, but also precise model creation, protocol model validations, and other entry points using this Worker Registry. Subsequent authentication may reject requests again, but cannot treat late failures as correctness earlier.

Another direction: connecting Workers to public Effective Selection without supplementing states would cause ordinary account selections to parse as empty without unique current. Both fixes need to be validated as a set.

Recommendation: pass complete same snapshots through the current temporary protocol; Workers' boundaries clearly define "initialization fail-closed" and "complete account facts," avoiding leaked states being misread as normal executable states. Cannot simply make current required for all Providers, nor add current for Off-Peak.

### P100-02: Received Does Not Equal Applied, ACK Can Report Wrong Versions (Memory Reproduced, Priority Fix)

Chain:

- `bootstrap/src/zcode-protocol-entrypoint.ts:239` replaces Account Sources, await Registry refresh, but does not verify the returned applied snapshot.
- `bootstrap/src/zcode-protocol/account-provider-config.ts` unconditionally replies input `snapshot.revision` as `appliedRevision`.
- Host stores this result in each Client's confirmation cache, skipping same revisions subsequently.
- Registries allow refreshes to return old snapshots when Built-in sources do not match; this is **correct Registry behavior**.

```text
Worker using A
  -> receives Account B,配套 Built-in B has not yet arrived
  -> Account Source=B; Registry still complete A
  -> Protocol replies appliedRevision=B       [error occurs here]
  -> Host considers B complete, stops sending same content
```

On 2026-09-09, no-account, pure-memory `ProviderRegistryService` execution yielded:

```json
{
  "sourceAccount": "account-B",
  "refreshReturnedAccount": "account-A",
  "appliedAccount": "account-A",
  "oldHandlerWouldAck": "account-B"
}
```

The last item is deduced from baseline handler logic, not claimed to have run the entire old protocol process. The preceding three are actual execution results.

Recommendation: ACKs derived from actual applied snapshots; not-yet-applied must be clearly distinguished, cannot be recorded as success. Does not prescribe blocking waits for the latest, nor relies on infinite waits/delays. How to express accepted-but-not-applied can be the minimum protocol adjustment chosen in implementation specifications.

### P100-03: Explicit Subagents Not Connected to Public Resolution (Confirmed, Consumption Layer Focus)

Baseline `core/src/runtime/methods/subagent.ts`'s same-name effective helper only takes profile.modelSelection or parent selections, without calling `packages/provider/src/effective-model-selection.ts`. Subsequently uses precise ModelFactories.

Therefore, old intents from personal Providers do not automatically correspond when the same model exists in current Teams. When states are lost, it may first incorrectly pass the Registry; after supplementing states, it will more clearly fail; so "problems become more obvious after supplementing sync" is not a reason to restore loose gates.

Recommendation: inject the same-process public read/parse capabilities when explicit profiles start new executions, using Workers' already-applied complete snapshots. Profiles do not write back. Nested children, workflow/script children must propagate identical dependencies. Implicit inheritance and internal overrides do not go through this re-parsing.

### P100-04: Bot Existing Task Subsequent Messages Do Not Re-parse (Conditional Gap, Consumption Boundaries Must Be Clear)

`botsService.ts:4842`'s initial task creation reads Views with original selections, creates tasks using effectiveSelection; this is correct.

But `botsService.ts:4934`'s existing activeTask branch is resume + send. `sendPromptInBackground:4764` does not pass modelSelection; task adapters do not supplement parsing, Core `turn.ts:105` directly freezes Session-saved selections when intents are missing.

Conclusions: if the same Bot task is idle, users switch personal→Team, then send next messages, this path **does not automatically correspond to the same model due to Account updates**. Here, "activeTask" means long-term reuse task IDs, not necessarily executing in one round.

Recommendation per this round's goals: new messages from idle tasks belong to new dispatches and should obtain effective selections; already-admitted inputs, already-fixed executions, retries, and running guidance should not be universally re-parsed. Specific Bot busy inputs freeze at which established boundaries need to follow the original CommandInbox semantics, cannot rebuild Host queues. Semantic boundaries noted here, not arbitrarily changing all subsequent inputs to the same behavior.

### P100-05: Task Send Has Attachment Branch Losing Selections (Confirmed Branch Gap, No Real-Machine Reproduction)

`zcodeTaskServiceAdapter.ts:363`'s `sendPromptToAgent` receives modelSelection/modelExecution.

- No attachments: sends V4 sendText, carrying both.
- With attachments: calls old `zcodeAgentService.sendPrompt`, both items not carried when manually rebuilding parameters.

This does not necessarily cause every attachment send to error: if Sessions happen to already be at the same selection, behavior may be normal. But if callers rely on this selection to override or execution-specific scopes, attachment branches cannot preserve equal semantics. Upper layers "already called getView" is insufficient to prove final execution correctness.

Recommendation: restore equivalent transmission based on actual protocol capabilities, clearly define execution-only boundaries; cannot simply setModel globally on already-running Sessions. Does not require completing the entire attachment protocol migration this round.

## 5. Per-Entry Consumption Review Table

| Entry                                       | Baseline Actual Behavior                                                                                                              | Investigation Conclusions / Subsequent Ownership                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer new and existing session drafts    | Hooks read target services with original selections; derive draftConfig; only accepted successful writes back of effective selections | Public algorithm connected; retain scope/request to prevent races, do not continuously re-inject Session snapshots                                                                                                                |
| Normal Core Turns                           | Freezes传入 intents or Session selections before admission; subsequently precisely creates Models                                     | Execution layer should not secretly remap; requires upstream new intent entries to pass complete results                                                                                                                          |
| Scheduled task initial dispatch             | `automationModelSelection.ts` has original selections when getView(input), dispatch returns results                                   | Correct; cannot only verify editors, need to keep this backend chain                                                                                                                                                              |
| Scheduled task already-fixed runs / retries | fixedSelection branches directly return; callers use run selections                                                                   | Correct exceptions; do not re-correspond accounts                                                                                                                                                                                 |
| Bot draft display/initial creation          | Displays returned copy effective values; creation parses and submits effective values                                                 | Connected; P100-04 is another existing task branch                                                                                                                                                                                |
| Bot existing task new messages              | Continue along Session selections                                                                                                     | P100-04; distinguish idle new rounds from accepted-running inputs                                                                                                                                                                 |
| Task adapter attachment branches            | Do not forward selections/execution contexts                                                                                          | P100-05; attachment and non-attachment must reach the same selection contract                                                                                                                                                     |
| Wiki new generations                        | `resolveGenerationConfig` reads original selections to target Views, validates issues, fixes generation configs                       | Connected to public resolution; `repoWikiModelClient.ts:95`                                                                                                                                                                       |
| Wiki fixed generation retries               | `resolveConfig` no longer re-interprets account selections                                                                            | Correct exceptions, cannot change retries to getView then switch plans                                                                                                                                                            |
| Explicit Subagents                          | Original profile selections directly enter factories                                                                                  | P100-03; actual execution entries, built-in JSON overrides, and user Markdown parse results treated uniformly                                                                                                                     |
| Implicit Subagents                          | Inherit parent Active Models, with frozen model factories                                                                             | Correct exceptions; cannot let background current updates switch child models                                                                                                                                                     |
| Workflow / script children                  | Independent child runtime assemblies, dependencies must propagate                                                                     | Must cover assemblies when connecting public capabilities, do not write separate matching tables                                                                                                                                  |
| Titles / Goal titles                        | `title-generation-sidecar.ts:103` reads title configs or Session Selections, then precisely creates Models                            | Not UI consumption; independent explicit configs are potential missed connections. Checked Host currently creates only title on/off, no normal UI independent model selection entries; not exaggerated into confirmed user faults |
| Compacts                                    | Inherits when inputs exist; precisely creates Session Models when not                                                                 | Retain running inheritance; manual independent Compact new intents and frozen executions should be distinguished at entries, do not re-parse every internal model step                                                            |
| Memory Extraction / Dreams                  | `project-memory-agent.ts:34` prioritizes input Models, otherwise creates from Sessions                                                | Extraction inheritance correct; Dream default paths need to clarify new work vs. inherited work in subsequent entry specifications, do not force-unify to latest accounts                                                         |
| Connection testing                          | Tests explicit settings Providers/Models, checks actual models in Workers                                                             | Should not be remapped to other plans through ordinary accounts. Sync correctness applicable; public "current plan corresponding" not unconditionally applicable                                                                  |
| Off-Peak                                    | Takes Tickets on creation; dispatches validations, uses Ticket request contexts                                                       | Maintain original bindings, original domains, and execution-specific scopes; do not merge into ordinary account auto-remap; P100-05 cannot lose execution contexts                                                                |
| Phone remote control                        | Shares target Host services/task commands, UIs share public Hooks                                                                     | No need to add phone Account calculations; must maintain replayable recoveries, workspaceIdentity, and attachment boundaries                                                                                                      |
| Independent terminal CLI                    | Same Provider cores, simplified Account sources, incomplete Team/Start assemblies                                                     | Users have excluded, recording differences is sufficient                                                                                                                                                                          |

### Request-Period Authentication is Not a Second Model Selector

`accountProviderRequestAuthService.ts` / `accountProviderConnectionResolver.ts:253` obtains current credentials by static access family/mode; mode mismatches reject, do not change personal Providers to Team Providers at the request layer. API Key/JWT/one-time security verification materials are not static Model Configs.

Freezing here is **Provider/Model/static request configs and this execution selections**, not forever-frozen OAuth Tokens. Current code allows compatible family/mode request materials to update per-request (including current Team scopes); this differs from the stronger semantics of "the same Model forever bound to the original account." This item does not autonomously add old account/team locks, nor put Tokens in through complete snapshots. Off-Peak has separate Ticket binding rules, cannot generalize ordinary request behavior to it.

## 6. Temporary Sync: Fix Correctness, Do Not Build a Second Platform

### Timing, Frequency, and Lifecycle

| Item                           | Current Facts                                                                                                                               | Judgment                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream invalidation triggers | Family/connection/endpoint setting changes, config source changes; login/logout/purchasing business explicit refreshes                      | Event-driven; Account reads usually read caches, not querying remotes each time                                                                                      |
| Hot pushes                     | Traverse `activeClientsByWorkspaceKey` after Account changes                                                                                | Normal Workers here; not full-process broadcasts                                                                                                                     |
| On-demand checks               | Create/recover sessions, partial reads/subscriptions, generateText, connection testing, and startup readiness etc.                          | Already share one sync helper, not each location writing separate network syncs; but strategy entries are scattered                                                  |
| Normal V4 sends                | Synchronous checks at createSession branches, not forcibly syncing Desktop→SSH on every normal sendText                                     | Retain adjudicated no-global-send barriers                                                                                                                           |
| Deduplication                  | Each Client WeakMap saves confirmed revisions; same-value skips                                                                             | Can continue after data completeness/ACK correctness; revision is content identity, not comparable old/new numbers                                                   |
| Serialization                  | Per-Client Promise queues, failures do not poison next tasks                                                                                | Exists, no need to stack queues again; snapshots read before enqueuing, cannot only claim order-discard functionality through revision strings                       |
| Worker reconstruction          | Confirmation caches keyed by Client objects, new objects do not inherit old confirmations; WeakMaps do not form permanent strong references | Should not additionally create permanent workspace confirmation tables                                                                                               |
| Wiki Workers                   | Independent process managers; already wired Host handlers; not on normal active map hot pushes, checks before generateText                  | Not "completely unsynced." Allows old complete snapshots; if future internal autonomous new work is initiated, needs to clearly define initialization/refresh scopes |
| Plugin/MCP-dedicated Workers   | Dedicated managers, mainly doing plugin/MCP management                                                                                      | Do not force pure-read capabilities to wait for account readiness for "uniformity"                                                                                   |

Minimum convergence recommendations: retain existing sync helpers/queues, clarify needed facts in model execution Worker initialization/usage contracts; fix P100-01/P100-02. Do not pursue eliminating all ensure calls this round, nor add account checks to every unrelated RPC. Future transport deletions should not modify effective selection algorithms or business save semantics.

## 7. Mid-States: Levels Truly Needing Unification

```text
Source reads / Account queries (can be async, can fail)
             |
             v
Same-scope complete Account results
             |
             v
Registry checks source matching -> publishes complete applied snapshot
             |
       +-----+----------------+
       v                      v
Settings/candidates/effective selection    Transfer application confirmations
Read this result                           Confirm actual application results
```

"Global consistency" should not be understood as all processes simultaneously switching to B. Old complete As can continue serving; new combinations that are not self-consistent should not be published.

Registry has been confirmed to have this layer of protection; Facades also correctly consume. **Account async upstream not inherently self-consistent cannot yet be proven**: settings read at query start, identities and API materials obtained asynchronously later; AccountServices serially refresh, but unlike Registries, do not discard expired queries by update generations on each return. This round has not reproduced "old selections + new identities/responses" mixed states with real account switches.

This should be listed as targeted production-side race risk R100-01, not claiming "everything is broken globally." Minimum subsequent validation is using controllable-delayed identity/entitlement ports, switching connections or accounts during queries, observing whether published scopes, currents, models, and LKGs belong to the same round. If not成立, fix production-side scope capture/expiration result publishing, not adding timeouts individually in UIs.

R100-02: synchronized snapshots read before queuing, channels only recognize same-values, not orderings. Currently Account reads are cached snapshots, Client requests serially; this round did not reproduce reverse-order applications. Do not introduce second global version clocks for assumed risks. Subsequent validation through delayed read/reconnect scenarios is sufficient.

## 8. What Reconstruction Should Look Like

The target is not to make each business "know how to sync," but to let each business only explain what input they provide:

```text
Saved configs / current drafts              Already-fixed Selections / Active Models / Tickets
        |                                        |
        v                                        |  Used as-is
Public Selection read entries                   |
  = Same applied snapshot + original intents     |
        |                                        |
        v                                        |
effectiveSelection + issues + Views               |
        |                                        |
        +--------------> New dispatch boundaries <-------------
                              |
                              v
                       Precise ModelFactory
                       Fix this model
                              |
                       Request-period legal authentication
```

Suggested responsibilities:

- `packages/provider`: continues to own Account orchestration abstractions, Registry applied snapshots, pure effective selection rules. Does not import Hosts/networks/files, nor save business selections.
- Environment assembly layers: provide config sources, Account fact sources, and identity classifiers; Hosts and managed Workers assemble the same selection capabilities. Temporary transports are just one adapter for Account sources.
- Core: resolves **explicit new intents** through dependency ports; dependencies pass from parent runtimes to children. Should not depend on specific services Runtimes, nor RPC reverse for each resolution.
- UIs: continue public Hooks, do not copy account correspondences/refreshes/expired response handling.
- Bots/Automations/Wikis: each own intents and execution records; return public rule values, businesses use at established new dispatch points. Do not make getView an operation that scans and rewrites task files.
- Factories/adapters: precise executions, no secret fallbacks, no re-selecting models on each HTTP retry.

Input types prioritize clear functions/ports and existing execution scopes, not urgently adding generic "large context objects" or rebuilding state frameworks. Whether to move Account services to another process in the future is a deployment decision, not a prerequisite for pure resolution algorithms.

## 9. Fix Suggestion Order and Pending Rulings

This section is investigation suggestions, not authorized implementations:

1. **Set minimal state closure together**: P100-01 complete facts + P100-02 real application confirmations. Cover only current changes, Builtin mismatches, new Clients, post-failure retries; do not replace cross-end Registry result comparisons with optional field successful round-trips.
2. **Connect complete public consumption chains**: P100-03 explicit Subagent real model calls and all child assemblies; failed original tiers/non-same-models must report results per public rules, cannot inherit parent models to cover failures.
3. **Fix dispatch losses and verify new rounds**: P100-05 attachment protocol transmission; P100-04 Bot idle new inputs. Strictly maintain already-fixed runs, busy admissions, Tickets, do not rewrite accepted inputs.
4. **Supplement production-side race evidence**: R100-01 delayed query scopes; check whether identity changes and Config refreshes can publish mixed results. If成立, fix upstream, retain existing Registry/Hook protections.
5. **Only then do necessary structural simplifications**: Public Facade assemblies, Worker execution capability initializations; do not make thorough temporary sync unification completion prerequisites.

Product boundaries needing discussion concentrate on: Bot busy/queue inputs and independent titles, manual Compacts, Dreams' "new work" and "inherit current work" boundaries. Implicit children, intra-run Compacts/Extractions, fixed Wiki runs, Off-Peak need no re-rulings.

Independent CLI complete account services, deleting temporary syncs, full-end instant consistency, persisted structure re-dos are all outside this round's minimal fix targets.

## 10. Verifications, Paused Experiments, and Coverage Limitations

### Executed This Round

- Workspace freshness checks passed; baseline pinned at `86bbe157c8`.
- Read-only tracked the above entry points, Host/Worker assemblies, protocols, request authentication, and model factories; did not modify product files.
- Existing Registry/Resolver unit tests **2 files, 21 passing**.
- Existing Facade/AccountService/Account resolution unit tests **3 files, 31 passing**.
- P100-02 pure memory reproduction; no real requests, account credentials, or user data.
- First group commands included non-existent `effective-model-selection.test.ts` path; Vitest actually only ran two files. Subsequent runs included `facades.test.ts` with related behaviors; recorded actual files/cases here, do not claim non-existent tests passed.

These 52 verify existing public mechanisms, not proving transmission end-to-end or product gaps fixed. Test files and tested Provider cores not modified this round.

### Re-review of Todo99 Paused Experiments

Workspace trial modifications added states transmission, shared Facade assemblies, Core optional resolution ports, and explicit Subagent helpers. Directions cover parts of P100-01/P100-03, but:

- Did not fix P100-02 ACK; cannot claim complete snapshots are end-to-end applied.
- Optional states' strictness/missing semantics not formed complete contracts.
- Did not cover P100-04/P100-05 and auxiliary consumer boundaries.
- Mock helper successes do not equal real children emitting correct requests; workflows, implicit inheritance, overrides need joint proofs.
- Previous bootstrap tests had old fixture schemas/incomplete config failures, partial type builds also had dependency artifact freshness issues; this round did not continue fixing these failures, nor announced experiments submittable.

Therefore continue paused, neither auto-adopting nor auto-rolling back; retain necessary parts from rulings later. Experiment tests and product modifications cannot be mixed into this "pure investigation complete."

### Not Executed and Subsequent Acceptance Requirements

- No real multi-plan/account switches, real SSH machines, phone attachments, Bot attachments and multiple rounds, real Subagent network request verifications performed.
- R100-01/R100-02 not proven to appear in production; cannot list them as reproduced incidents.
- After implementations, verify actual Provider/Model/tiers and execution scopes of requests, not just UI texts/Schema receptions; in-flight switches cannot change old Models, next explicit new works should correspond.
- This round is docs-only; no full-warehouse typecheck/lint or E2E historical results should back paused experiments; above unit tests only serve as investigation evidence.

## 11. Impact Mapping / Graph Rewriting Suggestions

Uses feature-boundary-planner's impact-only paths; this round's users explicitly requested Todos and investigation reports, did not generate implementation matrices or directly modify feature graphs. codegraph tools unavailable, using functional graph seeds + targeted file/call searches, not claiming completed full-warehouse automatic reference graph audits.

Main nodes: AccountProviderService → ProviderRegistryService → ModelSelectionFacade → UI Hooks/backend new dispatches/implicit children → ModelFactory; temporary Account transports are source edges, not effective selection rule owners.

Graph facts needing updates by subsequent real implementations:

- Old "explicit Subagents must extend Host parsing RPCs" is not a necessary constraint; pure Facades can reuse Workers' local application snapshots.
- "Bots already connected to public resolution" should be split into drafts/initial creation and existing task subsequent messages; cannot represent full coverage with the former.
- "Workers already share Resolvers" cannot infer Account states equally complete; transmission gaps should be marked separately.
- "Sync success" needs to distinguish source reception and Registry applications; existing applied snapshots can serve as evidence sources.

Investigation completion only indicates this round's itemized conclusions and traceable evidence exist, not that the system has no other Bugs, nor authorizes automatic Todo99 recoveries.
