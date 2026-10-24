# R3 Source Server unified remote main chain

## 1. Status and scope

- Status: implemented (code baseline `fad93b9e57`, 2026-09-13). Release validation and the real SSH E2E re-run are still in progress; see R3-ISSUE-001 / 020 in the [issue ledger](./r3-source-server-remote-open-issues.md). This document is the current-state spec. R3 process documents are archived under `docs/archive/remote-r3/`; the reading entry is [docs/remote/README.md](../remote/README.md).
- Model configuration semantics (§1/§2/§3.1/§6.2/§7.1/§8/§10/§11): the settings page binds to the local Environment and Provisioning pushes configuration one way, automatically (decided 2026-09-07 when Provider refactor M2 merged). Provider-side facts live in [Remote Provider Provisioning](../remote/provider-provisioning.md) and [SSH remote workspace state authority](../ssh-remote-app-global-state-authority.md); the merge record is [r3-provider-refactor-merge.md (archived)](../archive/remote-r3/r3-provider-refactor-merge.md).
- Phase: unified multi-device remote architecture R3 / D5–D11.
- Release: SSH, WSL and Docker switch to the new main chain in the same App version. No per-transport versioning or gray release. R3 keeps no runnable old remote main chain.
- Goal: introduce Source Server, `sourceServerId`, Connection Profile, Transport Adapter, Source authority, identity migration and version compatibility, so all three transports complete the product loop on the "window-level Local Host (R1) <-> resident ZCode Server daemon (R2)" chain.

Based on:

- ZCode unified multi-device remote connection architecture and product plan (internal review draft; defines D5–D11).
- [R1 window-level single Host refactor](./r1-single-window-host-refactor.md) (implemented; current architecture fact).
- [R2 standalone Server CLI and daemon](./r2-server-cli-and-daemon.md) (implemented; `verify-remote-ssh.mjs` is a minimal rehearsal of the R3 SSH transport).
- [R3 Source Server release test plan (historical, archived)](../archive/remote-r3/r3-source-server-release-test-plan.md): the stable IDs REMOTE-01–15 now live in [conversation-session-case-catalog.md](../conversation-session-case-catalog.md); the current execution plan is [r3-remote-automation-plan.md](../testing/r3-remote-automation-plan.md).
- [Remote workspace projection and persistence compatibility](./remote-domain-simplification-and-conversation-workspace-spec.md) (projection, open set, strict schema, remaining R4 work).
- [ZCode Lite / Server multi-server plan](./unified-zcode-lite-server-multi-server-plan.md) (target architecture background).
- [Remote Target abstraction](./remote-target-abstraction.md) (target/backend facts of the old chain).

R3 delivers:

- Remote domain model and protocol: `SourceServerRecord`, `ConnectionProfile`, `sourceServerId`, compatibility manifest, handshake/migration/sync schemas (D5).
- Transport framework with SSH, WSL and Docker adapters, responsible only for discovery, install, start and transport (D6).
- Stable `sourceServerId` handshake, Profile merging, Source write routing and identity migration (D7).
- A unified remote main chain: all three transports connect to the resident Server daemon; the "deploy a temporary stdio zcode-server" business chain is removed; old connection records and remote data are migrated (D8).
- Lifecycle and recovery: startup auto-reconnect, online-disconnect retry, offline probe, disconnected-data recovery, pending-request recovery (D9).
- Version compatibility and update: dual-side compatibility manifest, upgrade only the older side, full Server CLI remote update with re-handshake (D10).
- Multi-Source product surface: connection management page, flat project list with task source labels, non-blocking keep-running notice, full update interaction (D11). Model configuration and login no longer have a device selector or a "one-click sync" entry: Provider Provisioning pushes them one way on first connect / reconnect / successful local save, and the settings "Model settings" page always binds to the local Environment (route A; §8.2, §8.3).

R3 does not deliver:

- A Direct URL entry (`kind: "server"` stays a dev-only debug entry).
- Cross-network remote control, new Mobile capabilities, task-completion push (the existing phone QR attachment and replayable boundary must not regress).
- Phone-specific sandbox; Resource Store attachment protocol (the existing prompt-attachment-transfer contract stays).
- Automatic resume of running Tasks after Server/Agent crash; remote editing of model configuration, reverse (remote -> local) sync and a remote configuration UI (the remote is a disposable execution mirror of local configuration, §8.3); remote automation (cron stays a local workspace capability; the scheduler stays in the window Host).
- A Desktop Local Host and a same-machine standalone daemon sharing one data directory (explicitly unsupported).
- Removal of old-data migration compatibility code (left for R4 / D12).

## 2. Core decisions

| Decision | R3 conclusion |
| --- | --- |
| `sourceServerId` | The remote Server's `install.json.installationId` (R2: UUID, atomically generated, kept when uninstalling with data preserved, exposed as `/api/server-info.serverId`). No second identity system. |
| Identity boundary | `sourceServerId` means "Server environment + login account". Different OS accounts / WSL distros / containers have separate server roots and therefore different ids. Changing IP/domain/port/transport keeps the id. Official uninstall keeps user data and identity; reinstalling in place keeps the Source Server, Profile and projects. Only a connection target that is an independent data environment is confirmed as a new identity. Detecting duplicated ids from cloned data directories is out of scope. |
| Workspace identity | Controller identity is `remote:server:<sourceServerId>:<posixPath>` (reuses `buildServerRemoteWorkspaceIdentity`). Remote authority storage keys stay in the **old route-derived format, not rewritten**: each path gets one canonical key, and the new chain routes reads/writes to it (§3.2/§9.2). Server-local cleanup is left for R4. Route-derived keys are no longer generated on the controller; the Host sends them only as a hint for canonical election. |
| Topology | The Host opens a byte channel through a Transport Adapter to the remote loopback ingress, and runs the same HTTP+WS handshake chain as `kind:"server"` direct connect over it (server-info -> capability ticket -> `/ws/host`). `connectServerRemote` and `createServerRemoteWorkspaceServiceCollection` are the existing skeleton. |
| Adapter channel | SSH uses `ssh2 forwardOut` (direct-tcpip to the remote loopback dynamic port). WSL and Docker use a stdio bridge (internal command `zcode server proxy-stdio`). WSL host-localhost direct connect is out of phase one (smaller test matrix; later performance option). |
| Bootstrap base | Reuses the `detect/exec/upload` primitives of `IRemoteBackend` (SSH sftp, WSL UNC direct copy, docker cp). The old `deployServer` asset orchestration is retired. |
| Remote install | Upload the R2 six-platform release archive, run a local-archive install remotely (same immutable promote semantics as R2 update), then `serve --daemon`. First install and upgrade share one chain. |
| Daemon keep-alive | Every Transport first picks a start mode by remote capability: if a launchd / `systemd --user` manager is reachable, register an OS service (`serviceRegistered=true`); if the manager is missing, not running or the user session is unreachable, use a detached fallback (`serviceRegistered=false`). If probing succeeded but real registration fails, fail closed; a fallback must not mask permission, descriptor or system errors. Fallback persistence depends on the surrounding environment staying alive; after a restart the next automatic/manual connect re-runs `ensureDaemon`. |
| Ingress auth | A file token `run/ingress-token` (0600) under the server root. The Adapter reads it as the target user through the transport; every HTTP/WS request carries it. This upgrades the R2 "network location boundary" to an "OS user identity boundary". The R2 one-time host capability ticket stays on top of the token. |
| Version compatibility | Both sides generate a compatibility manifest `{schemaVersion, productVersion, minCompatibleVersion}`. The newer side's manifest judges the older side; only the older side is upgraded. R2 servers without a manifest are always "too old, upgrade". |
| Remote update | Desktop resolves and verifies the current Server release archive and runs `zcode update --from-archive` through Adapter `installOrUpdate(..., { force })` (reusing the R2 running-task guard, atomic switch and rollback). The target-version CLI must converge Supervisor/Core/Agent to the same immutable release before returning `applied:true`; it must not depend on a remote manifest URL. Re-handshake follows automatically. |
| Authority switch | The remote daemon runs as `standalone-server` authority (R2 Core already does). The `desktop-attached-remote` provider push chain is removed. Model Provider configuration is self-authoritative on the remote Environment (Core `createLocalServices({ providerProvisioningTargetEnabled: true, zcodeBuiltinProviderConfigFilePath })`); the local Personal Layer, Configured Default, narrow account settings and allowlisted credentials are **pushed one way automatically** by Provider Provisioning on first connect / reconnect / successful local save. The settings "Model settings" page always binds to the local Environment: no device selector, remote editing or manual one-click sync (§8.2/§8.3). |
| Service collection | All transports use the "full forward" mode (as `createServerRemoteWorkspaceServiceCollection` for the server transport). `LegacyRemoteWorkspaceRpcContract` is renamed to the versioned `RemoteWorkspaceRpcContract` and is part of handshake validation. |
| Connection record model | The `lastWorkspaceSession` "connection + workspace in one entity" is split into three: `SourceServerRecord` (created after handshake), `ConnectionProfile` (route + credential references), workspace open history (references the first two). Credential keys move from `remote-workspace:<workspaceKey>:*` to `connection-profile:<profileId>:*`. |
| Remote data migration | **No destructive key rewrite in R3.** The Server Core keeps a path -> canonical key alias layer, executed lazily per workspace open. Single-route history needs zero data change (old and new versions read/write the same rows; rollback and mixed connect work naturally). Only multi-route variant history is merged once into the canonical key (backup + ledger); failure blocks opening that workspace only, never the connection. R4 does the server-local cleanup. |
| Directory coexistence | Old-chain assets (`node`, `zcode-server.cjs`, `agents/`, `tools/`, `build/` loose files under `~/.zcode/server`) coexist with the R2 release layout. R3 install does not clean the old files (protects the rollback path of un-upgraded Desktops); cleanup is left for R4. |
| Auto reconnect | Startup tries all saved connections ordered by latest online, with no 7-day filter (concurrency and per-attempt budget: see the [current recovery contract](../remote/desktop-remote-session-renderer-reattach.md); one attempt each). Online disconnects retry at 2/4/8 s, 3 times. Offline sources are probed silently every 2 minutes. Only Profiles whose credentials are silently obtainable qualify; anything interactive (password not stored, incompatible version, migration failure) stays offline until the user acts. |
| Window model | Keeps R1 window-level isolation. Phase one is designed and accepted for a single (main) window; startup auto-reconnect runs in the main window Host. No multi-window product promise. |
| Remote automation | Not supported in phase one. Cron scheduling and run lifecycle live in the window Host process (`cronAutomationRepo` / `cronRunLifecycle`); moving them to Core needs a scheduler port, missed-run semantics and multi-Source management UI, which is independent and sizable. Daemon residency paves the way; the R3 architecture does not block it. |
| Gray release and rollback | Gray by App/user version; rollback = reinstall the old Desktop. With canonical keys, single-route users roll back at zero cost (remote data untouched); multi-route merges have backup + ledger (§9.3/§9.4). |

Invariants kept:

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`; path I/O keeps using `workspacePath`.
- Desktop `continuous` and phone Web `replayable` queues, seq, gap and recovery boundaries stay isolated; phone `/remote` only attaches to the existing window Host.
- Main and relay hold no business state. `remoteSessionId` is allocated by the Host and stays an in-window routing handle, never a global identity.
- The CLI is the authority for Session content and runtime state; the Supervisor holds no business state; Tasks interrupted by a crash/update are not auto-resumed.
- Secrets never enter logs, task events, snapshots or migration reports.

## 3. Domain model and identity

### 3.1 New shared types (D5, in `packages/shared/src/source-server/`)

```ts
/** Controller-persisted: one route that reaches a Server. */
interface ConnectionProfile {
  profileId: string; // UUID generated by the controller
  transport: "ssh" | "wsl" | "docker";
  target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget; // reuses existing snapshot fields (secrets are always credential-key references)
  sourceServerId?: string; // back-filled after the first successful handshake; shown standalone before that
  displayName?: string; // user-editable; defaults to host/alias/distro/container
  lastConnectedAt?: number;
  lastConnectError?: string;
  createdAt: number;
}

/** Controller-persisted: one recognized Source Server. */
interface SourceServerRecord {
  sourceServerId: string; // = remote install.json.installationId
  displayName: string; // default `${hostname} · ${osUser}`, user-editable
  osUser?: string;
  hostname?: string;
  lastSeenVersion?: string; // remote productVersion
  lastOnlineAt?: number; // basis of the startup silent-reconnect 7-day gate (§7.1)
  declaredWorkspaces?: Array<{ workspacePath: string; workspaceIdentity: string; label?: string }>; // remote known directories, replaced on handshake, <=20 (§8.4.1)
  preferredProfileId?: string; // user-chosen default route; otherwise the latest successful one
}

/** Controller-persisted: workspace open history; stable identity and rollback hint stored separately. */
interface SourceServerWorkspaceHistoryEntry {
  workspacePath: string;
  workspaceIdentity?: string;
  legacyWorkspaceIdentity?: string;
  profileId: string;
  sourceServerId?: string;
  lastOpenedAt: number;
}

/** Cross-Environment model-config push is not defined here: Envelope / Result / Trigger schemas are in
 *  packages/shared/src/provider-provisioning.ts, semantics in docs/remote/provider-provisioning.md. */

interface SourceServerResolveWorkspaceRequest {
  workspacePath: string;
  legacyRouteHint?: string;
}

interface SourceServerResolveWorkspaceResult {
  canonicalWorkspaceKey: string;
  mergedKeys: string[];
  migrationId?: string;
}

/** Compatibility manifest embedded in both builds. */
interface CompatibilityManifest {
  schemaVersion: 1;
  productVersion: string; // = ZCODE_VERSION
  minCompatibleVersion: string;
}
```

All of these have strict zod schemas (`.strict()`) in the `packages/shared/src/validation*` system with contract tests. The `ssh/wsl/docker` connection parameter shapes of `RemoteTarget` are unchanged and remain the Adapter input. Model-config push uses `ProviderProvisioningEnvelope` (Personal Layer + Configured Default + narrow account settings + allowlisted credentials); its fields and transaction semantics follow [Remote Provider Provisioning](../remote/provider-provisioning.md); R3 defines no sync snapshot type of its own.

<a id="保留数据的卸载重装2026-10-10"></a>

### Uninstall and reinstall with data preserved (2026-10-10)

`sourceServerId` denotes the remote persistent user-data environment and keeps `install.json.installationId` as its only source. Official `uninstall` removes runtime assets and keeps user data and `install.json`; reinstalling reuses the same UUID. The App does not start an identity generation change, archive the Profile, or add a device or project; original tasks stay visible and usable. Normal updates and reinstalls with data preserved never change workspace identity; the temporary `remoteSessionId` may be reallocated.

```text
original device / Profile / project / history
  -> uninstall: keep data and install.json, write uninstalled.json to forbid start
  -> archive install done: clear the uninstall marker; handshake still returns the original sourceServerId
  -> reuse the original device, Profile and project; open the original task and continue chatting
