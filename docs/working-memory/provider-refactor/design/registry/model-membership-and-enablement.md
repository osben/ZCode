# Provider Model Members, Enable/Disable, and Ordering

> Status: Current effective design
>
> Last updated: 2026-08-26

## Goal

Model members, model enable/disable, and model ordering are three different types of facts:

```text
Provider Config
├─ builtinModelIds / modelIds  -> which models exist
└─ modelOrder                  -> in what order to display

Model Config
└─ enabled                     -> whether a member can execute
```

Provider member arrays cannot declare model capabilities or enable/disable; Model Rules cannot create members or decide member ownership.

## Member Ownership

```ts
interface ProviderConfig {
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
}
```

`builtinModelIds` is managed by ZCode Built-in or Account Built-in; `modelIds` is managed by Personal. After completing Overlay,
the Resolver normalizes missing or `null` to `[]`, then produces a source-aware inventory.

Member IDs are compared case-sensitively after trimming leading/trailing whitespace:

- Duplicates within the same array: keep the first occurrence, ignore later items;
- Built-in and Personal same ID: Built-in-wins, producing only one Built-in member;
- Normal Settings prohibit Personal from adding IDs already existing in Built-in;
- User-handwritten duplicate configs can still be deterministically read; duplicates and stale items are removed from the Personal array the next time the related Provider is saved;
- No conflict objects, suspended identities, or second models with the same name are created.

Model Config Rules hitting a non-existent ID do not create members; they only participate in resolution when a Provider truly owns that member in the future.

## Explicit Built-in Source

Providers use complete `builtin: boolean` in Effective/Registry/Settings DTOs. The Host explicitly returns the `builtin` field for Model rows based on the final source-aware inventory; Renderers do not guess by ID, Preset whitelists, Personal Map membership, or UI grouping.

Builtin Model IDs are read-only and do not show delete buttons. Personal Model IDs can be modified through atomic rename; Personal Models can be deleted.

## Model Config `enabled`

### Provider Rule Outer Enable/Disable (Todo107 subsequent decision)

`ProviderConfigRule.enabled?: boolean` is at the same level as providerId and providerName; it is not placed inside config or Access.
The Resolver uniformly interprets defaults as true. Personal switches only write the outer `enabled`; they do not change Keys, members, model switches, or account connections.
Facades return normalized enabled and existing executables; UI only maps gray (disabled), yellow (enabled but not executable), and green (ready). Account groups use the current connection's corresponding Provider's public results and cannot substitute plan menu statusActive for execution eligibility.
Bound Models are not retroactively revoked by config switches; historical selections remain; subsequent execution follows existing resolution and admission.

```ts
interface ModelConfig {
  enabled?: boolean | null;
  // properties / optionSpecs (including per-option map) / narrow encoding facts
}
```

`enabled` is a model execution gate, not member relationship, visibility, authorization, or completeness:

```text
Provider complete
AND Provider Rule enabled (default true)
AND Account Provider entitled (account types only)
AND membership exists
AND Effective Model Config enabled
AND Model Config complete
        |
        v
Executable Model
```

Only Executable Models enter Registry, and thus can be used by fallback, tests, internal exact IDs, or ModelFactory. Normal user candidates additionally require Provider `visibility=visible`. Models do not have independent visibility, nor do they save selectable/executable.

disabled Models:

- Remain in Settings;
- Retain Properties, Options, Reasoning, and ordering;
- Can be edited or re-enabled; the model list does not provide an enabled "restore default";
- Cannot test, fallback, select, or create by exact ID;
- Do not provide bypass gates for internal tasks.

Already-created immutable Models are not interrupted by config refreshes; subsequent creations use the new enabled state.

## Built-in Defaults and Personal Overrides

Built-in general Rules provide complete default `enabled=true`. More specific, later-positioned Built-in Rules can default淘汰 or no-longer-recommended models to `false`. This allows ZCode to adjust official defaults when publishing new configs, without changing Provider members.

Personal Rules come after all Built-in Rules:

```text
Built-in general enabled=true
            |
            v
Built-in specific enabled=false
            |
            v
Personal provider-model enabled=true/false
            |
            v
Effective Model Config enabled
```

Users toggling switches only write Personal `enabled` leaves and save explicit boolean values; the model list does not provide a "restore default" entry. When normally creating a new Personal Model, `enabled=true` is explicitly written to avoid relying on implicit guesses for new flows. Schema and Overlay still allow deleting this leaf through config editing, but this is not a product operation of the model list switch.

## Provider/Model-specific Rules

Built-in and Personal Model Rules use the same structure:

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

`provider-model` targets a precise Provider/Model combination. It can belong to two Sources:

- Built-in specific Rules are managed by the ZCode Built-in Release and can declare official specializations for Built-in Provider/Model combinations;
- Personal specific Rules are managed by Settings and can override Built-in or Personal Models.

Only Personal-specific Rules participate in user lifecycles:

- Created or updated when Settings modifies single-model fields;
- Moved when Personal Models are renamed;
- Deleted when Personal Models are deleted;
- All specific Rules for that Provider are deleted when deleting the Provider's Personal Overlay;
- Empty Rules are deleted after restoring the last field.

