# Provider Implementation Architecture Conformance Review

## Document Status

- Status: Discussion draft
- Review baseline: `bcb119437370b74b6460b89975afae2ef5cdea33..6ddf899d6863d7cdede91a47fa6d718541284326`
- Review target: Production implementation of Provider Refactor that has been committed
- Out of scope: Pre-baseline legacy code cleanup, M4 Model Execution Cutover, uncommitted changes in current worktree, remote config sync product capabilities
- Purpose: Document current implementation's conformance to confirmed Design, structural bridging, and unresolved boundary disputes; this document does not directly approve the final scheme

"Clean" is easily misunderstood as code style, file size, or subjective neatness. This document uses "architecture conformance" to specifically check whether implementation贯彻s confirmed state ownership, Overlay ordering, Source/Repository, Registry, Facade, and Account boundaries.

## Division of Labor with Legacy Code Cleanup Review

A separate review focusing on "cleaning existing legacy code" currently exists. The two reviews divide labor as follows:

```text
Legacy Code Cleanup Review
└─ Legacy implementations, entry points, and compatibility chains existing before the baseline

This Review
└─ Provider Refactor new code
   ├─ Whether it directly expresses the target Design
   ├─ Whether it introduces long-term reasonable boundary Adapters
   └─ Whether it repackages old problems as new bridging layers
```

This review does not enumerate or plan deletion of pre-baseline legacy code. If a new code segment connects to the old system, this review only determines "whether this new connection is a reasonable temporary Adapter, whether it leaks into the target domain, and whether it has a clear exit boundary"; the connected legacy implementation belongs to the legacy code cleanup review.

The ~2,850 lines of explicit legacy/transition glue in this document are for explaining the total composition of new code and avoiding statistical misunderstanding; they do not constitute this review's legacy code remediation list. The two reviews can cross-reference each other but cannot claim the same cleanup task.

## Review Objectives

This review answers the following questions:

1. Which parts of new production code are genuine target-domain implementations?
2. Which parts are cross-process, serialization, file, and network boundary Adapters still needed long-term?
3. Which code, though on the formal main path, is structurally bridging caused by authoritative state or abstract boundaries not being贯彻?
4. Which problems are direct Design-implementation conflicts, and which still require product or architectural rulings?
5. What should be deleted, rewritten, and which reasonable boundaries must be preserved in subsequent cleanup?

The review does not judge by file names. A file without `legacy` or `compat` in its name might still reverse-derive state, duplicate parsing implicit protocols, or patch cross-layer holes. An Adapter file might also be a formally necessary part of the target architecture.

## Classification Criteria

| Category                   | Definition                                                                                                                | Typical Examples                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Target core implementation | Directly expresses confirmed domain model and state ownership                                                             | Config Overlay, Resolver, Registry, Facade, Account Config projection          |
| Long-term boundary Adapter | Form transformation still needed in target architecture                                                                   | RPC serialization, Node file IO, Network API Adapter                           |
| Structural bridging        | Reverse-derivation, duplicate parsing, or exception maintenance due to missing authoritative state or abstract boundaries | Effective-to-Personal reverse derivation, UI parsing `accessId`                |
| Explicit migration glue    | Temporary compatibility retained for old formats or callers                                                               | Legacy importer, old Provider store reader                                     |
| Mechanical boilerplate     | Does not deviate from Design, but implementation causes duplication                                                       | Config Input/Object/Class, Overlay, `toJSON()`, completeness-check boilerplate |

## Current Quantity Assessment

Previously ~19,250 lines were classified as "core Design implementation." After semantic-link review, the current estimate:

| Category                                         | Estimated New Lines | Description                                 |
| ------------------------------------------------ | ------------------: | ------------------------------------------- |
| Genuine target Design贯彻                        |      ~14,000–15,000 | Still the main body of new implementation   |
| Long-term reasonable boundary Adapter            |        ~1,400–1,900 | Should not be deleted to reduce line count  |
| Structural bridging from abstract incompleteness |        ~2,100–2,800 | This document's focus                       |
| Mechanical abstract boilerplate                  |            ~600–900 | Optimizable, but not architecture deviation |

