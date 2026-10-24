# Todo131: Smart-config placement and the "restore" button in model settings

> Status: product implementation, local verification and review done; final batch acceptance pending
> (Goal authorized implementation on 2026-09-11).
>
> Later decision (2026-09-12): [Todo134](todo-134-model-editor-basic-advanced-draft.md) moves the smart
> config back to the fixed bottom left and makes restore an outline button placed to the left of save. The
> restore semantics and async protection here stay; the old layout no longer applies.
>
> Final name: **恢复** ("Restore"; not "reset", "restore recommendation" or "restore recommendation and
> save"). It only edits the current draft and takes effect on save. It works with an empty ID; it is
> disabled only while saving.
>
> Related: [Todo125 help copy](./todo-125-model-settings-help-copy.md) (help text and question-mark
> interaction stay valid), [Todo130 field boundary](./todo-130-manual-model-config-editable-field-boundary.md)
> (field ownership and mode conversion are reused, not redefined).

## 1. Decisions

- Restore does not save directly: the page has save/cancel, and an immediate persist could not be undone by cancel and would mix in unsaved model-ID edits.
- The smart-config switch moves into the model-ID container (ID input shortened, switch on the right, question mark moves with the title). The freed bottom-left holds the restore button; save/cancel stay on the right.
- Meaning: restore the current model's smart recommendation and turn smart config on, not restore the values saved when the dialog opened.
- Not disabled for an empty ID: it still clears editable overrides and turns smart config on, but sends no empty-ID recommendation request; filling the ID later matches through the normal chain.

## 2. Layer 1: layout

```text
[ Model ID                         Smart config ? ]
[ GLM-5.3                              [switch]   ]
... existing model config groups ...
[Restore]                              [Save] [Cancel]
```

- ID input keeps most of the width; the right smart-config area has a stable width and the switch never leaves the container.
- Long IDs scroll horizontally inside the input; values are never truncated or abbreviated; no new ID length limit.
- Narrow phone screens stack vertically inside the container; bottom buttons may wrap responsively.
- An inherited model ID is read-only but smart config stays switchable; while saving, body lock and switch disable stay.
- The question mark follows the "smart config" title (Todo125); the model ID gets no question mark.
- Restore uses the existing weak button style, save stays primary, save/cancel order kept; other groups, dialog scrolling, focus rules and visual hierarchy unchanged.
- Per Todo130 the switch is always shown and disabled only while saving; no second bottom switch remains.

## 3. Layer 2: restore action

### 3.1 What is restored

- Clears personal overrides of the current model's editable fields (both the saved overrides' draft representation and unsaved edits).
- Turns smart config on and restores recommendation for the current model ID, Provider and access config; when smart config was already on it still clears all overrides at once.
- Keeps the currently typed model ID (not the ID at open time), Provider, model enable state, members and order.
- System fields stay system-resolved per Todo130 (not copied to personal config, no frozen hidden mapping, no hidden-item editor).
- Does not restore other models, change Provider API Key/Base URL/connection config, or call a full-Provider reset; does not call the save API on click (never persists a pending rename).

### 3.2 Relation to save/cancel

```text
click Restore -> draft clears editable overrides + smart on
  -> Save: takes effect via existing validation, revision and atomic commit
  -> Cancel: discard draft, keep previously saved config
```

No confirmation dialog or direct-save entry. Fields edited after restore are new personal overrides; save must not unconditionally clear later edits because "restore happened".

### 3.3 Empty ID, failure and concurrency

| Condition                                           | Behavior                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Empty ID                                            | clickable; clears overrides and enables smart; keeps empty ID; no empty-identity request; matches after an ID is typed    |
| Current identity already has a valid recommendation | may reuse results still applicable to the current Provider/model/access; project the draft immediately                    |
| Re-resolution needed                                | restore is not disabled while resolving; only results for the current identity and this restore intent are applied        |
| Resolution fails                                    | keep the pre-restore draft, show failure in the existing feedback area (never clear first and let the user bear the loss) |
| Resolution succeeds but recommendation has gaps     | show only what was actually obtained; real gap feedback and save validation apply; nothing fabricated                     |
| Saving                                              | restore disabled; click cannot change the draft being submitted                                                           |

Apart from saving there is no extra disable condition (empty ID, already smart, no overrides, request in flight).

