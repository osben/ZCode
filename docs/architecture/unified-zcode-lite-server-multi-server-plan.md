# ZCode Lite / Server Unified Multi-Client Architecture Implementation Plan

## Status

- Type: New target architecture and implementation plan
- Status: Product boundaries confirmed; phased implementation pending
- Scope: Desktop, Browser Web, mobile Remote Controller, local, SSH, WSL, Docker, Direct URL
- Current sources of truth:
  - `docs/architecture/zcode-code-architecture-overview.md`
  - `docs/architecture/message-flow.md`
  - `docs/architecture/rpc.md`
  - `docs/web-remote-control/web-remote-control-architecture.md`
  - `docs/web-remote-control/task-realtime-sync.md`
  - `docs/web-remote-control-task-command-queue.md`
  - `docs/remote-prompt-attachment-materialization.md`
  - `docs/ssh-remote-app-global-state-authority.md`
  - `docs/task/task-sqlite-index.md`
  - `docs/working-memory/provider-refactor/design/environment/environment.md`
  - `docs/working-memory/provider-refactor/design/registry/runtime.md`

This document redefines the target architecture; historical SSH/Web implementations are not the target model. A compatibility adapter may remain during implementation, but the final design must converge on the process, identity, state-authority, and communication boundaries defined here.

### Current Temporary Product Boundary

The `Browser Web -> Lite Controller Runtime` described below is the target architecture, not the current implementation. Ordinary Web (including the development Web entry point and `zcode-lite serve`) still connects directly from the browser to `@zcode/server` `/ws`; it has no Desktop Window Host Controller. Therefore, until Lite / Browser Controller Runtime is implemented and multi-client regressions are complete, ordinary Web does not support the global left-side task list or multi-source aggregation that depends on Window Host Controller, and the Renderer must not maintain a second Controller fallback.

```text
Current: Browser Web -> @zcode/server /ws -> createLocalServices()
                                      -X-> Window Host Controller

Target: Browser Web -> Lite Controller Runtime -> Local / Remote Server sources
```

This temporary boundary does not affect local Desktop, Desktop SSH/WSL/Docker/Server workspaces, or mobile `/remote` attached to an existing Desktop Host. For current facts and exact scope, see “Current ordinary Web support boundary” in `docs/zcode-lite-static-distribution.md`.

## 1. Goals

The same ZCode Server capabilities support these entry points:

1. Desktop UI manages the local machine and multiple remote Servers.
2. Browser Web uses one ZCode Lite to manage its machine and multiple remote Servers.
3. One ZCode Lite can connect to another ZCode Lite.
4. Mobile Remote Controller attaches to an existing Desktop or Lite controller and reuses its multi-Server view.
5. SSH, WSL, Docker, and Direct URL affect only how a connection is established; they do not change higher-level RPC, resource, Session, or task semantics.
6. At most one logical ZCode Server runs for a given OS user and data root on each machine.
7. At most one Agent CLI runs per Workspace; one Server can manage multiple Workspace Agents concurrently.

## 2. Explicitly Out of Scope

- Do not introduce a centralized `ZCode Hub` service.
- Do not let a Session span multiple Servers.
- Do not automatically synchronize Server connection lists saved by different controllers.
- Do not let mobile independently establish SSH/WSL/Docker connections or start an Agent.
- Do not add multiple users, roles, or fine-grained authorization; an authenticated client has full ZCode permissions within that OS user's scope.
- Do not track Workspace path moves or renames; treat a path change as a new Workspace.
- The first release does not handle autostart after an OS reboot or replaying missed tasks; once started, Server runs until the user stops it manually.
- Do not synchronize Provider display order, OAuth login state, current connection selection, or the UI's recent model.
- Do not add cross-Server persistence for groups; tasks only need to aggregate in the UI, and cross-Server ordering is best effort.

## 3. Shared Concepts

### 3.1 ZCode Lite

ZCode Lite is an installable product, not a particular UI. It includes:

```text
ZCode Lite
├─ Stable Launcher
│  ├─ Listening, authentication, and stable Bootstrap Protocol
│  ├─ Version negotiation, runtime cache, installation, and process lock
│  └─ Starts one current Server Core
├─ Versioned Runtimes
│  ├─ server/<version>
│  └─ connector/<version>
├─ Server Core
│  ├─ workspace / file / git / terminal
│  ├─ task / session / scheduler
│  ├─ model provider
│  ├─ plugins / skills / subagents
│  ├─ resource store
│  └─ workspace -> Agent CLI supervisor
├─ Browser Web static assets and Web controller entry point
└─ Local TUI
```

TUI is only a local UI capability of Lite. It attaches directly to the local Server and does not provide cross-remote UI or transport.

### 3.2 ZCode Server

A ZCode Server is a logical instance consisting of `Launcher + current Server Core + data directory`.

- Multiple Server runtime versions may be installed on disk at the same time.
- Only one Server Core may run at a time for the same user and data directory.
- The Server lifecycle does not follow any one UI connection.
- Server continues running after the last UI disconnects so scheduled and background tasks can run.

### 3.3 Controller Runtime

Controller Runtime is the connection manager behind the UI. It is not a central Hub and does not own remote business data.

```text
Desktop UI
  -> Desktop Controller Runtime
     -> Server A / B / C

Browser Web (provided by Lite A)
  -> Lite A Controller Runtime
     -> Server A / B

Mobile Remote
  -> attaches to a Desktop or Lite Controller Runtime
     -> reuses its Server A / B / C connections
```

Controller Runtime is responsible for:

- Saving connection configuration for this controller.
- Establishing Direct URL, SSH, WSL, and Docker connections.
- Selecting a compatible Connector.
- Aggregating read-only list projections from multiple Servers for the UI.
- Routing user operations to the Source Server that owns the object.

Controller Runtime does not persist remote Session content, remote task runtime state, remote resources, or copies of remote configuration.

### 3.4 Server, Workspace, and Session References

```ts
interface ServerRef {
  serverId: string;
}

interface WorkspaceRef {
  serverId: string;
  workspaceIdentity: string;
  workspacePath: string;
}

interface SessionRef {
  serverId: string;
  sessionId: string;
}
```

- `serverId` is a persistent random identity stored in the Server data root; it is unrelated to IP, domain, SSH user, or connection method.
- `workspaceIdentity` is the Workspace isolation identity on the Server machine; it must not contain an SSH account, IP, domain, or jump-host chain.
- `workspacePath` is used only for path display and actual IO.
- Every Session, Task, and Workspace key in the global UI must include `serverId`.
- Within a Server, continue to follow `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## 4. Target Process Model

### 4.1 Desktop Manages A, B, and C

```text
Machine C
├─ Desktop Renderer
├─ Desktop Controller Runtime
│  ├─ local connector ───────────────> Server C
│  ├─ SSH bootstrap + tunnel ────────> Server A
│  └─ Direct WSS / SSH tunnel ───────> Server B
└─ Bundled Lite Launcher
   └─ Server C
      ├─ Workspace C1 -> Agent CLI C1
      └─ Workspace C2 -> Agent CLI C2

Machine A
└─ Lite Launcher -> Server A
   ├─ Workspace A1 -> Agent CLI A1
   └─ Workspace A2 -> Agent CLI A2

Machine B
└─ Lite Launcher -> Server B
   └─ Workspace B1 -> Agent CLI B1
```

The local Desktop also uses the unified Server contract. A MessagePort or in-process fast path may remain, but it is only an implementation of `IMessagePassingProtocol` and must not create a separate set of Service semantics.

### 4.2 Browser Web Manages A and B

```text
Browser
  -> HTTP/WSS -> Lite A Controller Runtime
                   ├─ local connector -> Server A
                   └─ SSH/Direct connector -> Server B
```

The Browser does not execute SSH directly. It submits connection intent to Lite A's Controller Runtime, whose Node capabilities establish SSH, WSL, Docker, or Direct URL connections.

### 4.3 Mobile Remote Controller

```text
Mobile Web
  -> relay / direct paired transport
  -> attaches to an existing Desktop or Lite Controller
  -> Servers already connected by that Controller