These are semantic estimates, not mechanically calculable LOC from paths. ~4,000–4,800 lines of formal implementation are within the affected code surface, but the same files typically contain correct domain logic alongside bridging logic; estimated truly deletable or significantly reducible structural bridging is ~2,100–2,800 lines.

Explicit legacy/transition glue is ~2,850 lines, outside the above 19,250 lines. Combined, the total migration or structural debt in production new code is ~5,000–5,700 lines.

## Feature Summary

| Field            | Value                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Developer intent | Review whether Provider Refactor formal implementation贯彻s confirmed architecture, and build an issue list for subsequent rulings               |
| Capability       | Provider Config, Account Overlay, Registry, Settings/Selection Facade, Repository                                                                |
| Change layer     | option-source / validation / commit-effect / persistence                                                                                         |
| Operating mode   | Impact-only; records findings and candidate directions only                                                                                      |
| Primary seeds    | `ProviderConfigService`, `projectEffectiveProvidersToPersonalConfig`, `ProviderConfigDocument`, `AccountProviderService`, `ModelSelectionFacade` |
| Out of scope     | M4, Model lifecycle, remote config sync product capabilities, queue and recovery semantics                                                       |

## Confirmed Target Structure

Provider Overlay order preserves both existing rulings:

```text
ZCode Built-in Provider Config
              |
              v
 overlay Account Built-in Provider Config
              |
              v
Effective Built-in Provider Config
              |
              v
 overlay Personal Provider Config
              |
              v
    Effective Provider Config
```

`Effective Built-in Provider Config` means "ZCode Built-in resolved and constrained by current Account Built-in facts." It is a formal concept layer and Settings read-only baseline; no new persistence object or independent Source is required. Implementation can keep it as a derived value in Resolver/Registry Snapshot.

Both invariants hold simultaneously:

- Account only processes Built-in declared account Providers; it does not read or constrain Personal-only Providers.
- Personal takes effect after Account; it is the user's final override.

## Current Findings

### F1. Settings Save Chain Rebuilds Personal from Effective

Status: `must-inspect`, Design conflict candidate, highest priority.

Current chain:

```text
Effective Provider Config
          |
          v
Renderer clones full Effective Draft
          |
          v
saveEffectiveProvider()
          |
          v
Only computes Personal diff relative to Built-in/Official
          |
          +--> Special case discards Account accessId
          `--> Other Account results may enter Personal
