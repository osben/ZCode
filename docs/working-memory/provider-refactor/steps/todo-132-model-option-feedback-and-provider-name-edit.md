# Todo132: Model option background feedback and Provider name edit fix

> Status: implemented on 2026-09-11; local review and verification passed; final batch acceptance pending.
>
> Two final decisions: (1) only strengthen the selected background of model block options; text/icons stay
> unchanged and the border keeps expressing personal override only. (2) Custom Provider name editing has no
> timed save: Enter/blur confirms, Esc abandons the current edit; the auto-save of address/API Key is kept.
>
> Related: [Todo92](./todo-92-model-smart-config-and-override-feedback.md),
> [Todo130](./todo-130-manual-model-config-editable-field-boundary.md),
> [Todo131](./todo-131-model-settings-smart-config-placement-and-restore.md).

## 1. Model block options: weak click feedback

Scope: the block options in the model editor (image/video/PDF, model capabilities, MFJS); not a site-wide
Switch rework, no change to the smart-config sliding switch colors.

Problem: `modelEditorControlStyle()` expressed on/off mostly by background. In the Zai light theme
`--color-selected` and `--color-hover` are both `rgba(13,13,13,0.05)`, so unselected hover and selected
hover look identical; dark theme (10% vs 5% white, with a blended selected hover) differs only slightly
(composited examples: light about `#f3f3f3` both; dark about `#2b2b2b` vs `#313131`). The user rejected
strengthening text/icons; no text color, bold or icon emphasis.

| State dimension        | Final rule                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| On/off                 | background difference only; light selected darker, dark selected lighter                             |
| Hover / keyboard focus | slight interaction background change; on and off still clearly different; off-hover must not look on |
| Personal override      | border keeps expressing override source only; no border-as-switch, no thicker border or focus ring   |
| Text/icons             | original color, weight, glyph, size                                                                  |
| Layout/controls        | size, spacing, icons, groups unchanged; no checkbox, check mark or on/off text                       |

Fix locally in the model editor; do not change global `--color-selected` / `--color-hover` or other pages.
`modelEditorControlStyle` is shared with text-input/map editors, so only the boolean-selected branch
changes. The fixed text input/output options stay locked. Acceptance focus: **clicking the same button
repeatedly without moving the mouse shows each on/off change clearly**; also check mouse-away, keyboard
focus and phone touch.

## 2. Provider name auto-save made Esc ineffective

Problem: `MODEL_PROVIDER_TEXT_IDLE_TRIGGER_MS = 1200`; name input and IME composition end scheduled the
shared auto-save, and `handleNameKeyDown()` on Esc restored `getProviderFormLabel(provider)` (the current
saved/projected name, not the value at edit start). So A -> B -> idle auto-commit B -> Esc restored B, not
A. Also `commitPendingDraft()` saves the whole Provider draft, so address, API Key, connection test and
cleanup entries could carry the name; removing only the name timer was not enough.

### 2.1 Final interaction

| Action                            | Behavior                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Enter name editing                | create a name-edit draft and edit identity; show the current name                               |
| Type / pause / composition end    | edit the name draft only; no timed save; does not exit editing                                  |
| Enter (not IME candidate confirm) | confirm: save and end the edit, reusing the blur commit with no duplicate write                 |
| Blur                              | confirm save and exit; blank/unchanged name keeps existing validation and no-commit rule        |
| Esc (not IME composing)           | abandon this edit, restore the name shown at edit start, exit; no save or compensating rollback |
| IME candidate confirm             | keep the composition guard; candidate Enter is not a confirm-save                               |

Esc cancels the **local unconfirmed name draft**; it does not write back remote/other-window changes.
After exit the authoritative Provider View is shown; no rollback writes an old whole Provider.

### 2.2 Isolation from other save entries

```text
name draft --Enter / real blur confirm--> name save
        `--Esc--> discard name draft (no write)
