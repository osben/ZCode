# Window-Scoped WSL Remote Host Sharing and Resource Lifecycle Design

## Implementation status

Workspace release and concurrency foundation (single-flight, discovery cache, deploy lock), the window-level
Host pool, and runtime verification are complete on `fix/wsl-remote-process-cleanup`, including the automated
verification within this scope and the real Windows + Ubuntu WSL PID verification. Runtime evidence is in
`docs/testing/wsl-host-pooling-runtime-evidence.md`.

The real environment verified that 1, 3 and 5 logical workspaces of the same window, distro and user keep only
one Windows remote Host and one WSL `zcode-server`; after the last owner is released they are reclaimed after
the roughly 60s idle TTL, and on a normal whole-App close the TTL is skipped and the Host/server are reclaimed
within a roughly 4s sampling window. Task draining, mobile attachment and the Docker dedicated boundary are
covered by automated tests; a real task, a real phone and the runtime injection of an update install have not
been run.

## Review correction: Active Run authority boundary

The first implementation treated the pending interval of the `sendPrompt()` Promise as a running workspace
task. That boundary does not hold: `sendPrompt()` returns the command ACK, and model output and tool execution
may continue; dropping the count to 0 after the ACK would let a closed tab run `disposeWorkspace()` and
interrupt a live run. `turn terminal` is also too early (the Agent active lock may be unreleased). This design
uses `session ready` (`prompt_completed` / `prompt_failed`, Agent active lock released) as the completion
boundary of an active run:

```text
sendPrompt(taskId, traceId)
  → subscribe to the task ready event first
  → workspace activeRun(taskId)=true
  → report the workspace count and the derived Host aggregate count
  → send ACK (does not change the count)
  → session ready
     → activeRun(taskId)=false
     → update the workspace/Host count
     → if the workspace is in pending release, run the release
```

- A task/session has at most one active run; a repeated begin is idempotent.
- If the ACK fails and the run has not started, revoke the count and the ready subscription immediately; a
  ready event preceding the ACK continuation must still close correctly and must not be re-marked running.
- The workspace count is authoritative; the Host aggregate is derived from all workspace active runs (no second
  `runningPromptCount`).
- When task meta does not exist, no workspace identity is fabricated; a brief RPC in-flight fallback serves only
  exit diagnostics and takes no part in release decisions.
- If background work must stay alive after session ready, a background handle must join the same tracker as an
  independent owner and must not fall back to Promise-pending counting.

### Shared Host proxy state cleanup

`taskMetaById` and the workspace event subscription belong to the Desktop Host proxy layer and are not cleaned
by the remote `disposeWorkspace()`. `ReleaseRemoteWorkspace` completion must delete all task meta of the
`workspaceKey`, dispose the `onDynamicWorkspaceEvent` subscription Disposable and delete the subscription
record (so a future re-attach can subscribe again), and clean the workspace's closed tracker state; with an
active run, release is still deferred.

### Regression tests

- Closing the workspace after the `sendPrompt` ACK but before session ready must not call
  `releaseWorkspacePreparation()`; after ready the pending release runs exactly once.
- Ready before the ACK continuation leaves count 0 and no residual active run.
- Two parallel workspace runs keep independent counts; the Host aggregate is their sum.
- After release, task meta, workspace subscription and listener are all cleaned and re-attach can subscribe
  again.

## Owners and references

Code owners: `packages/desktop/src/main/desktopRemoteSessions.ts`, `packages/desktop/src/host/index.ts`,
`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`, `packages/server/src/remote/wsl-backend.ts`,
`packages/server/src/remote/connect.ts`, `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`.
Related docs: `docs/wsl-remote-workspace-design.md`, `docs/remote/wsl-remote-realtime-boundary.md`,
`docs/superpowers/specs/2026-07-19-wsl-remote-process-cleanup-design.md`,
`docs/superpowers/specs/2026-07-13-window-scoped-ssh-remote-host-pooling-design.md`,
`docs/architecture/zcode-code-architecture-overview.md`. Pool scope: the product limits to one window, but the
pool identity still includes `windowWebContentsId`.

## Background and verified facts

Currently WSL, Docker and server remote use a dedicated Host; only SSH uses the window-level Host pool. Each
logical session of a WSL distro creates a UtilityProcess Host and a separate `wsl.exe` stdio connection to its
own `zcode-server` (three idle handshaken servers measured about 485 MB RSS in total, excluding the Host,
Agents and MCP processes; a baseline, not a product budget).

```text
Today: three WSL workspaces of the same distro

Desktop Main
├─ Host A ─ wsl.exe ─ zcode-server A ─ Agent(workspaceKey A)
├─ Host B ─ wsl.exe ─ zcode-server B ─ Agent(workspaceKey B)
└─ Host C ─ wsl.exe ─ zcode-server C ─ Agent(workspaceKey C)
```

Facts that bound the design:

- The remote `createLocalServices()` and `ZCodeAgentProcessManager` already manage multiple workspaces by
  `workspaceKey` in one server; the Agent is per workspace (one Agent can host several sessions); MCP children
  start by configuration and use.