```

When the same route actually reaches an independent data environment, it still goes through identity confirmation as a different UUID: cancel changes no record; confirm creates a new device and independent Profile, archives the original connection and keeps the original project identity. Tests must replace the whole data environment, not just the UUID while sharing a history DB. Identity-change copy describes a changed connection target and must not describe a data-preserving reinstall as a new device. This version is not released yet, so there is no recovery for lost legacy identity and no merging of historically duplicated devices. Data cloning keeps the §2 scope limit.

### 3.2 Three-layer workspace identity

Problem: the old identity `remote:ssh:<host>:<port>:<user>:<path>` encodes the route (`packages/shared/src/remote-workspace-identity.ts`); changing IP/alias creates a new key and loses history, and the same directory reached through several routes leaves several parallel histories in the two remote databases (`~/.zcode/v2/tasks-index.sqlite`, `~/.zcode/cli/db/db.sqlite`).

R3 identity has three layers. Trade-off: **controller identity is fully route-independent; the remote storage key keeps the old format (canonical key) during the migration window, so an old-version Desktop rolling back or connecting mixed reads/writes the same data**; server-local cleanup of the storage key waits for R4 (after old versions leave the support window).

```text
Controller (Host / Renderer / phone bridge / credential key / tab dedupe)
  workspaceIdentity = remote:server:<sourceServerId>:<posixPath>   <- route independent, unchanged by route change
  workspaceKey      = workspaceIdentity
        |
        |  wire: the Host sends { workspacePath, legacyRouteHint? }
        |        legacyRouteHint = old-format key built for the current route (canonical election only, removed in R4)
        v
Remote Server Core (single mapping point: workspace locator layer)
  canonical key resolution: path --alias table--> canonical key (old route-derived format)
        |
        v
Remote authority storage (Server Core / Agent CLI / SQLite / sessions/<hash>/ config dir)
  workspaceKey = canonical key (R3 migration window) --R4--> server-local path
```

- The controller format reuses `buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath })`. `isRemoteWorkspaceIdentity`, the phone chain carrying `workspaceIdentity + remoteSessionId`, and realtime `workspaceKey + taskId` routing keep their semantics; only the value changes.
- Changing route does not change controller identity; the remote alias layer converges any route to the same canonical key, hence the same history (REMOTE-09).
- Different OS accounts -> different server roots -> different `sourceServerId`, and the remote databases already belong to different accounts -> strict isolation (REMOTE-10).
- The canonical key is the old format, so an old-version Desktop (old chain) reads/writes **the same task rows and session rows** by the old key: after rollback existing conversations are visible and can continue (messages/parts are linked by `session_id`, visible both ways); the `sessions/<hash>` config dir hash is unchanged. Compatibility does not depend on old code understanding any new concept.
- A TUI on the remote machine opening the same directory still uses the path key and does not share remote history yet (same as old versions; unified at R4 cleanup).
- Before opening a workspace the remote `fileService.resolvePath` still does a realpath, so symlink aliases do not create two identities.
- The Renderer no longer builds formal identity from an SSH/WSL/Docker target. `bindRemoteWorkspaceSessionContext` returns the authoritative `{ sourceServerId, workspacePath, workspaceIdentity }` only after the Host finished canonical preparation and the new attachment is ready; tabs, history, credentials and reconnect matching all consume that return value. Route-derived identity is only the Host-internal `legacyRouteHint` and never goes back to the Renderer or phone.

Core mapping seam:

- `source-server-workspace.resolveWorkspace` resolves the alias remotely and registers `remote:server:<sourceServerId>:<workspacePath> <-> canonical key` in a Core in-memory map.
- Ordinary RPC values are mapped in the remote Core `IChannelServer` decorator layer: workspace identity values in call arguments, return values and listen events of every business channel are replaced at value level.
- V4 topic logical frames are an exception: the Source Server internal CLI wire may already be JSON + CRC32 + base64 fragmented by canonical identity, so the fragment outer object must not be edited alone. Within the existing bounded budget (16 MiB / 1,024 fragments), the Core outward seam first reassembles the internal logical frame, maps the topic, `snapshot.workspaceId` and `session.workspaceId`, then re-encodes JSON/CRC32/fragments into the outward stable wire. Any checksum/schema/limit failure stays fail-closed; no partial apply.
- The conversation, sessions-index and workspace-config V4 topics share this physical fragment seam. When the assembler returns both fault and complete in one batch, handle each. A fault or re-encode failure may only send a typed recovery candidate without the canonical payload to the controller; never pass the raw base64 through, and never let an exception escape the event listener and close the whole CLI runtime.
- Unfragmented mapped strings are of two kinds: (1) the whole value equals an identity; (2) registered protocol composite values `sessions-index/<identity>` and `workspace-config/<identity>`. Composites must be parsed and rebuilt with the matching parser/builder codec; generic substring replace is forbidden (it would corrupt paths, logs and user text). A new composite identity string requires updating this section and the codec contract tests first.
- Binary, `Date`, `ArrayBuffer`, typed arrays and other non-plain objects pass through unchanged; the mapper must not deep-copy arbitrary objects via `Object.entries`.
- `source-server-workspace` itself is not mapped and still returns the real canonical key for migration diagnostics. The Desktop Host does not store or consume the canonical key and no longer wraps `IServiceAccessor`.
- The seam ensures R4 cleanup only replaces the remote mapping implementation, with no Desktop/Renderer/phone release needed.

### 3.3 Task address

```ts
interface WindowHostTaskAddress {
  sourceServerId?: string; // new: stable identity of the remote source (absent for local tasks)
  remoteSessionId?: string; // kept: in-window connection handle (changes on reconnect)
  workspacePath: string;
  workspaceIdentity?: string; // controller identity (remote:server:...)
  taskId: string;
}
```

Controller writes (pin/archive/delete/open/resume) locate the single source by `sourceServerId + workspaceKey + taskId`; `remoteSessionId` only routes the request to the current in-window active connection. After reconnect `remoteSessionId` changes generation while the stable triple stays; the R1 `replaceDisconnectedSource` atomic replacement semantics are unchanged.

## 4. Process and connection topology

Before (old remote chain after R1):

```text
Window Host (R1)
├─ LocalSource ── stdio ── local zcode-cli
└─ RemoteConnectionRegistry
   ├─ SSH entry ─ ssh2 exec ─ deployServer deploys loose assets ─ start foreground stdio zcode-server (entry-stdio)
   │                               version must be strictly equal   │ SERVICE_AUTHORITY_MODE=desktop-attached-remote
   │                                                                └─ remote Agent CLI (exits with connection EOF)
   ├─ WSL entry ─ wsl.exe ─ same as above (60s idle TTL)
   ├─ Docker entry ─ docker exec ─ same as above (per-session dedicated)
   └─ Server entry ─ HTTP+WS ─ already-running zcode-server /ws/host (dev-only)
identity = remote:ssh:<host>:<port>:<user>:<path> (route-derived)
model config = Desktop push overrides remote
```

After R3:

```text
Window Host (R3)
├─ LocalSource ── stdio ── local zcode-cli (unchanged)
└─ SourceServerConnectionManager (evolution of RemoteConnectionRegistry)
   ├─ ServerDirectory (app-level persistent read/write: SourceServerRecord + ConnectionProfile)
   ├─ one window-level connection per online Source Server
   │  ├─ TransportAdapter(ssh|wsl|docker)
   │  │  ├─ bootstrap: probe -> (after confirmation) install/update -> ensure daemon -> read port/token
   │  │  └─ channel: Duplex byte channel -> remote 127.0.0.1:<dynamic port>
   │  ├─ handshake: /api/server-info (version compatibility + migration gate) -> ticket -> WS /ws/host
   │  └─ @zcode/rpc service collection (full forward) + multiple logical remote sessions (remoteSessionId)
   │                         │
   │                         ▼
   │              remote ZCode Server daemon (R2)
   │              OS service / detached ── Supervisor ── Server Core ── Workspace Agent CLI
   │              Desktop disconnect only releases the attachment; daemon and tasks keep running
   └─ ControllerProjection (source dimension = sourceServerId)
```

Closing a window / quitting the App only drops the attachment and transport channel and never stops the remote daemon (REMOTE-03). When several windows/Desktops connect to one Server, Core supports multiple attachments independently.

## 5. Transport Adapter contract (D6)

### 5.1 Interface

```ts
interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";

  /** Probe the remote environment and Server CLI install state; no writes. */
  probe(target: RemoteTarget, ctx: TransportContext): Promise<SourceServerProbeResult>;

  /** Upload the release archive and install/upgrade with local-archive semantics; progress is reported structurally via RemoteWorkspaceConnectionLog. */
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    ctx: TransportContext,
    options?: { force?: boolean },
  ): Promise<void>;

  /** Ensure the daemon runs (serve --daemon; service or detached fallback by remote service-manager capability); return ingress port and token. */
  ensureDaemon(target: RemoteTarget, ctx): Promise<SourceServerIngressInfo>;

  /** Open a Duplex byte channel to the remote loopback ingress; HTTP/WS run on top. */
  openChannel(target: RemoteTarget, ingress: SourceServerIngressInfo, ctx): Promise<Duplex>;

  /** Run remote management commands (status/update/migrate retry/uninstall, always --json). */
  exec(target: RemoteTarget, argv: string[], ctx): Promise<RemoteExecResult>;
}

interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installedVersion?: string; // bin/zcode --version
  daemonStatus?: PersistedServerStatus; // status.json read result (valid/missing/invalid)
}

interface SourceServerIngressInfo {
  port: number; // dynamic port from status.json
  ingressToken: string; // run/ingress-token content (memory only, never in controller logs/persistence)
}
```

Transport independence (REMOTE-15): handshake, service collection, identity, lifecycle and error semantics above the Adapter are identical. Contract tests run one case set against fake/real implementations of all three Adapters; no `kind`-specific business branch may leak above the Manager layer.

Remote platform support is unchanged: all three transports require a POSIX remote (linux/darwin); win32 remotes stay rejected (`assertSupportedRemoteEnvironment` semantics). The R2 win32 assets only serve "manually install Server CLI locally" and are not part of the R3 remote matrix.

### 5.2 Three implementations

| Capability | SSH | WSL | Docker |
| --- | --- | --- | --- |
| Base | existing `SSHBackend` (ssh2; exec forces `/bin/sh`) | existing `WSLBackend` (wsl.exe -d distro -u user) | existing `DockerBackend` (docker exec -i) |
| probe/exec | `client.exec` | `spawn wsl.exe` | `spawn docker exec` |
| Upload | SFTP, falls back to a `cat >` pipe | `\\wsl.localhost\` UNC direct copy, falls back to streaming | `docker cp`, falls back to `cat >` |
| channel | `client.forwardOut` -> remote `127.0.0.1:<port>` (direct-tcpip, uses no exec channel); when sshd disables forwarding (`AllowTcpForwarding no`) falls back to the stdio bridge (the same proxy-stdio command over an exec channel) | stdio bridge (`wsl.exe -d <distro> -u <user> --exec bash -lc '<serverRoot>/bin/zcode server proxy-stdio --server-root <serverRoot>'`; must be `--exec`, because `--` lets the default shell expand the command early, see R3-ISSUE-024) | `docker exec -i <c> <serverRoot>/bin/zcode server proxy-stdio` (stdio bridge) |
| Daemon residency | `serve --daemon` prefers launchd/systemd --user registration; when the service manager is unreachable, detached fallback, restarted by the next connect | detached fallback; if an accessible service manager appears later it consumes the same capability-probe contract | detached fallback; exits when the container stops |
| Connection reuse | one ssh2 Client per `buildSshRemoteHostKey` (exec/sftp/forwardOut channels multiplexed) | wsl.exe call context reused by normalized distro+user | reused per container |

- `zcode server proxy-stdio` (new internal subcommand): reads this root's `status.json` port and does pure byte forwarding between stdin/stdout and `127.0.0.1:<port>`; if the daemon is not running it prints one structured error line and exits. It does not call `createLocalServices` and holds no business state.
- The Host runs HTTP requests and WS upgrades over any Duplex (`http.request` / `ws` accept a custom `createConnection`); SSH forwardOut streams and stdio-bridge streams use identical upper-layer code.
- The old chain's WSL 60 s idle TTL and Docker per-session dedicated lifecycle differences are removed: connection lifecycle is uniformly "window-level connection <-> resident daemon"; workspace runtime start/stop is fully managed by the remote Core.
- Docker Backend direct exec and home-relative path reads validate the container reference before calling the CLI: after trimming it must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$` (names, full IDs and ID prefixes accepted). Invalid references are rejected explicitly, with no container enumeration or extra CLI round trip.
- R1 registry mechanisms (generation, fail-closed, two-phase attachment generation change) are kept as is.

Daemon start capability decision:

```text
serve --daemon
  ├─ explicit opt-out (WSL/Docker) ─────────────────────► detached fallback
  └─ default path
       ├─ OS user service manager unreachable ──────────► detached fallback
       │    Linux non-interactive SSH first tries /run/user/<uid>/bus
       │    and restores XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
       └─ service manager reachable
            ├─ register/start succeeds ─────────────────► OS service
            └─ register/start fails ────────────────────► fail-closed (no fallback)
```

- "Service manager unreachable" is a capability fact, not an install failure: typical for SSH into containers, minimal systems, no running user manager, or a macOS SSH session without an accessible launchd user domain.
- Automatic fallback does not change Source/Task/Session authority; Desktop disconnect only releases the attachment. A fallback process keeps running while the remote environment lives; after a host/container restart the startup reconnect or a manual connect restarts it.
- On Linux SSH, if `/run/user/<uid>/bus` exists, use that user bus for service probing and registration even when sshd did not inject `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`; missing env vars must not be misread as "no systemd".
- Linux capability probing reads `systemctl --user show --property=Version`; the user manager is accessible only when the exit code is 0 and a non-empty `Version` property is returned. chroot / offline environments may skip the command and return 0; a result without the property response must go to the existing detached fallback, never rely on localized stderr text, and never override the user's offline-environment settings.
- Capability probing keeps a 2 s process timeout. After the command is killed by a signal, the executor must close the local stdout/stderr pipes and return failure instead of waiting for a D-Bus helper holding the pipes; a normal exit still waits for `close` to read the full response. This does not change service-registration error propagation and adds no start path.
- Real registration errors after a successful probe are returned as is; permission, service-file or start errors must not be swallowed. The daemon start owner stays the Server CLI choosing between OS service and detached Supervisor; no retry, state cache or parallel start path is added.
- On non-zero exit of `serve --daemon --json`, the Adapter first parses the structured `{ error, code?, retryable? }` on stdout and then uses stderr as supplementary diagnostics. Node warnings, login banners or shell noise must not override the real CLI error.
- A Server CLI `--json` result (success or failure) is the last single-line JSON object on stdout; the Adapter skips plain-text lines before and after it. Some SSH bastions merge remote stderr into stdout and deliver it after stdout ends, so a Node warning may follow the result line; the last non-empty line must not be taken as the result.
- The Source Server bootstrap executable lives in a temporary staging under the final executable root (`~/.zcode/server`), not in the often-`noexec` `/tmp`. Temporary archive files are still cleaned up on success, failure and cancel.
- Remote direct download requires only curl/wget, tar and a SHA-256 tool; awk/wc/date only enrich progress and degrade to speed-less progress when missing. Desktop download-then-upload must likewise probe tar before uploading, so a large archive is not uploaded before failing.
- The archive embeds the official Node 22 Linux build, which dynamically links glibc 2.28 or newer. Probe reads `getconf GNU_LIBC_VERSION` in the same read-only round trip. On a Linux remote (including WSL and Docker) below 2.28 (for example CentOS 7, RHEL 7, Ubuntu 18.04), probe fails the pre-check before install confirmation, upload or remote direct download, with the measured and required versions in the message. If the glibc version cannot be read (musl, missing getconf, unrecognized output), do not block; continue the normal install chain.
- When building the POSIX archive on macOS, bsdtar xattr/PAX metadata must be disabled explicitly; `COPYFILE_DISABLE=1` alone does not remove `LIBARCHIVE.xattr.*`, and Linux extraction would print thousands of "unknown extended header" lines that hide the real error.

