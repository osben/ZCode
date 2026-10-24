# Web Remote Control Overview and External Relay Architecture

This document describes the current implementation. Old in-repo relays, window control sockets, bridge tokens
and HTTP bootstrap APIs are removed and are not compatibility paths.

Full history: `git show b8876e8b:docs/web-remote-control/web-remote-control-architecture.md`

## Product overview

Mobile Web remote control lets a user reach the workspaces and tasks already open in the target desktop
window through a browser. The desktop application hosts the real services and Agent runtime; the mobile
client connects to the same Host workspace scope through an external relay; the mobile page starts no Host or
Agent of its own; the relay only handles authentication, pairing, heartbeat and message passthrough.

### Usage flow and pages

1. On the desktop, open the Web remote control dialog, start remote control and get a QR code or link; the
   mobile browser opens the link to pair.
2. A narrow-screen QR first enters the task home page; tasks can be browsed by workspace or across the
   workspace timeline. The initial task carried by the QR is for selection and positioning, not a direct jump to chat.
3. Clicking a task enters chat; a workspace's "new task" entry enters that workspace's draft page.
   Cross-workspace operations switch the bridge first, then reach the target workspace service. Returning home
   keeps the task selection; the chat page can be restored from the browser history state.
4. The workspace and task selected on mobile are independent of the desktop selection and do not make the desktop switch tabs/tasks.
5. When the network recovers or the page returns to the foreground, the connection is restored and task state
   re-syncs by the replayable protocol; a disconnected remote workspace can trigger the desktop's existing
   reconnect flow from the home page, and its tasks cannot be opened or created before the connection succeeds.

The narrow screen uses an independent two-page shell (home / chat) whose chat content reuses the existing V4
session component. The wide-screen remote control uses the sidebar layout with its task list also from the
desktop-synced cross-workspace index. The mobile theme uses the browser's local preference, independent of the
desktop theme, defaulting to `zai-dark` without a local preference.

### Capabilities and boundaries

- Browse the workspaces and tasks in the target window, open sessions, send inputs, create new tasks, and
  handle session permissions and interaction requests.
- Remote workspaces reuse the desktop's existing connections and service scopes; the home page reconnects
  existing workspaces and offers no mobile entry to create new SSH/WSL/Docker connections or manage
  workspaces of other desktop windows.
- A task is still executed by the existing runtime owner. The desktop is `desktop-continuous`; mobile is
  `web-remote-replayable`; mobile recovery does not change the desktop continuous main path.
