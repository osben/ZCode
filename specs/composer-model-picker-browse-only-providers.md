# Composer model picker: provider rows are browse-only

Supersedes the "switching provider immediately selects the first unlocked model" rule in
`docs/composer-model-thinking.md` (user decision on ISSUE-058).

Source rule: `docs/ui/chat-model-select-menu.md` (Current implementation): with several providers the first level lists
providers; choosing one in the provider list shows that provider's models. Browsing never
changes the selection.

## Rules

1. A provider row (flyout on desktop, provider page on narrow < 640px) only chooses which provider's models
   the Models list shows. Only an explicit choice browses: a click, or Enter/Space on a focused row. Choosing a row
   also closes the desktop flyout (the narrow page returns to the model page). Hovering a row or arrowing between
   rows only moves the highlight and focus; it never browses, so the Models list and the panel height stay still
   while the pointer travels over the provider list. None of these ever calls a model, effort, or connection write.
2. The model, the effort, and the account connection (Individual / Team / API) change only when the
   user picks a model row.
3. Browsing never touches effort. While a non-selected provider is browsed the Effort area shows
   the empty-value placeholder and the slider is disabled (existing rule for a non-selected group); returning to the
   selected provider shows the unchanged effort.
4. Picking a different model follows the existing model-change rule: the target model's catalog
   default level, else its highest level (`completeNewModelSelection`,
   `docs/conversation-session-case-catalog.md` I42, `docs/subagents-built-in-model-overrides.md`).
   The source model's effort is not carried over.
5. Re-picking the already selected model in the selected provider is a no-op while its effort is
   valid: it does not rewrite the draft and does not reset effort. With a missing or invalid effort
   the pick is forwarded and the model default fills it, as before. After a failed connection switch
   (provider menu error) the pick is still forwarded so the user can retry.
   6a. When the picked model is not in the target connection's synchronized catalog, the switch
   fails inside synchronization, so the persisted account connection is rolled back and the current
   model is kept; no other model is chosen in its place.
6. A pick inside a browsed provider other than the selected one goes through the existing
   connection-switch owner (`useComposerConnectionSwitch`) with that exact model, so team rows that
   share model values with another team still switch the account connection, and the loading /
   error / presentation-receipt rules stay as they are.
   6b. An inactive account plan (Individual or Team not in the executable registry) lists the
   enabled models from its Provider Settings view, so it stays reachable through a model pick; the
   switch then re-checks that model against the synchronized catalog (rule 6a).
7. The provider list's check mark stays on the selected provider, not the browsed one. The provider
   trigger row shows the browsed provider.
8. Browse state is UI-local to the open menu. It resets when the menu closes (the menu content
   unmounts) and is dropped as soon as the selected model changes.
9. A pick outside the selected group (a browsed group, or the display fallback group when no model
   is selected) goes through the connection owner (rule 6).

10. Layout (upstream 4.0.0 source): the panel is a Popover (`composer-model-panel`, fixed `w-72`), not a menu.
    The provider trigger row opens the provider flyout on mouse hover, click, or ArrowRight; the flyout is its own
    Popover pinned to the panel's right edge (4px gap) and the panel's top, so it does not move with the trigger row.
    It stays open while the pointer is over the trigger, the flyout, or the corridor between them, and closes when
    the pointer leaves all three. Provider rows and model rows are `role="option"` buttons inside `role="listbox"`
    groups with roving focus (arrows move, Home/End jump, focus wraps). Picking a model row closes the provider
    flyout on every input path (mouse, keyboard, a hover-opened flyout), so the next Escape closes the panel.
11. Search: a search box next to the Models heading filters the shown group's models by name (case-insensitive,
    trimmed). The query belongs to the shown group and resets when the shown group changes (browse, or the
    selection moving to another group). ArrowDown in the box focuses the first enabled model row. A clear button
    appears while the query is not empty. No match shows "No models found".

Unchanged: Recent is written only on an accepted send; an unresolvable stored pick is never dropped
(ISSUE-026/035); locked models are not selectable; Ctrl+M only opens the menu.

## Owners and event order

