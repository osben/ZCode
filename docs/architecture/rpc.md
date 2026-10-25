# @zcode/rpc

A VS Code-style IPC communication abstraction framework. Transport-independent, type-safe, and supports bidirectional RPC and remote connections.

## Architecture Overview

The framework has seven layers, built from the bottom up:

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 6: Remote                                             │
│  RemoteAuthorityResolver → SocketFactory → PersistentProtocol│
│  → IPCClient → channel.call()                                │
├──────────────────────────────────────────────────────────────┤
│  Layer 5: ProxyChannel                                       │
│  fromService(service) ↔ toService(channel)                   │
├──────────────────────────────────────────────────────────────┤
│  Layer 4: IPCServer (1:N) / IPCClient (1:1 bidirectional)    │
│  Connection management, routing, multicast                    │
├──────────────────────────────────────────────────────────────┤
│  Layer 3: ChannelServer / ChannelClient                      │
│  Channel-based RPC (call / listen)                            │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: IMessagePassingProtocol                            │
│  send(buffer) / onMessage: Event<buffer>                     │
├──────────────────────────────────────────────────────────────┤
│  Layer 1: Serialization (VQL + type tags)                     │
│  serialize() / deserialize()                                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 0: Foundation                                         │
│  Event / Emitter / Disposable / VSBuffer / CancellationToken │
└──────────────────────────────────────────────────────────────┘
```

Each layer depends only on the one below it. Layer 3 and above are independent of the transport: Electron IPC, MessagePort, WebSocket and TCP share the same RPC code.

## File Structure

```
packages/rpc/src/
├── index.ts            # Unified exports
├── foundation.ts       # Layer 0: Event, Emitter, Disposable
├── buffer.ts           # Cross-platform binary abstraction for VSBuffer
├── serialization.ts    # Layer 1: Binary serialization
├── protocol.ts         # Layer 2: Message-passing protocol
├── channels.ts         # Layer 3: Channel RPC
├── ipc.ts              # Layer 4: Multi-connection management
├── proxy-channel.ts    # Layer 5: Automatic service proxy
└── remote.ts           # Layer 6: Remote connection infrastructure
```

---

## Layer 0: Foundation

### Disposable — Resource Lifecycle

```typescript
import { IDisposable, toDisposable, DisposableStore } from "@zcode/rpc";

// Wrap a cleanup function
const d = toDisposable(() => socket.close());

// Manage a group
const store = new DisposableStore();
store.add(subscription1);
store.add(subscription2);
store.dispose(); // Dispose everything at once
```

### Event / Emitter — Event System

`Event<T>` is a function signature: `(listener: (e: T) => void) => IDisposable`. Subscriptions return a disposable that can be used to unsubscribe.

```typescript
import { Emitter, Event } from "@zcode/rpc";

class FileWatcher {
  private _onDidChange = new Emitter<string>();
  readonly onDidChange: Event<string> = this._onDidChange.event;

  detectChange(path: string) {
    this._onDidChange.fire(path);
  }
}

// Usage
const watcher = new FileWatcher();
const sub = watcher.onDidChange((path) => console.log("changed:", path));
sub.dispose(); // Unsubscribe
```

Emitter supports lazy-initialization hooks, which are central to the framework's network efficiency:

```typescript
const emitter = new Emitter<Data>({
  onWillAddFirstListener: () => {
    /* Start fetching data when the first subscriber arrives. */
  },
  onDidRemoveLastListener: () => {
    /* Stop fetching data when the last subscriber leaves. */
  },
});
```

**Event utility methods**:

| Method                    | Purpose                                     |
| ------------------------- | ------------------------------------------- |
| `Event.once(event)`       | Fires once, then unsubscribes automatically |
| `Event.toPromise(event)`  | Converts an event to a Promise              |
| `Event.filter(event, fn)` | Filters events                              |
| `Event.map(event, fn)`    | Transforms event values                     |

### CancellationToken — Async Cancellation

```typescript
import { CancellationTokenSource } from "@zcode/rpc";

const cts = new CancellationTokenSource();
doWork(cts.token);
cts.cancel(); // Notify listeners of cancellation
cts.dispose(); // Release resources
```

---

## Layer 1: Serialization

Binary serialization, with the format `[1-byte type tag] [VQL-encoded length] [data]`.

Supported types: Undefined, String (UTF-8), Buffer, VSBuffer, Array (recursive), Object (JSON fallback), Int (VQL-encoded).

VQL (Variable-Length Quantity) encoding: small integers need only 1 byte (vs. 4 bytes in JSON), saving significant space.

```typescript
import { BufferWriter, BufferReader, serialize, deserialize } from "@zcode/rpc";

const writer = new BufferWriter();
serialize(writer, { name: "test", count: 42, data: [1, 2, 3] });
const buffer = writer.buffer;

