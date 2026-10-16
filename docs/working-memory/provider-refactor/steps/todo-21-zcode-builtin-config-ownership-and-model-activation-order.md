# 21 ZCode Built-in Config, Model Activation, Sorting, and Settings Consolidation

> Status: Completed (subsequent Todo 23 has removed the last Compatibility Config)
>
> Date: 2026-08-26
>
> Related tasks: [`02`](./todo-02-ai-sdk-execution-registry-retirement.md),
> [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md),
> [`17`](./todo-17-provider-registry-settings-authority-boundary-closure.md),
> [`18`](./todo-18-zcode-builtin-client-config-sync-and-lkg.md),
> [`22`](./todo-22-additional-builtin-providers-and-cloud-access.md)
>
> Related design: [`design.md`](../design/design.md),
> [`provider-and-model-configuration-overview.md`](../design/registry/provider-and-model-configuration-overview.md),
> [`configuration.md`](../design/registry/configuration.md),
> [`model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md),
> [`settings.md`](../design/registry/settings.md),
> [`registry.md`](../design/registry/registry.md),
> [`request-compatibility-and-access-protocols.md`](../design/registry/request-compatibility-and-access-protocols.md)

## 0. Task Positioning

This Todo is responsible for consolidating the existing ZCode Built-in Provider Config and Built-in Model Config Rules, and
consolidating the Provider/Model Settings page into a single set of domain facts. The goal is not to add a compatibility layer
to the old implementation, but to make Built-in Config the sole source of static model and API facts,
let Settings edit only Personal Config, and let Registry consume only the final resolved result.

This Todo is the authoritative implementation Spec during the current implementation cycle. It is not required to mechanically
synchronize all content to the Design Tree and Feature Graph before development; after implementation,
a full synchronization should be made against the finalized types, service boundaries, and UI entry points, and conflicting
old documents should be explicitly updated or marked as superseded. This synchronization is the completion gate for this Todo
and cannot be deferred to subsequent tasks.

Implementation must faithfully execute the already-decided domain and product design, and must not alter the design merely for
local implementation convenience, reuse of existing components, or minimizing current changes. When facing ordinary
implementation ambiguity, local correctness conflicts, or new facts in the target mode, prioritize the solution closest to
existing decisions, with minimal impact and reversibility, and record the decisions and evidence; design adjustments should
only be discussed after the target is complete. Do not automatically escalate temporary trade-offs into new designs. Only
irreversible damage, the need for new external permissions, or any candidate violating core goals should block the goal.

Not included in this Todo:

- Client Config public service refactoring; Todo 18 handles only the minimal integration for the current Built-in Release;
- OpenRouter, OpenCode Zen, Azure, Volcano Ark, AWS Bedrock; see Todo 22;
- Google Gemini and Vertex AI; not currently supported;
- Off-Peak structured error refactoring; this round only adjusts config ownership;
- Rebuilding old Catalog, Preset, or Adapter Registry;
- Heavy migration audits per commit or per leaf.

### Implementation Results (2026-08-26)

- Five Source Schema, Provider group, structured `provider-model` Rule, Model `enabled`, Builtin-wins, and explicit Provider/Model
  ordering have entered the official Config/Resolver/Facade/Repository pipeline; Personal persistent fields are consolidated to `modelConfigRules`.
- Built-in Release has atomically switched `account:` account Providers; Z.ai/BigModel Family and regular API Providers are separated; Off-Peak
  is split into two hidden Family Providers; Account Overlay determines connection constraints, available members, and corresponding Provider enabled.
- Settings directly consumes Host's group, addition candidates, full ordering, member source, and executable/selectable results; Provider ID is read-only,
  Model full editing saves as sparse Personal-only Rule, with inherited values, overridden values, and inheritance restoration having clear interactions.
- Official release request security validation and Off-Peak execution protocol have been folded into Provider Access; old reasoning/output-token/Provider-ID
  runtime compatibility and Renderer ID whitelist have been deleted. Subsequent Todo 23 further deleted the last Compatibility Config and synthetic
  empty-thinking projection.
- Design Tree, Feature Graph, and historical Todo superseded annotations have been synchronized to the final implementation.

This implementation validates: Provider core directed tests 255 passed, root `typecheck`, `lint`, Desktop E2E typecheck, modified file format check, and
`git diff --check` passed; root unit tests 12,416 passed, with 2 additional items failing due to missing external `zip` command in the current Linux environment, all located in
`zcode-server-cli` Windows ZIP packaging/installation tests, unrelated to Provider changes. Real requests and official E2E execute per the final Release Checklist.

## 1. Final Dual-Path Configuration

```text
Provider Config Path                         Model Config Path
====================                       =================

ZCode Built-in Provider Config             ZCode Built-in Model Config Rules
              |                                         +
              v                                         |
Account Built-in Provider Config           Personal Model Config Rules
              |                                         |
              v                                         v
Personal Provider Config                   Effective Model Config Rules
              |                                         |
              v                                         |
Effective Provider Config                              |
├─ group / label / logo                                |
├─ enabled / visibility                                |
├─ api / access                                        |
├─ builtinModelIds / modelIds                          |
└─ modelOrder                                          |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  v
                       Effective Model Config
                       ├─ enabled
                       ├─ properties
                       ├─ optionSpecs
                       ├─ reasoningMapping
                       └─ confirmed narrow request encoding facts
                                  |
                                  v
                    Integrity and execution qualification validation
                                  |
                                  v
                         Provider Registry
                                  |
                                  v
                       ModelFactory -> Model -> Adapter
```

Provider Config determines Provider identity, access method, members, and display order. Model Config determines whether a model is enabled, what capabilities it has,
which options are allowed, and how options are encoded. Model Rules cannot create members; Provider member arrays cannot declare model capabilities.

Overlay is a natural, reusable configuration composition semantics and mechanism, responsible for inheritance, overriding, and clearing of the same configuration slot. Provider/Model domain uses it
to implement its own configuration space, member composition, default state, and lifecycle semantics. Overlay is not a universal abstraction that can naturally support all business semantics; structure must
first serve the domain model, then reuse Overlay for cross-layer composition.

## 2. Five Source Schema

Five input sources each have strict Schema, but after entering the domain they share Provider Config, Model Config, and Overlay language; no five sets of Runtime
DTOs are created.

| Source                            | Writable facts                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| ZCode Built-in Provider Config    | Provider group, identity, display, API/Access template, `builtinModelIds`, Provider default state and declared order |
| Account Built-in Provider Config  | Account Provider Access/connection constraints, Provider enabled, `builtinModelIds` when server actually returns |
| Personal Provider Config          | `standard-personal` new Provider, or API/Access/status Overlay for existing Provider; `modelIds/order` |
| ZCode Built-in Model Config Rules | Complete Model defaults, model/API/Provider/Endpoint specialization, official default enable/disable |
| Personal Model Config Rules       | User's single-model specific overrides, and user-written generic Match Rules |

Strong constraints:

- Personal Overlay cannot rewrite `group` for existing Providers; Personal-only root declarations must `group=standard-personal`;
- Personal Provider Config cannot write `builtinModelIds`;
- Account only constrains Built-in account Providers, does not read or modify Personal-only Providers;
- Account does not write Model Config, does not provide context, format, reasoning, and other model static facts;
- Personal Provider's `modelIds` is prohibited from containing IDs in the current Effective `builtinModelIds`; on reading duplicate hand-written entries, Built-in-wins,
  saving related Providers automatically clears them from Personal arrays;
- Source Schema is responsible for structure and field ownership; whether the server ultimately authorizes is still determined by actual requests.

The target boundaries for the five Sources are further fixed as:

| Source                     | Must/Allow                                                                                                                                                            | Explicitly Prohibited                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ZCode Built-in Provider    | Each root declaration must provide `standard-builtin`, `zai-family`, or `bigmodel-family` group; label/logo, enabled, visibility, API, Access template, `builtinModelIds` are allowed | `standard-personal`, `modelIds`, `modelOrder`, `providerOrder` |
| Account Built-in Provider  | Can only override existing ZCode Built-in Family Providers; enabled, structured Account Access, `builtinModelIds` when interface actually returns are allowed                   | group, display fields, visibility, API, Personal members/order, Model Config                      |
| Personal Provider          | Root allows `providerOrder`; existing Provider Overlay allows label, enabled, visibility, API, Access, `modelIds/modelOrder`; Personal-only root must `group=standard-personal` | `builtinModelIds`; rewriting group for existing Providers                                      |
| ZCode Built-in Model Rules | `provider-model` and `match`; complete Model Config, official enabled defaults, and evidence-confirmed Built-in-only narrow compatibility facts are allowed                     | Provider members, order, Access, dynamic credentials                                           |
| Personal Model Rules       | `provider-model` and `match`; user-overridable Model Config sparse fields are allowed                                                                                   | Provider members/order, Access, product protocols not allowed for Personal override, pending Compatibility |

Structure parsing and semantic validation are two steps: single-file Parser strictly rejects unknown fields; constraints requiring knowledge of "whether this ID comes from Built-in" are completed by Source
assembly validation. Unreleased development middle Rules are directly rejected without adding dual-read or schema migration; truly published
old configs are converted only within the Legacy importer private boundary.

## 3. Provider Config

```ts
interface ProviderConfig {
  group?: "standard-builtin" | "standard-personal" | "zai-family" | "bigmodel-family" | null;
  label?: string | null;
  enabled?: boolean | null;
  visibility?: "visible" | "hidden" | null;
  api?: ProviderApiConfig | null;
  access?: ProviderAccessConfig | null;
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
}
```

Provider top-level `enabled` is the execution gate: disabled Providers do not enter Registry, fallback, selector, or exact creation.
`visibility=hidden` only hides normal Settings/Selection; complete and enabled hidden Providers can still be used by internal products by exact ID.
Providers do not save `selectable`.

`group` is a simple, explicit Provider product organization fact, not a substitute for execution capability, Access type, or visibility:

```text
standard-builtin
└─ Providers provided by ZCode templates, configured by users
   └─ Participate in "add supplier" candidates and normal providerOrder

standard-personal
└─ Personal-only Providers created from scratch by users
   └─ Participate in normal providerOrder

zai-family / bigmodel-family
└─ Product providers fixed to corresponding account families
   ├─ Do not participate in normal Provider dragging
   └─ Settings UI does not provide Provider enable/disable operations
```

Renderer no longer infers grouping from Provider ID whitelist, Access type, or Endpoint. ZCode Built-in root declarations must explicitly provide non-Personal
group; Personal-only Providers are fixed to `standard-personal`; Account/Personal Overlay has no authority to change existing Provider grouping.
Providers no longer save extra `builtin` boolean; complete `group` simultaneously expresses normal Built-in, Personal-only, and two account families.
`visibility` continues to independently express whether visible to normal users, `enabled` continues to independently express whether executable.

Normal external Built-in Providers default to `enabled=false`. When users select it from "Add Supplier," a Personal Overlay is immediately created and
`enabled=true` is written. Built-in means maintained by ZCode internally, not that it uses a ZCode account, already has credentials, or is available by default.

`enabledModelIds` is not adopted. Providers only maintain model members and order; model enable/disable is handled by Model Config.

## 4. Model Members and Builtin-wins

```text
builtinModelIds
└─ ZCode/Account Built-in owned members

modelIds
└─ User-owned Personal members
```

Member sets are produced only from both. When Builtin and Personal share an ID, only one Built-in member is retained; single-array duplicates retain the first occurrence. On reading,
deterministic ignoring of duplicate latter items, no conflicting DTOs are created, and Built-in models are not blocked. Normal UI prohibits creating duplicates; saving related Providers automatically
normalizes duplicates and invalid members.

Deleting Built-in Models is not allowed; the list does not show a delete button. Personal Models can be deleted or have their ID modified. Provider IDs are
non-modifiable under any circumstances; Provider Name/label can be modified and is case-insensitive unique after trimming.

## 5. Model Config `enabled`

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: Readonly<Record<string, ReasoningParameters>> | null;
  requiresMfjsToolSchema?: boolean | null;
}
```

Models no longer have independent `visibility`. The sole semantic of `enabled` is the model execution gate:

```text
Effective Provider enabled
AND Provider complete
AND model is Effective Provider member
AND Effective Model Config enabled
AND Model Config complete
        |
        v
Executable Model (enters Registry)
        |
        + Provider visibility=visible
        v
Selectable Model (enters normal selector)
```

disabled models remain in Settings, preserving configuration and order, but cannot be tested, used for fallback, exactly created, or bypassed by any internal tasks. Already-created
immutable Models are not affected by config refresh; subsequent creations respect the new state.

Built-in general Rules must provide complete default `enabled=true`. Official releases can use more specific and later Built-in Rules to set older models to
`enabled=false`. Personal Rules always follow Built-in Rules; users can explicitly override; "restore defaults" deletes Personal `enabled`
leaves and re-inherits from Built-in.

When normally adding a new Personal Model, members, order, and specific Rule `enabled=true` are atomically saved. This way user-added models immediately express explicit enable intent,
while user hand-written, ungenerated members still resolve according to Built-in complete fallback.

## 6. Provider/Model Specific Rules and Generic Match Rules

```ts
type ModelConfigRule =
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    }
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    };
```

`provider-model` can belong to Built-in or Personal Source: Built-in uses it to declare official facts for a precise Provider/Model combination;
Personal uses it to carry exact overrides for Built-in or Personal Models from the settings page. Only Personal-specific Rules follow the user lifecycle:

- Created or updated when toggling enabled, editing Properties/Options/Reasoning;
- Atomically moved with members and order when Personal Model is renamed;
- Deleted when Personal Model is deleted;
- When deleting a Provider Personal Overlay, all specific Rules for that Provider are deleted;
- Empty Rules are deleted after the last overridden field is restored.

`match` can belong to Built-in or Personal Source, for a group of targets. Provider/Model deletion, renaming, deduplication do not automatically rewrite or delete
any Match Rules, nor modify Built-in-specific Rules. Specific Rules use structured IDs and do not rely on regex to express "exactness," nor introduce ambiguous
`exclusive` booleans.

Built-in Rules continue to use matchers, and can select the minimal sufficient condition based on real differences of model, Provider, API, or normalized baseURL.

## 7. Model and Provider Order

Model base order is fixed in three segments:

```text
Built-in Models not appearing in modelOrder
                  +
all valid members still in modelOrder
                  +
Personal Models not appearing in modelOrder
```

Therefore, newly released but user-not-yet-ordered Built-in Models default to the front. Normal UI new Personal Models materialize all current valid members
into `modelOrder`, so "unsorted Personal" only handles user hand-written or abnormal input.

On each real order save:

1. Retain current valid members;
2. Delete stale and duplicate IDs, retaining the first for duplicates;
3. Add all missing members;
4. Save complete `modelOrder`.

disabled models still participate in Settings order; Selection filtering preserves the relative order of remaining models.

Providers use Personal top-level `providerOrder`, no longer relying on Map insertion order tricks. It follows the same "unsorted Built-in first,
explicit order middle, unsorted Personal back" principle; each new addition or reorder materializes the current complete normal Provider order. Z.ai/BigModel Family
keeps fixed product organization and does not participate in normal Provider dragging.

Personal persistent shell goal:

```ts
interface PersonalProviderConfigFile {
  schemaVersion: 1;
  providerOrder?: readonly string[];
  providers: Record<string, PersonalProviderConfig>;
  modelConfigRules: readonly PersonalModelConfigRule[];
}
```

`providerOrder` is the Personal Source's own collection semantics, not participating in Provider field Overlay. ZCode Built-in Provider base order continues
from Release's Provider Map declaration order; Account does not provide order. This branch is not yet released, so the existing ambiguous `models` storage field is directly
renamed to `modelConfigRules`, without adding migration for development middle formats; Legacy importer outputs final fields.

## 8. Settings: Provider Add, Enable/Disable, and Delete

Fixed order in Provider navigation: Z.ai/BigModel Account Families are at the front; "Add Supplier" and "Create Custom Provider" two fixed operations
follow; normal `standard-builtin` and `standard-personal` Provider lists are after the operations. The two operations do not participate in `providerOrder`
or dragging.

```text
Add Supplier
└─ candidates = visible + group=standard-builtin - Personal Provider Map keys
   └─ Click immediately creates Personal Overlay(enabled=true) and enters editing

Create Custom Provider
└─ First obtain unique and unmodifiable providerId and unique label
   └─ Immediately create group=standard-personal, enabled=true Personal-only Provider
      ├─ access.type=api
      ├─ Do not prefill api.type, baseURL, or models
      └─ Enter full custom editing, no longer needing a second "create"
```

The authoritative fact for "already added" is merely whether the Personal Provider Config Map has this providerId. It is unrelated to API Key, enabled, executable,
selectable. Provider enabled is an independent toggle in the config page: disabled still stays in the configured area; only deleting Personal Overlay causes
it to re-enter add candidates.

The domain semantics of "Delete Provider" in UI is always deleting Personal Overlay:

```text
standard-builtin
└─ Delete Personal Overlay + Personal-specific Rules for that Provider
   └─ Effective Provider falls back to Built-in, re-enters "Add Supplier" candidates

standard-personal
└─ Delete Personal Overlay + Personal-specific Rules for that Provider
   └─ Naturally disappears since no other definitions exist

zai-family / bigmodel-family
└─ Delete Personal Overlay + Personal-specific Rules for that Provider
   └─ Effective Provider falls back to Built-in/Account state, stays in fixed Family area
```

The system never deletes ZCode Built-in Config. Generic Personal Match Rules are not affected by Provider deletion. Families do not enter normal "Add Supplier" candidates,
nor does the UI provide Provider enabled toggles; underlying fields still serve Built-in/Account assembly; special states from user-manual configuration modifications are not within
Settings UI product guarantee scope.

Host Settings contract provides at minimum the following authoritative results:

```text
ProviderSettingsView
├─ revision
├─ addableProviders[]
│  └─ visible + group=standard-builtin + no Personal Overlay yet
├─ providerOrder[]
└─ providers[]
   ├─ providerId / group / label
   ├─ effectiveBuiltinConfig / personalConfig / effectiveConfig
   ├─ enabled / issues / executable
   └─ models[]
      ├─ modelId / builtin
      ├─ effectiveBuiltinConfig / personalExactConfig / effectiveConfig
      └─ enabled / issues / executable / selectable
```

No longer returning `isZCodeBuiltin`, `canReorder`, member conflict DTOs, or naming Provider executable as selectable. Renderer organizes configured areas based on
`group`, but candidates, order, member source, and all derived state are produced by Host.

Host Mutation must cover the following domain operations; specific function names can serve code style, but semantics must not be merged:

- `addBuiltinProvider(providerId)`: creates `enabled=true` Personal Overlay, and materializes complete `providerOrder`;
- `createPersonalProvider({ providerId, label })`: validates identity, then immediately creates empty API Provider, and materializes order;
- `savePersonalProvider(providerId, sparseConfig)`: saves label/enabled/API/Access overlays, does not modify ID;
- `deletePersonalProvider(providerId)`: deletes Personal Overlay and this Provider's Personal-specific Rules;
- `reorderProviders(completeProviderOrder)`;
- `addPersonalModel`, `renamePersonalModel`, `deletePersonalModel`, `reorderModels`;
- `savePersonalModelConfig` and leaf-level default restoration;
- `previewPersonalModelRename`: moves specific Rules first, then resolves new Built-in defaults;
- `testModel`: saves and refreshes, then executes through official Registry/ModelFactory.

All Mutation success responses must correspond to the same revision that has been persisted and observed by Registry. Local and remote use the same service contract, but the service
instance belongs to the target Environment Host.

## 9. Settings: Model Editing

Model list uses compact info rows, no longer rendering editable Model ID input fields in the list, nor displaying Built-in/Personal source labels for now. Source is still provided by Host
DTO explicit `builtin`, used for delete permissions and domain operations; Renderer does not use ID whitelist or Preset/Catalog inference.

Model rows directly display Model ID, necessary compact summaries, Effective enabled status, test, edit pencil, and delete actions. Edit pencil continues exposed; delete
continues exposed on Personal Model rows; Builtin Models do not show delete. Enable/disable controls show current Effective status, but the list does not emphasize whether it comes from Built-in
default or Personal override.

When Provider is editable, all Effective Built-in/Personal Model members are sortable; Builtin Models are simply not allowed to delete, cannot reuse the current
"only Personal Models draggable" restriction. Sortable models use the entire row as the drag activation area, with no independent drag handles displayed; edit, delete, enable/disable, test, and other
row-level controls must be excluded from the drag activation range. Pointer movement threshold distinguishes normal clicks from dragging; touch needs to avoid conflicts with list scrolling; keyboard still provides
equivalent sorting capability. Normal clicks on model rows do not open editors, nor produce configuration operations; only the exposed edit pencil enters Model editor.

Model edit page allows editing the complete Model Config field set, but persistence always forms sparse Personal Rules, writing only the leaves users explicitly modified or cleared:

- `enabled`;
- context/max output;
- input/output format;
- tool call, structured output, native web search, MCS;
- option specs and reasoning mapping;
- confirmed allow-for-Personal-override request encoding fields;
- `requiresMfjsToolSchema` at the end.

Model editor must distinguish the following facts, not assuming every field has Built-in default value:

```text
No Personal leaves + upstream has value
└─ Inherits that value

No Personal leaves + upstream has no value
└─ Not set; cannot display as "default off" or fabricated empty value

Has Personal leaves
└─ User explicitly overrides

Personal explicit clear (field permits)
└─ Explicitly clears upstream value
```

Field controls follow these unified visual semantics:

| Status                         | Visual and Interaction                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Upstream has value, Personal not overridden | Displays real Effective result, but uses low-emphasis text, fill, or stroke; no restore operation |
| Upstream has no value, Personal not overridden  | Displays neutral dash or "Not set" placeholder, cannot disguise as off or empty default      |
| Personal explicit override       | Uses normal control emphasis; provides low-interference undo icon, shown on Desktop hover/focus, always discoverable on touch |
| Personal explicit clear          | Displays clear unset/cleared state; cannot be confused with "no Personal leaves"         |
| Validation error               | Uses standard error text and semantic colors, not mixed with inheritance/override visual strength  |

Text and numbers display upstream values as placeholder when inheritable values exist, without copying them into Personal; displays "Not set" when upstream has no value. Clears Personal
input to restore inheritance; provides narrow, explicit clear operation only when the field genuinely allows explicit clear. Enums continue to use existing Select language: collapsed displays Effective result;
menu distinguishes "inherit existing value," "keep unset," "explicit clear" (when field permits), and explicit enum values, but does not stack
"Default (currently X)" long text in trigger.

Model total `enabled` uses compact Switch. Input/Output Format, and capability Booleans for tool call, structured output, native web search, MCS
etc., use Toggle Chip / Selectable Tag coordinating with existing Modality controls: Outline Button containing checkmark and short label, wrap-able, not
a row of Switches. Inherited enabled uses low-emphasis selected Tag; explicit enabled uses normal emphasis selected Tag; inherited disabled and explicit disabled use low-emphasis and normal
stroke respectively; upstream no value uses neutral dash. Selected status uses checkmark, not set uses dash, Personal override has undo entry and accessible name, so cannot
rely solely on color to distinguish status. Text lock facts continue to use existing lock icon and disabled semantics. PDF/Audio not shown for now, but irrelevant editing must preserve their Personal values.

Option Specs and Reasoning Mapping are advanced configurations, using multiple independent, syntax-highlighted or at least monospace-font, auto-formatting JSON text editors,
without developing total `optionSpecs` editor, tables, per-row Mapping, or visual Builder. First version includes at minimum:

```text
Reasoning Level Option Spec JSON
└─ directly overrides optionSpecs.reasoningLevel

Max Output Tokens Option Spec JSON
└─ directly overrides optionSpecs.maxOutputTokens

Reasoning Mapping JSON
└─ directly overrides entire reasoningMapping
```

Each editor corresponds to an independent configuration slot; editor provides JSON to directly replace upstream value for that slot; empty Personal editor means deleting that slot override and re-inheriting. `optionSpecs` shell in
Personal file can only contain overridden sub-fields, but no finer-grained Overlay within single editor;
`reasoningMapping` must not secretly implement per-key merging within the UI. Each slot's Effective JSON is viewed through read-only preview, collapsible area, or tab; cannot
first copy Effective JSON then save as Personal. Execute JSON parsing and corresponding slot's strict Schema validation before saving; errors locate to row/column or field
path as much as possible.

Page must not pile prominent "restore default" buttons next to each field. Restore inheritance is completed by clearing input, Select's inherit/unset items, Toggle Chip's low-interference
undo entry, or clearing JSON Personal content.

All the above controls must reuse `DESIGN.md` and existing component dimensions, border-radius, focus, menus, and semantic Tokens. Hardcoded light/dark values or guessing theme
solely by opacity are prohibited; at minimum covers Zai Light, Zai Dark, keyboard Focus, Hover, disabled, error, and touch no-Hover states. UI uses `text-ui-*`
font hierarchy, Model ID and JSON use monospace font, long Chinese/English text and narrow screens allow reasonable wrapping.

Model editing continues using popups, not switching to right-side details or settings page secondary page. Existing `max-w-xl` space is insufficient; Desktop enlarges popup by one tier, using
`max-w-2xl` nearby existing size tier as starting point, not expanding to horizontal workspace or near-full-screen ultra-wide popup. Field growth mainly uses vertical sections;
popup width and height must stay coordinated, Header and Footer fixed, only one content scroll area in the middle, avoiding multi-layer page scrolling from popup and JSON editor. Narrow screen and
Mobile uses available width and height within safe margins, without changing fields, inheritance, and save semantics. Implementation can fine-tune actual width and height within existing size tiers, but cannot maintain old size by hiding already required
open fields.

Model editing popup explicitly adopts manual save, an out-of-bounds exception to the settings page auto-save mental model. Opening popup establishes
Local Draft based on current Host View and revision; modifying Model ID, Properties, Option Specs, Reasoning Mapping and other fields only updates Draft, does not persist per-field, nor triggers
Registry refresh. Enable/disable, sorting, delete, and other single-domain operations in the list continue their own immediate, atomic saves, not merged into popup Draft.

```text
Host View @ R1
      |
      v
Open popup -> Local Model Draft @ R1
                 |
                 +--> Edit fields --------> Only modifies Draft
                 |
                 +--> Cancel / X / Esc ---> Discard Draft, do not write config
                 |
                 `--> Save
                        |
                        +--> Full validation failure ----> Keep popup and Draft, show errors
                        |
                        `--> One atomic Host Mutation
                                  |
                                  v
                          Persist + Registry @ R2
                                  |
                                  v
                              Close popup
```

Save button is not re-triggerable when Draft is invalid or being submitted. Save must validate and submit the complete Draft's expressed sparse Personal config in one go; Model ID
modification requires members, order, and specific Rule migration also belonging to the same atomic Mutation. Only Host confirms persistence result has been observed by Registry before closing
popup; save failures retain user input, cannot fall back to per-field auto-save.

When modifying Personal Model ID, must first move that model's `provider-model` specific Rule in preview semantics, then re-resolve Built-in Rules by new ID, Effective API, and
Endpoint, finally overlay original Personal sparse values. This way inherited defaults update, while user explicit values remain unchanged.

## 10. Built-in Config Writing and Organization

Providers are arranged continuously by product origin: Zhipu direct API and accounts/subscriptions/Off-Peak first, external mainstream Providers last. Normal external Built-in
Providers default to `group=standard-builtin`, `enabled=false`, `visibility=visible`, providing protocol, Endpoint, Access template, and recommended members;
Personal Config fills actual access material.

Z.ai/BigModel each retain two different API Key product identities:

```text
Family API Key Provider
├─ account:zai-api-key       -> group=zai-family
└─ account:bigmodel-api-key  -> group=bigmodel-family
   └─ Managed by fixed Family UI together with account plans

Regular API Provider
├─ zai-api           -> group=standard-builtin
└─ bigmodel-api      -> group=standard-builtin
   └─ Entered from "Add Supplier", users fill API Key independently
```

The two Provider groups have different providerId, Personal Overlay, enabled, API Key,
model members, and ordering even when Endpoint, API Schema, and recommended models are identical. They cannot share or silently copy credentials. Duplicate static model facts continue to reuse Model Rules' matcher; no ID
special case in Runtime/Adapter for these four Providers.

Old account Provider ID `builtin:` prefix is once changed to `account:`, making physical identity consistent with product semantics:

```text
builtin:zai-*       -> account:zai-*
builtin:bigmodel-*  -> account:bigmodel-*
builtin:offpeak-idle-plan
                    -> account:zai-offpeak-idle-plan
                     + account:bigmodel-offpeak-idle-plan
```

This branch is not yet released, so old ID aliases, dual-read, or persistent migration are not retained; tests, Family Spec, ModelSelection fixtures, and exact
Provider constants must switch atomically.

Off-Peak no longer uses a single execution-time dynamically-following account family shared Provider, but is split into two complete Providers:

```text
account:zai-offpeak-idle-plan
├─ group=zai-family
├─ visibility=hidden
└─ access.executionProtocol=off-peak

account:bigmodel-offpeak-idle-plan
├─ group=bigmodel-family
├─ visibility=hidden
└─ access.executionProtocol=off-peak
```

Account Built-in Overlay enables only matching Off-Peak Providers based on current structured Family/Coding Plan connection; the other is explicitly
`enabled=false`. Off-Peak creation entry gets corresponding exact Provider by current Family; there is no "shared Provider switching Family during request."
Saved tasks continue holding original `ModelSelection`: after user switches Family, old Family Provider is disabled, task is retained but unscheduleable; switching back and
connection re-validated restores it. The system must not silently migrate saved tasks to another Family, nor create substitute ModelSelection for them.

Model Rules maintain a single ordered array:

```text
Complete conservative fallback
      |
      v
Model family A
├─ Public facts with model match only
├─ model + API specialization
├─ provider + model specialization
└─ necessary Endpoint specialization
      |
      v
Model family B ...
```

Related rules of the same model family are placed consecutively. Runtime, Adapter, and UI do not establish second facts based on specific modelId, Provider ID, or URL. Current
repo config does lightweight correctness review: all Built-in members can parse into complete Model Config, and check whether MCS, Native Web Search, media format,
Reasoning, MFJS are covered by Rules; does not restore strict historical comparison tables.

## 11. Access and Adapter Boundaries

The following facts belong to Provider Access:

```text
access.executionProtocol = "off-peak"
```

Official release request security validation admission also belongs to Provider Access, and is executed at Adapter's final HTTP transport boundary (specific fields and implementation are maintained only in official release).
It does not enter Model properties, is not determined by modelId, nor replaces API Key authentication.

Compatibility decisions:

- OpenAI-compatible reasoning depends on canonical history and SDK native encoding; ZCode special replay is deleted;
- GitHub Copilot `omitMaxOutputTokens` is deleted;
- Snowflake Cortex is not currently supported; `maxOutputTokensRequestField` is deleted;
- Official release request security validation and Off-Peak failure/execution protocol are moved from Model Config to Access; this round does not refactor Off-Peak string errors;
- `requiresMfjsToolSchema` stays in Model Config; when enabled, projects Tool JSON Schema, projection failure directly errors;
- DeepSeek Anthropic unified execution of canonical replay, no synthetic empty thinking;
- Z.ai text/tool signature patches not in the current baseline are not merged; if support is needed, real response evidence must be obtained first, following "return whatever is received."

## 12. Client Config Boundaries

ZCode Built-in Provider Config and Built-in Model Config Rules are released as an atomic `zcodeBuiltin` Release. Repository/package contents
are fallback before pull and on failure; each Environment uses its own Active/LKG and Registry. Remote workspaces are pulled and parsed by Remote Host,
and returns its configuration; Renderer does not pass off Local Host config as remote facts.

This Todo only requires new fields to make complete round-trip along Todo 18's existing minimal pipeline, not unify all `/client/configs` consumers by the way.

## 13. Implementation Order

1. Tests first, establishing five Source Schema, Provider `group`, Personal Rule union, Provider/Model integrity and order tests;
2. Adjust Config/Protocol/Repository types, delete `enabledModelIds` candidates and Model visibility;
3. Implement `provider-model` specific Rule lifecycle and normal `match` Rule isolation;
4. Implement model enabled, three-segment Model/Provider order, Builtin-wins, and save normalization;
5. Organize `zcode-builtin.json` Provider and Rules order, atomically switch `account:` IDs, split Family/regular
   Z.ai/BigModel API Providers and dual Off-Peak Providers, complete model default enabled and official disabled items;
6. Migrate official release request security validation and Off-Peak execution protocol to Access, clean up decided-to-delete Adapter Compatibility;
7. Refactor Settings Facade, Mutation, and UI, unify Local/Remote Host authoritative source;
8. Delete Preset/Catalog source inference, old order tricks, dead fields, dead helpers, and obsolete tests;
9. Sync this Todo's facts to Design Tree, Feature Graph, and superseded old docs based on final implementation;
10. Execute unit tests, typecheck, Lint, format check, and affected E2E, commit with Conventional Commit.

## 14. Test Plan

### Config and Resolver

- Five Source Schema allow/reject matrix;
- ZCode Built-in `group` is required and cannot be `standard-personal`; Personal-only fixed `standard-personal`, Overlay cannot change group;
- Four groups of normal Built-in, Personal-only, Z.ai Family, BigModel Family are complete and mutually exclusive;
- Two Off-Peak Providers are mutually-enabled by Account Overlay by current Family;
- Personal prohibits writing `builtinModelIds`, prohibits normally saving Built-in duplicate `modelIds`;
- Built-in/Personal same ID means Built-in-wins, single-array duplicates retain first;
- Model `enabled` Built-in default, official specialization, Personal deferred override, restore default, and JSON round-trip;
- `provider-model` specific Rule and `match` generic Rule order, deletion, renaming, and empty Rule cleanup;
- Provider/Model enabled, integrity, and Provider visibility form executable/selectable formulas.

### Ordering and Lifecycle

- Model/Provider three-segment order;
- New Built-in automatically falls into unsorted Built-in segment;
- Normal new Personal atomic updates members, order, and `enabled=true` specific Rule;
- Order save adds missing, deletes stale, removes duplicates;
- Personal Model rename/delete atomic updates members, order, and specific Rule;
- Provider deletion deletes Overlay and specific Rules, does not modify generic Match Rules;
- disabled members retain position in Settings, excluded from Selection/Registry.

### Settings and Cross-Environment

- "Already added" only by Personal Map membership; Provider disable does not return to add candidates, only delete does;
- Adding Built-in and creating Personal-only both take effect immediately and write `enabled=true`;
- Normal candidates only from `group=standard-builtin`; two Families do not rely on ID whitelist filtering;
- Two Families do not participate in normal ordering, and UI does not provide Provider enabled toggles; deleting Personal Overlay still stays in fixed Family area;
- Custom Provider creation does not guess API Schema, Endpoint, or models; creates incomplete Provider immediately after identity confirmation;
- Family API Key and regular Z.ai/BigModel API Provider Personal Config, credentials, enabled, and order are isolated from each other;
- `account:` Provider IDs atomically switched across chain with no old aliases;
- After switching Family, old Family Off-Peak tasks are retained but unscheduleable, restored when switching back; no silent ModelSelection migration;
- Built-in Models have no delete button, Provider IDs all read-only, label is unique;
- Effective placeholder, explicit override, and restore default; hidden fields preserved losslessly;
- Four editing states: upstream has default, upstream no default, Personal override, and explicit clear do not confuse each other;
- Model enabled uses Switch, capability Booleans use existing-style Toggle Chip/Selectable Tag; selected, not set, and Personal override have
  non-pure-color clues;
- `optionSpecs.reasoningLevel`, `optionSpecs.maxOutputTokens`, and `reasoningMapping` each use independent formatted Personal JSON
  editor and read-only Effective preview; each editor directly replaces its own slot, no further Overlay within editor or per-key merging;
- Model editing uses proportionally coordinated larger popup, not right-side details/secondary page; Desktop does not do ultra-wide layout, fixed Header/Footer, only middle content area
  scrolling, Mobile uses safe viewport range;
- Model editing popup uses Local Draft and manual save; field edits do not write config early, Cancel/X/Esc produces no Mutation, save initiates only one atomic
  Mutation, and closes after persistence result is observed by Registry; failures retain Draft and popup;
- Model row enable/disable, sorting, and delete are still immediate atomic operations, not mixed with popup Draft;
- Compact Model row does not render Model ID input box or source label, retains exposed test, edit, enable/disable, and Personal delete operations;
- Normal clicks on Model row do not open editor; editing only entered by pencil; entire row drag not triggered by row-level buttons, supports pointer threshold, touch scrolling, and keyboard
  equivalent operations;
- Provider fixed operations, Model list, and complete Model editor cover Zai Light/Zai Dark, Desktop and Mobile layout and Chinese/English;
- Modifying Model ID first moves Personal-specific Rules, then refreshes Built-in Preview;
- Local workspace uses Local Host, remote workspace uses Remote Host; Renderer does not do local fallback parsing.

### Adapter and Regression

- Official release request security validation and Off-Peak route by Access, Model Config no longer shows corresponding fields;
- Delete Copilot/Snowflake/old OpenAI replay means no Runtime fallback;
- MFJS open, close, and conversion failure;
- DeepSeek A/B real request results form reproducible fixtures before deciding field retention;
- Normal requests, Compact, Memory, Child Agent, Off-Peak all use only Active Model/Registry facts.

## 15. Completion Definition

- Design Tree, summary, Feature Graph consistent with implementation, no longer showing `enabledModelIds`, Model visibility, or conflicting DTOs as target design;
- Providers only manage members and order, Model Config `enabled` is the sole model execution gate;
- Built-in general Rules provide complete defaults, official can default-disable old models via specific Rules;
- Single-model editing on settings page all falls into structured Personal-specific Rules; generic Match Rules not guessed by lifecycle operations;
- "Added Provider," Provider enabled, and Provider delete three semantics are not mixed;
- Built-in config covers current known static model/API hardcode, no new Runtime second facts created;
- Access product protocols and Model request compatibility are correct, decided-to-delete items have no residue;
- `pnpm typecheck`, `pnpm lint`, related unit tests, format check, and affected E2E pass;
- Submitted with Conventional Commit.
