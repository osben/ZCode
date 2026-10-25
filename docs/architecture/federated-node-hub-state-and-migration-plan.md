# Federated ZCode Node / Hub State and Migration Plan

## Status

- Document status: Architecture draft, pending product decision.
- Scope: A single Desktop or Browser Web instance manages the local machine and multiple ZCode Lite / Server Nodes at the same time.
- This document plans a unified process model, communication stack, state authority, task aggregation, extension capabilities, and legacy data migration; it does not modify existing product code.
- Confirmed upper-level architecture boundaries:
  - Desktop UI and Browser Web are both unified UIs.
  - TUI is a local Node capability, not a cross-remote UI.
  - SSH / WSL / Docker handle bootstrap, discovery, and transport; the business protocol ultimately connects to the same Node Runtime.
  - Mobile `/remote` is a remote UI attachment to an existing Hub; it does not create a separate Node runtime.
  - Desktop `desktop-continuous` and Browser / mobile replayable retain different delivery semantics;
    in the target state, Browser and mobile will also have distinct trusted connection roles.

## Feature Impact Brief

### Change layers

| Layer         | Changes in this plan                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| option-source | Model catalog becomes account-level desired configuration; Skill / Plugin / Subagent candidates come from the target Node's actual capabilities. |
| draft-default | New-task model defaults come from the account-level model Profile; existing Sessions continue using their own runtime configuration.             |
| validation    | Check the target Node's model and credential readiness before creation and sending; check target Node capabilities for extension operations.     |
| commit-effect | Route Task / Session commands only to the Task's source Node; the Hub does not execute business commands.                                        |
| persistence   | Introduce stable Node / Workspace identities, cross-node view configuration, Hub catalog cache, and migration ledger.                            |
| recovery      | Recovery protocols are needed for multi-Node cursors, node outages, topology changes, dual-database migration, and legacy identity aliases.      |

### Current facts

1. Persistent Task list rows come from each endpoint's `tasks-index.sqlite`; the CLI Session Store remains authoritative for Session runtime and content. The current UI fetches all active / pinned / archived Tasks from every endpoint, then merges, sorts, and trims them in the renderer.
2. `ZCodeTaskListQuery` has only `limit`, not a cursor; “show more” currently rereads the entire prefix.
3. Custom groups are currently stored in one `tasks-index.sqlite` in
   `task_groups / task_group_members / task_group_view_node_orders`. Sorting uses the user's explicit order,
   not time order; the current Grouped view explicitly does not aggregate remote endpoints.
4. The authoritative App model configuration file is `~/.zcode/v2/config.json`. Provider metadata, Base URL, and
   custom API keys are still mixed together in the same config / registry snapshot.
5. SSH / WSL currently have mixed authority:
   - Files, Git, Terminal, Agent, Task, Skills, and Plugins are remote;
   - Settings, Credentials, and Model Providers are on Desktop;
   - the Subagent settings service remains on Desktop, but the remote CLI runtime actually reads remote definitions and state, splitting the source of truth.
6. Legacy SSH Task data is actually written to two databases on the target machine:
   - `~/.zcode/v2/tasks-index.sqlite`
   - `~/.zcode/cli/db/db.sqlite`
7. The legacy SSH workspace key has this format:

```text
remote:ssh:<host>:<port>:<username>:<workspacePath>
```

Connecting to the same target machine through different hostnames, ports, usernames, or SSH aliases produces different keys.

8. SSH / WSL / Docker currently reuse
   `IRemoteBackend -> deployServer -> connectRemote -> zcode-server`, but process reuse and cleanup remain inconsistent:
   - SSH: a Host is shared by the same window and SSH identity, and usually remains until the window closes;
   - WSL: a Host is shared by the same window, distro, and user, using workspace generation and a 60-second idle TTL;
   - Docker: each remote session gets a dedicated Host, and closing the session reclaims the entire runtime.
9. SSH / WSL / Docker currently start a foreground stdio `zcode-server`. Its lifecycle is owned by the Desktop Host;
   it does not listen on a persistent port. Connection EOF or Host exit triggers Server and Agent cleanup.
10. ZCode Lite currently uses `entry-http.js` to create a different, long-lived HTTP / WebSocket Server. It and the stdio Server
    both call `createLocalServices()`, but their entry points, authentication, connection reuse, and lifecycles remain separate.
11. Mobile `/remote` currently attaches through the relay to a Local / Remote Host in an existing Desktop window; relay and Desktop main
    only forward `rpc-frame` and attachment controls and do not own task / session / stream / queue / snapshot.

### Invariants that must be preserved

1. The business source of truth for Task / Session / Stream / Queue / Snapshot exists only on the Task's source Node.
2. Hub, relay, and Desktop main do not hold conversation business state.
3. Global Task identity can no longer use only `taskId`; it must use at least:

```text
GlobalTaskRef = { nodeId, workspaceId, taskId }
```

4. `workspacePath` is used only for I/O and display on the target Node; it cannot remain the permanent cross-machine identity.
5. The Session runtime remains authoritative for the provider / model / thought of an existing Session; account model configuration provides only
   the catalog, defaults, and seeds for new Sessions, and cannot rewrite historical Sessions in bulk.
6. Node-local Skills / Plugins / Subagents must not be presented as “available to the current Task” by taking the union of candidates from multiple Nodes.
7. Mobile `/remote` sees only Nodes connected to or cached by a paired Hub; it cannot bypass the Hub attachment to create a
   Node runtime directly.
8. The UI must not declare a trusted `clientMode` itself; the Hub / Node attachment must inject Desktop continuous and Browser / Mobile replayable modes
   based on the authenticated connection role.
9. SSH / WSL / Docker bootstrap only “reaches the Node”; it must not own the lifecycle of the workspace, Agent, or conversation.

## Target architecture

```text
                         Account Control Plane
                  ┌────────────────────────────────┐
                  │ Model Profile                  │
                  │ Credential policy / bindings   │
                  │ Federated Task View Profile    │
                  └───────────────┬────────────────┘
                                  │ revision sync
                  ┌───────────────┴────────────────┐
                  │                                │
          Browser Web on A                  Desktop UI on C
                  │                                │
             Federated Hub A                  Federated Hub C
             ┌────┴────┐                    ┌──────┼──────┐
             │         │                    │      │      │
          Node A     Node B               Node A Node B Node C
             ▲
             │ local/in-process
          TUI on A

Mobile /remote
  -> relay
  -> Hub C attachment
  -> Connected Nodes A / B / C
```

Constraints:

- A Hub connects only to the Node plane; it does not recursively connect to another Hub, avoiding loops, duplicate aggregation, and identity ambiguity.
- The Browser Web Hub runs in the Lite / Server process it connects to; the Desktop Hub is an app-wide standalone process supervised by Electron Main
  and shared across multiple windows. It does not belong to any per-window Host.
