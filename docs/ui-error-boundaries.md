# UI Error Boundaries

ZCode's React error boundaries have two layers:

- Root `AppErrorBoundary`: catches startup, Provider and Root-level exceptions so the whole window does not go blank.
- Local `ScopedErrorBoundary`: isolates regions such as sidebar, header, chat, terminal, side pane and settings layer by fault domain inside a workspace.

## Isolation scope

Local boundaries are preferably placed inside stable layout containers so a fallback does not break
structural components such as `ResizablePanelGroup`. For example, the terminal and side pane boundaries
sit in the content layer of their own `ResizablePanel`, not around the whole panel.

## Reset key

For workspace-level isolation, uniformly use:

```ts
const workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

Each region appends its own context key:

- chat: `workspaceKey + activeTaskId`
- side pane: `workspaceKey + activeTabId`
- terminal/sidebar: `workspaceKey`

This way a remote workspace is isolated by identity and a local workspace falls back to the real path.

## Logging

Local boundaries log at `error` level through `packages/ui/src/logger.ts`, and the log includes `scope`
and the React component stack. Async errors from event callbacks, Promises and stream handlers are not
caught by a React Error Boundary and must still be handled explicitly in the corresponding hook or call site.
