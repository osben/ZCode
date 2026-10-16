# Web Remote Control Overview and External Relay Architecture

This document describes the current effective implementation. Old in-repo relays, window control sockets, bridge tokens, and HTTP bootstrap APIs have been removed and no longer serve as compatibility paths.

## Product Overview

The mobile Web remote control allows users to access workspaces and tasks already opened in the target desktop window through a browser. The desktop application hosts
the actual services and Agent runtime; the mobile client connects to the same Host workspace scope through an external relay; the mobile page
does not start an independent Host or Agent; the relay only handles authentication, pairing, heartbeats, and message passthrough.

### Usage Flow and Pages

1. Open the Web remote control dialog on the desktop, start remote control, and obtain a QR code or connection link; the mobile browser opens the link to complete pairing.
2. The narrow-screen QR code first enters the task home page by default; you can browse tasks grouped by workspace or across the workspace timeline.
   The initial task carried by the QR code is used for selection and positioning, not directly jumping to the chat page.
3. Click a task to enter chat; the new task entry for the workspace enters the draft page of that workspace. Cross-workspace operations first switch the bridge,
   then access the target workspace service. Returning to the home page retains the task selection state; the chat page can be restored from the browser history state.
4. The workspace and task selected on the mobile client are independent of the desktop selection state and do not cause the desktop to switch tabs/tasks.
5. When the network recovers or the page returns to the foreground, the connection is restored, and the task state is re-synced according to the replayable protocol;
   disconnected remote workspaces can be triggered from the home page to the desktop's existing reconnection flow; tasks within them cannot be opened or created before the connection succeeds.

The narrow screen uses an independent two-page shell (home / chat); the chat content reuses the existing V4 session component. The wide-screen remote control uses the sidebar layout,
and the task list also comes from the desktop-synced cross-workspace index. The mobile theme uses the browser's local preference, independent of the desktop theme;
it defaults to `zai-dark` when there is no local preference.

### Capabilities and Boundaries

- You can browse workspaces and tasks already in the target window, open sessions, send inputs, create new tasks, and handle session permissions and interaction requests.
- Remote workspaces reuse the desktop's existing connections and service scopes; the home page reconnects existing workspaces and does not provide a mobile entry to create
  new SSH/WSL/Docker connections or manage other desktop window workspaces.
- The same task is still executed by the existing runtime owner. The desktop uses `desktop-continuous`; the mobile uses
  `web-remote-replayable`; mobile recovery does not change the desktop's continuous main path.
- Mobile client and tool capabilities are constrained by attachment/capability and do not automatically gain all desktop capabilities by reusing the desktop UI.
  The terminal exposure boundary is described below under "Startup Call Boundaries and Office XSS Relationship."

```text
Mobile browser (independent selection state, replayable)
  -> external relay (passthrough)
  -> Desktop main (attachment scheduling and RPC bridging)
  -> Target window's shared Host workspace scope -> same task runtime owner
                          ^
Desktop renderer (continuous) ─┘
```

### Topic Navigation

| Content                                                            | Document                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Mobile home page, chat, new tasks, and page state                  | [Mobile Task Home](./mobile-task-home-design.md)                         |
| Mobile task timeline and sorting                                   | [Mobile Task Timeline](../ui/web-remote-control-mobile-task-timeline.md) |
| Wide-screen task list, search, and archive                         | [Wide-Screen Task List](./wide-screen-task-list.md)                      |
| Mobile theme and browser surface                                   | [Theme Control](./mobile-theme-control.md)                               |
| Remote workspace disconnect and reconnect                          | [Workspace Reconnect](./mobile-remote-workspace-reconnect.md)            |
| Realtime sync, snapshot, and gap recovery                          | [Task Realtime Sync](./task-realtime-sync.md)                            |
| Input admission, queues, and cross-end command routing             | [Task Command Queue](../web-remote-control-task-command-queue.md)        |
| V4 static resource publishing                                      | [V4 Deployment](./remote-v4-static-deployment.md)                        |
| Independent OAuth login entry                                      | [Web Remote Login](./web-remote-login.md)                                |
| Self-hosted relay: server implemented; Desktop integration pending | [Self-hosted Remote Relay](./self-hosted-remote-relay.md)                |

The following describes the current technical implementation; [Minimal Run Plan](./web-remote-control-minimal-plan.md) is for historical records only;
the in-repo relay, dedicated mobile host, and old debugging commands in it are not applicable to the current path.

## Entry Points

