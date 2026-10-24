# Provider Implementation Architecture Conformance Review

## Document Status

- Status: Discussion draft
- Review baseline: `bcb119437370b74b6460b89975afae2ef5cdea33..6ddf899d6863d7cdede91a47fa6d718541284326`
- Review target: committed production implementation of the Provider Refactor
- Out of scope: pre-baseline legacy code cleanup, M4 Model Execution Cutover, uncommitted worktree changes, remote config sync product capabilities
- Purpose: record the implementation's conformance to confirmed Design, structural bridging, and unresolved boundary disputes; this document does not directly approve the final scheme

"Clean" here means architecture conformance: whether the implementation carries through confirmed state ownership, Overlay ordering, Source/Repository, Registry, Facade, and Account boundaries — not code style, file size, or subjective neatness.

## Division of Labor with Legacy Code Cleanup Review

A separate review covers pre-baseline legacy implementations, entry points, and compatibility chains. This review covers Provider Refactor new code only: whether it directly expresses the target Design, whether it introduces long-term reasonable boundary Adapters, and whether it repackages old problems as new bridging layers. If new code connects to the old system, this review only judges whether the connection is a reasonable temporary Adapter with a clear exit boundary and no leakage into the target domain. The ~2,850 lines of explicit legacy/transition glue listed below are composition statistics, not this review's remediation list; the two reviews cross-reference but never claim the same cleanup task.

## Review Objectives

1. Which parts of new production code are genuine target-domain implementations?
2. Which parts are cross-process, serialization, file, and network boundary Adapters still needed long-term?
3. Which code on the formal main path is structural bridging caused by authoritative state or abstract boundaries not being carried through?
4. Which problems are direct Design-implementation conflicts, and which still require product or architectural rulings?
5. What should be deleted, rewritten, and which reasonable boundaries must be preserved in subsequent cleanup?

File names are not the criterion: a file without `legacy`/`compat` in its name may still reverse-derive state or duplicate-parse implicit protocols; an Adapter file may be a formally necessary part of the target architecture.

## Classification Criteria

| Category                   | Definition                                                                                                                | Typical Examples                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Target core implementation | Directly expresses confirmed domain model and state ownership                                                             | Config Overlay, Resolver, Registry, Facade, Account Config projection          |
| Long-term boundary Adapter | Form transformation still needed in target architecture                                                                   | RPC serialization, Node file IO, Network API Adapter                           |
| Structural bridging        | Reverse-derivation, duplicate parsing, or exception maintenance due to missing authoritative state or abstract boundaries | Effective-to-Personal reverse derivation, UI parsing `accessId`                |
| Explicit migration glue    | Temporary compatibility retained for old formats or callers                                                               | Legacy importer, old Provider store reader                                     |
| Mechanical boilerplate     | Does not deviate from Design, but implementation causes duplication                                                       | Config Input/Object/Class, Overlay, `toJSON()`, completeness-check boilerplate |

## Current Quantity Assessment

Semantic estimates, not mechanically calculable LOC:

| Category                                         | Estimated New Lines | Description                                 |
| ------------------------------------------------ | ------------------: | ------------------------------------------- |
| Genuine target Design conformance                |      ~14,000–15,000 | Still the main body of new implementation   |
| Long-term reasonable boundary Adapter            |        ~1,400–1,900 | Should not be deleted to reduce line count  |
| Structural bridging from abstract incompleteness |        ~2,100–2,800 | This document's focus                       |
| Mechanical abstract boilerplate                  |            ~600–900 | Optimizable, but not architecture deviation |

The same files typically mix correct domain logic with bridging logic; estimated truly deletable or significantly reducible structural bridging is ~2,100–2,800 of ~4,000–4,800 affected lines. Explicit legacy/transition glue is ~2,850 lines outside the above ~19,250; total migration or structural debt in production new code is ~5,000–5,700 lines.

## Feature Summary

| Field            | Value                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Developer intent | Review whether Provider Refactor formal implementation conforms to confirmed architecture, and build an issue list for subsequent rulings          |
| Capability       | Provider Config, Account Overlay, Registry, Settings/Selection Facade, Repository                                                                |
| Change layer     | option-source / validation / commit-effect / persistence                                                                                         |
| Operating mode   | Impact-only; records findings and candidate directions only                                                                                      |
| Primary seeds    | `ProviderConfigService`, `projectEffectiveProvidersToPersonalConfig`, `ProviderConfigDocument`, `AccountProviderService`, `ModelSelectionFacade` |
| Out of scope     | M4, Model lifecycle, remote config sync product capabilities, queue and recovery semantics                                                       |

