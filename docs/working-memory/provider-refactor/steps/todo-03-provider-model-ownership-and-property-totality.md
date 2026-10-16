# 03 Provider Model Members, Enable/Disable, Visibility, and Registry Completeness Closure

> Status: Completed
>
> Historical note: The `builtinModelIds/modelIds` and Properties completeness that this Todo completed at the time remain valid; Model
> `enabled/visibility`, duplicate member conflicts, and settings interactions have been re-decided by
> [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md).
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Target design: [`../design/registry/model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md)、
> [`../design/registry/configuration.md`](../design/registry/configuration.md)、
> [`../design/model/input-output-format.md`](../design/model/input-output-format.md)

## 1. Objective

This task closes three groups of同源 (same-origin) issues in the Provider Refactor new implementation:

1. Use `builtinModelIds` and `modelIds` separately to express management models and Personal model members, preventing Personal-saved old lists
   from obscuring subsequently added Built-in/Account models;
2. Add `enabled` and `visibility` to Model Config, expressing execution gate and user entry visibility separately;
3. Close Config sparse boundaries when Resolver publishes to Registry, so Registry, Selection, ModelFactory, and Runtime
   only observe complete model facts.

```text
ZCode Built-in Provider Config
              |
              v
 overlay Account Built-in Provider Config
              |
              v
Effective Built-in Provider Config          ZCode Built-in Model Config Rules
              |                                           +
              v                                  Personal Model Config Rules
 overlay Personal Provider Config                         |
              |                                           v
              v                              Effective Model Config Rules
    Effective Provider Config                            |
    ├─ builtinModelIds                                   |
    └─ modelIds                                          |
              |                                           |
              +---------------------+---------------------+
                                    |
                                    v
                     source-aware Model Inventory
                     ├─ executable candidate
                     ├─ disabled / incomplete / duplicate
                     └─ Built-in candidate + Personal id-conflict diagnostic
                                    |
                                    v
                 RegistryProviderConfig / RegistryModelConfig
                                    |
                  +-----------------+-----------------+
                  |                                   |
                  v                                   v
             Selection Facade                    ModelFactory
                                                      |
                                                      v
                                          Active Model.properties
```

This task does not add compatible DTO, Runtime capability map, Renderer Overlay, or new configuration authority.

## 2. Confirmed Decisions

### 2.1 Model Member Fields

Provider Config uses two fields:

```ts
interface ProviderConfig {
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
}
```

Normal assembly follows this mental model:

| Config Source                        | Field Normally Maintained | Semantics                                       |
| ------------------------------------ | ------------------------- | ------------------------------------------------- |
| ZCode Built-in Provider Config       | `builtinModelIds`         | ZCode declared Built-in models and order          |
| Account Built-in Provider Config     | `builtinModelIds`         | Overrides Built-in model set when account API provides |
| Personal Provider Config             | `modelIds`                | User-added, deleted, renamed, and sorted Personal models |

This is field meaning and code maintenance principle, not a permission system. This task does not establish Source-specific Provider Config types, strict Source
Schema, cross-layer field rejection logic, or Config Service source permission checks.

Resolver keeps both sets and generates member Inventory in Built-in-first, Personal-last order. Personal-only Provider
naturally uses empty `builtinModelIds`; the settings page only modifies `modelIds`, without providing delete or reorder Built-in member interactions.

Fields maintain three-state in Config Overlay, normalized at Inventory boundary:

```text
undefined = this layer does not override
null      = this layer explicitly clears that source set
array     = this layer provides members and order

Final missing or null -> [] in Inventory
```

Thus empty sets are legal, not indicating incomplete Provider config; Personal-only Providers need not persist meaningless
`builtinModelIds: []`. Model IDs are trimmed at write boundary; empty values are illegal; Registry identity uses case-sensitive exact strings.

The current branch's Provider Config Schema has not yet been published; there is no v1 → v2 compatible task for internal `models[]`:

- Directly change current domain Schema, `official.json`, Personal writes, and test fixtures to final fields;
- Do not add adjacent schema migration; do not dual-read current development `models[]`;
- Existing pre-refactor legacy importer directly outputs final fields; it does not constitute current Provider Config version history.

### 2.2 Same ID Conflict

When the same Provider's `builtinModelIds` and `modelIds` contain the same ID, a `id-conflict` is formed:

- Do not silently delete Personal conflicts; execution identity uses Built-in-wins;
- Built-in X continues parsing, enters Registry, Selection/fallback, and ModelFactory;
- When parsing, only exclude precise Rules owned by conflicting Personal X; other general Personal Rules continue participating;
- Provider Settings display conflicts; users resolve by renaming Personal models or deleting Personal models;
- When saved Selection points to X, it continues resolving to Built-in X.

Normal model selectors do not display special conflict diagnostic items, do not add placeholder candidates for Automation, Subagent, or Repo Wiki, and do not expand
Selection Protocol to carry Settings navigation information.

Single-set internal duplicate IDs form `duplicate-membership`: do not silently dedupe; duplicate IDs merge into one Settings diagnostic item,
not parsed, not selected, not executed before fix; other models of the same Provider continue working. Member duplicates and cross-set conflicts are Model-level issues,
and cannot enter Provider general integrity issues and drag down the entire Provider.

### 2.3 Model `enabled` and `visibility`

Sparse Overlay fields added to top-level Model Config:

```ts
interface ModelConfig {
  enabled?: boolean | null;
  visibility?: "visible" | "hidden" | null;
  // properties / optionSpecs / reasoningMapping
}
```

Built-in general Rules provide complete default values `enabled=true`, `visibility="visible"`; Personal Rules can override or restore
inherited. Effective both fields must be complete.

`enabled=false` means the model is disabled by user:

- Settings still display and allow editing, re-enabling; cannot test during disabled state;
- Does not enter selection candidates, default selection, or fallback;
- Does not enter Registry executable index; exact ModelFactory creation and internal tasks cannot bypass;
- Already created Active Model is not terminated mid-flight by Config update; subsequently created Models obey new state.

Model `visibility` is symmetrical with Provider visibility: only filters user Settings/Selection Facade, does not prevent complete, enabled
models from entering Registry or being created exactly internally. Member relations, Provider/Model visibility, Provider/Model enabled,
completeness, and account authorization are different basic facts; `executable` / `selectable` are Resolver-derived results.

### 2.4 Settings Only Submit Sparse Personal Overlay

Settings View returns Effective baseline, Personal explicit config, Resolver-computed Inventory, conflicts, and integrity issues.
Renderer only maintains Personal Draft; does not copy Overlay, member combinations, or conflict algorithms; does not project Effective Config backward into
Personal Config.

Delete `saveEffectiveProvider()` / Effective → Personal reverse projection from normal settings chain; Legacy importer can
use one-time difference projection at its own read boundary, not entering the formal save protocol.

Normal candidate Renderer Draft only copies sparse Personal Config; Effective Config is only read-only inheritance baseline. User modifies
a config item for the first time before materializing that item; restoring defaults deletes Personal field. Conflict candidates have no normal Effective Draft; only provide read-only
Built-in candidate summary, old Personal precise config, and two atomic resolution operations.

## 3. Registry Complete Type Boundary

### 3.1 Sparsity Exists Only in Config Input

```text
Sparse Model Config Rule
├─ undefined = this Rule does not override
├─ null      = this Rule explicitly clears
└─ value     = this Rule provides value
             |
             v
       resolve + validateComplete
             |
       +-----+------------------+
       |                        |
       v                        v
Settings candidate       Registry publish
allow incomplete with issues     only accepts complete types
```

The following fields must be complete at Registry and downstream:

- Model `enabled`;
- Model `visibility`;
- `contextWindow`;
- `input_format` of Text/Image/Video/Audio/PDF boolean;
- `output_format.support_text`;
- `supportsToolCall`, `supportsJsonSchemaOutput`, `supportsNativeWebSearch`,
  `supportsMidConversationSystem`;
- `optionSpecs.maxOutputTokens`;
- Reasoning Spec non-empty when present, default within values, and each public level has a Mapping; ordering and deduplication are the config publisher's responsibility.

Reasoning Mapping can retain execution mappings `disabled`, `off`, `nothink`, `none` that do not appear in public values.

### 3.2 Registry Types

Retain existing sparse `ProviderConfig` and `ModelConfig` as Overlay types. The additions are only Registry publish types:

```ts
interface RegistryProviderConfig extends ProviderConfig {
  readonly access: CompleteProviderAccessConfig;
  readonly api: CompleteProviderApiConfig;
}

interface RegistryModelConfig extends ModelConfig {
  readonly enabled: boolean;
  readonly visibility: "visible" | "hidden";
  readonly properties: RegistryModelProperties;
  readonly optionSpecs: RegistryModelOptionSpecs;
}
```

They are not new Config Source, persisted Document, Overlay layer, or Runtime DTO. `requireComplete` successfully returns the same
Effective Config object, only tightening the static type without copying a new config fact, nor adding deep freeze.

Complete types must tighten serialized return values as well. Do not let the inherited sparse `toJSON(): ModelConfig` leak optional
Properties to Selection/Protocol again; implementation should override complete return type or provide unique `toRegistryJSON()`, without copying
a second config authority.

Provider Registry publishes `enabled=true` and complete Models, including hidden and Built-in Models with the same name as Personal;
Settings Resolution retains disabled, incomplete, duplicate, and suspended Personal conflicts. Post-Registry consumers
can no longer observe optional Properties or Option Specs.

Provider integrity only tightens execution-required facts: legal Access branches, API Type, and non-null Endpoint. `label`, `logoUrl`,
`visibility`, Headers, and other legal optional fields retain original semantics; member sets have already been projected as Registry `Provider.models`; execution
consumers do not re-read member fields to decide membership.

Todo 03 only establishes this single integrity boundary based on the Provider Access Schema existing at the time of initiation. Todo 07 introduces structured Account
Connection by strengthening `zhipu-account` on the same `CompleteProviderAccessConfig` / `requireComplete`. This task
does not prematurely implement connection, nor claim Account Access is finally closed.

### 3.3 Settings Candidate is a Branch Contract

```ts
type ProviderModelSettingsItem =
  | {
      kind: "candidate";
      modelId: ModelId;
      source: "builtin" | "personal";
      effectiveConfig: CompleteModelConfigObject;
      personalConfig?: ModelConfigObject;
      effectiveEnabled: boolean;
      effectiveVisibility: "visible" | "hidden";
      providerEnabled: boolean;
      providerVisibility: "visible" | "hidden";
      personalMembershipConflict?: {
        kind: "id-conflict";
        personalExactConfig?: ModelConfigObject;
      };
      issues: readonly ProviderConfigIssue[];
      executable: boolean;
      selectable: boolean;
    }
  | {
      kind: "membership-conflict";
      modelId: ModelId;
      sources: readonly ("builtin" | "personal")[];
      conflict: "duplicate-membership";
      personalExactConfig?: ModelConfigObject;
      issues: readonly ProviderConfigIssue[];
      executable: false;
      selectable: false;
    };
```

Cross-set same-name conflicts use `personalMembershipConflict` on Built-in candidate; Built-in still has real Effective Config;
single-set duplicates use the inexecutable conflict branch. Provider/Model enabled, visibility, completeness, and member identity are basic facts;
`executable` / `selectable` are derived results; UI can derive primary labels, but the domain layer does not compress to a single `status`.

### 3.4 Downstream Deleted Unknown States

Formal main chain deletes:

```ts
properties?.input_format?.support_image ?? false;
properties?.input_format?.support_text ?? true;
input_format?: ModelInputFormat;
properties?: ModelProperties;
if (allPropertiesPresent) protocol.properties = properties;
```

Also deletes:

- Bootstrap's `requireCompleteProperties()`, `requireCompleteOptionSpecs()`, and Provider required field duplicate proofs;
- Selection/Protocol silent omission of complete Properties;
- Settings fills `true/false` from missing Effective Property;
- Runtime capability map, and capability fallback inferred by Catalog, Provider type, Endpoint, or modelId.

One-time legacy importer can parse any old JSON but can only migrate facts that old files explicitly express; undeclared capabilities do not write
Personal Override, and continue to be filled by Built-in Rules. Importer cannot use migration-specific capability constants or infer values by model name, Provider,
or Endpoint.

## 4. Todo 02/03 Division of Labor

Todo 03 is responsible for business Provider Registry fact completeness:

- Final member fields, Inventory, conflicts, and Model `enabled` / `visibility`;
- `RegistryProviderConfig` / `RegistryModelConfig`;
- Resolver publish gate;
- Settings, Selection, Protocol, and ModelFactory consume complete or diagnostic views;
- Delete Bootstrap duplicate completeness proof for business Registry Config;
- Cut new Provider/Model main chain dependency on capability fallback.

Todo 02 is responsible for physical retirement of old execution Registry inside Adapter:

- Mutable Provider map and revision subscription;
- `replaceRegistryConfig()`;
- Adapter Registry's default Provider, bare Model ID fallback, and Connection reverse query;
- Adapter private old types, resources, and lifecycle.

Todo 03 can let old Adapter Registry temporarily continue existing, but it can only receive complete facts verified by business Registry. Todo 03
does not搬 (move) old Registry fields into new business abstraction.

## 5. Implementation Scope

### Step A: Config and Member Inventory

- Replace current `models` field directly with `builtinModelIds` / `modelIds`;
- Update Official, Account, Personal normal assembly and legacy importer final output;
- Add Model Config `enabled` / `visibility`, supplemented by Built-in general Rules;
- Resolver normalizes missing/null sets to empty arrays at Inventory boundary, combines members, and detects single-set duplicates and cross-set same ID
  conflicts; Account projection does not prematurely dedupe;
- Cross-set same-name publishes Built-in identity, and excludes conflicting Personal precise Rules; single-set duplicates do not enter Registry.

### Step B: Complete Types and Registry

- Define Registry complete types and unique `requireComplete` boundary in Provider package;
- Complete types' JSON/Protocol serialization returns complete static types, does not re-expose sparse Config;
- Retain Settings diagnostics; Registry accepts complete, enabled Built-in/Personal models and hidden models;
- Registry/ModelFactory exact creation, Selection, and fallback share the same index gate;
- Delete Bootstrap duplicate proof, non-null fallback, and silent omission.

### Step C: Settings, Protocol, and UI

- Settings View attaches Personal same-name conflicts to normal Built-in candidates; single-set duplicates use conflict branch; returns
  Provider/Model enabled, visibility, issues, and derived gates separately;
- Delete normal save entry from Effective → Personal; save interface directly submits sparse Personal Overlay;
- `builtinModelIds` is read-only in UI; `modelIds` supports adding, deleting, renaming, and sorting;
- `renamePersonalModel()` only determines ownership by Personal `modelIds`, and atomically moves precise Rules; new
  `deletePersonalModel()` atomically deletes members and their precise Rules;
- enabled toggle saves Personal precise Rules; restoring defaults deletes that leaf;
- Provider page maintains Built-in running state and testing; config editing is read-only during conflicts; provides Personal conflict resolution. Selector
  continues providing normal Built-in, excludes disabled/hidden;
- Connectivity Test uses model `executable` gate; cannot only check whether ID exists in Settings list;
- Normal Protocol Model Option input/output Properties are required fields;
- Settings Draft initialized from complete Effective Properties; hidden PDF/Audio retained as-is.

### Step D: Runtime Main Chain Cleanup

- Properties required throughout from Registry Model to ModelFactory;
- Active Model holds complete Properties as-is;
- Normal requests, Compact, Memory, Subagent, off-peak, and Adapter encoding only read Active Model;
- Delete Catalog/runtime capability merge and `?? true/false` from new main chain;
- Video still constrained by both Model Property and Adapter encoding capabilities; Audio does not gain unimplemented encoding entry from this;
- Physical retirement of Adapter old Registry completed by concurrently implemented Todo 02.

## 6. Tests First

### 6.1 Config and Inventory

1. After Built-in/Account updates `builtinModelIds`, Personal `modelIds` remains unchanged;
2. Personal-only Provider uses `modelIds`; empty Built-in set works normally;
3. Both sets maintain their own order; final Inventory is Built-in first, Personal last;
4. Single-set duplicate IDs produce inexecutable `duplicate-membership`; cross-set same IDs publish Built-in and suspend Personal;
5. Currently unpublished `models` field is not dual-read by formal Schema; legacy importer directly outputs final fields;
6. Config JSON round-trip preserves empty sets, null, and sparse Rules; Inventory normalizes final missing/null sets to `[]`;
7. Model ID is precise and case-sensitive after trim; Account model lists are not silently deduped.

Do not test "writing another field from a Source must error" because member ownership is normal code maintenance principle, not a Source permission system.

### 6.2 Resolver, Registry, enabled, and visibility

1. On dual-source same-name, Built-in X continues parsing, selecting, and creating; conflicting Personal precise Rules do not participate;
2. `enabled=false` models remain in Settings but do not enter Selection, fallback, or exact creation;
3. After restoring defaults, re-inherit Built-in `enabled` / `visibility`; hidden models can be created internally but do not enter user Facade;
4. Models missing any required Property/Option do not enter Registry;
5. Providers missing Access/API/Endpoint do not enter Registry;
6. Registry public types express complete Config statically; Config updates only affect subsequently created Models;
7. Reasoning Mapping covers all public levels, and allows retaining extra disabled mappings.

### 6.3 Settings, Protocol, and Runtime

1. Settings returns candidate/conflict branches and orthogonal gate facts; UI derives ready, disabled, incomplete, conflict,
   and only submits sparse Personal Overlay;
2. Built-in does not display delete/drag; same-name Built-in config is read-only but testable; conflicting Personal can be atomically renamed or deleted;
3. Personal conflicts resolved only in Settings, not forming normal candidates; existing X Selection continues pointing to Built-in X;
4. enabled auto-saves, failure rollback, restore defaults; disabled/incomplete/duplicate disables testing; same-name tests Built-in X;
5. Protocol normal candidates always carry complete input/output Properties;
6. UI does not fill defaults for missing capabilities; PDF/Audio hidden fields retained after editing;
7. Normal requests, Compact, Memory, Subagent, off-peak models all read this round's Active Model Properties;
8. Image/PDF/Video allow/deny remain consistent; Audio does not trigger unimplemented encoding.

Desktop, Web, and mobile share the same Settings/Selection Service; this task does not change remote workspace config sync product capabilities,
nor change continuous/replayable, queue, recovery, or workspace identity.

## 7. Non-Goals

- Account availability `unknown` and last-known-good;
- Account authentication, Request Auth, and Credential lifecycle;
- Todo 07's structured Account Connection, and `zhipu-account` final integrity strengthening;
- Telemetry, ModelRef, ModelConnectionPort cleanup;
- remote workspace config sync product capabilities;
- `modelContextBudget.strategy`, queue, and recovery;
- Audio content blocks, attachment entry, or Provider encoding implementation.

## 8. Completion Conditions

Mechanical zero:

```text
models[] in formal Provider Config                          = 0
currently unpublished Provider Config schema migration         = 0
Source-specific Provider Config types/cross-layer permission checks = 0
Effective/Registry Model enabled optional                     = 0
Effective/Registry Model visibility optional                  = 0
Registry/Selection/Protocol/Runtime format capability optional = 0
formal execution chain support_* ?? true / ?? false           = 0
Settings fills defaults from missing Effective Property        = 0
duplicate requireComplete post-Registry                       = 0
Bootstrap duplicate requiredString/field validation on Registry Provider Config = 0
Renderer computes Overlay, member conflicts, or Effective → Personal = 0
member lists silently Set-deduped before entering Inventory   = 0
Settings fakes second Effective Model Config for suspended Personal conflicts = 0
complete Registry Config serialization returns optional Properties = 0
normal model selector conflict diagnostic candidates          = 0
Legacy importer fills compatible constants or runtime inference for missing capabilities = 0
```

Behavioral acceptance:

- Built-in/Account new models not obscured by old Personal member lists;
- Users can manage Personal models and disable Built-in models via Model `enabled`;
- On same-name ID conflicts, Built-in continues execution; conflicting Personal precise Rules are suspended and resolved only in Settings;
- Single-set duplicates isolate only the corresponding ID and do not drag down the Provider;
- Model visibility is symmetrical with Provider, only affecting user Facade, not changing Registry execution qualification;
- Sparsity exists only in Rules, Personal Overlay, and Settings draft/candidate;

## 9. Implementation Result

- Provider members changed to `builtinModelIds` / `modelIds`; Account only constrains Built-in sets; Personal only maintains user sets;
- Resolver implemented source-aware Inventory: cross-set same-name preserves Built-in execution identity and suspends Personal precise Rules,
  single-set duplicates isolate corresponding models only;
- Model `enabled` / `visibility`, complete Registry types, and single integrity gate have been landed; post-Registry Models,
  Selection, and protocols no longer accept optional format facts;
- Settings changed to directly edit sparse Personal Overlay. Built-in members cannot be deleted or reordered; conflicting Personal members can only
  be atomically renamed or deleted; model enabled can override and restore inheritance;
- Legacy importer only migrates members, formats, limits, and reasoning mappings that old files explicitly declare; no longer infers capabilities by model name, Provider type
  or Endpoint;
- Config updates only affect subsequently created Models; created Models continue holding complete static facts from creation time.
- Registry, Selection, ModelFactory, and Runtime only observe complete model facts;
- Created Models are not hot-swapped by Config updates;
- Concurrently implemented Todo 02 has deleted Adapter Registry abstraction; Todo 03 has not copied its fields or query surface into business Registry.

## 10. Verification

At minimum, execute:

```bash
pnpm test:unit:affected
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

UI changes also require executing Provider Settings/Model Selection related Desktop E2E, and verifying mobile Web responsive layouts. Use
`pnpm dep:refs` and `rg` to audit whether optional capability, Catalog fallback, old `models[]`, and Effective → Personal
entries are zeroed. If full `knip` contains repository noise, still independently record audit results for this task's symbols.