```

Evidence:

- `packages/ui/src/lib/providerSettingsFormProjection.ts` copies `effectiveConfig` and model `effectiveConfig` in full as form state.
- `packages/ui/src/lib/providerPersonalSave.ts` passes full Draft to `saveEffectiveProvider()`.
- `packages/provider/src/config-service.ts` only reads Built-in/Official Source on save.
- `packages/provider/src/personal-config-projection.ts` can only manually exclude `zhipu-account.accessId`.

Risks:

- Account-returned Built-in model members may be persisted into Personal when users modify unrelated fields.
- Subsequent account model member changes will be obscured by Personal's full list.
- Each new Account dynamic field adds another field blacklist.
- Save baseline and Effective Config generation baseline are inconsistent.

Internal Design contradictions also need ruling:

- `registry/configuration.md` requires Personal to remain sparse; Effective View must not reverse-contaminate Personal.
- `registry/settings.md` states compute Personal relative to ZCode Built-in baseline.

Candidate directions, not directly ruled in this document:

1. Save complete Effective Draft, but compute Personal relative to the same revision of `Effective Built-in Provider Config`.
2. Renderer or Facade submits sparse Personal intent directly, without reverse-diffing complete Effective Draft.
3. Keep current Built-in diff and continue maintaining Account field exceptions; this plan perpetuates structural bridging and is not recommended as target state.

#### Subsequent Ruling (2026-08-24)

This item has been formally ruled in official Design; the above three-way choice is no longer held:

- Settings directly perceives `Effective Built-in Provider Config` and sparse Personal Config, submitting only user-modified sparse Personal Overlay; Renderer does not reverse-derive Personal from Effective Config;
- Individual config items fully exposed to users continue as full replacement; untouched inherited values must not materialize from unrelated saves;
- Provider model members no longer use three-layer shared coverage `models[]`; split into `builtinModelIds` (Owned by Built-in/Account Built-in) and `modelIds` (Owned by Personal);
- Two member fields with identical names form explicit Model ID conflicts. The old Personal config for conflicting models is non-executable; Settings, model selector, and model editor jointly display diagnostics and require user rename or deletion;
- Model Config adds `enabled`; Provider pages directly provide enable/disable operations. Built-in IDs are undeletable; users manage candidate sets in ordinary model selectors via `enabled`.

Official facts at
[`design/registry/model-membership-and-enablement.md`](./design/registry/model-membership-and-enablement.md)
and [`design/registry/configuration.md`](./design/registry/configuration.md).

### F2. `Config Document` Has Entered Provider Domain Layer

Status: `must-inspect`, confirmed inconsistent with Design.

Design specifies: Config Map, Rules, and Effective Config are domain objects; `schemaVersion`, JSON envelope, file name, and migration belong to Source/Repository.

Current implementation exposes:

- `ProviderConfigDocument` in `packages/provider/src/config/document.ts`;
- `ModelSelectionConfigDocument` in `packages/provider/src/model-selection-config.ts`;
- Personal projection functions returning `ProviderConfigDocument`;
- Node Repository, Official Source, and Importer around Document passing.

Version migration, JSON validation, backup, and atomic write are long-term needed persistence capabilities. The problem is not these code existing, but the Repository envelope shaped as a Provider Domain public object.

Candidate target boundary:

```text
Provider Domain
└─ ProviderConfigMap + ModelConfigRules + Layer Update
                    |
                    v
Repository Boundary
├─ schemaVersion
├─ JSON envelope
├─ migration
├─ backup
└─ atomic write
```

The unresolved point is the final form of public API and migration order, not whether versioned storage is retained.

### F3. `accessId` Resolved as Product Protocol by Multiple Layers

Status: `must-inspect`, boundary design awaiting ruling.

`accessId`'s established responsibility is stable, non-sensitive account connection identity. Currently it is also used by multiple layers to derive:

- Start / Individual / Team Plan;
- Provider Family;
- organization/project;
- Credential key;
- UI grouping, labels, and Badges.

Current Account Resolver, Request Auth, Team Plan Runtime Key, and UI separately parse `start-plan:`, `coding-plan:`, `team-plan:` prefixes. Notably `packages/ui/src/lib/modelSelectionGroups.ts` directly decides product display via `accessId.startsWith(...)`.

This turns accessId from an opaque identity into a cross-layer string protocol without a centralized type definition.

Candidate direction:

```text
Provider Config
└─ accessId (remains stable, opaque)