`match` Rules can also belong to Built-in or Personal Sources, used for common facts across groups of models/APIs/Providers/Endpoints. Any Provider/Model rename, delete, or deduplication does not guess or rewrite Match Rules; Built-in specific Rules are also unaffected by user operations. Specific Rules use structured IDs, not escaping precise IDs to regex, and do not add `exclusive` flags.

## Model Ordering

Basic ordering is divided into three segments:

```text
Built-in not appearing in modelOrder
              +
Members still valid in modelOrder
              +
Personal not appearing in modelOrder
```

This ensures that newly released online config Built-in Models that users have not yet sorted default to the front. When normal Settings adds Personal Models, a complete `modelOrder` and initial specific Rule are atomically updated in the same atomic operation, so unsorted Personal comes only from handwritten or abnormal inputs.

When users save by dragging:

1. Read the current effective source-aware inventory;
2. Arrange according to user results;
3. Delete stale and duplicate IDs;
4. Fill in all missing members;
5. Save the complete `modelOrder`.

Disabled Models still appear in Settings by `modelOrder`. After Selection filters disabled models, other models maintain their relative ordering.

## Lifecycle Operations

### Adding Personal Models

```text
validate new modelId
        |
        v
atomic write
├─ modelIds += id
├─ modelOrder = complete current order
└─ provider-model rule { enabled: true }
```

If the ID duplicates a Built-in or existing Personal member, normal saves are rejected.

### Renaming Personal Models

Atomic replacement:

- The old ID in `modelIds`;
- The old ID in `modelOrder`;
- The old `provider-model` specific Rule's target ID.

Preview must first move the Personal-specific Rule, then resolve Built-in Rules using the new ID and Effective Provider API/Endpoint, then overlay the original Personal sparse values. User-entered explicit values remain unchanged; inherited defaults update with the new ID. Generic Match Rules do not rewrite.

### Deleting Personal Models

Atomic deletion:

- The member in `modelIds`;
- The position in `modelOrder`;
- The corresponding `provider-model` specific Rule.

Generic Match Rules are not deleted. Builtin Models have no such operation.

### Deleting Provider Personal Overlays

Delete the Provider's Personal Overlay, and delete all `provider-model` specific Rules for that Provider; Generic Match Rules are retained.
Built-in Providers fall back to the Built-in baseline; Personal-only Providers naturally disappear without other root definitions.

## Settings and Selection

Settings returns complete members of all visible Providers, including disabled/incomplete Models, and explicitly provides:

- `builtin`;
- Effective `enabled`;
- Whether Personal explicitly overrides enabled;
- Effective/Personal Model Config;
- Completeness issues;
- Derived executable/selectable;
- Unified ordering.

Selection returns only executable models from visible Providers, maintaining Registry order. Renderers no longer filter, sort, Overlay, or manufacture candidates from Connections/Presets/Catalogs.

## Acceptance Cases

| ID   | Input/Operation                            | Result                                                                           |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| MM01 | Built-in `[A,B]`, Personal `[X]`           | Inventory is Built-in A/B + Personal X                                           |
| MM02 | Both sources have X                        | Only produces Built-in X; Personal duplicate ignored, cleaned at save time       |
| MM03 | One array has `[A,A,B]`                    | Keeps the first A and B                                                          |
| MM04 | Built-in Rule sets old A to disabled       | A remains in Settings; does not enter Registry/Selection/fallback                |
| MM05 | User switches A's toggle to true           | A becomes executable again, retains Personal enabled=true                        |
| MM06 | New Built-in C not in user's modelOrder    | C appears in the unsorted Built-in front segment                                 |
| MM07 | Settings creates Personal Y                | Members, complete ordering, enabled=true specific Rule atomically saved          |
| MM08 | Personal Y renamed to Z                    | Members, ordering, specific Rule atomically moved; Generic Match Rules unchanged |
| MM09 | Delete Personal Y                          | Members, ordering, specific Rule deleted; Generic Match Rules retained           |
| MM10 | Provider disabled                          | All models remain in Settings; not included in Registry/Selection                |
| MM11 | Provider hidden and enabled, Model enabled | Normal Settings/Selection not displayed; internal exact creation possible        |
| MM12 | Model disabled then config refreshed       | Existing Active Models complete their lifecycle; new creations rejected          |

## Non-adopted Approaches

- A single `models[]`: Personal snapshots would obscure later-released Built-in members;
- `enabledModelIds`: Complete positive collections cannot simultaneously express official future defaults and user-per-model overrides;
- Provider-level default + per-model enablement policy: Duplicate Model Rule overlay capabilities;
- Model visibility: Overlaps with Provider visibility/Model enabled, creating a second set of hidden semantics;
- Duplicate member conflict DTOs: Normal UI already prohibits duplicates; handwritten input can be handled by Built-in-wins + save normalization;
- Encoding UI exact Rules with regex: Lifecycle ownership is unclear; rename/delete must be guessed;
- Generic equality/identity abstraction: Member judgment using explicit providerId/modelId comparison is sufficient.
