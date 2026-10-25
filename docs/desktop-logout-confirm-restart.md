# Desktop Logout Confirmation And Restart

## Background

Desktop logout changes the global authentication context. Existing ZCode Agent sessions, running tasks, and background toolchains depend on the current provider token and the derived Start/Coding Plan key. To keep stale sessions from holding dead context after logout, desktop logout must — after user confirmation — interrupt current runs and restart the app.

## Design

- The UI keeps the unified `ConfirmDialogHost`; no new dialog component.
- Root's `handleLogout` queries the desktop main process's running-session count before `oauthService.logout()`.
- With running agent sessions detected, the confirmation copy shows the exact count; without, the copy still states that the app will restart.
- "断开连接并重启" is the primary action completing the logout flow, using the unified ConfirmDialog's default primary button; the running-session risk is conveyed only by title and description, never downgraded to a warning/danger button.
- Cancel triggers no telemetry, logout, or restart.
- On confirm, OAuth, provider family domain, and presentation state are cleaned in the existing order, then the app restart is requested via the desktop command.

## Boundaries

- The running-session count comes from main's existing host running-task statistics, used only for the desktop confirmation copy — session/task business state is not sunk into main.
- Web/mobile remote never uses the restart command; the Web fallback returns 0 running sessions and stays a no-op.
- The restart command goes through the existing app quit preparation, so host processes and agent children still clean up along the desktop quit path.