## Confirmed Target Structure

Provider Overlay order:

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

Status: ruled 2026-08-24; highest priority.

The pre-ruling chain cloned the full Effective Draft in the Renderer, passed it to `saveEffectiveProvider()` (`packages/ui/src/lib/providerSettingsFormProjection.ts`, `packages/ui/src/lib/providerPersonalSave.ts`), which computed only a Personal diff relative to Built-in/Official (`packages/provider/src/config-service.ts`) with manual exclusions such as `zhipu-account.accessId` (`packages/provider/src/personal-config-projection.ts`). Risks were: Account-returned Built-in model members persisted into Personal from unrelated saves; later account member changes obscured by Personal's full list; a new blacklist per Account dynamic field; save baseline inconsistent with Effective Config generation. This contradicted `registry/configuration.md` (Personal stays sparse; no reverse contamination) vs `registry/settings.md` (diff against ZCode Built-in baseline).

Ruling (official facts at [`design/registry/model-membership-and-enablement.md`](./design/registry/model-membership-and-enablement.md) and [`design/registry/configuration.md`](./design/registry/configuration.md)):

- Settings directly perceives `Effective Built-in Provider Config` and sparse Personal Config, submitting only user-modified sparse Personal Overlay; the Renderer does not reverse-derive Personal from Effective Config.
- Config items fully exposed to users continue as full replacement; untouched inherited values must not materialize from unrelated saves.
- Provider model members no longer use three-layer shared coverage `models[]`; split into `builtinModelIds` (Owned by Built-in/Account Built-in) and `modelIds` (Owned by Personal).
- Two member fields with identical names form explicit Model ID conflicts. The old Personal config for conflicting models is non-executable; Settings, model selector, and model editor jointly display diagnostics and require user rename or deletion.
- Model Config adds `enabled`; Provider pages directly provide enable/disable operations. Built-in IDs are undeletable; users manage candidate sets in ordinary model selectors via `enabled`.

### F2. `Config Document` Has Entered Provider Domain Layer

Status: `must-inspect`, confirmed inconsistent with Design.

Design: Config Map, Rules, and Effective Config are domain objects; `schemaVersion`, JSON envelope, file name, and migration belong to Source/Repository. Current implementation exposes `ProviderConfigDocument` (`packages/provider/src/config/document.ts`), `ModelSelectionConfigDocument` (`packages/provider/src/model-selection-config.ts`), Personal projection functions returning `ProviderConfigDocument`, and Node Repository / Official Source / Importer passing Documents around.

Version migration, JSON validation, backup, and atomic write are long-term needed persistence capabilities; the problem is the Repository envelope shaped as a Provider Domain public object. Target boundary:

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

The unresolved point is the final form of the public API and migration order, not whether versioned storage is retained.

### F3. `accessId` Resolved as Product Protocol by Multiple Layers

Status: `must-inspect`, boundary design awaiting ruling.

`accessId`'s established responsibility is stable, non-sensitive account connection identity. It is also used by multiple layers to derive: Start / Individual / Team Plan; Provider Family; organization/project; credential key; UI grouping, labels, and Badges. The Account Resolver, Request Auth, Team Plan Runtime Key, and UI separately parse `start-plan:`, `coding-plan:`, `team-plan:` prefixes; notably `packages/ui/src/lib/modelSelectionGroups.ts` decides product display via `accessId.startsWith(...)`. This turns accessId into a cross-layer string protocol without a centralized type definition.

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

This candidate needs no plan display fields on Provider Config and no new Registry Source. Open: which existing Service/Facade owns the typed Account/Product projection, and how request auth guarantees a single accessId parser.

### F4. Account Last-Known-Good Uses Full Atomic Snapshot (Ruled)

Account Built-in Provider Config is an atomic snapshot from a single Settings, current account, connection choice, and entitlement resolution. Full refresh succeeds → whole batch published; any external dependency fails → partial new results not published, the full previous successful Snapshot is kept. No per-Family or per-Provider partial last-known-good; temporary staleness is restored by subsequent refreshes; dynamic credentials still go through Request Auth and server-side auth — displaying an old Snapshot cannot bypass authorization. Full snapshot semantics require no account generation, selection revision, or dependency failure scope maintenance.

