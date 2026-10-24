# Todo 82: Model Config "Follow Recommended" and Draft Materialization

> Status: done
>
> Date: 2026-09-04

## Background

The model edit dialog offered both a model-list-row switch and an in-dialog "enable" switch, both changing the same model `enabled`. The dialog bottom had "restore all defaults", but model config already uses a sparse merge of Built-in recommended values and the Personal Model Config Overlay and lacked an explicit "follow recommended" mode. This Todo folds the two interactions into one config-mode switch: the user either keeps following the Built-in recommended config or pins the current config as a full personal config. Switching changes only the dialog Draft; persistence happens on "Save".

## Product rulings

1. **Remove the duplicate enable entry in the dialog.** Delete the in-dialog "enable" switch beside the model ID and its Draft field. The list-row `enabled` switch stays the only UI entry for model enabled state. `enabled` remains a formal Model Config field but is outside the edit scope of the "follow recommended" switch.
2. **"Follow recommended settings" replaces "restore all defaults".** The dialog keeps one config-mode switch (zh: `跟随推荐配置`, en: `Follow recommended settings`). On = keep the current sparse Overlay logic; off = pin the current model's personal config. The bottom "restore all defaults" button and its duplicate interaction are deleted, with no second reset entry.
3. **Mode semantics.**

```text
follow recommended: on
  -> unoverridden fields use Built-in recommended values; Personal Overlay stays sparse
  -> when recommendations update, unoverridden fields follow

follow recommended: off
  -> the current Effective values are written into the Personal Overlay
  -> all editor-managed fields show real inputs
  -> Built-in recommended values no longer take part in these fields' result
```

The saved off-state is a complete Personal Overlay of the editor-managed fields, not a one-off UI snapshot. Saving in the on-state clears the model's Personal Overlay, restoring recommended values and placeholders.

4. **Draft-only switching.**

```text
open dialog -> read current Personal Overlay + Effective Built-in -> local Draft
  on -> off: materialize current Effective values into the Draft
  off -> on: clear the Draft Personal Overlay, restore placeholders
  keep editing: change only the Draft
  cancel: discard all Draft changes
  save: submit the current mode and config at once
```

Switching mode, editing fields and "restore recommended" never write Personal Config, refresh the Registry or trigger remote sync directly; only after a successful save, through the existing Provider Settings Facade single-save entry.

5. **Where the mode is stored.** The mode belongs to the Personal exact model config record of a concrete `providerId + modelId`, as one optional field:

```ts
{
  type: "provider-model",
  providerId,
  modelId,
  useRecommendedConfig: true,
  config: { /* Personal Model Config Overlay */ }
}
```

Missing or `true` = follow recommended; `false` = pinned personal config. The field is Settings config-mode metadata: not part of `ModelConfigObject`, not used by Model Registry, ModelFactory or request parameters. The `provider-model` Rule name and Provider/Model identity are unchanged; the UI calls it "personal model config" or `personalExactConfig`.

6. **`enabled` boundary.** "Follow recommended" covers only editor-managed fields: Context, Max Output, input/output types, capabilities, Reasoning, Mapping and advanced config. Model `enabled` is managed by the list-row switch only; a mode switch never silently enables or disables a model. "Complete Personal Overlay" means complete over editor-managed fields.

## Scope

- Extend the Personal exact model config record with the mode, ideally together with Todo 76's `provider-model` Rule cleanup; no Provider-level or Registry-level config.
- Add the switch to the model-edit Draft, updating form values, placeholders, Personal source styling and save-button state immediately.
- Turning follow off materializes from the latest Effective values (never a stale Built-in snapshot). Turning follow on clears the Draft Overlay; the earlier personal overrides are not kept and a mistaken action can be cancelled before saving.
- Save reuses the existing model Draft save entry and revision check; mode and config commit in one atomic operation.
- Before saving off-mode, validate that the Personal Overlay covers all editor-managed fields and that the resolution no longer depends on Built-in fill-in; a validation failure never partially saves.
- The old "restore all defaults" capability is carried by the switch; the old button, callback and state branches serving only it are deleted.
- A pure custom model with no Built-in recommended baseline hides or disables the switch and keeps ordinary Personal config editing.

## Non-goals

No change to Provider top-level config, Provider Template, Account Access or Provider/Model identity; no change to Model Registry, ModelFactory, Adapter or request protocol (Runtime does not read the mode field); no change to the list-row `enabled` semantics; no new "follow-recommended policy" or second Model Config Overlay type; no auto-save, auto Registry refresh or separate remote provisioning on switch.

## Tests and acceptance

- The dialog has no duplicate model "enable" control; the list-row switch is unchanged.
- Toggling after opening changes only the Draft; Personal Config, Registry and remote sync are unchanged before save.
- On -> off: all editor-managed fields are filled with the current Effective values, placeholders disappear, save yields a complete Personal Overlay.
- Off -> on: the Draft Overlay is cleared, fields return to recommended values/placeholders, save no longer keeps the old personal overrides.
- Cancel after switching restores the earlier mode and all fields, with nothing written to disk.
- Editing any field in off-mode and saving still yields a complete Personal Overlay; later Built-in updates do not change those fields. Re-editing and saving in on-mode keeps unoverridden fields following Built-in updates.
- `enabled` keeps its value through any mode switch and changes only through the list-row switch.
- Existing config without the mode field is treated as "follow recommended" with no migration.
- A missing or incomplete Built-in baseline never creates a half-built Overlay; saving fails explicitly with nothing partially written.
- Registry revision changes, concurrent saves and late responses do not overwrite a newer Draft with old Effective values.
- Run Provider Settings, Model Config, Registry and Settings UI unit tests and necessary desktop/remote regressions; confirm Model Selection, Automation, Subagent, Wiki and Composer selection semantics are unchanged.

## Relation to other Todos

Todo 55 keeps Model `enabled` and removes Provider top-level `enabled` (this Todo only removes the duplicate dialog entry). Todo 76 finished the Provider Site, Template Model and Provider Model Rule layering; the mode field joins the same exact Personal `provider-model` record with no new layer. Todo 77 is done and the switch reuses existing design-system controls. Todo 81 (selection invalidation notices) is independent of this config inheritance mode.

## Outcome (2026-09-04)

- The `provider-model` Personal Rule gained the optional `useRecommendedConfig` metadata (missing or `true` = follow, `false` = pinned); it never enters `ModelConfig` or affects Registry, ModelFactory or request parameters.
- The Settings Facade, Provider Config Service and UI Form Projection carry the field; saving still uses the existing revision check and a single Personal Repository update.
- The model-edit dialog dropped the duplicate enable control and the "restore all defaults" entry (the list row stays the only `enabled` entry) and gained the Draft-only "follow recommended" switch; a pure custom model with no Built-in baseline does not show it.
- Pinned-mode save materializes the current Effective editor-managed fields into a complete Personal Overlay; switching back to recommended clears the old Overlay only after an explicit user switch in this edit, while the independent enabled state is kept.
- Provider Config, Facade, Draft, Dialog and model-row regression tests added; 119 affected tests pass, `pnpm typecheck` passes, `pnpm lint` passes (40 existing warnings, 0 error).