The desktop and mobile web only switch to the test relay at the standard test endpoint; production and other custom
endpoints continue to use the production relay:

```bash
production/default: wss://zcode.z.ai/ws
test endpoint:       wss://zcode.z.ai/ws
```

`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` remains the highest-priority explicit debug override. When not overridden, the test relay is used only when the normalized
endpoint origin is `https://zcode.z.ai`; production and localhost/custom
endpoints keep the production relay, avoiding expanding the existing semantics of custom endpoints. The QR code page URL is still derived by the App version
between `/remote/v3` and `/remote/v4`; `ZCODE_WEB_REMOTE_CONTROL_URL` is only used for explicit debug overrides.

During development, you can point the mobile page to the local web:

```bash
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.z.ai/ws \
ZCODE_WEB_REMOTE_CONTROL_URL=http://localhost:5173/remote \
pnpm dev:desktop
```

## Static Deployment

The mobile remote control page is a Vite SPA from `packages/web`, does not use Next.js static export, and does not have
`remote.html` or similar page files. Production deployment only requires handing `packages/web/dist` to nginx for hosting and mapping the entry path
back to `index.html`.

The current four static deployment chains are retained:

```text
v2:
  -> pnpm run build:web-remote-control
  -> packages/web/dist
  -> Dockerfile.web-remote-control
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2
  -> zcode/frontend/deployment-remote.yaml
  -> /remote

v3:
  -> pnpm run build:web-remote-control:v3
  -> packages/web/dist
  -> Dockerfile.web-remote-control-v3
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3
  -> zcode/frontend/deployment-remote-v3.yaml
  -> /remote/v3

v4:
  -> pnpm run build:web-remote-control:v4
  -> packages/web/dist
  -> Dockerfile.web-remote-control-v4
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v4
  -> external infrastructure's zcode/frontend/deployment-remote-v4.yaml
  -> /remote/v4

test:
  -> pnpm run build:web-remote-control:test
  -> packages/web/dist
  -> Dockerfile.web-remote-control-test
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test
  -> zcode/frontend/deployment-remote-test.yaml
  -> /remote/__test__
```

The v4 test and production online deployments share the same Dockerfile and `/remote/v4` resource base, but are isolated by independent Jenkins
Jobs, images, and Deployments. The two jobs must explicitly pass `ZCODE_ENV=test` and
`ZCODE_ENV=production`; the Dockerfile validates in the builder stage and hands the endpoint to Vite injection. The domain itself does not rewrite the product environment at browser runtime:

```text
test:       zcode.z.ai/remote/v4 -> wss://zcode.z.ai/ws
production: zcode.z.ai/remote/v4         -> wss://zcode.z.ai/ws
```

`/remote/__test__` is still an independent static resource verification entry and does not replace the standard test product environment's `/remote/v4`.

`/remote` is the old resource entry; the release script still updates `deployment-remote.yaml`.
`/remote/v3` is the old version App resource entry; the release script only updates `deployment-remote-v3.yaml`.
`/remote/v4` is the resource entry for official version App `3.4.0` and above; the release script only updates
`deployment-remote-v4.yaml`.
`/remote/__test__` is the test resource entry; the release script only updates `deployment-remote-test.yaml`.
The four chains use independent Dockerfiles, nginx configurations, image names, and k8s deployment files, avoiding new resource releases from overwriting resources still used by old version Apps.

All four nginx configurations must explicitly map `assets/`, `material-icons/`, and
`pdfjs/cmaps/` under their respective build bases to the corresponding build artifacts within `/usr/share/nginx/html`. The PDF.js CMap actually resides at
`/usr/share/nginx/html/pdfjs/cmaps/`; requests with `/remote`, `/remote/v3`, `/remote/v4`, or
`/remote/__test__` prefixes must not enter the SPA fallback, otherwise nginx will use the 200 response from `index.html` to masquerade as a successful static resource. Docker smoke must compare the actual response body of representative `.bcmap` files, not just assert HTTP 200.

Local verification:

```bash
pnpm run typecheck
pnpm run lint
pnpm run build:web-remote-control
bash scripts/test-web-remote-control-docker-build.sh
pnpm run build:web-remote-control:v3
bash scripts/test-web-remote-control-v3-docker-build.sh
pnpm run build:web-remote-control:v4
bash scripts/test-web-remote-control-v4-docker-build.sh
pnpm run build:web-remote-control:test
bash scripts/test-web-remote-control-test-docker-build.sh
```

Build and push:

```bash
export DOCKER_REGISTRY_PASSWORD='***'
bash scripts/docker-build-and-push-web-remote-control.sh --tag 202604291800
bash scripts/docker-build-and-push-web-remote-control-v3.sh --tag 202604291800
bash scripts/docker-build-and-push-web-remote-control-v4.sh --tag 202604291800
bash scripts/docker-build-and-push-web-remote-control-test.sh --tag 202604291800
```

`zcode/frontend/deployment-remote-v4.yaml` and `zcode/frontend/deployment-remote-test.yaml` are convention paths within the external infrastructure
repository, not in the current repository, and are not created by this feature. The release script defaults to
`K8S_REPO_DIR=~/workspace/cgx-dev-k8s` to update the corresponding deployment file and create an MR; if `--skip-mr` is passed,
the script only builds and pushes the image without updating the external repository.

The desktop default QR code URL does not point to `/remote/__test__`. To verify test resources, override via environment variables:

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__ pnpm dev:desktop
```

nginx only handles static resources and SPA fallback, not proxying the relay. The browser connects to the corresponding relay directly based on the build-time endpoint: production uses `wss://zcode.z.ai/ws`, test uses `wss://zcode.z.ai/ws`. For Desktop App official versions greater than or equal to `3.4.0`, the QR code URL uses
`https://zcode.z.ai/remote/v4?...`; for versions below `3.4.0`, pre-release versions of `3.4.0`, or unresolvable versions, it continues to use
`https://zcode.z.ai/remote/v3?...`. Pre-release versions above that threshold (e.g., `3.5.0-beta.1`) use v4; explicit
`ZCODE_WEB_REMOTE_CONTROL_URL` overrides are not rewritten by the version logic.

All four `Dockerfile.web-remote-control*` use a Node builder to execute filtered installation and Vite builds within the container:
`pnpm install --frozen-lockfile --filter @zcode/web... --ignore-scripts`. The runtime stage only retains
`nginx:alpine` and static `dist`, without including a Node runtime. The release script does not rebuild on the host, ensuring the final image resources
come only from the Docker builder.

## Transport

The external relay only handles the transport layer:

1. The desktop connects to the external relay at the current endpoint as a `device`, passing `device_mid` via `X-Device-ID`
2. The mobile web connects to the same endpoint as a `terminal`; the browser passes the routing hint via the query `mid=<device_mid>`
3. The relay completes `device_register_init`, `auth_init`, `auth_challenge`, `auth_response`, `auth_ack`
4. Both ends use `pair_status_query` / `pair_status_ack` for heartbeats at an average of 10 seconds, bounded to 8~12 seconds of jitter; when the most recent ACK has not been updated for over 30 seconds, a local watchdog triggers reconnection; the watchdog-triggered reconnection adds a small random delay to avoid reconnection spikes
5. All ZCode business messages are placed in the relay `data.payload`; the relay does not parse the payload

Task realtime sync also follows this boundary: the relay only forwards `rpc-frame` between the mobile and desktop main; it does not parse tasks, sessions, workspaces, or ZCode realtime events. The mobile remote control page does not own an independent Host and does not start an independent Agent runtime. After receiving
`workspace-bridge-open`, the desktop main creates a new `MessagePort` attachment for the mobile bridge and attaches it to the corresponding local/remote workspaceKey's service/CLI scope in the target desktop window's single Window Host. The relay only forwards `rpc-frame` and does not parse ZCode tasks, streams, or workspace business semantics.

### Heartbeat Scheduling and Disconnection Recovery

Heartbeats belong only to the local transport state of the desktop device transport and mobile terminal transport; the relay does not save or broadcast the clients' scheduling times:

```text
auth_ack / matched
        │
        ▼
Local random wait 8~12 seconds
        │
        ▼
Send pair_status_query ─────────────┐
        │                           │
        └─ wait another 8~12 seconds  │
                                    ▼
                         Receive pair_status_ack
                                    │
                         Reset 30s ACK watchdog
                                    │
                         30s no ACK -> local reconnection
```

The heartbeat uses recursive `setTimeout`, resampling each round; the average cycle is still 10 seconds; missed historical heartbeats during page background or system sleep must not be resent. 30 seconds is a time-based ACK deadline, not inferred by a fixed number of failures; the watchdog-triggered reconnection adds a small random delay; explicit errors, user stops, and foreground recovery maintain the original immediate recovery semantics. The heartbeat payload and relay protocol schema are unchanged.

The pairing identity is `device_sid`. The QR URL is:

```text
/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<timestamp>&mid=<device_mid>&name=<device_name>&app_version=<app_version>
```

