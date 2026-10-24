# Desktop startup critical path optimization

## Background and baseline

A 2026-08-05 sample of production cold-start logs and runtime marks showed:

- From `initializing local services` to `local services ready`, the Local Host median over the last 12 runs was
  `2.081s`, and the latest run `2.208s`.
- On the same machine, running the two existing login shell probes separately took about `0.97s` each: one read
  only `PATH`, one read `env -0`. The latter already includes `PATH`, so two serial probes are duplicated work.
- After Local Host ready, the first second produced about `146` RPCs; when restoring 13 workspaces, the task
  list's list/archive/pin/delete queries enter the data source with all tabs at once.
- In the latest production cold start the estimated time until input became available was about `5.3s`; in the
  built-in T0-T5 marks the first React commit took only `24ms`, and the main waiting was workspace restoration
  after Host initialization and the startup gate.

This document defines two P0 changes that only shorten the startup critical path of the Desktop local window,
without changing the authoritative state of task/session, remote workspace connection semantics, or the mobile
remote-control recovery protocol.

## P0-1: capture the login shell environment once, asynchronously and early

### Before

```text
renderer dom-ready
  -> fork Local Host
     -> createLocalServices()
        -> zsh -ilc <capture PATH>   ~0.97s, blocks the Host event loop
        -> zsh -ilc 'env -0'         ~0.97s, blocks the Host event loop
        -> construct services
        -> publish RPC port
```

### Target ordering

```text
Desktop Main module init
  +-> async shell -ilc 'marked env -0'  --------+
  |                                              |
  +-> app.ready -> create window -> renderer DOM |
                                                 v
renderer dom-ready -> await warmed snapshot -> fork Local Host
                                               -> InitLocal(envPatch)
                                               -> createLocalServices(envPatch)
                                               -> publish RPC port directly
```

Constraints:

1. The shell runs only once; the same null-separated snapshot provides both `PATH` and the environment fields
   allowed to be inherited.
2. Main uses async `execFile`, so capture overlaps with Electron/app/window initialization; no synchronous
   shell IO on the critical path of Main or the Local Host.
3. Main only captures and passes the filtered runtime patch; it does not write the shell environment into its
   own process.
4. `InitLocal` can carry `runtimeProcessEnvPatch`; a Remote Host does not reuse the local patch, so local
   `PATH`, `SSH_AUTH_SOCK` or workspace authority is not carried into SSH/WSL/Docker.
5. Windows does not currently run a POSIX shell probe and keeps the original bootstrap/Node path rules. macOS
   and Linux use the same async implementation.
6. The old synchronous creation entry for non-Desktop Local Hosts temporarily keeps a single-snapshot fallback,
   keeping the remote server and test callers compatible; it no longer runs the duplicated PATH + env two
   probes.
7. A snapshot failure or timeout fails open: use the current process environment, the POSIX bootstrap path and
   bundled tools, do not block window startup, and do not log environment values or keys.

### Safety boundary after 2026-08-09 production feedback

The performance optimization stays, but environment warm-up may only be a bounded startup accelerator and not a
single point startup gate of the Local Host. Production logs confirmed two independent faults: a macOS
white-screen sample had only `dom-ready` and no Host fork afterwards; on a Windows sample the Host started
normally, but expanding the case-insensitive `Path` into a plain object made downstream read `PATH`, so only the
bundled tool directory was written into the new `PATH`, overwriting the user's original command directories.

The correct ordering must satisfy:

```text
Main module import
  -> per-window async login-shell capture
       | success before deadline -> complete filtered patch
       | failure / hard deadline -> shell-free fallback patch
       v
renderer dom-ready
  -> bounded wait (the Promise must not be awaited forever)
  -> fork Local Host exactly once
  -> InitLocal always carries a complete patch
  -> Host is forbidden to run a synchronous login shell again because of the fallback
```

Environment invariants:

1. Windows environment variable names are case-insensitive by OS semantics. Once `process.env`, dotenv and the
   warm-up patch are copied into a plain object, all `Path` case variants must first be merged into a unique
   `PATH`; the real process environment wins over dotenv.
