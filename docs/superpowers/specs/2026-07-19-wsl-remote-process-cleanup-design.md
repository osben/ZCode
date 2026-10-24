# WSL Remote Process Deterministic Cleanup Design

> **Historical boundary note**: this document was written when WSL still used a per-session dedicated Host. WSL is now pooled per `window + normalized(distro,user)`; workspace release, the 60-second idle TTL, and app shutdown follow `docs/superpowers/specs/2026-07-20-window-scoped-wsl-host-pooling-design.md`. The bounded exit, idempotent cleanup, and orphan-process protection here remain valid, but WSL's Host cardinality must no longer be read as per-session.

## Background

WSL remote workspaces reuse the unified `IRemoteBackend` / `connectRemote` / Desktop Host chain. The main WSL connection is a `wsl.exe -- bash -lc "...zcode-server..."` stdio child started by the Desktop Host; normal release relies on the client closing stdin so the in-WSL `zcode-server` sees EOF and releases its ZCode Agents. Per-session, per-window, and Host-internal resource release existed, but app-level exit waited only on Local Hosts in `windowHostProcessMap`. Dedicated WSL/Docker/Server Hosts, window-scoped shared SSH Hosts, and Bot remote runtimes held by the remote session manager received a Dispose on window `closed` but were not awaited by app quit / update install. A remote stdio shutdown stuck in RPC stop exited at its total deadline, possibly skipping Agent dispose, and the `disconnect` path had no bounded final-exit guarantee. This left a gap between "release initiated" and "all ZCode-owned remote processes exited": with early main exit, stuck Host cleanup, or a legacy crash, detached `zcode-cli` inside WSL could be re-parented to PID 1 and persist.

## Goals

- Deterministically reclaim the owner's Remote Host, WSL `zcode-server`, and ZCode Agents on real window close, app quit, or update install.
- App quit / update install waits bounded for Local Hosts and all Remote Hosts; on timeout, log explicitly and fall back to process-level kills.
- An RPC-stop timeout must never prevent Agent cleanup from being attempted.
- Main and Host `disconnect` / signal / Dispose entries converge into one idempotent release state machine.
- Newly started WSL ZCode processes carry owner identity so later startups can safely identify "owner dead" orphans; no global process-name scanning or killing.
- No changes to `desktop-continuous`, `web-remote-replayable`, owner/lease, CommandInbox, or workspace identity semantics.

## Non-goals

- Never call `wsl --terminate` or `wsl --shutdown`; the WSL distro is a shared user environment, not owned by one ZCode session.
- No Host/Agent destruction on mobile disconnect, Web bridge rebuild, renderer reload, minimize, or hide-to-tray.
- No cleanup of arbitrary `node`/`zcode-cli`/user-shell processes whose ZCode ownership cannot be proven.
- No changes to the SSH window-scoped sharing policy; WSL/Docker do not become shared Hosts.
- No task/session/queue/snapshot state sinking into desktop main, relay, or the cleanup registry.

## Reclaim points

| Event | Reclaim? | Scope | Reason |
| --- | --- | --- | --- |
| Close a real BrowserWindow | yes | that window's Local Host, dedicated sessions, shared SSH Hosts, Bot runtimes | window owner ended |
| Windows close button hides to tray | no | — | window and running tasks stay alive |
| Minimize | no | — | visibility only |
| renderer reload / crash recovery | no | old attachments only | Host/CLI lifecycle belongs to the window, not the renderer |
| mobile `/remote` disconnect or bridge dispose | no | mobile attachment only | shared-host attachment owns no runtime |
| `before-quit` / Cmd+Q / tray quit | yes, with wait | all in-app Local/Remote Hosts | app owner ended |
| before auto-update install | yes, with wait | all in-app Local/Remote Hosts | release processes, files, and runtime locks before update handoff |
| Host remote connection abnormal close | yes | that Host's services, attachments, Agents, backend | Host failure domain ended |
| Main/Host IPC disconnect | yes, bounded | all resources of that Host | parent owner gone |