address / API Key draft --original idle / blur / cleanup--> original save (never carries an unconfirmed name)
```

- An unconfirmed name never joins idle, connection-test, model-operation or cleanup commits of other fields; reuse existing field ownership and commit boundaries (no second Provider service or persistence protocol).
- Name composition start/end starts no timer; isolation must not cancel address/API Key pending-save intents.
- Esc invalidates the name commit intent first, then exits; later blur, unmount or cleanup must not resubmit the name from a stale closure.
- Enter-triggered blur commits once; unchanged name does not commit; only real blur confirms (events after Esc do not count).
- On Provider switch/unmount, normal blur confirms commit to the old target; cleanup does not secretly save an unconfirmed name nor apply an old result to a new Provider.
- Existing save-failure prompt/retry and Provider update protection stay; no fake success; no "auto-save B then send A" compensating rollback.
- No change to address/API Key/API format save timing, shared idle delay, name schema, permissions or server revision/atomic write rules.

## 3. Modification entries

Relative to `packages/ui/src/settings/model-provider-section/`:

| Item              | Location                                                                                                  | Boundary                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Block feedback    | `modelEditorControlStyle.ts`; check `ProviderModelMetadataFields.tsx`, `ProviderModelModalityOptions.tsx` | local selected/hover background only         |
| Name interaction  | `InlineEditableProviderCard.tsx`, Header in `ProviderCardSections.tsx`                                    | name edit draft, Enter/blur/Esc, IME events  |
| Commit isolation  | `ProviderDraftSave.ts` and the `commitPendingDraft` call sites                                            | adjust field extraction only if needed       |
| Shared scheduling | `useIdleTrigger.ts`                                                                                       | check consumers only; no global timer change |

## 4. Verification

| Case    | Scenario/action                                                          | Must assert                                                                                                           |
| ------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| S122-01 | both themes, mouse stays, toggle image/capability/MFJS repeatedly        | selected/unselected backgrounds clearly differ; text, icon, size unchanged                                            |
| S122-02 | not overridden / overridden x on/off x hover/keyboard focus; phone touch | border means override only; off-hover does not look on; no new ring/checkbox; touch state distinguishable             |
| S122-03 | number/map inputs on the same page and other settings controls           | not affected by the option style change; fixed locked options still cannot toggle                                     |
| N122-01 | A -> B, keep editing longer than the old idle time, then Esc             | no save on timeout; Esc restores the old name/exits; advancing timers or cleanup never writes B                       |
| N122-02 | A -> B, Enter / click outside                                            | saves the correct name exactly once; unchanged/blank follows the old rules                                            |
| N122-03 | address/API Key auto-save, connection test while name unconfirmed        | other fields save as before without the unconfirmed name; Esc does not clear other fields' intent                     |
| N122-04 | blur/cleanup after Esc; switch Provider; delayed save reply              | cancelled name not resubmitted; no overwrite of a new Provider or newer state                                         |
| N122-05 | Chinese IME input / candidate Enter / composition end                    | no mid-way confirm or timed save; real Enter/Esc still work                                                           |
| N122-06 | name save success/failure, re-enter editing                              | success shows authoritative name; failure has feedback and retry path; no fake success or compensating old-name write |

Name tests use real component events with controlled time/Promises and verify actual save calls/output.
Style needs real browser computed style plus interaction screenshots in both themes and representative
desktop/phone widths. APP E2E covers start edit, pause, Esc, Enter and blur through a test Service/isolated Repository.

## 5. Implementation result (2026-09-11)

- The name no longer calls idle schedule/cancel; Enter/blur enter the save explicitly via `nameConfirmed`, and other save entries exclude the name by default; Esc cancels the edit identity before exit with no compensating write. Switching Provider clears the old edit identity and invalidates the old feedback revision. Connection draft timing unchanged.
- Tests reproduced the idle false-save and Key-save-carries-name first; after the fix with Todo115, 109 unit tests pass, including IME, single confirm, blur/cleanup after Esc, Key preserved, save-failure retry and target switch. No second save service/Schema.
- Boolean model options locally use a foreground 15% background and hover/focus 20%; the off state and text/Map input branches unchanged. Real browser same-position repeated clicks on image/capability/MFJS show distinct backgrounds with unchanged text/icon color, size and override border; fixed text stays locked.
- 6 browser component cases pass; computed values and screenshots are in `/tmp/zcode-provider-settings-batch/header-options-*.json`, `selected-*.png`. The local machine lacks Chinese fonts, so Chinese glyph rendering is not counted as passed.
- Root typecheck/lint pass. The Electron create-Provider helper now goes through the more-menu and blur-confirm; the Electron / real phone full chain is not claimed and stays in the final batch acceptance.