2. The fallback patch must be computed directly from the current process environment, the platform bootstrap
   path and bundled tools; it must not trigger the Host's old synchronous shell fallback with `undefined`.
3. The login shell capture itself must have a hard deadline; on POSIX, after the timeout the capture's process
   group must be terminated and the Promise settled at once, so descendants started by the profile that inherit
   stdio cannot leave `execFile` waiting for close forever.
4. The window lifecycle also needs its own deadline. Even if an injected test or a future executor never
   settles, the Local Host must be created with the fallback; a late warm-up result must not create a second
   Host.
5. The first window reuses the warm-up started at Main import; later new windows each capture asynchronously
   again, so one process lifetime never reuses a stale shell environment forever. A Renderer reload with an
   existing Host re-mounts the port directly without waiting or creating a Host.
6. Logs record only duration, success/degradation reason and lifecycle, never PATH contents, environment values
   or keys.

## P0-2: restore the active workspace first, fill in inactive ones after the first frame

### Before

```text
settings.get
  -> ensure conversation workspace
  -> restoreTabs([workspace 1 ... workspace N], activeIndex)
  -> all tabs enter task/sidebar/session hooks at once
  -> N workspaces' index subscriptions and membership RPC fan-out
  -> startup gate cleared
```

### Target ordering

```text
settings.get
  -> parse the complete, de-duplicated persisted session
  -> restoreTabs([active workspace], 0)
  -> startup gate cleared -> active input box available (T6)
  -> browser idle callback after the first frame
     -> completeTabRestore(full persisted session)
     -> keep active tab id / current focus / tabs the user opened
     -> inactive workspaces enter the task list data source in the background
     -> allow later tab session persistence
```

State constraints:

- Active-first is enabled only on the Desktop main window's local `desktop-continuous` restore chain. Web,
  mobile `web-remote-replayable` and secondary windows that do not restore sessions keep the current behavior.
- The Renderer restores the previously active project by `lastActiveTabIndex`, including a disconnected remote.
  `resolveStartupLocalWorkspaceSessionIndex` decides only Main's local warm-up target and may differ from the
  Renderer's active project; remote auto-reconnect disabled semantics are unchanged.
- The inactive fill-in must be a merge: it must not rebuild an already restored active tab, steal focus, or
  override a settings/workspace tab the user opened before the fill-in.
- Active-only is a transient projection, not a new persisted fact. Before the inactive fill-in completes or
  fails, tab persistence must not write the active-only state back to `lastWorkspaceSession`.
- Use an async timer fallback when `requestIdleCallback` is unavailable; both must be cancellable, and after
  Root unmount the old window's store must not be modified.
- On fill-in failure, record a UI logger error and release the persistence gate; startup input stays usable.

Active-first is a two-stage restore state internal to the Renderer, not a full workspace snapshot that may be
published externally:

```text
pending
  -> active-ready
       | Renderer: allow the active workspace's first screen and input
       | Main/TaskRealtimeBus: still wait, do not publish workspaceKeys=[active]
       | Web remote: still wait, do not publish a single-workspace snapshot
       | persistence: still closed
  -> complete
       | merge inactive workspaces
       | publish the complete workspace scope
       | open the persistence gate
```

Additional constraints:

1. `syncWindowTabs`, `syncWebRemoteControlWorkspaces`, the Web remote task index and telemetry scope that
   depends on the complete workspace set may consume tabs only after `complete`. Desktop is still
   `desktop-continuous` and mobile still `web-remote-replayable`; no new replay/snapshot state is introduced
   here.
2. If the user closes the startup active tab between `active-ready` and `complete`, the fill-in must treat that
   closing as this window's user intent and must not re-add it from the old persisted snapshot. Workspace/settings
   tabs opened in the meantime and the current focus must still be kept.
3. The complete restore keeps using `workspaceKey = workspaceIdentity?.trim() || workspacePath` for identity
   equality; file execution and display keep using `workspacePath`.

## Acceptance and tests

Automation must cover:

1. One async shell call yields both the login `PATH` and the inheritable fields; on failure the fallback is
   used.
2. `InitLocal` passes the precomputed patch to the Local Host, and `createLocalServices` uses the injected value
   and no longer triggers a shell.
