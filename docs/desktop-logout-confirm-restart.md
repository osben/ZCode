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
- On desktop, the logout flow enters a "logging out" blocking state before it exposes the sign-in entry, and stays in it until the app restarts: that is, after the OAuth logout and the settings write succeed, and before the sign-in page is opened and the user is cleared. During this time Root renders only the startup screen (`RootStartupLoading`), not the sign-in page, the sign-in button or the workspace. Reason: the OAuth flow is kept only in the current Host's memory, so a sign-in started before the restart is lost when the Host exits, and after the browser authorization finishes the new process can only report `OAuth state does not match or has expired`.
- The blocking state is not entered at confirm time: it unmounts the workspace, and when a step after confirm but before the user is cleared (reading settings, OAuth logout, writing settings) fails, the UI must stay as it was and must not lose UI state that lives only in memory (such as a closed career onboarding).
- If any step inside the blocking state fails (refresh, clearing webview storage, or the restart command itself), it leaves the blocking state at once and shows the sign-in entry (the user is already cleared by then), and the error is thrown upward as usual; no timeout is used to lift the block.
- Web / mobile remote do not enter the blocking state and show the sign-in entry directly after logout.

```text
user confirms logout
  read settings → oauth.logout → write settings        ← on failure: keep the original UI
  └─ [desktop] enter the logging-out blocking state (startup screen, no sign-in entry)
       open sign-in page / setUser(null) → refreshProviderState
       → ClearCodingPlanWebviewStorage → RelaunchApp → new process
       on failure → leave the blocking state → sign-in entry
```

## Boundaries

- The running-session count comes from main's existing host running-task statistics, used only for the desktop confirmation copy — session/task business state is not sunk into main.
- Web/mobile remote never uses the restart command; the Web fallback returns 0 running sessions and stays a no-op.
- The restart command goes through the existing app quit preparation, so host processes and agent children still clean up along the desktop quit path.