### 5.3 Discovery, install and upgrade chain

```text
probe -- installed and daemon ready --------------------------> ensureDaemon (reuse)
  │
  ├─ not installed -> show target account/version/install location, user confirms -> upload archive (platform-matching R2 release)
  │                                                        └─> remote local-archive install (immutable promote)
  │                                                              └─> serve --daemon --> ready
  └─ installed but version incompatible -> §6.3 upgrade flow (same install/update chain)
```

- Release source: the existing remote asset distribution mode (CDN manifest + local cache + `assetInstallMode` remote-download option). Assets change from loose files to four platform archives `zcode-server-<os>-<arch>.tar.gz` (`linux/darwin x x64/arm64`). The version root must also publish an independent `source-server-release.json` that records, per target, `version`, `fileName`, `sha256`, `sizeBytes` and relative `urls`. Desktop and remote direct download must consume the same descriptor and verify SHA-256 before install. The Windows stage may still produce `.zip` for R2 local validation, but R3 remotes reject win32 and it is not part of the Desktop Source Server resolver's release contract.
- Official `build:remote-assets` only runs the Server CLI stage for the four targets, copies the descriptor/archives into the current version's release root and uploads them. R3 no longer builds or publishes legacy `manifest-*.json` / `components/**`. CI validates file by file, fail-closed, before copy and upload; the `dist-release` cache of a development worktree is not release evidence. Legacy objects of already published versions stay on CDN/OSS; removing the build entry of the new version must not delete historical objects.
- `assetInstallMode` only decides which side fetches the archive: `local-download-upload` = Desktop downloads, verifies and uploads through the Backend; `remote-download` = the SSH target downloads with descriptor URLs and verifies. From the remote temporary archive onward both paths merge into the same `zcode update --from-archive`; the old loose-component installer must not return.
- Remote entry: `zcode update --from-archive <path> --json` (R2 update gains a local archive source; on first install the archive is unpacked first to bootstrap `bin/zcode`). Install, upgrade, component cache, atomic switch and rollback all reuse the R2-verified release semantics; the Adapter has no second install logic.
- First install immediately runs `serve --daemon`: with an accessible OS user service manager it returns `serviceRegistered=true`; otherwise it falls back to detached and returns `false`, and the connection log states "stays resident while the remote environment lives; restarted by the connection after a reboot".
- Source Server deployment strategy explicitly distinguishes `release-versioned` and `development-content-addressed`; they differ only in the "needs update" decision. Packaged Desktop always uses the former and judges by version compatibility only. Unpackaged development SSH uses the latter: needs update when the Server version equals the current archive version but `archiveSha256` differs or the remote identity is missing; the same SHA is reused. This decision must not spread to production or to WSL/Docker.
- After "needs update" is decided, both strategies behave identically. The connection flow only sets the Profile to `needs-upgrade + updateAvailability: required` and rejects with `source-server-upgrade-required`; it never runs an archive update inside the connection flow. The update runs through §6.3 `updateSource -> Manager.updateServer` (`updating` state, operation log, `force:false` first, running-task guard, then explicit user confirmation and `force:true`). So the in-wizard auto update, the "Update now" entry of startup reconnect / disconnect recovery and the forced-update confirmation also work in development mode.
- Development content refresh accepts only the local staging descriptor/archive of the current round and always uploads through Desktop; even if the SSH Profile stored `remote-download` it must not fetch the same-version artifact from CDN. If the local artifact is missing, verification fails or the update is blocked by the running-task guard, the connection fails closed; no CDN fallback, no continuing on the old release.
- Development `bootstrap:with-remote` must call the same Source Server staging entry as CI and refresh descriptor/archives; plain `bootstrap` still skips remote assets. A successful return means all repository-source-derived runtime, plugins and archives were built in this round; only pinned, verified external binaries may reuse caches. Staging first invalidates the old descriptor, atomically writes all four platform archives and verifies them, then atomically publishes the new descriptor; a failure must not leave an old generation consumable by development connections. The Linux dev entry `prepare:remote-assets:linux` shares this path, builds and publishes only `linux-x64` / `linux-arm64`, and lists only this round's targets in the descriptor (no historical macOS entries); environment and usage are in [Bootstrap commands](../bootstrap.md).
- Old-chain loose files under remote `~/.zcode/server` (`node`, `zcode-server.cjs`, `agents/`, `build/`, `tools/`) share the directory with the R2 layout. R3 install does **not** delete them, because un-upgraded old Desktops still run the old chain on them; cleanup belongs to R4. The R2 uninstall allowlist must list these old paths so that `zcode uninstall` after R3 removes them and records `preservedPaths` for reconciliation.

## 6. Handshake, authentication and version compatibility

### 6.1 Ingress authentication (closes the R2 security gap)

R2 loopback-only is a network-location boundary: on a multi-user server any local process can reach `/ws` and the capability issuing endpoint. The R3 tunnel exposes this port to "any ZCode user who can reach the machine", so it must be tightened first:

- At start the daemon writes a random token to `<serverRoot>/run/ingress-token` (0600, rotated on every daemon start).
- Core ingress requires `authorization: Bearer <token>` (or `?token=`, the carrying style the server-transport client already implements) for all of `/api/*`, `/ws`, `/ws/host`. `/api/server-info` may return anonymously a degraded form containing **only version and compatibility fields**, for upgrade prompts.
- During bootstrap the Adapter reads the file as the target user through the transport; being able to read a 0600 file proves the caller is the same OS user, so the boundary moves from "network location" to "OS user identity".
- The token lives only in Host memory, never in controller persistence or logs; on WS reconnect the file is re-read (the token rotated after a daemon restart).
- The one-time host capability ticket (30 s TTL, deleted on consume) stays as the second gate for `/ws/host`, semantics unchanged.
- `server-info.authRequired` changes from hard-coded `false` to truthfully reflect the token requirement.

### 6.2 Handshake sequence

```text
Adapter                                    remote daemon (Server Core)
  │ probe: exec bin/zcode status --json / read status.json
  │ ensureDaemon: serve --daemon (if needed)
  │ read run/ingress-token (0600)
  │ openChannel == Duplex -> 127.0.0.1:<port> ============╗
  │                                                        ║
  │ GET /api/server-info (Bearer token) ──────────────────►║
  │ <── { serverId, version, compatibility{min...}, migration{failedPathCount}, identity{osUser,hostname}, ... }
  │
  │ (1) version compatibility (newer side's manifest, §6.3) -> incompatible stops at needs-upgrade
  │ (2) Profile.sourceServerId back-fill/check: mismatch with an existing record -> treat as a new Source Server and prompt
  │
  │ POST /api/rpc-host-capability (Bearer token) -> ticket
  │ WS /ws/host + ticket + token ─────────────────────────►║ desktop-continuous / trusted-host-relay
  │ assertRemoteWorkspaceRpcContract (channel completeness)
  │ -> Main: ProviderProvisioningEnvironmentCoordinator.register(...).initialSync
  │   (first-connect barrier, §8.3.2: only applied/already-applied publishes ready; failed/rollback_failed/unsupported fail the connection)
  │ -> online: register the Controller source, read authoritative task facts
  │
  │ (canonical key resolution/merge is not part of the handshake: it runs lazily per workspace open,
  │  failure only blocks opening that workspace, §9.2; migration.failedPathCount only gives the connection page a report entry)
```

`/api/server-info` extension (all new fields optional, `protocolVersion` stays 1):

```ts
interface ServerRemoteInfo {
  serverId: string; // = installationId = sourceServerId
  version: string;
  protocolVersion: 1;
  authRequired: boolean;
  compatibility?: CompatibilityManifest; // always present from R3; missing => pre-R3, needs upgrade
  migration?: { failedPathCount: number }; // count of workspaces whose multi-route merge failed; display only, never blocks connect
  identity?: { osUser: string; hostname: string };
  capabilities: { desktopContinuous: true; websocketRpc: true };
}
```

The Server self-validates its output with a strict schema; Desktop/the controller ignores unknown fields when parsing wire input, so new optional fields under `protocolVersion=1` do not break old clients. The anonymous server-info uses a separate schema that exposes only `version/protocolVersion/authRequired/compatibility`; do not force it into the full handshake schema.

<a id="63-版本兼容与远端更新d10"></a>

### 6.3 Version compatibility and remote update (D10)

- Desktop builds and Server CLI release archives each embed a `CompatibilityManifest`. Rule: take the end with the newer `productVersion` and use its `minCompatibleVersion` to judge the older end. Compatible but different versions -> after a successful connect show one non-blocking "update available" prompt once, and keep an update entry on the Source management page. Incompatible -> block the business connection and show current version / minimum version / which end must upgrade.
- Server older: when the user explicitly clicks connect, the wizard automatically starts one protected `force:false` update. With no running Task it updates directly and continues the original connect intent; only on a running-task guard does it ask the user whether to force-interrupt. Startup reconnect, disconnect recovery and offline probe stay at `needs-upgrade` and offer only "Update now"; they never update silently or pop a confirmation. The upgrade command is addressed by `profileId + target` and does not need a prior handshake yielding `sourceServerId`; Desktop resolves the current release archive and calls Adapter `installOrUpdate`, so pre-R3 servers can upgrade before the handshake. With running Tasks it returns the guard error by default and waits; only an explicit user choice forces. **Update is an explicit orchestrated operation**: the connection enters `updating` and suspends passive disconnect retry; after completion it re-handshakes and back-fills `sourceServerId`; failure shows the reason and retry; it does not rely on §7 passive probing.
- The Host state snapshot is the single authority for version judgement and always carries `updateAvailability: none | available | required`, `currentVersion`, `availableVersion`, `minimumVersion`, `upgradeTarget`, `errorCode`, `retryable`. The Renderer does not compare versions itself.
- A `source-server-upgrade-required` connection failure keeps the `profileId` the Host actually used, validated by the strict Host response schema and passed through Main. It identifies only the failed route; upgrade eligibility still reads the latest Host snapshot; no credentials, no new persisted state. After WSL parameter normalization the wizard continues update and reconnect with that route's actual target, so a default user differing from the raw UI parameters cannot make the upgrade entry a no-op.
- Auto upgrade is bound to the immutable target identity at failure time; `profileId` only identifies the editable record. WSL upgrade failures and install waits return the `resolvedWslTarget` resolved for that attempt. The wizard first checks the latest Profile target, then submits `updateSource({ profileId, expectedTarget, force })`; `expectedTarget` contains only SSH address/port/user/config alias, WSL actual distro/user, or Docker container, never credentials.
- The Host strictly validates `expectedTarget` at runtime and compares the current Profile with the resolved target. The update uses the fixed target resolved from the same Profile snapshot (never re-fetch by ID after validation). On mismatch it returns `remote-target-changed`, does not probe/install/reconnect, the UI ends the old upgrade and shows an explicit retry. Force confirmation keeps the original identity. The old management entry without `expectedTarget` stays compatible. Desktop continuous / phone replayable and the remote task owner are unchanged.

```text
failed target A -> UI checks latest Profile -> expectedTarget=A -> Host validates and pins A -> update
                    changed to B -refused-┘           changed to B -refused-┘
Host pinned A -> later Profile edit to B -> the in-flight operation still uses only A
```

- `source-server-install-required` likewise keeps the actual `profileId`. WSL install failure responses also carry a strictly validated `resolvedWslTarget: { kind: "wsl", distro, user }` with both identity fields non-empty and no credentials. It comes from the resolved target of this Host connect request, independent of the optional install preview; when the preview is unavailable the same target can still be confirmed. The field is preserved through Main, the platform and the original-project failure hand-off, without changing discovery cache, persistence, install authorization or the desktop/phone transport boundary.
- Public error codes are registered in `@zcode/shared` and consumed by CLI/Host: the running-task guard uses `source-server-update-running-tasks` (`retryable:false`, user may explicitly `force`); compatibility block uses `source-server-upgrade-required`; workspace migration and bind cancel must not keep their own allowlists either.
- Connection/deploy failures are classified in shared: connection refused/unreachable, timeout, host not found, explicit SSH host-key verification failure, download, upload, pre-check, install, remote space/permission, cancel and unknown all have public codes. AggregateError reads the inner code, empty messages get a non-empty fallback, and a Host failure response must not hang because of schema rejection. The UI maps zh/en copy; unknown codes show generic text.
- User-visible logs receive only explicit pipeline progress; Host console and other services' diagnostics are not forwarded. Absolute paths, tokens, credential references and device identifiers are redacted uniformly; waiting for install confirmation is `info`. Connection feedback pre-fills this log and does not upload the full diagnostic file by default.
- Redacted credential fields in connection logs also cover `apiKey` / `api_key` / `api-key`, `secret`, Authorization and Cookie / Set-Cookie; Bearer and Basic credentials are both masked. Ordinary Authorization/Cookie header values are covered to end of line; quoted structured keys are filtered as complete escaped strings; repeated filtering is idempotent and later log lines are kept.
- The Server CLI natively provides `version --json` / `--version`; version output must not be delegated to the Agent `zcode.cjs`. When probing a pre-R3 install, a unique valid semver may be extracted from old text output; when compatibility cannot be proven, conservatively enter `needs-upgrade`.
- Desktop older: only prompt to upgrade Desktop; never downgrade the Server.
- R2 servers (no compatibility field) are judged too old and take the same upgrade chain; the R3 Desktop `minCompatibleVersion` is the first Server version that carries the R3 handshake contract.
- The current release does not declare a `zcodeCompatibility` override in the root `package.json`; Desktop and Server CLI builds fall back a missing `minCompatibleVersion` to the current `productVersion`, so by default only same-version compatibility is promised. A lower `zcodeCompatibility.minCompatibleVersion` may be declared only after cross-version contract and release validation.
- When the Server is older and must upgrade, the startup reconnect prompt, the connection-wizard failure panel and the connection management page must all offer an in-place "Update now", submitted uniformly to `SourceServerManagementService.updateSource`; users must not have to find a single entry in Settings. When Desktop is older it still only points to a Desktop upgrade and shows no Server update action.
- The Source Server update Toast on startup / task-list reconnect has its own display variant: top centered, device and version text fully wrapped, full "Update now" and a close entry. It serves only Source Server and does not change the position and truncation rules of existing compact update Toasts such as the Desktop app update.
- Once the connection wizard takes over a target, that target's Server upgrade prompt is shown by the wizard and the global Toast does not repeat it; minimizing the wizard keeps the takeover, leaving/changing target releases it; other devices and Desktop upgrade prompts are unaffected. The wizard publishes the target synchronously before connecting (not after `needs-upgrade`). When the Host enters `updating`, the upgrade need is lifted, or the Profile is removed, the old upgrade Toast is revoked immediately; click actions re-check the current snapshot and the same prompt submits an update only once. After a failure returns to the needs-upgrade state the retry entry stays; old-prompt dedupe must not lose the notification permanently.
- The update action defaults to `force:false`; only after receiving the `source-server-update-running-tasks` guard does it ask the user a second time and retry with `force:true`. "Version incompatible" alone is not authorization to force-interrupt running Tasks.
- "Updating" must override old required/error copy in every entry, showing a clear loading state, the current structured phase and an expandable log. Show a percentage only when upload/download yields a verifiable number; use indeterminate progress otherwise. On success it re-handshakes automatically and continues the original connect intent; on failure it keeps phase, log, retry and manual guidance.
- `applied:true` is the full remote runtime convergence contract: `current.json`, Supervisor, Server Core and Agent/Plugin Host must all come from the same target release. The current Supervisor may first verify the candidate Core ready, but the target-version CLI must then stop the old Supervisor, re-run `serve --daemon` from the target immutable release, and succeed only after control runtime identity verification; `status.version` or a new Core ready must not be taken as the whole daemon having changed generation. A brief offline period during the update belongs to `updating` and must not publish a new online attachment.
- An explicit update of a recognized Source must reuse the §7.1 physical -> logical generation seam: only when the old physical connection is actually removed from the Manager online owner are that Source's existing logical workspaces marked recoverable offline; after the new physical connection handshakes, the same Source's reconnect handle must be published so that `WindowRemoteConnectionRegistry` changes `remoteSessionId`, generation, scoped services and Desktop/Mobile attachments. When a running-task guard or update preparation fails while the old physical connection is still alive, logical workspaces must not be invalidated or regenerated.

