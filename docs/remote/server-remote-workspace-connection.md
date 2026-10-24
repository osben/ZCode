# Server Remote Workspace Connection

> **Status (2026-09-13)**: the `kind:"server"` direct connection is still a dev-only entry wired to the
> ingress token (main spec §6.1, §15 item 5); this document's Server interface, service ownership and Realtime
> boundary descriptions still apply. The process model stated in the text ("SSH and WSL pool connections in
> the Host, Docker/Server use a dedicated connection") belongs to the pre-R3 main chain; SSH/WSL/Docker now
> all use the Source Server main chain, see `docs/architecture/r3-source-server-remote-architecture.md` §4.

## Background

The Desktop App can create remote workspaces over SSH / WSL / Docker / Server. Each BrowserWindow has one
independent Window Host shared by the local and remote workspace tabs of that window; SSH and WSL pool
connections inside the Host, and Docker/Server use the dedicated connection of a logical session. The Host
exposes the service/CLI scope of the matching workspaceKey to the renderer, and the registry is not shared
across BrowserWindows.

In Web mode the remote server already exposes `/ws` and hands a `ServiceCollection` to the Web UI through
`ChannelServer`. This can be reused by the Desktop App, but it is not the same chain as SSH remote: Desktop
should no longer deploy or start a remote runtime, but connect to an already running ZCode server and use the
App UI to manage that server's workspaces, tasks, files, git and terminal.

## Goals

- Add a remote target kind `server` that connects to a running ZCode Web/HTTP server.
- Desktop opens a server remote workspace the way it opens an SSH remote workspace.
- The remote server keeps the workspace runtime, ZCode session/task, agent runtime, file system, git, terminal and workspace-level capability state.
- Local Desktop keeps only the window, UI shell, server credentials, connection lifecycle and the workspace tab/session binding.
- No change to existing SSH / WSL / Docker remote workspace behavior.
- Mobile `/remote` replayable recovery semantics are not spread to the Desktop App continuous main chain.

## Non-goals

- Starting a new ZCode Agent runtime on the local Desktop machine for server remote.
- Letting Desktop main parse or store ZCode task/session/stream business state.
- Treating the bare `/ws` as a production interface to expose long-term on the public internet.
- The first version does not promise locally queued messages survive a disconnect; sending is disabled when disconnected and aligned with the remote snapshot after reconnect.
- The first version does not let the Desktop App create new SSH / WSL / Docker sessions nested inside a remote server; server remote only connects to existing servers.

## Process model

After R1 the Server connector runs inside the window's single Host and creates no extra connector Host
process. The remote server wire contract is unchanged.

```text
Desktop renderer
  -> RemoteWorkspaceSessionStore
  -> MessagePort
  -> Window Host / remote-scoped attachment
      -> RemoteConnectionRegistry / dedicated server connection
      -> Node WebSocket wss://<server>/ws
      -> SocketProtocol
      -> ChannelClient
      -> RemoteServiceAccess
  -> remote ZCode server
      -> ChannelServer
      -> ServiceCollection
      -> ZCode task/session/agent runtime
      -> remote filesystem / git / terminal
```

The connector stays in the Node Host instead of the renderer connecting directly, because:

- WebSocket auth headers, system proxy, TLS/certificates and network diagnostics fit the Node side better.
- The renderer keeps consuming only `IServiceAccessor`, consistent with the existing remote workspace UI structure.
- Main only thinly forwards connection control requests and the MessagePort, and carries no RPC frame details or reconnect state machine.

## Connection sequence

```text
User selects "Connect server"
  -> renderer validates form
  -> main forwards ConnectRemoteWorkspace to Window Host
  -> Window Host allocates remoteSessionId and creates dedicated connection
  -> connector calls GET /api/server-info
  -> connector opens wss://server/ws with auth
  -> connector creates RemoteServiceAccess
  -> Window Host exposes scoped MessagePort; main transfers it to renderer
  -> renderer registers remote session
  -> UI loads workspace state from remote services
```

Reconnect:

```text
WebSocket close
  -> connector reports disconnected
  -> renderer marks remote workspace disconnected
  -> UI disables send / terminal write
  -> connector reconnects or user clicks reconnect
  -> new ChannelClient is created
  -> renderer re-registers services
  -> UI calls list/read snapshot APIs to converge
```

## RemoteTarget and workspace identity

New target type:

```ts
type ServerRemoteTarget = {
  kind: "server";
  url: string;
  name?: string;
  tokenRef?: string;
  workspacePath?: string;
  serverId?: string;
};
```

Identity isolation keeps the existing rule:

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

The `workspaceIdentity` of a server remote must be built by the unified `buildRemoteWorkspaceIdentity()` in
the form:

```text
remote:server:<serverId>:<workspacePath>
```

`workspacePath` keeps expressing only the actual execution path on the remote server; tab dedup, session
binding, cache keys, queue keys and persistence keys use the `workspaceIdentity` fallback rule.

## Server interface

The existing `/ws` can stay the RPC entry but needs a production bootstrap and authentication:

```text
GET /api/server-info
  -> serverId
  -> version
  -> protocolVersion
  -> authRequired
  -> workspaces[]

GET /api/health
  -> ok

GET /ws
  Authorization: Bearer <token>
```

The bare `/ws` used in deployment verification suits only a controlled intranet or temporary debugging. A
production entry must enable a token or equivalent authentication, and logs must not record the raw token.

## Service ownership

Server remote cannot fully reuse the SSH remote service merge strategy. SSH remote still has much app-global
state authoritatively managed by local Desktop; server remote is more like connecting to a complete running
remote ZCode instance, so workspace/runtime-related state should follow the server.

Recommended first-version ownership:

```text
Local Desktop authority:
  - theme / locale / window state
  - server target list
  - server token credential
  - desktop-only platform actions

Remote server authority:
  - file / git / terminal / file watcher
  - zcodeTask / zcodeSession / zcodeAgent
  - skills / plugins / MCP / commands for remote workspace
  - model provider registry used by the remote runtime
  - workspace-level settings and task/session persistence
```

This needs a new `buildServerRemoteWorkspaceSessionServices()`; SSH's `buildRemoteWorkspaceSessionServices()`
must not be applied directly.

## Realtime and queue boundary

When the Desktop App connects to a server remote it is still a Desktop continuous client:

```text
Desktop server remote:
  clientMode = desktop-continuous
  deliveryKind = continuous
  reconnect recovery = read snapshot / list tasks

Mobile /remote:
  clientMode = web-remote-replayable
  deliveryKind = replayable
  reconnect recovery = mirror gap + snapshot watermark + pendingCommands
```

First-version send strategy:

- connected and task ready: send through the existing remote `zcodeTaskService` / `zcodeAgentService` path.
- disconnected: sending is disabled and nothing piles up in a local renderer queue.
- The stream of a running task is held by the remote server; a Desktop disconnect does not kill the remote runtime.
- After reconnect the UI aligns with the remote session/task snapshot.

If the product later requires that prompts submitted during a Desktop disconnect are not lost, server remote
desktop sending should be switched separately to a host-accepted command queue, explicitly without affecting
the local Desktop continuous main chain.

## UI entry

The existing Remote Connection dialog gains a `Server` type, currently open only in the local development
runtime form:

```text
Remote Connection
  - SSH
  - WSL
  - Docker
  - Server
```

Display boundary:

- Local Vite development, or Desktop platform explicitly marked `isLocalDevelopmentRuntime = true`: show the `Server` type card.
- Desktop packaged in production mode (official and preview builds): do not show the `Server` type card, even if the product environment is configured as `test`.
- The gate uses only the local development runtime form, not `ZCODE_ENV` or intranet probing; the display rules for SSH / WSL / Docker are unaffected.

Server form fields:

- Server URL
- Display name
- Token / credential
- Workspace selector (from `/api/server-info`; if there is no workspace list, allow typing a path)

After a successful connection the sidebar shows it as a remote workspace. Disconnect state, reconnect button
and error log reuse the existing remote workspace UI patterns, with copy distinguishing "Server connection"
from "SSH connection".

## Verification plan

- Unit: `ServerRemoteTarget` schema, workspace identity construction, URL normalizer, token redaction.
- Unit: connector host reconnect state machine.
- Unit: server remote service merge does not misuse the SSH merge strategy.
- Integration: mock `/api/server-info` + `/ws` ChannelServer; verify the renderer can register a remote session and read workspace state.
- Integration: after WebSocket close the UI marks disconnected and re-reads the snapshot after reconnect.
- E2E: Desktop connects to a local test server, sends a prompt, and the task stream shows normally.
- Regression: SSH / WSL / Docker remote connections are unaffected.
- Regression: mobile `/remote` still attaches the existing host and adds no independent runtime.

## Current implementation status

- `RemoteTarget` / settings snapshot gained `kind: "server"`; the server token is persisted through a credential key.
- The Server HTTP entry gained `GET /api/server-info`, returning `serverId`, version, protocol version, workspace list and the desktop continuous capability flag.
- The Desktop host connects to an existing server's `/ws` through a Node WebSocket and relays RPC with `RemoteServiceAccess`, without entering the SSH/WSL/Docker backend deployment chain.
- Desktop server remote does not enable `relay_bridge` and keeps desktop continuous semantics; mobile `/remote` replayable recovery boundaries are not spread to server remote.
- The Renderer uses a server-authoritative service merge for server remote; SSH/WSL/Docker keep the original local-global services + remote workspace services strategy.
- The runtime Provider Registry of a server remote stays server-authoritative; the Desktop model settings page edits only the Local Environment, the first-connection `onlyIfMissing` Provisioning is the only automatic copy entry, and there is no manual Local -> Server sync action while running.
- The UI remote connection wizard gained the Server type and the URL / name / token / default directory fields in the local development runtime form; production-mode packaging does not show this type.

## Open questions

- Whether server remote allows only HTTPS/WSS, or HTTP/WS in development.
- Whether one server can expose several workspaces; if so, the permissions and refresh strategy of the workspace list must be defined in `/api/server-info` or a separate `/api/workspaces`.
- When several Desktop Apps connect to the same server, whether the UX for task owner, permission and elicitation should show the current owner/client info.