- Server deploy has a version match check (skips the large upload on a hit), but a first install/upgrade may
  still be run concurrently by several backends; `WSLBackend.resolveInfoPromise` caches only inside one backend.
- The UI already calls `releaseWorkspacePreparation()` for "no longer needs a prewarmed runtime", but the
  adapter implementation is empty, so there is no workspace-level reclamation loop.
- An ordinary desktop WSL must stay `desktop-continuous` and must not register the mobile replayable
  `relay_bridge` to share a Host. The existing process cleanup design requires real window close, App quit and
  update install to reclaim Hosts uniformly and forbids `wsl --terminate` / `wsl --shutdown`.

## Problem definition

Host owner, logical session and workspace runtime lifecycles are currently bound into one layer:
`remoteSessionId` closes = RPC port closes = the whole UtilityProcess Host closes = the WSL server connection
closes = all workspace runtimes in that server close. Probe caching or throttling alone cannot remove the
duplicate-server resident cost, and copying the SSH pool would leave zero-reference workspace Agents until
window close. The design must therefore solve together: Host/server-level sharing; independent attach/detach of
logical sessions; independent release of workspace Agent/runtime; idle reclamation of a zero-reference Host;
single-flight and races of first connection, probing and deploy; and high-priority deterministic reclamation
on window close / App quit / update install.

## Problem definition

The problem is not simply too many `wsl.exe` launches, but that three lifecycles, Host owner, logical session
and workspace runtime, are currently bound into one layer:

```text
Current coupling

remoteSessionId closes
  = RPC port closes
  = the whole UtilityProcess Host closes
  = the WSL server connection closes
  = all workspace runtimes in that server close
```

The advantage of the dedicated model is simplicity and fault isolation, but multiple workspaces of the same
distro/user cannot reuse the remote service graph that already supports multiple workspaces. Adding only a
probe cache or connection throttling cannot remove the main resident cost of duplicate servers; copying the SSH
pool directly would leave zero-reference workspace Agents until the window closes, producing another kind of
resource retention.

This design must therefore solve together:

1. Host/server-level sharing.
2. Independent attach/detach of logical sessions.
3. Independent release of the workspace Agent/runtime.
4. Idle reclamation of a zero-reference Host.
5. Single-flight and races of first connection, probing and deploy.
6. High-priority deterministic reclamation on window close / App quit / update install.

## Goals

- WSL workspaces of the same window, canonical distro and Linux user share one UtilityProcess Host, one
  `wsl.exe` stdio server connection and one `zcode-server`.
- Each workspace keeps its own `remoteSessionId`, `attachmentId`, `workspaceIdentity`, `workspaceKey` and
  Renderer RPC port.
- Closing a single workspace only detaches the logical session; when the workspace has no desktop/mobile
  reference and no running task, release that workspace's Agent/preparation runtime.
- When the last workspace reference closes but a task is still running, enter draining; release the runtime
  after the task reaches a terminal state.
- After the whole pool has zero references and no draining workspace, enter a 60s idle TTL; reconnecting within
  the TTL reuses the Host and at TTL expiry the Host/server is released.
- Real window close, App quit and update install cancel the TTL, stop new attaches, and immediately enter the
  existing bounded shutdown barrier.
- Concurrent connections, environment probing and deploy of the same pool are not repeated; a first
  install/version upgrade does not compete for a fixed staging file.
- Keep the Desktop continuous, mobile replayable, owner/lease, workspace identity and task command queue
  semantics.
- Leave real Windows + WSL evidence of PID, RSS, connection time and close reclamation for 1, 3 and 5 WSL
  workspaces.

## Non-goals

- No Host sharing across Electron windows or across Desktop App instances.
- `zcode-server` is not changed into a resident daemon listening on TCP/Unix sockets.
- No `wsl --terminate` or `wsl --shutdown`, and no stopping of the whole distro.
- No scanning or cleaning of user processes by process name, and no widening of the existing owner registry
  boundary.
- The Docker backend is not changed into a shared pool; the owner and isolation semantics of Docker containers
  are designed separately.
- No change to the SSH pool cache policy.
- No new UI, setting or user-configurable TTL; the TTL is fixed at 60s in this phase and tested through an
  internal constant.
- Task, stream, queue, snapshot, permission or elicitation state is not pushed down into Desktop Main.
- No change to the App and Agent `@zcode/protocol`, unless implementation proves the existing service RPC
  cannot express workspace runtime release; if a change is unavoidable, the protocol spec and runtime schema
  are updated separately.
- No promise that the WSL distro shows `Stopped` after ZCode exits; the acceptance object is the ZCode-owned
  Host, server and Agent.

## Option comparison

- **A. Window-level WSL shared pool (adopted).** Separates the WSL Host from the logical session in Desktop
  Main, reusing `AttachServicePort` and the remote multi-workspace service graph. It removes the duplicate
  Host/server, adds no remote listening port, and keeps the external semantics of `remoteSessionId`. Costs:
  Main must maintain the pool, attachments, idle timer and connection single-flight; a real workspace runtime
  release is required; a shared failure affects all workspaces of the pool.
