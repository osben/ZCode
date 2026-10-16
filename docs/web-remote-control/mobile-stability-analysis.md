# Web Remote Control Mobile Stability Analysis

> Status: Stability background analysis; some "current risks" have been fixed by subsequent implementations.
>
> The current effective architecture is shared-host attachment + desktop `continuous` / mobile `replayable`
> message streams. Specific message recovery semantics are defined in `docs/web-remote-control/task-realtime-sync.md`
> and `docs/web-remote-control/web-remote-control-architecture.md`.

This document analyzes the main reasons why mobile Web remote control "disconnects always" and provides actionable experience optimization directions.

## Conclusion

The current implementation's stability boundaries are not a single issue. They are simultaneously affected by three types of factors:

1. Mobile Web platform limitations: When a mobile browser switches to the background, locks the screen, or the system is in low-battery or low-memory mode, pages may be hidden, frozen, or discarded; WebSocket and JS timers cannot guarantee continued operation.
2. The current mobile transport recovery strategy is coarse: after pairing, a socket close triggers a full page reload, lacking an in-place recovery state machine triggered by `visibilitychange` / `pageshow` / `online`.
3. The external relay and network path carry semi-disconnect risks: the code has already patched actual issues like `waiting` false positives, one-way paths, and relay `INTERNAL`, indicating that stability depends on more than just the browser.

Therefore, it cannot be simply attributed to "the Web stack is inadequate." The correct judgment is: **Web can support this feature, but it cannot guarantee that a mobile page maintains a real-time control connection for extended periods in the background; both product and implementation must be designed around "real-time in foreground, recoverable from background".**

## Current Connection Model

The current `/remote` uses an external relay:

```text
mobile browser /remote
  -> WebSocket terminal
  -> external relay wss://zcode.z.ai/ws
  -> WebSocket device
  -> desktop main
  -> shared-host attachment
  -> existing workspace scope in the single Host Process
```

Key points:

- The desktop connects to the relay as a `device`.
- The mobile web connects to the same relay as a `terminal`.
- Both ends use `pair_status_query` / `pair_status_ack` for heartbeats at an average of 10 seconds, bounded to 8~12 seconds of jitter; when the most recent ACK has not been updated for over 30 seconds, a local watchdog triggers reconnection.
- All ZCode business messages are wrapped in the relay `data.payload`.
- The mobile UI还原s to `IMessagePassingProtocol` through `rpc-frame`, then reuses the existing `Root`.
- The mobile client does not own an independent Agent host process; reconnection only rebuilds the bridge attachment, without destroying the still-running host/runtime.

Corresponding implementation:

- `packages/web/src/webRemoteControlTransport.ts`
- `packages/web/src/main.tsx`
- `packages/desktop/src/main/webRemoteControlTransport.ts`
- `packages/desktop/src/main/webRemoteControlManager.ts`
- `docs/web-remote-control/web-remote-control-architecture.md`

## Hard Boundaries of Mobile Web

### Switching App or Browser Tab

After a mobile user switches to another App, the page typically enters a hidden state. Modern browsers can further freeze or discard the page to save power and memory.

This produces several results:

- JS timers may not run on schedule; the 10-second heartbeat may be delayed significantly.
- WebSocket may remain open for a while, or may be closed by the system or network layer.
- When the page is discarded, no JS callback can run; recovery is equivalent to a full reload.
- `beforeunload` / `unload` are unreliable on mobile and cannot serve as the core mechanism for disconnection save and recovery.

External references:

- Chrome Page Lifecycle: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- MDN Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN WebSocket close event: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close_event

### Lock Screen and Screen Off

Locking the screen is more aggressive than simply switching to the background. Even if the browser does not immediately close the WebSocket in the short term, it cannot be relied upon for long-term availability.

Screen Wake Lock can address the "user is actively remote-controlling but the phone auto-screens-off" problem, but cannot solve background preservation after switching apps. Wake Lock only applies to active / visible documents; it is released when the page is hidden, the device is low on power, or in power-saving mode.

External references:

- MDN Screen Wake Lock API: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- MDN WakeLockSentinel: https://developer.mozilla.org/en-US/docs/Web/API/WakeLockSentinel

## Stability Boundaries in the Current Implementation

### 1. Mobile Socket Close No Longer Reloads Page After Pairing

