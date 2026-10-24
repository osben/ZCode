# Web Remote Control Mobile Stability Analysis

> Status: stability background analysis; some "current risks" have been fixed by later implementations.
> The current architecture is shared-host attachment + desktop `continuous` / mobile `replayable` message
> streams. Message recovery semantics are defined in `docs/web-remote-control/task-realtime-sync.md` and
> `docs/web-remote-control/web-remote-control-architecture.md`.

Full history: `git show b8876e8b:docs/web-remote-control/mobile-stability-analysis.md`

This document explains why mobile Web remote control "keeps disconnecting" and lists actionable experience
optimizations.

## Conclusion

Stability is affected by three kinds of factors at once:

1. Mobile Web platform limits: when the browser goes to the background, the screen locks, or the system is in
   low-battery/low-memory mode, pages may be hidden, frozen or discarded; WebSocket and JS timers are not
   guaranteed to keep running.
2. The mobile transport recovery strategy was coarse: after pairing, a socket close triggered a full page
   reload, with no in-place recovery state machine on `visibilitychange` / `pageshow` / `online`.
3. The external relay and network path carry semi-disconnect risk: the code already patched real issues such
   as `waiting` false positives, one-way paths and relay `INTERNAL`.

So it is not simply "the Web stack is inadequate". **Web can support this feature, but cannot guarantee a
mobile page keeps a real-time control connection in the background; product and implementation must be
designed as "real-time in foreground, recoverable from background".**

## Current connection model

```text
mobile browser /remote
  -> WebSocket terminal
  -> external relay wss://zcode.z.ai/ws
  -> WebSocket device
  -> desktop main
  -> shared-host attachment
  -> existing workspace scope in the single Host Process
```

- The desktop connects to the relay as a `device`; the mobile web as a `terminal`.
- Both ends heartbeat with `pair_status_query` / `pair_status_ack` at about 10 s, jittered within 8-12 s; if
  the latest ACK is not updated for over 30 s, a local watchdog triggers reconnection.
- All ZCode business messages are wrapped in the relay `data.payload`; the mobile UI restores
  `IMessagePassingProtocol` from `rpc-frame` and reuses the existing `Root`.
- The mobile client owns no independent Agent host process; reconnection only rebuilds the bridge attachment
  and does not destroy the still-running host/runtime.

Implementation: `packages/web/src/webRemoteControlTransport.ts`, `packages/web/src/main.tsx`,
`packages/desktop/src/main/webRemoteControlTransport.ts`,
`packages/desktop/src/main/webRemoteControlManager.ts`.

## Hard boundaries of mobile Web

- **Switching app or browser tab:** the page usually becomes hidden and may be frozen or discarded. JS timers
  may run late (the 10 s heartbeat can be delayed a lot); the WebSocket may stay open for a while or be closed
  by the system or network; a discarded page runs no JS callback, so recovery equals a full reload;
  `beforeunload` / `unload` are unreliable on mobile and cannot be the core of disconnect save/recovery.
- **Lock screen / screen off:** more aggressive than backgrounding; even if the browser does not close the
  WebSocket at once, long-term availability cannot be relied upon. Screen Wake Lock solves "user is actively
  remote-controlling but the phone auto-sleeps" but not background keep-alive: it applies only to
  active/visible documents and is released when the page is hidden, on low battery or in power-saving mode.

References: Chrome Page Lifecycle (developer.chrome.com/docs/web-platform/page-lifecycle-api), MDN Page
Visibility API, MDN WebSocket close event, MDN Screen Wake Lock API / WakeLockSentinel.

## Stability boundaries in the current implementation

1. **Mobile socket close no longer reloads the page after pairing.** The terminal transport is now a state
   machine: `connecting`, `authenticating`, `waiting`, `paired`, `reconnecting`, `suspended`, `kicked`,
   `error`. Paired socket close, network changes and background recovery first enter `reconnecting` /
   `suspended` and try in-place recovery; `reloadPage` remains only as a fallback injection point. Still to
   watch: slow recovery must still show a clear reconnecting/suspended state; old RPC frames must not be
   blindly replayed (hard recovery is re-attach bridge + snapshot alignment); non-idempotent business commands
   still need business-layer accepted acks or idempotency keys rather than transport retransmission.
2. **Mobile page lifecycle recovery.** The entry listens to `visibilitychange`, `pagehide`, `pageshow`,
   `online` and Chrome `freeze` / `resume`; recovery triggers `recoverConnection()` and re-aligns the current
   workspace/task via bridge/runtime snapshot. Still to watch: whether the host still exists after long
   background periods, whether the relay still matches, and whether the snapshot covers the replayable gap.