- **B. Keep dedicated, add only caching and throttling (not adopted).** A possible pre-stage of A, but it cannot
  remove the resident cost of duplicate `zcode-server` and the local Host service graph.
- **C. App-global WSL daemon/pool (not adopted).** Needs persistent owner, remote authentication, version
  upgrade, cross-window permissions and daemon orphan governance, which the single-window product does not
  justify.

## Process topology and component responsibilities

```text
Desktop Main (lifecycle owner)
└─ Window-scoped WSL Host Pool
   key = windowWebContentsId + canonicalDistro + linuxUser
   │
   ├─ Remote Host UtilityProcess
   │  ├─ local remote-workspace service wrappers
   │  ├─ attachment registry
   │  └─ workspace lifecycle coordinator
   │
   └─ WSLBackend / wsl.exe stdio connection
      └─ one zcode-server
         ├─ workspaceKey A → Agent runtime A
         ├─ workspaceKey B → Agent runtime B
         └─ workspaceKey C → Agent runtime C
```

### Desktop Main

Main manages only processes, logical sessions and attachment lifecycle:

- compute `poolKey` and get-or-create the Host.
- run connections of the same pool through single-flight.
- create an independent attachment for each `remoteSessionId`.
- derive workspace/pool references from logical sessions and mobile attachments.
- manage the single 60s idle timer of each Host.
- on window/App/update teardown, cancel the timer and enter the shutdown barrier.
- on abnormal Host exit, notify all associated logical sessions without storing task business state.

Extract the WSL pool from the already large `desktopRemoteSessions.ts` into
`packages/desktop/src/main/remoteWslHostPool.ts`; that file is responsible only for the pool state machine,
single-flight, idle timer and Host dispose, not for IPC argument parsing or UI notification.

### Remote Host

The Remote Host holds one shared `activeServices`, exposed to logical sessions through multiple
`AttachServicePort`s. It is responsible for:

- attachment registration, duplicate attach protection and detach.
- binding an attachment to the workspace context.
- requesting Agent/preparation release after a workspace reference count reaches zero.
- task running/terminal lifecycle and draining workspace coordination.
- on Host shutdown, stop new attachments and release all services/connections in phases.

### WSL backend / connect layer

- One pool Host creates only one `WSLBackend`.
- `resolvedInfoPromise` keeps guaranteeing single-flight inside the backend.
- Main/Host upper layers allow only one in-flight Promise for `connectRemote()` of the same pool.
- The backend reclaims only the Windows children it explicitly created, keeping stdin EOF as the normal server
  exit path.

### Remote zcode-server / services

- One `createLocalServices()` keeps serving multiple workspaces.
- `ZCodeAgentProcessManager` keeps isolating Agents by `workspaceKey`.
- Implement an awaitable, idempotent workspace preparation/runtime release; closing only the Renderer port and
  leaving the Agent behind is not allowed.
- Runtime release does not delete persisted task/session data and releases only processes and rebuildable
  in-memory resources.

## Identity Model

### Pool identity

```text
poolKey = encode(
  windowWebContentsId,
  canonicalDistro,
  linuxUser
)
```

Rules:

- `windowWebContentsId` must exist and must not be omitted even though the product currently has one window.
- The distro is trimmed and keyed by the canonical distribution name returned by WSL; it must not rely only on
  the UI display label.
- The Linux user must be the user the backend actually uses. When no user is entered explicitly, the resolved
  user should be obtained after the connection probe, and the provisional connect key is safely merged into the
  resolved pool key.
- `$HOME` is not used as the user identity; the home directory can be customized.
- `workspacePath`, `workspaceIdentity`, `remoteSessionId` and the server asset version do not enter the pool
  key.
- Secrets, environment variable contents or the full command are not written into keys or logs.

Distro/user may use defaults before the connection starts, so acquisition and final identity are two layers:

```text
connectKey = windowWebContentsId
  + normalizedRequestedDistroOrDefaultSentinel
  + normalizedRequestedUserOrDefaultSentinel

resolvedPoolKey = windowWebContentsId
  + canonicalDistro
  + resolvedLinuxUser
```

- `connectKey` is used only for the waiter single-flight before the first resolve and cannot be the long-term
  identity of a ready Host.
- The same `connectKey` starts at most one Host at a time, avoiding several default distro/user requests
  connecting repeatedly before resolve.
- After the Host resolves, it atomically registers `resolvedPoolKey` and keeps an in-process alias
  `connectKey → resolvedPoolKey` until the Host is disposed or the WSL discovery cache is invalidated.
- If another ready Host already occupies the same `resolvedPoolKey`, the new Host does not publish an
  attachment; waiters move to the existing Host and the new Host is disposed. This conflict path must have a
  unit test.
- An explicit distro/user and a default that finally resolve to the same identity may converge after the first
  resolve; when the first concurrent requests use different `connectKey`s, a short-lived loser Host may
  appear, but two ready pool owners must never exist.

### Logical session identity

`remoteSessionId` keeps representing one Renderer/Main logical remote workspace route:

```text
workspace A → remoteSessionId A → attachment A ─┐
workspace B → remoteSessionId B → attachment B ─┼→ shared WSL Host
workspace C → remoteSessionId C → attachment C ─┘
```

