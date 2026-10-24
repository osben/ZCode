# Composer model picker: provider rows are browse-only

Status: accepted 2026-10-23 (user decision on ISSUE-058). Supersedes the "switching provider
immediately selects the first unlocked model" rule in `docs/composer-model-thinking.md`.

Source rule: `docs/ui/chat-model-select-menu.md:13` — with several providers the first level
lists providers; hovering or keyboard-opening the submenu shows that provider's models.
Browsing never changes the selection.

## Rules

1. A provider row (submenu on desktop, provider page on narrow < 640px) only chooses which
   provider's models the Models list shows. Clicking it, pressing Enter/Space on it, or
   hovering it never calls a model, effort, or connection write.
2. The model, the effort, and the account connection (Individual / Team / API) change only
   when the user picks a model row.
3. Browsing never touches effort. While a non-selected provider is browsed the Effort area
   shows "—" and the slider is disabled (existing rule for a non-selected group); returning
   to the selected provider shows the unchanged effort.
4. Picking a different model follows the existing model-change rule: the target model's
   catalog default level, else its highest level (`completeNewModelSelection`,
   `docs/conversation-session-case-catalog.md` I42, `docs/subagents-built-in-model-overrides.md`).
   The source model's effort is not carried over.
5. Re-picking the already selected model in the selected provider is a no-op while its effort
   is valid: it does not rewrite the draft and does not reset effort. With a missing or invalid
   effort the pick is forwarded and the model default fills it, as before. After a failed
   connection switch (provider menu error) the pick is still forwarded so the user can retry.
   6a. When the picked model is not in the target connection's synchronized catalog, the switch
   fails inside synchronization, so the persisted account connection is rolled back and the
   current model is kept; no other model is chosen in its place.
6. A pick inside a browsed provider other than the selected one goes through the existing
   connection-switch owner (`useComposerConnectionSwitch`) with that exact model, so team rows
   that share model values with another team still switch the account connection, and the
   loading / error / presentation-receipt rules stay as they are.
7. The provider list's check mark stays on the selected provider, not the browsed one. The
   provider trigger row shows the browsed provider.
8. Browse state is UI-local to the open menu. It resets when the menu closes or when the
   selected model changes.

Unchanged: Recent is written only on an accepted send; an unresolvable stored pick is never
dropped (ISSUE-026/035); locked models are not selectable; Ctrl+M only opens the menu.

## Owners and event order

```text
provider row (click / Enter / hover)
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

The Composer draft stays the single owner of model and effort. Desktop
`desktop-continuous` and mobile `web-remote-replayable` paths are unchanged; the menu is the
same React component on both.

## Acceptance scenarios

- Model `deepseek/...flash` with effort Off; open the picker, browse LM Studio, Local, then
  OpenRouter: `data-model-current-value` and effort stay as they were after every step.
- Same with keyboard: ArrowRight into the provider list, Enter on another provider — no change.
- Hovering a provider row only highlights it; nothing is written.
- Narrow width: choosing a provider on the provider page returns to the model page showing that
  provider's models; nothing is selected.
- Browse to another provider and pick a model: the model changes and effort becomes the target
  model's default.
- Browse away, come back, and click the checked model: effort stays as it was.
- Team rows: browse "Team Two" and pick its model: the connection switch runs with that model.

Coverage: `packages/ui/test/composerModelPickerBrowseOnly.test.ts`,
`packages/ui/test/composerModelThinking.test.ts`, `packages/ui/test/composerTeamMenu.test.ts`,
`packages/ui/test/v4ComposerToolbarRecovery.test.ts`, `packages/ui/test/composerConnectionSwitch.test.ts`.
