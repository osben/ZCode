# React Error Boundary

`packages/ui/src/ErrorBoundary.tsx` provides the shared `AppErrorBoundary`, which the desktop and web renderer
entries uniformly wrap around `ZCodeIntlProvider` and `Root`.

Purpose:

- A React render / lifecycle exception no longer unmounts the whole tree into a white screen.
- The fallback page logs the error through `packages/ui/src/logger.ts`.
- The user can at least run "重试" (Retry) or "刷新应用" (Refresh app).

The strategy is "survive first, recover next": `重试` clears the error boundary state and tries to render the
current tree again; `刷新应用` refreshes the current renderer directly, suited to a corrupted Provider or
initialization state.

Finer-grained isolation can later add secondary Error Boundaries in local areas such as workspace, sidebar and
right panel, but the root boundary must be kept so the app never returns to a white screen.
