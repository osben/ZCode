# RPC Channel Initialization Timing and the "Unknown channel" Issue

## Symptoms

In Remote mode, an error appears when the window opens:

```
[DirectoryBrowser] 获取系统信息失败: Unknown channel: Channel name 'system'
timed out after 1000ms
```

## ChannelClient State Transitions

```
Uninitialized ──[receives Initialize(200)]──→ Idle ──[sends request]──→ Idle (remains)
```

- **Uninitialized**: the server's Initialize has not arrived; all requests are queued automatically (`whenInitialized()`) and do not time out.
- **Idle**: Initialize has arrived; requests are sent immediately.

## Full Communication Flow

### Local Mode (Working)

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer()
                                  ├── immediately sends Initialize ─→ receives Initialize
                                  ├── state → Idle                   ChannelClient: Uninitialized → Idle
                                  │
                                  createLocalServices()  (synchronous)
                                  exposeOnChannelServer()  (synchronous)
                                  registers file/system/terminal/...
                                                                     DirectoryBrowser mounts
                                                                     useEffect → systemService.info()
                                                                     RPC request sent ← ─ ─ ─ ─ ─ ─ ─ ─ ─
                                                                  ← ─ system channel is registered; handled directly
                                                                     result returned ─────────────────→
```

**No issue:** `registerChannel` runs synchronously immediately after `Initialize` is sent. By the time the Renderer receives `Initialize` and sends a request, the channel is already registered.

### Remote Mode (Buggy)

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer()
                                  ├── immediately sends Initialize ─→ receives Initialize
                                  │                                 ChannelClient: Uninitialized → Idle
                                  │
                                  await setupRemoteConnection()     DirectoryBrowser mounts
                                    (SSH connection may take 2–5 s)  useEffect → systemService.info()
                                  │                                 RPC request sent ─ ─ ─ ─ ─ ─ ─ ─ →
                                  │                                 system channel does not exist!
                                  │                                 added to pendingRequests queue
                                  │                                 starts 1000ms timeout timer
                                  │
                                  │                                 ─── after 1000ms ───
                                  │                                 timeout! Error:
                                  │                                 "Unknown channel: 'system'"
                                  │
                                  ... SSH is still connecting ...
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)    ← too late; the request has timed out
```

**Root cause:** `ChannelServer` sends `Initialize` during construction, so the Renderer assumes the server is ready and sends a request immediately. But SSH has not connected yet, and the `system` channel has not been registered; the request times out after 1000 ms.

### Remote Mode After the Fix

```
Main Process                    Host Utility Process              Renderer
───────────                     ─────────────────                 ────────
fork host process ──────────→
                                parentPort.on("message")
                                  new ChannelServer(deferInit=true)
                                  ├── does not send Initialize
                                  │                                 ChannelClient: remains Uninitialized
                                  │
                                  await setupRemoteConnection()
                                    (SSH connection may take 2–5 s)  DirectoryBrowser mounts
                                  │                                 useEffect → systemService.info()
                                  │                                 ChannelClient remains Uninitialized
                                  │                                 request is queued until Initialize (no timeout)
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)
                                  server.ready() ─── sends Initialize → receives Initialize
                                                                     ChannelClient: Uninitialized → Idle
                                                                     queued request sent immediately ─ → system channel is registered; handled directly
                                                                  ← ─ result returned ────────────────→
```

## Fix

Add a `deferInit` option to `ChannelServer`:

- **Local mode**: send `Initialize` immediately during construction (no behavior change).
- **Remote mode**: do not send `Initialize` during construction; call `server.ready()` to send it manually after all `registerChannel` calls complete.

Files involved:

- `packages/rpc/src/channels.ts` — add the `deferInit` parameter to the `ChannelServer` constructor and add a `ready()` method.
- `packages/rpc/src/logging-middleware.ts` — forward `ready()` through `LoggingChannelServer`.
- `packages/desktop/src/host/index.ts` — pass `deferInit=true` in Remote mode and call `server.ready()` after registering services.

## Pending Request Lifecycle (Unregistered Channels)

After `Initialize`, a request for a channel that is not registered yet is held by `ChannelServer` in `pendingRequests` (owner: `ChannelServer`, keyed by channel name, records identified by request id). `registerChannel` flushes the bucket on the next tick.

Rules:

| Event                                      | Promise request                                                                 | EventListen request                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Channel registers before the timeout       | Executed once                                                                   | Subscribed once                                                          |
| Timeout (`timeoutDelay`, default 1000 ms)  | `PromiseError` sent, record **removed**; a later registration never executes it | `console.error` only; record **kept** so a later registration subscribes |
| Client sends `PromiseCancel` while pending | Record removed; never executed                                                  | —                                                                        |
| Client sends `EventDispose` while pending  | —                                                                               | Record removed; never subscribed                                         |
| `ChannelServer.dispose()`                  | All pending timers cleared, map emptied                                         | Same                                                                     |

Rationale:

- The client rejects and forgets a Promise on timeout or cancel. Executing it later would run a side effect whose result nobody can observe (double-execution window for mutations), and keeping the record leaks its arguments for the server lifetime.
- The client never receives an error for a pending EventListen and keeps its emitter until the last listener is removed, so a late registration still yields a working subscription. The record is released when the client removes its last listener (`EventDispose`) or when the server is disposed. `ChannelClient.dispose()` does not send `EventDispose`, so every transport owner must dispose its `ChannelServer` when the transport closes — the same requirement that already applies to active subscriptions.
- A flow that legitimately needs more than `timeoutDelay` to register channels must use `deferInit` (above) or a larger `timeoutDelay`, not rely on late execution.

Event order for a Promise to a channel that registers late:

```
client                         ChannelServer
──────                         ─────────────
call(id=7) ──────────────────→ channel missing → pendingRequests["x"] = [{id 7, timer}]
                               ... timeoutDelay ...
         ←── PromiseError(7) ── timer fires → record 7 removed
reject; handler deleted
                               registerChannel("x") → flush: bucket empty → nothing runs
```