Account/Product Facade View
├─ family
├─ planKind
├─ connectionId
├─ organization/project display
└─ presentation label/badge
```

This candidate does not require adding plan display fields to Provider Config, nor establishing a new Registry Source. The discussion is: which existing Service/Facade owns the typed Account/Product projection, and how the request auth side guarantees a single accessId parser.

### F4. Account Last-Known-Good Uses Full Atomic Snapshot (Ruled)

Account Built-in Provider Config is an atomic snapshot from a single Settings, current account, connection choice, and entitlement resolution. Full refresh succeeds → whole batch published; any external dependency fails → partial new results not published, continues keeping full previous successful Snapshot.

This round does not implement per-Family or per-Provider partial last-known-good. Temporary staleness restored by subsequent refreshes; dynamic credentials still by Request Auth and server-side auth; cannot bypass authorization by displaying old Snapshot. Full snapshot semantics are simpler than mixed multiple resolution generations, and require no account generation, selection revision, and dependency failure scope maintenance.

Current `unknown + previousProviders` per-Provider branching is a half-set recovery mechanism overlapping with target semantics; Todo 07 modification of Account Resolver can simplify alongside, without creating independent tasks for fault isolation.

### F5. Selection Facade View and Validation Boundary Inconsistent

Status: Ruled, entered
[`steps/todo-12-model-selection-validation-boundary-cutover.md`](./steps/todo-12-model-selection-validation-boundary-cutover.md).

`ModelSelectionFacade.getView()` filters hidden Providers, but `validate()` directly delegates the full Registry. Therefore, hidden Providers not visible in the candidate View may still pass through the user Facade's validation.

This is inconsistent with existing design:

- User candidates and user selection validation use Selection Facade's visible candidates;
- Internal product capabilities use exact ID for full Registry lookup.

Further code review confirmed that ordinary UI only consumes View; Facade `validate()`'s main production caller is actually hidden Off-Peak dispatch. Final ruling: do not retain execution validation on user Facade; delete Facade/Service `validate()`; Off-Peak uses internal Registry narrow advance check; all Selection finalized by current Agent Registry/ModelFactory upon real task submission and Model building.

### F6. Provider Runtime Composition Has Duplicate Shells

Status: Entered draft at
[`steps/todo-11-provider-runtime-composition-boundary-cleanup.md`](./steps/todo-11-provider-runtime-composition-boundary-cleanup.md), must not implement.

The following implementations wrap similar Config/Registry lifecycles:

- `packages/provider-node/src/provider-config-runtime.ts`
- `packages/provider-node/src/provider-registry-runtime.ts`
- `packages/services/src/model-provider/providerRuntime.ts`
- `packages/services/src/model-provider/providerConfigRuntime.ts`

File path injection, watcher, RPC Facade, and Account Source are all reasonable boundaries. The problem is Empty Account Source, start/dispose, ready promise, and Config/Registry assembly duplication.

Further code review confirmed these four layers correspond to two different real composition roots: Host manages Settings/Selection; Agent process manages ModelFactory/execution; both sides owning Registry is the correct boundary. The draft records shared Node Config resources plus two explicit composition root candidates, while preserving current structure and unified Runtime as alternative plans, awaiting item-by-item ruling.

Also discovered a specific lifecycle bug candidate: `startProcessProviderRegistryRuntime()`'s outer `dispose()` also manages Model Selection Repository and manages Credential subscription in Standalone mode; Protocol entrypoint directly calls inner `runtime.dispose()`, bypassing outer Repository cleanup. Draft stage only records, does not fix along the way.

### F7. Physical `official` Naming Still Spreading to Domain API

Status: Ruled, entered
[`steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](./steps/todo-10-zcode-builtin-provider-config-naming-cutover.md).

Current `officialProviders`, `officialSource`, and `OfficialProviderConfigSource` still widely exist. Domain semantics unified as ZCode Built-in Provider Config.

Domain types, services, Source, Facade, variables, physical files, environment variables, and SEA assets must be unifiedly migrated to `zcodeBuiltin*` / `zcode-builtin` semantics in the same switch. This branch has not shipped; no old fields, old paths, aliases, fallbacks, or importers retained.

### F8. Complete Model Properties Still Propagated as Unknown State Cross-Layer

Status: `must-inspect`, Design confirmed, awaiting implementation.

Target `ModelProperties` has defined all `support_*` as required booleans, Built-in general Model Rule also provides complete defaults. However, the Resolver still publishes sparse `ModelConfig` type directly to Registry after `validateComplete()` succeeds, causing downstream to repeatedly adapt an "unknown capability" state that should not actually exist:

- Bootstrap Runtime re-checks each field with `requireCompleteProperties()` and copies;
- Selection only sends Protocol `properties` when all fields exist; otherwise silently omits;
- Protocol's format leaf is required, but `ZCodeModelOption.properties` is overall optional;
- Settings Draft uses `support_text ?? true`, other formats `?? false` to fill defaults;
- Adapter already-resolved models and message conversion still accept optional `properties/input_format`;
- Old Catalog merge hardcodes true/false on missing capabilities.