In early implementations, `WebRemoteControlTerminalTransport` would call `reloadPage()` after receiving a close during the paired state. The current implementation has been changed to a connection state machine:

- `connecting`
- `authenticating`
- `waiting`
- `paired`
- `reconnecting`
- `suspended`
- `kicked`
- `error`

Paths such as paired socket close, network changes, and background recovery first enter `reconnecting` / `suspended` and attempt in-place recovery. `reloadPage` is kept only as a fallback injection point, not the primary strategy for paired close.

Still worth monitoring:

- When recovery takes too long, the UI must still display a clear reconnecting/suspended state.
- Old RPC frames should not be blindly replayed; hard recovery should use re-attach bridge + snapshot alignment as the boundary.
- Non-idempotent business commands still need business-layer accepted acks or idempotency keys, not reliance on transport retransmission.

### 2. Mobile Page Lifecycle Recovery State Machine

The current entry point already listens to key mobile lifecycle events:

- `visibilitychange`
- `pagehide`
- `pageshow`
- `online`
- Chrome's `freeze` / `resume`

Page recovery triggers `recoverConnection()`, and the current workspace/task is re-aligned via bridge/runtime snapshot. Still worth monitoring is whether the host still exists after long background periods, whether the relay is still matched, and whether the snapshot covers the replayable gap.

### 3. Desktop Remains More Stable Than Mobile

The desktop device transport automatically calls `scheduleReconnect()` after socket close. Relay `INTERNAL` is also treated as a recoverable error.

The mobile terminal transport now also has `recoverConnection()` and recoverable states, but mobile browser background freezing, lock screens, and system reclamation remain hard boundaries. Therefore, the product semantics should remain "real-time in foreground, recoverable from background," and cannot promise long-term online in the background.

This creates an asymmetric experience: the desktop can run long-term and continue holding the host/runtime; when the mobile returns, it must recover through replayable streams and snapshots.

### 4. Relay Has Already Experienced Semi-Disconnect and Routing Issues

Existing code comments indicate several categories of relay issues have been encountered:

- The external relay edge layer may shard only by `query.mid`, relying solely on `X-Device-ID` causes the desktop and mobile to fall to different backends.
- In paired sessions, heartbeats occasionally return `waiting`.
- The relay occasionally retains only a one-way path from mobile to desktop; the desktop has responded but the mobile does not receive it.
- When the terminal refreshes/reconnects quickly, the relay may briefly return `INTERNAL`.

These are not mobile browser background limitations; they are stability issues at the relay / network / load-balancing layers.

### 5. High-Frequency RPC Relies on the Same Relay Channel

Current business RPC, workspace bridge, and task realtime mirror all go through the same relay data channel. Stream mirror has already implemented aggregation, seq gap detection, and snapshot fallback, but control messages and real-time updates still share the same channel during link jitter.

Risks:

- A large number of UI stream frames may affect the response latency of control requests.
- After pending request timeouts, the upper layer cannot determine whether the desktop did not process it, the relay was one-way disconnected, or the mobile did not receive it.
- The gap in replayable streams can fall back to snapshots, but transport-layer RPC frames still cannot be universally replayed.

## User-Perceivable Disconnection Scenarios

| Scenario                                                                       | Main Cause                                         | Current Behavior                           | Optimization Direction                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Switching phone to WeChat/browser background for a few minutes, then returning | Page hidden / frozen / socket close                | Reload or error page                       | Auto-reconnect and restore workspace/task on foreground recovery |
| Locking phone screen, then unlocking                                           | Screen-off causes WebSocket disconnect or JS pause | Reload, stuck, or relay unavailable prompt | Wake Lock + recovery state machine                               |
| Mobile network switching from Wi-Fi to 5G                                      | TCP/WebSocket disconnect                           | Request timeout or failure                 | `online` event triggers reconnect + request replay               |
| Brief relay jitter                                                             | Relay close / INTERNAL / waiting false positive    | Desktop may recover, mobile may fail       | Mobile uses equivalent reconnection strategy                     |
| Relay one-way path                                                             | Mobile sends, does not receive desktop response    | bootstrap/list timeout                     | Request-level timeout diagnostics + rebuild terminal socket      |
| Another phone scans code                                                       | Relay kick / session conflict                      | Current phone kicked                       | Maintain terminal failure, but display reason in text            |