```text
version incompatible
  ├─ user explicitly connects ─► wizard auto updateSource(force=false)
  ├─ startup/reconnect Toast ──► "Update now" ─┐
  └─ remote device Server card ► "Update now" ─┴─► updateSource(force=false)
                                                           │
                                                           ├─► Host operation log Event
                                                           │      └─ phase / message / real progress
                                                           ├─ running-task guard
                                                           │      └─ user confirms ─► force=true
                                                           └─ old physical owner removed
                                                                  └─ logical offline
                                                                       └─ success ─► re-handshake
                                                                            └─ logical/attachment generation change
                                                                                 └─ continue the original connect intent
```

- Update failure: update-operation state and compatibility state are separate. If the Source was online and compatible before the update, a running-task guard, download/upload or install failure must restore the original `online + updateAvailability` fact and only attach this update's error plus retry/force-update entries; it must not turn an available Source into `needs-upgrade + required`. Blocking `needs-upgrade` happens only when handshake compatibility is clearly incompatible, or when development content-addressing finds an archive SHA mismatch (must update before connecting). Phase one adds no extra controller-side release rollback orchestration.
- Explicit disconnect, deleting a Profile that is updating, or Host release must cancel the in-flight update held by the Manager, covering probe, release resolution, install, running-task list read and re-handshake. A Profile without `sourceServerId` yet is also cancelled by Profile; disconnecting a Source cancels all its updates. Late success, failure and cleanup must not redial, publish online, restore old state, schedule retry, or override a later manual connect. Cancel only ends the local connect intent and does not promise to roll back an already applied remote release; normal update and unexpected-disconnect recovery keep the existing contract.
- When deleting a non-current update route after the update invalidated the old physical connection, and that Source has no other in-flight update, the Manager must hand recovery back to the retained original recovery route within the delete operation (reusing the existing retry) and must not wait for the cancelled update's late result. If the Source is still online, later connected, or another update is in progress, do not start another recovery. Deleting the current recovery route, explicit disconnect or Host release stay terminal and pick no alternative route; desktop and phone keep consuming the same Source recovery owner.
- Host release must also clear the recovery inputs of offline Sources, including connections currently in retry or offline probe; a late catch after aborting a flight must not reschedule timers or publish an ownerless connection.

```text
update -> Manager registers an independent operation -> probe / archive / install / re-handshake -> online
              │
disconnect / delete / release -> cancel and remove the operation -> late results just exit
                                           └─ keep offline / deleted state / later new connections
```

```text
A online -> B updates -> old physical connection invalid -> delete B
                                  ├─ other updates remain -> that update closes it out
                                  └─ original recovery route A retained -> existing retry -> A online
```

## 7. Connection lifecycle and auto reconnect (D9)

### 7.1 State machine (window level, one per Source Server)

```text
                ┌────────────── App start: Servers used in the last 7 days
                │               (<=3 concurrent, 10 s per node, one attempt, silent)
                ▼
 absent --connect--> bootstrapping --incompatible--> needs-upgrade (user action)
                │        │ probe->install?->daemon->channel->handshake
                │        └─success
                ▼        ▼
             failed    online <----resync done-------┐
                          │ channel/WS disconnect     │
                          ▼                          │
                       retrying (2s -> 4s -> 8s, x3) ┘
                          │ all fail
                          ▼
                       offline (silent probe every 2 min + manual retry + "last online time")
                          │ probe reachable and credentials silently available
                          └────────► bootstrapping (no-interaction path: no credential prompt, no new version install)
```

- **Silent precondition**: automatic paths (startup reconnect / disconnect retry / offline probe) may only use no-interaction steps. Credentials must be silently available from the credential store (private key without passphrase, or password/passphrase saved). Anything needing a password, an install confirmation, or facing an incompatible version stops in the matching state and waits for the user.
- **New recovery cycle after terminal**: when the same Source publishes a physical connection again, the Registry first creates a new recovery barrier for the old terminal owner and clears the old failure, then starts asynchronous re-attach. Other routes joining the same Source meanwhile must wait for the new cycle and must not read the old install/upgrade-wait error; recovery budget and the Manager's connection single-flight semantics are unchanged.
- **While disconnected**: R1 semantics. Keep the last trusted task projection and mark `sourceAvailability=offline`; all writes and I/O fail closed, never falling back to local; after reconnect the new source snapshot replaces atomically (existing `replaceDisconnectedSource` path).
- **Recovery complete**: re-fill Task/Session/pending requests (existing disconnect data recovery: authoritative state query + incremental convergence). With pending requests, the bottom blocking card consumes the `pendingInteractions` projection; the top warning and its "go handle" entry are gone and there is no second fact source. This applies to local desktop, remote desktop and phone Web. The remote continuing to run during a disconnect is natural daemon behavior; recovery only re-reads authoritative state and never replays input.
- **Startup reconnect scope**: the main-window Host, at startup, targets "Servers with `lastOnlineAt` within 7 days (`SourceServerRecord.lastOnlineAt`, using the default route)" (phase one designed for a single window; Profile `lastConnectedAt` only orders routes and is not part of the gate). Once a device is online, the Renderer re-attaches all open disconnected `remote:server:*` tabs of that device in the current window, with no filter by workspace age or last-connected history (see C3 in [remote-device-sidebar-device-level-connect-spec.md](./remote-device-sidebar-device-level-connect-spec.md)). This explicitly changes the old behavior "cold start restores only disconnected entries and waits for manual reconnect" (SSH-P0-LIFE-01); the case catalog must be updated accordingly.
- **Probe**: lightweight path (transport dial + anonymous server-info); only success enters the full bootstrap; probing causes no user-visible UI change except the status badge.
- **Last online**: a successful handshake initializes `lastOnlineAt`; when the Manager leaves online it submits the last-online moment using the Host clock to the Directory serial write queue, and after persistence refreshes the projection through the original directory event. Later offline retries do not advance the time; late writes must not override a later handshake or recreate a removed Source. This metadata update does not change the desktop continuous / mobile replayable recovery chain.
- When the daemon is absent (for example a server reboot with no autostart registered for WSL/Docker), auto reconnect may run `ensureDaemon` (excluding install/upgrade).
- **Disconnect before publish**: a physical connection enters the "channel/WS disconnect -> retrying" path only after the Manager registered it as that Source's online owner. If the connection closes during handshake persistence (`recordHandshake`), the Manager must not publish the closed connection as online; it ends as an ordinary connection failure (`failed`, `retryable:true`; automatic paths continue with the next retry tier). A handshake-time disconnect of another Profile on the same Source must not affect the online owner. A close event only affects its own connection and is not generalized by `sourceServerId`.

Recovery owner and generation-change seam:

```text
Source transport disconnect
  -> SourceServerConnectionManager only runs the 2/4/8 s transport reconnect flight
  -> WindowRemoteConnectionRegistry keeps the same connection entry and marks the old logical session generation offline
  -> Host closes the old scoped port; Desktop/phone enter reconnecting/recovering respectively; Controller keeps the last trusted projection
  -> Manager produces a new connection handle
  -> Registry, by entry + generation CAS, regenerates remoteSessionId/generation for still-open workspaces
  -> Host/Main atomically rebuild the Desktop attachment
  -> Main removes the Provisioning lane bound to the old remoteSessionId and re-registers with the new remoteSessionId
     (triggers one full environment-online re-push; failure only warns and never tears down the Workspace, §8.3.2)
  -> Main first finishes the Desktop attachment and notifies the Renderer; phone recovery takes no part in judging Desktop success
  -> Main sends a non-terminal bridge-degraded to the old phone bridge; Web actively rebuilds a replayable attachment with a new bridgeSessionId/generation,
     completes gap/snapshot recovery and returns to ready
  -> release the old connection/session/port
```

- `WindowRemoteConnectionRegistry` is the only recovery owner of connection handle, logical session, `remoteSessionId`, generation and `sourceAvailability`; the Manager never holds or replaces Renderer/phone attachments.
- SSH/WSL/Docker route keys are only provisional lookup keys before the handshake. After the handshake yields `sourceServerId`, the canonical owner key of the managed connection entry must converge to `source:<sourceServerId>`; several route aliases may point to that Source entry within one window, but each Profile must not keep its own online/recovering entry. The Source owner claim must happen before the entry, logical session or attachment publishes online. A provisional entry that loses the race only reclaims its logical wrapper/subscriptions and must not disconnect the physical Source connection held by the Manager.
- After a transient close the persistent Source entry keeps occupying the connection key; a manual reconnect only triggers or joins the same Manager/Registry recovery flight and never creates a second entry. Every `entriesByKey` write and logical replacement must verify the expected entry/generation; a late flight must not overwrite a new owner.
- Each connection entry maintains a monotonic `transitionEpoch`. Recovery replacement, manual connect join, workspace prepare and attachment generation change capture the epoch before crossing `await` and must re-verify entry owner, epoch, `closePhase/state` and logical session identity afterwards; if a terminal close arrived in between, the old flight fails closed and must not republish online.
- `connectionKey + workspaceKey` has at most one online/recovering logical owner at a time. Bot/phone-triggered reconnects must join the existing recovery and return the single regenerated session; they must not build a second logical session for the upper layer to clean up later.
- The commit and rollback unit of logical replacement is a single `connectionKey + workspaceKey`, not the whole Source entry. When workspace A's Controller/Main attachment on the same physical Source has completed its generation change, a prepare, Controller snapshot or attachment replacement failure for workspace B may only roll back and retry B; A's Registry owner must not be rolled back to the old `remoteSessionId`. The physical transport stays online while logical replacement fails; uncommitted workspaces stay offline with all scoped I/O fail-closed; budget exhaustion makes only those workspaces terminal.
- `SourceServerConnectionManager` owns the resident physical Source connection and offline probing; a Window registry entry owns only the logical wrapper and subscriptions. When the last logical owner releases or the entry is replaced by a new owner, the wrapper/subscriptions are reclaimed but the Manager's physical `disconnect` is never called implicitly. Physical disconnect comes only from an explicit action on the connection management page or Host shutdown. Recovery waiters still pending on a replaced entry must end with a connection-cancel error; aborting the transport alone does not replace rejecting the recovery Promise. Requests already handed to the canonical Source owner continue under that owner, unaffected by the old entry's release.
- Logical replacement / attachment replacement failure has its own bounded retry; once the physical connection recovered it must not wait for the next disconnect to retrigger. A replaced `ServerRemoteConnection` must be explicitly disposed.
- A logical replacement retry timer belongs to the transport epoch it was scheduled in; at execution the entry must still be online with unchanged `transitionEpoch`. On another physical close (recoverable or terminal) the old timer is cancelled immediately; a late callback must not turn disconnected into online, consume the budget of a new recovery cycle, or clear a new cycle's timer. After a recoverable close, waiters keep waiting for the real reconnect; a terminal close rejects waiters. Only a real reconnect or a connected-handle takeover can start a new generation round; a timer is no evidence that the transport recovered.
- The Manager's `onDidReconnect` has a single fact source: the same Source being published online again after its first online publish and before explicit disconnect (whether triggered by 2/4/8 s retry, offline probe, `updateServer`, or a manual `connect()` such as `connectProfile` / `confirmIdentityChange`). A successful manual connect must also make the Host wrapper swap services and the Registry finish the logical generation change; the fork "Manager online, Registry still recovering, new joins wait forever" must not exist. The first publish and a sibling Profile joining an already-online owner are not reconnects and do not fire.
- A successful reconnect must not only update the Manager's internal `services` snapshot; until the Registry finishes the handle/session generation change, the old source stays offline with all writes and I/O fail-closed.
- The Desktop attachment keeps injecting `desktop-continuous` and the phone attachment keeps injecting `web-remote-replayable`; a generation change rebuilds only each side's connection-owned subscriptions and does not spread replayable snapshot/gap semantics to Desktop.
- During transient retry the phone bridge only sends a recovering state and not the terminal `workspace-bridge-error`; the terminal error comes only when the recovery budget is exhausted, credentials/version/migration need user action, or the user disconnects explicitly.
- The Renderer must distinguish automatic recovery from manual reconnect: automatic recovery shows the current attempt and the fixed budget (1/3, 2/3, 3/3); manual reconnect does not fake an automatic retry count; an exhausted budget enters an explicit terminal state showing the mapping of the Host-provided `reasonCode/retryable`. While recovering, scoped services are released, and the sidebar's workspace expansion, task click, new task and all writes fail closed until the replacement attachment is ready. The Bot connection-status query only recognizes attachable routes and must not report closed / recovering routes as connected.
- Every Manager retry state must travel through Registry/Main to the Renderer; while the Registry is recovering, a later recoverable close must not be dropped as a duplicate terminal. Budget exhaustion closes with a public `reasonCode` and localized copy; hard-coded Chinese text in the Host must not override the client locale.
- Main must not create an acknowledged relay protocol with seq restarting at 1 under the same `bridgeSessionId + bridgeGeneration + recoveryId`; a new protocol needs a new identity. A phone attachment rebuild failure must not dispose a ready Desktop logical session.
- `bridge-degraded` is a persistent invalidation latch for a bridge generation and does not go into the ordinary 5 s app payload buffer. After a Source generation change the old phone attachment is released immediately, and the invalidation is resent when the relay is paired/send-ready until the phone completes `workspace-bridge-ready` with a new bridge identity. A Web bridge rebuild failure retries in a bounded way under the same recovery generation; ordinary background transport recovery must not create a new Agent/Host/session by mistake.
- The old `remoteSessionId`, generation and scoped port are released together after the new attachment is ready; any late event, owner command or write request must be rejected by the old scope.
- A workspace bind establishes a Main deadline by `requestId`. On expiry Main must send cancel to the Host; the Host checks the cancel epoch before and after each cross-`await` remote RPC, especially after `recordWorkspaceOpen` and before publishing success. A late completion only reclaims resources newly created and exclusively owned by that bind request; when it joined an existing logical session or other attachment owners exist, it must not unconditionally `disposeSession`. The Main timeout itself returns `remote-bind-canceled`, late ACKs are ignored idempotently, and a vanished timed-out caller must not leave a phantom scope or hurt other owners.