```text
Sparse Model Config Rule                    Correct
          |
          v
resolve + validateComplete
          |
          +--> Continue publishing Sparse ModelConfig  Current root cause
                       |
                       +--> Runtime re-validates
                       +--> Protocol can omit
                       +--> Settings fills defaults
                       `--> Adapter optional
```

Target is to close type boundary at Resolver/Registry publish point: Rules and Personal Overlay can be sparse, but Effective/Registry Model and Protocol, Active Model, Runtime, and Adapter must only see complete booleans. Missing fields are config errors, not `unknown`; downstream must not fill defaults or silently omit.

This does not involve TypeScript `unknown` for open JSON. Legacy importers may still read old formats at one-time boundaries, but can only produce sparse Personal Config from defined old facts; missing items inherit Built-in Rules, cannot add migration defaults or form general Runtime fallback. After mandatory upgrades cross the compatibility window, versionless old-format importers, parsers, Catalog dependencies, and tests are all deleted. Implementation plan per
[`steps/todo-03-provider-model-ownership-and-property-totality.md`](./steps/todo-03-provider-model-ownership-and-property-totality.md).

## UI Surface Matrix

| User scenario              | UI entry                           | Display/draft owner                         | Default/inherit source            | Validation/gating                      | Commit action                      | Authority/persistence   | Must remain isolated from                                   |
| -------------------------- | ---------------------------------- | ------------------------------------------- | --------------------------------- | -------------------------------------- | ---------------------------------- | ----------------------- | ----------------------------------------------------------- |
| Edit Provider              | Provider Settings                  | Renderer sparse Personal Draft              | Effective Built-in + Personal     | Facade Preview / Registry completeness | Save Personal Overlay              | Personal Repository     | Account dynamic results must not be inadvertently persisted |
| Select user-visible models | Model selector                     | Each Surface local Draft                    | Model Selection Facade View       | Selection Facade validate              | Each Surface's own submit action   | Each state owner        | Hidden Provider, other Surface state                        |
| Display plan Provider      | Model selector / Provider Settings | Renderer projection                         | Effective Provider + product data | Account availability                   | None or per-product connect action | Account/Product Service | UI must not parse request auth protocol                     |
| Enable/disable models      | Provider model list / model editor | Renderer Personal Draft                     | Effective Model Config            | enabled + completeness + conflict      | Save Personal precise Rule         | Personal Repository     | Do not modify Built-in members or server-side authorization |
| Handle Model ID conflicts  | Provider list / editor / selector  | Renderer displays authoritative diagnostics | source-aware Model Inventory      | Resolver `id-conflict`                 | Rename or delete Personal item     | Personal Repository     | Do not auto-rewrite Personal or selection source            |

## State Owners And Commit Sinks

| State/fact                       | Draft/display owner                | Authoritative owner          | Commit command/service    | Persistence/cache                    |
| -------------------------------- | ---------------------------------- | ---------------------------- | ------------------------- | ------------------------------------ |
| Built-in Provider/Model Config   | Settings View read-only projection | Built-in Config Source       | Product publishing        | `config/provider/zcode-builtin.json` |
| Account Built-in Provider Config | Settings/Selection View projection | Account Provider Service     | Account refresh           | Process-local last-known-good        |
| Personal Provider/Model Config   | Renderer Draft                     | Personal Config Repository   | Provider Settings Service | Current Environment Personal Config  |
| Effective Provider Config        | Facade View                        | Resolver/Registry Snapshot   | Source refresh/rebuild    | Not independently persisted          |
| Account request credential       | UI does not own                    | Account Request Auth Service | Every request attempt     | Credential Store/dynamic interface   |
| User-visible model candidates    | Each Surface display               | Model Selection Facade       | Registry refresh          | Not independently persisted          |
| Built-in model members           | Settings View read-only projection | Effective Built-in Config    | Built-in/Account refresh  | `builtinModelIds`                    |
| Personal model members           | Renderer Personal Draft            | Personal Config Repository   | Provider Settings Service | `modelIds`                           |
| Model ID conflicts               | Renderer read-only diagnostics     | Resolver/Registry Snapshot   | Source refresh/rebuild    | Not independently persisted          |
| Model enabled                    | Renderer Personal Draft            | Effective Model Config       | Personal Rule update      | Personal Model Config Rules          |

## Feature Relationships

| Rank           | From                         | Semantic edge                   | To                         | Why inspect it                                                               |
| -------------- | ---------------------------- | ------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| must-inspect   | Provider Settings Draft      | commits-effective-config-to     | Personal Config projection | Current Effective-to-Personal reverse derivation and Account field leak risk |
| must-inspect   | Account Provider Service     | overlays                        | Built-in Provider Config   | Determines correct baseline for Personal saves                               |
| must-inspect   | Account connection identity  | authenticates-through           | Account Request Auth       | accessId must be stable and parsing centralized                              |
| must-inspect   | Account product presentation | projects-to                     | Settings/Selection UI      | UI must not parse auth identity strings                                      |
| must-inspect   | Selection Facade             | validates-visible-candidate-for | User selection surfaces    | Current validate uses full Registry                                          |
| must-inspect   | Built-in/Personal membership | conflicts-by-same-model-id      | Settings/Selection/Editor  | Same execution identity must not silently select config source               |
| must-inspect   | Personal Model Rule          | controls-enabled-for            | Model Selection Facade     | disabled stays in Settings, but exits ordinary candidates                    |
| must-inspect   | Complete Model Config        | freezes-properties-for          | Protocol/Model/Runtime     | Sparse type leakage causes multi-layer unknown compatibility                 |
| should-inspect | Repository envelope          | serializes                      | Provider Config Layer      | Versioning must be retained but not enter domain layer                       |
| should-inspect | Provider Runtime composition | assembles                       | Config/Registry/Facade     | Can reduce duplication but must not break Source boundary                    |

## Must-Preserve Invariants

1. Provider Overlay order is always ZCode Built-in → Account Built-in → Personal.
2. Account Built-in only reads ZCode Built-in account Providers; it does not read Personal-only Providers.
3. Personal is final user override and remains sparse; unedited Account dynamic facts must not be inadvertently written to Personal.
4. Effective Config is not independently persisted, nor can it become a reverse-pollution source for upstream Sources.
5. `accessId` is non-sensitive connection identity, not model static capability, server-side authorization result, or UI product protocol.
6. Account request credentials do not enter Provider Config, Settings View, or persisted Personal Config.
7. Visibility only affects user Facade; internal exact Registry lookup does not introduce permission or "trusted" concepts.
8. JSON envelope, schema version, migration, and atomic write belong to Repository, not Provider Domain.
9. Desktop, Web, Mobile, and Remote Environment use their respective target Environment Provider Service; this review does not change existing remote sync product boundaries.
10. Model Rules can be sparse; Effective/Registry Model Properties after `resolve + validateComplete` must be complete; downstream must not maintain capability unknown or fill defaults.
11. Legacy importers only migrate defined old facts, never guess capabilities; after mandatory upgrades cross the compatibility window, the entire versionless old-format import chain is deleted, but normal schemaVersion migration continues to belong to Repository.

## Reasonable Adapters and Forbidden Deletion Items

The following code must not be deleted merely because it is "glue" even if line counts are high:

- Node Repository file locks, atomic writes, watchers, backups, and migrations;
- RPC Service projecting Config Class as ordinary serializable objects;
- Real business differences for Account API, Start Plan, Personal Coding Plan, Team Plan;
- Provider Source/Repository interfaces and process-local Registry;
- SEA environment Built-in config physical materialization;
- Protocol runtime Schema;
- Config three-state Overlay and completeness checks.

`ModelPropertiesConfig` and similar Config Classes have obvious mechanical boilerplate, but this is the implementation cost from insufficient declarative Overlay tooling, not automatically architecture deviation.

## Evidence And Limitations

This round inspected to depth 2 along the following paths:

```text
Provider Settings UI
  -> Provider Settings Service/Facade
  -> ProviderConfigService
  -> Personal projection
  -> Personal Repository

