# Provider Refactor Evidence and Contradiction Audit

> Status: Under active maintenance
> Purpose: Record where the current design comes from and where old materials conflict with current facts. This is not a second design.

## 1. Audit Methodology

The audit checks simultaneously:

- Commits and diffs between the current branch and `origin/staging`;
- `design`, `steps`, `plan`, `research`, Bugfix, and implementation records under `docs/working-memory/provider-refactor`;
- Current `@zcode/provider`, `@zcode/provider-node`, Services, UI, CLI Bootstrap, Adapter, and Built-in Config;
- Tests directly related to Provider core behavior;
- Todo 32's design, implementation commits, and verification records.

Rulings distinguish:

| Category            | Question answered                                           |
| ------------------- | ----------------------------------------------------------- |
| Target fact         | What the latest ruling requires the system to ultimately do |
| Implementation fact | How current code and tests currently behave                 |
| Historical evidence | Why a design appeared and when it was superseded            |
| Unfinished items    | Ruled but incomplete, or work still awaiting discussion     |

Do not grant an old document higher authority because it is detailed, and do not elevate a current code's
accidental branch into design.

## 2. Branch and Difference Facts

Implementation baseline for this document: `e01862000f`.

- Merge-base of current HEAD and `origin/staging` is `65fb4532d347194095cca8848e768f0fdbb28939`;
- this baseline has 238 unique commits relative to staging; staging has 236;
- the full-repo difference for `origin/staging...HEAD` covers ~1,271 files including substantial parallel
  product evolution — the full diff is not Provider Refactor alone;
- the Provider core is the new `packages/provider`, `packages/provider-node`, and
  `config/provider/zcode-builtin.json` added by this branch; staging still primarily uses the legacy Model
  Provider Service, retired by this branch;
- the current Built-in content shell is `schemaVersion + revision + config`, with 21 Providers and 120 Model
  Rules at the content layer;
- Todo 32 completed in `e01862000f`; its UI, i18n, tests, and design results are included in this audit.

Staging-unique commits must therefore be extracted item by item as product invariants; old implementations
must not be mechanically cherry-picked.

### 2.1 Staging-Unique Provider Fix Rulings

