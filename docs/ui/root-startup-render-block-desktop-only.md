# Root Startup Render Block Desktop Boundary

## Background

`isStartupRenderBlocked` is a desktop startup guard: after React takes over root, it waits for tab restore,
initial workspace injection or auth state to settle before showing the real UI. Mobile Web remote enters the
shared-host attachment chain, and the pairing loading page already covers the workspace bridge establishment;
after entering `Root` it must no longer use the desktop startup-block branch.

## Design

- `RootProps.isDesktop` is the only runtime boundary.
- `Root.tsx` calls `shouldBlockRootRender(...)` and enters the `isStartupRenderBlocked` branch only when
  `isDesktop === true`. Web and mobile Web remote do not use `isStartupRenderBlocked`.
- After mobile Web remote enters `Root`, if the initial workspace tab has not yet been injected by the effect,
  `Root` uses the `initialWorkspaceLoadingFallback` passed by the Web entry to keep showing the same page as
  "已配对，正在加载工作区..." (Paired, loading workspace...) until `workspaceShellPath` appears.
- The desktop and ordinary Web server entries pass no `initialWorkspaceLoadingFallback` and are unaffected by
  the mobile transition page.
- `RootStartupLoading` keeps the desktop startup shell duty and adds no viewport or user-agent checks.

## Verification

- New Root SSR tests cover rendering `data-testid="root-startup-loading"` when desktop blocks startup, Web not
  calling `shouldBlockRootRender(...)`, and mobile Web rendering the passed loading fallback before the initial
  workspace injection.
- Run `pnpm typecheck` and `pnpm lint`.