```text
provider row (click / Enter / Space)
  → ComposerModelMenu.browse (UI-local)  → Models list shows browsed group
                                            (no draft / settings write)

model row in the selected provider
  → same value?  yes → no-op
                 no  → ModelConfigSelect.onValueChange → useDraftConfigControl.selectModel
                       → completeNewModelSelection (target default effort) → Composer draft

model row in a browsed provider
  → providerMenu.onSelectModel(group, value)
  → useComposerConnectionSwitch.select(connection, previousKey, modelName)
  → [persist account connection when the row has one] → target Host catalog
  → onSelectModel(value, target default effort) → Composer draft → presentation receipt
```

The Composer draft stays the single owner of model and effort. Desktop `desktop-continuous` and
mobile `web-remote-replayable` paths are unchanged; the menu is the same React component on both.

## Acceptance scenarios

- Model `deepseek/...flash` with effort Off; open the picker, browse LM Studio, Local, then
  OpenRouter: `data-model-current-value` and effort stay as they were after every step.
- Same with keyboard: ArrowRight into the provider list, Enter on another provider: no change.
- Hovering provider rows on desktop changes neither the Models list nor the panel size; clicking one shows its
  models, closes the flyout, and writes nothing.
- The flyout's top edge and left edge stay at the same screen position while the pointer moves between rows.
- Search `pro` in a provider with Flash and Pro: only Pro is listed; `zzz` shows "No models found"; browsing
  another provider clears the query.
- Narrow width: choosing a provider on the provider page returns to the model page showing that
  provider's models; nothing is selected.
- Browse to another provider and pick a model: the model changes and effort becomes the target
  model's default.
- Browse away, come back, and click the checked model: effort stays as it was.
- Team rows: browse "Team Two" and pick its model: the connection switch runs with that model.

Coverage: `packages/ui/test/composerModelPickerBrowseOnly.test.ts`,
`packages/ui/test/browser/manual-review/pending/composer-provider-flyout.test.mjs` (real Chrome: hover walk keeps panel,
flyout and Models list still; on the pre-port code the panel shrank 383→208px and moved 175px),
`packages/ui/test/composerModelThinking.test.ts`, `packages/ui/test/composerPlanGroups.test.ts`,
`packages/ui/test/composerTeamMenu.test.ts`, `packages/ui/test/v4ComposerToolbarRecovery.test.ts`,
`packages/ui/test/composerConnectionSwitch.test.ts`.

## Fork deltas over 4.0.0

`ComposerModelMenu.tsx`, `ComposerProviderMenu.tsx` and the composer branch of `ModelConfigSelect.tsx` are upstream
4.0.0 source. Upstream switches the model on a provider click (first unlocked model of that provider) and marks the
browsed provider as selected. The fork keeps rules 1 to 9 on top of the upstream layout with these deltas only:

- Provider click: browse only (`setBrowse`), never `providerMenu.onSelect` or `onSelectModel`. The upstream
  `providerMenu.onSelect` option and the `isItemLocked`/first-unlocked-model fallback are removed from the menu.
- Provider list check mark, `aria-selected` and roving active item follow the selected model's group
  (`selectedKey`); the trigger row shows the browsed group.
- Model row click goes through `ComposerModelItemsOptions.onSelect` (connection owner via
  `providerMenu.onSelectModel` for picks outside the selected group, no-op re-pick); the row check follows
  `selectedValue`, which is empty while another group is browsed.
- A model pick closes the provider flyout explicitly. The flyout state lives in `ComposerModelMenu`
  (`providersOpen`, passed to `ComposerProviderMenu` as `open`/`onOpenChange`), so a pick that does not start with a
  pointerdown outside the flyout (keyboard, programmatic click) cannot leave the flyout open above the panel. A
  selection change from a row outside the Models list (for example Recent) closes it too.
- Browse state is dropped as soon as the selected model changes; the search query belongs to the shown group.
- E2E helpers: `closeComposerModelPanel` (`packages/desktop/test/e2e/helpers/composer-model-picker.ts`) repeats Escape
  until the panel is closed, because the flyout can stay mounted briefly after a pick; `switchV4Model` opens the
  flyout to reach provider rows.
