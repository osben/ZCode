# Desktop unread badge (retired, merged into the new spec)

This is a v0 draft. The data flow it describes (`countAllUnreadTasks`, `useRootPlatformEffects`,
`unreadTaskCount.ts`) was removed from the implementation. Current facts are in
[windows-taskbar-unread-badge.md](windows-taskbar-unread-badge.md):

- The unread authority is still tasks-index `unreadAt`; automation terminal states are persisted by the host
  `setTaskUnread`, and a user click clears it through `useWorkspaceTaskNavigation`. These constraints still apply.
- Count sync chain: `ProjectDirectoryProvider` counts unread in the authoritative tree -> `syncWindowUnreadCount`
  -> main forks by platform (win32 overlay / darwin and linux `setBadgeCount`).
- Badge semantics are "unread added during this app run" (per-host baseline boundary), no longer this doc's
  "all background-completed unread".
