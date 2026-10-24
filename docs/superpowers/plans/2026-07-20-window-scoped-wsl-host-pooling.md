# Window-scoped WSL Host pooling

> Implemented; the shipped protocol evolved past this plan's working names. Full contract
> and runtime evidence:
> [2026-07-20-window-scoped-wsl-host-pooling-design](../specs/2026-07-20-window-scoped-wsl-host-pooling-design.md)
> and `docs/testing/wsl-host-pooling-runtime-evidence.md`. That design doc is authoritative;
> this stub only maps the plan's targets to the current code.

**Goal:** WSL workspaces sharing one Electron window, distro and Linux user share one Remote
Host and `zcode-server`; unused workspace runtimes are released and the pool is disposed
deterministically after a 60-second idle TTL or immediately during owner teardown.

Mapping to current code:

- Window-scoped hosting landed as the window host process map plus the logical-session
  protocol (`ConnectRemoteWorkspace`, `DisposeRemoteWorkspaceSession`,
  `BindRemoteWorkspaceContext`, `AttachServicePort`/`DetachServicePort` in
  `packages/shared/src/channels.ts`; manager in
  `packages/desktop/src/main/desktopRemoteSessions.ts`). The plan's `InitRemoteWslHost` /
  `ReleaseRemoteWorkspace` names were folded into this protocol; WSL targets key by
  `wsl:<distro|default>\0<user>`. WSL desktop attachments stay `desktop-continuous` with no
  `relay_bridge`; Docker stays dedicated.
- Workspace runtime release (`releaseWorkspacePreparation` →
  `IZCodeAgentService.disposeWorkspace`, `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`)
  and Host-side active-run tracking shipped with the lifecycle review fix
  (`packages/desktop/src/host/hostWorkspaceTaskTracker.ts`,
  `hostRemoteWorkspaceProxyState.ts`, `WorkspaceRunningTaskCountChanged` channel): the
  `sendPrompt` ACK is never the active-run boundary — only session-ready
  (`prompt_completed` / `prompt_failed`, exposed as `onDynamicTaskReady`) finishes a tracked
  run, so closing a workspace cannot interrupt a still-running Agent.
- Discovery/deployment concurrency: 5-second rejected-promise-safe WSL discovery cache
  (`WSL_DISCOVERY_CACHE_TTL_MS`, `packages/server/src/remote/wsl-detect.ts`), owner-unique
  staging and the install-root transaction lock with in-lock version recheck — see
  [remote deploy transaction lock](2026-07-20-remote-deploy-transaction-lock.md).
