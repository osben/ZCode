# Todo143: Match Model-setting Checkboxes to System Colors

Status: Implemented and locally verified/reviewed. The user authorized implementation and MR creation on 2026-09-12.

## Requirements and Boundaries

- Checkboxes for input types and model capabilities use system Checkbox colors: selected `border-primary bg-primary text-primary-foreground`; unselected `border-input-border bg-input`.
- Selected Zai dark-theme checkbox: white box / black check. Light theme: black box / white check. Do not let the border invert with the check mark.
- Retain the 16px square, 12px Check icon, and the outer option button's background feedback, personal-overlay border, dimensions, click, and keyboard semantics. Text remains required and cannot be unchecked.
- The indicator remains a non-interactive decorative element. Do not nest an interactive Checkbox inside the existing button, and do not change global components or model config/save behavior.

## Verification and Review

- First add computed-style comparison against the system Checkbox in a real-component browser fixture. Cover Chinese/light/mobile width, English/dark/desktop width, selected/unselected, and ordinary/personal-overlay options.
- Retain click, single keyboard toggle, outer highlight, and text-lock assertions; inspect screenshots and run relevant unit tests, typecheck, lint, and architecture check.
- Do not rerun full Mac Electron/real mobile remote-control suites for this color-only change. The browser fixture is not native end-to-end verification.

Root cause: the original `border-current` followed `text-primary-foreground`, making the border invert with the check. The fix only narrows the semantic colors for this indicator.

## Results

- TDD: both new color assertions failed under the old implementation. After the fix, two color/interaction tests and four Todo141 editor tests passed together (**6/6**); related unit tests passed **51/51**.
- `pnpm typecheck` (including desktop E2E types) and `pnpm lint` passed; lint reported 0 errors and 42 existing warnings. Architecture check reported 0 violations; `git diff --check` passed.
- Inspected `/tmp/zcode-provider-settings-batch/selected-{390,1200}-0.png`: light/dark box and check colors match the system control. Linux's current CJK font was incomplete and some Chinese glyphs were missing in screenshots; do not claim visual verification of Chinese typography. Color, size, and interaction assertions did run.
- Review: production change is one class branch on the shared indicator; both call categories are covered. No state, event, I/O, protocol, persistence, or model capability changed. Outer personal-overlay, text lock, button keyboard semantics, and check graphic are unchanged; no interactive nested control was added.
- Mac Electron and real mobile shared-host were not rerun. This fixes shared UI colors only and does not change desktop continuous / mobile replayable paths.
