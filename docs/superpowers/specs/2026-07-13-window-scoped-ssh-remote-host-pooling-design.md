# Window-scoped SSH Remote Host Pooling Design

## Feature summary

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change                | Desktop SSH remote workspaces move from one Remote Host per workspace to one shared Remote Host per SSH connection config per Electron window.                                                                                                                                                                                                                                                                                 |
| User-visible surfaces | SSH connect, remote directory selection, remote workspace tabs, disconnect/reconnect, renderer reload, mobile `/remote` entering an SSH workspace.                                                                                                                                                                                                                                                                             |
| Existing docs         | `docs/architecture/zcode-code-architecture-overview.md`, `docs/architecture/message-flow.md`, `docs/remote-workspace-session-unified-settings.md`, `docs/ssh-remote-app-global-state-authority.md`, `docs/web-remote-control/web-remote-control-architecture.md`, `docs/web-remote-control/task-realtime-sync.md`, `docs/web-remote-control-task-command-queue.md`, `docs/remote/desktop-remote-session-renderer-reattach.md`. |
| Existing code owners  | `packages/desktop/src/main/desktopRemoteSessions.ts`, `packages/desktop/src/main/desktopHostProcess.ts`, `packages/desktop/src/host/index.ts`, `packages/desktop/src/renderer/src/main.tsx`, `packages/ui/src/store/remoteWorkspaceSessionStore.ts`, `packages/ui/src/root/useRemoteWorkspaceHistory.ts`, `packages/ui/src/root/useRemoteWorkspaceTabLifecycle.ts`.                                                            |
| Out of scope          | WSL/Docker Host sharing, cross-window sharing, SSH Profile data model, Host-level disconnect UI, remote resident daemon, app cold-start auto-reconnect.                                                                                                                                                                                                                                                                        |

## Background

A desktop local window creates a single Local Host whose `ZCodeAgentService` manages multiple Agent processes by `workspaceKey`, so local workspaces in a window share one Host. SSH was different: `createRemoteWorkspaceSession()` generated a new `remoteSessionId`, forked a new Remote Workspace Host, opened a new SSH connection, and started a new remote `zcode-server` every time — even for identical SSH login configs. The legacy implementation coupled three identities:

```text
remoteSessionId
  = workspace 的 Renderer RPC 路由身份
  = Main 侧 Remote Host 进程身份
  = Web Remote Control shared-host attachment 的查找身份
```

The remote `zcode-server` has no one-workspace-per-process limit: its `createLocalServices()`-created `ZCodeAgentService`, `ZCodeSessionService`, task index, and provider registry state are already isolated by `workspaceKey = workspaceIdentity?.trim() || workspacePath`. Only Desktop Main's Host/session lifecycle and MessagePort routing needed changing, not the remote Agent protocol.

## Goals

