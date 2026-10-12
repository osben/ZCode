# Self-hosted remote relay

## Status and audience

Implementation authorized on 2026-10-11 after review of this design. Production deployment/publication is not authorized by that implementation request.
The server package, shared transport contract and Dockerfile are now implemented;
operator configuration is in [the relay README](../packages/remote-relay/README.md).
Independent Desktop window registrations and release URL defaults remain pending.
Audience: maintainers implementing and operating the fork's public remote-control service.
The implementation boundary is a separate relay executable, its shared wire contract, and the existing Desktop/Web clients. This is not a replacement Agent or standalone cloud workspace server.

## Confirmed product decisions

| Decision | Rule | Source |
| --- | --- | --- |
| Registration | Public registration for users of the fork; no invitation or account requirement in v1 | User, 2026-10-11 |
| Browser replacement | A newly authenticated browser replaces the previous browser for the same target | User, 2026-10-11 |
| Desktop targets | Several independent Desktop windows can be controlled simultaneously | User, 2026-10-11 |
| Isolation unit | Each window has its own registration, key and browser pair; workspaces remain owned by that window's existing Host | Derived from independent-window requirement and current Host boundary |
| QR lifetime | Pending: window-lifetime identity versus persistent identity restored across application restarts | User question pending |

All proposal values below are implementation recommendations, not evidence of deployed behavior or measured capacity. The QR-lifetime decision is a stop gate for Desktop identity/persistence implementation; independent server contracts and package boundaries can be prepared before it is resolved.

## Repository placement

Use `packages/remote-relay`, package name `@zcode/remote-relay`. `pnpm-workspace.yaml` already includes `packages/*`. This placement follows the existing executable `packages/zcode-server-cli`, but introduces no dependency on that package.

```text
packages/remote-relay/                 # proposed, not created yet
  package.json
  tsconfig.json
  tsup.config.ts
  README.md                           # operator configuration and local launch
  Dockerfile                          # standalone Node image
  src/
    module.ts
    contract.ts                       # typed configuration and IO ports
    contract.example.ts
    contract.test.ts
    CONTRACT.md
    domain/connectionState.ts         # pure guards and state transitions
    app/relay.ts                      # sole connection/pair registry owner
    adapters/nodeServer.ts            # HTTP/WebSocket, composition and shutdown
    adapters/auth.ts                  # random identifiers, HMAC and key encryption
    adapters/deviceStore.ts           # asynchronous SQLite port / worker client
    adapters/deviceStoreWorker.ts     # synchronous SQLite isolated from socket loop
  test/                               # protocol, persistence and real-client tests

packages/shared/src/web-remote-relay/  # proposed transport-only public contract
  index.ts
  module.ts
  contract.ts
  contract.example.ts
  contract.test.ts
  CONTRACT.md

specs/self-hosted-remote-relay.md       # this design and acceptance catalog
```

The tree names responsibilities, not a requirement to add empty abstractions. Keep related operations together until an actual boundary requires a separate file. The managed-module contract files are required by repository architecture governance.

Register `remote-relay-protocol` and `remote-relay` as managed modules in `architecture-policy.yaml` during implementation. Protocol requires no other workspace module; relay requires only the protocol. Relay layers are `domain -> app -> adapters`; domain performs no IO and imports no Node APIs. The executable/composition entry is in adapters. Both modules expose explicit public entry points and matching `module.ts` declarations.

Add the shared package export `@zcode/shared/web-remote-relay`. Relay must not import the shared aggregate entry point, application payload schemas, Desktop, UI, services, server, client, RPC or Agent. Existing client-facing types remain available from their present entry points through aliases/re-exports, including their typed application payload specialization.

## Stack, build and packaging

| Concern | Decision |
| --- | --- |
| Runtime | Node 24, pinned through the repository toolchain; TypeScript/ESM |
| Socket transport | `ws`, following the version already used by this repository |
| HTTP | `node:http`; no new HTTP framework |
| Validation | Shared transport schemas using the existing `zod` version |
| Durable storage | `node:sqlite` in one dedicated worker, accessed through Promise-based ports |
| Packaging | Node executable bundled with the existing `tsup` toolchain; standalone Docker image |
| Initial topology | One relay replica with a persistent database volume, behind an HTTPS reverse proxy |
| Compression | WebSocket compression off initially; enabling it requires workload measurements |