3. **Desktop is still more stable than mobile.** The desktop device transport calls `scheduleReconnect()`
   after socket close and treats relay `INTERNAL` as recoverable. The mobile terminal now has
   `recoverConnection()` and recoverable states, but background freezing, lock screens and system reclamation
   remain hard limits, so the product semantics stay "real-time in foreground, recoverable from background"
   and cannot promise long-term background online. The desktop keeps holding the host/runtime; the mobile
   recovers through replayable streams and snapshots when it returns.
4. **The relay has shown semi-disconnect and routing issues:** the edge layer may shard only by `query.mid`
   (relying on `X-Device-ID` alone puts desktop and mobile on different backends); paired heartbeats
   occasionally return `waiting`; the relay occasionally keeps only the mobile-to-desktop one-way path; a fast
   terminal refresh/reconnect may briefly return `INTERNAL`. These are relay/network/load-balancing issues,
   not mobile background limits.
5. **High-frequency RPC shares one relay channel.** Business RPC, workspace bridge and task realtime mirror all
   use the same relay data channel. Stream mirror already aggregates, detects seq gaps and falls back to
   snapshots, but control messages and real-time updates still share the channel under jitter. Risks: many UI
   stream frames can delay control requests; after a pending request times out, the upper layer cannot tell
   whether the desktop did not process it, the relay was one-way, or the mobile did not receive it; a replayable
   stream gap can fall back to snapshot but transport-layer RPC frames still cannot be replayed universally.

## User-perceivable disconnection scenarios

- Phone in another app/browser background for minutes, then return: page hidden/frozen/socket close; was
  reload or error page; direction: auto-reconnect and restore workspace/task on foreground recovery.
- Lock then unlock: screen off breaks the WebSocket or pauses JS; was reload, stuck or relay-unavailable
  prompt; direction: Wake Lock + recovery state machine.
- Wi-Fi to 5G switch: TCP/WebSocket disconnect; request timeout or failure; direction: `online` event
  triggers reconnect + request replay.
- Brief relay jitter: relay close / INTERNAL / waiting false positive; desktop may recover while mobile fails;
  direction: mobile uses an equivalent reconnection strategy.
- Relay one-way path: mobile sends but receives no desktop response; bootstrap/list timeout; direction:
  request-level timeout diagnostics + rebuild the terminal socket.
- Another phone scans the code: relay kick / session conflict; the current phone is kicked; direction: keep it
  a terminal failure but show the reason in text.

## Optimization proposals

**P0: productize "the background will disconnect".** Do not let users think it is an unrecoverable crash.

1. Save minimal recovery state when the page becomes hidden: `deviceSid`, `currentWorkspaceKey`,
   `currentTaskId`, `bridgeSessionId`, last successful pair time, last received desktop payload time.
2. On visible / pageshow / online: check socket readyState; if unavailable create a new terminal socket; wait
   for pair matched; resend `bootstrap-request`; send `workspace-bridge-open` with the saved workspace/task;
   re-render Root or trigger snapshot reload.
3. Show explicit status: "Connection paused", "Restoring remote control", "Recovery failed, please scan the QR code again".

Principle: promise no real-time online in the background, but make foreground recovery as automatic as possible.

**P0: mobile transport close strategy.** Do not reload on close after pairing (states as listed above).

- `KICKED` / `AUTH_FAILED` / `DEVICE_NOT_FOUND`: terminal failure.
- `close` / `error` / `desktop-bootstrap-timeout`: enter `reconnecting` with exponential backoff.
- `document.hidden`: enter `suspended`, stop high-frequency work, save recovery state.
- `document.visible`: attempt recovery immediately.
- Pending requests: idempotent ones (`bootstrap-request`, `workspace-list-request`) may auto-replay; a bridge
  switch may replay if the old/new `bridgeSessionId` relation is clear; an RPC frame must not be blindly
  replayed and needs upper-layer snapshot reconciliation.

**P0: disconnection diagnostic logs** so "always disconnecting" is traceable. Mobile logs secure metadata:
transport state transitions; WebSocket close `code` / `reason` / `wasClean`; `document.visibilityState`;
`navigator.onLine`; hidden duration; last sent/received payload time; pending request type and timeout; pair
status ack `matched` / `waiting` / `kicked`. Never log QR URL content, `hash` / `passHash`, or raw payload
JSON; for high-frequency stream/rpc frames record counts and lengths only.