- Within one Electron window, multiple remote workspaces using the same normalized SSH config create one Remote Host.
- A shared Remote Host holds one SSH connection and starts one remote `zcode-server`.
- Each workspace keeps an independent `remoteSessionId`, MessagePort, `workspaceIdentity`, and `workspaceKey`.
- Closing/removing a workspace only detaches its session and RPC attachment; a ready Host stays cached until the window closes, even with zero bindings.
- An unexpected Host disconnect moves all associated workspaces to disconnected together.
- A user-initiated reconnect from any associated workspace restores all still-open workspaces in the same window using the same SSH config.
- Host-level connection failure fails the whole Host; after Host ready, path/Provider Registry/Agent initialization succeed or fail per workspace.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` boundaries stay as-is, as do remote `workspaceIdentity` isolation and real-`workspacePath` execution semantics.

## Non-goals

- No cross-window Host sharing; WSL/Docker keep one-Host-per-workspace.
- No SSH Profile ID, no migration of remote workspace history or credential storage.
- No user-visible Host-level "disconnect SSH config" entry.
- No remote daemon listening on a port/socket.
- No persistence of Host pool, readiness, attachments, or `remoteSessionId`; no SSH auto-connect at app cold start.
- No changes to `@zcode/protocol`, or to task/stream/queue/snapshot/permission/elicitation/owner-lease product semantics.
- No task/session/realtime business state sinking into Desktop Main or Relay.

## Boundary decisions

| Boundary            | Decision                                                                | Includes                                         | Excludes / prunes                           |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------------------ | ---------------------------------- |
| Sharing scope       | `(windowWebContentsId, remoteHostKey)` uniquely identifies an SSH Host. | Same-window same-config workspaces.              | Cross-window Hosts.                         |
| Host lifecycle      | A ready Host is cached until window close.                              | Idle Hosts with zero workspaces.                 | Dispose on last-session-close.              |
| Session identity    | `remoteSessionId` stays workspace-scoped.                               | Independent RPC port, cache, mobile route.       | Host-level shared session id.               |
| Workspace isolation | `workspaceKey = workspaceIdentity?.trim()                               |                                                  | workspacePath`.                             | Agent/provider/task/cache isolation. | Matching by `workspacePath` alone. |
| Reconnect           | One workspace's reconnect restores the group's still-open workspaces.   | One Host connection, multi-workspace attachment. | Per-workspace manual reconnect.             |
| Partial failure     | After Host ready, per-workspace.                                        | Provider/path/Agent init errors.                 | Rolling back the whole Host on one failure. |
| Remote kind         | Only SSH enters the Host pool.                                          | password/private-key/agent auth.                 | WSL/Docker.                                 |
| UI                  | No new Host-level disconnect entry.                                     | Existing workspace/tab behavior.                 | New UI and styles.                          |
| Persistence         | The Host pool is in-memory only.                                        | Existing remote workspace history.               | Host/Profile schema migration.              |
| Protocol            | Only Desktop-internal channel/platform messages change.                 | Main ↔ Host, Renderer ↔ Main.                    | `@zcode/protocol`.                          |

Host-level dispose closes all associated sessions; transport failure is layered separately from workspace initialization failure.

## High-risk cross-products

| Cross-product                  | Candidate risk                                                      | Handling                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Host pool × workspace identity | Same path on different SSH hosts mixing services.                   | `remoteHostKey` only decides process reuse; every call still carries workspaceIdentity.                  |
| Host pool × Renderer reload    | One Host re-attaching multiple sessions overwriting renderer store. | Independent MessagePort and remoteSessionId per session.                                                 |
| Host pool × mobile replayable  | Phone reaching workspace B via session A.                           | Attach validates remoteSessionId, window owner, and workspaceIdentity/workspaceKey together.             |
| Host pool × realtime scope     | Host receiving events for unbound workspaces.                       | Scope derived live from attached session context into TaskRealtimeBus.                                   |
| Host pool × provider registry  | One workspace's applied revision reused by another.                 | Remote registry and revisions stay keyed by workspaceKey.                                                |
| Host pool × cancel             | One waiter's cancel killing other concurrent waiters.               | Pending connects are independent; dispose only when all waiters cancel and the Host is still connecting. |
| Host pool × stale exit         | An old Host exit callback deleting a new Host.                      | Compare current pool entry/process object identity before deletion.                                      |
| Host pool × window lifecycle   | One window's close killing another window's same-key Host.          | Pool key always includes windowWebContentsId.                                                            |
| Host pool × credentials        | Same-key workspaces saving different passwords.                     | A connected Host keeps being reused; a fresh connection uses the initiator's current valid credential.   |

## Concept map

| Concept                                    | Why it matters                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `createRemoteWorkspaceSession()`           | Used to fork a Host per call; the refactor entry point (`packages/desktop/src/main/desktopRemoteSessions.ts`).                 |
| `AttachServicePort`                        | Already exposes new RPC ports on the existing `activeServices` — the basis for sharing (`packages/desktop/src/host/index.ts`). |
| `activeServices`                           | The shared mixed ServiceCollection inside one Host.                                                                            |
| `createRemoteWorkspaceServiceCollection()` | Combines local app-global services, remote services, and wrappers.                                                             |
| `connectRemote()`                          | One full SSH backend + remote server stdio + RPC client connection (`packages/server/src/remote/connect.ts`).                  |
| `createLocalServices()`                    | The remote server's multi-workspace service owner (`packages/services/src/node.ts`).                                           |
| `ZCodeAgentProcessManager`                 | Already reuses/isolates Agent processes by workspaceKey.                                                                       |
| `remoteWorkspaceSessionStore`              | Renderer registers services by remoteSessionId, then binds the workspace by identity/path.                                     |
| `webRemoteControlSharedHostAttachments`    | Mobile attachments resolve a logical session to the shared process.                                                            |
| `TaskRealtimeBus`                          | Main-side router for Host delivery scope, owner/lease, session routes.                                                         |
| `buildRemoteWorkspaceIdentity()`           | authority + canonical-path workspace identity (`packages/ui/src/lib/remoteWorkspaceHistory.ts`).                               |

## State owners

| State / fact                       | Authority                                     | Mirrors / caches                             |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------- |
| Window SSH Host existence          | Desktop Main Host pool                        | none (pool entry + child process)            |
| Host readiness                     | Host pool entry `readiness`                   | pending connect waiters                      |
| pending connect                    | Desktop Main pending connect map              | UI loading state                             |
| logical remote session             | Desktop Main attached session map             | Renderer `sessionsById`, tab remoteSessionId |
| RPC attachment                     | Remote Host attachment map                    | Main session `attachmentId`                  |
| workspace context                  | Renderer tab/history, bound into Main session | Host realtime scope                          |
| workspace isolation key            | `resolveWorkspaceKey(context)`                | Agent/task/provider maps                     |
| remote Agent process               | remote `ZCodeAgentProcessManager`             | process lifecycle reports                    |
| Provider registry applied revision | remote workspace runtime                      | UI sync coordinator                          |
| task/session/stream state          | remote Agent/session services                 | desktop projection / mobile replay mirror    |

## Identity model

### `remoteHostKey`

New shared pure function:

```ts
buildSshRemoteHostKey(target: SSHConnectOptions | SSHRemoteTargetSnapshot): string
```

Encoding semantics:

```text
ssh:v1:
  normalizedHost
  + effectivePort
  + trimmedUsername
  + authKind(password | private-key | agent)
  + normalizedPrivateKeyPath
```

Rules:

- Host is trimmed then ASCII-lowercased; default port `22`. Username keeps case after trim.
- Private key path uses browser-safe, root-aware lexical normalization: trim, unify separators, strip trailing separators, normalize Windows drive-letter case. Windows drive root (`C:/`), UNC share root (`//server/share/`), and POSIX root (`/`) are roots that `..` cannot pop; relative paths keep unresolvable leading `..`; `~` is not a normal directory resolvable by `..`.
- The shared key builder never expands `~`, calls realpath, or resolves symlinks; Main and Renderer must derive the same key from the same persisted text. Different-but-equivalent path text only causes conservative non-reuse, never wrong reuse.
- Passwords and private-key passphrases never enter the key, logs, or persistent Host indexes.
- `workspacePath`, `workspaceIdentity`, and `remoteSessionId` never enter the key.
- `assetInstallMode` affects only first-deploy strategy, not connection identity. `resourcePackages` is legacy input, ignored by deploy, not in the key.
- `sshConfigAlias` names are not identity; the backend uses the alias-expanded effective fields. Two aliases with identical effective fields reuse one Host.
- Password snapshots derive auth kind via `passwordCredentialKey`; secret content stays out of the key.