The registration table contains SID, machine MID, a server-computed key fingerprint, encrypted verifier material, creation time and last successful authentication time. Enforce uniqueness for `(MID, key fingerprint)`. Store writes happen on registration/authentication, not on every heartbeat or forwarded message. SQLite initialization/migration and key validation complete before readiness; a failed store is a failed startup, not an in-memory fallback.

The proposed runtime configuration owns listen host/port, database path, storage encryption key, allowed Web origins, trusted proxy addresses, admission quotas, outbound byte budgets and liveness deadlines. Local development defaults to loopback; a container binds its private interface explicitly. Require finite production limits and a valid encryption key. These are relay-only configuration inputs; no secret uses a `VITE_` variable or enters Desktop/Web build defines. Exact quota values are deployment parameters to establish with the local acceptance/load fixtures, not a promised service capacity.

New package manifest entries must be declared explicitly; workspace hoisting is not a dependency declaration. The user authorized the planned implementation, including the existing `ws` and shared protocol dependency. Any additional runtime library requires separate approval.

Proposed package commands: `dev`, `build`, `start`, `typecheck`, `test`. Proposed root aliases: `dev:relay`, `build:relay`, `test:relay`. These commands do not exist yet.

Add the package to the root explicit TypeScript build list. Root Vitest already includes `packages/*/test/**/*.test.ts` and `packages/*/src/**/contract.test.ts`; confirm discovery rather than copying the root test configuration. Use real socket barriers in integration tests, fake clocks only for deadline behavior.

Desktop builds and `scripts/build-zcode.mjs` must not stage or start relay. The generic recursive root build may build its package normally, but that does not make it part of the Desktop/runtime artifact. The relay container is built separately from the repository root with a filtered dependency closure; it contains no Electron, CLI Agent, native PTY, SSH, browser-use runtime, model credentials or project files.

Web remains `packages/web`, built under `/remote/v4/` and served separately by the reverse proxy. Its bundle must match the Desktop fork release; v1 needs no query-selected archive/version distribution service. Add container smoke coverage outside the checkout, without workspace package resolution fallbacks. Do not publish images or modify deployment infrastructure as part of implementation without authorization.

## Owners and dependency directions

| State/fact | Single authority | Persistence | Boundary |
| --- | --- | --- | --- |
| Registration SID and verifier material | Relay registration store | Relay SQLite | Transport authentication only |
| Socket authentication, challenge, active pair, pair generation | Relay application registry | None | Per SID and connection generation |
| Outbound pressure/queued transport bytes | Socket adapter | None, bounded | Per receiver plus process-wide cap |
| Window registration/key and enabled state | Desktop Main remote-control manager | Depends on pending QR-lifetime decision | Per window and relay origin; never app-wide shared key |
| Last-enabled startup target | Existing Main startup-intent owner | Existing non-secret setting, selected from enabled windows | A window's stop cannot clear another window's selected intent |
| QR/status and selected remote target | Existing Desktop status projection / browser local view | Existing owners | UI does not own relay or Host facts |
| Workspace service scope | Existing window Host / attachment owner | Existing owners | `workspaceIdentity` and `remoteSessionId` remain end-to-end |
| Tasks, accepted commands, Agent execution, stream recovery | Existing Host/CLI runtime | Existing stores | Never copied into relay |

No accepted command queue, RPC assembly, cumulative ACK generation, transcript cache, snapshot store or model/provider service belongs in relay. The existing endpoint adapters retain retransmission and delivery acknowledgement. Socket buffers do not become a durable offline mailbox.

```mermaid
sequenceDiagram
    participant D as Desktop Main: window A
    participant R as Relay: pair owner
    participant S as Registration store
    participant B1 as Browser 1
    participant B2 as Browser 2
    D->>R: register window-specific key
    R->>S: commit registration
    S-->>R: committed SID
    R-->>D: device_register_ack
    D->>R: challenge / proof as device
    B1->>R: challenge / proof as terminal
    R-->>D: matched
    R-->>B1: matched
    B2->>R: challenge / proof as terminal
    R->>R: retire B1; advance pair generation; bind B2
    R-->>B1: KICKED; close
    R-->>D: matched
    R-->>B2: matched
    Note over R: Old B1 callbacks cannot mutate or send through the new pair
    B2->>R: data.payload
    R->>D: same payload
    Note over D: Existing attachment routes to window A Host; window B has another SID
```

