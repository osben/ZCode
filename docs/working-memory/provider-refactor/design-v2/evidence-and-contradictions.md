# Provider Refactor Evidence and Contradiction Audit

> Status: Under active maintenance
> Purpose: Explain where the current design comes from, record where old materials conflict with current facts; this is not a second design.

## 1. Audit Methodology

This audit checks simultaneously:

- Commits and file differences between the current branch and `origin/staging`;
- `design`, `steps`, `plan`, `research`, Bugfix, and implementation records under `docs/working-memory/provider-refactor`;
- Current `@zcode/provider`, `@zcode/provider-node`, Services, UI, CLI Bootstrap, Adapter, and Built-in Config;
- Tests directly related to Provider core behavior;
- Todo 32's design, implementation commits, and verification records.

When ruling, distinguish between:

| Category            | Question answered                                           |
| ------------------- | ----------------------------------------------------------- |
| Target fact         | What the latest ruling requires the system to ultimately do |
| Implementation fact | How current code and tests currently behave                 |
| Historical evidence | Why a particular design appeared and when it was superseded |
| Unfinished items    | Ruled but incomplete, or work still awaiting discussion     |

Do not grant an old document higher authority simply because it is detailed, and do not elevate a current code's accidental branch into design.

## 2. Branch and Difference Facts

This document uses implementation baseline `e01862000f`:

- The merge-base between current HEAD and `origin/staging` is `65fb4532d347194095cca8848e768f0fdbb28939`;
- This implementation baseline has 238 unique commits relative to staging, and staging has 236 unique commits;
- The full-repo difference for `origin/staging...HEAD` covers approximately 1,271 files, including substantial parallel product evolution; the full diff cannot be equated with Provider Refactor alone;
- The Provider core is the new `packages/provider`, `packages/provider-node`, and `config/provider/zcode-builtin.json` added by this branch. Staging still primarily uses the legacy Model Provider Service, which has been retired by this branch;
- The current Built-in content shell is `schemaVersion + revision + config`, with 21 Providers and 120 Model Rules at the content layer;
- Todo 32 was completed by commit `e01862000f`, and the related UI, i18n, tests, and Design results are included in this audit.

Therefore, staging-unique commits must extract product invariants item by item; old implementations must not be mechanically cherry-picked.

### 2.1 Staging-Unique Provider Fix Rulings