### `remoteSessionId`

Still the workspace's Renderer/Main logical routing handle, no longer equal to a Host process ID; external semantics unchanged:

```text
workspace A -> remoteSessionId A --┐
                                   ├-> shared Remote Host
workspace B -> remoteSessionId B --┘
```

### `workspaceKey`

All identity/isolation keeps `workspaceKey = workspaceIdentity?.trim() || workspacePath`; actual file, Git, terminal, and command cwd keep using `workspacePath`.

## Lean state model

The Host pool keeps no derivable reverse sets of `sessionIds`/`workspaceKeys`:

```ts
type RemoteSshHostReadiness =
  | {
      kind: "connecting";
      promise: Promise<void>;
    }
  | {
      kind: "ready";
    };

interface RemoteSshHostEntry {
  process: ElectronUtilityProcess;
  target: SanitizedSshTarget;
  readiness: RemoteSshHostReadiness;
  taskRealtimeHostId?: string;
}

interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface PendingRemoteConnect {
  host: RemoteSshHostEntry;
  context?: RemoteWorkspaceContext;
}

interface AttachedRemoteWorkspaceSession {
  host: RemoteSshHostEntry;
  attachmentId: string;
  context?: RemoteWorkspaceContext;
}
```

Authoritative indexes:

```ts
sshHostsByPoolKey: Map<`${windowWebContentsId}\0${remoteHostKey}`, RemoteSshHostEntry>;

pendingConnectsByRequestId: Map<string, PendingRemoteConnect>;

attachedSessionsById: Map<
  string, // remoteSessionId
  AttachedRemoteWorkspaceSession
>;
```

Field constraints:

- The pool key already carries window and remoteHostKey; the value duplicates neither.
- Attached sessions reference the Host entry directly — no second `remoteHostId` map.
- TaskRealtimeBus reuses the `hostId` already generated by `spawnHostProcess()`.
- `workspaceKey` is always derived from context, never stored as a copy.
- Pending and attached live in separate maps; set membership expresses state, no session `state` field.
- `target` stores only the description without password/privateKeyPassphrase; full secrets are used only to start the Host.
- Low-frequency operations (Host failure, scope updates) derive the associated session/workspace set by scanning `attachedSessionsById`.
- When `connectRemote()` has no external requestId, Main generates an internal connectAttemptId; exact cancellation uses the external requestId, and window-level cancellation of legacy calls stays compatible by scanning that window's pending attempts.

## Approach comparison

**A — Main maintains a window-scoped SSH Host pool (adopted).** Keep the existing Remote Host and remote stdio server; split Host from logical session in Main. Pros: reuses `AttachServicePort` and remote multi-workspace capability; no remote listening port or daemon; `remoteSessionId`/Renderer store/mobile route semantics mostly unchanged; clear sharing scope, window lifecycle, and failure domain. Cost: Main manages pool/pending/attachment; the Host needs an explicit Detach RPC port; the UI reconnect coordinator batches by remoteHostKey.

**B — one Remote Broker Host per window (rejected).** One local Host managing multiple SSH targets and service graphs adds connection routing, fault isolation, and multi-graph state — too much process responsibility and regression surface.

**C — remote resident `zcode-server` daemon (rejected).** Multiple local Hosts connecting to one remote server needs remote auth, listen addresses, version upgrades, orphan-process reaping, and security design beyond the goal.

## Component responsibilities

### Shared: SSH Host key

Provides `buildSshRemoteHostKey()` and its normalization helpers. Desktop Main and the UI reconnect grouping must reuse the same implementation — never assemble the key independently.

### Desktop Main: Host pool and logical session

A focused `remoteSshHostPool` component (extracted from `desktopRemoteSessions.ts`) owns `getOrCreateHost()`, `reservePendingConnect()`, `attachSession()`, `detachSession()`, `bindSessionContext()`, `disposeHost()`, `disposeWindow()`. `desktopRemoteSessions.ts` keeps BrowserWindow/IPC adaptation, session-closed notifications, the WSL/Docker legacy path, and Bot/Web Remote Control bridging.

### Remote Host: shared ServiceCollection and attachment registry

The SSH shared path adds internal messages:

```ts
InitRemoteSshHost
AttachServicePort { attachmentId }
DetachServicePort { attachmentId }
```

`InitRemoteSshHost` only establishes SSH, runs deploy checks, starts the remote `zcode-server`, and creates the one shared ServiceCollection. It binds no workspace and never treats the init port as workspace 1's special channel. After Host ready, every logical session goes through `AttachServicePort`. The Host maintains:

```ts
attachedServicePorts: Map<string, ExposedServicePortHandle>;
```

`DetachServicePort` releases exactly that ChannelServer, protocol, and subscriptions; repeat detaches are idempotent.

### Renderer/UI: workspace binding and batch reconnect

The renderer still registers independent remote services by remoteSessionId. New explicit platform operation:

```ts
bindRemoteWorkspaceSessionContext({
  remoteSessionId,
  workspacePath,
  workspaceIdentity,
}): void;
```

Called after canonical path and workspaceIdentity are settled, before Provider Registry sync and connected-state commit. The legacy indirect binding through `syncWebRemoteControlWorkspaces` now only syncs mobile-visible workspaces — it is no longer Main session binding.

The SSH connect UI must keep the user-entered full target for the duration of the connect flow until credential/history mutations complete. Main's `RemoteServicePort` payload and the Renderer session store receive only a sanitized target; credential persistence must not depend on Main echoing password/privateKeyPassphrase back to the Renderer.

## Lifecycle

### First connect