## Wire and public HTTP contract

Preserve the current relay envelope and HMAC calculation: `base64url(HMAC-SHA256(pass_hash string, nonce + "|" + role + "|" + device_sid))`. The key is the UTF-8 string supplied by the current clients, not its Base64-decoded bytes. Use existing shared proof vectors as compatibility fixtures.

| Request | Reply | Rule |
| --- | --- | --- |
| `device_register_init {device_mid, pass_hash, meta, client_ts?}` | `device_register_ack {device_sid, server_ts?}` | Commit before ACK; rate limited; no overwrite by machine ID |
| `auth_init {role, device_sid, meta, client_ts?}` | `auth_challenge {nonce, server_ts?}` | Bind challenge to this socket, SID and role |
| `auth_response {device_sid, proof, client_ts?}` | `auth_ack {device_sid, terminal_sid?, pair_status, server_ts?}` | Challenge is single use and expires; fixed-length constant-time proof comparison |
| `pair_status_query {device_sid, client_ts?}` | `pair_status_ack {terminal_sid?, pair_status, server_ts?}` | SID must equal the authenticated socket's SID |
| `data {payload, client_ts?}` | Peer receives `data` envelope | Forward only for current authenticated pair; payload remains opaque |

The only pair statuses are `waiting` and `matched`. Errors retain `{type: "error", code, message, server_ts?}` with `AUTH_FAILED`, `DEVICE_OFFLINE`, `KICKED`, `WRONG_PARAM`, `INTERNAL`. Malformed/order-invalid requests use `WRONG_PARAM`; invalid proof/unknown registration uses `AUTH_FAILED`; database/transport failures must not be reported as invalid credentials.

`GET /ws?mid=<routing-hint>` upgrades to WebSocket. Preserve `X-Device-ID` support for Desktop, but neither header nor query authenticates a device or selects a business workspace. Registration SID, after authentication, is the pair key. Several window SIDs may share one machine MID.

`GET /healthz` returns 200 for a running process. `GET /readyz` returns 200 only after configuration/store initialization and while accepting connections; otherwise 503. Neither response exposes registrations, keys or user metadata. Unsupported HTTP routes return 404. Upgrade admission can reject with 400, 403, 429 or 503 before switching protocols; existing clients must recover without interpreting these as successful registration.

This protocol does not alter CLI stdio messages or Agent business protocol. Do not add unused Agent commands to `zcode-protocol/index.ts`; change that contract only if implementation actually crosses its boundary.

## Connection admission and replacement

Connection states: `new -> registering? -> challenge-issued -> authenticated(device|terminal) -> closed`. Permit only the message types valid in the current state. Async registration/authentication results capture a connection generation and are discarded if the socket has closed or been superseded. Serialize admission on each connection; bound pending input while store work is in flight.

Registration retry is safe for the same machine MID and high-entropy key: a server-computed key fingerprint plus MID identifies the same registration and returns its SID. A new key creates a new registration. Another key with the same MID must not overwrite the first record. A failed commit produces no successful ACK; an ACK lost after commit must not create an unlimited series of records on retry.

Authenticate a replacement browser before disturbing the old browser. Advance the pair generation and retire the old socket atomically; only then acknowledge the new pair. Discard old receiver-bound queued data. Old `close`, heartbeat and async callbacks may only remove their exact connection/generation. Do not tell Desktop to restart its Host or Agent.

For a second Desktop connection using an already-live SID, preserve the existing Desktop and reject the newcomer with `KICKED`. Desktop currently treats that code as recoverable. Once the previous socket closes or fails liveness, reauthentication can claim the slot. This differs deliberately from browser replacement: mutually replacing reconnecting Desktop clients would cause a loop. Independent windows use distinct SIDs and never encounter this conflict in normal operation.

On Desktop disconnect, a previously authenticated browser may stay connected in `waiting`. On browser disconnect, Desktop stays registered and waiting. Answer application heartbeat queries in both waiting and matched states; also enforce server-side socket liveness. Clients currently schedule queries around 8–12 seconds and enforce a 30-second ACK deadline. A server liveness deadline must accommodate that scheduling and suspended clients; establish it with recovery tests rather than copying the client deadline blindly.

