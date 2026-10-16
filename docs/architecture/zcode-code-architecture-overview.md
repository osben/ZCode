# Z Code Code Architecture Overview (Current Facts)

> This is the current entry point for process and layer architecture. Historical proposals and migration plans do not supersede the facts stated here.

## The Model in One Sentence

Z Code can run multiple workspace windows. Each window has exactly one Window Host, and each `workspaceKey` has at most one chat CLI. The Renderer accesses capabilities only through service/protocol boundaries; the CLI owns authoritative conversation state. Connections and scoped services for remote workspaces are also managed by the same Host for that window.

```text
Electron App
├─ Main Process (scheduling/native capabilities/attachment relay)
└─ Workspace Window (a separate set for each window)
   ├─ Renderer
   └─ Window Host (the sole PID)
      ├─ LocalSource
      │  ├─ workspaceKey A ── stdio ── zcode-cli A
      │  └─ workspaceKey B ── stdio ── zcode-cli B
      ├─ RemoteConnectionRegistry
      │  ├─ SSH / WSL pooled connection
      │  ├─ Docker / Server dedicated connection
      │  └─ remoteSessionId -> workspaceKey scoped services
      ├─ ControllerProjection (workspace/task list facts)
      └─ AttachmentRegistry
         ├─ desktop-continuous
         └─ web-remote-replayable
```

Window, Host, connection, and workspace are different levels. A Window Host isolates local CLIs by `workspaceKey` and maintains remote connections and logical sessions in-process. SSH shares one connection and one remote `zcode-server` within a window for the same normalized target. WSL shares connections by normalized distro/user and retains the existing 60-second idle TTL and running-task protection. Docker and Server keep dedicated connections. Every transport still retains its own `remoteSessionId`, attachment, and `workspaceKey`; connection reuse does not merge workspace identities.

## Process Responsibilities

### Main Process

Handles platform coordination only: window lifecycle, native dialogs, external URLs, OAuth callbacks, supervision of the window's sole Host Process, thin forwarding of remote-connection control requests and MessagePort/broadcast/remote-control attachments, and log receipt. Main does not own connection pools, logical-session lifecycles, task projections, rows, streams, queues, snapshots, goals, or interaction state; the Window Host assigns `remoteSessionId`.

### Renderer

Owns the React UI, routing, layout, and local state such as drafts/scroll/focus; sends intents through hooks/service proxies and V4 transport; subscribes to snapshots/deltas to render projections. The Renderer does not call Repo/Node/CLI directly or maintain a second authoritative conversation.

### Host Process

Initializes window-local services through `createLocalServices({ parentPort })` and maintains `RemoteConnectionRegistry`, `ControllerProjection`, and `AttachmentRegistry` in the same process. The Host selects or starts a local CLI by `workspaceKey`, or routes a scoped facade to the authoritative remote service. Controller owns list membership, online/running/waiting facts, and list-write routing; the Host does not assemble conversation rows, streams, permissions, or runtime snapshots on behalf of the CLI reducer.

Each window registers only one realtime `hostId`. Every attachment independently owns its trusted `clientMode`, subscriptions, `seq`, backpressure, and disposal; closing one attachment does not destroy a connection with other owners. On remote disconnection, retain the last trusted task projection and mark it offline; all IO/mutations fail closed, with no fallback to local. After reconnection, atomically replace it with a new source snapshot.

Actual window close, app quit, and update install wait only for that window's sole Host. Inside the Host, release attachments, the remote registry, and local services with bounded waits. Disconnecting a mobile attachment releases only that attachment and does not enter the Host shutdown barrier.

### zcode-cli

There is at most one chat CLI process per `workspaceKey`. The CLI owns the session/core runtime, V4 command inbox, idempotency/CAS adjudication, ProductProjection reducer, conversation topic, queue, goal, interaction, tool, and model runtime state.

## Workspace Identity

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

- Use `workspaceKey` for identity/isolation: CLI mapping, session binding, caching, queues, persistence, and cross-process correlation.
- Use `workspacePath` for file operations: cwd, file reads/writes, Git, and path display.
- SSH/WSL/Docker must pass `workspaceIdentity`; remote control also carries `remoteSessionId` end to end.

Do not infer the same workspace identity from the same remote path, and do not hand-write the remote identity format in business code.

## Monorepo Layers

| Module              | Responsibility                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| `packages/shared`   | Cross-process types, V4 schemas, workspace identity, and platform contracts |
| `packages/rpc`      | Channel RPC, MessagePort/WebSocket transport, and logging middleware        |
| `packages/services` | Host business-service interfaces and Node implementations                   |
| `packages/client`   | Service proxies and client transport composition                            |
| `packages/ui`       | Platform-independent React UI, hooks, and V4 projection store               |
| `packages/desktop`  | Electron main/preload/renderer/host shell                                   |
| `apps/zcode-cli`    | Agent core, commands, projections, and app-server                           |

```text
UI -> hooks/types -> service/protocol contracts
Host services -> adapters/interfaces -> runtime implementations
Desktop/Web shells -> dependency injection -> shared UI
```

The UI must not call Repos directly; Services must not reference concrete Runtime implementations; cross-domain imports of non-Types modules and circular dependencies are prohibited.

## Conversation Data Flow

```text
UI command
  -> Host transport
  -> workspace CLI command inbox
  -> core events
  -> ProductProjection
  -> snapshot/delta
  -> SessionDataLayer
  -> ConversationProjectionStore
  -> UI rows/status/composer
```

Desktop and mobile share this source-of-truth path. The only difference is the delivery profile: desktop is continuous; mobile is replayable and recovers from gaps with a snapshot. Relay/Main must not hold business state.

## Platform Abstractions and UI Rules

- The UI accesses platform capabilities such as directory selection and external links through `IPlatformService`.
- Components obtain dependencies through hooks such as `useServices()` and `usePlatform()`; they do not use `window.zcode` or service singletons directly.
- Handle Desktop/Web/Mobile differences through composition and dependency injection; do not hard-code platform branches into shared components.

## Current Sources of Truth

- [Communication Protocol Layers](./communication-protocol-layers.md)
- [ZCode Protocol](../zcode-protocol.md)
- [Message Flow](./message-flow.md)
- [Web Remote Control Architecture](../web-remote-control/web-remote-control-architecture.md)
- [Task Realtime Sync](../web-remote-control/task-realtime-sync.md)
- [Chat Message Queue](../ui/chat-message-queue.md)
