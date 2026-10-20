# Relay V2 migration (web remote control)

Status: DRAFT, awaiting user review on the decisions in section 5. No implementation has started.
Base: `origin/integration` (`cccf1977`, upstream 3.16.1 merged via PR #228).
Upstream reference: `0a1fc56d`. Upstream protocol reference: `docs/web-remote-control/relay-v2-pairing.md`
(contract taken from zcode-server `origin/staging` `5a947cae`: `docs/remote-relay.md`,
`internal/domain/relay_v2/*`, `internal/interfaces/web/{dto,controller}/remote_v2.go`).

User decision (final): migrate the web remote relay to V2. No dual stack.

## 1. Product rules

- The desktop device and the mobile terminal speak only V2. V1 code paths are removed, not hidden behind a flag.
- Mobile terminals sign in with the same account as the desktop (JWT from the account login). Pairing is
  per account. A QR code carries only routing hints (`sid`, `mid`, `name`, `app_version`), never a
  credential. Old QR links with `hash` or `t` are rejected.
- The relay (and Main) only authenticate, pair, heartbeat, forward `data` frames, and schedule
  attachments. The relay owns device records, unconsumed tokens, connections and the
  `(SID, role)` current owner. It holds no task, workspace, stream, snapshot or queue state.
- `desktop-continuous` (desktop real-time link) and `web-remote-replayable` (mobile recovery link)
  keep their owner, snapshot and gap-recovery boundaries. Any change to stream, snapshot, queue or
  reconnect must verify both.
- Fork-only behavior survives: OAuth callback page (`specs/oauth-callback-page.md`), self-hosted
  conversation share, bots `/remote`, deep links, English copy and comments.

## 2. Inventory of V1 (what is in the fork tree today)

Server (fork self-hosted relay, Node, V1 protocol):

- `packages/remote-relay/**` (25 files): `src/contract.ts` (V1 `RelayServerOptions`, `RelayCrypto.verify`
  with HMAC proof, `RelayDeviceStore` with `mid`/`key`), `src/app/relay.ts`, `src/adapters/*`
  (auth, config, deviceStore, nodeServer), `src/domain/connectionState.ts`, tests `relay.test.ts`,
  `clientCompatibility.test.ts`, `deviceStore.test.ts`, `sendPressure.test.ts`, `bundleSmoke.mjs`.
- Protocol package `remote-relay-protocol` (architecture module, see `architecture-policy.yaml`).

Shared (`packages/shared`):

- `src/web-remote-control-heartbeat.ts` (V1 heartbeat constants).
- V1 proof vectors and message types (to be deleted by the upstream shared change).
- `src/zcodeEndpoint.ts` (fork restored V1 values: `ws://…/ws` default, `/web-remote/callback`).
- Tests asserting V1 endpoints/proofs (`packages/shared/test/*`).

Desktop (`packages/desktop`):

- `src/main/webRemoteControlRelayAuthProvider.ts`, `webRemoteControlRelayAuthStorageProvider.ts`
  (V1 pass-hash / nonce storage), `webRemoteControlTransport.ts` (V1 WS framing),
  `webRemoteControlWorkspaceOpen.ts`, plus the Main wiring in `src/main/index.ts`.
- Tests: `webRemoteControlRelayAuthProvider.test.ts`, `…StorageProvider.test.ts`,
  `webRemoteControlWorkspaceOpen.test.ts`, `webRemoteControlManagerExternalRelay.test.ts`.
- e2e: four upstream-only relay-v2 files excluded in `packages/desktop/tsconfig.e2e.json`
  (`TEMPORARY(relay-decision)`).

Web (`packages/web`):

- Flat V1 files: `src/webRemoteControlRelayAuthProvider.ts`, `webRemoteControlTransport.ts`,
  `webRemoteControlWorkspaceOpen.ts`, `webRemoteControlWorkspaceBridgeSession.ts`, `webRemoteControlDeviceInfo.ts`, `webRemoteControlLifecycle.ts`, `webRemoteControlRoute.ts`, `webRemoteControlTaskRead.ts`, `webRemoteControlThemeSeed.ts`, `webRemoteControlVersion*.tsx|ts`, `webRemoteControlFailureScreen.tsx`.
- Login/OAuth callback: `/web-remote/callback` route (V1).
- Upstream v2 layout (not yet in fork): `src/web-remote-control/**` (adapters, app, domain, ui, contracts, `CONTRACT.md`), and `/remote/v4` callback.

Other packages touched by relay UI: `packages/ui` (`WebRemoteControlTaskIndexRow.tsx`,
`lib/webRemoteControlMobileTaskHome.ts`, `lib/webRemoteControlTaskIndex.ts`, `lib/webRemoteControlTaskSync.ts`) and `packages/client` (`webRemoteControlRelayProtocol.ts`, acknowledged relay batch queue). These are V1-shaped and are in the upstream UI merge scope (`specs/ui-upstream-sync*.md`); the relay part of them must follow this migration.

Docs: `docs/web-remote-control/self-hosted-remote-relay.md` (fork, V1 deployment), `docs/web-remote-control/relay-v2-pairing.md` (upstream V2 contract, present in the fork tree), `docs/issues/web-remote-control-relay-v2/01..07*.md` (upstream issue set).

Counts: `grep -rln "webRemoteControl|web-remote" packages/*/src packages/*/test` = 225 files on the fork side (includes non-relay UI); the 86 relay-deferred web paths are in `specs/upstream-sync-final-ledger.md`.

## 3. What V2 requires (client contract, derived from the repo)

The V2 contract is fully specified in `docs/web-remote-control/relay-v2-pairing.md`. Summary:

HTTP (`Authorization: Bearer <jwt>`, envelope `{code, msg, data}`, `code === 0` success):

- `POST /api/v1/remote/device` `{device_mid}` → device record (`device_sid`, `device_mid`, `online`, `created_at`, `meta`). Each register yields a new SID for the same MID.
- `GET /api/v1/remote/device` → device array (per user).
- `POST /api/v1/remote/device/delete` `{device_sid}`: only own offline devices. Unknown SID is idempotent success. Other account's device: HTTP 200 `code 1006`. Online device: HTTP 400 `code 3005`. Bad params: HTTP 400 `code 3001`.
- `POST /api/v1/remote/token` `{role: device|terminal}` → `{token, expires_in}`. Token is 16 random bytes, 22 Base64URL chars, bound to user and role (not SID), `Cache-Control: no-store`, valid 60 s, consumed atomically at WS upgrade, not restored on failure.

WebSocket `/api/v1/remote/ws2?token=…` (optional gateway hint `mid`). Missing/invalid/expired/duplicate token → 401 before upgrade. JSON text only, max 1 MiB.

- client→relay: `auth_init {device_sid, meta?, client_ts?}`, `pair_status_query {client_ts?}`, `data {payload, client_ts?}`.
- relay→client: `auth_ack {device_sid, terminal_sid, pair_status, server_ts?}`, `pair_status_ack`, `data {payload, server_ts?}`, `error {code, message?, server_ts?}`.
- Error codes: `AUTH_FAILED | WRONG_PARAM | KICKED | INTERNAL | DEVICE_OFFLINE`. Pair status: `waiting | matched`.
- Heartbeat: 5000 ms ±1000 ms jitter, ACK deadline 15000 ms.

Known protocol gaps (from the same doc, section 7): `KICKED` is ambiguous (replacement vs owner loss); a stale `/remote/v4` page from an older app_version stays on V1 and cannot be corrected automatically.

## 4. Sequence (target)

```mermaid
sequenceDiagram
    participant D as Desktop device
    participant R as Relay (sole owner of device/token/connection)
    participant T as Mobile terminal (same account JWT)
    D->>R: POST /device (JWT) -> device_sid
    D->>R: POST /token role=device (JWT) -> token (60 s)
    D->>R: WS ws2?token -> token consumed
    D->>R: auth_init(device_sid, meta)
    R-->>D: auth_ack(pair_status=waiting)
    T->>R: POST /token role=terminal (JWT) -> token
    T->>R: WS ws2?token -> token consumed
    T->>R: auth_init(device_sid)
    R-->>T: auth_ack(terminal_sid, pair_status=matched)
    R-->>D: pair_status_ack(matched)
    loop heartbeat every 5 s ±1 s, ACK deadline 15 s
        D->>R: pair_status_query(client_ts)
        R-->>D: pair_status_ack(server_ts)
    end
    T->>R: data(payload) -> R: data(payload) to D only (same SID, other role)
    Note over D,R: Desktop disconnect: terminal gets DEVICE_OFFLINE and closes
    Note over T,R: Terminal disconnect: device gets pair_status waiting
    Note over R: New connection of same (SID, role) validates owner, sends KICKED to old, closes old; old close must not remove new owner
```

Reconnect: tokens are never reused. Every reconnect requests a new token (60 s window) before WS upgrade.

## 5. Decisions the user must make before implementation

1. Server ownership. The V2 server is `zcode-server` (Go, external repo). It is NOT in this tree.
   The upstream 0a1fc56d tree contains no relay server. `packages/remote-relay` is the fork's own
   Node V1 server. Option (c) in the design note (implement the V2 API in `packages/remote-relay`) is
   the only one consistent with "the fork's self-hosted relay keeps working". This requires:
   - JWT verification for the device and terminal login. The V2 API is authenticated by an account
     JWT from the BigModel/ZAI account service. The self-hosted relay has no account system today.
     Unknown: which issuer, signing key or JWKS the self-hosted server should trust, or whether
     self-hosted deployments must run against zcode-server V2 instead.
   - Gateway routing hint `mid` and the 401-before-upgrade rule.
2. Endpoint for fork releases. Shared `zcodeEndpoint` currently ships V1 values (`ws://…/ws`,
   `/web-remote/callback`). Upstream uses `wss://…/api/v1/remote/ws2` and `/remote/v4`. The question
   "which host do fork releases use (`wss://zcode.z.ai/ws` was the open item)" is unresolved. Proposal:
   make the relay base URL configurable from the fork release config (`zcodeEndpoint` override plus
   a build-time default), default to the zcode-server host that the fork release actually deploys to.
3. Rollout / re-pair. V1-paired devices hold no V2 device record. Proposal: all paired devices must
   re-pair after upgrade. QR links from before the upgrade are rejected (`hash`/`t` present). Old
   `/remote/v4` or `/web-remote` pages keep the V1 page until the gateway is updated (documented
   limitation).
4. OAuth. Mobile login needs the BigModel OAuth redirect `…/remote/v4` registered. Whether the fork's
   `/web-remote/callback` is still accepted by the OAuth provider is unverified. This is an external dependency (section 6).

## 6. External dependencies (from `relay-v2-pairing.md`, section "外部依赖与发布顺序")

Production gates, all owned outside this repo:

- zcode-server prod deploys V2 HTTP/WS. Acceptance: token without JWT returns 401; valid account registers a device and pairs with a one-time token.
- Gateway routes `/api/v1/remote/ws2` exactly, and the same MID lands on the same instance.
- Gateway serves `/remote/v4` per `app_version`, release manifest is JSON.
- OAuth whitelist for the `/remote/v4` callback.
  Release order: prod server V2, gateway WS and OSS rules, OAuth whitelist, mobile page version directory, then same-version desktop app.

## 7. Implementation slices (proposed, not started)

Each slice must be green alone (typecheck, lint, architecture, tests) and ledgered.

- S0 (this PR): spec only.
- S1 shared: take upstream `packages/shared/src/web-remote-relay/**` (contract, heartbeat domain/adapters, retry) and the `testing/fake-relay-v2` fixture; delete V1 proof vectors and `web-remote-control-heartbeat.ts`; make `zcodeEndpoint` configurable per section 5.2. Test: `packages/shared/test/webRemoteControlRelayV2*.test.ts`, `fakeRelayV2.test.ts`.
- S2 desktop: `main/web-remote-relay/` (device storage, V2 HTTP, transport, auth gate), replace V1 auth providers; wire in `main/index.ts`; re-enable the 12 `webAuthService` skips; remove the e2e exclusion in `tsconfig.e2e.json`.
- S3 web: `src/web-remote-control/**` (V2 transport, token fetch, device list, switch account, QR), keep the OAuth callback page and English copy; update `packages/ui` and `packages/client` relay bits.
- S4 server: `packages/remote-relay` V2 implementation (only after section 5.1 is decided), with V2 contract tests.
- S5 e2e and docs: re-enable four e2e tests (or delete with ledger reason), update `self-hosted-remote-relay.md`, architecture policy modules for `web-remote-relay` / `web-remote-control` (upstream has them; fork dropped them).

Forbidden in all slices: `it.skip`, deleting tests without a ledger reason, weakening assertions,
editing `scripts/check-test-copy.mjs`.

## 8. Open unknowns (cannot be determined from this repo)

- Whether the self-hosted relay must accept zcode-server JWTs, and from which issuer/key set (5.1).
- Which production host and path fork releases target (5.2).
- Whether `KICKED` ambiguity needs a new error code from the server (relay-v2-pairing.md section 7).
- Whether upstream's Go server returns any additional fields the client must read (the contract ignores unknown response fields, so this is non-blocking).

## 9. Verification (for the implementation PRs)

`pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --full`, `node scripts/check-test-copy.mjs`,
`pnpm fmt:check`, and vitest for `packages/shared`, `packages/desktop/test` (excluding e2e),
`packages/web/test`, `packages/remote-relay` tests. Report real results only.

## 10. Owner decisions (final, supersede section 5)

1. Server and JWT. `packages/remote-relay` is the V2 server. It issues and validates its OWN account and
   device JWTs. The fork owns the key set: signing keys or a JWKS come from environment config
   (`ZCODE_REMOTE_RELAY_JWT_*`, exact names fixed in the S4 PR), with a documented rotation story
   (multiple active `kid`s, old key removed after max token lifetime). There is no dependency on the
   ZAI/BigModel account service and none on zcode-server. Mobile login keeps the fork's existing
   identity flow (`specs/oauth-callback-page.md`); the relay exchanges that identity for relay JWTs.
   Trust boundary: the relay trusts only tokens it signed; the OAuth identity is verified once at
   login, then the relay JWT is the only credential used on `/api/v1/remote/*` and `ws2`.
2. Endpoint. Relay base URL comes from environment/release config, never a hardcoded production host.
   Env var: `ZCODE_REMOTE_RELAY_URL` (WebSocket base, e.g. `wss://relay.example.com`), read through the
   existing runtime env helper (`packages/shared/src/runtimeEnv.ts`, `readRuntimeEnvValue`). Dev default:
   the self-hosted relay on `ws://127.0.0.1:<port>` (fork default). Shared endpoint builders read this
   base and append `/api/v1/remote/ws2` and the HTTP paths.
3. Re-pair. All paired devices must re-pair after upgrade. The app shows an explicit "needs re-pair"
   state (not a silent failure) when a stored device is unknown to the relay or the relay returns
   `AUTH_FAILED`/401 for a stored SID.
4. OAuth redirect. The fork handles `/remote/v4` for the login callback (client route and relay
   callback). `/web-remote/callback` stays only if it is cheap to keep. The PR body lists the exact
   redirect URI(s) the owner must register in the OAuth app.

Compatibility: the desktop and web clients must remain compatible with upstream's V2 client contract
(`packages/shared/src/web-remote-relay/**`) so they can talk to either server.

## 11. Refinements (supersede 10.1 and 10.2 where they differ)

### 11.1 Relay host config (existing variable, no new name)

- The variable is the existing `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`, set in
  `.github/workflows/fork-release.yml` (`vars.*`, build time), read at runtime by
  `packages/shared/src/env.ts` (`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL_DEFAULT`) and
  `packages/desktop/src/main/index.ts`, and for web as `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`.
- Semantics change: the value is a relay ORIGIN (`https://host` or `wss://host`; a path is stripped).
  A legacy `wss://host/ws` value is normalized to its origin with a logged warning. Release notes must say so.
- Derived from the origin, never separately configured:
  HTTP `${origin}/api/v1/remote/{device,device/delete,token}`,
  WS `${wsOrigin}/api/v1/remote/ws2?token=…`,
  OAuth callback `${endpointOrigin}/remote/v4`.
- Fallback when unset: the zcode endpoint origin (upstream behavior). No hardcoded production relay host.

### 11.2 Bearer for relay HTTP (the JWT seam)

- Upstream's client already takes the bearer as a parameter (`register(deviceMid, jwt, signal)`).
  That signature is kept byte-identical, so the wire matches upstream.
- The caller supplies a relay JWT from a `RelayBearerProvider` (desktop Main and web), which is the only
  new seam. The provider obtains the JWT by exchanging the account identity.
- Exchange endpoint (self-hosted relay): `POST ${origin}/api/v1/remote/session`, body
  `{identity_token: string}`, response `{code: 0, msg, data: {jwt, expires_in}}`. The relay verifies the
  identity token once against the configured identity provider (issuer and JWKS from env, fork-owned
  config), then signs its own JWT with a fork-owned key (`kid`, rotation per 8.1).
- Trust boundary: the identity provider is trusted only at the exchange. Relay JWTs are the only
  credential for `/api/v1/remote/*` and `ws2`. Relay JWTs never go into QR codes or business messages.
- OPEN (owner to confirm): which identity provider is "the fork's existing identity" for mobile login
  (the desktop login session, or the OAuth provider used by `/remote/v4`). Until confirmed, the exchange
  accepts an identity token from the configured issuer only.

### 11.3 Staging (advisor review)

- PR1 (shared): add V2 exports next to V1 (`WebRemoteControlRelayV2*` names do not collide). Add
  `adapters/` and `domain/`, fill `./testing/fake-relay-v2`, add V2 tests. V1 kept. Architecture policy entries for the new subdirectories.
- PR2 (desktop + web + endpoint builders): switch to V2, remove V1 transport and auth providers,
  add the re-pair state. `zcodeEndpoint.test.ts` change is ledgered as an intentional behavior change.
- PR3 (server + e2e): `packages/remote-relay` V2, remove the `tsconfig.e2e.json` exclusion, re-enable
  the 12 `webAuthService` skips if they depend on the server (check first), delete remaining V1.
- Every upstream comment and test copy is translated to English on import. `check-test-copy.mjs` must pass.

## 12. S2 desktop implementation notes (branch claude/relay-v2-desktop)

Decisions taken while implementing the desktop client. Each one is a deviation or an interpretation of sections 10-11.

1. Main relay code: `packages/desktop/src/main/web-remote-relay/` taken from upstream `0a1fc56d` (contract, device storage, V2 HTTP, WS transport), CJK comments translated. New file `webRemoteControlRelaySession.ts` holds the bearer exchange.
2. Bearer (11.2): `createWebRemoteControlRelayBearer` exchanges the account identity JWT at `POST {relayOrigin}/api/v1/remote/session` (body `{identity_token}`, response `{code:0,data:{jwt,expires_in}}`). The relay JWT is cached per relay origin and identity until 30 s before expiry, concurrent exchanges are shared, `auth-required` drops the cache. The exchange endpoint is owned by the S4 server; it does not exist in upstream zcode-server, so desktop builds that point at upstream zcode-server cannot pair until that endpoint or a passthrough is decided (open, see the PR body).
3. Relay HTTP origin: the origin of the relay WS URL (`wss`→`https`, `ws`→`http`). Previously upstream used the endpoint origin for HTTP. Self-hosted relays configured through `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` therefore receive HTTP and WS on the same origin.
4. Relay URL (11.1): `resolveWebRemoteControlRelayWsUrl` treats the configured value as an origin, drops any path and appends `/api/v1/remote/ws2`. The removed `wss://zcode.z.ai/ws` default and the test-endpoint special case are gone. `buildZCodeEndpointUrls` returns `relayWsUrl` on ws2 and `webRemoteCallbackUrl` on `/remote/v4`.
5. QR (V2): `buildWebRemoteControlExternalQrUrl` no longer takes `passHash`/`timestamp` and removes stale `hash`/`t` from the base URL. The parser `parseWebRemoteControlExternalQrParams` is unchanged here; packages/web still uses the V1 parser until S3 lands.
6. Re-pair (10.3): `deviceStorage.clearLegacy()` resolves to `true` when pre-V2 pairing material was found. The manager then sets `repairRequired` on the status. The dialog shows `webRemoteControl.failure.repairRequired` (en-US, uk-UA, zh-CN). The flag clears only when a phone pairs. It is not persisted, so a later restart that finds no legacy data drops the notice; the QR still works.
7. Refresh QR (fork feature `ResetWebRemoteControlPairing`): `resetPairing` closes the runtime and calls `start` with `forceRegistration`, which deletes the stored device and registers a new SID. The channel was missing from `packages/shared/src/channels.ts` on the base branch and is restored.
8. Bots `/remote` (fork feature): `findLinkForWorkspace` returns the current connect URL from a live runtime that is QR-ready (`qrUrl` set) and bridgeable for the workspace. Its V2 URL carries `sid` and routing hints only.
9. Fork workspace-open (`workspace-open-request` → `openWorkspace`) is kept as it was on the fork.
10. Task-list sync (`syncWebRemoteControlTasks`, bootstrap `tasks`) is removed. Upstream V2 replaced it with the mobile task view. The bootstrap result returns `tasks: []` so older phone clients still parse it. The renderer never called the desktop task sync, so no caller was broken.
11. Shared additions (additive, needed by upstream's manager): mobile task view payload types and union members, `WebRemoteControlWindowBootstrapResult.mobileTaskViewEpoch`, bridge-open `project`/`taskHostId`/`fileTreeTaskId`, external remote bridge `capabilities`, bridge-degraded reason `source-session-replaced`, nullable status `mobileTaskView`, and `WebRemoteControlStatus.repairRequired`. No V1 type was removed, because packages/web and the fork server still compile against them until S3/S4.
12. e2e: the `tsconfig.e2e.json` exclusion is removed. The four relay-v2 files compile after the shared additions and the upstream `web-remote-control-session-events-fixture` helper and its fixture JSON were copied in. Their scenarios are not run here (e2e needs a built Electron app).
13. Not ported: upstream `webRemoteControlAuthGateFixture.test.ts` (imports the upstream auth-gate e2e helper; that flow belongs to the web client slice S3).

Verification on this branch (see the PR body for the exact outputs): `pnpm typecheck` 0, `pnpm lint` 0 errors, `architecture:check --full` 0 violations, `check-test-copy` passes, `fmt:check` passes, desktop unit tests (excluding e2e) 367 files passed. `tsconfig.main.json` still reports pre-existing errors in autoUpdater, desktopDictationSystemAudio, resourceManagerStorage and the bot reconnect wiring in index.ts. Those areas are not touched by this change and the main project is not in the typecheck gate.

## 13. S3 web client (branch `claude/relay-v2-web`)

Status: implemented on this branch; desktop (`claude/relay-v2-desktop`) and server (`claude/relay-v2-server`) are separate PRs.

- The web remote control client is upstream's V2 tree `packages/web/src/web-remote-control/**`
  (entry, device list, switch account, V2 token exchange, `ws2` transport, bridge recovery). The
  V1 flat modules `webRemoteControl{RelayAuthProvider,Transport,WorkspaceBridgeSession}.ts` and their
  tests are removed. Fork modules kept: `webRemoteControlWorkspaceOpen.ts` (`docs/specs/web-remote-workspace-open.md`),
  now driven by a V2 `workspace-open-request` over the relay.
- Relay origin: `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` (web: `VITE_` variant) is an origin; the path
  `/api/v1/remote/ws2` is derived in `resolveWebRemoteControlRelayWsUrl`. Unset falls back to the
  endpoint origin. No production host is hardcoded in the web client.
- Bearer seam: `getToken` and `token(jwt)` are injected by `WebRemoteControlEntry` from the logged-in
  account (`webAuthService.getZCodeJwtToken()`). Relay JWTs are never placed in URLs or payloads.
- Login callback: `webRemoteCallbackUrl` is `${origin}/remote/v4`. The fork's `/web-remote/callback`
  route is dropped; the OAuth whitelist must register `/remote/v4` (owner action, listed in the PR).
- Re-pair: QR links carrying the V1 `hash`/`t` credential show the re-pair notice (en-US, uk-UA;
  `domain/webRemoteControlRepairNotice.ts`) instead of a generic failure. A stored device the relay no
  longer knows (`AUTH_FAILED`) is reported by the device-side transport as before.
- QR contract (shared): `buildWebRemoteControlExternalQrUrl` emits only `sid`, `mid`, `name`,
  `app_version` and strips `hash`/`t`; `parseWebRemoteControlExternalQrParams` returns V2 hints or null
  for legacy credentials.
- Deferred to later PRs (not in S2): the desktop-side mobile task view publisher and the relay
  `KICKED` ambiguity (`docs/web-remote-control/relay-v2-pairing.md` section 7).