- The Node is authoritative for its local workspace, task, session, file, git, terminal, resource, and extension inventory.
- The Account Control Plane is a logical interface that can be implemented by the ZCode account service, a self-hosted sync service, or an offline local Profile;
  cloud implementation details are not hard-coded into Node RPC.

## Unified process and communication model

### The model in one sentence

```text
Desktop / Browser / Mobile UI connects only to the Hub
TUI connects only to the local Node
The Hub connects only to Nodes
The Node owns local business services and workspace runtimes
The Node lazily starts a ZCode Agent per workspaceKey
SSH / WSL / Docker are only bootstrap + tunnel adapters
```

The goal is not to put everything into one process, but to let different deployment models reuse the same logical roles and protocol contracts.

### Logical roles

| Role                       | Quantity and location                                            | Responsibilities                                                                                                           | Explicitly not responsible for                                                           |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| UI Client                  | Desktop Renderer, Browser Web, Mobile Web                        | Displays a unified Node / Workspace / Task view and submits user intent                                                    | Does not own business authority, SSH directly, or start Agents                           |
| ZCode Hub                  | One per Desktop instance; one per Lite Web origin                | Node registry, connection management, Task Summary aggregation, offline catalog cache, account Profile sync, UI attachment | Does not execute file commands, assemble conversations, or own queue / stream / snapshot |
| ZCode Node                 | One stable instance per target machine, WSL distro, or container | Workspace Registry, file/git/terminal, Task Index, Resource Store, Agent manager, extension inventory                      | Does not aggregate other Nodes or recursively act as a remote Hub                        |
| ZCode Agent                | At most one primary chat runtime per active workspaceKey         | Session, V4 CommandInbox, projection, stream, permission, tool, model runtime                                              | Does not manage cross-Node connections or UI layout                                      |
| Bootstrap / Tunnel Adapter | One short-lived connector per SSH / WSL / Docker connection      | Installs, upgrades, and discovers a Node; establishes a byte tunnel to the Node endpoint                                   | Does not create a second ServiceCollection or store business state                       |
| Relay                      | Optional external infrastructure                                 | Authenticates and pairs mobile with Hub, handles heartbeat, forwards opaque frames                                         | Does not parse Node / task / session or create replayable snapshots                      |
| Account Control Plane      | Account service, self-hosted service, or offline implementation  | Model Profile, Credential policy, Federated View revision                                                                  | Does not carry live conversations                                                        |

### Desktop process model

```text
Desktop machine C
┌─────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                       │
│ - Windows, native APIs, process supervision, MessagePort dispatch  │
│ - Does not own Node registry / task / session                       │
│                                                                     │
│ ├─ Renderer Window 1 ─┐                                             │
│ ├─ Renderer Window 2 ─┼─ MessagePort ──> App-wide ZCode Hub Process │
│ └─ Mobile relay ──────┘                         │                    │
│                                                ├─ local connector   │
│                                                ├─ direct WSS        │
│                                                ├─ SSH tunnel        │
│                                                ├─ WSL tunnel        │
│                                                └─ Docker tunnel     │
└────────────────────────────────────────────────┼────────────────────┘
                                                 │
                         ┌───────────────────────┼──────────────────────┐
                         ▼                       ▼                      ▼
                      Node A                  Node B                 Node C
```

In the target state, a business Remote Host is no longer created per window for each SSH / Docker workspace. Desktop main supervises one
app-wide Hub; multiple windows and mobile attachments reuse the Hub's Node connection pool. Each UI attachment
still has its own connection / subscription scope; physical connection reuse must not cause delivery buffers to be shared.

Desktop local capabilities also use the same Node contract:

```text
Desktop Hub
  -> Discover an existing local Node daemon
  -> If none exists, Main supervises startup of an embedded Node Process
  -> MessagePort / named pipe / loopback socket
  -> Local Node Core
```

The Node data directory must have a single-owner lock. If the user has already started a Node against the same data directory through ZCode Lite,
Desktop must reuse it rather than start a second SQLite / Agent owner.

### ZCode Lite / Browser Web process model

```text
zcode-lite serve
┌──────────────────────────────────────────────────────────────┐
│ Lite Supervisor                                              │
│ ├─ Node Core / Node Process                                  │
│ │   ├─ Workspace Registry / Task Index / Resource Store      │
│ │   └─ Agent A / Agent B ...                                 │
│ ├─ Hub Core / Hub Gateway                                    │
│ │   ├─ local Node A connection                               │
│ │   └─ remote Node B / C connections                         │
│ └─ HTTP Gateway                                              │
│     ├─ /                 Web static assets                     │
│     ├─ UI <-> Hub endpoint                                   │
│     └─ authenticated Hub <-> Node endpoint                   │
└──────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ same-origin WSS                  │ HTTPS/WSS
   Browser Web on A                   Desktop Hub C
```

Lite may expose only one port externally, but roles within the port must remain separate:

```text
Browser UI role  -> Hub endpoint
Remote Hub role  -> Node endpoint
Admin/bootstrap  -> Limited Node discovery / pairing endpoint
```

The same HTTP listener does not imply the same permissions. A Browser session cookie does not automatically grant trusted Hub-to-Node permissions;
the Desktop Hub requires a separate token, mTLS, or one-time capability.

The MVP may place Node Core, Hub Core, and HTTP Gateway in one Node.js process to reduce installation complexity, but they must use
separate service collections, identities, and lifecycle interfaces. They can be split into separate processes later without changing the protocol.

### Mapping current entry points to target entry points

| Current implementation                    | Current semantics                                                      | Target migration                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `entry-http.ts -> createLocalServices()`  | Lite HTTP process directly owns Node services                          | Extract Node Core; add a separate Hub Gateway to the same listener                       |
| `/ws`                                     | Browser connects directly to Node services with fixed replayable       | Browser connects to the Hub endpoint; Hub routes to local / remote Nodes                 |
| `/ws/host`                                | Desktop Node Host connects directly to Node with a one-time capability | Keep as a trusted Hub-to-Node endpoint and extend with stable identity and reconnect     |
| `entry-stdio.ts -> createLocalServices()` | Each SSH / WSL / Docker connection starts a business Server            | Migrate to a bootstrap / tunnel shim; business logic runs only in the stable Node daemon |
| per-window Remote Host                    | Window-scoped SSH / WSL pool; dedicated Docker                         | app-wide Hub connector pool                                                              |
| Desktop Main mobile bridge                | Relay frame reaches a Host already owned by a window                   | Relay device transport reaches a Hub logical attachment                                  |