Current `unknown + previousProviders` per-Provider branching is a half-set recovery mechanism overlapping with target semantics; Todo 07's modification of Account Resolver can simplify alongside, without independent fault-isolation tasks.

### F5. Selection Facade View and Validation Boundary Inconsistent (Ruled)

`ModelSelectionFacade.getView()` filtered hidden Providers, but `validate()` delegated the full Registry, so hidden Providers could pass user Facade validation. Further review: ordinary UI only consumes View; the main production caller of Facade `validate()` was hidden Off-Peak dispatch. Ruling (entered [`steps/todo-12-model-selection-validation-boundary-cutover.md`](./steps/todo-12-model-selection-validation-boundary-cutover.md)): user candidates and user selection validation use the Selection Facade's visible candidates; do not retain execution validation on the user Facade — delete Facade/Service `validate()`; Off-Peak uses internal Registry narrow advance check with exact ID; all Selection is finalized by the current Agent Registry/ModelFactory at real task submission and Model building.

### F6. Provider Runtime Composition Has Duplicate Shells

Status: draft saved at [`steps/todo-11-provider-runtime-composition-boundary-cleanup.md`](./steps/todo-11-provider-runtime-composition-boundary-cleanup.md); must not implement before item-by-item ruling.

Four implementations wrap similar Config/Registry lifecycles: `packages/provider-node/src/provider-config-runtime.ts`, `packages/provider-node/src/provider-registry-runtime.ts`, `packages/services/src/model-provider/providerRuntime.ts`, `packages/services/src/model-provider/providerConfigRuntime.ts`. File path injection, watcher, RPC Facade, and Account Source are reasonable boundaries; the problem is Empty Account Source, start/dispose, ready promise, and Config/Registry assembly duplication.

Further review: these four layers correspond to two real composition roots — Host manages Settings/Selection; the Agent process manages ModelFactory/execution; both sides owning Registry is the correct boundary. The draft records shared Node Config resources plus two explicit composition-root candidates, with unified Runtime as an alternative, awaiting ruling.

Specific lifecycle bug candidate recorded (not fixed at draft stage): `startProcessProviderRegistryRuntime()`'s outer `dispose()` also manages the Model Selection Repository and Credential subscription in Standalone mode; the Protocol entrypoint directly calls inner `runtime.dispose()`, bypassing outer Repository cleanup.

### F7. Physical `official` Naming Still Spreading to Domain API (Ruled)