Closing `remoteSessionId A` is not closing the shared Host.

### Workspace identity

All isolation semantics keep using:

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

File read/write, Git, terminal and command cwd keep using `workspacePath`. Main, Host, mobile attachment,
provider registry and Agent release requests must carry both `workspaceIdentity` and `workspacePath`; matching
by path alone is forbidden.

## State model and authority

### Host pool state

```ts
type RemoteWslHostState = "connecting" | "ready" | "draining" | "idle" | "disposing" | "disposed";

interface RemoteWslHostEntry {
  process: ElectronUtilityProcess;
  generation: number;
  target: SanitizedWslTarget;
  resolvedDistro?: string;
  resolvedUser?: string;
  state: RemoteWslHostState;
  readinessPromise: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  disposePromise?: Promise<void>;
}
```

This is a design shape and the implementation need not copy the types verbatim, but these invariants must be
kept:

- A pool key has at most one non-disposed Host entry at a time.
- A Host entry has at most one idle timer and one dispose Promise at a time.
- `generation` increases monotonically; timers, ready continuations and exit callbacks must compare both the
  entry object and the generation before modifying the map.
- After `disposing`, new attaches are rejected; a caller that needs a new Host must wait until the old entry is
  removed from the map.
- Map deletion is compare-and-delete; an old Host exit cannot delete a new Host with the same key.

### Logical session state

```ts
interface AttachedWslWorkspaceSession {
  host: RemoteWslHostEntry;
  attachmentId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}
```

Main does not additionally store a hand-kept `refCount` that can be derived. Desktop references are derived
from attached logical sessions; mobile references from the existing shared-host attachment registry. An index
may be maintained when frequent decisions need it, but only the same atomic attach/detach entry may update it,
and a consistency test is required.

### Workspace runtime state

```text
active
  ├─ refs > 0                         → active
  └─ refs = 0
     ├─ running task exists           → draining
     └─ no running task               → releasing → released

draining
  ├─ new attachment arrives           → active
  ├─ task reaches terminal state      → releasing → released
  └─ owner teardown                   → forced bounded shutdown
```

The authority of whether a task is running remains the Host/remote Agent/session service. Main may hold the
lifecycle marker "the workspace is draining" but must not copy task content, stream events or snapshots.

The acquire/release of a workspace runtime uses an independent, monotonically increasing workspace generation.
When Main re-establishes a logical session for the same workspace it must first send the acquire generation to
the Host and wait for the ACK, and only after a successful ACK may it attach the RPC MessagePort. On receiving
acquire, the Host cancels an older release that has not started; if an older release has already entered
`releaseWorkspacePreparation()`, it waits for it to finish before the ACK. Before the release completes the new
session must not enter resume/create/sendPrompt.

```text
close generation=7
  → ReleaseRemoteWorkspace(generation=7)
      → releaseWorkspacePreparation in-flight

reopen generation=8
  → AcquireRemoteWorkspace(generation=8, requestId)
      → invalidate pending release generation<8
      → await in-flight release generation=7
      → RemoteWorkspaceAcquired(generation=8, requestId)
  → attach service port
  → resume/create/sendPrompt
```

The implementation adopts the equivalent convergence "resolve before building the Host": Main runs a cacheable,
failure-non-sticky WSL identity resolution for the provisional target, and only after obtaining the canonical
distro name from the WSL list and the actual Linux user from `id -un` calls the Host pool `getOrCreate`. The
provisional key therefore serves only the resolver single-flight/cache and never becomes the long-term identity
of a ready Host; the default target, an explicitly equivalent target and a target differing only in case but
hitting the same name in the WSL list all end up using the same resolved key. Concurrent resolvers may probe
repeatedly, but the resolved `getOrCreate` must atomically guarantee only one Host is spawned. If the
App/window closes during resolution, the completion continuation must re-check the shutdown/window state and
must not create a Host after the teardown snapshot.

Main's wait for the acquire ACK must have a 10s deadline; the deadline only terminates this logical connect, and
must not bypass the ACK to attach, nor kill a shared Host that still serves other workspaces. Host exit/App
shutdown must reject all pending acquire waiters. The generation is allocated before `AcquireRemoteWorkspace`
is sent, so on timeout/cancel the waiter cannot merely be discarded: Main must immediately send a best-effort
compensating release with the same generation. If a successful ACK arrives after the waiter gave up, Main must
confirm that the workspace has no attached desktop/mobile owner and resend a release with the generation
carried by the ACK; a failed ACK needs no compensation. Thus even if the first release overlapped an old
generation's in-flight release in the Host and did not run, the late ACK still closes after the old release
completes.

A successful Acquire ACK only means the Host granted the runtime owner of that workspace generation, not that a
desktop logical attachment has been established. If after the ACK any of `AttachServicePort`, the renderer port
transfer or session tracking fails, Main must run a compensating `ReleaseRemoteWorkspace` for the same
generation and then release the pool owner; releasing only the pool owner is not equivalent to releasing the
workspace runtime inside the shared Host. A mobile shared-host attachment must verify the bound
`workspaceGeneration` before creating or transferring a MessagePort, and an illegal session must not leave the
Host an attachment held by no caller.