Built-in Config
  -> Account connection resolver
  -> Account Provider Service
  -> Provider Resolver/Registry
  -> Settings/Selection Facade

accessId
  -> Account Config
  -> Request Auth
  -> Product UI presentation
```

Current environment does not provide callable codegraph interfaces; direct callers and state chains verified against current code, `rg`, target Design, and test evidence. Run codegraph impact/affected-tests again before implementation to confirm no new callers.

## Graph Drift Candidates

| Candidate                                     | Live-code evidence                               | Missing/stale graph relation                                                                     | Proposed follow-up                                                       |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Effective-to-Personal reverse projection      | Settings Draft and `saveEffectiveProvider`       | Feature graph only records Settings persistence, no Account baseline dependency                  | Add graph after ruling save semantics                                    |
| Account product presentation parsing accessId | `modelSelectionGroups.ts` etc.                   | Provider Registry and Plan Entitlements lack presentation projection edge                        | Add graph after confirming Facade owner                                  |
| Selection Facade hidden validation            | View filtering, validate delegates full Registry | Graph does not distinguish visible validation from internal exact validation                     | Add graph after confirming API semantics                                 |
| Model member ownership / id conflict          | New Design confirmed                             | Graph originally lacked Built-in/Personal members and conflict edges                             | Added capability invariants and Settings/Selection edges already         |
| Complete Properties → Runtime                 | Optional/default compatibility after Registry    | Target edge exists, but implementation did not close Sparse Rule to Complete Model type boundary | Tighten Registry publish type per TODO 03 and delete downstream fallback |

This document is in impact-only stage; it does not directly modify feature graph.

## Topics for Discussion and Ruling

### D1. Personal Save Authority Input (Ruled)

- Renderer directly submits sparse Personal Overlay from actual modifications;
- Settings View simultaneously provides Effective Built-in, Personal, and authoritative Effective Config, but Effective is not save input;
- Full config items exposed to users are replaced as a whole once modified; unmodified items do not materialize.

### D2. Save-time Account Baseline Consistency (Ruled)

Saves carry Settings View revision; Service applies Personal Overlay on current Effective Built-in; expired responses must not overwrite updated Draft. Account/Built-in model members enter `builtinModelIds`, user members enter `modelIds`; upstream refresh no longer needs rebase on a shared member list. Name conflicts handled by explicit `id-conflict`.

### D3. Repository envelope API

Need to confirm whether `ProviderConfigDocument` and `ModelSelectionConfigDocument` move to `provider-node` private implementation, or remain as Repository package-internal non-domain serialization helpers; neither plan should continue as Provider Domain public state.

### D4. Account/Product Typed Projection Owner

Need to choose owner between existing Account Service, Provider Settings Facade, or independent product Facade. UI display semantics must not continue encoded into accessId; product UI fields must not be stuffed into Provider Config.

### D5. Account Restorable Failure Granularity (Ruled)

No partial failure granularity established. Account Built-in Config published atomically on success; whole previous successful Snapshot retained on failure.

### D6. Selection Facade validate Caller Semantics

Ruled: User Facade only projects visible candidates, `validate()` no longer public. Ordinary tasks authorizedly validated at ModelFactory build boundary; Off-Peak and other internal products use Registry's exact validation directly; visibility does not become permission or special execution identity.

### D7. Runtime Composition Wrap-up Timing

Draft for Todo 11 saved current state, two process composition roots, candidate plans, and unresolved items. Currently deferred; it can be independent of preceding semantic rulings, but must not update formal Design or implement before manual understanding and item-by-item confirmation.

## Suggested Discussion Order

1. D1 + D2 completed; implementation review should delete Effective-to-Personal reverse projection and shared `models[]` bridging based on this.
2. D3: Confirm domain-Repository serialization boundary.
3. D4: Confirm Account identity and product projection; D5 ruled as full atomic Snapshot.
4. D6: Ruled and entered Todo 12, awaiting implementation.
5. D7: Todo 11 saved draft, awaiting future resumption of discussion, not entering current implementation sequence.

After each ruling, first write back to Provider Design, then制定测试 and implementation plans. This document preserves review trajectory and should not replace final Design.