If a peer disappears during forwarding, fail visibly/recoverably and update pair state. Never acknowledge an application command, silently drop traffic while continuing to claim delivery, or replay old messages into an unrelated registration. Bounded transport failure closes the affected connection and lets endpoint recovery act.

## Desktop multi-window integration and migration

Current Main has `Map<number, WindowControlRuntime>`, but `WebRemoteControlRelayAuthStorageProvider` uses one application-wide `deviceSid/passHash`. Startup persistence also remembers one last-enabled context. Independent windows require changing this scope; a relay alone cannot fix it.

Each enabled window must own a unique registration and key. Machine MID remains a machine routing hint. Do not use a workspace path as the registration identity: multiple windows can open the same local path, and remote identity is separate from path. Electron window IDs are process-local and cannot identify restored windows across restarts.

Pending QR-lifetime alternatives:

- **Window-lifetime identity (recommended):** Main creates a random control identity/key for the actual window lifetime, reuses it through renderer reload, network reconnect and stop/start, and rotates on explicit QR refresh. True window close/application exit discards it. The next process issues a new QR; existing last-enabled intent can restore remote-control enablement only through the current startup path, without inventing multi-window restoration. No per-window credential persistence is needed.
- **Persistent identity:** requires a stable window/profile identifier, lifecycle-aware profile restoration and separately scoped credential entries keyed by normalized relay origin and profile ID. Do not map profiles by transient Electron ID, workspace path, creation order or whichever window first reports a matching workspace. Design and approve the restore/migration flow before implementation.

For the recommended branch, legacy application-wide authentication must not be cloned into every window. Do not read, expose, or delete unrelated credentials; retain the old stored value until the migration policy explicitly retires it. Existing enabled intent is not a reason to open new windows, start new Hosts or create remote sessions. Explicit stop disables that window; renderer reload/network loss does not. Closing one window must not stop another window's remote control.

Keep the existing single last-enabled startup target separately from per-window runtime authentication. Main selects the most recently explicitly enabled remaining window as that target. Stopping/closing one window cannot blindly clear the target selected from another enabled window; recompute the target under the same owner before persisting it. Normal app exit preserves the selected intent instead of treating shutdown cleanup as a series of manual stops. Startup still restores at most the existing one target once its workspace is actually restored; restoring all previous windows is not promised by the recommended branch. The pending persistent-identity alternative needs its own approved multi-window restore contract.

The existing platform methods and QR dialog remain the user entry point. No new relay-settings screen or device dashboard is required for v1. Preserve QR refresh confirmation, window-bound IPC authorization and existing capability restrictions.

## Public-service controls and limitations

Public registration means any protocol-compatible client can attempt registration. A User-Agent, version string, MID or public value compiled into the fork cannot prove that the caller is an official fork build. Accounts/attestation are outside the confirmed v1 scope.

Enforce configurable caps for connections, pending challenges, registrations per source IP, registry size, per-receiver queued bytes and total queued bytes. Trust forwarded IP headers only from configured reverse proxies. Allow the deployed browser origin while accommodating Desktop connections without an Origin header; Origin filtering is not authentication. Return retryable overload behavior, do not evict active devices to make room for anonymous registrations.

Validate the complete uncompressed incoming WebSocket message at at most 1 MiB before JSON parsing; bound small control envelopes separately. Enforce the same final-envelope limit after adding `server_ts`. Preserve payload bytes/values and ordering; do not decode RPC fragments or inspect task/session/permission fields. Compression remains off until separate memory/traffic measurements justify it.

Store only registration/authentication material and minimal lifecycle metadata. Keys are encrypted at rest with a server key supplied outside the image; preserve that key with backups. Online connections/challenges/pairs are memory-only. Retention of inactive registrations is a configurable operator policy; the baseline contract must not silently change valid QR lifetime through garbage collection.

Use structured event logs and bounded counters for connections, registrations, failures, forwarded bytes and pressure. Never log pass hashes, proof values, QR URLs, query strings, message bodies, hostnames or user metadata. Reverse-proxy logs for the Web route must omit the query: the QR secret currently appears in it. Set a restrictive referrer policy for that page. Do not add vendor telemetry.

