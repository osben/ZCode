# Todo143: Match model-setting checkboxes to system colors

Status: implemented, locally verified and reviewed (user authorized implementation and MR creation on 2026-09-12).

## Rule

- Checkboxes for input types and model capabilities use the system Checkbox colors: selected `border-primary bg-primary text-primary-foreground`; unselected `border-input-border bg-input`.
- Selected Zai dark theme: white box / black check; light theme: black box / white check. The border must not invert with the check mark (root cause: the original `border-current` followed `text-primary-foreground`).
- Keep the 16px square, the 12px Check icon, and the outer option button's background feedback, personal-overlay border, dimensions, click and keyboard semantics. Text remains required and cannot be unchecked.
- The indicator stays a non-interactive decorative element: no interactive Checkbox nested in the button, no global component or model config/save behavior change.

## Verification and review

- Computed-style comparison against the system Checkbox in a real-component browser fixture (Chinese/light/mobile width, English/dark/desktop width, selected/unselected, ordinary/personal-overlay); click, single keyboard toggle, outer highlight and text-lock assertions kept.
- TDD: both new color assertions failed on the old implementation; after the fix two color/interaction tests and four Todo141 editor tests pass together (**6/6**); related unit tests **51/51**. `pnpm typecheck` (incl. desktop E2E types) and `pnpm lint` (0 errors / 42 existing warnings) pass; architecture check 0 violations; `git diff --check` passed.
- Screenshots `/tmp/zcode-provider-settings-batch/selected-{390,1200}-0.png`: light/dark box and check colors match the system control. The Linux CJK font was incomplete (some Chinese glyphs missing), so Chinese typography is not claimed verified.
- The production change is one class branch on the shared indicator covering both call categories; no state, event, I/O, protocol, persistence or capability change.
- Mac Electron and real mobile shared-host suites were not rerun for this color-only change; the browser fixture is not native end-to-end verification; desktop continuous / mobile replayable paths unaffected.
