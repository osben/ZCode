# Todo130: Smart-config switch and manual config editable-field boundary

> Status (2026-09-11): local implementation and local review done; final batch acceptance pending. The
> domain schema defines the editable leaves; extraction and cleanup reuse the schema structure; a manual
> rule keeps the current identity's system baseline and full execution admission is not relaxed. The file
> codec normalizes only strictly valid old full manual rules, later saves write the new shape, and
> unknown/corrupt shapes are still rejected. Todo131/125 layout and help are separate and not claimed here.
>
> Later decisions: [Todo134](todo-134-model-editor-basic-advanced-draft.md) hides MFJS / output type, so
> MFJS leaves the manual editable schema (the MFJS row of the field table below is no longer valid); the
> general "freeze only editable fields" mechanism stays.
> [Todo131](todo-131-model-settings-smart-config-placement-and-restore.md) moves the smart-config switch to
> the right of the model ID plus a bottom "restore" button, superseding this Todo's no-layout-change
> constraint; field ownership, manual schema and save composition still follow this Todo.
>
> Core decision: the switch is always shown and disabled only while saving; manual config saves only the
> complete editable fields, and system fields keep resolving from the current model and access config. No
> editing entry is added for hidden fields.
>
> Compatibility: the user said a published old full manual format is unlikely ("this should not exist, no
> big problem"). Plan as "probably unpublished": no complex migration, new file or version bump. This is a
> current judgment, not a verified publication fact.
>
> Related: [Todo90 shared add/edit draft](./todo-90-model-add-edit-shared-recommended-draft.md),
> [Todo92 override feedback](./todo-92-model-smart-config-and-override-feedback.md),
> [Todo104 schema refinement](./todo-104-pre-release-schema-review.md). This Todo supersedes their rules
> "disable the switch when recommendation is not ready", "manual mode freezes the whole config" and "all
> model fields required, system baseline cleared".

## 1. Background and verified problems

The model settings page sometimes could not turn smart config off:

1. `ProviderModelMetadataDialog` disabled the switch in smart mode when the ID was empty and the recommendation not ready, and hid it when an ID existed without a recommendation and not pending.
2. `useProviderModelDraft.pending` means "needs resolution but no result", not "request in flight"; after a failure it could stay true. Automatic resolution failures were swallowed by idle scheduling, so users saw no error and could not go manual.
3. Simply enabling the switch exposed a save defect: after A -> B with B unresolved, closing smart mode could refill the hidden max-output mapping from the original A `currentModel.config`.
4. A brand-new model without recommendation still required the hidden `maxOutputTokens.map` for manual save and reported it as a max-output-token error.
5. The domain also froze the whole config: `manualModelConfigSchema` derived from the full config (only `enabled` optional), and `ModelConfigRules.resolve()` cleared earlier config for a manual rule keeping only `enabled`.

Evidence: seven isolated tests with the real Hook and dialog asserted the problem behaviors; baseline `HEAD=615657da82`.

## 2. Layer 1: field ownership

| Editable in the page, user-managed in manual mode | Config path                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Context window                                    | `properties.contextWindow`                                                                      |
| Max output token cap                              | `optionSpecs.maxOutputTokens.max`                                                               |
| Image, video, PDF input                           | `properties.inputFormat.supportsImage / supportsVideo / supportsPdf`                            |
| Structured output, native search, mid-conversation system message | `properties.supportsJsonSchemaOutput / supportsNativeWebSearch / supportsMidConversationSystem` |
| Reasoning levels and reasoning parameter mapping  | `optionSpecs.reasoningLevel.values / map`                                                       |
| MFJS tool schema (superseded by Todo134)          | `properties.requiresMfjsToolSchema`                                                             |

| Not editable, not frozen by manual mode | Config path                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| Max output token request-parameter mapping | `optionSpecs.maxOutputTokens.map`                                          |
| Tool-call capability                    | `properties.supportsToolCall`                                                 |
| Audio input capability                  | `properties.inputFormat.supportsAudio`                                        |
| Fixed text input / text output declarations | `properties.inputFormat.supportsText`, `properties.outputFormat.supportsText` |

Model ID is identity and `enabled` is independent on/off; neither is rewritten by a mode switch. `enabled`
keeps its optional/null semantics and any explicit personal value; closing smart config does not copy a new
enable override from the effective config.

"Editable" is an explicit product field contract, not inferred from DOM disabled state, client type or
transient state. New internal fields are outside the manual freeze by default; a new user setting must
explicitly change the contract and tests. System-owned does not mean always writing true/false or fixed
parameter names: facts keep coming from the current rule source. UI defaults never fabricate system fields
and an empty `{}` mapping is never auto-written to fix a save error.

## 3. Layer 2: manual schema and write boundary

Keep Provider/Model exact rules, the `manualProviderModelRules` collection and nested names. A manual
rule's `config` requires **complete editable fields** and no system fields. optionSpecs shape:
`reasoningLevel: { values: readonly string[]; map: string }`, `maxOutputTokens: { max: number }`;
properties follow section 2; `inputFormat` requires only image/video/pdf. Editable leaves keep type and
validation (positive integer, non-empty unique reasoning levels, valid CEL); `false` is a valid user value
and a valid `{}` reasoning mapping follows the original validation. The layer is not made arbitrary
partial (that would let missing manual fields inherit the recommendation).

Principles:

- Derive from existing leaf schemas by pick/omit/extend with `z.infer` types; no second hand-written type or validation.
- The manual field contract lives in the Provider domain; UI reuses it or its field-extraction function; the domain never imports UI.
- Schema, save extraction and resolution overlay use the same ownership basis (no three lists).
- New manual rules never allow system fields; no object spread of `currentModel.config`, old personalConfig or full `inputFormat`.
- Keep member validation, duplicate IDs, built-in models not renameable, revision conflicts and atomic member/order/rule commits.
- Smart mode keeps the sparse-override semantics; the page must not auto-add hidden-field overrides from conservative display defaults.

## 4. Layer 3: final config composition

The whole-config clearing is replaced by composition that keeps system fields, using the existing rule
engine, rule layers and Host/CLI same-source resolution (no second "manual Registry").

```text
current Provider / model / API format / Base URL
  -> existing system rule resolution
  -> extract and keep system-owned fields + original enable semantics
  + complete manual editable fields
  -> final model config -> existing completeness/executability validation
```

1. Manual editable fields no longer follow system recommendation changes; missing ones are rejected by the manual schema, never silently filled.
2. System fields keep resolving from the current identity (Builtin updates and access changes take effect); they are not frozen into personal config.
3. After A -> B, system fields are never filled from A's baseline or cache; an already kept user editable draft remains explicit user intent.
4. Closing smart config only stops writing recommendations into the editable form; final-config system rule resolution continues.
5. `completeModelConfigDataSchema` and the Registry's full-config admission stay strict; manual mode does not tolerate missing execution-required fields.
6. Existing Models and running requests keep their frozen lifecycle; changes apply at the existing Registry update and next model resolution boundary.

## 5. Layer 4: page and draft lifecycle

### 5.1 Switch and mode change

- The switch is always shown; `disabled` is controlled only by saving. Empty ID, resolving, failed resolution and no recommendation can all switch.
- On close: keep existing editable input and fill valid editable recommendations already obtained for the current model. Values not obtained (numbers, reasoning levels, mapping) stay empty; capability controls keep their explicit form defaults, not presented as recommendation.
- Hidden fields are not copied; `maxOutputTokensMapValue` etc., if only used for freezing, lose their draft-save role. The fallback `draft.map ?? currentModel.config.map` is removed rather than masked by a new fallback.
- After close, the existing edit generation/identity check invalidates in-flight recommendations; no extra request/state cache.
- Re-enabling still clears editor-managed personal overrides and fetches the recommendation for the current identity; later edits are kept; `enabled` unchanged.
- `pending` no longer decides switch availability. Mode changes only edit the draft; save persists, cancel writes nothing, failure keeps edits. Add and edit share the logic and keep identity-permission differences.

```text
recommendation resolving/failed -> user closes smart config
  -> freeze editable draft, stale recommendation replies invalid
  -> manual edit -> editable-field validation -> atomic personal rule save
  -> system fields still composed from the current Registry; late replies never write into the manual draft
```

### 5.2 Two kinds of error

| State                                                | Handling                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| User-editable field missing/invalid                  | block save, locate the field                                                           |
| Editable fields complete but system config lacks execution fields | allow saving the valid personal rule; model stays non-executable in the Registry with the config problem shown |

The existing "incomplete model can be repaired in settings but not executed" candidate mechanism is kept.
A missing `maxOutputTokens.map` no longer reports a user-cap input error; no hidden-field editor is added;
actual Model creation checks are not relaxed.

## 6. Compatibility stays light (assumed unpublished)

No version bump, dual write, new file, complex migrator or rollback system.

- Do one bounded publication-fact check at implementation; without contrary evidence treat it as an unpublished in-branch format.
- For full manual records that may exist in the current dev environment, normalize locally: keep editable fields, Provider/Model identity and `enabled`; old frozen system fields do not take part in the new manual override. Do not delete the whole personal config or reset unrelated Providers/default selection/order.
- Check the codec and Repository read-normalize-write so the new strict schema does not mark an old full manual record bad and lose the personal view. Handle only at boundaries that clearly recognize the old manual structure; do not swallow all unknown fields/invalid files.
- If clear evidence appears that the full manual format was officially published, state the evidence and the needed compatibility adjustment; "should not exist" is not rewritten as a verified permanent waiver.

## 7. Modification locations

| Layer             | Main location                                                                                      | Purpose                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Field contract/schema | `packages/provider/src/config/rule-data-schema.ts`; reuse leaves of `packages/shared/src/model-config.ts` | manual requires editable fields only; final schema not weakened |
| Rule composition/write | `packages/provider/src/config/model-config.ts`, ConfigService/Facade write boundary           | system fields inherited, manual fields override explicitly |
| Draft/submit      | UI `ProviderModelMetadata.ts`, `ProviderModelDraftState.ts`, `useProviderModelDraft.ts`            | materialize editable items only; drop old-model and hidden-field fallbacks |
| Page              | UI `ProviderModelMetadataDialog.tsx`                                                               | always show switch, disable only while saving            |
| Local format      | `packages/provider-node/src/provider-config-file-codec.ts`, `personal-provider-config-repository.ts` | local handling of old dev records                      |

UI paths are relative to `packages/ui/src/settings/model-provider-section/`.

## 8. Implementation result and verification

- `manual-model-config.ts` derives the new schema from a shared strict-leaf pick; types come from `z.infer`. New fields are outside the manual contract by default; `enabled` keeps optional/null meaning and `false` is a valid manual value. Composition clears the editable baseline first and then overlays manual values, so directly-built incomplete rules cannot become executable via inheritance.
- The strict file boundary exposed that `ModelPropertiesConfig.toJSON()` did not recursively call the input/output format `toJSON`, mixing undefined system keys of class instances into validation; nested serialization was fixed instead of relaxing the schema. Old valid full manual shapes are extracted locally in the codec while new API writes still reject system fields; default selection, order and independent enable state of real files are preserved; bad-old-file protection tests still pass.
- UI: hidden map/tool-call draft duties removed; audio/fixed text no longer materialized by the editor; closing saves editable content only. A -> B unresolved never falls back to A's config; switching back to smart clears only editable overrides, not existing system leaves/enable state. Switch always shown, disabled only while saving.
- Tests: two domain failing tests (old schema rejected the new manual shape), codec/draft failing tests (hidden fields still materialized); then Provider, Provider Node and UI draft/component tests (42 files, 498 passed), a real temporary Repository write/reopen/enable test (8), and targeted draft tests (37). Real Hook+dialog browser checks (390/zh-CN/light, 1200/English/dark) passed: empty ID makes no request, switch operable, stale success/failure after close never overwrites the draft. Root typecheck passed, lint 0 errors / 41 existing warnings, architecture 0 violations. No Pro/Electron/phone shared-host run is claimed.

| Case    | Setup and action                                                | Must prove                                                              |
| ------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| M120-01 | add/edit with empty ID, resolving, failed, no recommendation; toggle mode | switch present and usable; disabled only while saving; smart -> manual works |
| M120-02 | A -> B, B unresolved, close, fill editable items, save          | no A system-field fallback; saved rule has no hidden fields; final internal config from B |
| M120-03 | on->off->on, A->B->A, switch Provider, close dialog, reversed resolve order | stale replies never overwrite manual/new-generation draft; smart config not auto re-enabled |
| M120-04 | manual config pins editable values; system updates capability and mapping | user fields unchanged; system fields update; enable semantics unchanged |
| M120-05 | manual missing any required editable field, or system field supplied | new-write schema rejects precisely; `false` and valid CEL accepted    |
| M120-06 | visible fields complete, system maxOutput mapping missing; save then try to create Model | personal rule saves; candidate shows accurate system config problem and cannot execute; no false numeric error |
| M120-07 | dev-env old full manual record incl. other Providers, default selection, order | local normalization keeps user values/identity/enable; no whole-file clearing or unrelated loss |
| M120-08 | save+reopen, cancel, save failure, revision conflict, re-enable then edit | mode and values correct; cancel writes nothing; failure keeps edits; new edits not swallowed by restored recommendation |
| M120-09 | smart mode untouched fields / explicit override / explicit false | sparse intent kept; no hidden-field overrides produced                 |
| M120-10 | desktop, phone existing settings entries and CLI/Host consume the same config | ownership and final config agree; no new cross-end write fork; remote identity and message flow unchanged |

APP interaction needs E2E covering close click, fill, save, reopen and cancel (existing pending smart-config
cases updated per the E2E lifecycle). Desktop and phone keep shared-host, continuous/replayable boundaries.

## 9. Non-goals and open items

No hidden-field editor, no renaming of smart/recommended types, no change to the model catalog/Builtin
recommendation values, auth/plan/telemetry/Composer, Todo128/129, or personal config file architecture.
Todo125 question-mark help and copy are separate. Risks: incomplete field extraction, old-value fallback,
system fields written again, manual gaps masked by recommendation. Open: final batch acceptance and
real-end (Pro/Electron/phone shared-host) verification.