const reader = new BufferReader(buffer);
const value = deserialize(reader); // { name: 'test', count: 42, data: [1, 2, 3] }
```

---

## Layer 2: Protocol

### IMessagePassingProtocol — Transport Abstraction

This is the framework's key abstraction boundary. Any transport that implements this interface can use all higher-level capabilities:

```typescript
interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  readonly onMessage: Event<VSBuffer>;
  drain?(): Promise<void>;
}
```

### Built-in Protocol Implementations

| Implementation        | Scenario                               | Features                                                              |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `SocketProtocol`      | TCP / raw Socket                       | 13-byte message frame header; handles TCP coalescing/splitting        |
| `PersistentProtocol`  | Scenarios requiring reliable transport | ACKs + replay of unacknowledged messages + heartbeat (5s) + reconnect |
| `MessagePortProtocol` | Web Worker / Electron IPC              | No framing needed (MessagePort preserves message boundaries)          |
| `createQueuePair()`   | Tests / in-process communication       | Returns two in-memory interconnected protocols                        |

### createQueuePair — Testing Utility

```typescript
import { createQueuePair } from "@zcode/rpc";

const [clientProtocol, serverProtocol] = createQueuePair();
// Data from clientProtocol.send() appears in serverProtocol.onMessage, and vice versa
```

---

## Layer 3: Channel RPC

### Core Concepts

**IChannel** (client view):

```typescript
interface IChannel {
  call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T>;
  listen<T>(event: string, arg?: any): Event<T>;
}
```

**IServerChannel** (server view):

```typescript
interface IServerChannel<TContext = string> {
  call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T>;
  listen<T>(ctx: TContext, event: string, arg?: any): Event<T>;
}
```

The only difference is the `ctx` parameter, which identifies the client that made the request.

### ChannelServer + ChannelClient

```typescript
import { ChannelServer, ChannelClient, createQueuePair } from "@zcode/rpc";

const [cp, sp] = createQueuePair();

// Server
const server = new ChannelServer(sp, "server-ctx");
server.registerChannel("calc", myCalculatorChannel);

// Client
const client = new ChannelClient(cp);
const calc = client.getChannel("calc");
const result = await calc.call<number>("add", [1, 2]); // Call a method
calc.listen<string>("onDidLog")((msg) => console.log(msg)); // Subscribe to an event
```

### Message Protocol

```
Client → Server:
  Promise(100)       Call method
  PromiseCancel(101) Cancel call
  EventListen(102)   Subscribe to event
  EventDispose(103)  Unsubscribe

Server → Client:
  Initialize(200)      Handshake complete
  PromiseSuccess(201)  Call succeeded
  PromiseError(202)    Call failed (Error)
  PromiseErrorObj(203) Call failed (non-Error)
  EventFire(204)       Event fired
```

---

## Layer 4: IPCServer / IPCClient

### IPCServer — One-to-Many

One server manages multiple client connections. Supports reverse RPC (server calls client).

```typescript
import { IPCServer, IPCClient, StaticRouter, createQueuePair } from "@zcode/rpc";

// Server listens for connection events
const server = new IPCServer(onDidClientConnect);

// Register a global service (available to all clients)
server.registerChannel("config", configChannel);

// Reverse RPC: server calls a specific client
const windowChannel = server.getChannel(
  "windowInfo",
  new StaticRouter((ctx) => ctx === "window-1"),
);
const title = await windowChannel.call<string>("getTitle");

// Multicast: aggregate events from all clients
const allEvents = server.getChannel("notifications", () => true).listen("onNotification");
```

### IPCClient — One-to-One, Bidirectional

Acts as both client and server, suitable for peer-to-peer communication:

```typescript
const ipcClient = new IPCClient(protocol, "my-client-id");

// Call the remote side as a client
const remote = ipcClient.getChannel("service");

// Register a local service as a server
ipcClient.registerChannel("localService", myChannel);
```

---

## Layer 5: ProxyChannel

ProxyChannel exposes and consumes services with zero boilerplate.

### The Problem

Without ProxyChannel, every service needs a hand-written switch-case mapping:

```typescript
// Repeated for every service
class FileServiceChannel implements IServerChannel {
  call(ctx, command, arg) {
    switch (command) {
      case "readFile":
        return this.service.readFile(arg[0]);
      case "writeFile":
        return this.service.writeFile(arg[0], arg[1]);
      // ... manually map every method
    }
  }
}
```

### The Solution

```typescript
import { ProxyChannel } from "@zcode/rpc";

// Server: expose in one line
const channel = ProxyChannel.fromService(fileService);
server.registerChannel("fs", channel);