**P1: foreground Wake Lock** (not implemented). Request `navigator.wakeLock.request("screen")` once `/remote`
enters an active bridge; offer an off switch ("Keep screen on"); re-apply on WakeLockSentinel `release` when
visible; degrade silently when unsupported. Wake Lock cannot keep the background alive and is released on low
battery, power-saving mode or hidden page.

**P1: snapshot reconciliation on recovery.** After the terminal recovers matched, open the bridge first; once
ready, fetch the workspace task list, the active task snapshot and the current task runtime status; if the
owner run is still running, resubscribe to dynamic task events; if the replayable stream has a gap, do not
chase every chunk: wait for a snapshot whose `runtime.streamWatermark` covers the gap, then continue the
stream. Replayable streams handle runtime continuity across recovery, and snapshots handle eventual
consistency and large-gap alignment.

**P1: connection generation and observability at the relay layer** (not implemented). Add secure metadata to
relay/app payloads: `connectionId`, `connectionGeneration`, `lastPairMatchedAt`, `lastHeartbeatAckAt`, device
and terminal `mid` routing shards, relay close reason categories, so one disconnection can be correlated
across mobile and desktop logs.

**P2: tier control requests and stream frames** (not implemented). App payload priority: high (permission
response, stop generation, workspace switch), normal (bootstrap, workspace list, platform request), low
(stream mirror batch). If the relay supports queues, forward high/normal first; keep merging mirror batches
on the desktop and pause mirrors when the mobile is invisible, leaving only snapshot invalidation.

**P2: PWA / installed state.** Add a Web App Manifest, reduce browser UI in standalone mode, save the last
recovery state. iOS/Android PWAs cannot guarantee long-lived background WebSockets or replace native
background execution.

## Recommended order

1. Diagnostic logs (visibility, close code, pending request, pair status).
2. Mobile close does not reload (paired close -> `reconnecting`; error page only for unrecoverable errors).
3. Foreground recovery state machine (visible / pageshow / online, restore workspace/task).
4. Wake Lock.
5. Relay observability (connection generation and shard logs).
6. Payload tiering and recovery protocol.

## Acceptance

Manual scenarios:

1. Enter remote control, switch to another app for 30 s and return: auto-restores the same workspace/task.
2. Lock the screen for 1 minute and unlock: auto-recovers or shows an explicit retryable state.
3. After a Wi-Fi/cellular switch: auto-reconnects, not an immediate permanent failure page.
4. When the desktop relay recovers from a brief disconnect: the mobile needs no re-scan.
5. When another phone scans and kicks the current phone: it shows a session conflict, not infinite reconnect.

Recommended unit tests: close after paired enters reconnecting, not reload; `visibilitychange hidden ->
visible` triggers recover; `online` triggers recover; idempotent requests replay after recover; `KICKED` and
`AUTH_FAILED` do not reconnect; pending RPC frames are not blindly replayed.

Recommended metrics: mobile terminal socket close counts and close-code distribution; disconnection ratio
after hidden; auto-recovery success rate after visible; average recovery time; bootstrap / workspace-list /
workspace-bridge-open timeout rates; relay `waiting` after paired counts; suspected relay one-way path counts
(mobile request sent, desktop response logged sent, mobile timeout).

User-facing wording: "Mobile Web remote control is suited to foreground real-time operation. When switching
apps, locking the screen or changing networks, the mobile browser may pause the connection; ZCode restores the
most recent workspace and task when you return. For a more stable experience keep the page in the foreground
and let the screen stay on."

## P0 implementation status

Implemented:

1. The mobile terminal transport has `reconnecting` / `suspended` states.
2. A paired socket close no longer reloads the page; it reconnects in place and triggers bootstrap after re-pairing.
3. `/remote` listens for `visibilitychange` / `pagehide` / `pageshow` / `online` / `freeze` / `resume`;
   heartbeats pause when the page hides and the terminal socket is rebuilt on foreground or network recovery.
4. Diagnostic logs record secure metadata only (state transitions, close code/reason/wasClean, visibility,
   online, hidden duration, pair status); no QR URL, hash, passHash or business payload content.
5. Automated tests cover paired close not reloading, hidden suspended, and visible/pageshow/online recovery.

Not implemented: Wake Lock, relay connection generation, payload priority, full request replay. They need UI
switches or relay/app payload protocol extensions and are advanced independently as P1/P2.