- Mobile client and tool capabilities are limited by attachment/capability and do not automatically gain all
  desktop capabilities by reusing the desktop UI (terminal exposure boundary: "Startup call boundary and
  Office XSS" below).

```text
Mobile browser (independent selection state, replayable)
  -> external relay (passthrough)
  -> Desktop main (attachment scheduling and RPC bridging)
  -> Target window's shared Host workspace scope -> same task runtime owner
                          ^
Desktop renderer (continuous) ─┘
```

### Topic navigation

- Mobile home page, chat, new tasks and page state: [Mobile Task Home](./mobile-task-home-design.md)
- Mobile task timeline and sorting: [Mobile Task Timeline](../ui/web-remote-control-mobile-task-timeline.md)
- Wide-screen task list, search and archive: [Wide-Screen Task List](./wide-screen-task-list.md)
- Mobile theme and browser surface: [Theme Control](./mobile-theme-control.md)
- Remote workspace disconnect and reconnect: [Workspace Reconnect](./mobile-remote-workspace-reconnect.md)
- Realtime sync, snapshot and gap recovery: [Task Realtime Sync](./task-realtime-sync.md)
- Input admission, queues and cross-end command routing: [Task Command Queue](../web-remote-control-task-command-queue.md)
- V4 static resource publishing: [V4 Deployment](./remote-v4-static-deployment.md)
- Independent OAuth login entry: [Web Remote Login](./web-remote-login.md)
- Self-hosted relay (server implemented; Desktop integration pending): [Self-hosted Remote Relay](./self-hosted-remote-relay.md)

The [Minimal Run Plan](./web-remote-control-minimal-plan.md) is a historical record only; its in-repo relay,
dedicated mobile host and old debug commands do not apply to the current path.

## Entry points

The desktop and mobile web switch to the test relay only at the standard test endpoint; production and other
custom endpoints keep the production relay:

```bash
production/default: wss://zcode.z.ai/ws
test endpoint:       wss://zcode.z.ai/ws
```

`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` stays the highest-priority explicit debug override. When not
overridden, the test relay is used only when the normalized endpoint origin is `https://zcode.z.ai`;
production and localhost/custom endpoints keep the production relay, so the semantics of custom endpoints are
not widened. The QR page URL is still derived by App version between `/remote/v3` and `/remote/v4`;
`ZCODE_WEB_REMOTE_CONTROL_URL` is only an explicit debug override. During development the mobile page can
point to the local web:

```bash
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.z.ai/ws \
ZCODE_WEB_REMOTE_CONTROL_URL=http://localhost:5173/remote \
pnpm dev:desktop
```

## Static deployment

The mobile remote control page is a Vite SPA from `packages/web`, with no Next.js static export and no
`remote.html`-style page files. Production deployment hands `packages/web/dist` to nginx and maps the entry
path back to `index.html`. Four static deployment chains are kept, each with its own Dockerfile, nginx
config, image name and k8s deployment file, so a new resource release never overwrites resources still used
by older Apps:

```text
v2:   pnpm run build:web-remote-control      -> Dockerfile.web-remote-control      -> zcode-remote-mobile-v2   -> deployment-remote.yaml      -> /remote
v3:   pnpm run build:web-remote-control:v3   -> Dockerfile.web-remote-control-v3   -> zcode-remote-mobile-v3   -> deployment-remote-v3.yaml   -> /remote/v3
v4:   pnpm run build:web-remote-control:v4   -> Dockerfile.web-remote-control-v4   -> zcode-remote-mobile-v4   -> deployment-remote-v4.yaml   -> /remote/v4
test: pnpm run build:web-remote-control:test -> Dockerfile.web-remote-control-test -> zcode-remote-mobile-test -> deployment-remote-test.yaml -> /remote/__test__
(each builds packages/web/dist; images under uhub.service.ucloud.cn/tianqi/; deployment files under zcode/frontend/)
```

- `/remote`: old resource entry. `/remote/v3`: resource entry for old-version Apps. `/remote/v4`: resource
  entry for official App `3.4.0` and above (its deployment file is in external infrastructure). `/remote/__test__`:
  test resource entry, an independent static-resource verification entry that does not replace the standard
  test environment's `/remote/v4`. The release script updates only the matching deployment file.
- v4 test and production online deployments share the Dockerfile and the `/remote/v4` resource base but are
  isolated by independent Jenkins Jobs, images and Deployments. The two jobs must pass `ZCODE_ENV=test` and
  `ZCODE_ENV=production` explicitly; the Dockerfile validates in the builder stage and hands the endpoint to
  Vite injection. The domain itself does not rewrite the product environment at browser runtime:
  `test: zcode.z.ai/remote/v4 -> wss://zcode.z.ai/ws`, `production: zcode.z.ai/remote/v4 -> wss://zcode.z.ai/ws`.
- All four nginx configs must explicitly map `assets/`, `material-icons/` and `pdfjs/cmaps/` under their
  build bases to the artifacts in `/usr/share/nginx/html`. PDF.js CMap actually lives in
  `/usr/share/nginx/html/pdfjs/cmaps/`; requests with `/remote`, `/remote/v3`, `/remote/v4` or
  `/remote/__test__` prefixes must not enter the SPA fallback (otherwise nginx answers 200 with `index.html`
  as if it were a static resource). The Docker smoke must compare the real response body of representative
  `.bcmap` files, not just assert HTTP 200.
- All four `Dockerfile.web-remote-control*` use a Node builder to run a filtered install and the Vite build
  in the container: `pnpm install --frozen-lockfile --filter @zcode/web... --ignore-scripts`. The runtime
  stage keeps only `nginx:alpine` and static `dist`, no Node runtime. The release script does not rebuild on
  the host, so the final image resources come only from the Docker builder.
- nginx only serves static resources and SPA fallback and does not proxy the relay; the browser connects to the
  corresponding relay directly by the build-time endpoint. For Desktop App official versions >= `3.4.0` the QR
  URL is `https://zcode.z.ai/remote/v4?...`; for versions below `3.4.0`, pre-releases of `3.4.0`, or
  unresolvable versions it stays `https://zcode.z.ai/remote/v3?...`. Pre-releases above the threshold (for
  example `3.5.0-beta.1`) use v4; an explicit `ZCODE_WEB_REMOTE_CONTROL_URL` is not rewritten by the version logic.
- The desktop default QR URL does not point to `/remote/__test__`; to verify test resources override via
  `ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__ pnpm dev:desktop`.

Local verification (per chain): `pnpm run typecheck`, `pnpm run lint`, `pnpm run build:web-remote-control[:v3|:v4|:test]`
and `bash scripts/test-web-remote-control[-v3|-v4|-test]-docker-build.sh`. Build and push:
`export DOCKER_REGISTRY_PASSWORD='***'` then `bash scripts/docker-build-and-push-web-remote-control[-v3|-v4|-test].sh --tag <tag>`.
`zcode/frontend/deployment-remote-v4.yaml` and `zcode/frontend/deployment-remote-test.yaml` are convention
paths in the external infrastructure repository, not in this repository and not created by this feature. The
release script defaults to `K8S_REPO_DIR=~/workspace/cgx-dev-k8s` to update the matching deployment file and
create an MR; with `--skip-mr` it only builds and pushes the image.

## Transport

The external relay only handles the transport layer:

1. The desktop connects to the external relay at the current endpoint as a `device`, passing `device_mid` via `X-Device-ID`.
2. The mobile web connects to the same endpoint as a `terminal`; the browser passes the routing hint via the query `mid=<device_mid>`.
3. The relay completes `device_register_init`, `auth_init`, `auth_challenge`, `auth_response`, `auth_ack`.
4. Both ends heartbeat with `pair_status_query` / `pair_status_ack` at about 10 s average, jittered within 8-12
   s; if the latest ACK is not updated for over 30 s, a local watchdog triggers reconnection (with a small
   random delay to avoid reconnect spikes).
5. All ZCode business messages go in the relay `data.payload`; the relay does not parse the payload.

Task realtime sync follows the same boundary: the relay only forwards `rpc-frame` between mobile and desktop
main and does not parse tasks, sessions, workspaces or ZCode realtime events. The mobile page owns no Host and
starts no Agent runtime. After receiving `workspace-bridge-open`, desktop main creates a new `MessagePort`
attachment for the mobile bridge and attaches it to the service/CLI scope of the matching local/remote
workspaceKey in the target desktop window's single Window Host.

### Heartbeat scheduling and disconnection recovery

Heartbeats belong only to the local transport state of the desktop device transport and mobile terminal
transport; the relay does not save or broadcast the clients' scheduling times:

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

The heartbeat uses recursive `setTimeout`, resampling each round (average cycle still 10 s); heartbeats
missed while the page was in the background or the system slept are not resent. 30 s is a time-based ACK
deadline, not inferred from a fixed failure count; a watchdog-triggered reconnect adds a small random delay,
while explicit errors, user stops and foreground recovery keep immediate recovery. The heartbeat payload and
relay protocol schema are unchanged.

The pairing identity is `device_sid`. The QR URL is:

```text
/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<timestamp>&mid=<device_mid>&name=<device_name>&app_version=<app_version>
```

`hash` is the HMAC key material, appears only in the QR URL and credential storage, and is never written to
logs, OAuth state or setting.json.

## App payload

`data.payload` distinguishes business messages by `zcode_type`: `bootstrap-request` / `bootstrap-response`;
`workspace-list-request` / `workspace-list-response` / `workspace-list-updated`; `workspace-bridge-open` /
`workspace-bridge-ready` / `workspace-bridge-error`; `platform-request` / `platform-response`;
`mobile-view-state-update`; `rpc-frame` / `rpc-frame-ack` (transport-only; the relay does not parse);
`app-error`.

04D-3 made desktop main and mobile web use the shared acknowledged adapter; the global app parser formally
accepts the new strict fragment/ACK and deleted the legacy single branch. A raw Channel message cannot be
base64-inserted into a single `rpc-frame`; it must be split into physical fragments with
`messageSeq/fragmentIndex/fragmentCount/messageBytes/CRC32`; each fragment's final
`{type:"data",payload,client_ts,server_ts}` uncompressed JSON must be at most 1 MiB. One logical raw message
is at most 16 MiB / 64 fragments; the receiver stages one message and delivers it atomically after full
validation. `rpc-frame-ack` is the cumulative ACK of raw transport, not a command ACK, and carries no
conversation business facts.

The production adapter's transport state is symmetric and bridge-scoped: TX keeps the whole immutable
fragment batch before sending the first fragment and maintains `1 MiB / 256 KiB` flow edges and `8 MiB / 45s`
replay bounds by final outer JSON bytes; RX queues the cumulative ACK only after complete assembly and
successful synchronous Channel delivery, and ACKs are flushed first. The same bridge replays unACKed batches
each time it re-sends ready, including the `same-socket` case where the local WebSocket was not replaced but
the heartbeat re-confirms `matched` (the peer may already have been replaced, so local socket identity is not
delivery proof). Replay reuses the original immutable batch and does not refresh its queued age; new bridges,
terminal faults and dispose clear the old transport state. The first queued ACK is also bound by the 45s
deadline; later higher cumulative ACKs only replace the value without refreshing the age. These states hold
no task/session/topic/command facts. The desktop/web transport builds one immutable final outer JSON per
payload; the adapter's meter and the actual send share the same serializer/cache, and replay on the same
bridge reuses the same bytes. Raw frames/ACKs do not enter desktop main's ordinary 50-item app payload
buffer. Both ends hard-gate `<=1 MiB` uncompressed UTF-8 before `JSON.parse`; the compression switch does not
affect admission; permanent oversize and temporary unavailability are separated; a raw fault triggers one
hard bridge recovery. Across ends only the common `bridge-degraded: rpc-transport-fault` is passed; typed
reasonCodes stay in the owning end's secure logs.

`mobile-view-state-update` carries, besides `activeWorkspaceKey`, `activeTaskId` and `updatedAt`, a
`deviceInfo` field collected by the mobile browser, containing only controlled information the browser can
stably obtain: `platform/version/name`, `userAgent`, language, `navigator.platform`, viewport, screen,
timezone, online status and collection time. Desktop main keeps it only in the current window runtime and
exposes it to the desktop through `getWebRemoteControlStatus()`; it takes no part in workspace identity,
session binding, cache keys or relay pairing decisions.

After receiving relay `data.payload`, both desktop and mobile first run `parseWebRemoteControlAppPayload()`;
an invalid payload logs only secure metadata, never the raw JSON.

`workspace-list-updated` is used only after the desktop renderer synced a new snapshot through
`syncWebRemoteControlTasks` / `syncWebRemoteControlWorkspaces`, to push the same
`WebRemoteControlWorkspaceListResult` to the connected mobile client. It does not change responsibilities:
the relay only forwards `data.payload`; desktop main only composes and forwards the workspace/task index the
renderer already synced and holds no ZCode task, stream, queue or snapshot business state.

## Desktop main

`packages/desktop/src/main/webRemoteControlManager.ts` is responsible for:

1. Connecting to the external relay through `WebRemoteControlDeviceTransport`.
2. Storing the non-sensitive `deviceSid` in AppSettings through `WebRemoteControlRelayAuthStorageProvider`, and `passHash` in the credentialService.
3. Matching workspaces by `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
4. Creating a new `MessagePort` attachment for the current mobile bridge.
5. Encoding the host's `MessagePortProtocol` RPC messages into bounded `rpc-frame` fragments with the shared acknowledged adapter, and consuming the cumulative ACK.
6. Not parsing ZCode task business semantics and not taking part in task streams, permissions or workspace task list sync logic.

### Enablement recovery after a desktop App restart

"Whether Web remote control was enabled last time" is the user's enable intent: after a successful start the
last target is recorded; an explicit stop by the user clears the record. Window destruction and app exit
release the transport/attachments of that run; a renderer reload can keep reusing the window-level runtime;
none of these lifecycle events may rewrite the enable intent to off. So recovery works after normal or
unexpected app exit but not after the user actively closed it. Configuration changes such as endpoint
switching may pause the current runtime but likewise do not mean the user disabled remote control.

The persisted target stores only `workspacePath`, optional `workspaceIdentity` and optional `initialTaskId`.
`remoteSessionId` is the remote connection identity within this process and must not be persisted across app
restarts. A new process waits for the renderer to sync the restored workspace context of the current window
to main, matches the last target by `workspaceKey = workspaceIdentity?.trim() || workspacePath` and starts the
device relay with the current process's `remoteSessionId`. The target stays `idle` until it is restored in
some window; automatic recovery does not start a new local host, remote session or Agent runtime.

```text
Last startup success --> save enabled target ──┐
                                               v
New desktop main -> wait for window workspace sync -> workspaceKey match -> start device relay
                                               |
                                               +-> No match: remain idle, continue waiting for subsequent window sync

User explicitly stops --> clear enabled target --> remain idle on next startup
```

Automatic recovery rebuilds only the desktop device relay. The mobile client still enters the existing
shared host through the `web-remote-replayable` attachment; the desktop renderer stays `desktop-continuous`,
and replayable snapshot / gap recovery semantics must not spread into the desktop main path.

The external relay no longer provides `bridgeToken` or `wsUrl`. `WebRemoteControlExternalWorkspaceBridge`
only describes workspace identity and `bridgeSessionId`.

The desktop renderer and the mobile Web remote control connect to the same host/service/runtime through
different RPC clients. The host assigns each attachment an independent `connectionId` and a trusted
`clientMode`: local and SSH/WSL/Docker desktop windows are both `desktop-continuous`; mobile `/remote` is
`web-remote-replayable`. The host keeps an owned-subscription registry per attachment; downlink frames can
only be written to the MessagePort owning that `subscriptionId`; workspace broadcasts with the mobile then
dropping desktop frames are forbidden.

The mobile raw adapter's high/low edges flow up only through the owning attachment's MessagePort sideband; the
control object is consumed before the Channel parser and never becomes an RPC request/event:

```text
mobile adapter high/low
  -> desktop main (no topic/session state)
  -> owning host attachment only
  -> trusted connection scope (serial + dedupe)
  -> existing workspace CLI: v4/connection/flow
  -> pause/resume only mobile connection B

desktop connection A ----------------------------------> continues draining
```

Main/relay cannot specify arbitrary connectionIds; the host scope generates workspace/connection routes from
owned subscriptions. The remote host relay prefixes and namespaces downstream IDs by length. A port close
serially sends `closed` before disposing owned subscriptions; old SAT/DRN/timers must not revive.

`zcode-server /ws` fixes all normal connections as replayable; the old `x-zcode-rpc-client-mode` header is
ignored and cannot promote browsers or ordinary WebSockets to continuous. The desktop server-remote Node host
first obtains a short-lived one-time random capability through `POST /api/rpc-host-capability` (protected by
the existing server auth middleware), then connects to the dedicated `/ws/host` carrying it in a Node-only
header. The server creates a continuous trusted relay attachment only after consuming it; the final
`connectionId` is still generated per connection by the server. The open/no-token server also keeps the same
"explicitly apply for a ticket -> consume once" boundary; missing, invalid, expired or replayed tickets are rejected.

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

Each attachment's subscribe establishes pending ownership before calling the CLI. The CLI server uses a
request-scoped post-response outbox that always writes in `ACK response -> initial notification` order; even
when two lines arrive in one read, a physical wire arriving before the ACK enters only bounded staging; the
ACK binds `subscriptionId` and releases to the unique owner's incremental assembler in the original order.
Ownership filtering precedes assembly, so foreign subIds occupy no memory. The staging limit is 1,024 wires /
32 MiB; overflow clears the whole batch and explicitly marks `fault.subscription.initialFrameStagingOverflow`,
shifting single fragments is forbidden. Attachment close / stale generation / unsubscribe clears staging and
assembly. Unsubscribe is generated by the owned registry as a complete `{ topic, subscriptionId, connectionId }`
route; the CLI deletes only publisher entries matching all three exactly, so the same bare `subscriptionId`
is not deleted by mistake across topics or connections.

The CLI publisher's initial/online frames all use non-destructive reservations: all physical notifications
advance the water level only after the current transport accepts them; a mid-stream failure retries the same
logical id/content. The topic encoder slices by the conservative bounds of CLI NDJSON, Channel binaries and
old mobile outer JSON; the production mobile Channel message is then subject to the raw adapter's independent
precise final-envelope metering/fragmentation, so actual relay JSON never exceeds 1 MiB. Attachments go
through a separate `begin -> <=512KiB decoded chunk -> commit/abort` business transaction; renderer-to-host
Channel and host-to-CLI NDJSON envelopes are metered independently; a full-data `attachment/put` fallback is
forbidden. Relay/main see only opaque `rpc-frame` and keep no upload staging, checksums or artifact refs.
Each subscription holds a monotonically increasing `logicalFrameOrdinal`; the host/renderer assembler uses it
to block late replays and reverse supersede; completed/fault/timeout tombstones are cleared only on
unsubscribe/replacement.

Real metadata of task messages, assistant streams, tool calls, permissions, plans, runtime status and task
lists all comes from the same CLI/runtime. Composer drafts, scroll/focus/panels and other uncommitted state
stay renderer-local; once input is submitted, whether from desktop or mobile, it enters the same CLI
`CommandInbox`/runtime FIFO directly. Mobile V4 no longer goes through the `enqueueTaskCommand` host runtime
command queue, the desktop keeps no renderer-local accepted queue, and the UI keeps only the pending
optimistic overlay and reconciles through projections/`commands/query`.

The remote workspace bridge may only attach to a `remoteSessionId` that already exists and is not closed in
the desktop window. `remoteSessionId` is allocated by the registry inside the Window Host and stays a
workspace-level logical session; main holds only request correlation and forwarding scope; the Host finally
validates the `workspacePath + workspaceIdentity` the session was bound to before creating independent
attachments. The mobile client cannot create new SSH / WSL / Docker remote sessions or reach workspace B under
the same Host by borrowing session A; identity isolation keeps using `workspaceIdentity?.trim() || workspacePath`.

After determining the canonical path and identity in remote directory selection or reconnect, the desktop
renderer must `BindRemoteWorkspaceSessionContext` to bind the same `workspacePath + workspaceIdentity` back to
the main/Host logical session. If the values used by tabs, remote history and the mobile-visible workspace
list disagree with the main descriptor, the bridge rejects with `REMOTE_WORKSPACE_IDENTITY_MISMATCH` (in
3.12.0 new connections lacked this bind, so mobile could not connect to remote projects).

Process recycling is still triggered by desktop lifecycle events: real window close, app quit and update
installation close the attachments before recycling the corresponding or all Window Hosts; mobile
bridge/relay disconnect, page refresh and replayable reconnect only release short-lived attachments and must
not destroy a Window Host or remote connection still used by other owners. This boundary does not change the
`workspaceIdentity + remoteSessionId` routing and does not sink replayable state to main.

## Task message streams

Desktop and mobile connect to the same service/runtime, but the delivery profile is decided by the trusted
attachment, not UI parameters: the desktop (including remote workspace desktop windows) is fixed as
`continuous`, keeping the complete real-time stream; mobile Web remote control is fixed as `replayable`, for
disconnect reconnect, page refresh, late subscription and gap recovery.

Replayable is not relay-level replay. The relay still only forwards `rpc-frame`; connection-level
saturated/drained is passed to the host/CLI by desktop main through the owning MessagePort sideband. Topic
sequences, subscriber buffers, fragment assemblies, gap/resync and snapshots are maintained by the host facade
and the CLI publisher/client apply; relay/main hold no conversation business state.

Recovery sequence on a mobile gap or after attachment rebuild:

1. Re-attach the bridge, complete the V4 `hello/clientHello` and obtain a new trusted connection context.
2. Re-subscribe automatically by active topics; try resume when there is a valid `{logEpoch, seq}`, otherwise snapshot.
3. Replace the whole snapshot after complete fragment assembly; silently drop `toSeq <= localSeq`.
4. A gap triggers only one `v4/conversation/resync`; resuming a gap again forces a snapshot.
5. Restore permissions/elicitation, queue/guided rows and pending command summaries from projections; reconcile with `commands/query` when the ACK is unclear.

A CLI runtime restart changes `logEpoch` and triggers snapshots. Inputs admitted by the previous process but
not in the transcript explicitly return `fault.command.inputDiscardedOnRestart` and the persisted `delivery`;
the old runtime's `queue/guide` settles silently; only `startNow` or `unknown` not in the transcript prompts the
user to confirm resending; automatic replay is not attempted. When the mobile network disconnects but the
runtime was not replaced, the authoritative queue is still recovered from the replayable snapshot and does not
depend on renderer localStorage.

Blocking events cannot be filtered as ordinary owner-only content streams. `permission_request`,
`elicitation_request`, their responses, terminal and snapshot invalidation must be visible to online clients
of the same task, or at least trigger snapshot alignment.

## Web

`/remote`, `/remote/v3` and `/remote/v4` are QR direct-connect entries, handled before the `/web-remote` OAuth logic.

Mobile web connection flow:

1. Parse `sid/hash/t/mid/name/app_version`.
2. Authenticate as `terminal` through `WebRemoteControlTerminalTransport`.
3. After pairing, send `bootstrap-request`; v4 uses the optional `desktopAppVersion` of the response to
   validate the URL. On first inconsistency correct and navigate; if already on the page keep the page and
   prompt confirmation before reloading; when an old desktop lacks the field, keep the original behavior.
   Reconnect/foreground recovery re-validates even when the bridge is healthy; details in
   [v4 version sync](./remote-v4-static-deployment.md#v4-url-synchronization-with-desktop-actual-version).
4. Select the initial workspace by `mobileViewState -> initialViewState -> first workspace`.
5. If the target remote workspace does not yet meet the bridge conditions, render the home-only `Root`,
   keeping the workspace list and reconnect entry; no workspace bridge is created and task operations that
   depend on workspace services are not opened. With no selectable workspace an error page is shown.
6. When the target can establish a bridge, send `workspace-bridge-open`, using
   `createAcknowledgedWebRemoteControlRelayProtocol()` to adapt `rpc-frame` / `rpc-frame-ack` app payloads to
   `IMessagePassingProtocol`, keeping fragmentation, ACK and transport recovery.
7. After `connectViaProtocol()` render `Root`; the narrow screen is managed by `WebRemoteControlMobileShell`
   for the home/chat pages and the wide screen uses the remote control sidebar. Selection of the initial
   workspace and page landing are two states; a selected task does not mean auto-entering chat.

`/web-remote` remains the ZAI OAuth login and waiting-page entry; `remoteControlToken` / `relayOrigin` belong
only to the old `/web-remote` behavior and do not apply to the new `/remote`, `/remote/v3` or `/remote/v4` QR routes.

## Feature exposure

Desktop main uses `createWebRemoteControlFeatureGate()`, default `true`, without automatically disabling
remote control by production/development environment. Production can start through the existing remote
control entry and get connection information; "production build" can no longer be assumed to reject the IPC
or hide the QR. `WebRemoteControlFeatureGate` keeps an explicit disable capability: when `false` is injected
the manager refuses to start and the status returns no valid connection information. This gate is a feature
switch and does not replace the caller-source verification and internal ticket boundary below. Wiring is in
`packages/desktop/src/main/index.ts`; the switch implementation in `packages/desktop/src/main/webRemoteControlFeatureGate.ts`.

## Startup call boundary and Office XSS

Opening `WebRemoteControlDialog` is the existing user entry to Web remote control. When the current target
has no reusable runtime the renderer sends a start IPC at once; refreshing the QR keeps the confirmation
dialog already in the renderer. To keep the existing experience, Desktop main adds no native second
confirmation for start or refresh.

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

The manager still generates a short-lived one-time internal ticket bound to
`windowId + workspaceKey + remoteSessionId` (`workspaceKey = workspaceIdentity?.trim() || workspacePath`); the
ticket must not enter the renderer-writable shared protocol nor be written to logs, telemetry or ordinary
settings. It constrains the targets of `startAuthorized` / `resetPairingAuthorized` and consistency, but
because the same IPC request issues the ticket immediately, it is not user authorization and cannot stop a
compromised renderer from calling the start IPC.

The manager dependency type exposed to the IPC handler allows only `authorizeStart`, `startAuthorized`,
`resetPairingAuthorized`, `stop` and `getStatus`. Direct `start` / `resetPairing` belong only to the
manager's internal lifecycle and cannot enter IPC dependency interfaces reachable by the renderer. Public
return types keep the `cancelled` compatibility branch, but the current Desktop start and refresh paths never
produce that terminal state. Start, refresh pairing, window close, user stop and ticket expiry all invalidate
unconsumed tickets. Restoring "last enabled" at app startup remains an internal lifecycle operation and must
not bypass workspace/session binding.

The root-cause boundary of Office document XSS is defined by `docs/ui/office-file-preview.md`: untrusted links
must pass the protocol allowlist, DOM sanitization, click interception and controlled external link opening.
Removing the native remote control confirmation does not change these root-cause fixes; the cost is that if a
new renderer XSS appears or the boundary is bypassed, the internal ticket gives no evidence of user presence.
Security assessments must not treat the ticket as a compensating control for Office XSS.

`web-remote-replayable` should not get terminal capabilities by default. If the product still needs mobile
terminals they must be exposed through independent workspace/session/device binding capabilities, short TTL,
owner/lease and disconnect recycling; the generic `services.exposeOnChannelServer()` cannot be treated as authorization.

## Workspace Hook Trust review

Workspace Hook Trust replicates no business state in the relay, desktop main or renderer. The Desktop
continuous and Mobile/Web replayable attachments share one CLI Runtime review registry:

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

- The Host capability `workspaceHookReview` and the Client UI capability `workspaceHookReviewUi` are declared separately; missing equals false.
- The review request is projected as `pendingInteractions[kind=workspaceHookReview]`; mobile refresh, gap/resync or attachment rebuild only restores presentation and never settles Runtime requests.
- The command target is bound to `taskId + runId + remoteSessionId? + workspaceIdentity + bundleDigest + reviewFlowId + generation + interactionId`; any mismatch is rejected before the store mutation.
- The renderer pending-command registry saves only the sensitive command digest/ACK status. When the ACK is unclear `commands/query` can be used; the original Trust decision is not persisted or auto-replayed.
- A Runtime restart produces a new run epoch; old interactions, Allow once and pending sensitive commands cannot be reused across epochs.
- With `workspaceHookTrustEnabled=false` the Runtime does not read the Trust store or create reviews; the Protocol Host can roll the field back to a hard block at the trusted bootstrap boundary.
- Managed denials always outrank Trust established by UI/CLI; relay/main only route opaque commands and projections and hold no copy of policy, Trust stores or leases.
