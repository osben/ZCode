# RPC Channel Initialization Timing and the "Unknown channel" Issue

## Symptom

In Remote mode, an error appears when the window opens:

```
[DirectoryBrowser] 获取系统信息失败: Unknown channel: Channel name 'system'
timed out after 1000ms
```

## ChannelClient state transitions

```
Uninitialized ──[receives Initialize(200)]──→ Idle ──[sends request]──→ Idle (remains)
```

- **Uninitialized**: the server's Initialize has not arrived; all requests are queued automatically (`whenInitialized()`) and do not time out.
- **Idle**: Initialize has arrived; requests are sent immediately.

## Communication flow

### Local mode (works)

`ChannelServer` sends `Initialize` in its constructor, and `createLocalServices()` / `exposeOnChannelServer()` / `registerChannel` run synchronously right after. By the time the Renderer receives `Initialize` and sends a request, the `system` channel is already registered.

### Remote mode (buggy)

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
                                  │                                 ─── after 1000ms ───
                                  │                                 timeout! Error:
                                  │                                 "Unknown channel: 'system'"
                                  ... SSH is still connecting ...
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)    ← too late; the request has timed out
```

**Root cause:** `ChannelServer` sends `Initialize` during construction, so the Renderer assumes the server is ready and sends a request immediately. SSH has not connected yet and the `system` channel is not registered, so the request times out after 1000 ms.

### Remote mode after the fix

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
                                  │                                 request queued until Initialize (no timeout)
                                  │
                                  services.exposeOnChannelServer()
                                  registerChannel("system", ...)
                                  server.ready() ─── sends Initialize → receives Initialize
                                                                     ChannelClient: Uninitialized → Idle
                                                                     queued request sent; handled directly
                                                                  ← ─ result returned ────────────────→
```

## Fix

`ChannelServer` has a `deferInit` option:

- **Local mode**: send `Initialize` immediately during construction (no behavior change).
- **Remote mode**: do not send `Initialize` during construction; call `server.ready()` to send it manually after all `registerChannel` calls complete.

Files involved:

- `packages/rpc/src/channels.ts`: `deferInit` constructor parameter and `ready()` method.
- `packages/rpc/src/logging-middleware.ts`: forwards `ready()` through `LoggingChannelServer`.
- `packages/desktop/src/host/index.ts`: passes `deferInit=true` in Remote mode and calls `server.ready()` after registering services.

## Pending request lifecycle (unregistered channels)

After `Initialize`, a request for a channel that is not registered yet is held by `ChannelServer` in `pendingRequests` (owner: `ChannelServer`, keyed by channel name, records identified by request id). `registerChannel` flushes the bucket on the next tick.

| Event | Promise request | EventListen request |
| --- | --- | --- |
| Channel registers before the timeout | Executed once | Subscribed once |
| Timeout (`timeoutDelay`, default 1000 ms) | `PromiseError` sent, record **removed**; a later registration never executes it | `console.error` only; record **kept** so a later registration subscribes |
| Client sends `PromiseCancel` while pending | Record removed; never executed | n/a |
| Client sends `EventDispose` while pending | n/a | Record removed; never subscribed |
| `ChannelServer.dispose()` | All pending timers cleared, map emptied | Same |

Rationale:

- The client rejects and forgets a Promise on timeout or cancel. Executing it later would run a side effect whose result nobody can observe (a double-execution window for mutations), and keeping the record leaks its arguments for the server lifetime.
- The client never receives an error for a pending EventListen and keeps its emitter until the last listener is removed, so a late registration still yields a working subscription. The record is released when the client removes its last listener (`EventDispose`) or when the server is disposed. `ChannelClient.dispose()` does not send `EventDispose`, so every transport owner must dispose its `ChannelServer` when the transport closes, the same requirement that applies to active subscriptions.
- A flow that legitimately needs more than `timeoutDelay` to register channels must use `deferInit` or a larger `timeoutDelay`, not rely on late execution.

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