1. Main computes `(windowWebContentsId, remoteHostKey)`.
2. Pool miss: create a connecting Host entry and fork `InitRemoteSshHost`.
3. The pending connect registers under `connectAttemptId = requestId?.trim() || randomUUID()`.
4. The Host establishes SSH, deploys the server, creates the ServiceCollection, reports `Connected`.
5. Host entry readiness becomes ready.
6. Main creates a new remoteSessionId and attachmentId.
7. Main sends `AttachServicePort` to the Host and delivers an independent `RemoteServicePort` to the Renderer.
8. The connect IPC returns the remoteSessionId; the Renderer waits for session-store registration.

### Subsequent same-config connects

- Connecting Host: reuse the same readiness promise, no duplicate fork.
- Ready Host: create a new logical session and attachment directly.
- Same remoteHostKey in a different window: different pool key, separate Host.

### Workspace context binding

1. An initial session may have no context (remote directory browsing).
2. The Renderer calls realpath remotely for the canonical workspacePath.
3. Build workspaceIdentity with the unified utility.
4. Bind the context to the remoteSessionId via the dedicated platform operation.
5. Main derives the Host's workspaceKey union from attached sessions and updates the TaskRealtimeBus scope.
6. UI then runs Provider Registry sync, history commit, and tab connected updates.

### Renderer workspace RPC readiness

The Renderer must classify workspace service resolution explicitly as `local-ready`, `remote-waiting`, or `remote-ready`. Local is always `local-ready`; a remote workspace becomes `remote-ready` only when its `remoteSessionId` exists in the Renderer session store and resolves to real remote services. Remote tab metadata alone or a reconnecting state is still `remote-waiting`.

During `remote-waiting`, the app shell, sidebar, and connect progress may render, but workspace RPC side effects must not start: workspace model init, conversation/sessions-index subscriptions, sessions-index listeners for task terminal notifications, MCP workspace directory config hydration, draft config hydration, and draft session prewarm. The disconnected proxy stays the final out-of-bounds guard — no fallback to local base services, no request caching and replaying across transports. App-global capabilities like usage entitlement use the base host service regardless of remote readiness.

This readiness only gates when the Renderer issues workspace RPCs; it does not change `desktop-continuous`/`web-remote-replayable`, owner/lease, or workspace identity semantics.

### Closing a workspace

1. Renderer deletes the tab and unbinds the identity/path → session mapping.
2. Main deletes the logical session.
3. Main releases that session's desktop RPC attachment and mobile shared-host attachments.
4. Main re-derives the realtime workspace scope.
5. A ready Host stays in the pool even with zero sessions.

### Renderer reload

Main walks still-attached logical sessions and creates a new attachment for each from the same Host. remoteSessionId and workspace context are unchanged; old attachments are explicitly released. This restores Desktop direct RPC only — never mobile replayable snapshot/gap semantics.

### Window close

Main deletes all pool entries for that window, releases all sessions/attachments, sends dispose to each Host, and waits for the existing force-kill fallback.

### Remote stdio server exit

SSH transport close makes the remote `zcode-server`'s stdin see `end`/`error`, or delivers `SIGHUP`/`SIGTERM`/`SIGINT`. The remote server owns its internal `ZCodeAgentProcessManager`, so it must not `process.exit()` directly; it stops RPC first, waits for graceful + force cleanup of every workspace Agent, then exits:

```text
stdin end/error or termination signal
  -> ChannelServer / connection scope 停止接收 RPC
  -> disposeServiceResourcesAndWait()
       -> 每个 workspace 的 Agent disposeAndWait()
       -> graceful stdin EOF
       -> 超时后进程树强杀兜底
  -> cleanup 完成、失败或整体 deadline 超时被记录
  -> process.exit(normal=0, transport/cleanup error=1)
```

Exit is idempotent: `end`, `error`, termination signals, or repeats start cleanup once and call exit once; another stdin error or termination signal during cleanup upgrades the final exit code to `1`. Cleanup failure must be logged and exit `1` — never skip exit or leak an unhandled rejection on a rejected Promise. The whole `stopRpc + disposeServiceResourcesAndWait` shares one default 5-second hard deadline, injectable for tests; if any stage pends forever, the server logs the pending stage and deadline and exits `1` without waiting. The deadline timer keeps its ref so it can drive final shutdown alone. This contract belongs to the remote server process only; the local Desktop Host's existing `disposeServiceResourcesAndWait()` path, workspaceKey, desktop continuous, and mobile replayable semantics are unchanged.

## Cancellation semantics

- One waiter of a connecting Host cancels: only that pending connect is removed.
- All waiters of a connecting Host cancel with no attached session: dispose the Host and stop in-flight upload/deploy.
- Cancelling remote directory selection on a ready Host: delete the temporary logical session; the Host stays cached.
- Closing the last workspace on a ready Host: the Host stays cached.
- requestId/connectAttemptId belongs only to pending connects, never to long-term attached-session state.

## Disconnect and reconnect

### Unexpected Host exit

1. Main confirms the exit callback still belongs to the current pool entry by Host entry/process object identity.
2. Find all `attachedSessionsById` sessions referencing that Host.
3. Send the existing remote-session-closed notification per session.
4. Release all desktop/mobile attachments.
5. Renderer clears each tab's remoteSessionId, keeping remote target, workspace history, and workspaceIdentity.
6. Delete the Host pool entry.

A stale exit/error callback from an old Host must never delete a new same-key Host.

### User-initiated reconnect

