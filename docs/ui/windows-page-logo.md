# Windows Page Top-Left Logo

## Scope

- The Windows desktop `SettingsPage` top left gets the app logo. Only a brand mark is added: no click
  behavior, and the existing back, open workspace and settings-section interactions are unchanged.

## Implementation

- The UI uses `packages/ui/src/WindowsTopLeftLogo.tsx`, uniformly reusing the static `ZCodeStartupLogoBadge`.
  `SettingsPage` renders the component only under `isWindowsDesktop` and keeps the top `app-region:drag`.

## Desktop Logo Style Migration

- The Windows/Linux workspace top left and the Windows settings page reuse the compact look of
  `ZCodeStartupLogoBadge`: 20px gradient base, 4px radius, 1px white/20 outline, a 13px-wide inline SVG that
  keeps its height proportionally, with the breathing animation off.
- The workspace keeps its 28px click area, navigation position, sidebar toggle callback and hover icon;
  keyboard focus also shows the sidebar icon. The settings page keeps its positioning and display semantics
  with no new click behavior.
- The Logo's outer footprint is 20px; the workspace keeps a 28px click area, and the settings page's outer
  footprint keeps 17px/19px at the top left, preserving the original center point. The default 96px Logo of the
  startup and onboarding pages and the macOS/Web/mobile entries keep their look.
- The standalone title bar, native window controls, panel buttons, radius and margins are not migrated. State
  is still owned by the existing Sidebar owner; no state, protocol or remote message chain is added.
- Regression: component tests verify static SVG, size and the default hero; SPT-E2E-000 verifies workspace
  Logo size, hover and click toggle; UP-00 verifies the settings page Logo and dual-theme positioning. Results
  are recorded in the matching coverage matrices.
- E2E prerequisites reuse the local account control-plane mock, so simulated credentials do not trigger an
  online 401 that covers the screenshot; the workspace uses the standard launch-prep helper to wait for the
  first screen and skip the career onboarding, rather than changing product login state or hiding dialogs.

Final size verification: 20px base, 13px SVG, 4px radius, 28px workspace click area. 8 component tests,
typecheck, typecheck:e2e, lint and architecture check passed; Windows SPT-E2E-000 run
desktop-e2e-20261009074039183-p26228-1224c47db4432985 and UP-00 run
desktop-e2e-20261009074139434-p10168-0faa703391ebcbc2 both passed. Linux real machine is still to do.