`hash` is the HMAC key material, appearing only in the QR URL and credential storage; it is not written to logs, OAuth state, or setting.json.

## App Payload

`data.payload` uses `zcode_type` to distinguish business messages:

- `bootstrap-request` / `bootstrap-response`
- `workspace-list-request` / `workspace-list-response` / `workspace-list-updated`
- `workspace-bridge-open` / `workspace-bridge-ready` / `workspace-bridge-error`
- `platform-request` / `platform-response`
- `mobile-view-state-update`
- `rpc-frame` / `rpc-frame-ack` (transport-only; relay does not parse)
- `app-error`

04D-3 has made the desktop main/mobile web simultaneously use the shared acknowledged adapter; the global app parser formally accepts
the new strict fragment/ACK and has deleted the legacy single-branch. Raw Channel messages cannot be directly base64-encoded and inserted into a single
`rpc-frame`; they must be split into physical fragments with `messageSeq/fragmentIndex/fragmentCount/messageBytes/CRC32`; each fragment's final
`{type:"data",payload,client_ts,server_ts}` uncompressed JSON must not exceed 1 MiB. A single logical raw
message has an upper limit of 16 MiB / 64 fragments; the receiving side only stages one message and delivers it atomically after complete validation.
`rpc-frame-ack` is the cumulative ACK for raw transport, not a command ACK, and does not carry conversation
business facts.

The production adapter's transport state is symmetric and bridge-scoped: TX retains the entire batch of immutable
fragments before the first fragment is sent and maintains `1 MiB / 256 KiB` flow edges, `8 MiB / 45s` replay
boundaries by the final outer JSON bytes; RX queues the cumulative ACK only after complete assembly and successful synchronous Channel delivery. ACKs are prioritized for flush. The same bridge replays unACKed batches every time it re-sends-ready, including the `same-socket` scenario where the local WebSocket has not been replaced but the heartbeat re-confirms
`matched`; the peer may have already been replaced and cannot treat the local socket identity as a delivery proof. The replay reuses the original immutable batch and does not refresh its queued age; new bridges, terminal faults, or dispose clear the old
transport state. The first queued ACK is also constrained by the 45s deadline; subsequent higher cumulative ACKs only replace the value without refreshing the age.
These states do not contain task/session/topic/command facts. The desktop/web transport creates a unique immutable
final outer JSON for the payload; the adapter's meter and actual send share the same serializer/cache; the same bridge replay reuses the same
bytes. Raw frames/ACKs do not enter the desktop main's ordinary 50-item app payload buffer. Both ends have a hard gate of
`<=1 MiB` uncompressed UTF-8 before `JSON.parse`; the compression switch does not affect admission; permanent oversize and temporary unavailability
are diverted; raw faults trigger a single hard bridge recovery. Cross-end only passes the common
`bridge-degraded: rpc-transport-fault`; specific typed reasonCodes remain in the owning end's secure logs.

`mobile-view-state-update` carries, in addition to `activeWorkspaceKey`, `activeTaskId`, `updatedAt`, the
`deviceInfo` field. This field is collected by the mobile browser client and contains only controlled information that the browser can stably obtain: `platform/version/name`,
`userAgent`, language, `navigator.platform`, viewport, screen, timezone, online status, and collection time. The desktop main
only saves it in the current window runtime and exposes it to the desktop through `getWebRemoteControlStatus()`; it does not participate in
workspace identity, session binding, cache keys, or relay pairing decisions.

After receiving the relay `data.payload`, both the desktop and mobile must first go through `parseWebRemoteControlAppPayload()`. Invalid payloads only log secure metadata, not raw JSON.

`workspace-list-updated` is only used after the desktop renderer has synchronized a new snapshot through
`syncWebRemoteControlTasks` / `syncWebRemoteControlWorkspaces`, to push the same `WebRemoteControlWorkspaceListResult`
to the connected mobile client. It does not change the responsibilities of the relay and desktop main: the relay still only forwards `data.payload`; the desktop main
still only composes and forwards the workspace/task index already synchronized by the renderer, without holding ZCode task, stream, queue, or snapshot business state.

## Desktop Main

`packages/desktop/src/main/webRemoteControlManager.ts` is responsible for:

1. Connecting to the external relay through `WebRemoteControlDeviceTransport`
2. Storing the non-sensitive `deviceSid` in AppSettings through `WebRemoteControlRelayAuthStorageProvider`, and storing `passHash` in the credentialService
3. Matching workspaces by `workspaceKey = workspaceIdentity?.trim() || workspacePath`
4. Creating a new `MessagePort` attachment for the current mobile bridge
5. Encoding the host's `MessagePortProtocol` RPC messages into bounded
   `rpc-frame` fragments using the shared acknowledged adapter, and consuming the cumulative ACK
