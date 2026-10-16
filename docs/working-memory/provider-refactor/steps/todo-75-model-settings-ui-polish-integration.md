# Todo75: Integrate Model Settings UI Polish and Adapt It to the Current Architecture

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promotion items are transferred to [Todo102](todo-102-verification-debt-closeout.md). This closes the separate verification schedule here; historical evidence remains and transfer does not mean tests passed.

> Later, outstanding Desktop graphical E2E verification was consolidated under Todo78; this Todo no longer has a separate schedule.

> Decision correction (2026-09-07): the statement below that there would be no Advanced settings group only records the result of that integration at the time; it was superseded by a later user decision. Add two titled, non-collapsible containers: “Reasoning settings” (levels + Mapping) and “Advanced settings” (MFJS). Todo88/R13 handles the omission.

> Status: Complete (code and local verification complete; Desktop graphical E2E remains for a Mac environment).
>
> Date: 2026-09-04
>
> Source: `fix/model-settings-ui-polish`

## Goal

Integrate model-settings-page UI improvements from the designer branch into current m2 and make the necessary adjustments for the current Provider-refactor code. Change only presentation, layout, interaction, and related tests. Do not change Provider, Registry, Overlay, model-selection persistence, or request/runtime semantics.

## Changes to Retain

- Field layout in the model-edit dialog, including Model ID and enable-switch placement.
- Icon-based options for input modalities and model capabilities.
- Reasoning-level editor size and add entry point.
- Model-list padding, dividers while dragging, and Add Model button.
- Settings header action buttons and Provider save-feedback styling.
- Model-settings unit tests and E2E coverage added in the designer branch.

## Cleanup After Integration

- The product at that time had no “Advanced settings” layer; remove related collapse/grouping and documentation language.
- Use ordinary UI font for reasoning levels as in the designer's proposal.
- Keep E2E structural and behavioral assertions, reducing unnecessary coupling to specific CSS classes, pixel spacing, and internal implementation.
- Ensure Model ID input and enable switch remain usable in narrow windows; do not add extra responsive semantics.
- Preserve lower-layer compatibility data such as Audio/PDF; do not silently remove it because the UI is narrower.

## Execution and Acceptance

1. Merge `origin/fix/model-settings-ui-polish` and record the result.
2. Apply the cleanup above in current m2 and verify Provider abstractions and save flow remain unchanged.
3. Run model-settings-related unit tests, E2E, `pnpm typecheck`, and `pnpm lint`.
4. Review the full change scope and check for obvious regressions across desktop/Web, Chinese/English, and light/dark themes.
5. After verification passes, commit and push the current m2 branch.

## Implementation Results

- Merged `origin/fix/model-settings-ui-polish`, retaining the designer branch's UI changes and test coverage.
- Removed the then-nonexistent product “Advanced settings” layer; Reasoning, Mapping, and MFJS Tool Schema were displayed directly as ordinary model config.
- Synced implementation, E2E, and design documentation. Provider, Registry, Overlay, model-selection persistence, and request/runtime semantics were unchanged.
- Seven model-settings UI test files passed 74 tests, as did `pnpm typecheck`, `pnpm lint`, and the affected pre-push tests. Desktop graphical E2E was not run in the current environment and needs to be rerun on Mac using the existing procedure.
- Merge commits: `700b5ba77c`, `d10f45c65f`; pushed to `provider-refactor-m2`.
