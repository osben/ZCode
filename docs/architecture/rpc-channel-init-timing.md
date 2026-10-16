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