| staging commit                                                                       | Valid issue it proves                                                                                  | Ruling for V2                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1ccf6f906e fix(model-provider): honor selected Start Plan runtime`                  | With Start and Coding Plan in the same Family, the user's explicit selection must enter real execution | Product invariant valid; the old `modelProviderService` fix is not ported. The new architecture has the Account Connection Resolver set unselected Providers to `unavailable` and enable only the selected Provider via Account Overlay |
| `b89263389e fix(model-provider): decouple start plan selection`                      | Plan selection, Family navigation, and model candidates must not be inferred from each other           | Issue valid; assigned to Account Connection, Settings View, and independent plan projection. The old family runtime filter is not restored                                                                                              |
| `198a013a95 fix(model-provider): avoid boundary token budget in connectivity probes` | Connectivity probes with extremely small token boundary values cause false failures                    | Product behavior valid; the old connectivity helper is deleted; behavior is independently checked in the formal ModelFactory/Adapter test chain. Do not restore the old service                                                         |
| `08862385c3 fix(ui): clarify pending start plan entitlements`                        | pending, unknown, unavailable must not be conflated as "unassigned"                                    | State semantics valid; Todo 32 further rules that plan state cannot determine whether an Effective Provider/model config area exists                                                                                                    |

Current `AccountProviderConnectionResolver` resolves only the selected mode as `available` from the explicit
Family selection; `resolveAccountProviderConfigs` projects it to `access.entitled`, and Start Plan
additionally projects account model sets. This landing point supersedes the old Registry dispatch filter.

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

Early M2/M3 materials and logs used `Official Config`; Todo 10 performed a one-time name switch with no alias
retained. Types and files now use `zcodeBuiltin*` / `zcode-builtin.json`. Current names are only `ZCode
Built-in Provider Config` and `ZCode Built-in Model Config Rules`; old names are historical references only.

### C02. Is `Config Document` a domain concept?

Early Provider Domain exposed `ProviderConfigDocument`, `ModelSelectionConfigDocument`. The user required
removing the document concept; Todo 06 moved the version shell and migration back to the Repository. The
domain now processes only Config/Rules/Snapshot; `schemaVersion/revision` belongs to codec, repository, or
remote publishing shells. No Config Document domain intermediate state exists; physical files may still have
a storage shell.

### C03. Provider Overlay ordering

Early diagrams wrote Personal and Account order backwards or treated Account as the final override. Explicit
ruling: `ZCode Built-in -> Account -> Personal`, Personal last. `ProviderConfigResolver` first obtains
`effectiveBuiltinProviders`, then Overlays Personal. The order is fixed; Account only constrains Built-in
account Providers; the Renderer no longer applies it additionally.

### C04. Model Rules: override or concatenate?

Some materials treated Personal Model Config as a single replacement. Ruling: Built-in and Personal are
array concatenation, Personal last. `composeEffective()` preserves Built-in order, placing Personal exact
rules last. Ordered overlay; Personal allows only exact `providerId + modelId`, with the highest priority.

### C05. Does Account Config own `accessId/productId/team scope`?

Research, Todo 07, Todo 20, and early reviews once treated `accessId` as a fixed Config or Model field. Todo
24 deleted `accessId`; Todo 26 deleted static `planKind` and pseudo-generic protocol fields. Account Provider
Config Schema allows only `access.entitled` and `builtinModelIds`. Account protocols, Subscription, Usage,
and Request Auth legitimately contain `planKind/productId/organizationId/projectId` — they may belong to
account/plan/request context but must not flow back into Provider Config, Registry Model static facts, or
Selection.

### C06. Should Account influence Config?

Discussions once leaned toward "no account facts relate to Config"; it was then explicitly stated that Start
Plan models vary by account and account Provider entitlements participate in final resolution. Account is the
formal third-layer Provider Overlay; it projects only `access.entitled` and the `builtinModelIds` explicitly
returned by the account interface. Account must influence Effective Provider but is never the source of
static Model Properties, Endpoints, or dynamic credentials.

### C07. Do only Start Plans return model sets?

Early assumption: all account plans might return models, or `show_name` would degrade to a Model ID. Current:
the Account Resolver consumes only the `models` explicitly returned by the account interface; without a
dynamic member set it falls back to Built-in. Individual/Team/Start eligibility is uniformly written to
`access.entitled`, not to a top-level `enabled`. Start Plan resolution accepts only upstream-explicit model
facts; display text never becomes Registry identity. Account model subsets are a Start Plan special case, not
a universal dynamic member protocol for all Account Providers.

### C08. Access types: `request-auth`, `execution-provided`, or account-specific types?

M4 used `request-auth`; Todo 24 changed it to generic `execution-provided` plus request protocol fields; the
user considered that over-generalized and Todo 26 supersedes Todo 24. Formal Access types are only `api-key`
and `zhipu-account`; Off-Peak is `zhipu-account + mode=off-peak`. The old Access types and
`challenge/requestSigning/executionProtocol` are retired intermediate designs.

### C09. `family member`, `plan kind`, `group`, `mode`

Discussions once tried to retain both family member and plan kind, or derive access methods from groups.
Current: `group` handles static product grouping; `zhipu-account.family` handles Z.ai/BigModel; `mode`
handles API Key, Start, Individual, Team, Off-Peak. The three are orthogonal and non-derivable; account
runtime protocols may keep their own `planKind` naming.

### C10. Do both Provider and Model have visibility?

Todo 03 once decided Provider/Model symmetrically possess visibility; old `registry.md` retains that phrasing.
Todo 21 explicitly deleted Model visibility, user-confirmed. The Schema has only Provider `visibility`; Model
`selectable` is computed from execution eligibility and Provider visibility. Model has no independent
visibility; the old symmetric design is invalid.

### C11. `executionOnly` vs. "trusted execution"

Pre-M4, `executionOnly` expressed hiding, internal execution, and integrity exemption simultaneously, with
trusted lookup discussed. The user required generic visibility only, unbound from "trusted"; the Provider
Config layer does not restrict access through other interfaces. `visibility=hidden` only affects the normal
View; Registry exact lookup can still execute, and integrity requirements are not relaxed. `executionOnly`
and the trusted concept are deleted; internal product entries use fixed Provider IDs for exact selection.

### C12. Enabled, integrity, Executable, Selectable

Old services commonly used a single `enabled` or availability for configuration completeness, account
usability, selection visibility, and execution eligibility at once. The Resolver stores `enabled`, issues,
`executable`, `selectable` separately; Settings retains incomplete items; the Registry accepts only executable
items. The four facts are orthogonal: incomplete configuration can be saved but not used; account plan state
cannot erase Provider configuration from the settings page.

### C13. Built-in and Personal model name collisions

Once written as "colliding models fully isolated." The user required Built-in models to keep running when
names collide with custom ones. The Resolver deduplicates Built-in first, then discards Personal members
colliding with Built-in. Built-in wins; collisions do not cripple the Provider, and Personal identity cannot
override Built-in.

### C14. Reasoning compatibility and hardcoded specific models

`magic_name`, ox-alpha, GLM special cases, `adapterCompatibility`, `reasoningReplay` existed or were proposed
into configuration. All production code identifying reasoning intensity by specific model exits;
`reasoningReplay` and Compatibility are fully deleted. Logic tiers are declared by
`optionSpecs.reasoningLevel`; protocol fields are projected directly from that Option's restricted CEL
`map(value)` into the final raw Request Body; the formal Schema rejects old `reasoningMapping` fields.
Specific model differences are declarative Model Rules; Runtime/Adapter does not patch by Model ID.

### C15. Input and output formats

Evolution: `modalities: { input: string[], output: string[] }`, then flattened
`supportsImages/Pdf/Video`, final ruling nested snake_case properties. Config, Registry, Protocol, and Model
uniformly use `properties.input_format/output_format`; PDF/Audio enter static facts, PDF continues gating,
Audio has no content encoding entry yet. Old fields may appear only in one-time importer/historical test
inputs, not as formal facts.

### C16. Model intermediate states: ModelRef, ConnectionPort, Capability DTO

Old CLI design and trajectory documents heavily describe `ModelRef`, `ModelConnectionPort`, Catalog
capability. Todos 01, 02, 04, 05, 08, 14, 16 completed the retirement. The public execution object is an
immutable Model created by Factory from the formal Registry; media and option reads use the Model's own
structure. Old CLI design/trajectory explains history only, never current interfaces.

### C17. Should `Document`, Snapshot, Envelope all be deleted?

Deleting the Document concept was sometimes extended into "no snapshots or versions at all." The domain needs
read-only Config Snapshot and Registry Snapshot for atomic publishing, and Repository/remote sync needs
version shells; they have not re-emerged as editable Config DTOs. What was deleted is the redundant domain
intermediate state, not the immutable snapshots and physical version information required for atomicity.

### C18. Does Registry refresh need a revision handshake?

Once suggested that Host sends a revision to the Agent after saving and waits for the observed revision. The
user considered it over-abstract, preferring Host testing directly. Current: Source/Registry in each
Environment reads configuration independently; connection tests go through the formal Host
Registry/ModelFactory; the Worker watcher has failure self-healing; Built-in and Account revisions are
atomically paired in Registry Service. Do not introduce cross-process Registry Snapshots or a universal
revision handshake; execution entries wait for their own Environment's formal refresh result.

### C19. Does the settings page read Account Overlay?

Some UI designs concatenated Account Overlay, plan cards, and Provider configuration in the Renderer, even
letting entitlement state control the model area. Ruling: the settings page reads only the final Provider
Settings View; plan state projects independently. Todo 32 completed in `e01862000f`: Team/Individual details
resolve exactly from the Provider Settings View by `providerId`; plan state no longer controls whether the
config area and model list exist; `not-allocated` and `credential-unavailable` are explicit page states. This
boundary is a current fact; plan projection cannot retroactively become Provider configuration authority.

### C20. Should Endpoint/API Schema be displayed on the Account page?

General settings design requires Built-in Endpoint/Schema visible but read-only; Todo 32's latest ruling
hides them on Individual/Team Coding Plan pages. General Built-in still displays read-only connection facts;
Individual/Team are product-display exceptions. Fields were never deleted from Effective Config; Runtime
continues using them.

### C21. Settings feedback location

Old `settings.md` once placed a global Toast at the page/viewport bottom; real-machine feedback required the
right-side Provider details column bottom, banner style, new states replacing old. Recent Bugfix/Todo
converged feedback to the details column. Core design uses the Provider details column bottom banner; this is
interaction projection only, not a change of configuration authority.

### C22. `modelContextBudget.strategy` and so-called Official Runtime Config

Once attempted to include all fields from remote `/client/configs` into Provider Config or create a new
Official Runtime Config. Ruling: this field belongs to Agent parameters/product canary, unrelated to model
static configuration. No changes this round, no new config domain. Not part of Provider Refactor.

### C23. Remote Provisioning

Some consolidation plans listed local-to-remote sync, remote editing, and login as incomplete Provider
refactor items. Ruling: Remote Provisioning is an independent product capability. Provider design only
requires each execution Environment to own its fact source; it does not define how configuration distributes
across Environments.

### C24. Who is responsible for Built-in integrity?

Todo 18/19 discussed large-scale client-side "static integrity" gates; the user considered the rules hard to
maintain and possibly the publisher's responsibility. Ruling: do not expand integrity validation for now;
Todo 19's discussion is obsolete; if needed later, establish a new publishing gate task separately. Schema,
Resolver, and the existing Built-in integrity test protect the current executable contract; no new remote
publisher workflow was added. Existing runtime integrity continues; stronger publishing gates must not be
written as current design without prior discussion.

### C25. Start independent Provider vs. current single-connection semantics

**Conflicting old statement**: Start/Individual/Team share a single current, Start selection maps with the
current plan. Proposals of virtual unified entry, cross-brand mapping, full migration, upgrade connection
snapshots, multi-Provider global invalidation notices, and additional auth race checks cannot serve as final
contracts.

**Subsequent user ruling (2026-09-16)**: Retain the two Start IDs, unified name, and respective brand logos
under the existing Zhipu grouping; details remove only connect/disconnect. Retain "current", allowing Start
and the current paid connection to coexist; Start resolves strictly by original identity, paid connections
keep their mapping; JWT reused from login; account race conditions follow current state. The user explicitly
stated "no migration, add an optimization": only recommend a quota-bearing, reasoning-compatible same-model
Start when the user submits/saves, including Subagent explicit model saves, ultimately excluding immediate
run. Preferences apply across entries, restart, and same-Host mobile; no account cloud sync. On invalidation,
retain quota feedback; global connection notifications handle only paid plans.

**Pre-implementation code/test facts**: current, public account mappings, and Start request auth originally
had old connection constraints; settings navigation had connection side effects. Normal Sessions write back
their selection on submission start; drafts write back after acceptance; therefore "all old sessions
persistently retain Start" is false. Automation only fixes run; explicit Subagent execution does not change
long-term configuration; no migration does not mean old valid behavior remains unchanged. I27/MP-R03 actually
injects Recent, asserting fallback Configured Default; the old matrix's Start→Team cannot prove normal
Sessions need migration. See [research](../research/todo154-start-plan-independence-impact.md).

**Final ruling**: The target is Design V2 §4.5; full implementation boundaries belong to
[Todo154](../steps/todo-154-start-plan-independent-provider.md). Retain existing data and resolve by new
semantics; no new migration mechanism, no history rewriting, no secretly selecting paid models through
removed mappings. The expanded proposals above are withdrawn. The user authorized Todo154 execution on
2026-09-16 with comprehensive review; Todo101 remaining items deferred. Formal behavior synced to the
[Start specification](../../../zai-start-plan-provider.md).

**Owner and completion criteria**: Todo154 owns state/auth/model selection/navigation, submission
recommendations, preferences, and invalidation feedback implementation plus desktop/mobile/Worker regression.
The 17 pre-implementation tests are historical evidence only. Independent current/JWT, Start exact identity
resolution, independent navigation, and submission recommendations for four entry types are implemented; no
data migration was added. Targeted unit tests, Pro admin SSH Electron live runs, and review results are
recorded in Todo154 §8; narrow-screen simulation is not equated with physical phone verification.

### C26. Can approval dialog full-access modify permissions of an accepted queue?

**Old statement**: [Todo71](../steps/todo-71-persistent-composer-draft-and-submission-state.md) and
[Todo151](../steps/todo-151-independent-plan-state-draft.md) require a Submission to retain its original
configuration after queuing, not rewritten by drafts or approval results.

**Subsequent ruling (2026-09-17)**: Only the approval dialog's new "full access" synchronizes the current
task, Composer, and all queued messages to `mode=yolo`; individual `planEnabled` and other fields are
retained. The normal Composer menu still modifies only drafts.

**Current fact**: The immediate switch command is still used by Bot, automation, and compatibility paths;
`app.setMode()` also writes project permission preferences; passing only yolo disables Plan and does not
update queues or responses to existing approvals. The shared normalization function's Plan disablement has
been reproduced with minimal execution; the approval's new behavior is unimplemented.

**Final ruling**: Add an explicit permission update exception for approval dialogs, without overturning
model selection freeze, Plan independence, normal queue consumption, or draft ownership. The Agent coordinates
task permissions, all target queues, and current responses; the client side synchronizes corresponding
drafts; no project default write side effects are inherited; old request normalization semantics are not
globally modified.

**Completion status**: Implemented per ruling; acceptance not yet fully consolidated; owner is
[Todo158](../steps/todo-158-permission-dialog-full-access-and-queued-mode.md). SQLite, Runtime, broker, V4,
and Composer regression evidence and baseline failures are in its Section 9; the phone shared-host full
end-to-end path remains unverified; pending cases are not treated as formal acceptance criteria.

## 5. Old Material Usage Tiers

### 5.1 Can serve as current design evidence

- Two-path architecture and core principles in `design/design.md` not corrected by this document;
- Current field contract of `design/registry/configuration.md`;
- `design/model/input-output-format.md`;
- `design/registry/model-membership-and-enablement.md`;
- Final rulings of Todos 21, 23, 26, 28, 29, 32;
- Current Schema, Resolver, Registry, ModelFactory, and tests.

### 5.2 Can only serve as historical implementation evidence

- M1–M4 implementation documents and logs;
- Todos 00–10, 12–14, 16–18, 20, 24, 25, 27, 30, 31;
- Bugfixes 01–06;
- Provider MR review and architecture conformance review;
- Research and dogfood records.

These documents explain why an abstraction was deleted, but their stage-specific Schema cannot override
subsequent rulings.

### 5.3 Explicitly superseded key materials

- Todo 03 Model visibility: superseded by Todo 21;
- M4, Todos 02, 07, 14, 15 `request-auth/accessId`: superseded by Todos 24/26;
- Todo 24 `execution-provided + executionProtocol`: superseded by Todo 26;
- Research `Official Config`, old flattened capabilities, and `accessId` drafts: superseded by Todo 10, the
  input/output format design, and Todos 24/26;
- Old CLI v2 ModelRef/Capability documents: superseded by the actual cleanup of Todos 00–16;
- Settings global bottom Toast: superseded by subsequent real-machine interaction rulings.

### 5.4 Cannot yet enter current facts

- Todo154 old candidates (virtual Provider, cross-brand mapping, full migration, new auth barriers) are
  withdrawn; current implementation and verification follow Todo154 §8;
- Todo 11: draft;
- Todo 11A: awaiting execution;
- Todo 15: obsolete, no longer an independent execution item;
- Todo 19: obsolete, no longer an independent execution item;
- Todo 22: draft;
- Research reports on not-yet-implemented Built-in model fact expansions;
- Manual E2E, real accounts, formal packages, and cross-platform verifications not yet complete.

## 6. Completion Evidence and Remaining Audit Items

### 6.1 Todo 32 Completion Evidence

Todo 32 completed in commit `e01862000f`, file status updated to "completed." Implementation records prove:

- Plan state no longer controls Provider/model config area existence;
- Team/Individual models come from the Provider Settings View;
- Team models keep existing sorting, enable/disable, and Personal Model Config editing;
- Endpoint/API Schema hidden only in product UI; runtime configuration unchanged;
- loading, explicit unassigned, credential unavailable, and request failure are no longer inferred from
  display text.

Recorded verification: 220 passing Provider UI targeted tests, 1470 full unit test files with 12,480 passing
tests, and root `typecheck`, `lint`, format check, and `git diff --check` passing. Real Team account and
formal package experience remain publishing verification, not design status changes.

### 6.2 Staging final integration

The branch is significantly forked from staging. Before the final merge, staging-unique Provider commits must
be reviewed as "product invariant migration," not "old code retention," verifying:

1. Start/Individual/Team/API Key explicit selection enters Account Overlay and real Model creation;
2. Connection tests do not produce false failures from extremely small output token budgets;
3. pending/unknown entitlements do not falsely report as unassigned;
4. staging's new business/UI features do not reintroduce the old Provider Service, family runtime filter,
   capability DTO, or hardcoded specific models.

### 6.3 Publishing verification

Automation demonstrates the main domain contracts; the following remain live verification rather than design
gaps:

- Real API Key, Start, Individual, Team, Off-Peak requests;
- Built-in paths in Desktop/CLI formal artifacts;
- macOS, Windows, Linux, and the historical Personal Config importer;
- Config updates, process restarts, and cold starts;
- Deferred manual E2E and container environment gates.

### 6.4 Non-Provider Config similar fields

The full repo may still contain terms like `planKind`, `productId`, `modalities`, `supportsImages`,
`ModelRef`. Do not equate strings with regressions:

- `planKind/productId` in account, Subscription, Usage protocols are legitimate business fields;
- `modalities` in legacy importer/test fixtures is compatible input;
- `supportsImages` in Adapter local transformation helpers can be a function parameter, but must not become a
  second Active Model capability authority;
- `ModelRef` in CLI historical design/trajectory is document residue, not a current production interface.

Mechanical zeroing is limited to formal Provider Config, Registry, Model, and Runtime authoritative paths;
avoid erroneously deleting legitimate concepts in other domains.

## 7. Future Maintenance Format

New contradictions append a `Cxx` item stating at minimum:

1. The conflicting old statement;
2. The subsequent explicit ruling;
3. Current code/test facts;
4. The final ruling;
5. If unfinished, the owner Todo and verification criteria.

Historical documents are not retroactively rewritten "as if the final answer was known at the time."
Preserving original trajectories while maintaining rulings here satisfies both current design clarity and
historical audit credibility.