```text
AcquireRemoteWorkspace(generation=N) → ACK
  → validate generation
  → AttachServicePort
      ├─ success → logical session owns runtime N
      └─ failure → ReleaseRemoteWorkspace(generation=N)
                  → release pool owner
```

## Create, reuse and cancel sequence

```text
Workspace A connect
  → Main canonicalize provisional WSL target
  → reserve pool entry(connecting, generation=N)
  → create Host
  → create WSLBackend
  → resolve distro + Linux user
  → detect/deploy/start zcode-server
  → Host Connected
  → entry(ready)
  → AttachServicePort(A, workspace context)
  → publish RemoteServicePort(A)
```

Concurrent connects to the same target:

```text
Connect A ─┐
Connect B ─┼→ same readinessPromise → one detect/deploy/server start
Connect C ─┘

ready
  ├→ independent attachment A
  ├→ independent attachment B
  └→ independent attachment C
```

Cancel rules:

- Cancelling one pending logical connect only removes that waiter.
- Every pending owner created by `wslHostPool.retain()` must be released by a single idempotent closing
  function; after the cancel triggers the acquire Promise rejection, the async catch must not decrement the
  reference again. The owner moves from the pending connect to the tracked logical session only after a
  successful attach, and session dispose is responsible for the one later release.
- Dispose a connecting Host only when all waiters are cancelled, the Host is still connecting and has no
  attachment.
- Once the Host is ready, an old cancel must not destroy a Host already reused by other sessions.
- App/window/update shutdown unconditionally overrides the waiter rule, rejects all pending and releases the
  Host.
- When the `setupRemoteConnection()` continuation resumes after shutdown it must check the Host lifecycle token
  and must not republish the connection or attachment.

## Workspace detach and runtime reclamation

```text
close workspace A
  → remove A from the logical session map
  → DetachServicePort(attachment A)
  → derive desktop/mobile refs of workspaceKey A
     ├─ refs > 0
     │  → keep the runtime
     └─ refs = 0
        ├─ no running task
        │  → disposeWorkspace(workspaceKey A)
        └─ running task
           → mark draining(A)
           → terminal event
           → re-check refs
              ├─ refs > 0 → active
              └─ refs = 0 → disposeWorkspace(A)
```

`releaseWorkspacePreparation()` must change from a no-op into a real lifecycle entry and satisfy:

- Arguments resolve `workspaceKey` with `workspaceIdentity` falling back to `workspacePath`.
- It forms a single implementation with `disposeWorkspace()` or an equivalent Agent manager API; no two release
  semantics are kept.
- Idempotent; repeated calls reuse the in-flight call or return the released result.
- Mutual exclusion with `ensureAgentReady()` of the same workspace, or generation-based protection against "an
  old warm-up continuation publishing an Agent after the release completed".
- When a running task exists the Agent is not killed directly; it returns an explicit busy/draining result, or
  the Host coordinator defers the call.
- Owner teardown may bypass the busy retention policy and enter the bounded shutdown of the whole Host.
- It releases only processes, watchers, MCP transports and rebuildable caches, and does not delete
  session/task persisted data.

## Pool idle TTL

The pool can enter idle only when all of these hold:

1. No attached desktop logical session.
2. No mobile shared-host attachment of this Host.
3. No draining workspace/running task owner.
4. The Host is ready and has no pending connect waiter.

```text
last owner released
  → entry.state = idle
  → install timer(entry identity, generation=N, 60s)

new connect before deadline
  → compare current entry + generation
  → clear timer
  → state = ready
  → attach

timer fires
  → compare current entry + generation
  → re-check all four idle predicates
  ├─ predicate false → no dispose; transition to ready/draining as derived
  └─ predicate true
     → state = disposing
     → remove/mark entry atomically
     → disposeHostProcessAndWait
```

The TTL constant is named and defined centrally, and unit tests use an injectable clock/fake timer; `60_000`
must not be scattered over multiple call sites.

## Real window close, App quit and update install

Owner teardown has higher priority than the idle cache and draining tasks:

```text
real window close / app quit / update install
  → manager enters shuttingDown
  → reject new Host, connect and attachment
  → cancel all Host idle timers
  → reject pending connect waiters
  → snapshot all dedicated/shared/bot Hosts
  → dedupe by process identity
  → dispose all Hosts in parallel
  → await aggregate bounded barrier
  → continue window destruction / app quit / update handoff
```

- Renderer reload is not owner teardown; existing logical sessions recover per the existing reattach design.
- Minimizing and hiding to the tray trigger no idle and do not reduce workspace owners.
- App quit during the idle TTL cancels the timer at once and releases without waiting for the TTL.
- App quit during workspace draining does not wait for the task to end naturally and reuses the existing
  Host/server/Agent shutdown deadline.
- Repeated `before-quit`, window `closed` and update preparation calls must hit the same single-flight result.
- The WSL shared Host must enter the existing app-level full snapshot of remote Hosts and not rely only on the
  window `closed` event.

## Probing, deploy and `wsl.exe` concurrency management

### Probe cache

The cache has two layers:

- Within the pool Host lifetime: backend `resolvedInfoPromise` is reused permanently.
- Main-process-level read-only discovery: `wsl --status` and the distro list use a 5s TTL cache; refreshing the
  WSL connection UI or a connection failure may invalidate it actively.

The Linux user, `$HOME` and actual distro must be scoped to the concrete Host target and must not be cached
permanently and globally per Windows user. A cached rejected Promise must be cleared so later connections can
retry.

### Connection throttling

The same poolKey uses single-flight rather than a semaphore; connections of different distros may run
concurrently. If a real runtime trace proves system-level lock contention of the WSL VM across concurrent
distros, a small global concurrency semaphore may be added; a serial policy must not be hard-coded from an
estimate first.

### Deploy single-flight and lock

A normal version match keeps skipping the upload. A first install/upgrade must satisfy:

- Deploy within one Host reuses the readiness Promise. A second window or App instance, even without a shared
  pool, must not compete for the same fixed `${remotePath}.new`: the staging path uses an unpredictable suffix
  unique to this deploy, the final replacement is an atomic rename in the same filesystem, and cleanup deletes
  only this owner's staging file (no broad glob).
- A remote lock scoped to the distro/user/server install root serializes the whole `deployServer` transaction
  (main server, Node runtime, Agent bundle, official plugin directory and the final version marker), so two
  versions never install interleaved. The version is re-checked inside the lock, and a waiter must not upload
  again unconditionally. The component cache lock cannot replace this install-root lock.
- The lock is fixed at `${REMOTE_BASE}/.deploy.lock` with an unpredictable UUID owner. The lock-holding shell
  refreshes the owner file mtime every 30s; a waiter takes over only a lock without a heartbeat for over 600s.
  Release compares the owner token again, so an old owner never deletes a later owner's lock; Host/backend
  close (stdin EOF) goes through the same owner-checked cleanup.
- `wsl.exe -- bash -lc <command>` regroups arguments through the WSL default shell, so local `$lock_dir` /
  `$owner_token` in the command argument could expand to empty. The lock-holder script is written as an
  octal payload without `$` into an owner-unique temp script, run by bash and deleted on exit, with stdin kept
  for the release marker. SSH/Docker reuse the same wrapper; the deploy transaction semantics do not fork for
  WSL.
- Deadlines on external boundaries: lock release waits at most 5s for close, then best-effort destroys the lock
  stream and returns an error with owner, deadline and stderr summary (without disposing the shared backend; if
  the deploy body also failed, both error contexts are kept). Lock acquisition waits at most 120s in total
  (`DeployOptions.deployLockAcquireTimeoutMs` may override), counted from lock-holder stream creation; on
  timeout the waiter destroys only its own stdin/stdout/stderr, removes listeners and throws an acquisition
  timeout, never deleting another owner's lock or disposing the backend. Each manifest CDN candidate's response
  headers and body read are bounded by `manifestRequestTimeoutMs`, and a timeout lets later connections retry.
- One deploy transaction pins one fresh manifest: the GLM skip decision, local release materialize and the
  written component identity use the same SHA-256 snapshot. An equal semantic version with a changed SHA must
  redeploy; an equal SHA must not upload again because the version label changed. The manifest source follows
  the component's real resource source: with complete mock-cdn files use the mock manifest; with a mock
  manifest but incomplete target component files and a configured CDN fallback, both the SHA decision and
  materialize switch to the same fresh CDN manifest, and the whole GLM artifact is not downloaded just to read
  the SHA.

```text
deployServer
  → start remote lock-holder shell
      → mkdir ~/.zcode/server/.deploy.lock (atomic acquire)
      → write owner UUID + heartbeat
      → emit acquired marker
  → re-run checkServerDeployDecision inside the lock
  → fetch one bounded fresh manifest snapshot
      → GLM SHA decision + release materialize share the snapshot
  → install all selected components + write version markers
  → send owner-scoped release / stdin EOF
      → compare owner UUID → remove only this lock
```

The local upload directory and the dev-state official plugin directory use a unique remote archive and unique
extract staging; on failure only this owner's archive/staging is cleaned, and the final directory replacement
runs inside the deploy-root lock (`RemoteDownloadAssetInstaller.installDirectory()` has its own unique staging,
but its final `rm + mv` also relies on this lock).

## Failures, disconnects and recovery

The WSL backend's shutdown barrier must first forbid new commands and then reclaim all registered children.
Any continuation that crossed a discovery / identity await after the `exec()` entry gate must check disposed
again before the final synchronous `spawn()`; the check, spawn and child registration sit in the same
JavaScript turn, and a new `wsl.exe` must not be produced after `disposeAndWait()` has completed. A probe
command via direct `execFile()` must likewise check disposed before creating the child synchronously.

### Shared Host unexpected exit

```text
Host/server unexpected close
  → compare pool entry identity
  → mark disposed and remove pool entry
  → cancel idle timer
  → enumerate attached logical sessions
  → emit RemoteSessionClosed for each session
  → existing UI marks affected workspaces disconnected
```