1. The UI uses `buildSshRemoteHostKey()` to find all still-open remote workspace tabs with the same key in the same window; the workspace the user reconnected from is the group initiator.
2. Load only the initiator's valid credentials and complete its logical connect first; when it returns, the shared Host in Main must already be ready.
3. If the initiator fails, stop the whole group immediately — other workspaces must not race to build a same-key Host with their own historical credentials.
4. After the initiator succeeds, restore the rest in parallel; the Main pool only creates independent attachments — no repeat SSH authentication.
5. Each workspace gets a new independent remoteSessionId.
6. Each workspace separately canonicalizes its path, binds context, syncs the Provider Registry, and initializes its Agent.
7. After initiator success, other workspaces keep independent failure semantics; one failing workspace never rolls back the ready Host or already-restored workspaces. Only the workspace the user clicked becomes the active tab; background-restored group members do not compete for it.

If the SSH/RPC transport drops during recovery, that is Host-level failure: all associated workspaces fail together.

## Service and provider boundaries

The shared Remote Host creates its local mixed ServiceCollection once:

- Local authorities: setting, credential, OAuth, model provider, usage stats, coding plan, broadcast, etc.
- Local wrappers: ZCode Task, ZCode Session, Repo Wiki, etc.
- Remote implementations: file, git, terminal, file watcher, Agent, skills, MCP/plugin sync, etc.

The remote `zcode-server` keeps managing by workspaceKey:

```text
zcode-server
├── workspaceKey A
│   ├── Agent A
│   └── appliedProviderRevision A
└── workspaceKey B
    ├── Agent B
    └── appliedProviderRevision B
```

The Provider Registry's source is the Desktop app-global config, but application and revision state stay per workspaceKey. A's sync failure does not mean the SSH Host is broken and must never clear B's successful state.

## Realtime and Web Remote Control

### Desktop continuous

- Each remoteSessionId uses an independent MessagePort; multiple MessagePorts point at the same Host `activeServices`.
- The UI subscribes to the remote continuous stream directly; it never splices mobile replayable restore messages.

### Mobile replayable

The phone still attaches an existing logical remote session via Relay/Main:

```text
remoteSessionId
  -> attached session
  -> shared Host
  + workspaceIdentity/workspaceKey validation
  -> remote services
```

`attachRemoteWorkspaceSessionHost()` must validate all of: remoteSessionId exists; the session belongs to the requesting window; workspaceIdentity is non-empty; `workspaceKey === resolveWorkspaceKey({ workspacePath, workspaceIdentity })`; the session's bound workspaceKey matches the request. Host sharing must never let mobile session A reach workspace B. Relay and Main keep doing only auth, pairing, heartbeat, rpc-frame/app payload forwarding, and attachment scheduling — no task/session/stream/queue/snapshot business state.

### TaskRealtimeBus

The SSH Host's realtime delivery kind stays `relay_bridge`. The workspace scope derives from the union of workspaceKeys of the Host's currently attached session contexts and updates via the existing `updateHostWorkspaceKeys()`. owner/lease, owner commands, pending permission/elicitation/command, and stale-run guards keep working per workspaceKey/task/run — never removed because of Host sharing.

## Persistence and credentials

- Host pool, readiness, pending connects, attachments, and remoteSessionIds are never persisted.
- App cold start restores disconnected remote workspace tabs without connecting.
- The existing `RemoteWorkspaceSessionEntry` schema is unchanged; no data migration.
- Existing password/private-key-passphrase credential keys stay saved per workspace history; duplicate credentials for same-config workspaces are accepted this round.
- Batch reconnect builds one Host with the initiator's successfully loaded credential; other workspaces do not re-authenticate.
- A ready Host is never replaced because password/privateKeyPassphrase content changed; the next real connection uses the initiator's current credential.

## Logging and security

- Full passwords, privateKeyPassphrases, Authorization/token, and full provider registries never enter logs.
- Main's long-lived Host entry stores no password or passphrase; the Renderer holds user input only temporarily, until the current connect flow's credential/history mutations finish.
- Allowed in logs: irreversible digests of the Host key, existing hostId, remoteSessionId, workspaceKey, state transitions, PIDs, error codes, durations.
- Host create/ready/exit and window dispose log `info`; recoverable attachment/context/single-workspace init failures log `warn`; unrecoverable Host connect/handshake/remote-server-start failures log `error`.
- Trace at stream/event volume uses service `debug`, never persisted in production.
- A failed SFTP session/write with a working exec pipe logs exactly one `warn` — never an `error` followed by a fallback `warn`; local file read failure or exec pipe failure remains `error`.
- When a new remote session, registry revision change, forced refresh, or pending retry explicitly requires pushing the Provider Registry, never call `getWorkspaceRuntimeIdentity` before the push. Read runtime identity only after registry application succeeds; only an unchanged verdict for the same session and revision may probe identity first to detect Agent rebuilds.
- If the post-apply identity probe still returns `ZCODE_AGENT_PROVIDER_NOT_READY`, keep one bounded replay guard — that error means the runtime was replaced after the apply response and is no longer a normal cold-start path.
- Node `ExperimentalWarning` / `DeprecationWarning` / `Warning` are structured by the host into one `warn`; the default stderr/console path must not also report an `error`.

## SSH upload capability degradation

- The SSH backend prefers SFTP initially, preserving upload performance and progress on healthy servers.
- After the first `sftp-session` or `sftp-write` failure, the backend marks itself `exec-upload-only`; the current file retries via exec pipe immediately and later files upload via exec pipe directly.
- `local-read` failure does not mean remote SFTP is unavailable and must not trigger `exec-upload-only`.
- The degraded flag lives only for the current backend lifetime; a new backend re-probes SFTP.
- The first degradation logs one `warn` with failure kind and error code; subsequent exec-only uploads keep normal start/progress/completion logs.

## Dimensions

