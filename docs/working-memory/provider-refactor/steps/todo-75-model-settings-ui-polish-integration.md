# Todo75: Integrate Model Settings UI Polish and Adapt It to the Current Architecture

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promotion items are transferred to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence remains and transfer does not mean tests passed. Desktop graphical E2E was also consolidated under Todo78.

> Decision correction (2026-09-07): the statement below that there would be no Advanced settings group only records the result of that integration at the time; it was superseded by a later user decision. Add two titled, non-collapsible containers: "Reasoning settings" (levels + Mapping) and "Advanced settings" (MFJS). Todo88/R13 handles the omission.

> Status: Complete (code and local verification complete; Desktop graphical E2E remains for a Mac environment).
>
> Date: 2026-09-04
>
> Source: `fix/model-settings-ui-polish`

## Goal

Integrate the designer branch's model-settings-page UI improvements into current m2 and adjust them for the current Provider-refactor code. Change only presentation, layout, interaction and related tests; Provider, Registry, Overlay, model-selection persistence and request/runtime semantics stay unchanged.

## Retained from the designer branch

- Field layout in the model-edit dialog, including Model ID and enable-switch placement.
- Icon-based options for input modalities and model capabilities.
- Reasoning-level editor size and add entry point.
- Model-list padding, dividers while dragging, and Add Model button.
- Settings header action buttons and Provider save-feedback styling.
- Model-settings unit tests and E2E coverage added in the branch.

## Cleanup after integration

- At that time there was no "Advanced settings" layer; related collapse/grouping and documentation language were removed.
- Reasoning levels use the ordinary UI font.
- E2E keeps structural and behavioral assertions, with less coupling to CSS classes, pixel spacing and internals.
- Model ID input and enable switch stay usable in narrow windows with no extra responsive semantics.
- Lower-layer compatibility data such as Audio/PDF is preserved, not silently removed because the UI is narrower.

## Outcome

- `origin/fix/model-settings-ui-polish` was merged (merge commits `700b5ba77c`, `d10f45c65f`; pushed to `provider-refactor-m2`), keeping its UI changes and test coverage.
- Reasoning, Mapping and MFJS Tool Schema displayed directly as ordinary model config; implementation, E2E and design docs synced; Provider, Registry, Overlay, selection persistence and runtime semantics unchanged.
- Seven model-settings UI test files passed 74 tests, plus `pnpm typecheck`, `pnpm lint` and the affected pre-push tests. Desktop graphical E2E was not run in that environment and needs a Mac run.