Current QR material can authorize both roles because the existing protocol uses the same key for `device` and `terminal`; role binding in HMAC prevents proof reuse across roles but does not create separate role credentials. Retaining this compatibility model is not device attestation. Separating role credentials is a distinct protocol/security change to approve before extending v1.

WSS protects the two connections, but relay can read their payloads; there is no endpoint-to-endpoint encryption in the inspected transport. The QR timestamp is not included in relay authorization, so a server cannot enforce QR-specific expiry from it without a contract change. Do not claim E2EE, QR TTL or physical-device identity.

## Deployment and endpoint configuration

One replica owns both sockets for each SID. SQLite volume contains only the registration store; no user workspace mounts. Use a process lifecycle with SIGTERM drain: stop accepting upgrades, mark readiness false, close clients, await bounded store shutdown and exit. Crash/restart loses live sockets, not committed registrations.

A reverse proxy serves `https://<public-origin>/remote/v4/` and forwards `wss://<public-origin>/ws` to relay. Preserve WebSocket Upgrade and configure read timeouts to accommodate heartbeat. Deployment sizing and caps require a local load/recovery measurement; this design has no demonstrated throughput claim.

Public relay and Web URLs must be compiled into the fork's Desktop release and Web build. Desktop's current `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` and `ZCODE_WEB_REMOTE_CONTROL_URL` are runtime overrides, not automatically inherited by an app launched from Finder/Explorer. Extend the existing build-time configuration path with public URL defaults and tests; do not bake secrets into bundles. Web uses its existing `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` override.

Activate the new window-registration policy explicitly with the fork's self-hosted relay configuration. Unconfigured builds retain the existing external-relay behavior; do not infer the policy from an arbitrary hostname. Compatibility of multiple registrations sharing a MID with the upstream hosted relay is unverified and is not part of the self-hosted acceptance claim. Tests must distinguish configured fork behavior from the untouched external-relay path.

Keep relay/Web URLs independent from Z.AI OAuth, Coding Plan, provider and API endpoint origins. Never repoint `ZCODE_BASE_URL` merely to select our relay. Use existing `zcodeEndpoint` resolution as the integration point. Missing/invalid production relay URLs must fail the opt-in relay-enabled release configuration clearly rather than silently route users to another operator.

Add a separate relay container build/smoke CI path at implementation time. Follow repository workflow permissions; do not add registry publication, deployment credentials or automatic production rollout without authorization. Existing Desktop release jobs only need the approved public client URL configuration.

## Implementation slices

| Order | Deliverable | Done evidence |
| --- | --- | --- |
| 1 | Transport-only shared contract and managed module boundaries | Existing type imports compile; HMAC vectors and envelope schemas pass; no Agent/RPC dependency |
| 2 | Relay executable: registration store, authentication, registry, forwarding and bounds | Real socket integration, restart persistence, isolation and malformed-input cases |
| 3 | Window-scoped Desktop registration and lifecycle, public fork URLs | Two real windows/registrations and QR flows; selected lifetime policy; no cross-window effects |
| 4 | Standalone container and local relay/Web/Desktop development entry | Image runs outside repo with persistent fixture volume; no native Agent assets; readiness/shutdown smoke |
| 5 | Browser/Desktop recovery and publication readiness | E2E evidence below; load/pressure measurements; operator configuration; deployment still requires authorization |

No implementation slice may erase owner/lease, stale-run or workspace guards to make a happy-path test pass.

## Acceptance catalog and coverage

Status `accepted` means required by confirmed product rules or an existing invariant; it does not mean implemented/tested. `undefined` cases require the pending product decision. All evidence is planned.