| Dimension          | Values                                                 | Reason                                               |
| ------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| window             | same / different                                       | Sharing boundary.                                    |
| remote kind        | SSH / WSL / Docker                                     | Only SSH changes.                                    |
| SSH key            | same / different                                       | Host pool primary key.                               |
| Host readiness     | absent / connecting / ready / exited                   | Concurrency, cancel, error semantics.                |
| logical session    | pending / attached / removed                           | Attachment lifecycle.                                |
| workspace context  | unbound / bound                                        | Directory browsing and identity validation.          |
| attached count     | 0 / 1 / many                                           | Idle cache and sharing behavior.                     |
| renderer lifecycle | initial / reload / close                               | Port re-attach and reclamation.                      |
| client mode        | desktop-continuous / web-remote-replayable             | Delivery boundaries must not mix.                    |
| failure layer      | Host transport / attachment / workspace initialization | Whole-failure vs partial-failure boundary.           |
| auth               | password / private key / agent                         | remoteHostKey equivalence classes.                   |
| credential content | same / changed                                         | Secrets stay out of the key but affect reconnection. |
| provider revision  | same / independently failed                            | Applied state is per workspace.                      |

## Candidate combinations

| ID               | State                                                                                                                     | Event                                               | Expected guard/effect                                                                                                                                                                                                              | Status   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| SSH-HOST-POOL-01 | no Host                                                                                                                   | connect A then B, same window/key                   | one Host, two logical sessions/ports                                                                                                                                                                                               | accepted |
| SSH-HOST-POOL-02 | no Host                                                                                                                   | same key in different windows                       | one Host per window                                                                                                                                                                                                                | accepted |
| SSH-HOST-POOL-03 | no Host                                                                                                                   | two different keys in same window                   | two Hosts                                                                                                                                                                                                                          | accepted |
| SSH-HOST-POOL-04 | connecting                                                                                                                | concurrent same-key connects                        | share readiness promise and one spawn                                                                                                                                                                                              | accepted |
| SSH-HOST-POOL-05 | connecting, two waiters                                                                                                   | cancel one                                          | one waiter removed, Host continues                                                                                                                                                                                                 | accepted |
| SSH-HOST-POOL-06 | connecting, last waiter                                                                                                   | cancel                                              | Host disposed and deployment stops                                                                                                                                                                                                 | accepted |
| SSH-HOST-POOL-07 | ready, temp session                                                                                                       | cancel directory selection                          | session detached, Host cached                                                                                                                                                                                                      | accepted |
| SSH-HOST-POOL-08 | ready, two workspaces                                                                                                     | close A                                             | detach A only; B remains usable                                                                                                                                                                                                    | accepted |
| SSH-HOST-POOL-09 | ready, one workspace                                                                                                      | close last workspace, reopen same key               | Host stays idle and is reused                                                                                                                                                                                                      | accepted |
| SSH-HOST-POOL-10 | ready Hosts                                                                                                               | close window                                        | dispose all Hosts in that window                                                                                                                                                                                                   | accepted |
| SSH-HOST-POOL-11 | ready, two sessions                                                                                                       | renderer reload                                     | reattach two independent ports to same Host                                                                                                                                                                                        | accepted |
| SSH-HOST-POOL-12 | ready, two sessions                                                                                                       | Host/SSH exits                                      | both sessions close and tabs disconnect                                                                                                                                                                                            | accepted |
| SSH-HOST-POOL-13 | disconnected group                                                                                                        | reconnect A                                         | A and B restored through one new Host                                                                                                                                                                                              | accepted |
| SSH-HOST-POOL-14 | Host ready                                                                                                                | B provider/path init fails                          | A stays connected; B shows failure                                                                                                                                                                                                 | accepted |
| SSH-HOST-POOL-15 | shared Host, A/B                                                                                                          | phones attach A and B                               | same process, isolated sessions/identities                                                                                                                                                                                         | accepted |
| SSH-HOST-POOL-16 | session A bound to key A                                                                                                  | attach with identity B                              | reject identity mismatch                                                                                                                                                                                                           | accepted |
| SSH-HOST-POOL-17 | A/B registry sync                                                                                                         | same registry revision                              | applied state independently keyed                                                                                                                                                                                                  | accepted |
| SSH-HOST-POOL-18 | attached set changes                                                                                                      | bind/unbind workspace                               | TaskRealtime scope equals derived union                                                                                                                                                                                            | accepted |
| SSH-HOST-POOL-19 | WSL/Docker                                                                                                                | open multiple workspaces                            | existing session-per-host behavior                                                                                                                                                                                                 | accepted |
| SSH-HOST-POOL-20 | ready or reconnecting                                                                                                     | credential content changes                          | ready Host reused; new Host uses current credential                                                                                                                                                                                | accepted |
| SSH-HOST-POOL-21 | backend's first SFTP write/session fails                                                                                  | upload several resources in a row                   | the first resource falls back; later resources go straight to the exec pipe; exactly one degradation warn is logged                                                                                                                | accepted |
| SSH-HOST-POOL-22 | new session with the provider registry not yet synced                                                                     | sync workspace app-global state                     | skip the decision-free pre-probe; apply the registry first, then run one successful post-apply identity probe                                                                                                                      | accepted |
| SSH-HOST-POOL-23 | remote tab activated but services not yet registered                                                                      | renderer workspace side effects about to start      | state is `remote-waiting`; workspace RPC call counts for conversation, task-notification sessions-index, and MCP hydration are all 0, each starts exactly once after services register; local workspaces keep starting immediately | accepted |
| SSH-HOST-POOL-24 | several remote tabs share `workspacePath` but differ in `workspaceIdentity`; only one identity is bound to a live session | renderer resolves workspace services                | a tab with identity may only match an explicit `remoteSessionId` or an identity-exact mapping; when the exact mapping is missing it stays `remote-waiting` — borrowing another endpoint by path is forbidden                       | accepted |
| SSH-HOST-POOL-25 | a local tab and a remote tab share `workspacePath`; the remote path index is bound to a live session                      | renderer resolves the local workspace's services    | a local tab without remote metadata must use base services — borrowing the remote endpoint by path alone is forbidden                                                                                                              | accepted |
| SSH-HOST-POOL-26 | web remote entry carries a remote `workspaceIdentity`; the tab's `remoteSessionId` is not yet filled in or is stale       | renderer resolves the remote-control target session | identity must participate in exact resolution; the overlay only receives registered resolution results — passing through unvalidated sessions or borrowing another endpoint by path is forbidden                                   | accepted |