## Lifecycle state machines

### App level

```text
RUNNING
  |
  | app-before-quit / update-install
  v
PREPARING_SHUTDOWN
  |-- mark force quit，禁止托盘隐藏逻辑重新接管
  |-- 停止 cron / telemetry / new remote session admission
  |-- snapshot Local Host + Remote Host owners
  |-- cancel pending remote connects
  |-- parallel disposeAndWait(all unique hosts)
  v
HOSTS_SETTLED
  |-- all exited: normal
  |-- deadline: record exact remaining host labels/PIDs and force fallback
  v
EXIT_OR_UPDATE_HANDOFF
```

### Remote Host internal

```text
ACTIVE
  |
  | Parent Dispose / SIGTERM / SIGINT / disconnect / remote close
  v
DISPOSING (single-flight)
  |-- stop accepting new attachments/RPC
  |-- close owned attachment scopes
  |-- dispose local services and Agent processes
  |-- close remoteConnection stdin
  |-- wait remote server stream close
  v
EXITED

deadline exceeded
  -> log current phase
  -> run remaining best-effort cleanup
  -> process.exit(non-zero for unexpected/timeout)
```

### WSL remote server

```text
stdin EOF / error / termination signal
  |
  v
stopRpc (bounded independently)
  |
  +-- success --------------------+
  +-- timeout/error -> log -------+
                                  v
                         dispose services/Agent
                         (always attempted, bounded)
                                  |
                                  v
                              process.exit
```

RPC stop and service dispose use independent phase deadlines. A single serial total deadline that skips Agent dispose entirely when `stopRpc` pends is forbidden.

## Component design

### 1. Remote session manager is the Remote Host lifecycle fact source

`createRemoteWorkspaceSessionManager` gains an app-level async entry:

```ts
disposeAllAndWaitForAppShutdown(reason: string): Promise<RemoteHostDisposeSummary>
```

On call it synchronously: blocks new remote sessions / Bot runtimes; cancels all pending SSH connects and rejects their promises; snapshots all unique Host processes from `remoteWorkspaceSessionsById`, `sshHostsByPoolKey`, `windowBotRemoteRuntimeProcessMap`; clears or marks the registries so later window `closed` and Host `exit` callbacks are idempotent; then calls the injected `disposeHostProcessAndWait` in parallel, returning exited/timed-out per Host.

The Process Monitor's full Host map stays for display and diagnostics only — it knows nothing about pending connects, logical sessions, SSH pool ownership, or Bot runtime relations, and never replaces the session manager.

### 2. App quit and update install share one shutdown barrier

One app-level Host barrier covers both `prepareAppQuit` and `prepareWindowsProcessesForUpdateInstall`, waiting in parallel for Local Hosts from `windowHostProcessMap` and the remote session manager's dedicated/shared/Bot Hosts. Host processes are deduplicated by object. Re-entering returns the same in-flight Promise; a `before-quit` after update pre-clean must not create another timer or overwrite the first result. Window `closed` keeps its existing per-window dispose as the normal window-lifecycle entry; the app barrier is the app-level wait and abnormal compensation, not a replacement.

### 3. Host shutdown uses bounded single-flight

`disposeHostResources(reason)` stays the single async release function, with phase/deadline recording:

- Synchronously seal attachments and new RPC entries first.
- Service dispose and remote connection dispose are both attempted; an earlier phase's failure never skips a later one.
- `disconnect`, like SIGTERM/SIGINT, waits for bounded cleanup then exits explicitly.
- The `exit` handler does synchronous best-effort only, never normal async cleanup.

Normal parent Dispose exits 0; remote unexpected close, disconnect cleanup timeout, or cleanup failure exits non-zero, with reason/phase/elapsedMs logged.

### 4. RemoteConnection provides an awaitable close contract