| staging commit                                                                       | The valid issue it proves                                                                                    | Ruling for V2                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1ccf6f906e fix(model-provider): honor selected Start Plan runtime`                  | When the same Family has both Start and Coding Plan, the user's explicit selection must enter real execution | Product invariant is valid; the old `modelProviderService` fix must not be ported. The new architecture should have Account Connection Resolver set unselected Providers to `unavailable`, and enable only the selected Provider through Account Overlay |
| `b89263389e fix(model-provider): decouple start plan selection`                      | Plan selection, Family navigation, and model candidates should not be incorrectly inferred from each other   | Issue is valid; assigned to Account Connection, Settings View, and independent plan projection. Do not restore the old family runtime filter                                                                                                             |
| `198a013a95 fix(model-provider): avoid boundary token budget in connectivity probes` | Connectivity probes using extremely small token boundary values cause false failures                         | Connection test product behavior is valid, but the old connectivity helper has been deleted; must be independently checked in the formal ModelFactory/Adapter test chain, do not restore the old service                                                 |
| `08862385c3 fix(ui): clarify pending start plan entitlements`                        | pending, unknown, unavailable must not be conflated as "unassigned"                                          | State semantics are valid; Todo 32 further specifies that plan state cannot determine whether an Effective Provider/model config area exists                                                                                                             |

Current `AccountProviderConnectionResolver` resolves only the selected mode as `available` based on explicit Family selection;
`resolveAccountProviderConfigs` then projects it to `access.entitled`, and Start Plan additionally projects account model sets. This landing point supersedes the old Registry
dispatch filter.

## 3. Major Code Evidence for Current Facts

| Design fact                                                     | Main implementation evidence                                                      | Main test evidence                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Provider Schema and Access union types                          | `packages/provider/src/config/provider-config.ts`, `config/schema.ts`             | `packages/provider/test/provider-config-kinds.test.ts`              |
| Model Schema, nested formats, and Rule ordering                 | `packages/provider/src/config/model-config.ts`                                    | `model-config-rules.test.ts`, `todo21-source-contracts.test.ts`     |
| Built-in -> Account -> Personal                                 | `packages/provider/src/resolver.ts`                                               | `resolver.test.ts`, `todo21-resolution.test.ts`                     |
| Settings candidates and Registry executable sets share a source | `resolver.ts`, `facades.ts`                                                       | `facades.test.ts`, `registry.test.ts`                               |
| Account only projects entitlement and Start models              | `account-provider-resolution.ts`, Services `accountProviderConnectionResolver.ts` | `account-provider-resolution.test.ts`, Services corresponding tests |
| Built-in / Account revision atomic pairing                      | `registry-service.ts`, `account-provider-service.ts`                              | `registry-service.test.ts`, `account-provider-service.test.ts`      |
| Personal persistence, remote Built-in, and LKG                  | `packages/provider-node/src/*`                                                    | `provider-node-runtime.test.ts`, `zcode-builtin-release.test.ts`    |
| ModelFactory fixed complete execution facts                     | `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts`    | Bootstrap, Core, Adapter Provider targeted tests                    |
| Active Model uses the same structure properties                 | CLI Contracts Model and Adapter/Core consumption chain                            | Model input/output, media, Compact/Subagent targeted tests          |
| Settings page reads/writes through Facade                       | `packages/provider/src/facades.ts`, UI `useProviderSettingsView.ts`               | Provider settings / coding plan UI tests                            |
| Built-in formal content                                         | `config/provider/zcode-builtin.json`                                              | `packages/provider-node/test/zcode-builtin-integrity.test.ts`       |

## 4. Contradiction Statements and Rulings

### C01. `Official Config` vs. `ZCode Built-in Config`

**Historical statement**: M2/M3 early materials and implementation logs heavily used `Official Config`.
**Subsequent ruling**: Todo 10 explicitly performed a one-time name switch, with no alias retained.
**Current fact**: Types and files all use `zcodeBuiltin*` / `zcode-builtin.json`.
**Ruling**: The current names are only `ZCode Built-in Provider Config` and `ZCode Built-in Model Config Rules`.
Old names serve as historical references only.

### C02. Is `Config Document` a domain concept?

**Historical statement**: Early Provider Domain exposed `ProviderConfigDocument`, `ModelSelectionConfigDocument`.
**Subsequent ruling**: User explicitly required removing the document concept from design; Todo 06 moved version shell and migration back to Repository.
**Current fact**: Domain only processes Config/Rules/Snapshot; `schemaVersion/revision` belongs to codec, repository, or remote publishing shell.
**Ruling**: No Config Document domain intermediate state exists. Physical files can still have a storage shell.

### C03. Provider Overlay ordering

**Historical conflict**: Early diagrams wrote Personal and Account order backwards, or treated Account as final override.
**Explicit ruling**: `ZCode Built-in -> Account -> Personal`, with Personal last.
**Current fact**: `ProviderConfigResolver` first obtains `effectiveBuiltinProviders`, then Overlays Personal.
**Ruling**: The current ordering is fixed; Account's role is to constrain Built-in account Providers; the Renderer no longer applies it additionally.

### C04. Model Rules: override or concatenate?

**Historical conflict**: Some materials treated Personal Model Config as a single replacement.
**Explicit ruling**: Built-in and Personal are array concatenation, with Personal last.
**Current fact**: `composeEffective()` preserves Built-in order, placing Personal exact rules last.
**Ruling**: Ordered overlay; Personal only allows exact `providerId + modelId`, with the highest priority.

### C05. Does Account Config own `accessId/productId/team scope`?

**Historical statement**: Research, Todo 07, Todo 20, and early architecture reviews once treated `accessId` as a fixed Config or Model field, and discussed product/team scope together.
**Subsequent ruling**: Todo 24 deleted `accessId`; Todo 26 deleted static `planKind` and pseudo-generic protocol fields.
**Current fact**: Account Provider Config Schema only allows `access.entitled` and `builtinModelIds`. Account protocols, Subscription, Usage,
Request Auth still legitimately contain `planKind/productId/organizationId/projectId`.
**Ruling**: These fields may belong to account/plan/request context, but must not flow back into Provider Config, Registry Model static facts, or Selection.

### C06. Should Account influence Config?

**Historical swing**: Discussions once leaned toward "no account facts should relate to Config." After multi-party confirmation, it was explicitly stated that Start Plan models vary by account,
and account Provider entitlements must participate in final resolution.
**Current fact**: Account is the formal third-layer Provider Overlay; it only projects `access.entitled` and the
`builtinModelIds` explicitly returned by the account interface.
**Ruling**: Account must influence Effective Provider, but cannot be the source of static Model Properties, Endpoints, or dynamic credentials.

### C07. Do only Start Plans return model sets?

**Historical question**: Early assumption was that all account plans might return models, or that `show_name` would degrade back to Model ID.
**Current fact**: Account Resolver only consumes the `models` explicitly returned by the account interface; when there is no dynamic member set, it falls back to Built-in.
Individual/Team/Start plan eligibility is uniformly written to `access.entitled`, without modifying the top-level `enabled`.
Start Plan resolution only accepts upstream-explicit model facts; display text must not become Registry identity.
**Ruling**: Account model subsets are a Start Plan special case, not generalized as a universal dynamic member protocol for all Account Providers.

### C08. Access types: `request-auth`, `execution-provided`, or account-specific types?

**Historical evolution**: M4 used `request-auth`; Todo 24 changed it to generic `execution-provided` and added request protocol fields; the user subsequently considered it overly
generalized. Todo 26 explicitly supersedes Todo 24.
**Current fact**: Formal Access types are only `api-key` and `zhipu-account`; Off-Peak is `zhipu-account + mode=off-peak`.
**Ruling**: The old two Access types and `challenge/requestSigning/executionProtocol` are all retired intermediate designs.

### C09. `family member`, `plan kind`, `group`, `mode`

**Historical conflict**: Discussions once tried to retain both family member and plan kind, or derive access methods from Provider groups.
**Current fact**: `group` handles static product grouping; `zhipu-account.family` handles Z.ai/BigModel; `mode` handles API Key, Start,
Individual, Team, Off-Peak.
**Ruling**: The three are orthogonal and cannot be derived from each other; account runtime protocols may continue to use their own `planKind` naming.

### C10. Do both Provider and Model have visibility?

**Historical statement**: Todo 03 once decided that Provider/Model symmetrically possess visibility; old `registry.md` also retains "Provider/Model
Visibility" phrasing.
**Subsequent ruling**: Todo 21 explicitly deleted Model visibility, confirmed by the user again.
**Current fact**: Schema only has Provider `visibility`; Model `selectable` is computed from execution eligibility and Provider visibility.
**Ruling**: Model has no independent visibility. The old symmetric design is invalid.

### C11. `executionOnly` vs. "trusted execution"

**Historical statement**: Pre-M4, `executionOnly` simultaneously expressed hiding, internal execution, and integrity exemption, with trusted lookup discussed.
**Explicit ruling**: User required it to be generic visibility only, unbound from "trusted"; Provider Config layer does not restrict whether users can access through other interfaces.
**Current fact**: `visibility=hidden` only affects the normal View; Registry exact lookup can still execute, but integrity requirements are not relaxed.
**Ruling**: Delete `executionOnly` and trusted concept; internal product entries use fixed Provider ID for exact selection.

### C12. Enabled, integrity, Executable, Selectable

**Historical confusion**: Old services commonly used a single `enabled` or availability to simultaneously handle configuration completeness, account usability, selection visibility, and execution eligibility.
**Current fact**: Resolver stores `enabled`, issues, `executable`, `selectable` separately; Settings retains incomplete items, Registry only accepts
executable items.
**Ruling**: Four facts are orthogonal. Incomplete configuration can be saved but not used; account plan state cannot erase Provider configuration from the settings page.

### C13. Built-in and Personal model name collisions

**Historical statement**: Once written as "colliding models fully isolated."
**Explicit ruling**: User required that Built-in models still run when names collide with custom ones.
**Current fact**: Resolver deduplicates Built-in first, then discards Personal members that collide with Built-in.
**Ruling**: Built-in wins; collisions do not cripple the Provider, nor allow Personal identity to override Built-in.

### C14. Reasoning Compatibility and hardcoded specific models

**Historical statement**: `magic_name`, ox-alpha, GLM special cases, `adapterCompatibility`, `reasoningReplay`, etc. existed or were proposed into configuration.
**Explicit ruling**: All production old code that "identifies reasoning intensity by specific model" exits; `reasoningReplay` and Compatibility fully deleted.
**Current fact**: Logic tiers are declared by `optionSpecs.reasoningLevel`; protocol fields are directly projected from that Option's restricted CEL `map(value)` into the final raw Request Body; formal Schema rejects old `reasoningMapping` fields.
**Ruling**: Specific model differences are written as declarative Model Rules; Runtime/Adapter does not patch by Model ID.

### C15. Input and output formats

**Historical evolution**: `modalities: { input: string[], output: string[] }`, then flattened `supportsImages/Pdf/Video` appeared, final ruling became
nested snake_case properties.
**Current fact**: Config, Registry, Protocol, and Model uniformly use `properties.input_format/output_format`; PDF/Audio enter static facts,
PDF continues gating, Audio has no content encoding entry yet.
**Ruling**: Old fields may only appear in one-time importer/historical test inputs, not as formal facts.

### C16. Model intermediate states: ModelRef, ConnectionPort, Capability DTO

**Historical statement**: Old CLI design and trajectory documents still heavily describe `ModelRef`, `ModelConnectionPort`, Catalog capability.
**Subsequent ruling**: Todo 01, 02, 04, 05, 08, 14, 16 completed retirement.
**Current fact**: The public execution object is an immutable Model, created by Factory from the formal Registry; media and option reads use the Model's own structure.
**Ruling**: Old CLI design/trajectory can only explain history, not serve as Provider Refactor current interface basis.

### C17. Should `Document`, Snapshot, Envelope all be deleted?

**Historical misunderstanding**: Deleting the Document concept was sometimes extended into "no snapshots or versions at all."
**Current fact**: The domain needs read-only Config Snapshot and Registry Snapshot to guarantee atomic publishing; Repository/remote sync needs version shells.
They have not re-emerged as editable Config DTOs.
**Ruling**: What was deleted is the redundant domain intermediate state, not the immutable snapshots and physical version information required for atomicity.

### C18. Does Registry refresh need a revision handshake?

**Historical proposal**: Once suggested that Host sends revision to Agent after saving and waits for observed revision. User considered it overly abstract, preferring Host to test directly.
**Current implementation**: Source/Registry in each Environment reads configuration independently; connection tests go through the formal Host Registry/ModelFactory; Worker watcher
has failure self-healing; Built-in and Account revisions are atomically paired in Registry Service.
**Ruling**: Do not introduce cross-process Registry Snapshot or universal revision handshake. Execution entries must wait for the formal refresh result of their own Environment.

### C19. Does the settings page read Account Overlay?

**Historical statement**: Some UI designs concatenated Account Overlay, plan cards, and Provider configuration directly in the Renderer, even letting entitlement state control the model area.
**Explicit ruling**: Settings page only reads the final Provider Settings View; plan state is independently projected.
**Implementation result**: Todo 32 was completed in `e01862000f`. Team / Individual details resolve exactly from Provider Settings View by `providerId`;
plan state no longer controls whether the config area and model list exist; `not-allocated` and `credential-unavailable` have become explicit page states.
**Ruling**: This boundary has entered current facts; plan projection can no longer retroactively become Provider configuration authority.

### C20. Should Endpoint/API Schema be displayed on the Account page?

**Historical conflict**: General settings design requires Built-in Endpoint/Schema to be visible but read-only; Todo 32's latest ruling specifies Individual/Team Coding Plan
pages hide them.
**Ruling**: General Built-in still displays read-only connection facts; Individual/Team are product-display exceptions. Fields were never deleted from Effective Config; Runtime
continues using them.

### C21. Settings feedback location

**Historical conflict**: Old `settings.md` once wrote global Toast at the page/viewport bottom; subsequent real-machine feedback explicitly required it located at the right-side Provider details column bottom,
using banner style, with new states replacing old ones.
**Current fact**: Recent Bugfix/Todo has already converged feedback to the details column.
**Ruling**: Core design uses the Provider details column bottom banner; this is only interaction projection, not changing configuration authority.

### C22. `modelContextBudget.strategy` and so-called Official Runtime Config

**Historical discussion**: Once attempted to include all fields from remote `/client/configs` into Provider Config, or create a new Official Runtime Config.
**Explicit ruling**: This field belongs to Agent parameters/product canary, unrelated to model static configuration. No changes this round, no new config domain created.
**Ruling**: Not part of Provider Refactor.

### C23. Remote Provisioning

**Historical plan**: Some consolidation plans listed local-to-remote sync, remote editing, and login as incomplete items of the Provider refactor.
**Explicit ruling**: Remote Provisioning is an independent product capability, not part of this refactor.
**Ruling**: Provider only specifies that each execution Environment has its own fact source; it does not define in this design how configuration is distributed across Environments.

### C24. Who is responsible for Built-in integrity?

**Historical dispute**: Todo 18/19 discussed large-scale "static integrity" gates on the client side; the user considered rules hard to maintain and potentially the publisher's responsibility.
**Explicit ruling**: Do not expand integrity validation for now; Todo 19's historical discussion is obsolete; if needed in the future, establish a new publishing gate task separately.
**Current fact**: Schema, Resolver, and existing Built-in integrity test protect the current executable contract; no new remote publisher workflow added.
**Ruling**: Existing runtime integrity continues; stronger publishing gates must not be written as current design without prior discussion.

### C25. Start independent Provider vs. current single-connection semantics

**Conflicting old statement**: Start/Individual/Team share a single current, Start selection maps with the current plan. Discussions also proposed virtual unified entry, cross-brand mapping, full migration, upgrade connection snapshots, multi-Provider global invalidation notices, and additional auth race condition checks. These candidates cannot serve as final contracts.

**Subsequent user ruling (2026-09-16)**: Retain two Start IDs, unified name, and respective brand logos; place under existing ZhiPu grouping; details remove only connect/disconnect. Retain current, allow Start and current paid connection to coexist; Start resolves strictly by original identity, paid connections maintain mapping; JWT reused from login, account race conditions follow current state. User explicitly stated "no migration, add an optimization": only recommend quota-bearing and reasoning-compatible same-model Start when user submits/saves; including Subagent explicit model saves; ultimately exclude immediate run. Preferences apply across entries, restart, and same-Host mobile; no account cloud sync. On invalidation, retain quota feedback; global connection notifications only handle paid plans.

**Pre-implementation code/test facts**: current, public account mappings, and Start request auth originally had old connection constraints; settings navigation has connection side effects. Normal Session writes back its selection upon submission start; drafts write back after accepted; therefore "all old sessions persistently retain Start" is false. Automation only fixes run; explicit Subagent execution does not change long-term configuration; no migration does not mean old valid behavior remains unchanged. I27/MP-R03 actually injects Recent, asserting fallback Configured Default; the old matrix's Start→Team cannot prove normal Session needs migration. See [research](../research/todo154-start-plan-independence-impact.md).

**Final ruling**: Target enters Design V2 §4.5, full implementation boundaries belong to [Todo154](../steps/todo-154-start-plan-independent-provider.md). Retain existing data and resolve by new semantics; no new migration mechanism, no rewriting history, no secretly selecting paid models due to removed mappings. Withdraw the above expanded proposals. User subsequently authorized Todo154 execution on 2026-09-16 with comprehensive review; Todo101 remaining items deferred. Formal behavior synced to [Start specification](../../../zai-start-plan-provider.md).

**owner and completion criteria**: Todo154 is responsible for state/auth/model selection/navigation, submission recommendations, preferences, and invalidation feedback implementation and desktop/mobile/Worker regression. The 17 pre-implementation tests serve as historical evidence only. Independent current/JWT, Start exact identity resolution, independent navigation, and submission recommendations for four entry types are now implemented; no data migration added. Targeted unit tests, Pro admin SSH Electron live runs, and review results are uniformly recorded in Todo154 §8; narrow-screen simulations are not equated with physical phone verification.

### C26. Can approval dialog full-access modify permissions of an accepted queue?

**Old statement**: [Todo71](../steps/todo-71-persistent-composer-draft-and-submission-state.md) and [Todo151](../steps/todo-151-independent-plan-state-draft.md) require Submission to retain original configuration after queuing, not rewritten by drafts or approval results.

**Subsequent ruling (2026-09-17)**: User explicitly stated that only the approval dialog's new "full access" synchronizes the current task, Composer, and all queued messages to `mode=yolo`; individual `planEnabled` and other fields are retained. Normal Composer menu still only modifies drafts.

**Current fact**: The immediate switch command is still used by Bot, automation, and compatibility paths; `app.setMode()` also writes project permission preferences; passing only yolo disables Plan, and does not update queues or responses to existing approvals. The shared normalization function's Plan disablement has been reproduced with minimal execution; the approval's new behavior is unimplemented.

**Final ruling**: Add an explicit permission update exception for approval dialogs, without overturning model selection freeze, Plan independence, normal queue consumption, or draft ownership. Agent coordinates task permissions, all target queues, and current responses; client side synchronizes corresponding drafts; no project default write side effects inherited, no global modification of old request normalization semantics.

**Completion status**: Implemented per ruling; acceptance not yet fully consolidated; owner is [Todo158](../steps/todo-158-permission-dialog-full-access-and-queued-mode.md). SQLite, Runtime, broker, V4, and Composer regression evidence and baseline failures are in its Section 9; the phone shared-host full链路 remains unverified; pending cases are not treated as formal acceptance criteria.

## 5. Old Material Usage Tiers

### 5.1 Can serve as current design evidence

- Two-path architecture and core principles in `design/design.md` not corrected by this document;
- Current field contract of `design/registry/configuration.md`;
- `design/model/input-output-format.md`;
- `design/registry/model-membership-and-enablement.md`;
- Final rulings of Todo 21, 23, 26, 28, 29, 32;
- Current Schema, Resolver, Registry, ModelFactory, and tests.

### 5.2 Can only serve as historical implementation evidence

- M1–M4 implementation documents and implementation logs;
- Todo 00–10, 12–14, 16–18, 20, 24, 25, 27, 30, 31;
- Bugfix 01–06;
- Provider MR review, architecture conformance review;
- Research and dogfood records.

These documents can explain why an abstraction was deleted, but their stage-specific Schema cannot override subsequent rulings.

### 5.3 Explicitly superseded key materials

- Todo 03 Model visibility: superseded by Todo 21;
- M4, Todo 02, 07, 14, 15 `request-auth/accessId`: superseded by Todo 24/26;
- Todo 24 `execution-provided + executionProtocol`: superseded by Todo 26;
- Research `Official Config`, old flattened capabilities, and `accessId` drafts: superseded by Todo 10, input/output format design, and Todo 24/26;
- Old CLI v2 ModelRef/Capability documents: superseded by actual cleanup from Todo 00–16;
- Settings global bottom Toast: superseded by subsequent real-machine interaction rulings.

### 5.4 Cannot yet enter current facts

- Todo154 old candidates: virtual Provider, cross-brand mapping, full migration, and new auth barriers have been withdrawn; current implementation and verification are per Todo154 §8;
- Todo 11: Draft;
- Todo 11A: Awaiting execution;
- Todo 15: Obsolete, no longer an independent execution item;
- Todo 19: Obsolete, no longer an independent execution item;
- Todo 22: Draft;
- Research reports on not-yet-implemented Built-in model fact expansions;
- Manual E2E, real accounts, formal packages, and cross-platform verifications that are not yet complete.

## 6. Completion Evidence and Remaining Audit Items

### 6.1 Todo 32 Completion Evidence

Todo 32 was completed in commit `e01862000f`, with file status updated to "completed." Implementation records prove:

- Plan state no longer controls Provider/model config area existence;
- Team/Individual models come from Provider Settings View;
- Team models continue to support existing sorting, enable/disable, and Personal Model Config editing;
- Endpoint/API Schema hidden only in product UI, runtime configuration unchanged;
- loading, explicit unassigned, credential unavailable, and request failure no longer inferred from display text.

Its recorded verification results include 220 passing Provider UI targeted tests, 1470 full unit test files with 12480 passing tests, and root
`typecheck`, `lint`, format check, and `git diff --check` passing. This evidence shows the implementation has landed; real Team account and formal package
experience still belong to publishing verification, not retroactively changing design status.

### 6.2 Staging final integration

Currently significantly forked from staging. Before final merge, staging-unique Provider commits must be reviewed as "product invariant migration" rather than "old code retention," with key verification:

1. Start/Individual/Team/API Key explicit selection enters Account Overlay and real Model creation;
2. Connection tests do not produce false failures from extremely small output token budgets;
3. pending/unknown entitlements do not falsely report as unassigned;
4. staging's new business/UI features do not reintroduce old Provider Service, family runtime filter, capability DTO, or hardcoded specific models.

### 6.3 Publishing verification

Existing automation has demonstrated main domain contracts, but the following remain live verification rather than design gaps:

- Real API Key, Start, Individual, Team, Off-Peak requests;
- Built-in paths in Desktop/CLI formal artifacts;
- macOS, Windows, Linux, and historical Personal Config importer;
- Config updates, process restarts, and cold starts;
- Deferred manual E2E and container environment gates.

### 6.4 Non-Provider Config similar fields

The full repo may still contain terms like `planKind`, `productId`, `modalities`, `supportsImages`, `ModelRef`, etc. Do not equate strings with regressions:

- `planKind/productId` in account, Subscription, Usage protocols are legitimate business fields;
- `modalities` in legacy importer/test fixture is compatible input;
- `supportsImages` in Adapter local transformation helpers can be function parameters, but must not become a second Active Model capability authority;
- `ModelRef` in CLI historical design/trajectory is document residue, not a current production interface.

Mechanical zeroing must be limited to formal Provider Config, Registry, Model, and Runtime authoritative paths, avoiding erroneous deletion of legitimate concepts in other domains.

## 7. Future Maintenance Format

When adding new contradictions, append a `Cxx` item, clearly stating at minimum:

1. The conflicting old statement;
2. The subsequent explicit ruling;
3. The current code/test facts;
4. The final ruling;
5. If unfinished, mark the owner Todo and verification criteria.

Historical documents should not be retroactively rewritten "as if the final answer was known at the time." Preserving original trajectories while maintaining rulings in this document satisfies both current design clarity and historical audit credibility.