```

- Mobile has no independent Host, Server, Agent, or connection directory.
- Mobile sees the multi-Server aggregate view of its attached controller.
- Mobile continues to use `web-remote-replayable`.
- Desktop and ordinary Browser control paths use `desktop-continuous` or the corresponding trusted continuous profile.
- Trusted attachments inject `clientMode` / `deliveryKind`; the UI must not forge them.

## 5. Unified Communication

### 5.1 Unify Messages and Services, Not Physical Links

```text
Typed Channel / V4 Protocol / Resource Protocol
                       |
              IMessagePassingProtocol
       ┌───────────────┼────────────────┐
       v               v                v
 MessagePort       WebSocket       SSH/WSL/Docker tunnel
 in-process        Direct WSS      carries the same frames after bootstrap
```

The following must be consistent across all transports:

- Service channel names, RPC commands, events, and schemas.
- Conversation V4 commands, ACKs, snapshots, deltas, and subscriptions.
- Workspace, Session, Task, and resource references.
- Chunks, checksums, cancellation, backpressure, and error codes.
- Capabilities, versions, and delivery profiles.

SSH handles only:

1. Finding or installing the Stable Launcher.
2. Establishing a secure bootstrap channel.
3. Obtaining short-lived device credentials.
4. Creating a tunnel to the Launcher's listening port.

SSH stdio no longer carries a separate business protocol. During migration, the current stdio RPC may be wrapped in a unified transport adapter.

### 5.2 Multi-Hop Jump Hosts

Multi-hop jump hosts belong to the Controller's Transport/Bootstrap layer:

```text
Controller
  -> SSH Connector
     -> Jump 1
        -> Jump 2
           -> Target Launcher
```

- The jump-host chain exists only in connection configuration and the SSH backend.
- Server, Workspace, Session, Task, and resource protocols are unaware of jump hosts.
- Target identity is determined by the `serverId` returned by the handshake; do not derive identity from the jump-host chain.

## 6. Version Negotiation

### 6.1 Stable Bootstrap Protocol

Launcher exposes a small, stable protocol:

```ts
interface BootstrapHello {
  launcherVersion: string;
  serverId: string;
  activeServerVersion?: string;
  supportedProtocolRanges: string[];
  capabilities: string[];
}
```

Handshake flow:

```text
Initiating Launcher/Controller
  -> reads target BootstrapHello
  -> current Connector is compatible: connect directly
  -> matching Connector exists locally: start that version
  -> no matching Connector locally: verify the signature, then install it
```

Target-side rules:

- If a Server Core is already running, do not switch versions for a new client or start a second Server Core.
- The initiating side selects a Connector compatible with the target's active Server.
- Only when no Server Core is running may Launcher select a compatible version from installed runtimes; install one only if none is available.
- Data schemas may only be upgraded monotonically. Do not downgrade the Server runtime to support an old client reading upgraded data.

### 6.2 Prefer Capability Checks Over Version Checks

Negotiate product capabilities through capabilities. Connector handles version adaptation, and the UI controls entry points based on capabilities. Do not scatter Desktop or Server version branches across business components.

## 7. Authentication and Listening

### 7.1 Listening

- Listen on `127.0.0.1` by default.
- SSH, WSL, and Docker access loopback through a tunnel by default.
- Allow LAN or public connections only when the user explicitly configures a non-loopback address.
- Authentication is required for non-loopback listening; public TLS may be provided by Launcher or a supported reverse proxy.

### 7.2 Unified Device Authentication

```text
SSH/WSL/Docker
  -> issue a device Token within the existing secure channel

Direct URL
  -> one-time pairing code
  -> long-lived, revocable device Token

Local Web/TUI
  -> Launcher issues a local Session

Mobile Remote
  -> existing pairing flow
  -> same device-Token semantics