Current Browser Web reads only one `ZCODE_SERVER_WORKSPACE` and cannot manage a dynamic workspace catalog; ordinary Web
also cannot fully handle temporary attachments for long text. The target Hub / Workspace Registry and Resource Store must first implement these contracts,
before cross-Node Web management is opened; merely displaying the UI entry point is insufficient.

### TUI

TUI is a local client in the Lite / Node installation package and does not participate in cross-Node aggregation:

```text
TUI on A
  -> local socket / in-process adapter
  -> Node A
  -> workspace Agent
```

It may reuse the Node API and V4 conversation protocol, but does not provide an SSH management entry point or act as a Hub for other machines.

### One binary, multiple roles

The recommendation is to ultimately ship one runtime and distinguish roles with subcommands:

```text
zcode node serve       # long-running Node daemon
zcode node connect     # byte bridge only: stdio <-> local Node socket
zcode hub serve        # independently runnable Hub Gateway
zcode lite serve       # supervises local Node + Hub + Web static entry point
zcode tui              # local UI, connects directly to local Node
```

`zcode node connect` does not call `createLocalServices()` or start an Agent; it is only a transport shim for cases where SSH / WSL / Docker
cannot directly forward a local socket.

### Authority and Transport are orthogonal

`ssh`, `direct URL`, or `local socket` describes only how to reach a Node; it must not implicitly determine the authority for models, credentials, and settings.

```text
Transport:
  local | direct-wss | ssh-tunnel | wsl-tunnel | docker-tunnel

Authority profile:
  account-managed
  hub-attached-compat
  node-standalone
```

- `account-managed`: the account Model Profile is the desired configuration; the Node uses its own credential binding / lease.
- `hub-attached-compat`: refers only to the retired historical Desktop Registry push model, not a current compatibility mode.
- `node-standalone`: an offline or self-hosted Node uses its local Profile / vault.

Changing the same Node from an SSH tunnel to direct WSS must not change its task, workspace, model, or extension identity.

## Communication stack

### Separate protocol and carrier layers

```text
Business layer
├─ Hub Protocol
│  ├─ Node registry / connection status
│  ├─ federated Task Summary query
│  ├─ account profile / view profile
│  └─ route(GlobalWorkspaceRef / GlobalTaskRef)
├─ Node Service Protocol
│  ├─ workspace / file / git / terminal / task index
│  ├─ extension inventory / readiness
│  └─ resource begin / chunk / commit
├─ ZCode Protocol V4
│  ├─ command ACK / query
│  ├─ conversation / sessions-index / workspace-config topic
│  └─ snapshot / delta / gap recovery
└─ Bootstrap Protocol
   ├─ install / upgrade / discover
   └─ NodeId / version / capability / endpoint

Unified RPC / frame layer
└─ @zcode/rpc IMessagePassingProtocol + typed runtime schema

Transport adapter
├─ MessagePort
├─ local socket / named pipe
├─ HTTPS + WSS
├─ SSH direct-tcpip / stdio tunnel
├─ WSL stdio tunnel
├─ Docker exec stdio tunnel
└─ mobile relay acknowledged rpc-frame
```

“SSH sends roughly the same content as WS” must mean that both carry exactly the same Node RPC / V4 frames,
not that SSH code maintains a separate set of service methods. WebSocket is a carrier; SSH / Docker stdio
is also just a carrier. Business schemas, connection scope, command idempotency, resource protocol, and recovery semantics must be identical.

### Recommended transport for each link

| Link                              | Physical transport                                   | Logical protocol                | Default delivery                 |
| --------------------------------- | ---------------------------------------------------- | ------------------------------- | -------------------------------- |
| Desktop Renderer -> Desktop Hub   | Electron MessagePort                                 | Hub RPC                         | `desktop-continuous`             |
| Browser Web -> Lite Hub           | same-origin WSS                                      | Hub RPC                         | `browser-replayable`             |
| Mobile -> Hub                     | WSS relay + acknowledged opaque `rpc-frame`          | Hub RPC                         | `mobile-remote-replayable`       |
| Desktop / Lite Hub -> direct Node | authenticated WSS                                    | Node RPC + multiplexed V4       | Determined by logical attachment |
| Hub -> local embedded Node        | MessagePort / named pipe / local socket              | Node RPC + multiplexed V4       | Determined by logical attachment |
| Hub -> SSH Node                   | Socket frames over SSH tunnel                        | Exactly the same as direct Node | Determined by logical attachment |
| Hub -> WSL Node                   | stdio connector -> distro local socket               | Exactly the same as direct Node | Determined by logical attachment |
| Hub -> Docker Node                | `docker exec -i` connector -> container local socket | Exactly the same as direct Node | Determined by logical attachment |
| Node -> Agent                     | child-process stdio NDJSON                           | ZCode Protocol V4               | Internal Node connection         |

`browser-replayable` and `mobile-remote-replayable` may reuse the same replayable algorithm, but must retain distinct
client roles so mobile pairing, Hub attachment, and Browser same-origin permissions are not conflated into one mode.
During migration, they can map to the existing `web-remote-replayable`.

### One physical Node link, multiple logical attachments

The Hub needs to maintain only a small number of physical connections to the same Node, but physical reuse must not erase existing connection isolation:

```text
Hub C == one authenticated physical link ==> Node A
          │
          ├─ attachment d1
          │   role=desktop
          │   profile=continuous
          │   connectionId=node-assigned-1
          │
          ├─ attachment b1
          │   role=browser
          │   profile=replayable
          │   connectionId=node-assigned-2
          │
          └─ attachment m1
              role=mobile-remote
              profile=replayable
              connectionId=node-assigned-3
```

Each logical attachment must independently own:

- `connectionId`
- subscription registry
- buffer / saturation state
- fragment assembly
- resync flight
- permission / elicitation visibility

The Node accepts only attachment roles opened by an authenticated Hub; a UI payload cannot directly specify `clientMode`. The MVP may initially open an
independent WebSocket for each attachment and add physical multiplexing after the contract stabilizes.

The Hub only routes frames and manages connections; the source Node / Agent remains authoritative for conversation sequence, snapshot, queue, and command lookup.

## SSH / WSL / Docker bootstrap and tunnels

### Unified sequence

```text
Hub Connector        Bootstrap Adapter          Target Node
     |                       |                       |
     |-- detect/install ---->|                       |
     |                       |-- install/upgrade --->|
     |                       |-- ensure daemon ----->|
     |                       |<-- bootstrap result --|
     |<-- NodeId/endpoint ---|                       |
     |                                               |
     |==== authenticated Node Protocol over tunnel ==|
     |-- hello(nodeId, protocol range, role) -------->|
     |<-- capability / bootId / workspace registry --|
     |-- open logical attachment -------------------->|
     |<== Node RPC / V4 / resource frames ===========>|
```

Bootstrap returns at least:

```ts
interface NodeBootstrapResult {
  nodeId: string;
  bootId: string;
  nodeVersion: string;
  protocolRange: { min: number; max: number };
  capabilities: string[];
  endpoint: {
    kind: "loopback-tcp" | "unix-socket" | "named-pipe" | "direct-url";
    address: string;
  };
  connectionChallenge: string;
}
```

`connectionChallenge` can be exchanged only for a short-lived Hub-to-Node capability; it must not become a long-lived plaintext credential.

### SSH

```text
ssh2
  1. Upload/upgrade the unified Node runtime
  2. Start or discover zcode node serve
  3. Node listens only on remote loopback
  4. ssh2.forwardOut establishes a direct-tcpip tunnel
  5. Run the same Node frames over the tunnel as over direct WSS
```

If the target environment cannot use direct-tcpip, run `zcode node connect` to forward SSH stdio directly to the Node's local
socket. Keep the old `entry-stdio.ts -> createLocalServices()` for only one migration cycle; it is not part of the long-term architecture.

### WSL

```text
wsl.exe ... zcode node connect
  -> Unix socket inside the distro
  -> persistent Node daemon
```

This way, Windows localhost forwarding differences affect only the adapter, not Node RPC. The WSL distro is not terminated when the Desktop
window closes.

### Docker

```text
docker exec -i <container> zcode node connect
  -> Unix socket inside the container
  -> persistent Node daemon
```

If the container explicitly exposes and protects the Node HTTPS / WSS port, the Hub can connect using a direct URL; otherwise it uses an exec
tunnel by default, without requiring the user to rebuild the container with an additional `-p`. The Node lifecycle follows the container; workspace / Agent lifecycle is determined by the unified
`WorkspaceLeaseManager`, so the entire Server is no longer restarted for every UI session.

### Manually installed Lite / Headless Node

After the user starts it through `zcode lite serve` or `zcode node serve`:

- Browser Web connects to the local Hub endpoint;
- Desktop connects to the Node endpoint on the same port using a direct URL;
- Local TUI uses the local socket;
- SSH / Docker bootstrap reuses the Node when it discovers the same NodeId and does not start a second runtime.

Connection URLs, SSH aliases, Docker container names, and WSL distros belong only in `ConnectionProfile`, not in permanent Node /
Workspace / Task identities.

## File and external resource transfer

Automatically file-backed long text, dragged images, and any external resources must use the same target Node Resource Store:

```text
Desktop / Browser / Mobile bytes
            |
            v
Hub route(GlobalWorkspaceRef)
            |
            v
Node resource/begin
  -> resource/chunk*
  -> resource/commit
            |
            v
ResourceRef { nodeId, workspaceId, resourceId, sha256, mediaType, size }
            |
            v
The Prompt carries only a ResourceRef
            |
            v
The target Node materializes / streams it to the workspace Agent
```

Rules:

1. A local UI path must never be sent directly to a remote Agent.
2. The Hub does not materialize resources as authoritative business files; it only routes the stream and tracks transfer progress.
3. Before `commit`, the Node validates length, hash, quota, and the target workspace lease.
4. ResourceRef must include `nodeId + workspaceId`; accidental reuse between Nodes is prohibited.
5. After a connection interruption, resume by upload id / committed chunks; never Base64-encode an entire large file in conversation RPC.
6. Temporary files for long text, screenshots, dragged images, and browser `File` objects share the same API.
7. The Node generates a local path or byte stream readable by the Agent; the CLI does not know whether the original file came from Desktop, Web, or mobile.

Therefore, when Browser A manages Node B, the resource path is
`Browser A -> Hub A -> Node B Resource Store`; Node A's temporary path is not written into the Prompt.

## Mobile Remote Controller

### Architectural position

Mobile is a remote UI attachment to the Hub:

```text
Mobile Browser
  -> external relay
  -> selected Hub device transport
  -> Hub node registry / router
  -> existing Node logical attachment
  -> source workspace Agent
```

In the target state, relay device transport and the shared attachment manager are consolidated into the Hub Gateway. Desktop main
retains only QR codes, windows, and process scheduling; Lite Hub may also register the relay device role when the user explicitly enables it.

### Capability boundaries

- Mobile can browse Nodes A / B / C known to the Hub and aggregated Task Summaries.
- When mobile opens a Task, the Hub creates a `mobile-remote-replayable` logical attachment to the source Node.
- Mobile disconnection, refresh, or relay reconnect rebuilds only the attachment; it does not stop the Hub, Node, or Agent.
- The relay continues to see only opaque `rpc-frame`; replay / gap / snapshot handling remains between the Node / Agent and mobile UI.
- In the first phase, mobile cannot install a Node, enter SSH credentials, or start a new SSH / WSL / Docker bootstrap.
- If an existing Hub connection is offline, mobile can see only a stale summary; whether the Hub may reconnect automatically using a pre-authorized profile is a separate product policy.
- Mobile commands enter the same source Agent `CommandInbox` as Desktop / Browser commands; no mobile queue is added.

### Difference from Browser Web

```text
Browser Web:
  same-origin WSS -> Lite Hub -> one or more Nodes

Mobile Remote:
  relay WSS -> paired Hub -> one or more Nodes
```

Both can render the same UI components and use replayable delivery, but their authentication, entry points, and connection owners differ.

## Lifecycle and failure boundaries

```text
UI attachment lifetime       = page / window / mobile bridge
Hub lifetime                 = Desktop App or Lite Hub service
Tunnel lifetime              = one physical connection from Hub to Node
Node daemon lifetime         = node-level, independent of UI and tunnel
Workspace lease lifetime     = attachment + running task + policy / idle TTL
Agent lifetime               = workspaceKey-level, managed by Node WorkspaceLeaseManager
Conversation lifetime        = Agent session store; not equivalent to any process connection
```

Must satisfy:

1. Closing a UI tab releases only its own logical attachment.
2. Browser refresh / Mobile reconnect does not restart the Node or Agent.
3. After a Hub crash and restart, recover from the Node registry, Task Summary, and V4 snapshot; do not replay private business logs.
4. Disconnecting the SSH tunnel does not immediately kill the Node daemon; whether the Agent continues is determined by the running task / lease policy.
5. A container stop, WSL shutdown, or machine shutdown changes the Node `bootId`; the Hub must invalidate old attachment /
   subscription / cursor state and perform a new handshake.
6. Node shutdown first stops new commands, closes attachments, and waits for the Agent process tree and database checkpoint,
   then exits.
7. Temporary unavailability of the Account Control Plane, relay, or Hub cannot damage local Node Task / Session data.

### Security boundaries