A shared Host exit affects all workspaces of the same pool, which is a fault domain the shared plan explicitly
accepts. Reconnecting any still-open workspace makes Main create a new Host; the other still-open workspaces
of the same group can reuse that Host to recover their attachments one by one. The path/provider/Agent
initialization failure of each workspace stays independent, and a failure of workspace B does not roll back the
already recovered workspace A.

### Stale continuation

All connection, deploy, attach, timer and exit continuations that cross an `await` check before writing shared
state:

- the manager has not entered `shuttingDown`.
- the pool map still points to the same Host entry.
- the generation has not changed.
- the logical request/session has not been cancelled.

On a failed check, only the resources it created itself and has not yet transferred an owner for are released,
and no stale port/connection is published.

### Logging

Host create/ready/idle/reuse/dispose/exit are low-frequency lifecycle `info`; deploy lock waits, connection
cancels and idle predicate changes use `debug` or a single `info` (no polling logs); timeouts, stale callbacks
and unexpectedly long release busy use `warn`; unrecoverable handshake, deploy, Agent release or shutdown
failures use `error`. Logs carry the pool label, generation, a safe summary of remoteSessionId/workspaceKey,
phase and elapsedMs, and never secrets, the full environment or user commands.

## Desktop continuous and mobile replayable boundary

```text
shared WSL Host
├─ desktop attachment
│  └─ clientMode=desktop-continuous
│     └─ direct continuous events; no relay_bridge
└─ mobile attachment
   └─ clientMode=web-remote-replayable
      └─ existing replayable gap/snapshot recovery
```

- Host sharing only changes process reuse, not the delivery kind.
- An ordinary desktop WSL must not register `relay_bridge` because the Host becomes shared.
- Mobile `/remote` keeps attaching to the existing desktop WSL Host and must not start a separate WSL
  session/runtime.
- A mobile disconnect only detaches the mobile attachment; only if there is no other reference and no running
  task does it take part in the workspace/pool idle decision.
- `workspaceIdentity` and `remoteSessionId` must run through the bridge, snapshot, queue, owner command and
  cache keys.
- Owner/lease and stale run protection are kept; a shared Host cannot replace the task owner decision.
- Main neither splices replayable events nor caches the task stream to help Host sharing.

## Docker backend decision

This design deliberately adds no symmetric shared pool for Docker:

- The shared identity of WSL is the stable distro + Linux user under the current Windows user; a Docker target
  may correspond to a one-shot container, a mutable container name or a different container lifecycle owner.
- There is currently no evidence that several Docker workspaces should share one container service graph, and
  no user confirmation whether the container should stay, stop or be deleted after the last workspace closes.
- Rashly applying the WSL/SSH pool would change the container owner and isolation semantics.

Docker still uses a dedicated Host but keeps taking part in the unified real-window-close/App/update shutdown
barrier and the idempotent dispose interface. Sharing Docker later must first separately confirm the container
identity, owner, rebuild and volume/workspace isolation.

## Test design

Unit tests cover these groups (each with fake timers/clock where relevant):

- **Pool identity:** same window, canonical distro and resolved user give the same key; different user or
  window do not share; workspacePath, workspaceIdentity, remoteSessionId and secrets never enter the key or
  logs.
- **Desktop Main pool:** concurrent connects with the same key spawn one Host and share the readiness Promise;
  each session gets its own attachmentId/MessagePort; cancelling one waiter does not affect the others and only
  cancelling all disposes a connecting Host; detach keeps a Host that still has references; the last reference
  installs the unique 60s timer; reconnect within the TTL cancels it and reuses the process; a new reference
  before the timer fires makes it a no-op; old generation timer/exit callbacks do not affect a new Host; window
  close/App quit/update install cancel timers and await Host dispose; reload, minimize and tray hide do not
  dispose; an unexpected Host exit emits closed to all associated sessions.
- **Workspace runtime:** `releaseWorkspacePreparation` is no longer a no-op and releases the right Agent by
  workspaceKey; repeated release is idempotent; release and warm-up concurrency never publish an Agent that
  lost its owner; refs=0 without a running task releases immediately; refs=0 with a running task drains without
  interruption and re-checks refs after terminal; re-attach during draining restores active; reopen after
  close does not attach the RPC port before the old release completes; acquire generation invalidates an older
  pending release; acquire ACK timeout or Host exit fails the connect; ACK success followed by attachment
  failure compensates by releasing the same generation; a mobile attach lacking a workspace generation is
  rejected before the MessagePort transfer; release deletes no persisted data.
- **Deploy/discovery:** discovery Promise/cache sharing, no permanent caching of rejection, TTL expiry and
  refresh; version match skips upload; competing installers upload once and the waiter re-checks inside the
  lock; staging path unique and cleanup limited to this owner; stale lock recoverable and active lock not
  preempted; lock release timeout after 5s destroys the owner stream; deploy and release failures keep both
  contexts; a half-open manifest body fails within the deadline and is not reused; GLM same-version
  different-SHA redeploys using one pinned manifest; mock manifest with incomplete GLM files uses the CDN SHA
  decision and does not download the artifact when the remote SHA matches.