```

An authenticated client has full permissions for ZCode Server under that OS user. The first release does not add RBAC.

## 8. State Authority

| State                                     | Authority                   | Aggregation/mirror                   |
| ----------------------------------------- | --------------------------- | ------------------------------------ |
| Workspace files, Git, Terminal            | Workspace's Server          | UI projection only                   |
| Session content and runtime state         | Agent CLI on Source Server  | UI continuous/replayable projection  |
| Task list, title, pin, archive, groups    | Source Server task index    | Best-effort Controller aggregation   |
| Scheduled tasks and scheduling            | Source Server               | Managed only by UI                   |
| Plugin, Skill, Subagent                   | Each Server                 | Not merged across Servers            |
| Provider definitions                      | Each Server                 | Explicitly synchronized by the user  |
| OAuth, connection selection, recent model | Each Server/UI              | Not synchronized                     |
| Server connection list                    | Each Controller Runtime     | Not synchronized automatically       |
| Theme, locale, drafts, scrolling          | UI/Controller               | Not moved into Server business layer |
| Prompt Resource                           | Its consuming Source Server | Controller only uploads              |

Settings in the unified UI must have an explicit Server selector. Build capability menus from the capabilities of the Source Server for the current Task/Workspace; do not union Plugins, Skills, or tools from A, B, and C and submit them to the wrong Server.

## 9. Model Provider Configuration Sync

Synchronization is a directional operation initiated by the user:

```text
Source Server A ──full mirror──> Target Server B
```

### 9.1 Synchronized content

- User-defined Provider names and enabled states.
- Base URL, Endpoint Paths, and API format.
- Manually entered API keys.
- Persistent headers; these are part of the Provider definition even if the current UI does not yet provide a way to edit them.
- Provider model configuration, including model lists, model ID mappings, context and output limits, reasoning, modalities, and tool capabilities.

### 9.2 Not synchronized

- OAuth login state and OAuth tokens.
- The current Z.ai / BigModel connection selection, domain, and family mode.
- The UI's recent model, thought level, and Agent config.
- runtime-only headers.
- Provider display order.
- System-derived unavailability reasons, connection test results, and temporary runtime state.

### 9.3 Merge rules

- The user must select a Source and a Target first.
- Same Provider ID: Source replaces Target.
- New on the Source: write it to the Target.
- Present only on the Target: remove it from the synchronization scope.
- The Target's OAuth and local runtime state are unaffected.
- Import must use a temporary file or database transaction, then atomically replace the data after validation succeeds.
- On synchronization failure, preserve the Target's original state and return a readable report.
- Do not write secrets to logs or include them in task events or replayable snapshots.

## 10. Unified Resource Store

Automatically file-backed long text, dragged images, selected files, and mobile attachments use the same resource protocol:

```text
UI/Controller
  -> resource/begin
  -> resource/chunk*
  -> resource/commit(hash, size)
  -> Source Server Resource Store
  -> AttachmentRef(resourceId)
  -> Agent CLI resolves it to a path readable on the local machine