6. Not parsing ZCode task business semantics, not participating in task streams, permissions, or workspace task list sync logic

### Post-Desktop App Restart Enablement Recovery

The desktop interprets "whether Web remote control was enabled last time" as the user's enable intent: after a successful remote control start, the last target is recorded;
the user explicitly clicks stop to clear that record. Window destruction and application exit release the transport/attachments for that run;
renderer reloads can continue to reuse window-level runtime; these lifecycle events must not rewrite the enable intent to close.
This allows recovery after normal or unexpected application exit, but does not re-open after the user actively closes.
Configuration changes such as endpoint switching can pause the current runtime, but similarly do not represent that the user has disabled remote control.

The persisted target only saves `workspacePath`, optional `workspaceIdentity`, and optional `initialTaskId`.
`remoteSessionId` belongs to the remote connection identity within this process and must not be persisted across application restarts. A new process must wait for
the renderer to sync the current window's restored workspace context to the main, then match the last target by
`workspaceKey = workspaceIdentity?.trim() || workspacePath`, and use the current process's
`remoteSessionId` to start the device relay. The target remains `idle` until it is restored to any window; do not start a new local host, remote session, or Agent runtime for automatic recovery.

```text
Last startup success --> save enabled target ──┐
                                               v
New desktop main -> wait for window workspace sync -> workspaceKey match -> start device relay
                                               |
                                               +-> No match: remain idle, continue waiting for subsequent window sync

User explicitly stops --> clear enabled target --> remain idle on next startup
```

Automatic recovery only rebuilds the desktop device relay. The mobile client still enters the existing
shared host through the `web-remote-replayable` attachment; the desktop renderer remains `desktop-continuous` and must not spread the replayable snapshot / gap recovery
semantics to the desktop main path.

The external relay no longer provides `bridgeToken` or `wsUrl`. `WebRemoteControlExternalWorkspaceBridge` only describes workspace identity and `bridgeSessionId`.

The mobile remote control page does not own an independent host process and does not start an independent Agent runtime. After receiving
`workspace-bridge-open`, the desktop main creates a new `MessagePort` attachment for the mobile bridge,
and attaches that attachment to the local/remote workspace scope of the target desktop window's single Window Host.
The relay only forwards `rpc-frame` and does not parse ZCode tasks, streams, or workspace business semantics.

The desktop renderer and mobile Web remote control connect to the same host/service/runtime through different RPC clients. Each attachment is assigned an independent `connectionId` and trusted `clientMode` by the host: local and SSH/WSL/Docker desktop windows are both `desktop-continuous`; the mobile `/remote` is `web-remote-replayable`. The host establishes an owned-subscription registry for each attachment; downlink frames can only be written to the MessagePort owning that `subscriptionId`; workspace broadcasts followed by the mobile discarding desktop frames are prohibited.

The mobile raw adapter's high/low edges only flow up through the owning attachment's MessagePort sideband; the control object
is consumed before the Channel parser and does not become an RPC request/event:

```text
mobile adapter high/low
  -> desktop main (no topic/session state)
  -> owning host attachment only
  -> trusted connection scope (serial + dedupe)
  -> existing workspace CLI: v4/connection/flow
  -> pause/resume only mobile connection B

desktop connection A ----------------------------------> continues draining
```

The main/relay cannot specify arbitrary connectionIds; the host scope generates workspace/connection routes from owned subscriptions.
The remote host relay prefixes and namespaces downstream IDs by length. Port close serially sends `closed` before disposing owned
subscriptions; old SAT/DRN/timers must not revive.

`zcode-server /ws` fixes all normal connections as replayable; the old
`x-zcode-rpc-client-mode` header is ignored and cannot promote browsers or ordinary WebSockets to
continuous. The desktop server-remote's Node host first obtains a short-lived, one-time random capability through the existing server auth middleware-protected `POST /api/rpc-host-capability`, then connects to the dedicated `/ws/host` carrying it in the Node-only
header. The server only creates a continuous trusted relay attachment after consuming it; the final `connectionId` is still generated per-connection by the server. The open/no-token server also retains the same
"explicitly apply for a ticket -> consume once" boundary; tickets that are missing, invalid, expired, or replayed are all rejected.