| Case | Setup/action | Required assertions | Status / evidence |
| --- | --- | --- | --- |
| RELAY-01 | New Desktop window registers and browser scans its QR | Store commits before ACK; both real HMAC providers authenticate; existing Host attachment serves its scope | accepted; socket + Desktop/browser E2E |
| RELAY-02 | Window A and B on one machine; separate browsers | Distinct SID/key; same MID allowed; no A/B command or payload crossover | accepted; socket + two-window E2E |
| RELAY-03 | Same workspace path in both windows; local and remote scopes | Window isolation still holds; identity/session guards preserved | accepted; attachment fixture + E2E |
| RELAY-04 | Invalid/replayed proof, SID substitution, data before auth | No forwarding/registration overwrite; bounded errors; challenge cannot be reused | accepted; protocol integration |
| RELAY-05 | Browser 2 authenticates; browser 1 closes late | Browser 1 receives KICKED and stops auto-retry; browser 2 works; late callbacks cannot detach it | accepted; socket + browser E2E |
| RELAY-06 | Unauthenticated/invalid browser attempts replacement | Existing pair remains active | accepted; protocol integration |
| RELAY-07 | Desktop reconnect races old close; duplicate live Desktop SID | No mutual replacement loop; eventual recovery after old slot is released; other windows unaffected | accepted; real socket barriers |
| RELAY-08 | Refresh browser, reload renderer, lose/recover network | Existing window registration retained as required by lifetime policy; fresh attachment; no new Host/Agent | accepted; socket + lifecycle E2E |
| RELAY-09 | Restart relay with the same durable store | Same registrations authenticate; live pairs rebuilt; endpoint RPC recovery owns replay | accepted; process/store integration |
| RELAY-10 | Full Desktop restart and true window close | Apply the selected QR identity/lifetime policy without assigning an old link to another window | undefined; lifecycle E2E |
| RELAY-11 | Stop/refresh QR/close window A while B is active | Only A is affected; old A link cannot control its replacement registration; enable intent follows explicit action | accepted; two-window E2E |
| RELAY-12 | 1 MiB boundary, oversize/malformed input, slow receiver | Full uncompressed envelope checked; bounded memory; no false command/RPC ACK; Desktop execution unaffected | accepted; socket/pressure integration |
| RELAY-13 | DB write failure, lost registration ACK, retry | No false success; no overwrite by MID; retry can recover committed registration | accepted; store fault injection |
| RELAY-14 | Registration floods/quota limit/proxy headers | Resource caps enforced; untrusted headers cannot bypass admission; active registrations not evicted | accepted; bounded local fixtures |
| RELAY-15 | Local and SSH/WSL/Docker workspace sends during phone recovery | One existing runtime/CommandInbox; no duplicate admission; Desktop continuous stays separate from mobile replayable | accepted; existing protocol/attachment fixtures + representative E2E |
| RELAY-16 | Production bundle/container without workspace fallbacks | Fork clients resolve approved public URLs; relay artifact contains only its closure; no secret payload logging | accepted; build/container smoke |

Existing client transport tests often use mocked proof providers/server ACKs; they are supporting recovery evidence, not authentication coverage for a new relay. The existing manual-review mobile onboarding scenario explicitly excludes real relay pairing; new real-relay/two-window cases need their own admission and evidence before CI promotion.

## Impact Brief

### Feature Summary

| Field | Value |
| --- | --- |
| Intent / capability | Operate the fork's public remote relay with independent Desktop windows |
| Change layers / mode | validation, commit-effect, persistence, recovery; planning |
| Primary seeds | Shared relay types; Desktop manager/auth storage; Desktop QR dialog; Web terminal transport; endpoint/build configuration |
| Out of scope | Agent/session logic, new cloud runtimes, device/account dashboard, invitation/OAuth registration, multi-browser fanout, E2EE, multi-replica topology, auto-deployment |

### UI Surface Matrix

| Scenario / entry | Projection/default owner | Guard and commit path | Authority / isolation |
| --- | --- | --- | --- |
| Enable/stop/refresh QR: `WebRemoteControlDialog` via `WorkspaceWebRemoteControlTrigger` | Dialog local loading; status from `useWebRemoteControlStatus`; public URLs from Main build/runtime config | `usePlatform -> IPlatformService -> desktopWebRemoteControlIpc -> manager` | Main owns window registration; existing refresh confirmation; other windows unaffected |
| Desktop sidebar/Root remote status | Existing status hook and window-specific status events | Read projection only; no registration write | Main status authority; workspace/task selection stays independent |
| Browser `/remote/v4`: bootstrap/home/chat | Browser terminal transport and local view state; relay URL from Web build | QR parser -> terminal auth -> existing workspace bridge | Relay pair authority; Host validates workspace scope; no independent browser Agent |
| Automatic remote-control enablement after app startup | Existing last-enabled intent and synchronized window workspaces | Existing `tryRestoreEnabledState`, subject to selected lifecycle policy | No window creation or guessed persistent window mapping |

