# ZCode Computer Use Permission Settings Entry

The macOS product authorization subject for ZCode CUA is the external `ZCode Computer Use.app`. The settings page keeps the user's active permission entry point; the official `request_access` real-time result from local desktop continuous can reuse the same onboarding after the trusted Host confirms it. Chat errors, tool card text and PermissionDialog carry no CUA permission side effects. After the plugin is enabled successfully, only refresh the state; do not automatically open the permissions UI.

## Interactions

- The Computer Use settings page provides two permission entries: Accessibility and Screen Recording.
- After the 2026-08-17 settings surface consolidation the page no longer shows the Helper runtime/identity row and the Input controller row; the section has only the master toggle + two permission rows (see `docs/superpowers/specs/2026-08-17-cua-settings-surface-minimization.md`).
- The old draggable Helper tile IPC chain (Prepare/StartCuaHelperPermissionDrag) was deleted in the 2026-08-16 audit (zero renderer calls); authorization guidance goes uniformly through `openCuaPermissionOnboarding`.
- The Accessibility entry launches the Helper, which itself triggers the macOS Accessibility prompt. Screen Recording has no equivalent prompt API and only opens the corresponding system settings page.
- When the official background-task `request_access` explicitly reports missing permissions, the window-level listener first re-reads the Helper state, then shows the ZCode ConfirmDialog. After user confirmation it re-checks once more and opens the still-missing items in the order Accessibility -> Screen Recording. Cancellation, same-round repeated results, already-restored state, unknown or unavailable never open system settings.

## Boundaries

- The authorization target is fixed to `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`.
- Python, Terminal, `uvx`, a local checkout or legacy `ZCode.app` brokers must not show product onboarding.
- `zcode-cua` provides a minimal permission snapshot through the namespaced `_meta["zcode.cua/request-access-status-v1"]`, without adding an MCP tool or putting broker token, socket token, argv or config args into UI metadata. Consumers accept only authority-verified official `request_access`; plain text parsing must not trigger onboarding.
- Web/non-macOS clients implement no authorization guidance and keep only normal diagnostics or show no action.
- Mobile replayable, cold snapshot/recovery and SSH/WSL/Docker workspaces receive no live permission observation. After authorization completes there is no automatic recovery or replay of the original task.
- The onboarding request sent by the Renderer includes only `operationId`, `initialPermission` and `requiredPermissions`; the early `prepareAllRequired` / `missingPermissions` inputs are no longer part of the IPC contract.
- Main keeps the Helper path, signature identity and `openedPermissions` internally as signature verification and session coordination facts, but across IPC returns only `success/canceled/sessionId/returnedFromSettings/restartHelperAfterReturn/error`. The Renderer receives no Helper file system paths or identity diagnostics.
- After the Helper restart from system settings completes successfully, Settings explicitly requests a real screenshot probe only once; ordinary polling and focus refresh stay read-only.

## Verification

- Unit: desktop main opener; Settings reusing the same onboarding with live request_access; refresh only after plugin enabled; ordinary error/history/mobile/remote have no side effects.
- Product manual test: open Accessibility/Screen Recording from the Computer Use settings page; after authorization returns the settings page state refreshes; a background task's live request_access first shows a confirmation dialog, cancellation does not open settings, and after confirmation only fresh missing items are handled.
