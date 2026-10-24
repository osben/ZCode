# Pinned Task Local Workspace Scope

## Background

The pinned task list used to follow the current window's `workspaceTabs` queries entirely. That works when workspace tabs are restored before the sidebar renders, but if restoration directly into a task view (pinned/timeline) is supported later, UI tabs may not exist yet and the pinned query would lack workspace scope. Remote workspaces without a `remoteSessionId` must not be mixed into the pinned query scope either, or service resolution may fall to local services and cross-read same-path remote and local tasks.

## Current Strategy

1. `workspaceTabs` remains the UI state of currently opened workspaces in the window.
2. Pinned queries get their scope from `useLocalWorkspaceScopes` and cover only currently opened local workspace tabs.
3. With no local workspace tab there is no fallback to `lastWorkspaceSession`; the query scope is empty.
4. Remote workspaces do not participate in this scope; remote pinned queries wait for the remote session and follow the corresponding remote service chain.

## Boundaries

Only the local scope source of pinned queries changes, not whether workspace tabs are restored at startup. If a remote pinned-view restore is added, the remote query scope must be connected separately after the remote session is ready and must not fall back through local scope.
