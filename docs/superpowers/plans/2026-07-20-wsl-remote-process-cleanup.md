# WSL Remote Process Cleanup — Outcome and Open Follow-up

Shipped (2026-07-20): real window close, application quit, and update installation
deterministically release all ZCode-owned Remote Hosts and WSL server/Agent processes
without terminating the WSL distro. Design and full contract:
`docs/superpowers/specs/2026-07-19-wsl-remote-process-cleanup-design.md`.

## Shipped scope

- Application shutdown barrier: `disposeAllAndWaitForAppShutdown(reason)` on the remote
  session manager (`packages/desktop/src/main/desktopRemoteSessions.ts`), single-flight,
  deduplicates unique dedicated/shared/Bot Host processes, rejects new creation after
  shutdown starts. `prepareAppQuit` and `prepareWindowsProcessesForUpdateInstall` await it
  in parallel with Local Host cleanup.
- Bounded shutdown phases: server stdio (`packages/server/src/stdio-lifecycle.ts`) and Host
  (`packages/desktop/src/host/hostShutdownPhases.ts`) run each cleanup phase with its own
  deadline; a timeout logs the phase and never skips the next one.
- Awaitable remote teardown: `RemoteConnection.disposeAndWait()` plus optional
  `IRemoteBackend.disposeAndWait()`; WSL backend tracks only children it spawned
  (`packages/server/src/remote/wsl-backend.ts`) and never issues distro-wide commands.

## Standing rules

- Never call `wsl --terminate` or `wsl --shutdown`.
- Do not destroy runtimes for minimize, tray hide, renderer reload, or mobile bridge
  disconnect.
- Desktop local/SSH/WSL/Docker attachments stay `desktop-continuous`; mobile stays
  `web-remote-replayable` and attaches to an existing Host only.
- All lifecycle APIs are idempotent and reuse one in-flight/result Promise.

## Open follow-up: WSL owner registry and orphan reaper (deferred)

The 2026-07-20 execution scope decision excluded the design's owner-registry/reaper task
from the shipped change: it is outside the "real close / quit / update install destroys"
trigger boundary and would expand cleanup into global process scanning. Until it lands,
the fallback only reclaims children created by the current `WSLBackend` instance and never
scans by process name; orphans from crashed desktops persist until manually killed. The
full registry design (owner records under `$HOME/.zcode/server/owners`, strict
ownerId + PID start-time + executable matching, reap only when every check passes) is in
the design spec above.