Async resolution stays atomic: keep the draft before resolution; apply once on success if identity and edit generation still match; failure never damages current edits. If the user changes ID, field, mode, Provider, closes the dialog or restores again while waiting, old results/errors never overwrite the new intent; a restore unfinished when saving starts must not mutate the draft during save. Reuse the existing edit generation / request identity; no fixed delay, second recommendation cache or separate state service.

## 4. Layer 3: implementation boundary

| Location                                                  | Purpose                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ProviderModelMetadataDialog.tsx`                         | smart config to the right of the ID container; bottom leadingAction becomes Restore; keep responsiveness, read-only ID and save lock |
| `ProviderModelMetadataDialogActions.tsx`                  | reuse existing Switch and action area; wire restore and saving-disable; no change to other pages' action order                       |
| `useProviderModelDraft.ts` / `ProviderModelDraftState.ts` | explicit draft action for restore, reusing the field cleanup/projection of enabling smart config, also covering "already smart"      |
| `ProviderFormControls.tsx` / `ProviderCardSections.tsx`   | add and edit share one restore entry; keep identity permissions, error display, revision and save transaction                        |
| i18n and existing help component                          | zh-CN button literally "恢复"; English translated with the same meaning; smart-config help per Todo125                               |

Paths relative to `packages/ui/src/settings/model-provider-section/` (except i18n/shared components).
Calling `onChange(true)` alone is not restore: when the mode is already on, a normal mode change may not
clear overrides, so the restore intent is explicit. No second field list or schema; the editable-field
contract, hidden-field removal and mode saving reuse Todo130. No new schema, persisted field, file, table
or protocol. May ship in the same batch as Todo130 but must not build a third restore mode on the old
"freeze the whole config" base.

## 5. Verification

| Case    | Scenario                                                                                | Must assert                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| R121-01 | wide/narrow screen, long ID, long translation, inherited ID read-only                   | switch only in the ID container, question mark placed correctly; Restore bottom left, save/cancel kept; no truncation or unreachable control |
| R121-02 | smart mode with overrides, click Restore                                                | overrides cleared, smart stays on; no immediate write; no dependence on switch false -> true                                                 |
| R121-03 | click Restore on manual config                                                          | editable items return to recommendation and smart on; ID/Provider/enabled kept; system fields not frozen                                     |
| R121-04 | Restore with empty ID, then type an ID                                                  | button usable, clears overrides, smart on, no empty-ID request; matches the current identity after typing                                    |
| R121-05 | restore -> edit -> save; restore -> cancel; save failure                                | new edits kept, cancel writes nothing, failure keeps the draft; the button itself never submits                                              |
| R121-06 | A -> B then Restore, B request slow/failing                                             | A's recommendation not used; failure does not clear the original draft; explicit error feedback                                              |
| R121-07 | restore in flight, then edit/switch mode/switch Provider/close/restore again/start save | stale success and failure never overwrite the new generation; no duplicate write or draft change during save                                 |
| R121-08 | saving=true / recommendation pending / no overrides                                     | disabled only when saving; otherwise allowed                                                                                                 |

Draft and mode are verified with the real Hook/pure functions; interaction by DOM/E2E clicks. Save/cancel
verify call counts and real Repository output (disk unchanged before save; after save independent enable
state kept). UI follows DESIGN.md, both themes and i18n; desktop and phone entries behave the same and keep
shared-host; continuous/replayable message flows untouched.

## 6. Delivered state and open items

Implemented: smart config at the right of the ID row (own row on narrow screens), Restore at bottom left.
Add and edit share one draft action and Todo130 field cleanup; ID, `enabled` and hidden config are kept and
the result is projected as a whole after restore succeeds. No new persisted field, protocol, recommendation
cache or save entry. The restore request reuses the existing recommendation Hook's request identity and
generation plus a current-draft edit-intent check; close, further edit and save start invalidate the old
restore intent; stale success and errors never overwrite a newer draft. Help entry and restore do not trigger each other.

Tests failed first (missing Restore button); then real Hook+dialog browser tests covered atomic restore,
failure, edit/mode/Provider/close/re-restore/save-start/ID change, empty-ID no request, no write on
restore, draft kept on save failure (390 zh-CN light and 1200 English dark pass); 60 related unit tests
pass; root typecheck (including Electron E2E), lint (0 errors / 41 warnings) and architecture (0
violations) pass. Electron `provider-model-smart-config` gained assertions (disk unchanged on restore +
cancel, restore + edit + save, independent `enabled` kept) and two affected settings cases were updated,
but **Electron was not run for this group**; real file interaction acceptance is left to the Goal batch
(Todo130's real-file manual/smart round trip passed separately).