`officialProviders`, `officialSource`, and `OfficialProviderConfigSource` are superseded naming; domain semantics are unified as ZCode Built-in Provider Config. Ruling (entered [`steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](./steps/todo-10-zcode-builtin-provider-config-naming-cutover.md)): domain types, services, Source, Facade, variables, physical files, environment variables, and SEA assets migrate to `zcodeBuiltin*` / `zcode-builtin` semantics in the same switch. This branch has not shipped; no old fields, old paths, aliases, fallbacks, or importers retained.

### F8. Complete Model Properties Still Propagated as Unknown State Cross-Layer

Status: `must-inspect`, Design confirmed, awaiting implementation (plan in [`steps/todo-03-provider-model-ownership-and-property-totality.md`](./steps/todo-03-provider-model-ownership-and-property-totality.md)).

Target `ModelProperties` defines all `support_*` as required booleans and Built-in generic Model Rules provide complete defaults. But the Resolver still publishes the sparse `ModelConfig` type after `validateComplete()` succeeds, forcing downstream to adapt an "unknown capability" state that should not exist:

- Bootstrap Runtime re-checks each field with `requireCompleteProperties()` and copies;
- Selection only sends Protocol `properties` when all fields exist, otherwise silently omits;
- Protocol's format leaf is required, but `ZCodeModelOption.properties` is overall optional;
- Settings Draft uses `support_text ?? true`, other formats `?? false`;
- Adapters still accept optional `properties/input_format`;
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

Target: close the type boundary at the Resolver/Registry publish point. Rules and Personal Overlay can be sparse; Effective/Registry Model and Protocol, Active Model, Runtime, and Adapter must only see complete booleans. Missing fields are config errors, not `unknown`; downstream must not fill defaults or silently omit. This does not involve TypeScript `unknown` for open JSON. Legacy importers may read old formats at one-time boundaries but can only produce sparse Personal Config from defined old facts; missing items inherit Built-in Rules, with no migration defaults or general Runtime fallback. After mandatory upgrades cross the compatibility window, versionless old-format importers, parsers, Catalog dependencies, and tests are all deleted.

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

`ModelPropertiesConfig` and similar Config Classes have mechanical boilerplate, but this is the implementation cost from insufficient declarative Overlay tooling, not automatically architecture deviation.

## Evidence And Limitations

Inspected to depth 2 along: Provider Settings UI → Settings Service/Facade → `ProviderConfigService` → Personal projection → Personal Repository; Built-in Config → Account connection resolver → Account Provider Service → Resolver/Registry → Settings/Selection Facade; accessId → Account Config → Request Auth → Product UI presentation.

Current environment provides no callable codegraph interfaces; direct callers and state chains were verified against current code, `rg`, target Design, and test evidence. Run codegraph impact/affected-tests before implementation to confirm no new callers.

## Graph Drift Candidates

| Candidate                                     | Live-code evidence                               | Missing/stale graph relation                                                                     | Proposed follow-up                                                       |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Effective-to-Personal reverse projection      | Settings Draft and `saveEffectiveProvider`       | Feature graph only records Settings persistence, no Account baseline dependency                  | Add graph after ruling save semantics                                    |
| Account product presentation parsing accessId | `modelSelectionGroups.ts` etc.                   | Provider Registry and Plan Entitlements lack presentation projection edge                        | Add graph after confirming Facade owner                                  |
| Selection Facade hidden validation            | View filtering, validate delegates full Registry | Graph does not distinguish visible validation from internal exact validation                     | Add graph after confirming API semantics                                 |
| Model member ownership / id conflict          | New Design confirmed                             | Graph originally lacked Built-in/Personal members and conflict edges                             | Added capability invariants and Settings/Selection edges already         |
| Complete Properties → Runtime                 | Optional/default compatibility after Registry    | Target edge exists, but implementation did not close Sparse Rule to Complete Model type boundary | Tighten Registry publish type per TODO 03 and delete downstream fallback |

This document is impact-only; it does not directly modify the feature graph.

## Topics for Discussion and Ruling

### D1. Personal Save Authority Input (Ruled)

- Renderer directly submits sparse Personal Overlay from actual modifications;
- Settings View simultaneously provides Effective Built-in, Personal, and authoritative Effective Config, but Effective is not save input;
- Full config items exposed to users are replaced as a whole once modified; unmodified items do not materialize.

### D2. Save-time Account Baseline Consistency (Ruled)

Saves carry Settings View revision; Service applies Personal Overlay on current Effective Built-in; expired responses must not overwrite an updated Draft. Account/Built-in model members enter `builtinModelIds`, user members enter `modelIds`; upstream refresh no longer rebases on a shared member list. Name conflicts are handled by explicit `id-conflict`.

### D3. Repository envelope API (open)

Confirm whether `ProviderConfigDocument` and `ModelSelectionConfigDocument` move to `provider-node` private implementation, or remain as Repository package-internal non-domain serialization helpers; neither plan continues as Provider Domain public state.

### D4. Account/Product Typed Projection Owner (open)

Choose an owner among existing Account Service, Provider Settings Facade, or an independent product Facade. UI display semantics must not stay encoded in accessId; product UI fields must not be stuffed into Provider Config.

### D5. Account Restorable Failure Granularity (Ruled)

No partial failure granularity. Account Built-in Config publishes atomically on success; the whole previous successful Snapshot is retained on failure.

### D6. Selection Facade validate Caller Semantics (Ruled)

User Facade only projects visible candidates; `validate()` is no longer public. Ordinary tasks are validated at the ModelFactory build boundary; Off-Peak and other internal products use Registry exact validation directly; visibility does not become permission or special execution identity.

### D7. Runtime Composition Wrap-up Timing (deferred)

Todo 11's draft saved current state, two process composition roots, candidate plans, and unresolved items. Deferred; it can be independent of preceding semantic rulings, but must not update formal Design or implement before manual understanding and item-by-item confirmation.

## Suggested Discussion Order

1. D1 + D2 completed; the implementation review should delete the Effective-to-Personal reverse projection and shared `models[]` bridging based on this.
2. D3: confirm the domain-Repository serialization boundary.
3. D4: confirm Account identity and product projection; D5 ruled as full atomic Snapshot.
4. D6: ruled and entered Todo 12, awaiting implementation.
5. D7: Todo 11 draft awaiting future resumption, not in the current implementation sequence.

After each ruling, first write back to Provider Design, then set test and implementation plans. This document preserves the review trajectory and does not replace final Design.
