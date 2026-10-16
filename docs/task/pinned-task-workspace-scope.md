# Pinned Task Local Workspace Scope

## Background

The pinned task list previously followed the current window's `workspaceTabs` queries entirely. This chain works fine in the startup path of "restore workspace tabs first, then render the sidebar", but if persistent restoration to a task view is later supported — for example, directly entering the pinned/timeline view — UI tabs may not yet be created, and the pinned query would lack workspace scope.

Additionally, remote workspaces without a `remoteSessionId` must not be mixed into the pinned query scope. Otherwise, subsequent service resolution may fall to local services, causing cross-reading of same-path remote and local tasks.

## Current Strategy

- `workspaceTabs` remains the UI state of currently opened workspaces in the window.
- Pinned queries use `useLocalWorkspaceScopes` to obtain the query scope.
- Pinned queries only against currently opened local workspace tabs in the window.
- When there is no local workspace tab, no fallback to `lastWorkspaceSession` is performed; the query scope is empty.
- Remote workspaces do not participate in this fallback scope; remote pinned queries wait for remote session establishment and follow the corresponding remote service chain.

## Boundaries

This adjustment only changes the local scope source for pinned task queries, not whether real workspace tabs are restored on app startup. If a remote pinned view restore is added in the future, the remote query scope must be connected separately after remote session ready; it cannot fall back through local scope.