### Shared And Divergent Behavior

| Concern | Shared | Deliberate difference |
| --- | --- | --- |
| Wire/authentication | Same envelope, schemas and HMAC vectors | Device registration versus terminal attachment |
| Replacement | Generation-bound cleanup | New terminal wins; live Desktop slot is not displaced |
| UI/defaults | Existing platform boundary and shared remote UI | Desktop status per window; browser selection local; Web URL compiled separately |
| Persistence/recovery | Durable server registrations; endpoint recovery | Window key persistence depends on QR decision; no relay business replay |

### Feature Relationships

| Rank | Edge / target | Why / evidence |
| --- | --- | --- |
| must-inspect | Relay contract -> Desktop/Web transports | Wire compatibility and different KICKED recovery; shared/transport tests |
| must-inspect | Window lifecycle -> manager -> auth storage | Current window map conflicts with app-wide auth storage; Main manager/storage source |
| must-inspect | Public build URLs -> fork Desktop/Web | Runtime env alone does not configure packaged apps; Desktop tsup + Web Vite |
| should-inspect | QR reset/stop -> window status projections | Scope changes must not break existing confirmation/enable intent; dialog/hook/IPC |
| invariant-only | Shared Host attachment -> task runtime/CommandInbox | Existing continuous/replayable and workspace isolation boundaries remain owners |
| evidence-only | Client transport mocks and onboarding E2E | Useful regression sources, not proof of production relay authentication |

### Must-Preserve Invariants

One registration/pair per window; opaque payload forwarding; no task/session state in relay; no false delivery ACK; existing Host/Agent reused; local/remote workspace identity guards retained; Desktop continuous and mobile replayable kept separate; no secret data in logs or browser-build configuration.

### Codegraph Evidence

The installed `codegraph` CLI reports this worktree is **not initialized**. No graph index was created and no graph-derived completeness is claimed. Focused source searches traced the following declared seeds to their direct callers and one meaningful semantic neighbor (depth-2 planning scope):

| Seed | Observed path / interpretation |
| --- | --- |
| `WebRemoteControlDialog` | `WorkspaceWebRemoteControlTrigger -> usePlatform -> IPlatformService -> registerWebRemoteControlIpcHandlers` |
| `createWebRemoteControlManager` | Main composition; per-window runtime, QR/reset, single global auth/startup persistence |
| `createWebRemoteControlSharedHostAttachments` | Main/Host attachment boundary; no new Host permitted |
| `bootstrapExternalRelayWebRemoteControl` | Web entry -> terminal transport -> window bootstrap/workspace bridge |
| `resolveWebRemoteControlRelayWsUrl` | Desktop Main and Web entry; custom API origin alone does not select our relay |

### Graph Drift Candidates and Graph Delta

The current feature graph declares remote delivery, the Desktop QR dialog and Host attachments, but no self-hosted relay package or independent window registration owner. These are proposed new nodes, not missing implemented features. Add this spec to the existing remote-delivery capability now; add an implemented relay capability, exact runtime seeds and owner edges only when implementation exists. Do not rename existing remote-delivery or shared-host nodes.

### Domain Scope, Dimensions and Pruning

Include transport/process boundaries, window registration persistence, public admission, and mobile replayable recovery. Conversation/queue/model/provider domains are invariant-only: no new product semantics. Formal Proof currently models conversation compact/fork/goal/queue/edit, so relay state planning stays in this catalog rather than extending that application.

Dimensions: window A/B (including equal workspace path), authenticated role, initial/reconnect/replacement, active/stale/offline peer, valid/expired/replayed challenge, healthy/failing store, normal/oversize/backpressured transport. Prioritize replacement x late-close, two windows x same MID/path, registration x lost ACK, and restart x registration persistence.

Prune multiple concurrent browsers per SID because the user selected replacement. Prune invitations/accounts because the user selected public registration. Prune multi-replica routing, provider cross-products and new Agent instances because the first deployment is one transparent relay. Keep representative local/remote and continuous/replayable isolation cases.

