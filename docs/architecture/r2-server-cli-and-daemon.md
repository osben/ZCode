# R2 Standalone Server CLI and Daemon Specification

## 1. Status and Scope

- Status: P0/P1 implemented; this hardening completes Core parent-process disconnect handling, update-pointer cleanup, and stable Server identity; Linux x64 has been verified on a real machine over SSH
- Phase: Unified multi-client remote architecture R2 / D4
- Goal for this phase: deliver a ZCode Server CLI that can be installed independently, run in the background, and is decoupled from the UI lifecycle
- Purpose: R2 implementation specification and boundaries; see the [R2 lifecycle test plan](./r2-server-cli-and-daemon-test-plan.md) for executable test supplements
- R2 does not switch Desktop's production remote-connection path

This document is based on:

- [ZCode unified multi-client remote-connection architecture and product proposal (review draft)](https://internal-docs.example.invalid/redacted)
- [R1 single window-scoped Host process refactor specification](./r1-single-window-host-refactor.md)
- [Agent Electron/Node runtime facts](../runtime-tools/agent-electron-node-runtime.md)
- [ZCode Lite / Server unified multi-client architecture implementation plan](./unified-zcode-lite-server-multi-server-plan.md)

R2 delivers:

- An independently installable `zcode` Server CLI;
- `serve`, `serve --daemon`, `status`, `stop`, `restart`, `update`, `uninstall`;
- Process boundaries for Supervisor, Server Core, and Agent;
- User-level startup services on macOS, Linux, and Windows;
- Single-instance, crash-backoff, and task-interruption semantics;
- HTTP/WebSocket ingress boundaries and R1 Host RPC compatibility verification;
- A standalone Node runtime consistent with the existing remote-asset flow.

R2 does not deliver:

- Transport Adapters for SSH, WSL, Docker, Direct URL, or WS/WSS;
- Connection discovery, installation, and connection management from Desktop Host to the Server daemon;
- A Web multi-Server Controller;
- Independent creation of a Server, Host, or Agent runtime by mobile;
- `sourceServerId`, Connection Profile, Resource Store, or a complete compatibility manifest;
- Switching Desktop to a new production remote-connection path.

## 2. Core Decisions

| Decision                      | R2 conclusion                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New code directory            | Create `packages/zcode-server-cli`; R2 adds no code to `packages/server`                                                                                                                                                                                                             |
| Existing `packages/server`    | Reference only for current HTTP/WS, stdio, remote deployment, and protocol behavior; keep its current entry points compatible                                                                                                                                                        |
| User entry point              | The standalone distribution provides `zcode`; no arguments continue to launch the existing TUI                                                                                                                                                                                       |
| Server Core                   | Implement a new Core entry point and lifecycle contract in the new directory; do not inherit process semantics from the old `entry-http` / `entry-stdio`                                                                                                                             |
| Business services             | Reuse lower-level capabilities such as `@zcode/services`, `@zcode/shared`, and `@zcode/rpc` after review                                                                                                                                                                             |
| Supervisor                    | Owns lifecycle state only, not task/session/stream/queue/snapshot business state                                                                                                                                                                                                     |
| Listen address                | Loopback address and dynamic port by default; non-loopback listening requires authentication                                                                                                                                                                                         |
| Web / WS                      | R2 implements and verifies the Core HTTP/WS ingress; specific remote transports are deferred to later phases                                                                                                                                                                         |
| Data directory                | Reuse `getZCodeDataRootDir()` and `ZCODE_DATA_BASE_DIR`; the standard directory is `<dataRoot>/server`. OS services must pass the internal argument `--server-root <absolute-path>` and must not depend on the shell environment at registration time                                |
| Node runtime                  | Use Node `v22.16.0` from the existing remote-asset flow; Server CLI does not depend on system Node or Electron Node                                                                                                                                                                  |
| Crash policy                  | Budget of 5 attempts per 5 minutes, with 1, 2, 4, 8, and 16-second backoff; after that, enter `crash-loop-stopped`                                                                                                                                                                   |
| Task recovery                 | After a Core crash or update, running Tasks are interrupted; do not automatically resume them or replay input                                                                                                                                                                        |
| stop                          | Stop the current instance but retain startup registration                                                                                                                                                                                                                            |
| uninstall                     | Stop the instance, remove service registration, and delete ZCode-owned data; do not delete Workspaces/Repos/user files                                                                                                                                                               |
| update                        | By default, download and validate online from the configured release catalog; apply a local pending release when offline; use atomic switching and rollback on failure                                                                                                               |
| Component updates             | Use content-addressed caches for five coarse-grained components: Node, server, agent, official-plugins, and native-search-tools; the complete release remains the atomic runtime unit                                                                                                |
| Platform service registration | After generating a descriptor, call the current user's launchctl / systemctl --user / schtasks. If a command is unavailable, retain the descriptor and return a diagnosable error. The OS service is the daemon's sole startup owner; Supervisor does not register the service again |

## 3. Process and Responsibility Model

```text
Installed zcode
└── bin/zcode
    ├── serve
    │   └── Supervisor
    │       └── Server Core
    │           └── Agent CLI
    ├── serve --daemon
    │   └── OS Service Manager
    │       └── Supervisor
    │           └── Server Core
    │               └── Agent CLI
    ├── status / stop / restart / update / uninstall
    │   └── Local Unix Socket / Windows Named Pipe
    │       └── Supervisor
    └── No arguments and other existing CLI commands
        └── Existing CLI/TUI bundle in the distribution
```

### 3.1 Server CLI

Server CLI is responsible for:

- Parsing Server lifecycle commands;
- Sending local control requests to Supervisor;
- Outputting human-readable or `--json` status;
- Handling interactive confirmation for update/uninstall;
- Preserving the TUI startup path without loading Server Core;
- Forwarding no-argument and non-Server-lifecycle commands to the existing CLI/TUI bundle in the distribution.

The CLI does not directly own Server business state or kill Core/Agent by raw PID.

### 3.2 Supervisor

Supervisor is responsible for:

- Acquiring and maintaining the data-root-level single-instance lock;
- Starting, stopping, and restarting Server Core;
- Receiving Core ready, heartbeat, running-task count, and exit reason over private child IPC;
- Applying crash backoff and the crash-loop circuit breaker;
- Enforcing running-task protection before update/uninstall;
- Managing platform service registration, startup, shutdown, and removal.

Supervisor does not own:

- Session content;
- Task conversation or stream;
- CommandInbox, queued prompts, or permission payloads;
- Workspace, Repo, or user-file content.

### 3.3 Server Core

Server Core is a headless business-service process responsible for:

- Composing services with `standalone-server` authority;
- Managing multiple Workspaces and Workspace Agents;
- Providing HTTP and WebSocket APIs;
- Maintaining authoritative task/session/runtime state;
- Providing Supervisor with a read-only lifecycle snapshot of the running-task count;
- Responding to SIGINT/SIGTERM and releasing service resources within bounded time.

After a Core crash, Supervisor starts a new Core. Tasks running in the old Core do not resume automatically; existing CLI/runtime cold-recovery semantics apply.

### 3.4 Agent CLI

The Agent CLI continues to run as a separate child process for each Workspace:

- Agent handles the command queue, Session, model calls, and tool execution;
- Server Core handles the lifecycle and routing between Workspaces and Agents;
- Supervisor does not directly manage Agent business state;
- Agent restarts, Core restarts, and Desktop attachment disconnections must not automatically replay accepted input.

## 4. Inter-Process Communication

```text
CLI control request ── Unix Socket / Windows Named Pipe ──> Supervisor
Supervisor ── private child IPC ──> Server Core
Server Core ── stdio/RPC ──> Agent CLI
Server Core ── HTTP/WS ──> Desktop Host / Browser / future Transport
```

### 4.1 CLI ↔ Supervisor

The local control protocol is owned by `packages/zcode-server-cli` and uses strict runtime schemas and JSONL framing. It includes at least:

- `status`;
- `stop`;
- `restart`;
- `prepare-update` / `apply-update`;
- `prepare-uninstall` / `confirm-uninstall`;
- `ping`.

The control socket/pipe must be under the current data root and use a runtime path with restricted permissions. Responses must not expose tokens, credentials, or sensitive information beyond full user paths.

### 4.2 Supervisor ↔ Core

Core sends the following over private child IPC:

- `ready`: listen address, port, Core version, and instance generation;
- `heartbeat`: monotonically increasing timestamp and running-task count;
- `task-activity`: read-only update when the running-task count changes;
- `shutdown-ack`: resources released;
- `fatal`: summary of an unrecoverable error;
- `exit`: reason for a normal or abnormal Core exit.

The running-task count must come from authoritative turn-lifecycle facts emitted by the Agent runtime inside Core; Supervisor must not
maintain a second task registry. Core-local `TaskActivityTracker` subscribes to all connected workspaces'
``turn.started` / `turn.terminal`, retains only activity keys deduplicated by `workspaceKey + sessionId`, and sends the count as a
lifecycle snapshot to Supervisor. It is not a public RPC interface and does not own content, streams, queues, or snapshots.
The Task facade and the `desktop-continuous` path that calls `IZCodeAgentService` v4 directly must feed the same tracker;
`web-remote-replayable` continues to recover clients only within its own gap/snapshot boundary; activity counts must not change the two delivery
semantics.

```text
desktop-continuous ── sendConversationCommandV4 ─┐
                                                 ├─> Agent runtime turn facts
web-remote-replayable ─ Task/Agent command ──────┘             │
                                                               ▼
                                         Core-local TaskActivityTracker
                                         key = workspaceKey + sessionId
                                                               │ count only
                                                               ▼
                                                         Supervisor guard
```

## 5. HTTP / WebSocket ingress

R2 does not design Server Core as an SSH-specific service. Web, WS, WSS, SSH, WSL, and Docker should all be different transports to the same Core.

```text
Desktop Host / Browser Web / Mobile Controller
                  │
                  ▼
       SSH / WSL / Docker / WS / WSS
                  │
                  ▼
              Server Core
```

R2 implements and verifies the following in Core:

- HTTP server-info capability;
- Web replayable WebSocket contract;
- capability-gated desktop continuous WebSocket contract;
- Delivery boundaries for `desktop-continuous` and `web-remote-replayable`;
- Propagation and isolation of `workspaceIdentity` and `workspacePath`; `remoteSessionId` is not part of the R2 Core ingress contract and remains the responsibility of the R3 Transport/Host connection layer to forward.

R2 Core is a child process of Supervisor. In addition to explicit `shutdown`, Core must listen for IPC
`disconnect`: if Supervisor is force-killed, crashes, or loses the IPC channel, Core must close HTTP/WebSocket itself, release
Agent/SQLite and other resources, and exit. It must not become an orphan process that bypasses the data-root lock. Supervisor determines instance liveness only from its own
lock ownership and must not treat an orphaned Core as safe to reuse.

```text
Supervisor ── SIGKILL/crash ──X IPC ──disconnect──> Core
                                                    │
                                                    ├─ close HTTP/WebSocket
                                                    ├─ dispose Agent/SQLite
                                                    └─ exit; port is no longer available
```

When the online catalog confirms that the current release matches the on-disk `current.json`, `prepareOnlineUpdate` deletes
a stale `pending.json` that cannot be newer than the current version. This prevents offline update from
accidentally downgrading to an older release after an online check reports “already up to date.” If pending explicitly points to a newer future version, retain it as an explicit offline candidate.

`/api/server-info.serverId` uses `install.json.installationId` as a stable installation identity. Only tests/embedded use cases that call
the Core HTTP factory without a server root fall back to the hostname. A Core started by a real Supervisor
must validate the ownership marker through `ZCODE_SERVER_ROOT` before injecting installationId.

Behavior of `/api/server-info`, `/api/rpc-host-capability`, `/ws`, `/ws/host`, and similar endpoints in existing `packages/server` serves as a compatibility reference. The new Core does not import old entry points directly; contract tests determine which boundaries to preserve.

By default, R2 listens only on a loopback address and dynamic port, and writes the actual port to `status.json`. Non-loopback listening requires explicitly configured authentication. R2 does not implement public exposure, Relay, pairing, Direct URL discovery, or Transport Adapters.

The current loopback-only ingress boundary is based on network location, not process identity: in theory, another process on the same machine that discovers the dynamic port can access ordinary `/ws` replayable RPC and request host capability. Therefore, R2 `authRequired: false` means only “caller authentication is not enabled”; it must not be interpreted as a cross-user or public-network security guarantee. This phase temporarily accepts the threat model of a controlled local machine/SSH tunnel. Before enabling Direct URL, WSS, Relay, or another non-loopback transport, add caller authentication such as a token, Unix socket peer credentials, or Windows named-pipe ACLs, and update the corresponding connection contract.

Mobile `/remote` can still attach only to an existing Desktop Host; the R2 daemon must not become an entry point for creating an independent mobile Agent.

## 6. New Code Directory and Dependency Boundaries

```text
packages/zcode-server-cli/
├── src/
│   ├── main.ts
│   ├── supervisor/
│   ├── server-core/
│   ├── ipc/
│   ├── platform/
│   ├── runtime/
│   └── packaging/
└── package.json
```

Dependency rules:

- The new Core does not depend on `@zcode/server` entry-point implementations;
- Do not modify `entry-http`, `entry-stdio`, or `build:remote` in `packages/server`;
- Reuse only reviewed `@zcode/services`, `@zcode/shared`, `@zcode/rpc`, and service types;
- Do not bundle Electron, Renderer, Desktop Main, or Window Host into the Server CLI package;
- Do not add an App ↔ Agent protocol. If that protocol must change in the future, update `packages/shared/src/zcode-protocol` separately and add schema validation;
- Use asynchronous APIs for new IO; locks, state, and release switching must be recoverable and auditable.

## 7. Installation Package and Node Runtime

R2 Server CLI does not use Electron-bundled Node and does not require Node to be preinstalled on the target server.

Current facts:

- Desktop Host/Agent use Node 24.x bundled with Electron 41;
- SSH/WSL/Docker remote assets use standalone Node `v22.16.0`;
- The CLI bundle currently targets `node22` as its minimum runtime.

R2 reuses the second remote-asset path and extends it into the distribution runtime for the standalone Server CLI:

- Pin the Node version to `v22.16.0`;
- CLI, Supervisor, Server Core, and Agent share the same Node runtime;
- Bundle the matching Node binary for each OS/architecture;
- Do not download Node at runtime;
- Bundle native dependencies such as `node-pty` for each OS/architecture;
- Root-level builds may still use Node 24+, but this does not mean the distribution runtime uses Node 24.

Distribution layout:

```text
zcode-server-<os>-<arch>/
├── bin/
│   ├── zcode
│   └── zcode.cmd
├── runtime/
│   ├── node                 # Windows uses node.exe
│   ├── package.json         # {"type":"module"} so .js entry points are parsed as ESM
│   ├── server-cli.js        # ESM bundle (tsup output, with __dirname banner)
│   ├── server-core.js       # ESM bundle; server-cli forks it using a relative path in the same directory
│   ├── zcode.cjs            # Existing CLI/Agent bundle (self-contained CJS)
│   ├── node_modules/        # External bundle dependency closure (includes node-pty platform prebuilds)
│   ├── tools/               # bfs/rg/ugrep (Windows uses rg/ugrep)
│   └── packages/            # Official plugins actually enabled by Agent
└── manifest.json
```

Use an ESM `.js` entry point instead of the originally proposed `.cjs`: the `@zcode/services` dependency chain is organized for ESM,
and bundling it as CJS is riskier. `server-cli.js` forks Core through `new URL("./server-core.js", import.meta.url)`
and delegates to the existing CLI through `zcode.cjs` in the same directory, so all three entry points must be in the same `runtime/` directory.

### 7.1 Release Package Staging

Staging is implemented in `packages/zcode-server-cli/src/packaging/stage.ts`,
and is triggered by `pnpm --filter @zcode/server-cli stage --target <os>-<arch>`. It assembles locally only; it does not upload or publish:

- Entry bundles come from this package's `tsup` output; `zcode.cjs` comes from `apps/zcode-cli/packages/cli/dist/zcode.cjs`
  (built by `scripts/build-desktop-agent-cli.mjs`, sharing the same source as the remote-asset path);
- The source of truth for `runtime/node_modules` is **output scanning**: scan top-level bare-module references in the bundles,
  intersect them with the workspace `node_modules`, recursively collect the production dependency closure, then copy it from the workspace into a flat layout;
  do not use the `tsup` external declaration list as the source of truth, avoiding drift between declarations and actual references;
- When copying `node-pty`, exclude `build/` (a locally compiled artifact that `loadNativeModule` would load first during cross-packaging, causing
  crashes on the wrong architecture). Keep only the target platform's `prebuilds/<os>-<arch>/`. The official Linux package has no prebuild,
  so add `pty.node` from the workspace `@lydell/node-pty-linux-<arch>`. On Darwin, retain the official `pty.node` and
  `spawn-helper`;
- Pin the Node binary to `v22.16.0`: first reuse the downloaded cache at `packages/desktop/mock-cdn/releases/<version>/node/<platform>/`
  and, if it is missing, download and cache the target format from nodejs.org (POSIX `tar.xz`, Windows `zip`);
- Produce both a directory layout and `zcode-server-<os>-<arch>.tar.gz` (for copying to a remote host with scp and extracting for verification);
- Staging supports six targets: `darwin-x64/arm64`, `linux-x64/arm64`, and `win32-x64/arm64`. POSIX
  produces `tar.gz`; Windows produces `zip` and `zcode.cmd`. Windows does not bundle `bfs`; it uses `rg.exe`,
  `ugrep.exe`, and retains the system/Git Bash fallback.
- The source of truth for external Agent bundle dependencies is runtime entry-point scanning plus official plugin definitions; no longer scan only Server CLI/Core,
  so runtime dependencies such as `@zcode/tui` and `playwright-core` are not missed.
- `runtime/tools` is prepared by `scripts/prepare-native-search-tools.mjs` according to the target release plan at
  `node_modules/.cache/zcode-server-cli/tools/<target>` (download when an intranet dependency source is configured; otherwise extract the repository archive),
  without reusing the mock-cdn or bundled-tools directories (remote macOS is pinned to rg13). Each tool directory also carries
  `THIRD-PARTY-NOTICES.txt` and `SOURCES.json`. At runtime, resolve it through
  `ZCODE_SERVER_RUNTIME_ROOT`; `runtime/packages` contains the seven packages that need to be seeded by the current official plugin definitions
  plugin(browser-use, document-skills, skill-creator, zcode-guide, android-emulator,
  ios-simulator, restore-legacy-sessions).

Agent wiring convention: Core in the distribution package is outside the monorepo and has no Electron runtime. Every time Supervisor starts Core,
it must recalculate wiring from that Core release's `runtime/` (`runtime/node zcode.cjs app-server
--stdio`). Do not let an old `server-cli.js` permanently write auto-derived values to global `process.env`. Explicit
`ZCODE_AGENT_SERVER_COMMAND` always takes precedence; do not inject it in development when no release runtime exists.

Separate installed programs from data:

```text
~/.zcode/server/
├── releases/<version>-<target>-<sha12>/
│   ├── runtime/
│   ├── bin/
│   └── manifest.json
├── current.json
├── pending.json
├── bin/zcode                       # Windows uses zcode.cmd; stable OS service entry point
├── service/<root-hash>.<platform>  # Generated at runtime per canonical root; explicitly passes --server-root
├── cache/components/<target>/<component>/<sha256>/
└── run/
    ├── server.lock
    ├── status.json
    └── control.sock / named pipe
```

The descriptor is not bundled in the release archive; it is written dynamically during `serve --daemon` registration by
`platform/serviceManager.ts` into `service/`. When a nonstandard `--server-root` is explicitly provided, Server CLI
also uses that directory as `dataBaseDir`, so local state such as Agent/SQLite is isolated in that root's `.zcode/` directory;
uninstall still deletes only the ZCode allowlist; unknown files are retained and listed in `uninstalled.json.preservedPaths`.

Update `current.json` and `pending.json` only through temp files plus rename. Release directories are content-addressed by archive SHA
and immutable: the installer may atomically promote a complete temporary directory only to a nonexistent `releases/<releaseId>`. If the target exists,
validate the archive identity and runtime manifest before reuse. Fail on content mismatch; never delete, overwrite, or rename
a release directory that Core may be using. On a component-cache hit, download only changed components and assemble a new release; finally,
switch `current.json` only once. On any startup failure, restore the old pointer and clean up temporary directories and partial caches.

Full archive installs and incremental component assembly must use the same immutable-promote semantics: `incoming` may be renamed only to
a nonexistent target. If the target exists, reuse it only after validating the full release identity and content hash. Whether reused or failed,
clean up any `incoming` that was not promoted. Do not move an existing target to a backup to publish new content; it may already have become active
after another concurrent update completes.

For update rollback, first stop the new Core that is not ready, then restore the old pointer and start the old release. A Core that has timed out but is still alive
must not coexist with the rolled-back old Core:

```text
apply pending
    │
    ▼
new Core ── ready ───────────────────────────────> commit
    │
    ├─ spawn error + close (no exit) ─┐
    └─ timeout / fatal / exit ────────┴─> stop if alive ─> restore current ─> old Core ready
```

The `error`, `exit`, and `close` events from `fork()` must converge on the same Core terminal-state entry point, which runs at most once. A spawn error
is also a recoverable startup failure and must be handled by Supervisor and counted against the crash budget; it must not become an unhandled event that crashes Supervisor
. A running ChildProcess `error` does not by itself mean the process has exited. The stop flow may release the data-root lock only after observing `exit`/`close`;
if shutdown is still incomplete after SIGKILL, enter `stop-failed`, retain the Core reference and lock, and prohibit starting a replacement Core.

Supervisor's `stop`, `restart`, `apply-update`, and `confirm-uninstall` share one lifecycle operation gate.
Idempotent stops of the same kind may reuse the current Promise; other concurrent write operations immediately return retryable `operation-in-progress` and are not queued.
Core IPC listeners must bind to a specific child and generation; discard all messages from noncurrent children. When Core terminates or is replaced,
clear host, port, startedAt, and runningTaskCount so interrupted tasks cannot contaminate the next generation's guard.

The OS service is the sole startup owner for `serve --daemon`. The descriptor command must point to the stable entry under the data root
`<serverRoot>/bin/zcode` (`zcode.cmd` on Windows), with fixed arguments `serve --supervisor --service-entry
--server-root <absolute-path>`. Do not record the absolute path to the `server-cli.js` release used at registration. After the CLI registers and starts the
service, it waits for the existing Supervisor to report ready; the service entry must not register itself again or fork a second Supervisor.
Only the OS service entry reports `serviceRegistered=true`; a detached fallback that explicitly skips service registration
must report false. If service-manager registration fails, retain the descriptor and return a diagnosable error; do not make a fallback
look like a successful registration. `update` switches Core immediately; the Supervisor's own new release code takes effect on the next daemon-process
lifecycle (when the OS service starts it again). R2 does not perform an in-process bootstrap handoff in the apply-update response. A normal exit requested by `stop`
must not be automatically restarted by launchd, while abnormal exits continue to use the service manager's restart semantics.

OS service identities must be isolated by canonical server root. Derive launchd Labels, systemd
unit names, Windows task names, and descriptor filenames from a stable root hash. When cleaning up a legacy fixed service ID, uninstall it only if the old descriptor
has a canonical `--server-root` matching the current root; do not accidentally remove another root's service.

`--server-root` is an internal global parameter for service/fallback daemons; its value must be an absolute path. The CLI's control
endpoint, status, release, service descriptor, and uninstall all resolve the same layout from this parameter. Core/Agent
also receive the corresponding `ZCODE_DATA_BASE_DIR`. A daemon with a custom data root must therefore not create a second
status, lock, Core, or SQLite under the default root.

Incremental component assembly first copies from the old release, then deletes old paths declared by changed or removed components, then extracts the new components and
validates the new manifest. This prevents files from removed plugins/tools and other components from carrying over to the new release.

R2 must prepare at least the following platform assets:

- `darwin-x64`, `darwin-arm64`;
- `linux-x64`, `linux-arm64`;
- `win32-x64`, `win32-arm64`.

## 8. CLI Command Semantics

```bash
zcode                  # No arguments still launch the TUI
zcode serve            # Foreground Server Core
zcode serve --daemon   # Register and start the daemon
zcode status
zcode stop
zcode restart
zcode update
zcode update --force
zcode uninstall
```

| Command          | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve`          | Run Supervisor/Core in the current CLI process; do not register OS startup; exit within a bounded time after a termination signal                                                                                                                                                                                                                                                                                                                  |
| `serve --daemon` | Install/reuse the current user's service registration and start/reuse Supervisor/Core                                                                                                                                                                                                                                                                                                                                                              |
| `status`         | Return registration status, Core state, PID, port, version, most recent exit reason, and crash budget                                                                                                                                                                                                                                                                                                                                              |
| `stop`           | Ask Supervisor to stop Core; retain startup registration                                                                                                                                                                                                                                                                                                                                                                                           |
| `restart`        | Stop and restart within bounded time; do not automatically resume interrupted Tasks                                                                                                                                                                                                                                                                                                                                                                |
| `update`         | Fetch the new release for the current target from the catalog (or use an existing pending release), validate/install it, then apply it; if the catalog and current archive match, return successful `up-to-date` and do not request apply again; if no catalog is configured and no pending release exists, return an explicit release-source error; when Tasks are running, return an actionable guard error by default without interrupting them |
| `update --force` | Explicitly allow interrupting running Tasks before applying the release                                                                                                                                                                                                                                                                                                                                                                            |
| `uninstall`      | Check for running Tasks (reject and preserve the original state if any are running), require entering `DELETE` twice, stop and remove the service, and delete allowlisted ZCode data                                                                                                                                                                                                                                                               |

`uninstall` may delete:

- R2 program releases;
- Supervisor/Core runtime records;
- ZCode configuration, caches, and runtime records;
- ZCode-owned state databases and logs.

`uninstall` must not delete:

- Workspace files;
- Git repositories and worktrees;
- Other files in the user's home directory;
- External directories explicitly specified by the user;
- Any path that does not pass canonical-path and allowlist validation.

When initializing a server root, write an ownership marker with a strict schema to `install.json`, including product, schema version,
canonical server root, and installation ID. `uninstall` may automatically clean up only if the root after `realpath` matches this marker;
otherwise, reject and instruct the user to handle it manually. Uninstall deletes only allowlisted items such as `releases/`, `run/`, `cache/`,
`bin/`, `service/`, `current.json`, `pending.json`, and the ownership marker. Unknown files inside the server root
must be retained and listed in the result's `preservedPaths`. After completion, write `uninstalled.json` under the retained root with the uninstall timestamp
and version. R2 does not implement a Controller UI.

## 9. Data, State, and Invariants

```text
OS Service Manager
└── Supervisor lifecycle state
    ├── release / PID / port / registration
    ├── crash budget / backoff
    └── update / uninstall operation

Server Core
└── authoritative business state
    ├── workspace / task / session
    ├── command queue / stream
    └── Agent runtime lifecycle

Workspace / Repo / User files
└── user-owned state; R2 is not responsible for deleting it
```

Must remain true:

- Single-instance key = current OS user + data root;
- Stale-lock recovery must first atomically claim the lock to an isolated path using the ownership token; release may delete only a token that still belongs to it. Never delete the current path based on a single stale PID check;
- Lock and recovery-gate records are published only complete: write the full record to a unique temp file next to the target, fsync it, then `link()` it to the target (exclusive, fails with EEXIST) and remove the temp file. A live owner therefore never exposes an empty or partial record, so unparseable content at the target means a crash or corruption and is recoverable like a stale lock. Leftover temp files never block acquisition. Only when the filesystem does not support hard links may the writer fall back to exclusive create-then-write, which reopens that window;
- Workspace isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`;
- Path operations continue to use `workspacePath`;
- Remote identity must not use `workspacePath` alone;
- Supervisor does not create a second CommandInbox or Task queue;
- Desktop `continuous` does not append Web `replayable` recovery messages;
- Mobile `replayable` does not bypass gap/snapshot recovery;
- Core crashes, updates, and uninstalls do not automatically resume interrupted input;
- Main, Relay, and future transports do not own business state;
- Production logs use `createServiceLogger`; high-frequency heartbeat/RPC details use debug; never log secrets.

## 10. Implementation Order

1. Keep this document as the R2 spec and supplement it with the [R2 lifecycle test plan](./r2-server-cli-and-daemon-test-plan.md); first update the case catalog and coverage matrix for cases involving conversations/sessions.
2. Create the CLI, IPC, runtime layout, and contract schemas in `packages/zcode-server-cli`; write tests first.
3. Implement the single-instance lock, state files, canonical-path validation, and allowlist validation.
4. Implement the new Server Core entry point, connect `standalone-server` services, and provide HTTP/WS ingress.
5. Implement Supervisor, private Core child IPC, crash budget, and running-task guard.
6. Implement adapters for macOS launchd, Linux systemd --user, and Windows Task Scheduler.
7. Implement Server CLI command routing, lazy delegation to the TUI/existing CLI, `--json`, and confirmation flows.
8. Implement staging for the six-platform Node runtime, node-pty, native search tools, and official plugins; do not change the `packages/server` build entry point.
9. Implement ReleaseCatalog/Downloader/Installer, content-addressed component caches, atomic current/pending switching, and rollback on failure.
10. Complete real OS service-manager adapters, online-download contract tests, Windows contract tests, and R1 Host RPC compatibility.
11. Run `pnpm typecheck`, `pnpm lint`, new-package tests, and the conversation coverage audit.

## 11. Acceptance Cases

| Case      | Acceptance goal                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| R2-CLI-01 | No arguments do not load Server Core; the TUI still launches                                                                   |
| R2-CLI-02 | Foreground `serve` starts Core, listens on a dynamic loopback port, and becomes ready                                          |
| R2-CLI-03 | `serve --daemon` registers the platform service and starts Supervisor                                                          |
| R2-CLI-04 | Repeated startup reuses the current instance and does not create a second Core                                                 |
| R2-CLI-05 | `status`, `stop`, and `restart` converge to an idempotent state                                                                |
| R2-CLI-06 | Core crash backoff is 1/2/4/8/16 seconds; exceeding the budget trips the circuit breaker                                       |
| R2-CLI-07 | Running Tasks are interrupted after a Core crash and do not resume automatically                                               |
| R2-CLI-08 | When no Tasks are running, update atomically switches the release and becomes ready                                            |
| R2-CLI-09 | When Tasks are running, update returns a guard error without interrupting them by default; only `--force` permits interruption |
| R2-CLI-10 | uninstall requires `DELETE` confirmation twice and removes service registration                                                |
| R2-CLI-11 | uninstall retains Workspaces, Repos, and user files                                                                            |
| R2-CLI-12 | HTTP/WS ingress passes server-info, Web replayable, and Host continuous contract tests                                         |
| R2-CLI-13 | Different data roots are isolated; the single-instance lock does not affect other roots                                        |
| R2-CLI-14 | Service descriptors and Node runtimes start on macOS/Linux/Windows                                                             |

## 12. Release and Rollback

R2 is verified only in internal environments and does not change Desktop's current production remote connection. Before release, all of the following must be true:

- Install, start, stop, restart, and uninstall succeed;
- Single-instance and crash-loop behavior is stable;
- Node runtime and native dependencies pass the three-platform matrix;
- R1 Host RPC boundaries pass contract tests;
- No Workspace/Repo/user files are deleted by mistake;
- Logs do not expose secrets;
- `pnpm typecheck` and `pnpm lint` pass.

On failure, roll back only the current Server CLI release or Desktop version. Do not perform destructive database migrations or switch/repair the existing `packages/server` remote path.