## Optimization Suggestions

### P0: Productize "The Background Will Disconnect"

Goal: Do not let users mistakenly believe this is an unrecoverable crash.

Suggestions:

1. Save minimal recovery state when the page enters hidden:
   - `deviceSid`
   - `currentWorkspaceKey`
   - `currentTaskId`
   - `bridgeSessionId`
   - Last successful pair time
   - Last received desktop payload time
2. Execute recovery when the page returns to visible / pageshow / online:
   - Check socket readyState.
   - If the socket is unavailable, create a new terminal socket.
   - Wait for pair matched.
   - Send `bootstrap-request` again.
   - Send `workspace-bridge-open` with the saved workspace/task.
   - Re-render Root or trigger snapshot reload.
3. UI displays explicit status:
   - "Connection paused"
   - "Restoring remote control"
   - "Recovery failed, please scan the QR code again"

Key principle: No real-time online is promised in the background, but foreground recovery should be as automatic as possible.

### P0: Refactor Mobile Transport Close Strategy

Goal: Do not directly reload on close after pairing.

Proposed new states:

```ts
type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";
```

Strategy:

- `KICKED` / `AUTH_FAILED` / `DEVICE_NOT_FOUND`: terminal failure.
- `close` / `error` / `desktop-bootstrap-timeout`: enter `reconnecting`, exponential backoff.
- `document.hidden`: enter `suspended`, stop high-frequency operations, save recovery state.
- `document.visible`: immediately attempt recovery.

Note pending requests:

- Idempotent requests: `bootstrap-request`, `workspace-list-request` can be automatically replayed.
- Bridge switch: can be replayed, but must ensure old/new `bridgeSessionId` relationships are clear.
- RPC frame: cannot be blindly replayed; needs upper-layer snapshot reconciliation.

### P0: Add Disconnection Diagnostic Logs

Goal: Make "always disconnecting" traceable to causes.

Mobile side should log secure metadata:

- Transport state transitions.
- WebSocket close `code` / `reason` / `wasClean`.
- `document.visibilityState`.
- `navigator.onLine`.
- Hidden duration.
- Last sent/received payload time.
- Pending request type and timeout.
- Pair status ack: `matched` / `waiting` / `kicked`.

Log notes:

- Do not log QR URL content.
- Do not log `hash` / `passHash`.
- Do not log raw payload JSON.
- High-frequency stream/rpc frame logs only record counts and lengths, not content.

### P1: Add Foreground Wake Lock

Goal: Reduce "user is viewing the remote control page, but the phone auto-screens-off causing disconnection."

Suggestions:

- Request `navigator.wakeLock.request("screen")` after `/remote` enters an active bridge.
- UI provides an off switch, e.g., "Keep screen on."
- Listen for WakeLockSentinel `release`; automatically re-apply when the page is visible.
- Silently degrade when Wake Lock is not supported; just prompt the user to keep the screen on.

Boundaries:

- Wake Lock cannot preserve in the background.
- Released by the system in low-battery, power-saving mode, or when the page is hidden.

### P1: Prioritize Snapshot Reconciliation on Recovery

Goal: Tasks continue running during disconnection; when the user returns, they see the latest state.

Suggestions:

1. After the terminal recovers matched, open the bridge first.
2. After the bridge is ready, proactively fetch:
   - workspace task list
   - active task snapshot
   - current task runtime status
3. If the owner run is still running, resubscribe to dynamic task events.
4. If the replayable stream has a gap, do not pursue catching up every chunk; first wait for the snapshot with `runtime.streamWatermark` to cover the gap, then continue with subsequent streams.

This is consistent with the existing realtime sync document: replayable streams handle runtime continuity during disconnection recovery, and snapshots handle eventual consistency and large gap alignment.

### P1: Add Connection Generation and Observability at the Relay Layer

Goal: Distinguish normal reconnection, stale connections, one-way paths, and route mismatches.

Suggestions for adding secure metadata to relay / app payloads:

- `connectionId`
- `connectionGeneration`
- `lastPairMatchedAt`
- `lastHeartbeatAckAt`
- Device and terminal `mid` routing shards
- Relay close reason categories

Mobile and desktop logs use these IDs to correlate one disconnection.

### P2: Tier Control Requests and Stream Frames

Goal: Prioritize guaranteeing user operation responses during link congestion.

