# Todo138: Empty model draft and Model-layer reasoning-level fallback

> Status: done (2026-09-12); implemented per the final decision and verified below.
>
> Merge note: the source branch numbered this Todo134, now unified as Todo138. The source builtin
> revision 23 became 24 after merging another revision-23 Turbo-disable change; old version mentions are
> historical evidence.

## Background and decision

A newly added model without an ID showed `disabled` because of a UI hardcode in
`ProviderCardSections.createEmptyModel`. The user wants an empty draft with no prefilled level, and the
real model to provide on/off fallback levels.

The first draft ("Model-generic levels empty, API layer adds two levels") was withdrawn: existing Model +
API rules override later, which would override Model-layer dedicated levels. The final decision changes no
layer, ordering or overlay algorithm, adds no field special case and does not redeclare dedicated levels
across layers.

## Resulting behavior

### New-model UI

Without a model ID the reasoning levels are empty (no `disabled` prefill); levels can be added; after an ID
is entered the existing resolution, draft projection and personal-override mechanisms apply. Clearing the ID
sends no resolution request and returns to an empty level list when there is no user override; explicitly
edited levels are kept. Existing models, manual settings and other initial capabilities are not reset.

### Model-layer generic fallback

```ts
reasoningLevel: {
  values: ["disabled", "enabled"],
  map: "{}",
}
```

Known models keep declaring their own levels in later dedicated rules (no extra disabled/enabled needed).
Without API information a model can still get the two Model-layer levels, but that does not mean complete
config or sendable requests; completeness validation is not relaxed.

### Generic mapping for the three API formats

API generic rules add no `values`; only the `enabled` branch of `map` changes:

- Anthropic Messages: disabled keeps `thinking.type=disabled`; enabled uses `thinking.type=adaptive`, `output_config.effort=high`.
- OpenAI Chat Completions: disabled keeps the off fields and effort=none; enabled uses `thinking.type=enabled`, `enable_thinking=true`, and both `reasoning_effort` and `reasoning.effort` = `high`.
- OpenAI Responses: disabled keeps `reasoning.effort=none`; enabled maps `reasoning.effort=high`.

Other levels follow the original mapping; model/API/site dedicated maps and personal overrides are kept.
Only generic expressions change; `enabled` is never sent as an API effort value as is.

## Ownership and boundaries

```text
empty-ID draft (UI, empty levels, no resolution)
  -> enter ID
  -> existing Host resolution: Model generic two levels -> dedicated model levels -> original later-layer overrides
  -> existing UI projection (explicit edits kept)
  -> existing request adapter executes the API map
```

UI owns only the uncommitted draft; rules and effective model config remain with the Provider resolution
chain. No new protocol, state source, timer or sync chain; desktop continuous / mobile replayable unchanged;
both ends reuse the same editor component.

When a user actively picks a model or on fresh initialization, `completeNewModelSelection` takes the last
level of the array, so a fallback model selects `enabled`; restoring/re-resolving an existing selection
does not use that completion; this natural result is accepted, the selection strategy is not changed and
saved user selections are not overwritten. Builtin revision 22 -> 23 (24 after merge); no `schemaVersion`
change, file format or migration.

## Code locations

- UI: `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`.
- Resolution/projection (regression only): `useModelConfigResolution.ts`, `useProviderModelDraft.ts`, `ProviderModelDraftState.ts`.
- Builtin: `config/provider/zcode-builtin.json` (first Model rule and the three generic Model + API maps).
- Rule order (unchanged): `packages/provider/src/config/schema.ts`, `model-config.ts`.

## Verification

- Red first: UI initial levels, real builtin resolution, SDK undeclared-`enabled` validation and two-size browser checks reproduced the old behavior.
- 153 UI/builtin-config unit tests; 7 draft-rule tests; 64 real SDK serialized-request tests (including 6 for disabled/enabled across the three formats) with isolated fetch (no paid model requests).
- Typecheck and desktop E2E typecheck pass; lint 0 errors / 42 existing warnings; architecture 0 violations.
- Dedicated-map historical baselines and GPT-5.4 / GLM-5.3 multi-level behavior kept. Grok-4.3 has no dedicated level declaration so it inherits the two levels like unknown models; its builtin default-off state is unchanged. Personal persistence is not written back.
- Two new browser cases pass: first open has no levels and no request, two levels after resolution, clearing the ID returns to an empty list, and manual edits are not overwritten by a late reply (the test once wrongly waited for the recommendation input value and now waits for the placeholder; production sync logic unchanged).
- Shared settings-page browser run of 22: 21 passed directly; the phone provider batch was interrupted by Vite HMR from a comment cleanup and passed on rerun. Tests used shared components and isolated services; full Electron, phone remote control and real-provider network calls were not run.