## Pruning decisions

| ID             | Pruned combination                         | Guard/invariant                                    | Reason                                    |
| -------------- | ------------------------------------------ | -------------------------------------------------- | ----------------------------------------- |
| SSH-POOL-PD-01 | same key across windows shares Host        | pool key includes window id                        | Window-scoped failure/lifecycle isolation |
| SSH-POOL-PD-02 | WSL/Docker use Host pool                   | remote kind must be SSH                            | Limit regression surface                  |
| SSH-POOL-PD-03 | all workspaces share one remoteSessionId   | session stays workspace-scoped                     | Preserve routing/cache/mobile semantics   |
| SSH-POOL-PD-04 | last session closes Host                   | ready Host survives zero binding                   | Faster workspace reopen                   |
| SSH-POOL-PD-05 | any workspace init failure rolls back Host | Host ready separates transport from workspace init | Avoid failure spread                      |
| SSH-POOL-PD-06 | persist Host/Profile identity              | Host pool is runtime-only                          | No config migration                       |
| SSH-POOL-PD-07 | app cold start auto-connect                | restored tabs remain disconnected                  | No background SSH                         |
| SSH-POOL-PD-08 | new disconnect UI                          | no UI in scope                                     | Focus on the process model                |
| SSH-POOL-PD-09 | mobile creates independent remote runtime  | shared-host attachment invariant                   | Relay/Main own no business runtime        |

## Accepted cases

| ID               | Setup                                                                                                  | Action                                                | Assertions                                                                                                                                                               | Status  |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| SSH-HOST-POOL-01 | same window, no Host                                                                                   | connect workspaces A/B with the same key sequentially | single fork; A/B sessionId and attachmentId differ; one remote server                                                                                                    | planned |
| SSH-HOST-POOL-04 | Host connecting                                                                                        | two concurrent connects                               | connect/deploy/handshake runs once                                                                                                                                       | planned |
| SSH-HOST-POOL-05 | two pending waiters                                                                                    | cancel one requestId                                  | the other still succeeds; Host not disposed                                                                                                                              | planned |
| SSH-HOST-POOL-06 | one pending waiter                                                                                     | cancel requestId                                      | connecting Host disposed; upload/deploy stops                                                                                                                            | planned |
| SSH-HOST-POOL-08 | A/B attached                                                                                           | close tab A                                           | Host detaches only A; B file/task RPC succeeds                                                                                                                           | planned |
| SSH-HOST-POOL-09 | last workspace attached                                                                                | close then reopen same-key workspace                  | Host PID unchanged; no new SSH handshake                                                                                                                                 | planned |
| SSH-HOST-POOL-11 | A/B attached                                                                                           | renderer reload                                       | A/B original remoteSessionIds re-attach to the same Host process                                                                                                         | planned |
| SSH-HOST-POOL-12 | A/B running                                                                                            | simulate SSH/backend close                            | two session-closed; both tabs clear remoteSessionId; pool entry deleted                                                                                                  | planned |
| SSH-HOST-POOL-13 | A/B disconnected, still open                                                                           | click reconnect on A                                  | one Host creation; A/B get new sessions; identities bound individually                                                                                                   | planned |
| SSH-HOST-POOL-14 | Host restored                                                                                          | inject B provider/path init failure                   | A connected; B failed; Host retained                                                                                                                                     | planned |
| SSH-HOST-POOL-15 | A/B attached, one Host                                                                                 | mobile opens A and B                                  | two shared-host attachments to one process; workspaceKeys do not cross                                                                                                   | planned |
| SSH-HOST-POOL-16 | session A bound to identity A                                                                          | mobile attaches A with identity B                     | identity mismatch returned; no port created                                                                                                                              | planned |
| SSH-HOST-POOL-17 | A/B share a provider snapshot                                                                          | update registry separately                            | both workspaceKeys record applied revisions; failures independent                                                                                                        | planned |
| SSH-HOST-POOL-18 | A attached, B attaches, A detaches                                                                     | update context                                        | realtime scope goes `{A}` → `{A,B}` → `{B}`                                                                                                                              | planned |
| SSH-HOST-POOL-22 | new remote session, no applied revision                                                                | sync provider registry                                | first operation is update; then exactly one successful identity probe                                                                                                    | covered |
| SSH-HOST-POOL-23 | remote tab with identity, no registered services                                                       | mount single/cross-workspace pane                     | data layer does not mount while waiting; mounts exactly once after registration+binding; local mounts immediately                                                        | covered |
| SSH-HOST-POOL-24 | 115, localhost, jumpserver remote tabs all at `/root`; only 115's identity bound to a live session     | resolve each tab's workspace services                 | 115 hits its own session; the other two stay remote-waiting and issue no sessions-index/provider/task RPC to 115's Host; legacy no-identity tabs still get path fallback | covered |
| SSH-HOST-POOL-25 | local `/root` and remote `/root` both open, path index points at the remote session                    | resolve the active local tab's workspace services     | returns the local/base route; never hits the remote session                                                                                                              | covered |
| SSH-HOST-POOL-26 | Web remote entry passes a localhost identity with a stale/missing session; the 115 path index is alive | open the remote-control overlay                       | resolver receives the localhost identity; the overlay only receives the resolver-validated session — never the stale or the 115 session                                  | covered |

