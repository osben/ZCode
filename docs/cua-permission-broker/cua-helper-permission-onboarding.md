# ZCode Computer Use Permission Settings Entry

## Objectives

The macOS product authorization subject for ZCode CUA must be the external `ZCode Computer Use.app`. The settings page retains the user's active
permission entry point; the official `request_access` real-time result from the local desktop continuous can be reused through the same onboarding after being confirmed by the trusted Host. Chat errors, tool card text, and PermissionDialog do not carry CUA permission side effects. Only refreshing the state after enabling the plugin successfully, no automatic opening of the permissions UI.

## Interactions

- The Computer Use settings page provides two permission entry points: Accessibility and Screen Recording.
- After the 2026-08-17 settings surface consolidation, the settings page no longer displays the Helper runtime/identity row and the Input controller row;
  the section only has the master toggle + two permission rows (see
  `docs/superpowers/specs/2026-08-17-cua-settings-surface-minimization.md`).
- The old draggable Helper tile IPC chain (Prepare/StartCuaHelperPermissionDrag)
  was deleted in the 2026-08-16 audit — zero calls at the rendering layer; authorization guidance uniformly goes through `openCuaPermissionOnboarding`.
- The Accessibility entry will launch the Helper, letting the Helper itself trigger the macOS Accessibility prompt. Screen
  Recording has no equivalent prompt API and only opens the corresponding system settings page.
- When the official `request_access` for background tasks explicitly reports missing permissions, the window-level listener first read-re-checks the Helper state, then pops the
  ZCode ConfirmDialog. After user confirmation, re-check once more and open the still-missing items in the order Accessibility → Screen Recording; cancellation, same-round repeated results, state already restored, unknown or unavailable all do not open the system settings.

## Boundaries

- The authorization target is fixed to `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`.
- Python, Terminal, `uvx`, local checkout, or legacy `ZCode.app` brokers must not show product
  onboarding.
- `zcode-cua` provides a minimal permission snapshot through namespaced `_meta["zcode.cua/request-access-status-v1"]`,
  without adding an MCP tool, or placing broker token, socket token, argv, or config args into UI metadata.
  Consumers only accept authority-verified official `request_access`; plain text parsing must not trigger onboarding.
- Web/non-macOS clients do not implement authorization guidance, only retaining normal diagnostics or not showing the action.
- Mobile replayable, cold snapshot/recovery, SSH/WSL/Docker workspaces do not receive live permission
  observation. No automatic recovery or replay of the original task after authorization is completed.
- The onboarding request sent by the Renderer includes only `operationId`, `initialPermission`, and
  `requiredPermissions`; the early `prepareAllRequired` / `missingPermissions` inputs are no longer part of the IPC contract.
- Main internally continues to hold the Helper path, signature identity, and `openedPermissions` as signature verification and session
  coordination facts, but cross-IPC only returns `success/canceled/sessionId/returnedFromSettings/
restartHelperAfterReturn/error`. The Renderer does not receive Helper file system paths or identity diagnostics.
- After successfully completing the Helper restart from system settings, the Settings explicitly requests a real screenshot probe only once; ordinary polling and
  focus refresh remain read-only at all times.

## Verification

- Unit: desktop main opener, Settings reusing the same onboarding with live request_access, only refresh after plugin enabled,
  ordinary error/history/mobile/remote have no side effects.
- Product manual test: open Accessibility/Screen Recording from the Computer Use settings page; after authorization is returned, the settings page
  state should refresh; the background task's live request_access first shows a confirmation dialog, cancellation does not open settings, after confirmation only handles fresh missing items.
