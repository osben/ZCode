# ZCode Early Layered Architecture (Historical)

This document records the layering context from when the project began with a shared UI, Channel RPC, and service interfaces. It no longer describes the current number of Hosts, remote topology, Root props, or conversation data flow; see the [Z Code Code Architecture Overview](./zcode-code-architecture-overview.md) for current facts.

## Design Principles That Still Apply

- Desktop, Web, and mobile remote reuse `packages/ui`; platform differences are handled through dependency injection.
- The UI depends on service/protocol interfaces and does not call Repos, Node implementations, or Electron main directly.
- `packages/rpc` provides only channels, transport, proxies, events, and logging middleware; it does not own business semantics.
- `packages/services` defines Host business interfaces and Node implementations; `packages/client` creates service proxies.
- `packages/desktop` / `packages/web` handle platform composition and must not leak platform objects into the shared UI.
- New services should register a descriptor, implementation, accessor, and client proxy, and keep type imports browser-safe.

## Obsolete Early Assumptions

Early documents described the system as a “single server with HTTP/WebSocket/stdio entry points” and had the renderer assemble chat state from task/session events. These assumptions have been replaced by the following implementation:

```text
Old: Renderer reducer -> task state -> UI
New: ZCode CLI ProductProjection -> V4 topic -> read-only UI store

Old: One abstract server supports every deployment form
New: Each window has a Host/service graph + workspace-scoped CLI + remote attachment
```

The following assumptions are also obsolete:

- `Root` directly composes platform capabilities through `credentialStore` / `onConnectRemote` props;
- The UI uses `window.zcode` or a concrete service singleton;
- Credentials can be exposed directly to the renderer through the platform bridge;
- The renderer store jointly owns the task list, conversation rows, queue, and stop/fork availability;
- A remote workspace can be identified by `workspacePath` alone.

## Current Dependency Direction

```text
packages/shared  <- schema / platform contracts
packages/rpc     <- transport / channel mechanics
packages/services<- Host service interfaces + Node implementations
packages/client  <- typed service proxies
packages/ui      <- hooks + V4 projection consumers
desktop/web      <- platform composition
apps/zcode-cli   <- Agent runtime + V4 authority
```

Cross-domain code may depend only on the other domain's public types/contracts. For new conversation protocols, update `packages/shared/src/zcode-protocol-v4/` first, then synchronize the CLI, Host transport, and all clients.

## Current Entry Points

- [Code Architecture Overview](./zcode-code-architecture-overview.md)
- [Message Flow](./message-flow.md)
- [RPC Architecture](./rpc.md)
- [ZCode Protocol](../zcode-protocol.md)