- **Host/server shutdown:** attachments stop accepting RPC before service dispose; workspace release
  pending/throw does not block the connection close phase; stdin EOF waits for server/wsl.exe exit; the deadline
  fallback handles only backend-owned children; idle dispose and app-level dispose reuse one Promise.
- **Desktop/mobile boundary:** desktop WSL stays `desktop-continuous` with no `relay_bridge`; mobile uses
  `web-remote-replayable` and creates no WSL Host; snapshot/event/queue/owner commands of different workspaces
  do not cross-route; a mobile detach does not kill a runtime that still has a desktop owner or running task.

### Real Windows + WSL verification

Every sample records timestamps and parent-child relationships:

1. Open one WSL workspace; record Host, `wsl.exe`, server and Agent PID and RSS.
2. Open the 2nd to 5th workspace of the same distro/user in the same window; the Host/server PID does not
   increase while Agents increase per workspace.
3. Compare total RSS, first-connection time and later attach time with the dedicated baseline.
4. Close one workspace: its attachment disappears; with no task its Agent exits within the deadline while the
   Host/server stays. With a running task, the task is not interrupted and the Agent is released after terminal.
5. Close the last workspace: Host/server stays within 60s and exits after the TTL; reopening within the TTL
   reuses the original PIDs.
6. Quit the App during the TTL: no 60s wait, all ZCode-owned Host/server/Agent exit within the shutdown
   deadline. Also verify real window close, update install, renderer reload, minimize and tray hide.
7. After a mobile attach, close the desktop tab: the mobile owner keeps the runtime; after the mobile
   disconnects it enters draining/idle.
8. Inject Host crash, connect cancel, deploy failure and a stale timer, and keep logs and PID evidence.
9. Confirm the distro can keep Running and ordinary user processes in it are unaffected.

Mechanical verification: `pnpm typecheck` and `pnpm lint`.

## Risks and mitigations

| Risk                                              | Mitigation                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A shared Host crash widens the impact             | Limit to window + distro + user; notify associated sessions in batch; reconnect recovers per workspace independently.                                                         |
| An old timer wrongly kills a reused Host          | entry identity + monotonic generation + re-derive idle predicates before firing.                                                                                              |
| Hand-kept refcount drift                          | Prefer deriving from the authoritative sets of logical/mobile attachments; if an index is built for performance, only an atomic entry may update it, with a consistency test. |
| Closing a tab wrongly kills a background task     | Enter draining when refs=0 and running; release only after terminal.                                                                                                          |
| Draining never ends                               | Normally wait for the task lifecycle; real owner teardown uses the existing bounded shutdown; abnormal disconnects are cleaned by Host exit.                                  |
| Data mix-up between workspaces in a shared server | All isolation keys use `workspaceIdentity` falling back to `workspacePath`; end-to-end multi-workspace tests.                                                                 |
| First-install deploy contention                   | Unique staging + remote lock + version re-check inside the lock.                                                                                                              |
| Stale discovery cache                             | 5s short TTL, active refresh/failure invalidation, no permanent global caching of resolved user/home.                                                                         |
| App quit delayed by the TTL                       | Shutdown cancels timers first and disposes in parallel at once; the TTL never enters the exit wait budget.                                                                    |
| Mobile replayable pollutes desktop                | Attachments keep clientMode/deliveryKind; desktop WSL explicitly forbids relay_bridge.                                                                                        |
| Docker wrongly symmetrized                        | This spec explicitly keeps dedicated; design again after the container owner is confirmed.                                                                                    |

## Acceptance

- Several WSL workspaces of the same window, canonical distro and Linux user have exactly one Host, one server
  connection and one `zcode-server`.
- Each logical workspace keeps its own remoteSessionId, attachment, workspaceIdentity and workspaceKey; no
  cross-workspace task/session/provider/queue mixing.
- Closing a workspace with no running task really releases the corresponding Agent/preparation runtime and no
  longer stays a no-op.
- An attachment failure after a successful acquire leaves no workspace runtime or Host attachment without a
  logical owner.
- Closing a workspace with a running task does not interrupt the task immediately; the runtime is released
  after terminal.
- After the pool has zero owners it enters a 60s idle TTL, reuses within the TTL and releases
  deterministically after the TTL.
- Real window close, App quit and update install enter bounded shutdown immediately in any TTL or draining
  state, without waiting 60s.
- Minimize, tray hide and renderer reload do not wrongly release a still-valid Host/runtime.
- Concurrent connections of the same pool run detect/deploy/server start only once; a first install/upgrade
  has no staging path contention.
- Deploy lock acquire/release and manifest HTTP requests each have an independent deadline; a half-open
  external boundary never holds the lock indefinitely.
- GLM resources decide content identity by the pinned manifest SHA, and a same-version re-issued artifact is
  updated correctly.
- Desktop WSL stays `desktop-continuous` with no `relay_bridge`; mobile stays a `web-remote-replayable`
  shared-host attachment.
- Docker stays dedicated but is still covered by the app-level shutdown barrier.
- Real Windows + WSL verification for 1/3/5 workspaces leaves PID, RSS, timing and release-time evidence.
- No distro terminate is called and non-ZCode WSL user processes are unaffected.
- Related tests, `pnpm typecheck` and `pnpm lint` all pass.