- By default, the Node listens only on loopback / Unix socket / named pipe; public addresses must explicitly enable TLS and token / mTLS.
- UI tokens, Hub-to-Node capabilities, bootstrap credentials, and account credentials use different audiences.
- The Node assigns `connectionId` and injects the delivery profile based on the authenticated role.
- The Hub stores only Connection Profiles and revocable credential references; it does not write SSH passwords or API keys to the task catalog.
- Direct URLs, SSH tunnels, and relay connections all require protocol-version and capability negotiation.
- Resource upload, terminal, file write, bootstrap, and account Secret delivery are authorized separately; merely “being connected to a Node” is insufficient.

## State scopes

| Scope      | Authoritative data                                                                                                            | Synchronization semantics                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| account    | Provider / Model metadata, display order, default model, global recent explicit model tuple, optional cross-device group view | Revisioned; converges across Hubs / Nodes for the same account                                |
| credential | API Key, OAuth token, Coding Plan key, runtime header                                                                         | Separate from metadata; policy chooses E2E sync, Node-local vault, or short-lived lease       |
| hub/device | Node connection profile, connection state, UI layout, persistent offline catalog cache                                        | Device-local; cannot be authoritative for Task / Session                                      |
| node       | Installed Plugins, user Skills / Subagents, toolchain, Node capability, runtime cache                                         | Independent per machine; may be copied explicitly, never unioned or overwritten automatically |
| workspace  | Repo `.zcode/*` / `.agents/*`, workspace extensions, project settings                                                         | Located in the target Node's workspace; naturally propagated by Git / filesystem              |
| session    | Current provider / model / thought / mode, messages, queue, owner, stream, permission                                         | Only in the Node runtime executing that Session                                               |

## Model configuration

### Target separation

The historical `ZCodeProviderRegistrySnapshot` contained both metadata and raw secrets; that snapshot path has been removed. The multi-Node
target design must still keep desired configuration, Credential Binding, and execution-time Lease as three separate flows:

```text
Account Model Profile
  ProviderCatalogSnapshot
  - provider / model / capability / baseURL / order / defaults
  - metadataRevision
                  │
             ▼
Node Runtime Binding
  - providerId / modelId / metadataRevision
  - credentialBindingId
                  │
                  ▼
Credential Plane
  - Encrypted Node secret or short-lived credential lease
  - audience = nodeId + workspaceId + sessionId
  - credentialRevision / expiry / revocation
```

Suggested types:

```ts
interface ModelProfile {
  profileId: string;
  revision: string;
  providers: ProviderMetadata[];
  defaultModelRef?: string;
  lastExplicitSelection?: {
    modelRef: string;
    thoughtLevel?: string;
  };
}

interface NodeModelReadiness {
  nodeId: string;
  profileRevision: string;
  providers: Array<{
    providerId: string;
    status: "ready" | "missing-credential" | "unsupported" | "stale";
    reason?: string;
  }>;
}
```

Rules:

1. All clients display the same `ModelProfile`.
2. Each Node reports readiness separately; “configuration is identical” and “the target Node can execute” are not combined in one field.
3. Before creating a Session, the Node must first apply the target Profile revision, then resolve the default model.
4. Existing Sessions retain their own provider / model / thought; opening a historical Session does not write back to global preferences.
5. If the target Node lacks credentials, by default block creation / sending and provide a clear remediation path; do not silently switch to a model available on another machine.
6. The current Desktop-attached SSH behavior of “sending the entire registry and raw secrets together” is only a migration-period compatibility path;
   the new protocol sends only the catalog revision and credential binding / lease.

### Pending decisions

- Must custom API keys be synchronized across clients using E2E encryption?
  - Recommended: Strongly synchronize Provider metadata; support account-level E2E Secret synchronization and allow a Provider-level setting for Node-local storage.
  - Simpler option: Keep all Secrets Node-local; model catalogs are then identical across clients, but readiness may differ.

## Skill / Plugin / Subagent

### Product semantics

1. Query extension inventory by `nodeId + workspaceId`; do not use the union of all Nodes as the candidates for the current Task.
2. When the current Task comes from Node B:
   - Composer / Slash command / Agent picker use B's capabilities;
   - Skill / Plugin / Subagent edits in Settings are also submitted to B;
   - installation state on Node A / C cannot affect B's runtime.
3. Global Settings needs a Node selector; an “All Nodes” matrix may be provided for comparison only, not as an execution catalog.
4. User-level Skills / Plugins / Subagents are Node-local.
5. Repo workspace Skills / Subagents are discovered from the checkout on the target Node.
6. “Copy to another Node” is an explicit action requiring preview, target selection, and conflict handling; do not synchronize automatically in the background.
7. A Subagent profile references a model ref from the account Model Profile, but the profile file and enabled / override
   state still belong to the Node or Workspace.

### Current implementation gaps

- Skills / Plugins on SSH / WSL already use remote services.
- The Subagents settings service for SSH / WSL still points to local Desktop while the runtime reads remote files; this UI / runtime split must be eliminated
  before the architecture is unified.
- The Plugin `workspace` field does not yet provide complete workspace-isolation semantics, so it cannot be treated as an implemented target design.

## Session / Task aggregation

### Do not fetch every Session's full content

The Hub aggregates only Task Summaries; it reads a snapshot / conversation page from the source Node only after the user opens a Task.

```text
Node A sorted TaskSummary page ─┐
Node B sorted TaskSummary page ─┼─ Hub k-way merge ── unified task list
Node C sorted TaskSummary page ─┘

select {nodeId, workspaceId, taskId}
  -> route to origin Node
  -> subscribe continuous / replayable
  -> on-demand session snapshot and rows
```

### New query protocol

```ts
interface FederatedTaskQuery {
  kind: "timeline" | "workspace" | "pinned" | "archived";
  sortBy: "created" | "updated";
  search?: string;
  workspaceIds?: string[];
  pageSize: number;
  cursor?: string;
}

interface NodeTaskSummaryPage {
  nodeId: string;
  taskIndexRevision: string;
  sessionIndexRevision: {
    logEpoch: string;
    seq: number;
  };
  items: TaskSummary[];
  nextCursor?: string;
}
```

The protocol requires every Node to use exactly the same total order. The global tie-break must include
`nodeId + workspaceId + taskId`; it cannot continue to assume that `taskId` is unique across endpoints.

### Separate Running tasks from historical pagination

The recommendation is to separate volatile running Tasks from the history cursor:

```text
Bounded, real-time, complete running overlay
                 +
Stable keyset-paginated terminal / history rows
```

Preserve the current sorting semantics:

- Pin running Tasks as a group at the top;
- Within running Tasks, sort by `createdAt DESC`, then by global Task ref;
- For non-running Tasks:
  - created:`createdAt DESC, updatedAt DESC, GlobalTaskRef`
  - updated:`updatedAt DESC, createdAt DESC, GlobalTaskRef`

The history-page cursor must be bound to at least:

```text
queryHash
topologyEpoch
nodeId -> taskIndexRevision / sessionIndexRevision / shardCursor
after -> primaryTime / secondaryTime / GlobalTaskRef
```

When the Node set or revision changes, return `cursor-stale` and refresh; do not silently skip entries.

### Cross-machine time

The MVP may continue using `createdAt / updatedAt` and use the global Task ref as a stable tie-break; this guarantees determinism only,
not the elimination of machine clock drift.

For the long term, consider adding:

```text
ActivityStamp = { physicalMs, logical, nodeId }
```

Migrate old data to `{ updatedAt, 0, nodeId }`. Exchange clock diagnostics during the Node handshake and flag severe drift in the UI;
do not use the time the Hub received a message to rewrite historical creation times.

### Offline

The current renderer cache is not persistent. The Federated Hub needs a read-only materialized catalog:

- key:`GlobalTaskRef`
- Contents: Task Summary, membership, tombstone, source revision, lastSeenAt
- Show stale / offline when a Node is offline
- The offline catalog allows browsing summaries only; opening content and sending, stopping, or handling permissions must wait for the source Node to come online
- When the Node returns, converge incrementally by revision / tombstone

## “Group” view

### Do not conflate the two types of grouping

1. Workspace grouping: derived from `GlobalWorkspaceRef`; Tasks are still paginated by time.
2. User-defined “groups”: organize data in the UI; sorting comes from explicit `sortOrder`, not Task timestamps.

### Recommended authority

Custom groups across Nodes must not directly union each Node's `task_groups`. The recommendation is to make one account-level
`FederatedTaskViewProfile` the sole owner:

```ts
interface FederatedTaskViewProfile {
  revision: string;
  groups: Array<{
    groupId: string;
    title: string;
    color: string;
    sortOrder: number;
  }>;
  members: Array<{
    groupId: string;
    task: GlobalTaskRef;
    sortOrder: number;
  }>;
  topLevel: Array<
    | { type: "group"; groupId: string; sortOrder: number }
    | { type: "task"; task: GlobalTaskRef; sortOrder: number }
  >;
}
```

All members and top-level nodes must persist an explicit order; the new architecture cannot rely on the client scanning everything and assigning order with
`max + 1000`.

Therefore:

- Timeline does not need to fetch everything; use Node pagination + Hub k-way merge.
- For a custom Group, first read the lightweight View Profile, then batch-fetch summaries for visible `GlobalTaskRef` values from their corresponding Nodes.
- The Group pagination cursor uses `viewRevision + groupId + sortOrder + GlobalTaskRef`.
- Keep members when a Node is offline, show offline summaries, and do not automatically remove them from the Group.

### Pending decisions

- Must A Web and C Desktop share exactly the same custom Groups / manual ordering?
  - Recommended: Account-level synchronization; all UIs are identical.
  - Optional: Hub-device-local; each UI can have a different layout, but this no longer meets the strict “one unified group view” requirement.

## Identity model

### Target

```text
NodeId       = UUID generated once and persisted in the Node data directory
WorkspaceId  = Stable UUID in the Node Workspace Registry

GlobalWorkspaceRef = { nodeId, workspaceId }
GlobalTaskRef      = { nodeId, workspaceId, taskId }
```

- Node URL, hostname, SSH alias, port, and username are connection routes, not NodeIds.
- `workspacePath` is a mutable attribute of the Workspace Registry, not the WorkspaceId.
- `remoteSessionId` remains a short-lived handle for a Hub attachment and is not part of global identity.
- SSH / WSL / Docker / direct URL adapters translate the legacy `workspaceIdentity` into a
  Node-local WorkspaceId at Node ingress; different access methods must not create separate sets of Tasks in the Node database.

As a transitional MVP, a normalized path within the Node may initially serve as the canonical workspace key, but RPC must first introduce
`WorkspaceRef` to leave room for upgrading to a stable WorkspaceId.

### Stable NodeId prerequisite

The current HTTP serverId may fall back to the hostname, and SSH stdio hello has no serverId. Before migration:

1. Generate and persist a UUID in the Node data directory.
2. Return the same NodeId from HTTP, SSH stdio, WSL, and Docker bootstrap handshakes.
3. Have the Hub detect duplicate NodeIds; after a VM clone, do not silently treat two machines as the same Node.
4. Provide a “claim old Node” flow on reinstall; do not automatically merge based on hostname.

## Legacy data migration

### Migration scope

```text
Target Node
├─ ~/.zcode/v2/tasks-index.sqlite
│  ├─ tasks
│  ├─ task_group_members
│  ├─ task_group_view_node_orders
│  ├─ task_group_workspace_bootstraps
│  ├─ automations
│  └─ automation_runs
├─ ~/.zcode/cli/db/db.sqlite
│  └─ session.workspace_id
├─ ~/.zcode/v2/sessions/<legacyWorkspaceHash>/
├─ workspace config / provider isolation hash directories
└─ Hub / Desktop lastWorkspaceSession and connection credentials
```

`messages / parts / todos / targets` and similar records are associated through `session_id`; the workspace key does not need to change.

### Aliases and ledger

Add the compatibility layer first, then move the data:

```text
workspace_registry(
  workspace_id,
  canonical_path,
  ...
)

workspace_alias(
  alias_key,
  workspace_id,
  source_kind,
  verified_node_id,
  created_at
)

migration_run(
  migration_id,
  source_alias,
  workspace_id,
  phase,
  error,
  updated_at
)
```

When old clients continue sending `remote:ssh:*`, the ingress alias must first resolve it to the canonical workspace;
otherwise old clients will write the old key again after migration.

### Idempotent saga

The two SQLite databases cannot share a cross-database transaction, so migration must be recoverable:

```text
prepared
   -> task_index_done
   -> session_store_done
   -> files_and_settings_done
   -> verified
```

1. `prepared`
   - Get the stable NodeId from the handshake;
   - accept only exact legacy aliases proven to belong to the current Node;
   - validate the identity path against the workspace path in the row;
   - create a consistent backup of each of the two WAL databases;
   - write the alias and migration ledger.
2. `task_index_done`
   - Merge `tasks`, updating scalar columns and `meta_json` together;
   - update group members;
   - parse and rewrite old and new top-level `node_key` formats;
   - update the bootstrap workspace key while preserving existing `group_id`, title, color, and order;
   - update automation / automation run;
   - do not delete the old alias.
3. `session_store_done`
   - update only the exact `session.id` listed in the migration manifest;
   - verify both `directory == canonicalPath` and `old workspace_id == source alias`;
   - do not update every row by directory.
4. `files_and_settings_done`
   - first copy / alias and verify legacy hash directories; do not move or delete the original directories;
   - change `lastWorkspaceSession` to GlobalWorkspaceRef;
   - move SSH addresses and authentication information into Connection Profiles; do not mix them into workspace identity;
   - do not copy, delete, or log plaintext secrets as part of Task identity migration.
