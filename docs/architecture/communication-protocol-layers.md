# Z Code Communication Protocol Layers (Current Facts)

> This document provides the simplest model for understanding communication between current processes. It is the project's three-layer mental model, not a requirement that every path pass through the same protocol stack.

## The Three Layers

```text
Layer 3: Content — what to do
Layer 2: Envelope — how to describe, number, and match messages
Layer 1: Channel — which pipe carries the message
```

Think of sending a parcel:

```text
Item inside the parcel = business content
Shipping label and packaging = message protocol
Truck, road, or plane = transport channel
```

Sending packages downward from Layer 3; receiving unpacks upward from Layer 1.

## Layer 1: Channel (Transport)

Channels only carry bytes or structured messages; they do not understand business concepts such as chat, files, or Git.

The project currently uses these channels:

- `MessagePort`: the local port between the Renderer and Window Host.
- `stdio`: standard input/output between the Host and `zcode-cli`, and between `zcode-server` and its Agent child process.
- `WebSocket`: connects to an existing `zcode-server` or to the mobile remote-control Relay.
- Electron IPC: platform calls between the Renderer and Main.
- UtilityProcess `postMessage`: process-control messages between Main and the Window Host.

This layer answers: **“Which pipe does the message travel through?”**

## Layer 2: Envelope (Message / Call Protocol)

This layer packages content into messages that can be processed and answers:

- Is this a request, response, or event?
- What is the request ID?
- Which service and method should be called?
- Which request should the response match?
- How is the data serialized?

There are three main forms today:

### `@zcode/rpc`

The general Service call protocol supports `call`, `response`, `listen`, and event notifications. It is used mainly for:

- Renderer ↔ Window Host;
- Window Host ↔ remote `zcode-server`.

### ZCode Protocol JSON envelope

The JSON request/response/notification envelope used between the Host and `zcode-cli`. A typical structure is shown below (some identity fields are omitted for readability):

```json
{
  "id": 42,
  "method": "v4/command",
  "params": {
    "commandId": "cmd-123",
    "clientId": "desktop-client",
    "sessionId": "session-1",
    "type": "sendText",
    "payload": { "text": "Hello" }
  }
}
```

These JSON objects are usually sent over stdio as NDJSON (one JSON object per line).

### Typed IPC / `postMessage`

Main's control messages do not use the general `@zcode/rpc`; instead, Main sends structured objects directly with a `type`, for example:

```ts
{
  type: "attach-service-port",
  attachmentId: "...",
  clientMode: "desktop-continuous",
}
```

Here, `type` itself provides the message-routing information.

## Layer 3: Content (Business Meaning)

This layer defines the actual business meaning of a message.

### V4 Conversation Protocol

V4 owns Agent session and conversation facts, including:

- Commands: `createSession`, `sendText`, `stop`, `compact`, `switchModelConfig`;
- Command ACKs: accepted, rejected, expired, duplicate, and so on;
- conversation topic:snapshot, delta, `seq`, `revision`;
- Subscriptions, reconnect recovery, and resync;
- Delivery semantics for `desktop-continuous` and `web-remote-replayable`.

The `zcode-cli` for a workspace is the final source of truth for V4 and adjudicates commands; the Renderer, Main, and Relay do not.

### Service API

The Service API exposes Host capabilities, for example:

- `fileService.readFile`;
- `terminalService.create`;
- `gitService.status`;
- `zcodeAgentService.sendConversationCommandV4`;
- `zcodeAgentService.subscribeConversationV4`.

The Service API can carry V4 as well as non-V4 capabilities such as files, terminals, and Git.

### Host Control Messages

Main and Host exchange process and connection controls, such as:

- initializing the Host;
- `ConnectRemoteWorkspace`;
- `AttachServicePort` / `DetachServicePort`;
- rebinding an attachment after the Renderer reloads.

These are not V4 conversation commands.

## Mapping Between Communication Paths

| Path                        | Layer 3: Content                                    | Layer 2: Envelope            | Layer 1: Channel       |
| --------------------------- | --------------------------------------------------- | ---------------------------- | ---------------------- |
| Renderer → Host             | Service API, V4 commands/queries/subscriptions      | `@zcode/rpc`                 | `MessagePort`          |
| Renderer → Main             | Platform operations                                 | Electron IPC channel         | Electron IPC           |
| Main → Host                 | Host control messages                               | typed `{ type, ... }`        | `postMessage`          |
| Host → local CLI            | V4 and a small number of legacy operations          | ZCode Protocol JSON          | stdio NDJSON           |
| Host → `zcode-server`       | Remote Service API, possibly carrying V4 parameters | `@zcode/rpc`                 | SSH stdio or WebSocket |
| `zcode-server` → remote CLI | V4 and a small number of legacy operations          | ZCode Protocol JSON          | stdio NDJSON           |
| Mobile → Relay → Main       | Remote-control Service/V4 calls                     | relay envelope + `rpc-frame` | WebSocket              |

Mobile remote control also enters the existing Window Host through a shared-host attachment. Relay and Main handle only authentication, pairing, heartbeats, frame forwarding, and attachment scheduling; they do not hold conversation/task/stream business state.

## Full Path of a Remote `sendText`

```text
Layer 3: V4 sendText command
        │
        ▼
Renderer
  Layer 2: @zcode/rpc call to sendConversationCommandV4(...)
  Layer 1: MessagePort
        │
        ▼
Window Host
  Layer 2: remote @zcode/rpc Service call
  Layer 1: SSH stdio / WebSocket
        │
        ▼
zcode-server
  Layer 2: ZCode Protocol JSON, method = "v4/command"
  Layer 1: child-process stdio
        │
        ▼
remote zcode-cli
  CommandInbox adjudicates and executes sendText
```

The same V4 command can be carried by multiple “calls,” but a “command” and a “call” are not the same concept:

```text
V4 command = a specific business intent, such as sendText
V4 call = a Service API call that sends the command to the next hop
```

Therefore, “Host → zcode-server: V4 call” in the screenshot is more accurately described as:

> **Remote Service RPC carrying a V4 command or query in its parameters.**

## Related Implementation Entry Points

- [Code Architecture Overview](./zcode-code-architecture-overview.md)
- [Message Flow](./message-flow.md)
- [`@zcode/rpc` Layered Implementation](../../packages/rpc/src/index.ts)
- [V4 command schema](../../packages/shared/src/zcode-protocol-v4/command.ts)
- [V4 transport schema](../../packages/shared/src/zcode-protocol-v4/transport.ts)
- [Remote RPC Connection](../../packages/server/src/remote/connect.ts)
- [zcode-server stdio RPC server](../../packages/server/src/stdio.ts)
- [Agent ZCode Protocol client](../../packages/services/src/zcode-agent/zcodeProtocolClient.ts)