## Matrix backfill

| File                                                         | Change                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `docs/architecture/zcode-code-architecture-overview.md`      | SSH Remote Host shared per remoteHostKey within a window.                                    |
| `docs/architecture/message-flow.md`                          | MessagePort and stdio flow from multiple workspaces to the shared Host/server.               |
| `docs/remote-workspace-session-unified-settings.md`          | Persisted workspace history separated from the runtime Host pool.                            |
| `docs/ssh-remote-app-global-state-authority.md`              | One Host, multiple workspaces: registry content same-source, applied state per workspaceKey. |
| `docs/web-remote-control/web-remote-control-architecture.md` | Multiple logical sessions attaching one SSH Host.                                            |
| `docs/web-remote-control/task-realtime-sync.md`              | Shared Host workspace scope is the derived union of attached sessions.                       |
| `docs/remote/desktop-remote-session-renderer-reattach.md`    | "session host" re-attach becomes "logical session attachment" re-attach.                     |

## Test design

### Shared unit tests

- Host case/whitespace/default-port normalization; username case kept, edges trimmed.
- Password/passphrase content changes do not change the key; different authKinds and privateKeyPaths produce different keys.
- Different alias names with identical effective fields produce the same key.

### Desktop Main unit tests

- SSH-HOST-POOL-01–13, 18, 19, 20.
- Stale Host exit does not delete a new entry; attachment failure reclaims only that session.
- Same key strictly isolated across windows; non-SSH keeps calling the legacy create/dispose path.

### Remote Host unit tests

- `InitRemoteSshHost` requires no workspace context or Renderer service port; ServiceCollection created once; multiple attachments expose the same collection.
- Detach releases exactly the target handle; unknown/repeat ids are idempotent.
- Host dispose releases all attachments, services, the realtime bridge, and the SSH connection.
- After the first SFTP session/write failure, later uploads on the same backend never call SFTP, with exactly one degradation warn.
- provider-not-ready RPC and Node warnings use the expected log levels, with no duplicate error.

### Renderer/UI unit tests

- Closing a remote tab calls detach session and does not dispose the Host.
- Open disconnected tabs with the same remoteHostKey form one recovery group; different keys/windows or closed workspaces do not.
- Partial batch-recovery failure keeps successful tabs.
- Provider Registry syncs per workspace session.
- Same-path different-endpoint tabs stay `remote-waiting` without an identity-exact mapping — no borrowing a connected endpoint by path; only legacy no-identity data gets path fallback.

### Web Remote Control unit tests

- SSH-HOST-POOL-15/16.
- Detaching a session releases only that session's mobile attachments; Host failure releases all mobile attachments under the Host.
- desktop-continuous and mobile-replayable deliveryKinds never substitute for each other.

### Service integration tests

- One remote ServiceCollection initializes independent Agents for two workspaceKeys.
- Provider registry applied revisions isolated per workspaceKey.
- task/session/file/terminal requests always use the workspacePath/workspaceIdentity from the call arguments.

### Real-runtime verification

With a real SSH macOS/Linux host: open two remote directories with one config in one window; confirm one local SSH Remote Host PID; one remote `zcode-server` with two workspaceKeys running independent Agents; both workspaces exercise file/Git/terminal/task/provider operations; closing one workspace leaves the other healthy with the same Host PID; closing the last and reopening does no new SSH handshake/server PID; killing SSH/server disconnects both; reconnecting one restores both through one new Host; mobile entering both workspaces shows no task/stream/permission cross-routing.

Repository checks: `pnpm typecheck`, `pnpm lint`.

## Risks and mitigations

| Risk                                   | Impact                                              | Mitigation                                                                       |
| -------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| One Host failure hits more workspaces  | same-config workspaces disconnect together          | Explicit Host failure domain; batch reconnect; no cross-window sharing           |
| Unreleased attachments                 | subscription/memory leak over a long idle Host life | attachmentId + DetachServicePort + dispose-all tests                             |
| session/context/Host index drift       | identity mix-ups, wrong scope                       | Three-fact-source model; workspaceKey/sessionIds/workspaceKeys derived on demand |
| Stale process callback                 | new Host wrongly reaped                             | Compare pool entry/process identity before deletion                              |
| Provider state wrongly shared          | workspace uses wrong model config                   | Applied revision and registry cache stay per workspaceKey                        |
| Mobile attachment escape               | cross-workspace task/data exposure                  | remoteSessionId + window + workspaceIdentity/workspaceKey quadruple validation   |
| Idle SSH holds resources               | connection lives while the window lives             | Confirmed UX choice; window close reclaims; no idle timeout this round           |
| workspace-scoped credential duplicates | multiple passwords for one config                   | Accepted this round; a separate SSH Profile design may come later                |

## Implementation notes

- `buildSshRemoteHostKey()` accepts both runtime SSH targets and persisted SSH snapshots; password snapshots derive auth kind from `passwordCredentialKey`, and secret content stays out of the key.
- The Renderer keeps the full target only inside the first-connect candidate-directory map or the reconnect call stack; Main's `RemoteServicePort`, the remote session store, and workspace tabs hold only sanitized targets, and temporary references drop once credential/history mutation completes.
- Canonical path and identity bind through the dedicated `BindRemoteWorkspaceSessionContext` IPC, validating that the session belongs to the requesting webContents; `syncWebRemoteControlWorkspaces` no longer doubles as the binding entry.
- Host attachments use an explicit `attachmentId`; desktop logical-session close/reload sends `DetachServicePort`, and mobile short attachments still trigger the same registry reclamation via MessagePort close.
- This design changes no task stream, snapshot, queue, permission, owner/lease, or deliveryKind protocol.