```text
Desktop Node host
  │ POST /api/rpc-host-capability (using existing auth)
  v
Short-lived capability -- first consumption --> GET /ws/host --> continuous trusted relay
       │                              │
       └─ Expired / replayed: rejected  └─ server generates connectionId

Browser / arbitrary ordinary client
  └─ GET /ws (old mode header ignored) -------------> replayable terminal
```

Each attachment's subscribe establishes pending ownership before calling the CLI. The CLI server uses a request-scoped
post-response outbox that always writes in `ACK response -> initial notification` order; even when two lines arrive in the same read, the physical wire that arrives early before the ACK only enters bounded staging; the ACK binds `subscriptionId`
and releases to the unique owner's incremental assembler in the original order. Ownership filtering precedes assembly;
foreign subIds do not occupy memory. The staging upper limit is 1,024 wires / 32 MiB; overflow clears the entire batch and explicitly
marks `fault.subscription.initialFrameStagingOverflow`, prohibiting shifting single fragments. Attachment close /
stale generation / unsubscribe clears staging and assembly. Unsubscribe is generated by the owned
registry as a complete `{ topic, subscriptionId, connectionId }` route; the CLI only deletes publisher entries that match all three exactly, avoiding the same bare `subscriptionId` being mistakenly deleted across topics or connections.

The CLI publisher's initial/online frames all use non-destructive reservations: all physical
notifications are advanced to the water level only after being accepted by the current transport; mid-stream failures with retries of the same
logical id/content. The topic encoder slices by the conservative upper bounds of CLI NDJSON, Channel binaries, and old mobile outer JSONs; the production mobile Channel message is subsequently subject to the raw adapter's independent precise final-envelope
metering/fragmentation; therefore, actual relay JSON also does not exceed 1 MiB. Attachments go through a separate
`begin -> <=512KiB decoded chunk -> commit/abort` business transaction; renderer→host Channel and host→CLI
NDJSON are independently measured for envelopes; full-data `attachment/put` fallbacks are prohibited. The relay/main only sees opaque
`rpc-frame` and does not save upload staging, checksums, or artifact refs.
Each subscription simultaneously holds a monotonically increasing `logicalFrameOrdinal`; the host/renderer assembler uses it to
block late replays and reverse supersede; completed/fault/timeout tombstones are cleared only on
unsubscribe/replacement.

Real metadata for task messages, assistant streams, tool calls, permissions, plans, runtime status, and task lists all come from the same CLI/runtime. Composer drafts, scroll/focus/panels, and other uncommitted states remain renderer-local; once input is submitted, regardless of whether it comes from the desktop or mobile, it directly enters the same CLI `CommandInbox`/runtime FIFO. The mobile V4 no longer goes through the `enqueueTaskCommand` host runtime command queue; the desktop also does not maintain a renderer-local accepted queue; the UI only retains the pending optimistic overlay and reconciles through projections/`commands/query`.

The remote workspace bridge only allows attaching to a `remoteSessionId` that already exists and has not been closed in the desktop window. The `remoteSessionId`
is allocated by the registry within the Window Host and remains a workspace-level logical session; the main only holds request correlations and forwards scopes;
it is ultimately validated by the Host for the `workspacePath + workspaceIdentity` that the session has been bound to before creating independent attachments. The mobile client cannot create new SSH / WSL /
Docker remote sessions, nor access workspace B under the same Host by borrowing session A; identity isolation continues to use
`workspaceIdentity?.trim() || workspacePath`.

After determining the canonical path and identity in the remote directory selection or reconnection, the desktop renderer must
`BindRemoteWorkspaceSessionContext` to bind the same `workspacePath + workspaceIdentity` back to the main/Host's
logical session. If the values used by tabs, remote history, and the mobile visible workspace list are inconsistent with the main descriptor, the bridge rejects with
`REMOTE_WORKSPACE_IDENTITY_MISMATCH` (in 3.12.0, new connections lacked this bind, causing the mobile client to be unable to connect to remote projects).

Process recycling is still triggered by desktop lifecycle events: real window closing, app quit, and update installation close the attachments before recycling the corresponding or all
Window Hosts; the mobile bridge/relay disconnect, page refresh, and replayable reconnection only release short-lifecycle attachments; they cannot destroy
Window Hosts or remote connections still used by other owners. This boundary does not change the `workspaceIdentity + remoteSessionId`
routing and does not sink the replayable state to main.

## Task Message Streams

The desktop and mobile clients connect to the same service/runtime, but the delivery profile is determined by the trusted attachment, not the UI parameter:

- The desktop (including remote workspace desktop windows) is fixed as `continuous`, maintaining the complete real-time data stream.
- The mobile Web remote control is fixed as `replayable`, for disconnection reconnection, page refresh, late subscription, and gap recovery.

Replayable is not a relay-level replay. The relay still only forwards `rpc-frame`; connection-level
saturated/drained is passed to the host/CLI by the desktop main through the owning MessagePort sideband. Topic sequences, subscriber
buffers, fragment assemblies, gap/resync, and snapshots are all maintained by the host facade and the CLI publisher/client apply;
the relay/main does not hold conversation business state.

The recovery sequence for the mobile client's gaps or post-attachment rebuild is:

1. Re-attach the bridge, complete the V4 `hello/clientHello`, and obtain a new trusted connection context.
2. Automatically re-subscribe by active topics; attempt resume when there is a valid `{logEpoch, seq}`, otherwise snapshot.
3. Replace the entire snapshot as a whole after complete fragment assembly; silently discard `toSeq <= localSeq`.
4. The gap triggers only one `v4/conversation/resync`; resuming a gap again forces a snapshot.
5. Restore permissions/elicitation, queue/guided rows, and pending command summaries from projections; use `commands/query` to reconcile when the ACK is unclear.

CLI runtime restarts change `logEpoch` and trigger snapshots. Inputs admitted by the previous process but not entered into the transcript explicitly return `fault.command.inputDiscardedOnRestart` and persistent `delivery`; the `queue/guide` of the old runtime silently settles; only `startNow` or `unknown` that has not entered the transcript prompts the user to confirm re-sending; automatic replay is not attempted. When the mobile network disconnects but the runtime has not been replaced, the authoritative queue is still recovered from the replayable snapshot and does not depend on renderer localStorage.

Blocking events cannot be filtered as ordinary owner-only content streams. `permission_request`, `elicitation_request`, their corresponding responses, terminal, and snapshot invalidation must be visible to online clients of the same task, or at least trigger snapshot alignment.

## Web

`/remote`, `/remote/v3`, and `/remote/v4` are QR direct-connect entries, processed before the `/web-remote` OAuth logic.

Mobile web connection flow:

1. Parse `sid/hash/t/mid/name/app_version`
2. Authenticate as `terminal` through `WebRemoteControlTerminalTransport`
3. After pairing, send `bootstrap-request`; v4 uses the optional `desktopAppVersion` in the response to validate the URL.
   On first inconsistency, correct and navigate; if already on the page, retain the page and prompt confirmation before reloading; when the old desktop is missing fields, maintain the original behavior.
   Reconnect/foreground recovery re-validates even when the bridge is healthy; specific boundaries are described in [v4 version sync](./remote-v4-static-deployment.md#v4-url-synchronization-with-desktop-actual-version).
4. Select the initial workspace by `mobileViewState -> initialViewState -> first workspace`
5. If the target remote workspace does not yet meet the bridge conditions, render the home-only `Root`, retaining the workspace list and reconnection entry;
   at this point, no workspace bridge is created, and task operations depending on workspace services are not opened. An error page is displayed when there are no optional workspaces.
6. When the target can establish a bridge, send `workspace-bridge-open`, using `createAcknowledgedWebRemoteControlRelayProtocol()`
   to adapt `rpc-frame` / `rpc-frame-ack` app payloads to `IMessagePassingProtocol`, maintaining fragmentation, ACK, and transport recovery.
7. After `connectViaProtocol()`, render `Root`; the narrow screen is managed by `WebRemoteControlMobileShell` for the home/chat pages,
   while the wide screen uses the remote control sidebar. The selection of the initial workspace and the page landing are two states; do not equate the selected task with automatically entering chat.

`/web-remote` is still the ZAI OAuth login and waiting page entry; `remoteControlToken` / `relayOrigin` only belong to the old `/web-remote` behavior and are not applicable to the new `/remote`, `/remote/v3`, or `/remote/v4` QR route.

## Feature Exposure

The current Desktop main uses `createWebRemoteControlFeatureGate()`, whose default value is `true`,
without automatically disabling remote control based on the production/development environment. The production environment can start through the existing remote control entry and obtain connection information;
"production builds" can no longer be treated as a guarantee of IPC being rejected or the QR code being hidden.

`WebRemoteControlFeatureGate` still retains explicit disable capability: when injecting `false`, the manager refuses to start,
and the status does not return valid remote control connection information. This gate is a feature switch and does not replace the call source verification and internal ticket boundary described below. The current wiring is in `packages/desktop/src/main/index.ts`; the switch implementation is in
`packages/desktop/src/main/webRemoteControlFeatureGate.ts`.

## Startup Call Boundaries and Office XSS Relationship

Opening `WebRemoteControlDialog` is the existing entry point for users to enter Web remote control. When the current target has no reusable runtime,
the renderer immediately sends a start IPC; refreshing the QR code continues to use the confirmation dialog already in the renderer. To maintain the existing remote control experience,
the Desktop main no longer adds a native secondary confirmation for starting or refreshing.

```text
WebRemoteControlDialog open / confirmed QR refresh
        │
        ▼
Desktop main: window/source check
        ▼
Manager: issue internal one-time ticket (short TTL)
        │
        ▼
Manager: consume ticket exactly once -> start relay
```

The manager still generates a short-lived, one-time internal ticket bound to `windowId + workspaceKey + remoteSessionId`, where
`workspaceKey = workspaceIdentity?.trim() || workspacePath`;
the ticket must not enter the renderer-writable shared protocol, nor be written to logs, telemetry, or normal settings. It is used to constrain
the call targets of `startAuthorized` / `resetPairingAuthorized` and consistency, but because the same IPC request immediately issues the
ticket, it is not user authorization and cannot prevent a compromised renderer from calling the start IPC.

The manager dependency types exposed by the IPC handler only allow exposing `authorizeStart`, `startAuthorized`,
`resetPairingAuthorized`, `stop`, and `getStatus`. Direct `start` / `resetPairing` only belongs to the manager
internal lifecycle implementation and cannot enter IPC dependency interfaces reachable by the renderer. Public return types retain the `cancelled` compatibility branch,
but the current Desktop start and refresh paths do not produce that terminal state.

Starting, refreshing pairing, window closing, user stopping, and ticket expiration must all invalidate unconsumed tickets. Restoring
"last enabled" at application startup is still an internal lifecycle operation and must not bypass workspace/session binding.

The root cause boundary of Office document XSS is defined by `docs/ui/office-file-preview.md`: untrusted links must pass the protocol whitelist,
DOM sanitization, click interception, and controlled external link opening. Removing the native remote control confirmation does not change these root cause fixes; the cost is that if a new renderer XSS appears or the above boundary is bypassed, the internal ticket does not provide evidence of user presence. Security evaluations must not treat the ticket as a compensating control for Office XSS.

`web-remote-replayable` should not obtain terminal capabilities by default. If the product still needs mobile terminals, they must be exposed through independent
workspace/session/device binding capabilities, short TTL, owner/lease, and disconnection recycling; the generic
`services.exposeOnChannelServer()` cannot be treated as authorization.

## Workspace Hook Trust Review

Workspace Hook Trust does not replicate business state in the relay, desktop main, or renderer. The Desktop continuous and Mobile/Web
replayable attachments share the same CLI Runtime review registry:

```text
project Hook discovery
  -> CLI Runtime immutable snapshot
  -> Runtime review registry (sole authority)
       ├─ continuous delta -> Desktop Settings
       └─ replayable snapshot/delta -> Mobile/Web Settings

Settings decision
  -> trusted connection facade
  -> sendConversationCommandV4
  -> CLI CommandInbox
  -> task/run/remoteSession/workspace/bundle/generation validation
  -> Trust mutation or fail-closed reason
```

Constraints:

- The Host capability `workspaceHookReview` and the Client UI capability `workspaceHookReviewUi` must be declared separately; missing is equivalent to false.
- The review request is projected as `pendingInteractions[kind=workspaceHookReview]`; mobile refresh, gap/resync, or attachment rebuild only restore presentation, not settle Runtime requests.
- The command target is bound to `taskId + runId + remoteSessionId? + workspaceIdentity + bundleDigest + reviewFlowId + generation + interactionId`; any mismatch is rejected before the store mutation.
- The renderer pending-command registry only saves sensitive command digest/ACK status. When the ACK is unclear, `commands/query` can be used; do not persist or automatically replay the original Trust decision.
- Runtime restarts produce new run epochs; old interactions, Allow once, and pending sensitive commands cannot be reused across epochs.
- When `workspaceHookTrustEnabled=false`, the Runtime does not read the Trust store or create reviews; the Protocol Host can roll back the field to a hard block at the trusted bootstrap boundary.
- Managed denials are always higher than Trust established by UI/CLI; the relay/main only routes opaque commands and projections and does not hold copies of policy, Trust stores, or leases.