5. `verified`
   - every Task list row opens the corresponding Session;
   - Groups, pin, archive, deleted, unread, and automation state can all be reconciled;
   - cold start, local Web, TUI, and Desktop remote use the same WorkspaceRef;
   - retain the legacy alias and backup for at least one version cycle.

### Conflicts

When the same `taskId` appears under one canonical workspace:

1. Session content summaries match: treat them as the same Task and merge shell metadata.
2. Session content differs: do not overwrite; record a migration conflict, preserve both, and require a user choice or generate
   a new Task identity for one of them.
3. Automatic fields:
   - use the earliest `createdAt`;
   - use the latest `updatedAt / unreadAt`;
   - prefer the user-overridden title;
   - use the latest valid Session projection for terminal / model / searchable text.
4. Product fields cannot simply be ORed:
   - resolve pinned / archived / deleted conflicts under explicit membership rules;
   - resolve Group and order conflicts by View Profile revision;
   - record conflicts until the rules are confirmed; do not automatically resurrect a deleted Task.

### Importing legacy Groups

Each Hub / Node may already have a different local Group layout. The recommendation is:

- Import each legacy layout with a separate `legacyViewOrigin`;
- do not automatically merge Groups with the same name;
- adopt directly when there is only one source;
- by default, retain multiple sources as separate groups named “From <device>” and merge them only after user confirmation;
- map Task refs through workspace aliases before adding them to the account View Profile.

## Phased rollout

### Phase 0: Contracts, identity, and observability

- Stable NodeId handshake.
- Workspace Registry / WorkspaceRef / alias schema.
- Change all Task keys, logs, and diagnostics to GlobalTaskRef.
- Define the Hub Protocol, Node Protocol, Bootstrap Protocol, and Resource Transfer Protocol.
- Introduce trusted connection roles and logical attachments at the protocol layer without changing the existing transport yet.
- Start with read-only inventory and migration dry-runs.

### Phase 1: Node Core and Hub Core

- Extract a single Node Core composition root from `entry-http` / `entry-stdio`.
- Implement the local Node single-owner lock, daemon discovery, and embedded fallback.
- Change Desktop to an app-wide Hub Process; multiple windows reuse it through separate MessagePort attachments.
- Add a logically independent Hub Core to Lite; Browser UI connects only to the Hub endpoint.
- Retain the existing per-window Host as a compatibility path; first observe both stacks rather than removing it immediately.

### Phase 2: Unified bootstrap, tunnels, and resource transfer

- SSH / WSL / Docker only install, start, upgrade, discover, and connect to the Node daemon.
- Direct URL, Browser Web, Desktop, and TUI use the same Node API.
- SSH uses direct-tcpip; WSL / Docker use `zcode node connect` to reach the local socket.
- Introduce a unified `WorkspaceLeaseManager` to eliminate the three different Host / Agent cleanup semantics.
- Long text, images, and external files all go into the Node Resource Store.
- Retain the old stdio business server for one compatibility cycle; the compatibility shim handles transport only.

### Phase 3: Node API and aggregated catalog

- Node Task Summary keyset API.
- Separate the Running overlay from historical pagination.
- Add Hub k-way merge, topology epoch, and persistent offline catalog.
- Route by source Node when opening a Task; conversation delivery semantics remain unchanged.

### Phase 4: Model and Extension scopes

- Separate ProviderCatalog from Credential Binding.
- Synchronize Account Model Profile revisions.
- Node readiness.
- Fix the SSH / WSL Subagent UI / runtime split.
- Add a Node selector to Extension Settings.

### Phase 5: Federated Groups

- Account View Profile.
- Legacy Group dry-run / import / conflict UI.
- Persist all sortOrder values authoritatively.
- Query group members by GlobalTaskRef.

### Phase 6: Legacy data migration and retirement of old paths

- Two-database migration saga.
- File-hash aliases.
- Separate Desktop history from credential routes.
- Gradual rollout with dual reads and single writes, validation, rollback, and cleanup after the version window.
- Remove the remote primary path `entry-stdio -> createLocalServices()`.
- Remove per-window SSH / Docker business Hosts; retain the bootstrap / tunnel adapter.

## Case Planning

### Main dimensions

| Dimension  | Representative values                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| UI         | Browser Web / Desktop / Mobile remote                                            |
| Node       | local / direct server / SSH bootstrap / offline                                  |
| delivery   | desktop-continuous / browser-replayable / mobile-remote-replayable               |
| transport  | MessagePort / direct WSS / SSH tunnel / WSL connector / Docker connector / relay |
| config     | Profile current / Node stale / missing credential                                |
| task state | running / terminal / archived / deleted                                          |
| list       | timeline / workspace / pinned / grouped                                          |
| resource   | long-paste file / image / browser File / mobile attachment                       |
| migration  | clean / duplicate alias / same task same content / same task divergent           |

### Initial candidate cases