### 7.2 Awaiting user confirmation (3.11)

Blocking permission/input requests are stored on the Source Server (existing Agent/Core behavior). A controller disconnect does not reject requests, and the Agent does not exit when it loses an attachment (natural once daemonized; replaces the old chain's "connection drop kills the server"). After reconnect, `pendingInteractions` is re-pulled by the recovery flow: Desktop auto recovery, Desktop manual reconnect and phone replayable attachment all re-project requests from the first snapshot. The bottom permission/question cards read this projection and disappear with the next authoritative snapshot after resolve. The top no longer repeats a pending-request hint.

## 8. Source authority and configuration surface (D7 / D11)

<a id="81-权威表"></a>

### 8.1 Authority table

| Data / capability | Authority | R3 change |
| --- | --- | --- |
| Workspace files, Git, Terminal, Task, Session, runtime state | Source Server / Agent CLI | Unchanged (remote authority); services become full-forward |
| Task index, pin/archive, workspace settings | Source Server | Unchanged; the Controller only aggregates and routes |
| MCP, Skills, Hooks, plugins, Commands, permission mode | Source Server | Skills/Plugins/Commands/Hooks were already remote; **Subagents/Memory/OutputStyle/settings-sync move from local to remote**, removing the UI/runtime fact-source split |
| Model Provider configuration, model availability | Source Server (execution mirror); local is the edit authority | **Main chain switch**: the desktop-attached push is removed; the remote `standalone-server` reads its own Built-in Release + Personal Layer and builds the Registry. Personal Layer and Configured Default are overwritten one way by local Provider Provisioning; the remote offers no edit entry. Model catalogs for the chat area / Subagents / Automation are read from the target Host's `model-selection` Facade (§8.2) |
| OAuth / `zcodejwttoken` login state | Held by each side; local is the source | Provisioning allowlisted credentials (`oauth:active_provider`, `oauth:zai\|bigmodel:*`, `zcodejwttoken`, `account-provider:*:api-key`) are replaced on the target Source with each push; the Source decrypts and the target re-encrypts with its own Credential Store; local logout / account switch converges on the next trigger. The remote cannot start a browser OAuth by itself |
| Connection Profile, window, Theme, Locale | Controller | Theme/Locale come from the local services of the window base attachment and do not follow Source switching |

Service collection: all three transports use the full-forward `createServerRemoteWorkspaceServiceCollection({ connectionServices, sourceServices })` (`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`); the SSH/WSL/Docker specific "local authority mixed" branch is removed, and the `onDynamicSessionRuntimePreferencesRequest` reverse bridge retired with desktop-attached mode. The full-forward collection also registers the Host-private `RemoteProviderProvisioningExecutor` (local `ProviderProvisioningSource` + remote `IProviderProvisioningTargetService`) in a WeakMap for Main scheduling; it never enters Renderer RPC (§8.3).

Under full forward, app-global services (OAuth, usage-stats, bots, coding-plan-subscription, etc.) in remote scope must be confirmed channel by channel in implementation slice 5. Already decided: a remote Source cannot start a browser OAuth directly (the controller's browser cannot serve the remote callback); it automatically receives the local active OAuth session through Provider Provisioning (allowlisted credentials). When the target holds no usable model, the chat area shows "此远程设备尚无可用模型，请先在本机配置模型，保存后会自动同步到远程设备" (no usable model on this remote device; configure models locally, saved changes sync automatically) and the configure / upgrade actions always point to the local machine.

`RemoteWorkspaceRpcContract v1` list after implementation:

| Channel group | Remote scope authority / behavior | Phase-one limit |
| --- | --- | --- |
| file/file-watcher/git/git-checkpoint/system/terminal | Source Server full forward | `workspacePath` only for remote I/O |
| zcode-task/zcode-agent/zcode-session | Source Server/CLI full forward | Desktop continuous; phone keeps replayable attachment |
| setting/credential/broadcast | Source Server full forward | Connection Profile, Theme, Locale still belong to the controller base attachment |
| onboarding-record | Source Server full forward (same source as setting/OAuth) | Does not borrow the controller record; phone replayable allowlist permits it, see onboarding-record-spec §5.1 |
| provider-settings/model-selection/media-preview | Source Server full forward (remote Facade reads remote Registry) | The settings "Model settings" page does not consume remote `provider-settings` (always local, §8.2); chat area / Subagents / Automation catalogs consume the target Host's `model-selection`; `media-preview` is a required contract channel checked by `assertRemoteWorkspaceRpcContract` |
| provider-provisioning-target | Remote Environment internal Provisioning target; **Host-only** | Not in `RemoteWorkspaceRpcContract v1`, not in the Renderer, not in the phone allowlist; a `/ws` replayable connection gets a throwing stub (§8.3.4) |
| OAuth/usage-stats/coding-plan/client-scenes/bots | Source Server full forward | The remote does not start browser OAuth itself; consumes the session pushed by Provisioning and does not fall back to controller services |
| skills/MCP/plugins/commands/hooks/subagents/memory/output/settings-sync | Source Server full forward | Source offline fails closed |
| conversation-share | Source Server runs with target OAuth/JWT, HTTP, Rows/File; Desktop forwards trusted attachment context | SSH/WSL/Docker can publish; Server direct and phone stay disabled; see the R3 authority convention in the conversation-share spec |
| prompt-attachment-transfer | Source local implementation kept; the Window Host attachment of SSH/WSL/Docker covers cross-machine staging | Reuses the current Transport backend to upload the desktop localPath; the operation is owned by the attachment and un-adopted content is cancelled on close; no Resource Store, see the attachment materialization spec |
| repo-wiki | Source Server full forward | Uses remote files and models |
| source-server-workspace | Source Server canonical alias / migration authority | `legacyRouteHint` is used only at the Host->Core boundary and never enters Renderer/phone identity |

A new channel must first update this table and `RemoteWorkspaceRpcContract v1`. The controller locally keeps only the Source/Profile directory, windows, Theme/Locale, Web remote-control pairing, attachment scheduling, plus the model-Provider edit authority (local `IProviderSettingsService`) and the Provisioning Source.

`REMOTE_WORKSPACE_RPC_CHANNELS` (`packages/desktop/src/host/remoteWorkspaceRpcContract.ts`, `REMOTE_WORKSPACE_RPC_CONTRACT_VERSION = 1`) currently lists the following; at handshake `assertRemoteWorkspaceRpcContract` requires the remote to provide each:

```text
fileService gitService gitCheckpointService systemService terminalService
settingService onboardingRecordService credentialService broadcastService
zcodeTaskService zcodeAgentService zcodeSessionService conversationShareService botsService fileWatcherService oauthService
providerSettingsService modelSelectionService mediaPreviewService          <- replaces modelProviderService / providerSyncService since 2026-09-07
sourceServerWorkspaceService usageStatsService codingPlanSubscriptionService clientScenesService
skillsService skillSyncService mcpSyncService pluginSyncService pluginsService pluginManagementService
subagentsService commandsService hooksService memoryService outputStyleService settingsSyncService
promptAttachmentTransferService repoWikiService
```

`modelProviderService` and `providerSyncService` were removed from the contract; `providerProvisioningTargetService` is not in the contract (the Host reads it from `connectionServices` on demand, no validation, no forwarding). The contract version stays v1: the compatibility gate by default promises same-version connections only, and old remotes are updated before the handshake; whether to move to v2 is discussed in [r3-provider-refactor-merge.md (archived)](../archive/remote-r3/r3-provider-refactor-merge.md).

#### Controller settings persistence transaction

Main saving window preferences and the Local Host saving the Source Directory both use `SettingService` patch updates; Source/workspace-history owners are unchanged. Writes to the shared `setting.json` must run under an inter-process lock on the same file: acquire lock -> re-read latest disk -> merge this patch/migration -> atomic replace -> release lock. Protecting only the final rename is not enough. The atomic write inside the lock reuses the held lock (no reentry); failure releases the lock; a timeout before commit revokes the write generation so a late old write cannot overwrite later settings; once the rename commit starts, the existing commit barrier applies until completion. Saving window size must not erase a just-recorded remote directory.

### 8.2 Model settings page binds to the local Environment

Decided 2026-09-07 when Provider refactor M2 merged (route A): the settings "Model settings" page **always binds to the local Environment**, with no device selector, no remote editing and no manual "one-click sync" button. Basis: Provider Refactor Design V2 §7.1 (each execution Environment reads its own configuration; the Host does not send Registry Snapshots to Workers; remote editing and login sync are independent product capabilities, not Provider core) and the "Desktop model configuration page" section of [Remote Provider Provisioning](../remote/provider-provisioning.md).

```text
SettingsPage
  └─ activeSection === "modelProvider"
       └─ ServiceProvider(localHostServices)            <- useBaseWorkspaceServices(), independent of the active workspace
            └─ ModelProviderSection
                 ├─ read/write: local IProviderSettingsService (provider_config.json / model-selection.json / narrow setting.json fields)
                 ├─ connectivity test: connectivityWorkspacePath forced to a local workspace; with a remote workspace active and no local workspace it returns unavailable
                 └─ save succeeds ──► local Provisioning Source trigger ──► §8.3 auto push to all online Sources

Active workspace (local / remote) -- decides only the workspace context, not the model-config data source
```

- The settings page has no "local / each remote Server" device menu and does not remember `lastAgentSettingsSourceServerId`; `ModelProviderSourceControls.tsx`, `useSourceSettingsAttachment.ts`, `providerSyncSnapshot.ts` and `AppSettings.lastAgentSettingsSourceServerId|providerSyncDefaultModel|providerSyncRuntimeCredentialBindings` are deleted. When a remote lacks models the settings page shows no remote guidance; guidance appears only in the chat area (§8.3).
- The retained `source-settings` attachment scope (`sourceSettingsServiceCollection.ts`) does not register `provider-settings` / `model-selection`; it serves only non-Provider configuration surfaces: Skills / MCP / Plugins / Commands / Hooks / Subagents / Memory / OutputStyle / settings-sync. Other capability pages keep their own User/Workspace Scope controls and current workspace routing; "Model settings binds local" must not spread to "all settings pages bind local".
- Model catalogs for the chat area, Subagents and Automation come from the **target Host**: `useModelSelectionView(workspacePath, remoteSessionId, workspaceIdentity)` resolves the workspace's service collection via `useWorkspaceServicesResolution` and reads its `modelSelectionService` (identical for ssh/wsl/docker/server). While waiting for the remote attachment it stays `remote-waiting` and never falls back to the local Local Host catalog. During the first bind/rekey, even if a tab still briefly carries a legacy `remote:ssh|wsl|docker:*` identity, it must not read the local catalog.
- When a remote workspace lacks a model, `ChatErrorBanner` with `modelConfigTarget: "remote"` only changes wording (`chat.error.remoteNoAvailableModel`: "此远程设备尚无可用模型，请先在本机配置模型，保存后会自动同步到远程设备"); the button stays "配置" (opens local model settings) / "升级"; the "去同步" entry is deleted.
- When the Renderer receives a remote scoped service port, whether to adopt the Source Server full-authority service collection is still decided by the Host-injected `sourceServerId`; SSH/WSL/Docker only describe the transport and must not cause a fall back to legacy mixed services. A recognized Source reached via SSH must still take `settingService`, credential, usage and `modelSelectionService` from the remote.

### 8.3 Provider Provisioning on the R3 main chain

There is no user-triggered sync entry for model configuration. The local machine is the only edit authority of Provider configuration, and each online Source Server is a disposable execution mirror of it. Envelope content, target-side transaction / rollback, `syncId` idempotency and validation boundaries follow [Remote Provider Provisioning](../remote/provider-provisioning.md); this section only describes how it attaches to the R3 chain and must not contradict it.

#### 8.3.1 Chain: Main coordinator -> Window Host executor -> Source Server target

```text
Desktop Main                         Window Host                              Source Server daemon (zcode-server-cli Core)
------------                         -----------                              --------------------------------------------
ProviderProvisioning                 RemoteProviderProvisioningExecutor       createLocalServices({
EnvironmentCoordinator               (registered by                             serviceAuthorityMode: "standalone-server",
  key = buildRemoteEnvironmentKey     createServerRemoteWorkspaceService-       providerProvisioningTargetEnabled: true,
        (descriptor.target)           Collection; Host-private WeakMap,         zcodeBuiltinProviderConfigFilePath })
  single-flight lane + generation     never exposed to Renderer RPC)           IProviderProvisioningTargetService
        |                                    |                                         |
        | HostMessage                        |                                         |
        | ProviderProvisioningExecute        |                                         |
        | {requestId, environmentKey,        |                                         |
        |  remoteSessionId, trigger}         |                                         |
        |----------------------------------->|                                         |
        |                                    | (1) source.read(syncId)                 |   <- local ProviderProvisioningSource
        |                                    | (2) target.apply(envelope)              |   <- /ws/host, desktop-continuous,
        |                                    |---------------------------------------->|      channel "provider-provisioning-target"
        |                                    |                                         | validate envelope
        |                                    |                                         | -> account narrow settings
        |                                    |                                         | -> credentials (re-encrypt on target)
        |                                    |                                         | -> provider_config.json
        |                                    |                                         | -> model-selection.json
        |                                    |                                         | any failure: reverse rollback
        |                                    |<----------------------------------------|
        |                                    | ProviderProvisioningResult              | success: refresh Account Source / Registry
        | HostResponse                       | {syncId, status, personalProviderCount, |          -> remote Host -> Worker overlay
        | ProviderProvisioningExecutionResult|  credentialCount, rolledBack}           |
        |<-----------------------------------|                                         |
        |
        | status in {applied, already-applied} -> resolve
        | otherwise: trigger == environment-online -> reject (first connect fails); other triggers -> warn (no Secret)
```

- Main only holds the Environment key, Host registration, trigger, generation and `requestId` correlation; it neither reads nor forwards configuration or Secrets. The Envelope passes through Window Host memory once; disk writes happen only in the target Source's official Store.
- Triggers (`ProviderProvisioningTrigger`): `environment-online` (first connect / reconnect), `personal-config`, `configured-default`, `account-settings`, `credential`. The last four are reported by local Local Services after persistence succeeds via `HostResponse ProviderProvisioningSourceChanged`; Main calls `coordinator.requestAll(trigger)` to advance generation on all online Environments. A new trigger during a sync only advances generation, and after the round one more read of the latest snapshot forms a trailing sync.
- Compared with the old "one-click sync": no target-confirmation UI, no journal + write barrier; the target uses transactional staging + reverse rollback + `syncId` idempotency. Team Plan runtime Key binding and the whole family run-selection bundle no longer exist; the account side syncs only the narrow `providerFamilyDomain` / `providerFamilyConnectionSelections` fields and allowlisted credentials.

#### 8.3.2 First-connect barrier and reconnect re-registration

```text
First connect (desktopRemoteSessions.ts handleConnected)
  RemoteWorkspaceConnected(descriptor)
    -> routesBySessionId.set(remoteSessionId, route)
    -> registration = coordinator.register(environmentKey, remoteSessionId, execute)
    -> route.providerProvisioningDispose = registration.dispose
    -> await registration.initialSync                       <- Remote Workspace ready barrier
         ├─ applied / already-applied --> attachRendererPort --> pending.resolve (connect succeeds)
         └─ failed / rollback_failed / unsupported
               --> dispose lane, delete route, DisposeRemoteWorkspaceSession --> pending.reject (connect fails)

Reconnect generation change (handleReconnected; §7.1 Source auto reconnect / re-handshake after explicit update)
  RemoteWorkspaceReconnected(previousRemoteSessionId, descriptor)
    -> route moves from the old sessionId to the new sessionId
    -> route.providerProvisioningDispose()                   <- remove the lane bound to the old sessionId
    -> registration = coordinator.register(environmentKey, new remoteSessionId, execute)
    -> registration.initialSync.catch(warn)                  <- reconnect is not a publish barrier: failure only logs a warning and never tears down the Workspace
    -> attachRendererPort(win, route, "source-server-reconnected")
```

- The barrier applies only to the first connect triggered by `environment-online`; a second Workspace of the same Environment joins the existing lane and produces no second first-time sync (E2E `SSH-P0-TASK-01` asserts that `records[]` in the remote `~/.zcode/v2/provider-provisioning-state.json` does not grow after the second Workspace connects).
- Reconnect must re-register: the lane is registered by `remoteSessionId` and the execute closure is bound to the old sessionId; without re-registering after the Source generation change, later pushes would hit an invalid old Host session and the remote would never get configuration again. Re-registering triggers one full `environment-online` re-push, covering local configuration changes made while offline. Unit tests in `desktopRemoteSessions.test.ts` cover "after reconnect re-register with the new sessionId and push again" and "a reconnect-triggered failure only warns".
- The Environment key is derived by `buildRemoteEnvironmentKey(target)` per transport (`ssh:<hostKey>` / `wsl:<distro>` / `docker:<container>` / `server:<serverId|url>`), not `sourceServerId`; the same Source reached over different routes forms different lanes (each first-connect sync, results idempotent). Converging on `sourceServerId` is an optional follow-up, see [r3-provider-refactor-merge.md (archived)](../archive/remote-r3/r3-provider-refactor-merge.md).

#### 8.3.3 `unsupported` rejection and compatibility-gate auto update

```text
connection wizard / auto reconnect
  -> handshake /api/server-info -> compatibility judgement (§6.3)
       ├─ remote < minCompatibleVersion (default = local product version)
       │     ├─ explicit connect: wizard updateSource(force=false) in place -> re-handshake -> continue the original connect intent
       │     └─ startup / offline reconnect: stop at needs-upgrade, wait for the user's "Update now"
       └─ compatible -> /ws/host -> assertRemoteWorkspaceRpcContract -> Provisioning first-connect barrier (§8.3.2)
```

- `ZCODE_MIN_COMPATIBLE_VERSION` defaults to the product version (root `package.json` declares no `zcodeCompatibility`), so an old daemon without a Provisioning target is judged "needs upgrade" at the handshake and goes through the §6.3 update first; the updated Core always registers the target. The R3 chain never sends an Envelope to a pre-Provisioning daemon.
- `unsupported` rejection semantics follow the Provisioning fact document unchanged and still cover: the local `ProviderProvisioningSource` unavailable (Window Host has no active local services, `sourceServices` empty); the remote Core not registering the target (for example `kind:"server"` dev direct connect to an HTTP zcode-server of `packages/server` without `ZCODE_SERVER_AUTH_TOKEN`).
- `unsupported` / `failed` / `rollback_failed` on first connect always take the official connection-failure channel: no Remote Workspace ready, no Secret sent, no silent retry. The Renderer sees an ordinary connection failure with logs; the user fixes and reconnects to retry.

#### 8.3.4 Non-desktop clientMode rejection stub

```text
Source Server Core (server-core/http.ts exposeWebSocket)
  /ws/host  clientMode = desktop-continuous (trusted Desktop Host: capability ticket + ingress token)
     └─ overrides do not replace -> real IProviderProvisioningTargetService
  /ws       clientMode = web-remote-replayable (phone / Web)
     └─ overrides.set("provider-provisioning-target",
            { apply: () => throw Error("Provider Provisioning 仅支持受信 Desktop Host") })

Window Host (windowHostAttachmentRpcPolicy.ts)
  web-remote-replayable allowlist: includes ProviderSettings / ModelSelection / MediaPreview, excludes ProviderProvisioningTarget
```

- Core always registers the target (the R3 ingress token is always present, so there is no HTTP-zcode-server style "unsupported without auth config" branch). Isolation is done at the clientMode layer: a phone replayable connection, even knowing the channel name, only gets a throwing stub and cannot write cross-Environment credentials into the Source Server.
- `RemoteProviderProvisioningExecutor` lives in the Host-private WeakMap and is not exposed to the Renderer via ServiceCollection; the Renderer/phone have no entry to trigger sync.

#### 8.3.5 Built-in Provider Config materialization directory

```text
zcode-server-cli build
  tsup define SERVER_CLI_DEFINES = { __ZCODE_VERSION__, __ZCODE_MIN_COMPATIBLE_VERSION__, __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ }
        │
Core start (server-core/core.ts runServerCore)
  layout = resolveServerLayout(ZCODE_SERVER_ROOT)
  ├─ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE set explicitly --> use that file directly
  ├─ otherwise materializeZCodeBuiltinProviderConfig({ runtimeRoot: layout.serverRoot, content })
  │     └─> ~/.zcode/server/config/provider/zcode-builtin-<sha256(content)>.json (tmp + rename; idempotent for the same hash, fails on content mismatch)
  └─ neither --> start fails (fail-closed)
```

- The materialization directory is `serverRoot` (`~/.zcode/server`), **not** the release's own `runtime/`: release directories are immutable, and when reinstalling the same releaseId `assertExistingReleaseMatches` recomputes the content hash of the whole tree, so extra materialized files would break verification. File names contain the content hash, so sharing across releases is safe. `config/` is currently not in the `zcode uninstall` allowlist, so after uninstall it is kept as `preservedPaths` (see [r2-server-cli-and-daemon.md](./r2-server-cli-and-daemon.md)).
- The remote Built-in Release is not copied by Provisioning: when the local Personal Layer references a Provider/Model that the remote Built-in lacks, the target returns a structured error and rolls back this configuration write.

### 8.4 Device management contract

Merged 2026-09-13 from the archived `docs/archive/remote-r3/r3-remote-ui-prototype-gap-audit.md` §8. Implemented. Code fact sources: `packages/shared/src/source-server/contracts.ts`, `packages/shared/src/source-server/errorCodes.ts`, `packages/desktop/src/host/sourceServerDirectory.ts`, `packages/desktop/src/host/sourceServerManagementService.ts`, `packages/shared/src/validationAppSettings.ts`.

**8.4.1 `declaredWorkspaces` (remote known directories)**

- Lives on `SourceServerRecord`, entries `{ workspacePath, workspaceIdentity, label? }`, schema `.default([])` (old persisted data without the key gets an empty array at parse); no new AppSettings key; it is regenerated and deleted with the device record.
- Only `recordHandshake` writes it: a successful handshake replaces it wholesale with the remote `ServerRemoteInfo.workspaces[]` (an empty array clears it), at most 20 per device; connection failure / disconnect does not touch it. A protocol response missing `workspaces` takes the existing handshake-failure path, no silent empty-array downgrade.
- Identity: when a remote entry's `workspaceIdentity` is missing or does not match the device/path, fill it with `buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath })` as a device-level stable identity. Merging/deduping with local `workspaceHistory` is always by `workspaceKey`, never by path alone. The field carries no `profileId`; quick-open only back-fills the path and is submitted by the currently established connection.

**8.4.2 `removeSourceServer(sourceServerId)` (remove all connections)**

- Deletes: all Profiles of the device (active / retired) and their credentials, all `workspaceHistory` entries, and the `sourceServers` record itself (including `declaredWorkspaces`); the migration ledger and remote data are unaffected.
- Order: (1) the Manager idempotently disposes running connections -> (2) `await onBeforeSourceServerRemoved(sourceServerId)` (the desktop Host production wiring must inject it and detach the device's Runtime resources in the callback) -> (3) one write of AppSettings inside a single Directory `enqueue`, credentials following `removeProfile` (backup first, delete, roll back on failure) -> (4) publish the management snapshot.
- Error codes: a missing callback refuses execution with `source-server-remove-callback-missing`; a callback failure aborts and deletes no persisted record, `source-server-remove-callback-failed`; a persistence / credential deletion failure enters the recovery state "device record kept, connection already disconnected", `source-server-remove-persist-failed`. A non-existent device returns a no-op success. Service-layer and UI tests assert the error codes, not exception text.
- UI: the device "more" menu offers "移除全部连接" (remove all connections) in every installed state, independent of the device being online, with a danger second confirmation; only "在侧边栏中显示" (show in sidebar) depends on online.

**8.4.3 Directory change events and unified generation**

- `SourceServerDirectory.onDidChange` fires after every successful `enqueue` persistence. The management service merges it with `manager.onDidChangeState` into one monotonic `generation` and exposes `onDidChangeDirectory` over RPC with payload `{ generation }` (`sourceServerManagementDirectoryDeltaSchema`). A snapshot content change always comes with a generation increment.
- `getSnapshot()` reads optimistically: record `startGeneration` -> read directory / states / counts -> compare `endGeneration`, re-read everything on mismatch; never produce "old content + new version number".
- The management snapshot must not wait for remote statistics RPCs: directory and connection state return first, and the Host reads migration statistics independently per current physical connection. `migrationCounts` distinguishes `loading`, `unavailable`, `requires-connection` and `available` with real numbers; the top-level total sums only available items and does not imply zero for others. At most one statistics request is in flight per connection; completion raises generation via the existing directory change event to notify refresh; a slow or failing Source does not block other Sources or manual disconnect. Old results after connection generation change, deletion or dispose must not be published. Directory changes and migration retry/abandon invalidate statistics; in-flight invalidations coalesce into one re-read after completion; no timed polling or unbounded retry.
- Page enter/refresh uses `getSnapshot({ refreshMigrationCounts: true })` to request a background statistics update; event-driven reads use the default false and only read the projection, so a statistics-complete event does not trigger another remote read. The optional parameter is validated by a strict Host schema, belongs only to the same-version local management service of Desktop and does not change the remote Server/Agent protocol.
- All management snapshot subscription points in the Renderer subscribe to both events and feed one in-flight / queued refresh queue, ordering by "drop generation lower than the observed value"; the directory callback of `useRemoteWorkspaceHistory` only refreshes the snapshot and does not trigger auto reconnect.

**8.4.4 Connection preference `remoteStartupAutoReconnectEnabled`**

- A top-level AppSettings boolean, default `true`, a missing field counts as `true`; both the full schema and the patch schema declare it, and an explicit `false` must not be stripped before writing to disk.
- It only gates the Host startup silent-reconnect entry (`listStartupReconnectCandidates -> reconnectOnStartup`); manual connect and post-disconnect retrying / offline recovery are unaffected. Changes persist immediately and take effect on the next start. Only the desktop settings page offers the entry; no cross-end RPC is added.
- There is no global default download-mode preference (decision 2026-08-28 revoked `remoteDefaultAssetInstallMode`); the SSH new-route form starts with `local-download-upload` every time, and the Profile's own `assetInstallMode` takes precedence.

## 9. Data migration (D7 / D8)

Schema upgrades go through the formal migration ledger of the physical databases: Controller/Source additional tables enter `tasks_schema_migration` by purpose, and the session identity tables enter the CLI `schema_migration`. Repos no longer create tables or add columns on their own. Old schemas, unfinished plans and rollback compatibility rules: [`Task SQLite Index: R3 additional tables in the database-level ledger`](../task/task-sqlite-index.md#r3-附加表纳入库级账本). The workspace-level data merge ledger below still tracks business progress and does not replace database-level schema versions.

### 9.1 Controller migration (first start after App upgrade)

Input: `~/.zcode/v2/setting.json#lastWorkspaceSession[kind="remote"]` (connection and workspace in one entity, <=20 entries) + `credentials.json` entries `remote-workspace:<workspaceKey>:{password,private-key-passphrase,server-token}`.

```text
each remote entry
  ├─ target snapshot --dedupe by (transport, normalized target)--> ConnectionProfile (new profileId)
  │     └─ credential key redirect: remote-workspace:<key>:* -> connection-profile:<profileId>:*
  │        (N credential copies of several directories on one host converge into 1; old keys kept until R4)
  ├─ workspacePath + lastOpenedAt --> workspace open history (references profileId; sourceServerId back-filled after handshake)
  └─ old identity kept on the history entry, as a fallback for remote history matching on open
```

- The migration is purely local, idempotent and done at schema-parse time (following the existing `migrateLegacyWorkspaceSession` pattern). A failure does not block App start; it only affects the connection page and can be retried. A rejected initialize flight of the Directory must be cleared so a later explicit retry is allowed. Whatever the migration result, the Window Host must expose the local base attachment first; a Source Server directory fault must not stall local workspaces.
- When one target has several credential copies (stored per workspace entry), non-sensitive target metadata comes from the entry with the latest `lastOpenedAt`; password and private-key passphrase are each taken from the first entry, scanning by `lastOpenedAt` descending, whose credential value actually exists. An empty source must not shadow an older valid sibling.
- New Profile creation and migration use the same credential seam: the Host owning the plaintext target generates `profileId`, writes the password/passphrase to `connection-profile:<profileId>:*` and writes the reference in the same persistence operation. Migration writes the new reference only after the value copy succeeded; an empty source continues to mean "interactive credential needed"; dangling keys must not be created.
- During the R4 compatibility window, when the Renderer projects a stable Source workspace for an old Desktop, it must materialize the Profile secret into an independent per-workspace `remote-workspace:<legacyWorkspaceKey>:*` mirror, writing the secret first and committing the `lastWorkspaceSession` reference afterwards. Old keys are only for rollback compatibility; the current main chain consumes only Profile credentials.
- `sourceServerDirectoryMigrationVersion=1` does not mean credentials are complete. Host initialize runs an idempotent audit over active SSH Profiles and repairs a missing canonical value only from legacy siblings with the same normalized route; it never guesses by alias/hostname similarity.
- `SourceServerRecord` is not created in this phase, because it can only come from a real handshake (`sourceServerId` unknown). Un-handshaked Profiles are shown standalone on the connection page and merge into the Server card by `sourceServerId` after the first successful connect.
- Rows in the controller's local `tasks-index.sqlite` that reference old remote identities are rewritten to the new identity after the corresponding Server's first handshake; silent dropping is forbidden. Per-table inventory (implemented: `packages/services/src/session/controllerRemoteIdentityMigration.ts`; merged 2026-09-13 from the archived `r3-controller-remote-row-migration-inventory.md`). The controller `tasks-index.sqlite` is only a Controller shell / scheduling record, not the authority of remote Session content; the old `lastWorkspaceSession` and old credential keys stay read-only until R4.

| Table / field | Existing semantics | R3 action | Conflict / reconciliation rule |
| --- | --- | --- | --- |
| `tasks.workspace_key/workspace_identity/meta_json` | Controller task membership/cache | Rewrite to the new key by `(oldWorkspaceKey, task_id)`; fix meta identity too | If the new key already has the same task, keep the shell row with the newer update time; content is not in this DB, no Session-content arbitration |
| `task_group_members.workspace_key/workspace_identity` | Local group membership reference | Rewrite in the same transaction as the task row | On a same-task conflict keep the target membership; never create duplicate members |
| `task_group_workspace_bootstraps.workspace_key` | Workspace first group-bootstrap marker | Rewrite key | If the target already has a marker delete the old one; group id kept to avoid reordering |
| `task_group_view_node_orders.node_key` (`node_type='task'`) | `JSON.stringify([workspaceKey, taskId])` order key | Parse JSON and replace only the workspace key | If the target node exists keep the target order; invalid historical keys are skipped and counted in the report |
| `automations.workspace_key/workspace_identity` | Controller cron definition | Keep the record and rewrite identity; `location_kind` unchanged | R3 opens no remote automation execution entry; migration only prevents orphaned records and does not change scheduling capability |
| `automation_runs.workspace_key` | Cron run reconciliation/history | Rewritten with the automation identity | `run_id` is the primary key, so updating workspace key never merges rows |
| `off_peak_tasks.workspace_key/workspace_identity` | Off-peak task records | Keep the record and rewrite identity | Active-binding conflicts on the same session cancel the source row per the ruling below; R3 does not widen remote off-peak scheduling |
| `workspace_alias` / `workspace_migration_*` | Remote-Server-only canonical/ledger | Not created or read by the controller | These tables belong only to the Source Server tasks-index and must not be mixed into controller migration |

Not rewritten: `task_groups` (not located by workspace key), `node_type='group'` rows of `task_group_view_node_orders`, local workspace rows and remote-local path-key rows, CLI `db.sqlite` `session/message/part` (handled by the Source Server canonical migration), the Controller in-memory projection (the first handshake / reconnect replaces it atomically with the new source snapshot).

Transaction and rollback: each workspace is rewritten in a single transaction and writes the `controller_remote_identity_migrations` ledger (old/new key, before/after row counts per table, status, error); any table failure rolls back the whole transaction. After migration, `tasks` membership, group member, automation, automation run and off-peak counts are reconciled mechanically to be equal before and after, and the row count for the old key must be 0.

Failure handling must preserve the original migration error. After SQLite auto-rolls back on FULL/IOERR, cleanup must not overwrite the original error with "no active transaction"; the controller's failed-audit write is best-effort and returns a failed report carrying the original error even when the audit DB is not writable, never interrupting the handshake because of a second audit failure. Remote alias-merge transaction rollback follows the same rule.

Off-peak binding conflict ruling (CR-03, shared by controller and remote canonical merge): when in the same database the source key and target key hold the same non-empty `session_id` and the `status` of both is not in `completed/failed/cancelled`, keep the target active row; the source conflicting row is first turned `cancelled`, then rewritten together with the other source rows, and history is not deleted. Cancel follows terminal persistence semantics: write the migration-time `ended_at/updated_at`, clear `failure_reason`, set `schedulable=0`, `claim_running=0`, `claimed_at=NULL`; object ids, session/conversation references, tickets and existing settlement state are unchanged, and unsettled terminals are left to the existing outbox. Target rows, existing terminal rows, empty sessions, different sessions and the running state of other workspaces are unchanged. The conflict ruling and the rekey must be in the same `BEGIN IMMEDIATE` transaction and roll back together with the cancel on later failure; a retry does not modify already-migrated rows again. Several source variants are processed in the frozen plan's order; when the target originally has no active row for that session, the row migrated first becomes the retained target for later conflicts. Existing Source Server task identity conflicts are still rejected by the pre-check and cannot be bypassed this way.

### 9.2 Remote canonical key resolution and merge (Server Core autonomous)

R3 principle for remote legacy data: **do not touch what you need not touch**. Old-version Desktops (old chain with old code) only understand old route-derived keys, so any compatibility layer that needs old-code cooperation is invalid; compatibility can only live in the data shape layer. R3 lets the new chain **keep reading and writing old-format keys** and gets route independence through alias resolution:

```text
Core workspace locator receives { workspacePath, legacyRouteHint? }
  │
  ├─ alias table has a record for this path ──────────► use the recorded canonical key (zero data change)
  │
  ├─ no record, scan both DBs for remote:* variants of this path
  │    ├─ exactly one key (single-route user, the vast majority) -> that key is canonical, write the alias table (zero data change)
  │    ├─ several keys (multi-route history) --> pick the most recently active key as canonical, merge the other variant rows into it once
  │    │                            (backup first + migration ledger + conflict report, below)
  │    └─ a local path-key history also exists --> do not merge (remote-local history stays independent, unified in R4)
  │
  └─ no history at all (new workspace) --> use legacyRouteHint as canonical and write the alias table
                                    (so an old version connecting from the same route also sees new tasks)
```

- The alias table lives in the remote `tasks-index.sqlite` (`workspace_alias(path, canonical_key, created_at)`), a small additional table for new code only; old code does not see it and is unaffected.
- **Single-route users (the vast majority)**: task rows, session rows and `sessions/<hash>` config directories are all untouched. Old and new versions read/write the same rows: after rollback existing conversations are visible and can continue; messages appended by the new version in the same session are visible to the old version (messages/parts are linked by session_id), and vice versa.
- Multi-route merge handles only "several remote:* variants of the same path"; objects and rulings:

  | Object | Merge rule |
  | --- | --- |
  | `tasks` | The only task moves to canonical; same `taskId` merges shell metadata. Meta fields: newer `updated_at` wins (on a tie source wins); status/provider/mode/model/migration/fork/cron/off-peak projections stay consistent with the merged meta. `createdAt` earliest, `updatedAt` latest, title prefers the user-edited one, pinned/archived/deleted by `deleted > archived > pinned > normal`; content index keeps canonical's non-empty value, else source's; `unreadAt` is the max of both non-empty values, `lastUnreadAt` the max of both historical markers and the merged unread; incompatible cron/off-peak/fork identity = conflict for the whole workspace |
  | `task_group_members` / `task_group_workspace_bootstraps` | Rekeyed with the task/workspace; if canonical already has the same task/bootstrap keep the canonical row and delete the source duplicate |
  | `task_group_view_node_orders` | Only change structured keys with `node_type='task'` and `node_key=[workspaceKey,taskId]`; if canonical has the same key keep canonical order |
  | `automations` / `automation_runs` | Full `workspace_key` rekey; sync `workspace_identity` to canonical when present; object ids, task/session references and run state unchanged |
  | `off_peak_tasks` | Per the §9.1 off-peak binding conflict ruling: keep the canonical active row, cancel the source conflicting row, then full rekey; keep all history and object references; non-conflict row state unchanged |
  | `~/.zcode/cli/db/db.sqlite#session` | Only change `workspace_id` of same-path variants to canonical; message/part content is not rewritten |
  | `~/.zcode/v2/sessions/<hash>` | Recursively merge the source hash directory: move if the target does not exist; dedupe when the same relative path has identical bytes; differing type or bytes make the whole workspace fail closed before any backup/move |

- Meta merging of duplicate tasks is per field: if the newer record lacks a field, keep the older record's value and do not overwrite it with the newer row's NULL projection. When old meta does not carry a field, keep the newer row's non-empty projection from both indexes (compatible with historical cron/off-peak records that only back-filled index columns). Projection repair, meta write and source deletion happen in the same task DB transaction; cron/off-peak/fork still take meta fields as authority and historical index columns as the source for missing fields, then run the identity conflict pre-check; even if the two meta JSONs are identical, differing effective identities on both sides must be refused and never overwritten by recency.
- Projected task indexes derive title, created/updated time and status from `cli_*` columns, so the merge must sync these CLI facts, matching `TaskIndexRepo.applyCliFacts`: `cli_created_at` earliest, `cli_updated_at` latest; if the newer row's `cli_last_outcome` is empty keep the older one; a custom title source is not overwritten by non-custom; `cli_deleted` max, `handoff_pending` union. Source Server rows share one owner host, and `host_id`/`root_path`/`project_id` follow the canonical row; DBs that only ran the tasks schema migration and lack these columns merge by the old columns.
- The "newer row" for CLI facts is judged only by both sides' `cli_updated_at`, independent of the shell fields' `updated_at` ruling; a side without CLI facts (`cli_updated_at` empty) does not win; on a tie source wins. The old ACP ID migration only raised `updated_at` without touching `cli_*`, so the two columns can diverge in existing DBs and `updated_at` cannot stand in.

  ```text
  older meta + newer meta -> merge meta -> update index projection in the same transaction -> delete source row
                                      └─ failure -> the whole task DB transaction rolls back
  ```

- Conflict pre-check covers task identity and `sessions/<hash>` file collisions. By default a conflict keeps the workspace fail-closed, with data on both sides untouched in place; since conflict detection precedes backup, it must not claim "a backup exists". Re-opening the same unchanged conflict only updates the same failed ledger / conflict set and creates no new ledger or backup. Identity conflict is a deterministic user decision: while the conflict is unresolved, `migrate retry` returns the structured `workspace-task-identity-conflict` with `retryable:false`, and must not spin and then claim a retry happened. The write transaction merges sources into canonical one by one, comparing each later source with the accumulated merge result; the task identity pre-check must accumulate the merge result per `taskId` in the same order and not compare only against the canonical snapshot. When canonical lacks the task or the identity field, source-to-source identity conflicts are likewise found before the ledger and backup:

  ```text
  canonical A has no T (or T without cron); source B.T cron=b, source C.T cron=c
    pre-check: merged[T] <- B.T -> C.T vs merged[T] -> conflict -> reuse the failed ledger, no backup
  ```

- The management surface provides an explicit **whole-directory** "conservative abandon merge": the most recently active variant becomes canonical and the other variants are sealed in place without moving; per-task skipping is forbidden. The ledger uses `status='abandoned'` and records canonical, time, trigger and an activity digest covering all the migration objects above. When a later query finds the digest changed it projects `abandoned-diverged` and offers re-trying the merge; `failedPathCount` counts only `failed`, `abandonedPathCount` counts independently, and neither may be inferred from the other.
- Abandon acquires the task DB write lock after reading the config snapshot and re-checks inside the transaction, for the same migration, `status='failed'`, `phase IS NULL`, and that canonical and variants are unchanged. If already completed, recovered, deleted or the plan changed it refuses with a retryable error and keeps the current ledger/alias; millisecond `updated_at` must not stand in for plan comparison. Within one Source Server Repo, resolve, retry and abandon share one serial queue keyed by trimmed workspacePath, covering plan read, async backup, directory move, alias publish and connection close; retry reuses the internal resolve inside the queue and does not enqueue twice. A previous failure still releases the queue and the next run resumes from the committed ledger; different paths queue independently. The queue does not replace SQLite write transactions and promises no cross-process serialization.
- The resolve entry queries the current path's `abandoned` ledger before alias/variant scanning. Unless the user explicitly "re-tries merge", it returns the frozen canonical and `mergedKeys=[]` regardless of digest change, allowing the workspace to open; a digest change only projects the report as `abandoned-diverged`. Only an explicit retry reactivates the ledger and enters the conflict preflight.
- Without conflicts, create backups of both DBs first, then advance forward-only by phase; backups serve only manual disaster recovery and committed phases are not rolled back automatically:

  ```text
  resolve(path)
    ├─ an active ledger with running/failed + phase exists
    │    └─ freeze migrationId + canonical + variants, continue from the recorded phase
    └─ no active ledger
         └─ scan variants + elect canonical + conflict preflight
                │
                ▼
            phase=preflight
                -> backups-created
                -> task-db-merged
                -> session-db-merged
                -> config-dirs-merged
                -> alias-published
                -> completed
  ```

  Writes of each phase must be idempotent and the ledger advances only after the phase completes; if phase work is done but the ledger has not advanced, replaying the same phase must converge. An active ledger takes priority over alias/variant scans; during recovery canonical must not be re-elected and no second ledger created; variants appearing after the migration started are left to the next incremental migration after this round completes.

- Resume must not skip conflict conditions that may still change. Before entering `task-db-merged`, the task identity of the frozen variants must be re-verified inside the same task DB write transaction; on a new conflict the whole phase rolls back and the ledger stays failed; "keep the conflicting task but continue rekeying membership/automation/session and mark completed" is forbidden. If the config directory move finds a new post-preflight conflict, the current phase also stays failed and no alias/completed is published.
- The ledger schema must be rebuilt with versioning, keep existing rows and add the phase and `abandoned` audit fields in one step; it must not rely on `CREATE TABLE IF NOT EXISTS` to alter existing CHECK constraints.
- Merging is idempotent and incremental: new variant rows written by an old-version Desktop from a "non-canonical route" during mixed connect are merged the next time Core resolves that path.
- `legacyRouteHint` priority: the Host first takes the old identity kept on that workspace's history entry (points more precisely to history), otherwise builds it from the current SSH/WSL/Docker route; the stable identity passed by the Renderer must not serve as a hint.
- `sourceServerWorkspaceHistory.legacyWorkspaceIdentity` is the single source of the rollback identity. `recordWorkspaceOpen` must keep the old value when it receives no new legacy hint; every `lastWorkspaceSession` writer must build the legacy-compatible snapshot from the same latest history, and a default empty history must not rewrite the frozen legacy identity into the current route.
- The identity of an unresolved conflict event is `path + conflict kind`; a canonical candidate change may only atomically update the same ledger and the current conflict set and must not create a duplicate ledger. Conflict details of resolved ledgers are kept as audit records; current-state queries must join the ledger and filter `status='failed'`, never show historical details as unresolved conflicts.
- `kind:"server"` is only a local dev direct-connect entry and takes no part in the R3 route compatibility of SSH/WSL/Docker. It must use the stable identity as its dev storage key, or wire exactly the same alias mapper as the Source Server Core; `remote:server:*` must not be sent into a `legacyRouteHint` that accepts only legacy route keys.

### 9.3 Old/new version compatibility boundary (mixed connect and rollback)

| Scenario | Behavior |
| --- | --- |
| Single-route user rolls back after upgrading to R3 | Zero data change; the old chain reads/writes the same rows by the original key: history complete and resumable; new tasks/messages created during R3 are visible too |
| Old and new Desktops mixed-connect the same remote (same route) | Both read/write rows of the same canonical key: tasks and conversations visible both ways, continuing interoperates. Differences are architectural only (old starts a temporary stdio server, new connects to the daemon) and do not interfere |
| Multi-route user: roll back / mixed connect from a merged route | That route's old-key rows were merged into canonical; the old side can no longer see merged history from that route (data not deleted; backup and ledger reconcile); the canonical route sees everything. A narrow edge case covered by gray-release copy |
| Workspace created by R3 on a newly installed server | canonical = the old-format key of the current route: an old version connecting from the same route sees it and can continue |

### 9.4 Rollback safety

- Remote: single-route users are naturally lossless (no data change); multi-route merges have backup + ledger + report and can be manually recovered in extreme cases; session content (messages/parts) is never rewritten. The alias table and ledger are purely additive and ignored by old code.
- Controller: remote entries in `lastWorkspaceSession` keep the legacy route-compatible representation in R3 and must never write `remote:server:*`; after rolling back to an old version the old field is still usable. R3 runtime tab/history/credential/UI store must project through `sourceServerWorkspaceHistory.legacyWorkspaceIdentity -> workspaceIdentity` into a single stable workspaceKey; the UI must not restore both the legacy and the stable one.
- On the first Desktop bind of a Source workspace, the Host bind response may carry a one-time `previousWorkspaceIdentity` rekey hint; the Renderer must reuse the existing `ensureWorkspaceTab()` to turn the legacy tab into the stable tab in place and must not produce a second workspace via `addTab()`. This field is not a task routing identity; it is only for Desktop `continuous` tab rekey and ignored by phone `replayable` attachments.
- Gray order: internal validation -> small-percentage gray (check alias hit rate, multi-route merge ledgers and task reconciliation) -> widen -> full; the three transports switch together, not split by transport.
- R4 (after the migration window ends and old versions leave support) has two decoupled steps: (1) delete compatibility code (old connection record reading, `legacyRouteHint`, old-format parsing, old loose-file cleanup), pure code, low risk; (2) canonical key cleanup: the R4 Server CLI at start rewrites canonical keys once into server-local keys, merges remote-local history and deletes the alias layer. Cleanup is fully transparent to Desktop: the R3 Source Server workspace locator wire only carries `{ workspacePath, legacyRouteHint? }`, the stable `workspaceIdentity` is only for Desktop/Host isolation, and canonical is always a Core-internal storage detail. So cleanup is just one remote Server version upgrade, needs no controller release, and can slip past R4 if scheduling is tight.

## 10. Controller projection and multi-Source product surface (D11)

### 10.1 Projection evolution

Source management state and commands are owned by the Window Host alone:

```text
Desktop Renderer -- SourceServerManagementService --> Directory + ConnectionManager
Desktop Renderer -- source-settings attachment -----> online Source configuration channels
Mobile /remote   -- existing workspace attachment --> management/source-settings forbidden
```

- `getRecentOperationLogs(profileId)` returns up to 100 lines of the latest connection or update of the owning device; `onDidAppendOperationLog` tells the UI to re-read. The only record belongs to the Host ConnectionManager's runtime memory; an internal reconnect after an update belongs to the same operation, and a new operation replaces the old record; concurrent late output cannot overwrite; identity generation change migrates to the new Source/Profile while the old device keeps prior history. Closing the panel does not clear it; deleting the record and Host exit clear it; nothing is written to settings.
- `SourceServerManagementService` provides the initial directory/state snapshot, monotonic-generation state deltas, connect/disconnect/update/rename/preferred/remove and migration counts. Directory changes must refresh `servers/profiles/history` through a full snapshot or typed directory delta, not only `states`. Migration counts are expressed per Source as `available | requires-connection | value`; offline must not masquerade as 0. The Renderer no longer overwrites settings with whole arrays.
- The `source-settings` attachment is not bound to a workspace and starts no Agent runtime; it exposes only non-Provider configuration channels MCP/skills/plugins/commands/hooks/subagents/memory/output/settings-sync and is destroyed when the Source goes offline. The Provider configuration surface is not in it: the model settings page binds local (§8.2) and remote configuration is pushed by Provisioning (§8.3).
- These two capabilities are registered only in `desktop-continuous` attachments; the Host rejects `web-remote-replayable` even if it constructs the scope; the phone keeps consuming the existing workspace/task projection only.
- The `ControllerProjection` source scope is upgraded from `remote\0remoteSessionId\0workspaceKey` to `sourceServerId` as the first-level dimension (local source stays `local\0workspaceKey`); the workspace facts of `controller/workspaces` gain `sourceServerId`, `serverDisplayName`, online status and "last online time".
- R1 subscription/seq/gap/resync, query-level invalidation, single-flight and offline-freeze semantics are all unchanged.
- The workspace, timeline, grouped, archived and pinned entries keep a task's Source attribution; the project list is flat, and device info, offline placeholders, ordering and actions follow the [project navigation spec](../remote/project-first-remote-navigation-spec.md). Display names take no part in identity, dedupe or persistence isolation, and device online is never substituted for attachment ready.
- Write operations (open/pin/archive/continue) always route to the Source Server that owns the task; when offline they fail explicitly and roll back optimistic state (R1 fail-closed semantics).

### 10.2 Product surface list

- [Connection UX](remote-device-connection-ux-spec.md) owns the unified five states, three-screen wizard, install confirmation, device card, logs, read-only task list and update prompts; the old three-tab / five-step plan is not used.
- [Project navigation](../remote/project-first-remote-navigation-spec.md) owns the flat project list, choosing a directory after connecting, original-project resume, disconnect and restart recovery; the remote no-project chat UI is disabled, data kept.
- The first "keeps running" notice sits on the directory page, one-time and non-blocking, using the versioned onboarding record; it no longer pops a boundary modal requiring confirmation.
- [Projection and persistence compatibility](remote-domain-simplification-and-conversation-workspace-spec.md) owns the open set, explicit close, strict schema and remaining R4 migration.
- [Renderer re-attach](../remote/desktop-remote-session-renderer-reattach.md) owns project re-attach after a device comes online; the underlying connection lifecycle remains §7.
- Model settings bind local (§8.2), Provider auto push (§8.3); other capability pages follow their User/Workspace Scope.
- Deleting the Profile used by the current physical connection or recovery owner is equivalent to explicitly disconnecting the whole Source in the current window: cancel timers/flights, release the connection, clear target/secret and publish terminal offline. Even with other active Profiles no automatic switch happens; deleting a non-current Profile does not interrupt other connections.
- After uninstall the user decides whether to remove the local record; identity continuity for reinstall with data preserved follows §3.

## 11. Old main chain removal and retention list

Runnable paths deleted or disabled within R3:

| Item | R3 outcome |
| --- | --- |
| `desktop-attached-remote` provider push chain and the local-authority mixed service collection | Delete `createRemoteWorkspaceServiceCollection` and tests that only verify the old branch; keep only the full-forward collection |
| Web/Lite old remote connect entry `POST /api/connect-remote` + `/ws/remote/:id` | The paired routes are both deleted and locked by a 404 unreachable test; the Server can no longer start a temporary stdio main chain |
| Callers that treat route-derived identity as the formal Controller/workspace identity | Zero callers deleted; stable identity is still built from `sourceServerId + workspacePath` |
| Early-R3 Provider "one-click sync" and the model settings device selector: `provider-sync` channel, `IProviderSyncService`, `packages/services/src/provider-sync/*`, `encryptedProviderSyncSnapshotSchema` / `providerSync*` schemas of `shared/src/source-server/contracts.ts`, `ModelProviderSourceControls.tsx`, `useSourceSettingsAttachment.ts`, `providerSyncSnapshot.ts`, `packages/ui/src/lib/remoteWorkspaceProviderSync.ts`, `packages/ui/src/lib/zcodeModelSelectionResolution.ts`, `AppSettings.lastAgentSettingsSourceServerId\|providerSyncDefaultModel\|providerSyncRuntimeCredentialBindings`, `ServiceChannels.ModelProvider\|ProviderSync`, `oauthService.exportSessionForSync\|replaceSessionForSync`, the chat banner "去同步" action | Deleted together under route A when Provider refactor M2 merged on 2026-09-07 (see [r3-provider-refactor-merge.md (archived)](../archive/remote-r3/r3-provider-refactor-merge.md)); replacements are Provider Provisioning (§8.3) and the local-bound model settings page (§8.2). The `source-settings` scope and `sourceSettingsServiceCollection.ts` stay, serving only non-Provider configuration surfaces |

After the flat project navigation shipped, the unreferenced `WorkspaceSourceGroupHeader`, the device grouping/collapse preference helpers and their dedicated tests were deleted; `getWorkspaceSourceServerId` and exact legacy alias resolution stay. This cleanup does not touch the R4 compatibility chain below.

Kept as source but unreachable from production entries, physically deleted in R4:

- `packages/server/src/remote/connect.ts` (and the `handshake.ts`, `stdio-socket.ts` direct old-chain dependencies), `deploy.ts` (and `remoteAssetDeployDecision.ts`, `zcodeAgentDeploy.ts` which it still calls statically) and `packages/server/src/entry-stdio.ts`. R3 first cuts the runtime path by deleting `/api/connect-remote` and the old Desktop callers, and keeps a migration window for R2 rollback / upgrade troubleshooting, avoiding a wide historical-module deletion during main-chain stabilization. `pnpm dep:refs` confirmed the latter two still have production callers and cannot be deleted as dead code.
- The SSH/WSL/Docker construction of `buildRemoteWorkspaceIdentity`. The Host still uses it to generate `legacyRouteHint` when no exact historical value exists; it is not the formal stable identity and is deleted together with the hint in R4.
- Reading and parsing of old connection records (`lastWorkspaceSession` remote entries, `remote-workspace:*` credential keys).
- `parseRemoteWorkspaceIdentity` parsing of `remote:ssh/wsl/docker:*` (used by the remote migration scan).
- Old loose files under remote `~/.zcode/server` (rollback dependency of un-upgraded Desktops).
- Compatible reading of migration ledgers/reports.

Kept long term: the exec/upload/detect primitives of the three `IRemoteBackend` implementations (Adapter base), the `kind:"server"` dev direct connect, the whole phone attachment chain.

## 12. Implementation record

The original implementation slices are done; the process is in Git history. Remaining release items follow the [issue ledger](r3-source-server-remote-open-issues.md). Marking this spec implemented does not mean the current candidate has completed all-platform release validation.

## 13. Acceptance mapping and test strategy

- The overall plan's acceptance matrix REMOTE-01–15 is fully closed by R3 (REMOTE-01 was covered by R1 and regressed here). Key mapping: REMOTE-02 -> §5.3; REMOTE-03 -> §4/§7; REMOTE-04/05 -> §7; REMOTE-06 -> §10; REMOTE-07 (Agent settings switching Source) and REMOTE-11 (one-click sync) are void under the 2026-09-07 decision, replaced by §8.2 model settings bound local + §8.3 Provisioning first-connect barrier / reconnect re-registration / `unsupported` rejection / phone replayable rejection stub / Secret not in logs (E2E anchor: the `provider-provisioning-state.json` assertion of `SSH-P0-TASK-01`); REMOTE-08 -> §6.3; REMOTE-09/10 -> §3.2; REMOTE-12 -> R2 regression + §7 recovery; REMOTE-13 -> §5.3 uninstall and §10.2 uninstall awareness; REMOTE-14 -> §10.2; REMOTE-15 -> §5.1 contract tests.
- Evidence layers per overall plan 5.3: UI / Process (one Host per window, one daemon per remote root, <=1 Agent per workspace) / Protocol (handshake returns version and `sourceServerId`, writes route with Source) / Network (three transports carry the same RPC, disconnect does not kill the remote, secrets not in logs) / Persistence (migration ledger, Profile, sync results reconcilable) / Recovery (reconnect, Core crash, state after upgrade follows the rules).
- Contract tests are the only proof of "transport independence": the same case set runs against all three Adapters + a fake Core; business-layer tests are all transport-agnostic.

## 14. Observability

- Connection state machine transitions, each bootstrap phase and each migration saga phase use production `info`; automatic retry / probe failures use `warn`; unrecoverable handshake/migration failures use `error`; high-frequency details such as WS frames and probe heartbeats are always `debug`.
- `RemoteWorkspaceConnectionLog` stays attributed by `windowId + requestId`, with all bootstrap phases reported structurally (detect/upload progress/install/daemon/handshake/migration gate).
- Process Monitor gains a Source Server dimension: connection state, `sourceServerId`, daemon version, attachment count.
- Ingress token, capability, Provisioning Envelope (Personal Layer and allowlisted credentials) and SSH credentials must not appear in any log/telemetry; Provisioning result logs record only `environmentKey`, trigger, status, duration and counts.

## 15. Decided items and open confirmations

Decided on review feedback (2026-08-18):

1. **Rollback and mixed-connect compatibility**: no destructive key rewrite on the remote; use canonical key + alias resolution (§3.2/§9.2). Single-route users rolling back to an old version keep complete history and can continue; old/new mixed connects read/write the same rows; server-local cleanup waits for R4.
2. **WSL channel**: phase one uses a stdio bridge uniformly, no host-localhost direct connect (later performance option).
3. **Remote automation**: not supported in phase one (the scheduler is inside the window Host, porting cost is independent and sizable; missed-run catch-up is listed as a later capability); daemon residency paves the way and the architecture does not block it.
4. **Encryption boundary of model-config push** (formerly "one-click sync encryption", taken over by Provisioning with route A on 2026-09-07): no application-layer double encryption on the wire (the credential cipher is a local-fingerprint key, infeasible across machines, and the channel is trusted); the Source decrypts allowlisted values and the target re-encrypts with its own Credential Store before writing to disk; secrets never in logs (§8.3, provider-provisioning.md).
5. **`kind:"server"` dev entry**: uses the ingress token (same client code path).
6. **Window semantics**: phase one is designed and accepted for a single window; startup auto-reconnect runs in the main-window Host.

Open confirmations (non-blocking):

- The gray-release wording for the narrow multi-route-merge edge (§9.3: after rolling back from a merged route, that route's view cannot see merged history).
- Five items from the Provider refactor merge (merged 2026-09-13 from §7 of [r3-provider-refactor-merge.md (archived)](../archive/remote-r3/r3-provider-refactor-merge.md)):
  - If the product still needs "view / manually sync the model configuration of a remote", rebuild a read-only device view plus an explicit "push now" button on top of `IProviderSettingsService` (reusing `coordinator.requestAll("personal-config")`), without reviving the `provider-sync` / journal system.
  - The Provisioning lane Environment key is derived by `buildRemoteEnvironmentKey(target)` per transport and does not use `sourceServerId`; the same Source reached over different routes forms two lanes (idempotent results but duplicate first-connect syncs). Evaluate using `sourceServerId` as the key when the descriptor carries it.
  - `REMOTE_WORKSPACE_RPC_CONTRACT_VERSION` is still v1 although the channel set changed; it is currently backstopped by "compatibility gate defaults to same version". If `zcodeCompatibility.minCompatibleVersion` is loosened later, decide first whether to move to v2 and negotiate it in the handshake.
  - The `zcode uninstall` allowlist lacks `config/`, so `config/provider/zcode-builtin-*.json` remains in `preservedPaths` after uninstall; whether to add it to the allowlist is undecided.
  - R3-ISSUE-012 (API Key plaintext persistence spec conflict) was closed as won't-fix under the plaintext Personal Config baseline; see the issue ledger.
