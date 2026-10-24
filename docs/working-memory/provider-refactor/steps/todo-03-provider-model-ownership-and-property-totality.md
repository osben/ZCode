# 03 Provider Model Members, Enable/Disable, Visibility, and Registry Completeness Closure

> Status: Completed
>
> Historical note: the `builtinModelIds/modelIds` members and Properties completeness completed here remain valid; Model
> `enabled/visibility`, duplicate member conflicts and settings interactions were re-decided by
> [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md).
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Target design: [`../design/registry/model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md),
> [`../design/registry/configuration.md`](../design/registry/configuration.md),
> [`../design/model/input-output-format.md`](../design/model/input-output-format.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-03-provider-model-ownership-and-property-totality.md`

## 1. Objective

Close three groups of same-origin issues: (1) `builtinModelIds` and `modelIds` separately express management models and
Personal model members so a Personal-saved old list cannot obscure later-added Built-in/Account models; (2) Model Config
gets `enabled` and `visibility` (execution gate vs user entry visibility); (3) Config sparse boundaries close when the
Resolver publishes to the Registry so Registry, Selection, ModelFactory and Runtime observe only complete model facts.

Flow: ZCode Built-in Provider Config -> overlay Account Built-in Provider Config -> Effective Built-in Provider Config
-> overlay Personal Provider Config -> Effective Provider Config (`builtinModelIds`, `modelIds`) combined with
Effective Model Config Rules (ZCode Built-in Model Config Rules + Personal Model Config Rules) -> source-aware Model
Inventory (executable candidate; disabled / incomplete / duplicate; Built-in candidate + Personal id-conflict
diagnostic) -> `RegistryProviderConfig` / `RegistryModelConfig` -> Selection Facade and ModelFactory -> Active
Model.properties. No compatible DTO, Runtime capability map, Renderer Overlay or new configuration authority is added.

## 2. Confirmed Decisions

**2.1 Member fields.** `ProviderConfig` has `builtinModelIds?: readonly string[] | null` and
`modelIds?: readonly string[] | null`. Conventional maintenance: ZCode Built-in and Account Built-in Provider Config
maintain `builtinModelIds` (ZCode declared models and order; Account overrides the Built-in set when the account API
provides one); Personal maintains `modelIds` (user-added, deleted, renamed, sorted models). This is a field-meaning and
code-maintenance principle, not a permission system: no Source-specific Provider Config types, strict Source Schema,
cross-layer field rejection or Config Service source permission checks. The Resolver keeps both sets and generates the
member Inventory Built-in first, Personal last. Personal-only Providers use empty `builtinModelIds`; the settings page
modifies only `modelIds` (no delete or reorder of Built-in members). Config Overlay three-state: `undefined` = this layer
does not override; `null` = explicitly clears that source set; array = provides members and order; final missing or
`null` normalizes to `[]` in the Inventory. Empty sets are legal and do not make a Provider incomplete; Model IDs are
trimmed at the write boundary, empty values are illegal, Registry identity is case-sensitive exact string.

The Provider Config Schema was not yet published, so there is no v1 -> v2 task for internal `models[]`: change the
domain Schema, `official.json`, Personal writes and test fixtures directly to the final fields; no adjacent schema
migration and no dual-read of development `models[]`; the pre-refactor legacy importer outputs final fields directly
(it is not Provider Config version history).

**2.2 Same-ID conflict.** The same ID in a Provider's `builtinModelIds` and `modelIds` forms `id-conflict`: Personal
conflicts are not silently deleted; execution identity is Built-in-wins (Built-in X parses, enters Registry,
Selection/fallback and ModelFactory); parsing excludes only precise Rules owned by the conflicting Personal X (other
general Personal Rules still participate); Provider Settings shows the conflict and users resolve it by renaming or
deleting the Personal model; a saved Selection pointing at X resolves to Built-in X. Normal model selectors show no
conflict diagnostic items, add no placeholder candidates for Automation / Subagent / Repo Wiki, and the Selection
Protocol does not carry Settings navigation information. Duplicate IDs inside one set form `duplicate-membership`: no
silent dedupe; duplicate IDs merge into one Settings diagnostic item and are not parsed, selected or executed until
fixed; other models of the Provider keep working. Member duplicates and cross-set conflicts are Model-level issues and
never enter Provider-general integrity issues.

**2.3 Model `enabled` and `visibility`.** Top-level Model Config sparse Overlay fields `enabled?: boolean | null` and
`visibility?: "visible" | "hidden" | null`; Built-in general Rules supply complete defaults `enabled=true`,
`visibility="visible"`; Personal Rules can override or restore inherited; Effective values must be complete.
`enabled=false` (disabled by user): Settings still shows and allows editing / re-enabling (no testing while disabled);
not in selection candidates, default selection or fallback; not in the Registry executable index (exact ModelFactory
creation and internal tasks cannot bypass); an already created Active Model is not terminated mid-flight by Config
updates, later Models obey the new state. Model `visibility` mirrors Provider visibility: it only filters the user
Settings/Selection Facade and does not stop complete, enabled models entering the Registry or being created exactly
internally. Membership, Provider/Model visibility, Provider/Model enabled, completeness and account authorization are
different basic facts; `executable` / `selectable` are Resolver-derived.

**2.4 Settings submit a sparse Personal Overlay only.** The Settings View returns the Effective baseline, Personal
explicit config, Resolver-computed Inventory, conflicts and integrity issues. The Renderer maintains only a Personal
Draft (no Overlay, member combination or conflict algorithms; no Effective -> Personal projection). `saveEffectiveProvider()`
and the Effective -> Personal reverse projection are deleted from the normal settings chain (the Legacy importer may do
one-time difference projection at its own read boundary). The normal-candidate Draft copies sparse Personal Config;
Effective Config is a read-only inheritance baseline; a config item is materialized on first modification; restore
defaults deletes the Personal field. Conflict candidates have no normal Effective Draft: only a read-only Built-in
summary, old Personal precise config and two atomic resolution operations.

## 3. Registry Complete Type Boundary

**3.1 Sparsity exists only in Config input** (`undefined` = no override, `null` = explicit clear, value = provides
value) -> `resolve + validateComplete`: Settings candidates allow incompleteness with issues; Registry publish accepts
only complete types. Required complete at Registry and downstream: Model `enabled`, `visibility`, `contextWindow`,
`input_format` of Text/Image/Video/Audio/PDF booleans, `output_format.support_text`, `supportsToolCall`,
`supportsJsonSchemaOutput`, `supportsNativeWebSearch`, `supportsMidConversationSystem`,
`optionSpecs.maxOutputTokens`; Reasoning Spec non-empty when present, default within values, each public level having a
Mapping (ordering and deduplication are the publisher's responsibility). Reasoning Mapping may retain execution
mappings `disabled`, `off`, `nothink`, `none` that do not appear in public values.

**3.2 Registry types.** Existing sparse `ProviderConfig` / `ModelConfig` remain Overlay types. Added publish types:

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

They are not a new Config Source, persisted Document, Overlay layer or Runtime DTO; `requireComplete` returns the same
Effective Config object (static type tightening only, no copy, no deep freeze). Serialized return values must tighten
too: override the complete return type or provide a unique `toRegistryJSON()` instead of the inherited sparse
`toJSON(): ModelConfig` (which would leak optional Properties to Selection/Protocol). The Registry publishes
`enabled=true` complete Models, including hidden and Built-in Models with the same name as a Personal one; Settings
Resolution retains disabled, incomplete, duplicate and suspended Personal conflicts. Provider integrity tightens only
execution-required facts (legal Access branches, API Type, non-null Endpoint); `label`, `logoUrl`, `visibility`,
Headers and other optional fields keep their semantics; member sets are already projected into Registry
`Provider.models` and execution consumers do not re-read member fields. Todo 03 establishes the single integrity
boundary on the Access Schema existing at that time; Todo 07 strengthens `zhipu-account` on the same
`CompleteProviderAccessConfig` / `requireComplete` (this task does not claim Account Access is finally closed).

**3.3 Settings candidate is a branch contract:**

```ts
type ProviderModelSettingsItem =
  | { kind: "candidate"; modelId: ModelId; source: "builtin" | "personal";
      effectiveConfig: CompleteModelConfigObject; personalConfig?: ModelConfigObject;
      effectiveEnabled: boolean; effectiveVisibility: "visible" | "hidden";
      providerEnabled: boolean; providerVisibility: "visible" | "hidden";
      personalMembershipConflict?: { kind: "id-conflict"; personalExactConfig?: ModelConfigObject };
      issues: readonly ProviderConfigIssue[]; executable: boolean; selectable: boolean }
  | { kind: "membership-conflict"; modelId: ModelId; sources: readonly ("builtin" | "personal")[];
      conflict: "duplicate-membership"; personalExactConfig?: ModelConfigObject;
      issues: readonly ProviderConfigIssue[]; executable: false; selectable: false };
```

Cross-set same-name conflicts use `personalMembershipConflict` on the Built-in candidate (still with real Effective
Config); single-set duplicates use the inexecutable conflict branch. Enabled, visibility, completeness and member
identity are basic facts; `executable` / `selectable` are derived; UI may derive primary labels but the domain does not
compress to one `status`.

**3.4 Downstream unknown states deleted:** `properties?.input_format?.support_image ?? false`,
`support_text ?? true`, `input_format?: ModelInputFormat`, `properties?: ModelProperties`,
`if (allPropertiesPresent) protocol.properties = properties`; Bootstrap `requireCompleteProperties()`,
`requireCompleteOptionSpecs()` and Provider required-field duplicate proofs; Selection/Protocol silent omission of
complete Properties; Settings filling `true/false` from missing Effective Property; Runtime capability map and
capability fallback inferred by Catalog, Provider type, Endpoint or modelId. The one-time legacy importer migrates only
facts old files explicitly express (undeclared capabilities write no Personal Override and are filled by Built-in
Rules); no migration-specific capability constants or inference by model name, Provider or Endpoint.

## 4. Todo 02/03 Division of Labor

Todo 03: business Provider Registry fact completeness (final member fields, Inventory, conflicts, Model `enabled` /
`visibility`; `RegistryProviderConfig` / `RegistryModelConfig`; Resolver publish gate; Settings, Selection, Protocol and
ModelFactory consume complete or diagnostic views; delete Bootstrap duplicate completeness proof; cut capability
fallback from the new main chain). Todo 02: physical retirement of the old execution Registry inside the Adapter (mutable
Provider map and revision subscription, `replaceRegistryConfig()`, default Provider, bare Model ID fallback, Connection
reverse query, Adapter private old types/resources/lifecycle). The old Adapter Registry may temporarily coexist but only
receives complete facts verified by the business Registry; Todo 03 does not move old Registry fields into the new
business abstraction.

## 5. Implementation Scope

- **A Config and members:** replace `models` with `builtinModelIds` / `modelIds`; update Official, Account, Personal
  assembly and legacy importer output; add Model `enabled` / `visibility` with Built-in general Rules; the Resolver
  normalizes missing/null to `[]`, combines members, detects single-set duplicates and cross-set conflicts (Account
  projection does not dedupe early); cross-set same name publishes Built-in identity and excludes conflicting Personal
  precise Rules; single-set duplicates do not enter the Registry.
- **B Complete types and Registry:** Registry complete types and the unique `requireComplete` boundary in the Provider
  package; complete types' JSON/Protocol serialization returns complete static types; Settings keeps diagnostics while
  the Registry accepts complete, enabled Built-in/Personal and hidden models; Registry/ModelFactory exact creation,
  Selection and fallback share the same index gate; delete Bootstrap duplicate proofs, non-null fallback and silent
  omission.
- **C Settings, Protocol, UI:** attach Personal same-name conflicts to Built-in candidates (single-set duplicates use
  the conflict branch), return Provider/Model enabled, visibility, issues and derived gates separately; the save
  interface submits a sparse Personal Overlay directly; `builtinModelIds` read-only, `modelIds` supports add / delete /
  rename / sort; `renamePersonalModel()` determines ownership by Personal `modelIds` and atomically moves precise Rules;
  new `deletePersonalModel()` deletes members and their precise Rules atomically; enabled toggle saves Personal precise
  Rules (restore defaults deletes the leaf); the Provider page keeps Built-in running state and testing, config editing
  read-only during conflicts, Personal conflict resolution available, the selector excludes disabled/hidden;
  Connectivity Test uses the model `executable` gate (not merely ID existence); Protocol Model Option input/output
  Properties are required; Settings Draft initializes from complete Effective Properties and keeps hidden PDF/Audio.
- **D Runtime cleanup:** Properties are required from Registry Model through ModelFactory and Active Model; normal
  requests, Compact, Memory, Subagent, off-peak and Adapter encoding read only the Active Model; delete Catalog/runtime
  capability merge and `?? true/false` from the new main chain; Video stays constrained by both Model Property and
  Adapter encoding capability; Audio gains no unimplemented encoding entry.

## 6. Tests

- **Config and Inventory:** Built-in/Account `builtinModelIds` updates leave Personal `modelIds` unchanged;
  Personal-only Providers use `modelIds` with an empty Built-in set; each set keeps its own order, final Inventory
  Built-in first; single-set duplicates give inexecutable `duplicate-membership`, cross-set same IDs publish Built-in
  and suspend Personal; unpublished `models` is not dual-read; legacy importer outputs final fields; Config JSON
  round-trip preserves empty sets, null and sparse Rules; trimmed case-sensitive Model IDs; Account lists not silently
  deduped. (Do not test "writing another field from a Source must error": ownership is a maintenance principle.)
- **Resolver, Registry, enabled, visibility:** dual-source same name keeps Built-in X parsing/selecting/creating with
  conflicting Personal precise Rules excluded; `enabled=false` models stay in Settings but not Selection, fallback or
  exact creation; restoring defaults re-inherits Built-in `enabled`/`visibility`; hidden models can be created
  internally but are not in the user Facade; models missing any Property/Option and Providers missing
  Access/API/Endpoint do not enter the Registry; Registry public types express complete Config statically; Config
  updates affect only later Models; Reasoning Mapping covers all public levels and may keep extra disabled mappings.
- **Settings, Protocol, Runtime:** candidate/conflict branches and orthogonal gate facts, UI derives ready / disabled /
  incomplete / conflict and submits sparse Personal Overlay only; Built-in has no delete/drag, same-name Built-in config
  read-only but testable, conflicting Personal atomically renamed or deleted; existing X Selection stays on Built-in X;
  enabled auto-saves, failure rollback, restore defaults; disabled/incomplete/duplicate disables testing, same-name
  tests Built-in X; Protocol candidates always carry complete input/output Properties; UI does not fill defaults for
  missing capabilities and keeps hidden PDF/Audio; all execution paths read the Active Model's Properties; Image/PDF/
  Video allow/deny consistent; Audio triggers no unimplemented encoding. Desktop, Web and mobile share the same
  Settings/Selection Service; remote workspace config sync, continuous/replayable, queue, recovery and workspace
  identity are unchanged.

## 7. Non-Goals

Account availability `unknown` / last-known-good; Account authentication, Request Auth and Credential lifecycle; Todo
07's structured Account Connection and `zhipu-account` final integrity strengthening; Telemetry, ModelRef,
ModelConnectionPort cleanup; remote workspace config sync product capabilities; `modelContextBudget.strategy`, queue
and recovery; Audio content blocks, attachment entry or Provider encoding.

## 8. Completion Conditions

Mechanical zero: `models[]` in formal Provider Config; unpublished Provider Config schema migration; Source-specific
Provider Config types / cross-layer permission checks; optional Effective/Registry Model `enabled` / `visibility`;
optional format capability in Registry/Selection/Protocol/Runtime; `support_* ?? true / ?? false` in the formal
execution chain; Settings filling defaults from missing Effective Property; duplicate `requireComplete` after the
Registry; Bootstrap duplicate required-field validation on Registry Provider Config; Renderer computing Overlay /
member conflicts / Effective -> Personal; member lists silently Set-deduped before Inventory; Settings faking a second
Effective Model Config for suspended Personal conflicts; complete Registry Config serialization returning optional
Properties; normal selector conflict diagnostic candidates; Legacy importer filling compatible constants or runtime
inference for missing capabilities.

Behavior: Built-in/Account new models are not obscured by old Personal member lists; users manage Personal models and
disable Built-in models via Model `enabled`; on same-name ID conflict Built-in continues executing and the conflicting
Personal precise Rules are suspended and resolved only in Settings; single-set duplicates isolate only the affected ID;
Model visibility mirrors Provider (user Facade only, no change to Registry execution qualification); sparsity exists
only in Rules, Personal Overlay and Settings draft/candidate; Registry, Selection, ModelFactory and Runtime observe only
complete facts; created Models are not hot-swapped by Config updates; Todo 02 (done concurrently) deleted the Adapter
Registry abstraction and Todo 03 did not copy its fields or query surface into the business Registry.

## 9. Implementation Result and Verification

Providers use `builtinModelIds` / `modelIds` (Account constrains only Built-in sets; Personal maintains user sets); the
Resolver implements source-aware Inventory; Model `enabled` / `visibility`, complete Registry types and the single
integrity gate landed; Settings edits a sparse Personal Overlay directly (Built-in members cannot be deleted or
reordered; conflicting Personal members can only be atomically renamed or deleted; model enabled can override and
restore inheritance); the legacy importer migrates only explicitly declared members, formats, limits and reasoning
mappings.

Verification: `pnpm test:unit:affected`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm knip`; UI changes also
need Provider Settings/Model Selection Desktop E2E and mobile Web responsive checks; audit with `pnpm dep:refs` and
`rg` that optional capability, Catalog fallback, old `models[]` and Effective -> Personal entries are zeroed (if full
`knip` has repository noise, still record this task's symbols independently).
