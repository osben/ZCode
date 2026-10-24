# Windows Computer Use Settings Design

> Update 2026-08-17: the macOS settings surface was minimized (see
> `2026-08-17-cua-settings-surface-minimization.md`). The picture-in-picture, background mode, Helper status and
> Input controller rows are gone; macOS and Windows now share the minimal "master switch + macOS permission rows"
> shape.

## Goal

Show a "Computer Use" (电脑控制) section in the Windows desktop settings page, reusing the existing macOS master
switch for the official `zcode-cua` plugin. The Windows section shows only the master switch and no system
authorization content (Windows has no macOS TCC permission model).

## Product boundary

- macOS desktop shows the master switch plus the Accessibility / Screen Recording permission rows (since
  2026-08-17 no picture-in-picture, background mode, Helper status or Input controller).
- Windows desktop shows the same "Computer Use" navigation entry, but the content is only the master switch.
- The Windows master switch shares plugin-management state and enable/disable logic with macOS; toggling
  enables or disables the official `zcode-cua` plugin together with its MCP and Skill.
- Linux, plain Web and mobile remote control do not show the "Computer Use" navigation entry.
- No Windows-specific settings field, copy, protocol or runtime lifecycle is added.
- Remote workspaces, mobile `/remote`, the replayable message stream, owner, queue, snapshot and
  `workspaceIdentity` semantics are unchanged.

## Page and state boundary

Settings navigation is generated from explicit desktop platform props, so a Windows browser does not show a
desktop capability based on user agent alone. `ComputerUseSection` stays the shared implementation and splits
"plugin switch capability" from "macOS advanced settings capability" internally.

```text
SettingsPage(isMacDesktop, isWindowsDesktop)
  |
  +-- macOS Desktop ------> Computer Use nav ------> shared zcode-cua master switch
  |                                                |
  |                                                +--> macOS permission rows (Accessibility / Screen Recording)
  |
  +-- Windows Desktop ----> Computer Use nav ------> shared zcode-cua master switch
  |
  +-- Linux / Web / mobile -> no Computer Use nav

shared master switch
  -> pluginManagementStore.setEnabled(zcode-cua, next)
     -> success: the store confirms the new state, the plugin's MCP and Skill start/stop together
     -> failure: keep the old state and reuse the existing toast error
```

A local Windows workspace may initialize plugin-management state and toggle the master switch, but never starts
macOS TCC permission queries or authorization guidance. Remote workspaces stay rejected by the existing
local-capability boundary.

## Implementation scope

### Settings page config

Settings sections are generated from desktop platform capabilities passed by the caller: macOS or Windows
desktop includes `computerUse`; other clients filter it out. The settings page's first landing and runtime
navigation intents must fall back to a section actually visible on the current platform; an invisible
`computerUse` preference must never render a blank page.

### Computer Use section

`ComputerUseSection` receives a Windows desktop flag:

- macOS local workspace: render master switch + permission rows (existing permission capability check).
- Windows local workspace: initialize official plugin state and render only the master switch card.
- Non-local or unsupported platform: render nothing.

Windows does not hide advanced settings with CSS: rendering and side effects are both gated by the platform
capability boundary, avoiding pointless macOS permission refreshes.

## Interaction and error handling

- The switch stays disabled with no workspace, as on macOS.
- The switch stays disabled while the plugin is toggling, preventing concurrent enable/disable.
- Plugin-management service failure reuses the existing store error and toast; no Windows-specific fallback.
- Windows shows no empty advanced-settings container or placeholder.
- Reuse the existing `SettingsGroupCard`, `SettingsRow` and `Switch`; no new visual style or copy.

## Tests and acceptance

Automated tests cover at least:

1. macOS and Windows desktop configs include `computerUse`; Linux/Web/mobile configs do not.
2. Windows `ComputerUseSection` renders only the master switch and no authorization content; macOS no longer
   renders the retired picture-in-picture/background mode/Helper/controller rows.
3. The Windows master switch calls the existing `setEnabled` flow of the official `zcode-cua` plugin.
4. The macOS permission-row render condition is unchanged.
5. An initial preference or navigation intent pointing at an invisible section falls back to `general`; the
   settings page is never blank.
6. Related unit tests, `pnpm typecheck` and `pnpm lint` pass.

## Non-goals

- Adding authorization UI or any CUA-specific settings row for Windows.
- Changing the Windows CUA runtime, install, signing, broker or tool capabilities.
- Opening CUA settings to Linux or Web.
- Changing `zcode-cua` management behavior in the plugin page.