| ID     | Setup                                                                      | Action                                      | Assertion                                                                                                           | Status           |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| FED-01 | A Web connects to Nodes A/B; C Desktop connects to A/B/C                   | Create a Task on each Node                  | Both UIs display GlobalTaskRef and do not incorrectly deduplicate equal taskId / path values                        | accepted         |
| FED-02 | Each of three Nodes has multiple pages of terminal Tasks and running Tasks | Scroll timeline                             | Running overlay stays at the top; historical k-way merge has no duplicates or omissions; no content is fetched      | proposed         |
| FED-03 | Node B is offline; Hub has an old catalog cache                            | Open unified list                           | B's Tasks show stale/offline; commands are blocked; A/C remain operable                                             | proposed         |
| FED-04 | Account Profile revision N; Node B is still at N-1                         | Create Task on B                            | Sync to N first; explicitly block if credentials are missing; do not silently switch models                         | proposed         |
| FED-05 | A/B have different Skills / Plugins / Subagents                            | Open candidate menu in a Task on B          | Show only B workspace + B Node inventory; global matrix does not participate in execution                           | accepted         |
| FED-06 | Account Group spans Tasks on A/B                                           | Reorder by drag in A Web; refresh C Desktop | Both converge on the same View Profile revision                                                                     | pending-decision |
| FED-07 | Legacy SSH alias and new Node WorkspaceRef point to the same data          | Run migration and cold start                | Task, Session, Group, and automation can be reconciled; old alias creates no new rows                               | proposed         |
| FED-08 | Two legacy aliases have the same taskId but different Session content      | Run migration                               | Do not overwrite; create a conflict and preserve original data and backups                                          | proposed         |
| FED-09 | Mobile attaches to C Desktop Hub                                           | Switch among Tasks on A/B/C                 | Use only the existing attachment; do not create Node runtime; replayable recovery boundary is unchanged             | accepted         |
| FED-10 | Lite started Node B; Desktop also discovers B through SSH                  | Desktop connects to the same workspace      | Reuse the same NodeId / WorkspaceId; do not create a second Server, Task Index, or Agent owner                      | proposed         |
| FED-11 | Desktop and Browser operate on the same Task on Node A simultaneously      | Subscribe and send from both clients        | Logical connections stay isolated; continuous / replayable recover independently; commands enter the same CLI inbox | proposed         |
| FED-12 | Node B has a running Task; SSH tunnel disconnects                          | Hub reconnects the tunnel                   | Node / Agent do not exit due to tunnel loss; recover using the new bootId / logEpoch or fail explicitly             | proposed         |
| FED-13 | Docker port is not exposed                                                 | Desktop connects to the container           | `docker exec` connector forwards only the local socket; business RPC uses the same schema as direct WSS             | proposed         |
| FED-14 | Desktop converts long text to a file; Browser drags an image to Node B     | Send Prompt                                 | Resource is committed to B Resource Store first; Prompt contains only B's ResourceRef; Agent can read it            | proposed         |
| FED-15 | Mobile connects to Hub C; Node B is offline                                | Open historical Task on B                   | Show stale summary only; mobile does not trigger SSH / Docker bootstrap                                             | accepted         |
| FED-16 | Lite Node and Desktop embedded Node compete for one data dir               | Start both concurrently                     | Single-owner lock guarantees one Node owner; the other discovers and connects or fails explicitly                   | proposed         |
| FED-17 | Ordinary Browser forges desktop clientMode                                 | Establish Node connection                   | Node ignores the client-reported value and injects a replayable profile based on the authenticated role             | accepted         |

### Pruning

- Do not test the full Cartesian product of UI × Node × delivery × every Task state; the Node API contract proves Task Summary terminal states,
  and Desktop / Web each use only one representative aggregation case.
- Use one candidate-isolation representative each for Skill, Plugin, and Subagent; the shared invariant is Node capability authority.
- Do not duplicate business aggregation cases for SSH / WSL / Docker; use representatives only in bootstrap / identity migration.
- Do not cross-product conversation queue / fork / compact with list pagination; they remain covered by the existing source Node protocol.
- Do not test creating a separate Hub / Node from mobile, since the product contract explicitly prohibits it.

## Impact scope

### Must inspect

- `packages/shared/src/remote-workspace-identity.ts`
- `packages/shared/src/remoteTarget.ts`
- `packages/shared/src/zcode-protocol/index.ts`
- `packages/services/src/session/taskIndexRepo.ts`
- `packages/services/src/session/automationRepo.ts`
- `apps/zcode-cli/packages/adapters/src/storage/session-store/`
- `packages/ui/src/hooks/useWorkspaceTaskLists.ts`
- `packages/ui/src/hooks/useGlobalTaskList.ts`
- `packages/ui/src/hooks/useGroupedTaskView.ts`
- `packages/ui/src/lib/buildGroupedTaskViewFromSessions.ts`
- `packages/ui/src/lib/taskListMembershipSets.ts`
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`
- `packages/desktop/src/main/desktopRemoteSessions.ts`
- `packages/desktop/src/main/desktopHostProcess.ts`
- `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts`
- `packages/desktop/src/host/serverRemoteConnection.ts`
- `packages/server/src/entry-http.ts`
- `packages/server/src/entry-stdio.ts`
- `packages/server/src/http.ts`
- `packages/server/src/remote/connect.ts`
- `packages/server/src/remote/create-backend.ts`
- `packages/server/src/remote/ssh-backend.ts`
- `packages/server/src/remote/wsl-backend.ts`
- `packages/server/src/remote/docker-backend.ts`
- `packages/services/src/node.ts`
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- `scripts/build-zcode-lite.mjs`

### Should inspect

- Model Provider storage / registry / remote sync
- Skill / Plugin / Subagent discovery and sync
- `lastWorkspaceSession` and Connection Profile persistence
- Web remote workspace list snapshot
- Hub persistent cache, search, pin / archive membership
- Node daemon supervisor, single-owner lock, and bootId
- Hub / Node connection capabilities and logical attachment multiplexing
- Resource Store quotas, resumable transfer, janitor, and cross-Node misuse prevention

### Invariants only

- V4 Session runtime / conversation projection
- owner / lease / queued command
- Desktop continuous and Mobile replayable
- Pure forwarding boundary for relay / desktop main
- V4 CommandInbox, command ACK/query, owner/lease, and connection-scoped subscription

## Proposed Feature Graph Delta

After product semantics are confirmed, update the feature graph; proposed additions:

- `capability.federated-node-hub`
- `capability.unified-node-runtime`
- `state.account-model-profile`
- `state.node-capability-manifest`
- `state.federated-task-view-profile`
- `service.hub-core`
- `service.node-core`
- `service.node-bootstrap`
- `service.node-resource-store`
- `service.logical-attachment-multiplexer`
- `service.node-workspace-registry`
- `service.federated-task-query`
- `persistence.workspace-alias-ledger`
- `persistence.hub-task-summary-catalog`
- `boundary.browser-replayable`
- `boundary.mobile-remote-replayable`
- `invariant.global-task-ref`

## Pending user decisions

1. Should custom API keys be synchronized across clients using E2E encryption, or should only model metadata sync while Secrets remain Node-local?
2. Must custom Groups / manual ordering be exactly the same in A Web and C Desktop?
3. When a Node is offline, should its last Task summaries continue to appear after restarting the UI, or should the UI show only “Node offline”?
4. For conflicting pin / archive / deleted state on the same legacy Task, should the conservative priority be `deleted > archived > pinned > normal`?
5. If cloning a Node data directory causes duplicate NodeIds, should a newly discovered machine be treated as a clone by default and be forced to generate a new NodeId?
6. Should the Node daemon run independently of the UI by default?
   - Recommended: Lite / manually installed Nodes run long-term; the Desktop embedded fallback follows the App lifecycle.
   - Alternative: all bootstrap Nodes exit under an idle policy after no Tasks / leases remain.
7. Should Lite Hub be allowed to register a mobile relay device role like Desktop Hub?
   - Recommended: yes, but only when explicitly enabled by the user; mobile still cannot bootstrap a new Node directly.
8. Should Browser Web always use replayable delivery?
   - Recommended: yes; Browser tabs refresh, sleep, and lose connectivity, so they should not pretend to be Desktop continuous.
9. May the Hub automatically restore offline Nodes using pre-authorized Connection Profiles?
   - Recommended: Desktop / Lite Hub may restore according to device policy; the mobile attachment itself has no authority to create or change that policy.