### Clarification Log and Unresolved Questions

2026-10-11: user selected public registration, replacement by a new browser, and simultaneous independent Desktop windows. Pending question: preserve per-window QR identities across application restarts, or expire them with the window/application lifetime. Exact production origins are deployment inputs, not required to implement the transport; use reserved example origins in fixtures.

### Planning Handoff / Matrix Backfill / E2E Notes

This file is the spec, boundary worksheet, stable case catalog and initial coverage matrix. Finalize RELAY-10 and the persistence branch after the QR decision. Before interaction implementation, route accepted two-window/real-relay cases through `e2e-case-lifecycle`; do not treat the existing onboarding test as relay coverage. Use deterministic local Agent/provider fixtures with no paid model calls, real socket barriers, disposable relay DB/keys, and isolated per-window Desktop data. Record UI, socket and Host/process evidence separately. No E2E code or fixtures have been added yet.

## Current verification and remaining gates

Workspace freshness passed: HEAD is 31 commits ahead of `origin/main`, zero behind; it has no tracking branch. Worktree already contained unrelated untracked `specs/command-center-worktrees-themes.md`; preserve it.

`pnpm architecture:check --changed` failed before analysis because `typescript` is missing. `pnpm typecheck` failed because `tsc` is unavailable. `pnpm lint` failed because `oxlint` is unavailable. The worktree has no `node_modules`; `mise` is not installed and the available Node is 24.16.0 rather than pinned 24.14.0. These are environment limitations, not passing checks or evidence of source defects. No tests, builds, container, native/browser interaction or production relay checks were run.

Document checks passed: all 16 acceptance IDs are unique, the three local Markdown links resolve, code fences balance, and there is no trailing whitespace. Feature graph YAML parsed with 374 unique node IDs and a valid new spec reference. Full graph edge validation found two unresolved endpoints (`persistence.desktop-user-data-root`, `capability.mcp-oauth-authorization`), both also present in HEAD; this change adds no unresolved endpoints and changes no node definitions or edges. `git diff --check` passed for tracked changes. A cold-reader pass clarified registration storage, production configuration, startup-intent isolation and activation of the fork-specific window policy. Codegraph source-seed validation remains unavailable without a worktree index.

Before implementation: resolve the QR-lifetime gate; obtain approval for new package runtime dependencies; make the pinned toolchain/dependency closure available. Before publication: provide real acceptance evidence, measured resource limits and approved deployment origins/infrastructure.

## Source map and upstream references

- `packages/shared/src/web-remote-control.ts`: current envelope, roles, error codes and QR parameters; `web-remote-control-heartbeat.ts` and `web-remote-control-rpc-transport.ts`: heartbeat/size/ACK boundaries.
- `packages/desktop/src/main/webRemoteControlManager.ts`, `webRemoteControlRelayAuthStorageProvider.ts`, `desktopWebRemoteControlIpc.ts`, `desktopWindowLifecycle.ts`, `index.ts`: current Main/Host/window and storage wiring.
- `packages/shared/src/protocol.ts`, `validationAppSettings.ts`: existing app-wide registration and last-enabled setting shapes.
- `packages/ui/src/WebRemoteControlDialog.tsx`, `WorkspaceWebRemoteControlTrigger.tsx`, `hooks/useWebRemoteControlStatus.ts`; `packages/web/src/main.tsx`, `webRemoteControlTransport.ts`: current user entry paths.
- `pnpm-workspace.yaml`, `architecture-policy.yaml`, `vitest.config.ts`, root `package.json`, `packages/desktop/tsup.config.ts`, `packages/web/vite.config.ts`, `scripts/build-time-config.mjs`, `scripts/build-zcode.mjs`, `.github/workflows/pr-checks.yml`, `.github/workflows/fork-release.yml`: integration and artifact boundaries.
- [Current remote architecture](../docs/web-remote-control/web-remote-control-architecture.md), [realtime ownership](../docs/web-remote-control/task-realtime-sync.md), [managed module contract](../.agents/skills/architecture-governance/references/module-contract.md).
- [ws 8.20 API](https://github.com/websockets/ws/blob/8.20.0/doc/ws.md), [Node 24.14 SQLite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html), [nginx WebSocket proxy](https://nginx.org/en/docs/http/websocket.html).