3. A window does not spawn a new Local Host while the patch is not ready; a renderer reload reusing an existing
   Host neither waits nor rebuilds.
4. In the first phase of active-first there is only one workspace, the deferred phase fills in the original
   order, and the active tab id/focus is kept.
5. The active-only snapshot is not persisted before the deferred phase completes; scheduling is cancellable.
6. Remote restore, Web/mobile replayable and workspace identity behavior keep passing existing tests.
7. A Windows `Path` input produces a unique `PATH` that keeps the user directories; the Host process environment
   has no case-duplicate keys either.
8. A warm-up Promise that never settles, rejects, or resolves late creates exactly one Local Host and, after the
   deadline, uses the complete fallback patch.
9. The active-only phase publishes no single-workspace snapshot to Main/mobile remote; after the user closes the
   active tab the fill-in does not revive it.

Mechanical verification: `pnpm typecheck`, `pnpm lint`, the related Vitest; performance verification uses the
same isolated production workspace/session data, with at least 3 cold starts before and after the change each,
reporting the median and the change of the two stages Local Host ready and T6, and does not use a single best
value as the conclusion.

## 2026-08-05 measured result

The baseline used a detached worktree at the same commit before the change; before and after builds were
production bundles, with the same isolated storage fixture containing 15 persisted workspaces copied in. Each
round used a fresh Electron process, user data and database clone, alternating baseline/optimized 5 times each;
the OS file cache was not cleared, so "cold start" here means cold process start and does not assume an
uncontrollable whole-machine cold cache.

| Metric                          | Median before | Median after |                  Change |
| ------------------------------- | ------------: | -----------: | ----------------------: |
| T0 to input available (T6)      |       5,441ms |      3,249ms | -2,193ms (40.3% faster) |
| Local Host initialization       |       2,707ms |         17ms | -2,690ms (99.4% faster) |
| startup gate after React commit |       3,278ms |        579ms | -2,699ms (82.3% faster) |

The new single async login shell snapshot itself still has a median of about `1,626ms`, but it starts at Main
module initialization and overlaps with Electron ready, window and renderer loading; in all 5 rounds it
finished before the Local Host was created, so it no longer enters the Host critical path. The Host-stage
reduction does not translate one-to-one into the T6 reduction because Agent/provider readiness and renderer
loading were partly parallel already; the final user-perceivable conclusion is the `2,193ms` median improvement
of T6.

## Follow-up extreme route: a resumable App Shell, not SSR

Traditional SSR is not the plan for the next stage. The Desktop renderer is already a local static resource and
the sampled first React commit is about `24ms`; moving JSX pre-rendering to Main/Node still needs hydration and
cannot remove the Host, auth, provider and workspace RPC waits, and adds two rendering environments and stale UI
risk.

The real next-stage goal is to separate "can type" from "all data is verified":

1. Continuously write a versioned, minimal startup projection atomically; do not rely only on a normal-exit
   callback, because crashes, forced updates and system shutdown can skip exit cleanup.
2. The projection holds only the active workspace identity/purpose, tab order, a limited number of task-row
   display fields, unsent drafts and UI preferences; it stores no token, credential, full conversation, running
   authoritative state or remote connection capability.
3. When Main creates the window it injects the projection once with the bootstrap. Before any service RPC the
   Renderer synchronously initializes the tab/sidebar/draft stores and first mounts the editable input box; Send
   goes into a local pending state before Host ready, and after ready follows the original authoritative command
   chain.
4. Host, settings and the sessions/tasks index recover in parallel in the background, and the projection is
   validated with schema version, storage profile, workspace identity and update time; a mismatch is replaced
   locally, not by resetting the whole page.
5. Long-list restoration keeps being sharded and put in `requestIdleCallback`; input, workspace switching and
   sending are critical user actions and must not go into the idle callback.
6. Optionally save a window screenshot as a startup cover, which only improves the time to "see the interface",
   is not counted as T6, and must not cover a real App Shell that is already editable.

This route is expected to make "see the interface" and "start typing" earlier than Host ready; the full
task/session authoritative projection still completes through background recovery. The concrete budget must be
re-set from the post-P0 baseline, and no fixed millisecond number is promised at design time.