`RemoteConnection` gains idempotent `disposeAndWait()`:

1. Synchronously stop client/protocol/socket and close the main stream stdin.
2. Wait for the main `StdioStream.onClose`.
3. After the remote-server grace period, call backend fallback dispose.
4. Return exited/timed-out for Host logging and upstream decisions.

The legacy synchronous `dispose()` stays compatible and triggers the same single-flight, but the Host's normal release path must await `disposeAndWait()`. A failure during connection establishment must also dispose the backend — ownership of cleanup starts before a successful `RemoteConnection` return.

### 5. WSLBackend tracks only its own children

The WSL backend keeps Windows child handles it started via `spawn` / `execFile` and that have not exited:

- Removed from the registry immediately on child `exit/close/error`.
- Backend fallback dispose closes only these handles — never enumerates system processes, never terminates the distro.
- The main server stream exits normally via stdin EOF; child kill is only the grace-period fallback.
- Short-lived upload/detect/deploy commands are also abortable on connection cancel or backend dispose, so no handles leak from a failed connection phase.

Docker backend keeps the same interface semantics; the SSH backend keeps closing the ssh2 connection; server remote uses its WebSocket close contract and never enters the WSL child registry.

### 6. Owner identity and safe orphan reaping

Each remote server start generates a non-reusable `ownerId` recorded with: owner kind `desktop-attached-remote`, remote kind/distro, Desktop Host owner token, server PID + Linux process start time, and Agent PIDs + start times started by that server. The registry lives in the WSL user's own `~/.zcode/server/owners/` with atomic writes — never in desktop main, relay, or the task repository. Normal exit deletes the registry.

The next same-user WSL remote server start reaps a record only when all hold:

1. Registry schema, owner kind, and distro match.
2. The recorded server PID is dead, or its PID start time differs from the record.
3. The Agent's current PID start time matches and its environment still carries the same `ownerId`.
4. The target executable/command belongs to a ZCode deployment path.

Any failed check logs a warn and skips. Legacy orphans without an owner registry are never auto-cleaned by name; after first release, diagnostics may prompt manual handling — never kill unprovable processes.

## Time budgets

Constants, injected in tests — no scattered magic numbers:

| Phase | Default | Note |
| --- | ---: | --- |
| Agent stdin graceful exit | 300 ms | current release fast path |
| Agent process-tree TERM/KILL fallback | 2,250 ms | current 2 s + 250 ms fallback |
| remote server RPC stop | 1,000 ms | service dispose continues after timeout |
| remote server service/Agent dispose | 3,500 ms | covers Agent process-tree fallback |
| Host remote stream close | 5,000 ms | covers both server phases plus scheduling slack |
| Main per-host force fallback | 6,000 ms | must be later than Host/remote normal budgets |
| App/update aggregate barrier | 8,000 ms | hosts wait in parallel, not summed |

E2E may use existing coverage-specific extended configs. All timeout logs must carry phase, host label, PID, remote kind, elapsedMs; high-frequency protocol frames never upgrade to info.

## Web remote-control and multi-client boundaries

- Before app/window teardown, close that Host's mobile attachments so their connection scopes send `closed` and release owned subscriptions.
- Never copy replayable snapshot, queue, or task state into main to assist shutdown.
- Desktop WSL attachments are always `desktop-continuous`; mobile attachments always `web-remote-replayable`.
- Mobile bridge dispose releases only the attachment, never triggering Host shutdown.
- A shared SSH Host is reclaimed wholesale at app/window teardown; closing one logical session still only detaches.
- `workspaceIdentity`, `remoteSessionId`, and owner/lease routing are unchanged by the process-reclaim interface.

## Error handling and logging