```

Core rules:

- A Prompt must not pass the Controller's local `localPath` as a remote path.
- Before send admission, a resource must be placed on the Source Server that consumes it.
- RPC/WS/SSH tunnels carry the same chunk semantics; SFTP may be used as an upload adapter optimization, but must not change the upper-level contract.
- `AttachmentRef` uses `resourceId`; a local materialized path is generated only inside the Source Server.
- The commit validates size/hash; on failure, the Prompt must not enter the CLI.
- After a successful commit, the Session/queue adopts the resource; a janitor reclaims uploads that were not adopted.
- Mobile uploads continue to be routed through the attached Controller to the Source Server; relay/main does not store resource business state.

## 11. Multi-Workspace Sessions

A Session can be associated with multiple Workspaces, but cannot span Servers:

```ts
interface SessionWorkspaceBinding {
  primary: WorkspaceRef;
  secondary: WorkspaceRef[];
}
```

Constraints:

- `primary.serverId === secondary[i].serverId`.
- Primary is immutable after creation.
- Secondary Workspaces can be added, removed, and reordered.
- The Agent CLI runs in the Primary Workspace.
- The Task appears only in the Primary Workspace's list.
- Secondary Workspaces only extend file, Git, Terminal, and tool access within the same Server.
- When a binding is submitted, the Server must verify that all WorkspaceRefs belong to it; reject cross-Server requests outright.

## 12. Current-state gaps

| Domain             | Current implementation                                                                                 | Target                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| SSH lifecycle      | Desktop starts and owns the remote stdio `zcode-server`                                                | Persistent per-user Launcher + one Server                                                      |
| Server entry       | `entry-stdio.ts` and `entry-http.ts` are separate                                                      | Shared Server Core; entry points are transport adapters                                        |
| Desktop local      | A Local Host per window                                                                                | One unified local Server; windows are clients                                                  |
| SSH Host           | Remote Host shared at window scope                                                                     | Controller connects to the target user's Server                                                |
| Identity           | Remote route + workspace path contribute to identity                                                   | Persistent serverId + server-local workspaceIdentity                                           |
| Provider authority | Each current Environment owns its Config, Credential, and Registry; Desktop does not send the Registry | Each Server remains authoritative; future explicit A→B Provisioning writes to the target Store |
| Attachments        | Eagerly stage host-local paths at remote paths                                                         | Resource Store + resourceId                                                                    |
| Web                | Primarily a static mobile `/remote` client                                                             | Lite provides full Browser Web + multi-Server Controller                                       |
| Mobile             | Attaches to one existing Local/Remote Host carrying the target workspace scope                         | Attaches to the Controller and reuses its multi-Server view                                    |
| Versioning         | Starts after deploying the current Desktop bundle                                                      | Stable Launcher + versioned Connector/Server runtime                                           |

## 13. Implementation phases

### Phase 0: Test baseline and protocol freeze

First add documentation and tests without changing the default path:

1. Add multi-Server, resource-upload, version-negotiation, and mobile-attachment cases to the conversation case catalog and coverage matrix.
2. Add contract tests for the current stdio, HTTP/WS, server-remote, and remote Prompt attachment paths.
3. Save the existing network/log baselines for Desktop continuous and mobile replayable.
4. Set up a Docker SSH test topology: Controller, Jump 1, Jump 2, Target A, and Target B.

Exit criterion: Current behavior is reproducible in tests, and each later phase can demonstrate that V4 conversation semantics have not changed.

### Phase 1: Shared identity and connection contract

1. Add strict schemas in `packages/shared`:
   - `ServerDescriptor`
   - `ServerRef`
   - `WorkspaceRef`
   - `SessionRef`
   - `ServerCapabilities`
   - `BootstrapHello`
2. Add the Controller-side `IServerConnection` / `IServerDirectory` interfaces.
3. Change all global UI keys to include at least `serverId`.
4. Generate temporary descriptors for existing connections through a compatibility adapter, without immediately changing persistence.

Exit criterion: One UI can hold Tasks with the same `workspacePath` but different `serverId` values at the same time without mixing their state.

### Phase 2: Stable Launcher and version management

1. Implement the Launcher process, stable bootstrap endpoint, and data-root lock.
2. Implement the runtime manifest, signature verification, download, cache, and cleanup.
3. Implement Connector version selection.
4. Select a compatible Server runtime when the target has no active Server.
5. Switch only the initiating Connector when the target already has an active Server.

Exit criterion: The version matrix never starts a second Server or uses an old runtime to read a newer schema as a downgrade.

### Phase 3: Unify Server Core entry points

1. Extract the same `createZCodeServerCore()` from `entry-stdio.ts` and `entry-http.ts`.
2. stdio, WS, and MessagePort only provide `IMessagePassingProtocol`.
3. Server Core owns the service collection, scheduler, workspace registry, task index, and Agent supervisor.
4. UI disconnection releases only the attachment; it does not exit the Server.
5. Initially connect Desktop local through a compatibility local connector to the unified Server.

Exit criterion: The Server and scheduled tasks remain alive after Desktop exits or the Browser closes; exit only when the user explicitly shuts it down.

### Phase 4: Controller multi-Server connections

1. Extract the Desktop Controller Runtime.
2. Assemble the same Controller Runtime in Lite for Browser Web.
3. Implement direct, SSH, WSL, and Docker transport adapters.
4. Support SSH ProxyJump/multi-hop, but expose it only at the backend layer.
5. Persist the connection list locally per Controller; do not synchronize it automatically.
6. Include `serverId` in UI queries and route actions back to the Source Server.

Exit criterion: A Web can manage A/B, C Desktop can manage A/B/C simultaneously, and state from the three Source Servers is never mixed.

### Phase 5: Server/Workspace identity migration

1. Generate and persist a `serverId` on the first start of each data root.
2. Create a server-local Workspace registry.
3. Scan old `tasks-index.sqlite` workspace keys containing SSH account/IP/target information.
4. Map them to the new workspace identity using `workspace_path` on the target Server.
5. Automatically merge when there are no conflicts; write title, group, pin, or sort-order conflicts to a migration report.
6. After writing the new key, retain a compatibility read path for one version and a migration-complete marker.
7. Reject a later process starting concurrently against a data directory with the same serverId; allow offline backup restores to retain the identity.

Exit criteria:

- After the SSH IP, domain, port, or account changes, the handshake returns the same serverId and historical Tasks remain available.
- Treat a changed Workspace path as a new Workspace.
- Migration can be rerun without creating duplicate Tasks.

### Phase 6:Resource Store

1. First add tests for very long pastes, dragged images, ordinary files, and failed retries.
2. Add the resource begin/chunk/commit/abort/adopt API.
3. Implement content hashing, atomic writes, references, and GC in the Server.
4. Change Composer to send `AttachmentRef(resourceId)`.
5. Retain the existing `IPromptAttachmentTransferService` as a compatibility facade that uses the Resource API internally.
6. Remove the remote Prompt's dependency on the Controller's `localPath`.

Exit criterion: Every attachment path read by the Agent on a Docker SSH Target is located on the Target; Controller temporary paths do not appear in the protocol or Prompt.

### Phase 7: Server state authority and Provider synchronization

1. Remove the `desktop-attached-remote` Provider authority override from the target architecture.
2. Each Server uses its own `modelProviderService`.
3. Add typed `exportProviderDefinitions` / `importProviderDefinitions`.
4. Implement atomic Source→Target mirroring, secret-redacted logs, and rollback on failure.
5. Add Server selection and synchronization-direction confirmation to Settings.
6. Plugins, Skills, and Subagents read only from the selected Source Server.

Exit criterion: After A→B, user Provider definitions are consistent; B's OAuth, local connection selection, and recent model remain unchanged; A and B may have different Plugins, Skills, and Subagents.

### Phase 8: Multi-Workspace Sessions

1. Extend the Session schema with an immutable primary and mutable secondary Workspaces.
2. On write, verify that all WorkspaceRefs have the same serverId.
3. Give the Primary Agent runtime controlled Secondary Workspace capabilities within the Server.
4. The Task index establishes membership only through the Primary Workspace.
5. Preserve the binding during resume, fork, snapshot, and migration.

Exit criterion: Primary and Secondary Workspaces on the same Server can be read and written; a cross-Server secondary is rejected by both schema and service layers.

### Phase 9: Mobile Controller attachment

1. Extend mobile workspace attachment into a Controller attachment.
2. Mobile reuses the Controller's Server list and aggregate queries.
3. After opening a Task, continue attaching to the existing Host/CLI scope on the Source Server.
4. Preserve `web-remote-replayable` gap/snapshot recovery.
5. Do not let relay/main own task, resource, or connection-directory business state.

Exit criterion: Mobile can see the Controller's A/B/C; reconnect recovery does not affect Desktop continuous; mobile cannot create an independent SSH runtime.

### Phase 10: Remove the old primary paths

Remove these only after all migration gates are met:

- The primary path for a remote stdio Server whose lifecycle is bound to Desktop.
- Workspace identities derived from remote routes.
- Any compatibility path that reintroduces automatic Desktop overrides of the remote Provider Registry.
- The compatibility branch that passes `localPath` across machines for Prompt attachments.
- The path that makes each window's local business Host the sole authority.

## 14. Verification matrix

### 14.1 Required topologies

```text
Host C: Desktop + local Server C
Docker A: SSH + Lite Server A
Docker B: Direct URL + Lite Server B
Docker J1 -> Docker J2 -> Docker A: two jump hosts
Mobile browser: attachment to Controller C or A
```

### 14.2 Core cases

| ID      | Setup                                           | Action                     | Assertions                                                                 |
| ------- | ----------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| UMS-001 | C connects to A/B/C                             | Fetch Tasks                | Same-path Tasks are isolated by serverId and displayed together            |
| UMS-002 | C connects to A through two SSH addresses       | Complete handshake         | Only one Server A appears; historical Tasks are not duplicated             |
| UMS-003 | All UIs disconnect from A                       | Cron time arrives          | Server/Agent runs as needed and records the result                         |
| UMS-004 | A runs v4; C defaults to v5                     | C connects to A            | C selects a v4 Connector; A does not restart or downgrade                  |
| UMS-005 | A has no active Server                          | C connects to A            | Launcher selects a compatible installed runtime or installs one if missing |
| UMS-006 | Very long paste in SSH Workspace                | Send Prompt                | Resource exists on A and is readable by Agent; C's localPath does not leak |
| UMS-007 | Drag image into SSH Workspace                   | Send Prompt                | Image bytes/hash are correct; retries do not adopt it twice                |
| UMS-008 | Synchronize Provider A→B                        | Inspect B                  | Definitions/API keys/headers are mirrored; OAuth/UI state is unchanged     |
| UMS-009 | Reverse synchronization B→A                     | Inspect A                  | User-selected direction determines the sole Source                         |
| UMS-010 | A/B have different skills                       | Switch Task                | Menu switches by Source Server; capabilities are not unioned               |
| UMS-011 | Mobile attaches to C                            | Browse A/B/C               | List is visible; opened Task uses replayable                               |
| UMS-012 | Mobile gap + Desktop streaming                  | Recover                    | Mobile snapshot converges; Desktop continuous does not splice in replay    |
| UMS-013 | Session primary/secondary both on A             | Access secondary directory | Succeeds; Task appears only under primary                                  |
| UMS-014 | Session secondary points to B                   | Save                       | Schema/service explicitly reject it                                        |
| UMS-015 | Old SSH key contains account/IP                 | First migration            | Task moves to server-local key; merge automatically when conflict-free     |
| UMS-016 | Clone A's data directory and start concurrently | Start second instance      | serverId lease conflict; later starter is rejected                         |
| UMS-017 | Rename A's path                                 | Open new path              | Treated as a new Workspace; old data is not linked automatically           |
| UMS-018 | Two jump hosts                                  | Connect to A               | Business handshake exposes only A's serverId, not jump-host identity       |

### 14.3 Evidence layers

Collect at least the following for each high-risk E2E:

- UI: visible Server, Workspace, and Task state.
- Protocol:bootstrap hello, capability, source server route, resource commit.
- Process: Launcher, single Server Core, and workspace Agent counts.
- Files:server identity, workspace registry, task index, resource store.
- Network: Direct WS or SSH tunnel frames; never record secrets.
- Recovery: continuous sequence and replayable watermark/gap/snapshot.

## 15. Release and rollback

1. First release the new schema and read-only handshake; leave the old path unchanged.
2. Then gradually roll out the Launcher and persistent Server, while retaining the stdio compatibility Connector.
3. Use an explicit schema version, migration log, and completion marker for identity migration.
4. First dual-write to/validate the Resource Store, then stop sending `localPath` across machines.
5. Provider authority switching must have a capability gate; the old and new systems must not both overwrite the same runtime.
6. Provide the ability to roll back to the old Connector at every phase, but do not downgrade an already upgraded data schema.
7. Complete the full Desktop, Browser, Mobile, SSH, WSL, and Docker matrix before removing compatibility code.

## 16. Invariants that must be preserved

1. The CLI remains authoritative for Session content and runtime state.
2. The Task index must not become authoritative for Session content or the current runtime config.
3. Relay/Main handle only authentication, pairing, frame forwarding, and attachment scheduling.
4. Desktop continuous and mobile replayable remain independent.
5. `workspacePath` is used only for execution/display; identity uses serverId + workspaceIdentity.
6. A Session does not span Servers.
7. Only one Server Core runs against a data root at a time.
8. A Workspace has at most one Agent CLI.
9. Secrets do not enter logs, task events, snapshots, or migration reports.
10. File, model configuration, task, and capability operations always return to the Source Server that owns the object.

## 17. Definition of done

The unified architecture is complete only when all of the following conditions are met:

- Desktop, Browser Web, and mobile use the same Server/Workspace/Session references.
- Local, Direct URL, SSH, WSL, and Docker differ only in transport/bootstrap.
- Only one logical Server runs per OS user on each machine.
- The UI can manage at least three Servers simultaneously without mixing state, capabilities, or secrets.
- The Source Server Resource Store handles long text and all external attachments.
- Old SSH Tasks migrate smoothly after IP/account changes.
- Users can mirror Provider definitions in a chosen direction while keeping OAuth and other local state isolated.
- The mobile multi-Server view continues to follow shared-host attachment and replayable recovery.
- `pnpm typecheck`, `pnpm lint`, protocol unit tests, Docker SSH/jump-host integration tests, and core E2E all pass.