// Client: consume in one line
const fs = ProxyChannel.toService<IFileService>(client.getChannel("fs"));
await fs.readFile("/path"); // Just like calling a local method
fs.onDidChangeFile((e) => console.log(e)); // Event subscription is just as transparent
```

### Naming Convention

ProxyChannel automatically distinguishes methods and events by naming convention:

| Naming pattern           | Type                                 | Example                       |
| ------------------------ | ------------------------------------ | ----------------------------- |
| `onXxx` (on + uppercase) | Static event                         | `onDidChange`, `onError`      |
| `onDynamicXxx`           | Dynamic event (method returns Event) | `onDynamicDidChangeFile(uri)` |
| Other                    | RPC method                           | `readFile`, `writeFile`       |

### Event Buffering

`fromService` buffers events automatically—events fired before the first subscriber arrives are not lost; the buffer is flushed when the subscription starts.

---

## Layer 6: Remote

Complete remote connection infrastructure supporting SSH, WSL, Docker, and other scenarios.

### Core Components

**RemoteAuthorityResolverService** — resolves remote authorities:

```typescript
// Authority format: "type+identifier", e.g. "ssh+myserver", "wsl+Ubuntu"
const resolver = new RemoteAuthorityResolverService();
resolver.register("ssh", sshResolver);

const result = await resolver.resolve("ssh+myserver");
// → { authority, connectTo: WebSocketRemoteConnection | ManagedRemoteConnection }
```

**RemoteSocketFactoryService** — creates connections:

```typescript
const factory = new RemoteSocketFactoryService();
factory.register(RemoteConnectionType.WebSocket, webSocketFactory);

const socket = await factory.connect(connectTo, path, query);
```

**createURITransformer** — transforms URI schemes:

```
Client → Server:
  vscode-remote://ssh+myserver/home/user/file.txt → file:///home/user/file.txt

Server → Client:
  file:///home/user/file.txt → vscode-remote://ssh+myserver/home/user/file.txt
```

### RemoteAgentConnection

Manages the full lifecycle: resolve authority → create socket → wrap in PersistentProtocol → return IPCClient. Supports automatic reconnect after disconnection (exponential backoff: 0, 5, 5, 10, 10, 10, 10, 10, 30 seconds).

```typescript
const connection = new RemoteAgentConnection("ssh+myserver", resolver, socketFactory);
const ipcClient = await connection.connect();

// Use remote services transparently
const remoteFS = ProxyChannel.toService<IFileService>(ipcClient.getChannel("filesystem"));
await remoteFS.readFile("/remote/path");

// Listen for connection status
connection.onDidStateChange((state) => {
  // 'connected' | 'reconnecting' | 'disconnected'
});
```

---

## Typical Usage Patterns

### Simplest Pattern: Direct RPC

```typescript
const [cp, sp] = createQueuePair();
const server = new ChannelServer(sp, "ctx");
const client = new ChannelClient(cp);

server.registerChannel("myService", ProxyChannel.fromService(myService));

const remote = ProxyChannel.toService<IMyService>(client.getChannel("myService"));
await remote.doSomething();
```

### Electron Main Process ↔ Renderer Process

```typescript
// Main process
const protocol = new MessagePortProtocol(electronPort);
const server = new ChannelServer(protocol, "main");
server.registerChannel("app", ProxyChannel.fromService(appService));

// Renderer process
const protocol = new MessagePortProtocol(electronPort);
const client = new ChannelClient(protocol);
const app = ProxyChannel.toService<IAppService>(client.getChannel("app"));
```

### Multi-Window Management

> General RPC capability note: Each ZCode workspace window owns a single Window Host. Base and remote-scoped
> MessagePorts connect to that Host; SSH/WSL pools and Docker/Server dedicated connections are Host-internal resources,
> and do not correspond to additional Host processes. Channels/contexts must isolate window, remoteSessionId, attachment, and workspaceKey.

```typescript
const server = new IPCServer(onDidWindowConnect);
server.registerChannel("config", ProxyChannel.fromService(configService));

// Send a command to a specific window
const targetWindow = server.getChannel("window", (ctx) => ctx === "window-2");
await targetWindow.call("focus");

// Aggregate events from all windows
const allCloses = server.getChannel("window", () => true).listen("onDidClose");
```

---

## Design Principles

1. **Transport-independent** — `IMessagePassingProtocol` is the sole abstraction boundary; a new transport only needs to implement this interface
2. **Lazy subscriptions** — events generate network traffic only when subscribed to (driven by Emitter hooks)
3. **Disposable everything** — every component implements `IDisposable`, preventing resource leaks
4. **Error propagation** — exceptions are serialized and reconstructed automatically, preserving the stack trace
5. **Zero-boilerplate proxies** — ProxyChannel uses naming conventions + ES6 Proxy to eliminate hand-written mappings
6. **Reliable transport** — PersistentProtocol provides ACKs + message replay + heartbeats + reconnect after disconnection

## Run Examples

```bash
pnpm --filter @zcode/rpc demo:basic    # Basic RPC
pnpm --filter @zcode/rpc demo:proxy    # ProxyChannel
pnpm --filter @zcode/rpc demo:remote   # Remote connection
```