- Main: barrier start, host count, each timed-out host, barrier completion at `info`/`warn`.
- Host: Dispose/disconnect/remote-close lifecycle via service logger — normal phases `info`, timeouts `warn`, cleanup failures `error`.
- WSL backend: low-frequency lifecycle logs for spawn/exit/forced fallback; never log secrets from the command environment.
- Owner reaper: successful reap `info`, validation failure/skip `warn`; never log the full environ.
- All dispose APIs are idempotent: a second call reuses the in-flight/result and never re-sends signals.

## Test design

### Desktop Main unit tests

- App shutdown awaits Local, WSL dedicated, Docker/Server dedicated, SSH shared, and Bot runtimes together; hosts wait in parallel, deduplicated by process object.
- After per-window `closed` dispose, the app barrier call stays idempotent; `before-quit` after update pre-clean reuses the same shutdown result.
- Tray hide, minimize, and renderer reload never invoke app-level remote dispose.
- Pending SSH connects are rejected at shutdown and their Hosts reclaimed.

### Host / Server unit tests

- Parent Dispose, SIGTERM, SIGINT, disconnect, and remote close enter the same single-flight.
- With RPC stop pended forever, service/Agent dispose still runs after the deadline; with service dispose failed, the remote connection still closes.
- Remote connection normal close, timeout fallback, and repeat dispose; post-timeout process exit uses the expected exit code with phase logged.

### WSL backend unit tests

- `exec`/`execFile` children are registered and removed on exit; stdin-EOF normal exit does not force-kill; grace timeout kills only that backend's children; backend dispose never calls `wsl --terminate`/`--shutdown`.
- Connection-establishment failure, upload cancel, and deploy failure leave no child handles.

### Owner registry/reaper unit tests

- Reap when server dead and Agent PID/start-time/env/ownerId all match; skip on PID reuse, ownerId mismatch, path mismatch, or corrupt registry; normal exit deletes the registry; legacy no-registry processes are never scanned or reaped.

### Real WSL verification

1. Open a WSL workspace, start a real Agent session.
2. Minimize, hide to tray, renderer reload — original Host/server/Agent PIDs unchanged.
3. Close the real window — that window's WSL Host/server/Agent exit within deadline; the distro stays Running.
4. Reconnect and quit the whole app — all ZCode-owned WSL processes exit.
5. Reconnect and trigger update install preparation — processes exit before handoff.
6. Inject Host disconnect, RPC-stop pending, and service-dispose pending — bounded convergence, no new orphans.
7. Create an orphan with a legal owner registry — the next connection reaps only that owner; ordinary WSL user processes untouched.
8. Mobile attaches the WSL workspace then disconnects — only the attachment releases, the desktop Host/Agent continues; closing the app then exits everything.

Repository checks: `pnpm typecheck`, `pnpm lint`.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Slower update/app quit | hosts wait in parallel; normal exit is event-driven, only abnormal paths hit deadlines |
| Inverted timeout layers killing top-down | unified budget constants with tested strict ordering: Agent < server < Host < app |
| Repeated window/app/update dispose | single-flight + process-object dedup + registry removal before await |
| Killing user WSL processes | no distro terminate; ownerId + PID start time + env + executable multi-check |
| Mobile disconnect killing the Host | mobile attachment and Host ownership layered, bridge dispose tested |
| SSH/Docker regressions | unified interface stays compatible with legacy `dispose()`, per-backend behavior covered |
| Main holding business state | the manager holds only Host/session lifecycle, never task/queue/snapshot |

## Acceptance criteria

- Window close, app quit, and update install — all three owner teardown paths — prove their ZCode Host/server/Agent exit within deadline.
- Tray hide, minimize, renderer reload, and mobile disconnect never terminate a runtime still owned by a valid owner.
- A pending/throwing shutdown phase never prevents later cleanup phases from being attempted.
- The WSL distro stays usable; non-ZCode user processes are unaffected.
- No new PPID-1 ZCode Agents; historical orphans with a legal owner registry are safely reaped on the next connection.
- typecheck, lint, and related unit/integration tests pass.