Suggestions:

- Add priority to app payloads:
  - high: permission response, stop generation, workspace switch
  - normal: bootstrap, workspace list, platform request
  - low: stream mirror batch
- If the relay supports queues, prioritize forwarding high / normal.
- When the desktop main sends mirror batches, continue merging; if necessary, pause mirrors when the mobile is invisible, keeping only snapshot invalidation.

### P2: PWA / Installed State Optimization

Goal: Improve entry and foreground experience, but do not treat it as a background preservation solution.

Suggestions:

- Add a Web App Manifest so users can add to the home screen.
- Reduce browser UI interference in standalone mode.
- Save the last remote control recovery state.

Boundaries:

- iOS / Android PWAs cannot guarantee long-lived background WebSockets.
- PWAs cannot replace native app background execution capabilities.

## Recommended Implementation Order

1. **Diagnostic logs first**: Add visibility, close code, pending request, pair status logs to confirm which categories of scenarios cause user disconnections.
2. **Mobile close does not reload**: Change paired close to `reconnecting`, keeping the error page only for unrecoverable errors.
3. **Foreground recovery state machine**: Implement visible / pageshow / online automatic recovery, and restore workspace/task.
4. **Wake Lock**: Reduce disconnections caused by screen-off during foreground use.
5. **Relay observability**: Add connection generation and shard logs.
6. **Payload tiering and recovery protocol**: Optimize high-frequency stream and control message channel contention.

## Acceptance Criteria

### Manual Scenarios

1. Scanning the QR code to enter remote control, switching to another App for 30 seconds and returning should automatically restore to the same workspace/task.
2. Scanning the QR code to enter remote control, locking the screen for 1 minute and unlocking should auto-recover or show an explicit retryable state.
3. After mobile Wi-Fi/cellular network switching, it should auto-reconnect, not immediately go to a permanent failure page.
4. When the desktop relay recovers from a brief disconnect, the mobile should not need to re-scan the QR code.
5. When another phone scans the code and kicks the current phone, the current phone should show a session conflict, not infinitely reconnect.

### Automated Tests

Recommended additional unit tests:

- Close after paired enters reconnecting, not reload.
- `visibilitychange hidden -> visible` triggers recover.
- `online` event triggers recover.
- Idempotent requests replay after recover.
- `KICKED` does not reconnect.
- `AUTH_FAILED` does not reconnect.
- Pending RPC frames are not blindly replayed.

### Observation Metrics

Recommended statistics:

- Mobile terminal socket close counts and close code distribution.
- Disconnection ratio after hidden.
- Auto-recovery success rate after visible.
- Average recovery time.
- bootstrap / workspace-list / workspace-bridge-open timeout rates.
- Relay `waiting` after paired counts.
- Suspected relay one-way path counts: mobile request sent, desktop response logged sent, but mobile timeout.

## User-Facing Description Suggestions

It can be explicitly stated on the remote control page or in help documentation:

> Mobile Web remote control is suitable for foreground real-time operations. When switching apps, locking the screen, or changing networks, the mobile browser may pause the connection; ZCode will automatically restore to the most recent workspace and task when you return to the page. For a more stable experience, try to keep the page open in the foreground during remote control, and allow the screen to stay on.

This is more consistent with the real boundaries of mobile Web than promising "no disconnections," and also reduces user misunderstandings.

## P0 Implementation Status

The first batch of P0 stability optimizations have been implemented:

1. Mobile terminal transport added `reconnecting` / `suspended` states.
2. Paired socket close no longer triggers a full page reload; it switches to in-place reconnection and triggers bootstrap after re-pairing.
3. `/remote` listens for `visibilitychange` / `pagehide` / `pageshow` / `online` / `freeze` / `resume`; heartbeats are paused when the page hides, and the terminal socket is rebuilt when the foreground or network recovers.
4. Diagnostic logs only record secure metadata: state transitions, close code/reason/wasClean, visibility, online, hidden duration, and pair status; QR URL, hash, passHash, or business payload content are not recorded.
5. Automated tests cover paired close not reloading, hidden suspended, visible/pageshow/online recovery.

Wake Lock, relay connection generation, payload priority, and full request replay have not yet been implemented; these require UI switches or relay/app payload protocol extensions and should be advanced independently per P1/P2.
