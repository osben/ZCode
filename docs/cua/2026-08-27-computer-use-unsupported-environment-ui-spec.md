# Computer Use: settings and plugin-list notice for unsupported environments

## Background

Computer Use depends on the local desktop Helper to reach the current machine's screen and input
devices. SSH, WSL, Docker, remote Server and Linux desktop targets have no CUA Helper. The settings
page must not hide the whole section with `return null` (that left a blank remote settings page). The
plugin page reads only the target environment's runtime plugin directory, so a remote directory
without CUA shows no capability entry.

## Goals

- In a remote workspace or on a Linux desktop, settings shows the Computer Use entry with an explicit
  "environment not supported" explanation, never a blank page.
- In the same environments, the plugin list shows a read-only CUA placeholder row with the reason.
- No CUA enable, disable, install, uninstall or update request is sent to SSH, WSL, Docker, Server or
  Linux targets.
- Local macOS/Windows toggles, the macOS permission flow and mobile Web remote behavior are unchanged.

## Capability boundary

```text
Target environment                 Computer Use
Local macOS                        supported: toggle + macOS permissions
Local Windows                      supported: toggle
Local Linux                        unsupported: notice, no action controls
Remote SSH / WSL / Docker / Server unsupported: notice, no action controls
Mobile Web remote                  follows the Web capability gray release; no local CUA Helper is started
```

## UI behavior

1. The gray-release switch still decides whether the Computer Use navigation item is shown. When it is
   on, Linux desktop also shows the entry.
2. In an unsupported environment the settings page shows one info card stating that Computer Use does
   not yet support the current environment (SSH, Linux, etc.). The plugin master toggle, the composer
   entry toggle and the permission actions are hidden.
3. The plugin list adds a read-only "电脑控制" (Computer Control) row in the user scope with a
   "当前环境不可用" (unavailable in this environment) badge and the reason. The row is not counted in
   installed/built-in totals, opens no details, and has no enable/disable, update or uninstall
   actions.
4. Plugin search matches that row by "电脑控制", "Computer Use", "zcode-cua" and "cua".

## Data and implementation constraints

- One shared UI capability function distinguishes local macOS, Windows, Linux and remote targets.
  Remote identity is still decided through `workspaceIdentity` / `remoteTarget`.
- The CUA placeholder is a UI projection. It does not fabricate remote plugin runtime data and does
  not change the plugin protocol or remote Host capabilities.
- Only settings and plugin-list presentation change. The desktop `continuous` and mobile `replayable`
  live links are untouched.

## Acceptance

- Settings for remote SSH, WSL, Docker, Server and local Linux does not render blank and shows the
  unsupported explanation.
- In those environments the plugin list can be searched for the "电脑控制" read-only row; clicking or
  toggling triggers no plugin-management write.
- Existing macOS/Windows local unit tests still pass; tests cover the capability matrix, the Linux
  entry and the unsupported notice.
