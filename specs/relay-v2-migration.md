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

## 14. S4 server: self-hosted relay V2 (`packages/remote-relay`)

Status: implemented in PR "feat(relay): self-hosted relay v2 server (own JWT issuer)" (branch
`claude/relay-v2-server-final`). Sections 10 and 11 remain the owner decisions; this section fixes the
server details they leave open. Client slices (desktop, web) consume the wire contract below.

### 12.1 Login identity and the trust boundary

What the clients hold today (verified in code, not assumed):

- The desktop and web login session carries a backend JWT under the credential key
  `zcodejwttoken` (`packages/services/src/oauth/oauthService.ts`,
  `packages/web/src/auth/browserOAuthCredentialRepo.ts`). The fork reads only its `exp` claim locally
  (`resolveJwtExpiration` in `packages/shared/src/oauth.ts`); no signature is checked anywhere in this tree.
- V1 relay auth did not use the login identity. It used a per-device `pass_hash` secret.

Decision for the exchange input (`identity_token`):

- The input is the existing login JWT (`zcodejwttoken`). It is the only identity the owner already has on
  desktop and mobile, so no new login flow is introduced.
- The relay verifies it locally, with no network call at runtime. Verification uses a public JWK set and
  an issuer string from environment configuration (section 12.4). The relay never calls the account
  service, zcode-server or any OAuth endpoint.
- Accepted algorithms: `EdDSA` (Ed25519), `ES256`, `RS256`. `none` and HMAC algorithms are rejected, so no
  shared secret with the account service is needed.
- Required claims: `exp` (not expired, 30 s clock skew), `iss` equal to the configured issuer, and a
  non-empty user claim (default `sub`). `aud` is checked only when configured.
- The `kid` header selects the key from the JWK set. A token without `kid` is accepted only when the set
  holds exactly one key.

Open and external (owner): the issuer string, the public JWK set and the user claim of the production
`zcodejwttoken` are not in this repository. The relay refuses to start without them (fail closed). This PR
asserts nothing about whether production tokens verify; tests use an issuer the test creates.

Rejected alternative: a desktop-minted HMAC or Ed25519 assertion signed with a per-device key pair. The
desktop would choose its own account identity: the relay could check that the desktop holds its key, but
not which account it belongs to. Mobile would also need that key pair, which the login session does not carry.

Trust boundary (explicit):

1. The account identity is trusted only at `POST /api/v1/remote/session`, and only through the configured
   public key set.
2. After the exchange, the relay JWT is the only credential for `/api/v1/remote/*`. The one-time WS token is
   minted from it. The login JWT is never sent to `ws2`, never placed in a QR code and never logged.
3. The relay trusts only tokens it signed itself (section 12.2).

### 12.2 Relay JWT (fork-owned issuer)

- Signed with EdDSA (Ed25519). Header: `alg: EdDSA`, `typ: JWT`, `kid`.
- Claims: `iss = "zcode-remote-relay"`, `aud = "zcode-remote-relay"`, `sub` = user id from the identity
  token, `iat`, `exp = iat + ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS` (default 3600, maximum 86400).
- Signing keys are private Ed25519 JWKs in `ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS` (JSON array). The first
  entry signs new tokens; every entry verifies. A `kid` not in the array is rejected.
- Rotation: prepend the new key and restart. Keep the old key in the array for at least one TTL, then
  remove it. The private keys live in memory only. Multi-replica deployments need the same array on every
  replica; this PR is single-replica.
- Expired or invalid relay JWTs return HTTP 401 before any handler runs.

### 12.3 HTTP and WebSocket contract (server side)

HTTP responses use the envelope `{code, msg, data?}`; `code: 0` is success. Every response carries
`Cache-Control: no-store`. Unknown routes return 404.

| Route                               | Auth                       | Success                              | Failure (HTTP / envelope `code`)                                                                          |
| ----------------------------------- | -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| POST `/api/v1/remote/session`       | none (identity token body) | `{jwt, expires_in}`                  | 400/3001 bad body; 401/401 identity invalid, expired or untrusted; 429/4029 rate limit                    |
| POST `/api/v1/remote/device`        | relay JWT                  | device record (new SID every call)   | 400/3001 bad body; 401/401                                                                                |
| GET `/api/v1/remote/device`         | relay JWT                  | array of the caller's device records | 401/401                                                                                                   |
| POST `/api/v1/remote/device/delete` | relay JWT                  | `null`; unknown SID is idempotent    | 400/3001; 200/1006 other account's device; 400/3005 device online; 401/401                                |
| POST `/api/v1/remote/token`         | relay JWT                  | `{token, expires_in: 60}`            | 400/3001; 401/401; 429/4029 too many outstanding tokens for this user                                     |
| WS `/api/v1/remote/ws2?token=`      | one-time token             | upgrade                              | 401 before upgrade for missing, unknown, expired or reused token; 400 wrong path; 503 closing or capacity |

Device record: `{device_sid, device_mid, online, created_at, meta}`. `meta` (`name`, `platform`, `version`)
comes from the device's `auth_init` and is `{}` when offline. The relay keeps nothing else about a device.

Token: 16 random bytes, Base64URL without padding (22 characters), bound to user and role (not SID), valid
60 s, consumed atomically at upgrade. A failed upgrade does not restore it. Tokens live in memory; a restart
invalidates them, which is safe because clients re-request.

WebSocket messages follow the shared V2 schemas (`parseWebRemoteControlRelayV2OutgoingMessage`). Text frames
only, 1 MiB maximum. Error codes are exactly `AUTH_FAILED | WRONG_PARAM | KICKED | INTERNAL | DEVICE_OFFLINE`:

- `AUTH_FAILED`: unknown or foreign device SID in `auth_init`, or traffic before auth. Connection closed.
- `WRONG_PARAM`: invalid frame, binary frame, second `auth_init`, or `pair_status_query` before auth.
  Connection closed.
- `KICKED`: a newer connection took the same `(SID, role)` slot. Sent only to the replaced socket, which is
  then closed. The relay cannot tell this apart from owner loss; see `relay-v2-pairing.md` section 7.
- `DEVICE_OFFLINE`: sent to the terminal when its device disconnects; the terminal is closed.
- `INTERNAL`: `data` with no authenticated peer. Connection stays open.

Time: `server_ts` is Unix seconds, always set by the relay. Client timestamps are accepted and ignored for
authorization.

Liveness: an unauthenticated socket is closed after 15 s without a successful `auth_init`
(`ZCODE_REMOTE_RELAY_AUTH_TIMEOUT_MS`, default 15000, matching the client handshake deadline). Transport
ping every 15 s, closed after 45 s without pong. The client heartbeat (`pair_status_query`, 5 s ±1 s, 15 s ACK)
is application level and is answered by the relay with `pair_status_ack`.

### 12.4 Environment variables (server)

Kept from V1: `ZCODE_RELAY_HOST`, `ZCODE_RELAY_PORT`, `ZCODE_RELAY_ALLOWED_ORIGINS`,
`ZCODE_RELAY_TRUSTED_PROXIES`, `ZCODE_RELAY_MAX_CONNECTIONS`, `ZCODE_RELAY_REGISTRATIONS_PER_MINUTE` (also
applied per source IP to `/session`), `ZCODE_RELAY_MAX_BUFFERED_BYTES`, `ZCODE_RELAY_MAX_TOTAL_BUFFERED_BYTES`,
`ZCODE_RELAY_DB_PATH`, `ZCODE_RELAY_MAX_REGISTRATIONS`.

Removed: `ZCODE_RELAY_STORAGE_KEY` (V2 device records hold no secret, so nothing is encrypted).

New:

| Variable                                 | Required | Meaning                                                                                        |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS`    | yes      | JSON array of private Ed25519 JWKs (`kty: OKP`, `crv: Ed25519`, `kid`, `d`, `x`). First signs. |
| `ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS`     | no       | Default 3600, maximum 86400.                                                                   |
| `ZCODE_REMOTE_RELAY_IDENTITY_ISSUER`     | yes      | Exact `iss` value of the login JWT.                                                            |
| `ZCODE_REMOTE_RELAY_IDENTITY_JWKS`       | yes      | JSON JWK set of public keys (EdDSA, ES256, RS256). No network fetch.                           |
| `ZCODE_REMOTE_RELAY_IDENTITY_AUDIENCE`   | no       | `aud` the login JWT must carry, when set.                                                      |
| `ZCODE_REMOTE_RELAY_IDENTITY_USER_CLAIM` | no       | Default `sub`.                                                                                 |
| `ZCODE_REMOTE_RELAY_AUTH_TIMEOUT_MS`     | no       | Default 15000.                                                                                 |

Missing or malformed required values stop startup with a message that names the variable, never its value.

### 12.5 Event order (server side)

Owners: the relay registry (`app/relay.ts`) owns connections and the `(SID, role)` slot; the token store owns
unconsumed tokens; the device store owns device records. Nothing else.

```mermaid
sequenceDiagram
    participant C as Client (desktop or terminal)
    participant H as HTTP API (app/http)
    participant T as Token store
    participant R as Registry (SID, role owner)
    participant S as Device store
    C->>H: POST /session {identity_token}
    H-->>C: relay JWT (EdDSA, TTL)
    C->>H: POST /device {device_mid} (Bearer)
    H->>S: insert record (new SID)
    H-->>C: device record
    C->>H: POST /token {role} (Bearer)
    H->>T: issue token (user, role, 60 s)
    H-->>C: token
    C->>R: WS /ws2?token (upgrade)
    R->>T: consume token (atomic, once)
    R-->>C: 401 before upgrade if missing, expired or reused
    C->>R: auth_init {device_sid}
    R->>S: look up SID owner
    alt unknown or foreign SID
        R-->>C: error AUTH_FAILED, close
    else device role
        R->>R: replace device slot; KICKED to old socket
        R-->>C: auth_ack (waiting, or matched if terminal present)
    else terminal role
        R->>R: replace terminal slot; KICKED to old socket
        R-->>C: auth_ack (terminal_sid, matched if device present)
    end
    loop application heartbeat
        C->>R: pair_status_query
        R-->>C: pair_status_ack
    end
    C->>R: data {payload}
    R-->>C: data {payload, server_ts} to the other role of the same SID only
    Note over R: Device socket closes: terminal gets pair_status_ack waiting, DEVICE_OFFLINE, then close.
    Note over R: Terminal socket closes: device gets pair_status_ack waiting.
    Note over R: A stale close removes the slot only if it still points to that exact connection.
```

Connection states: `pending` (token consumed, no `auth_init` yet) to `authenticated` (slot owned). Any other
transition closes the socket. Reconnection always starts from a new token.

### 12.6 Persistence

SQLite (`node:sqlite`, one worker thread, as before). Table `relay_devices(device_sid TEXT PRIMARY KEY,
user_id TEXT NOT NULL, device_mid TEXT NOT NULL, created_at INTEGER NOT NULL)` with indexes on `user_id`
and `(user_id, device_mid)`. Delete removes the row, so the SID stops authenticating. Plaintext at rest by
design, since no secret is stored; the package README requires the file to be readable only by the relay user.

### 12.7 Verification (S3 acceptance)

Unit: JWT sign/verify (algorithm allowlist, `kid`, expiry, issuer, audience, user claim); identity
verification for each accepted algorithm; one-time token rules; device store operations and restart
persistence; HTTP status and envelope rules. Integration (real loopback HTTP and WS, `ws` client): exchange,
register and list, cross-account delete rejection, online delete rejection, token reuse, pairing in both
orders, replacement with KICKED and a late close that must not drop the new owner, DEVICE_OFFLINE, waiting,
invalid frames, and the auth deadline (short value in tests). Every server frame is parsed with the shared
V2 schemas in the tests.

## 15. Identity modes (`ZCODE_REMOTE_RELAY_IDENTITY_MODE`)

Problem: section 12.1 makes the relay depend on a z.ai login JWT and its JWKS. The fork owner does not
operate z.ai, and fork users may have no z.ai login (API-key only). The relay therefore supports two
identity modes, chosen by environment, with identical relay JWT format, routes, `ws2` protocol and device
lifecycle. Only the way a client proves who it is at `POST /api/v1/remote/session` differs.

### 15.1 Modes and selection

| Mode         | Caller proves identity with                                  | Relay user id (`sub`)                     |
| ------------ | ------------------------------------------------------------ | ----------------------------------------- |
| `zai-jwt`    | z.ai login JWT in `{identity_token}` (sections 12.1 to 12.3) | the configured user claim, unchanged      |
| `device-key` | Ed25519 device key plus enrollment secret (15.2)             | `dk:` + base64url(sha256(raw public key)) |

- `ZCODE_REMOTE_RELAY_IDENTITY_MODE` is `zai-jwt` or `device-key`. Unknown values stop startup, naming the variable.
- Unset: `zai-jwt` when `ZCODE_REMOTE_RELAY_IDENTITY_ISSUER` or `_JWKS` is present (the existing per-variable
  errors keep applying); otherwise startup fails closed naming `ZCODE_REMOTE_RELAY_IDENTITY_MODE`. There is
  no silent fallback to an open relay.
- `ISSUER`, `JWKS`, `AUDIENCE`, `USER_CLAIM` are required (ISSUER, JWKS) only in `zai-jwt` mode. In
  `device-key` mode they are ignored and the relay logs one warning that names the variables, never values.
- `device-key` requires `ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET`, at least 32 characters. Missing or short stops
  startup, naming the variable only.
- `zai-jwt` behavior is unchanged. The `dk:` prefix is reserved: `zai-jwt` mode rejects login subjects that
  start with `dk:` and rejects relay JWTs whose `sub` starts with `dk:`; `device-key` mode rejects relay JWTs
  whose `sub` lacks it. Switching modes on one relay (same signing keys) therefore invalidates every
  previously issued relay JWT of the other mode.

### 15.2 `device-key` exchange

Owner of the key pair: the client install. Owner of enrolled public keys: the relay SQLite file, table
`fork_relay_device_keys(public_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT`, created additively
(`CREATE TABLE IF NOT EXISTS`); the existing `relay_devices` table is untouched. Enrolled keys count against
`ZCODE_RELAY_MAX_REGISTRATIONS` separately from devices.

`POST /api/v1/remote/session` body (exact keys, no others):

```json
{
  "device_key": { "public_key": "...", "ts": 1800000000, "nonce": "...", "signature": "..." },
  "enrollment_secret": "..."
}
```

- `public_key`: raw Ed25519 key, base64url, exactly 43 characters. `ts`: integer Unix seconds. `nonce`:
  base64url, 16 to 64 characters. `signature`: Ed25519 over the UTF-8 bytes of
  `zcode-relay-device-session-v1\nzcode-remote-relay\n<public_key>\n<ts>\n<nonce>` (base64url, 86 characters).
  Binding the public key into the signed bytes rejects key substitution.
- `enrollment_secret` is optional and only used for a key the relay has not enrolled.

Relay steps, in order; every failure before the last step changes no state:

1. Strict body parse (a login-JWT body is a 400 in this mode, a device-key body is a 400 in `zai-jwt` mode).
2. `|now - ts| <= 60` seconds, which rejects stale and future requests.
3. Verify the signature (proof of possession).
4. Unknown key: no secret gives 401 / envelope code 4012 ("not enrolled"); a secret is compared in constant
   time (both sides sha256-hashed, then `timingSafeEqual`, so length never short-circuits); a mismatch is the
   same 401/401 as a bad signature.
5. Replay cache `(public_key, nonce)`, kept 120 s. A seen pair is 401. The cache is capped; when full the
   request fails with 503 and nothing is evicted (eviction would let an attacker flush it). It is in memory,
   so a relay restart clears it: a captured request can be replayed within 60 s of its `ts` after a restart.
   Accepted, because the replayed result is a relay JWT for the same key that the attacker could not renew.
6. Enroll the key if unknown (secret already verified), then issue the relay JWT with the derived `sub`.

The shared per-IP limiter (`ZCODE_RELAY_REGISTRATIONS_PER_MINUTE`) already covers `/session`, so enrollment
and secret guessing are rate limited. The secret and signatures never appear in logs, errors or responses.

### 15.3 Pairing the phone without a z.ai login

The phone (`packages/web`) has no key and no z.ai login in `device-key` mode. It joins the Desktop's `dk:`
identity through a short-lived pairing code carried by the QR.

- `POST /api/v1/remote/pairing` (relay JWT, `device-key` mode only; 404 in `zai-jwt` mode) returns
  `{code, expires_in: 300}`. `code` is 16 random bytes, base64url (22 characters, 128 bits).
- The relay keeps only `sha256(code) -> {userId, expiresAt}` in memory, at most 8 unexpired codes per user
  and 10000 overall (429 / 4029 beyond the per-user cap). A restart drops them, which only forces a re-scan.
- `POST /session` accepts `{"pairing_code": "<code>"}` (exact key) in `device-key` mode. A valid unexpired
  code is consumed atomically and yields a relay JWT for the same `dk:` user id, so `device`, `token`
  and `ws2` behave exactly as for the Desktop. Reuse, expiry or an unknown code is 401 / 401. The same per-IP
  limiter applies.
- The phone's relay JWT lasts `ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS` and cannot be renewed with the spent
  code; after expiry the phone re-scans a QR (the Desktop issues a fresh code each time the QR is shown).
- A phone that holds a pairing JWT acts for the Desktop identity (list, register, delete devices) with two
  limits (15.6): `POST /token` refuses role `device` for it (the phone may only take the terminal slot,
  never the Desktop's), and its live terminal sockets are closed when that JWT expires. Treat the QR as a
  credential while it is valid.

QR: `buildWebRemoteControlExternalQrUrl` accepts an optional `pairingCode` and writes it as `pk` in the
URL fragment (`#pk=...`, 15.6), never in the query string, so it does not reach web-host access logs. Absent
option means a URL byte-identical to today's, so `zai-jwt` QR codes stay compatible with upstream.
`parseWebRemoteControlExternalQrParams` returns `pairingCode` only when `pk` is non-empty; a QR is
valid with or without it. The web entry reads `pk` from the fragment (and, for QRs made by older Desktops,
from the query string), removes it from the address bar (`replaceHref`) as soon as it has read it, and never logs it.

### 15.4 Clients

Desktop (owner: `packages/desktop/src/main/web-remote-relay`):

- Mode: `ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE` (`zai-jwt` default, or `device-key`). Never inferred.
  `device-key` also needs `ZCODE_WEB_REMOTE_CONTROL_RELAY_ENROLLMENT_SECRET` (read from env, or from the
  `fork_`-prefixed credential entry when set there); missing secret is reported as `auth-required`.
- Key pair: generated once per install, single-flight, stored through the existing web remote credential
  service under the key `fork_web-remote-control:device-key` (never `setting.json`).
- In `device-key` mode the login gate is replaced by the device identity (user id = derived `dk:` id), so an
  API-key-only user can start remote control. On 4012 the bearer retries once with the secret.
- The relay JWT cache is keyed by `(relayOrigin, user id)`. The QR gets a fresh pairing code from
  `/pairing` each time it is built and every 240 s while shown; the start result waits for the first one,
  and a relay that refuses to issue it fails the start instead of showing a QR the phone cannot use.

Pairing-derived relay JWTs carry the claim `amr: ["pairing"]`; `POST /pairing` refuses them, so a phone
cannot mint codes to renew itself or exhaust the Desktop's per-user cap. The claim is the only addition to
the JWT; `iss`, `aud`, `sub`, `iat`, `exp` and the format are unchanged and clients treat the token as opaque.

Desktop sign-out of a z.ai account does not end a `device-key` session (`accountAuthIndependent`), and the
mode may be baked at build time (`ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE`, runtime env wins) for apps
launched without shell env. The enrollment secret is never baked: it reaches the client only through env or
the `fork_web-remote-control:enrollment-secret` credential entry (no settings UI yet).

Web (owner: `packages/web/src/web-remote-control`): when the URL has `pk` and no z.ai JWT, the entry
exchanges it at `/session`, keeps the relay JWT in memory (not storage), and uses it for the device list
and tokens. With a z.ai JWT present, behavior is unchanged.

### 15.5 Acceptance scenarios

Relay (tests in `packages/remote-relay/test`): valid enrollment then re-login without secret; replayed
nonce; expired and future `ts`; wrong secret with equal and unequal length; unenrolled key without secret
(4012); signature by key B under key A's public key; modified `ts`/`nonce` after signing; login-JWT body
in `device-key` mode and device-key body in `zai-jwt` mode; relay JWT crossing modes in both directions with
the same signing key; replay-cache full; pairing code reuse, expiry, unknown code, per-user cap, `/pairing`
without bearer and in `zai-jwt` mode; startup failures (no mode and no zai variables, unknown mode, missing
and short secret); ignored zai variables warn by name only; secrets absent from responses and logs;
`zai-jwt` suite unchanged. Bundle smoke covers both modes. Client: bearer unit tests for device-key
exchange, 4012 retry, single-flight key generation; shared QR builder/parser tests for `pk`; web entry test for
pairing exchange and address-bar cleanup.

### 15.6 Open enrollment (`ZCODE_REMOTE_RELAY_ENROLLMENT_MODE=open`)

Problem: `device-key` mode needs `ZCODE_REMOTE_RELAY_ENROLLMENT_SECRET`, which cannot ship in a public
release build. Open enrollment lets any install enroll its own key without a shared secret, bounded so one
caller cannot exhaust the relay. A read-only review confirmed cross-user isolation (the user id is derived
from the proven key); this section adds the abuse bounds.

Owners: enrollment decision and PoW verification in `adapters/session.ts` (stateless except the replay cache
and the breaker); per-identity limits in `domain/identityLimits.ts` (in memory, clock injected); persisted key
tier, last-seen and daily bytes in table `fork_relay_identity_usage` plus idle expiry in
`adapters/deviceStoreWorker.ts`; socket admission and close in `adapters/nodeServer.ts`; PoW solving in the
Desktop client (`webRemoteControlDeviceKey.ts`).

**Modes.** `ZCODE_REMOTE_RELAY_ENROLLMENT_MODE` is `secret` (default when unset: exactly 15.1 to 15.2) or
`open`. In `open` the secret is optional; when set (at least 32 characters) it keeps working as the owner path.
Without it, enrollment by secret is denied. Unknown value stops startup naming the variable.

**Tiers.** Every enrolled key has a tier: `owner` (enrolled with the secret, and every key enrolled before this
change, i.e. a missing usage row) or `open` (enrolled by PoW). Owner limits are 4x the open limits. The tier is
carried in the relay JWT claim `tier` (`owner` or `open`) in `device-key` mode only; a `device-key` JWT without
the claim (issued before this change, at most one TTL old) is treated as `open`. `zai-jwt` mode has no tier and
no per-identity limits. A pairing JWT inherits the tier of the JWT that minted its code.

**Body.** `POST /session` accepts exactly one of: `{device_key}`, `{device_key, enrollment_secret}`,
`{device_key, work}`; secret and work together are a 400. `work` is `{challenge, nonce}` (exact keys): the
challenge string the relay issued, and the client's counter as a decimal string of at most 16 digits. The
difficulty is inside the challenge, not a separate client-controlled field.

**Challenge.** `challenge = base64url(issuedAt[8 bytes BE] || difficulty[1] || mac[16])`, with
`mac = HMAC-SHA256(processKey, "zcode-relay-pow-v1" || publicKey || issuedAt || difficulty)[0..16]`.
`processKey` is 32 random bytes per process (no env secret; a restart invalidates outstanding challenges and
the client fetches a new one). The PoW is: `sha256("zcode-relay-pow-v1\n" + publicKey + "\n" + challenge +
"\n" + nonce)` has at least `difficulty` leading zero bits. The byte layout and the leading-zero-bit check
live in `packages/shared` without `node:crypto`; hashing is done by each side.

**Event order (open mode, unenrolled key).**

```text
Desktop                                   Relay (session.ts)                    Store worker
  | POST /session {device_key}              |                                      |
  |---------------------------------------->| shape, |now-ts|<=60, signature      |
  |                                         |------------ lookup(publicKey) ------>|
  |                                         |<-- tier undefined, openKeys ---------|
  |                                         | breaker closed and openKeys < max?   |
  |<-- 401 code 4012 data{challenge,        |   yes: issue challenge               |
  |        difficulty, expires_in:60} ------|   no:  503 code 4503 (no PoW run)    |
  | solve PoW (chunked, yields, abortable)  |                                      |
  | POST /session {device_key (fresh ts),   |                                      |
  |                work{challenge,nonce}}-->| shape, window, signature,            |
  |                                         | challenge mac + age<=60 s + zeros    |
  |                                         | (before any DB call), replay cache   |
  |                                         |--- enroll(key,"open") (one txn: key  |
  |                                         |    row + usage row, cap re-checked)->|
  |<-- 200 {jwt (tier=open)} ---------------|<-------------------------------------|
```

Order of checks for `work`: shape, window, signature, PoW (stateless, no DB), then the DB lookup. An anonymous
flood therefore costs the relay one signature verify and one hash per request and never queues store calls
before the per-IP limiter (15.2) rejects it. A challenge older than 60 seconds or minted by another process is
401 (the client retries once with a new challenge). Replaying a solved request is stopped by the replay cache;
a stolen solution is bound to the same public key, so it can only enroll that key.

**Breaker.** New open enrollments stop (503, code 4503, before any challenge is issued) while either: the
number of `open` keys has reached `ZCODE_RELAY_MAX_ENROLLED_KEYS`; or more than `ZCODE_RELAY_ENROLLMENTS_PER_HOUR`
open enrollments happened in the last hour (default 300; the breaker then stays open until the count falls
below the limit). Existing identities, owner enrollment by secret, `/token`, `/device` and `ws2` are not affected.

**Per-identity limits** (open tier; owner is 4x), keyed by the relay `sub`:

| Limit                 | Variable                                 | Default | Effect when exceeded                   |
| --------------------- | ---------------------------------------- | ------- | -------------------------------------- |
| Live sockets          | `ZCODE_RELAY_MAX_SOCKETS_PER_IDENTITY`   | 8       | upgrade refused, 429                   |
| Inbound bytes per day | `ZCODE_RELAY_BYTES_PER_IDENTITY_PER_DAY` | 512 MiB | socket closed 1013, new tokens refused |
| `POST /token` per min | fixed constant                           | 30      | 429 / 4029                             |
| Registered devices    | fixed constant                           | 8       | 429 / 4029 at `POST /device`           |

Bytes count client-to-relay frames only, in memory, flushed to `fork_relay_identity_usage` on the sweep timer;
the day boundary is UTC; a relay restart resets the in-memory counters (accepted: restarts are operator driven).

**Idle expiry.** `open` keys whose `last_seen` is older than `ZCODE_RELAY_KEY_IDLE_EXPIRY_DAYS` (default 30) are
deleted with their usage row and their `relay_devices` rows in one transaction, hourly. `owner` keys never
expire. A returning client simply enrolls again.

**Table.** `fork_relay_identity_usage(public_key TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, tier TEXT NOT
NULL, last_seen INTEGER NOT NULL, day INTEGER NOT NULL, day_bytes INTEGER NOT NULL) STRICT`, created with
`CREATE TABLE IF NOT EXISTS`. `relay_devices` and `fork_relay_device_keys` are not altered.

**amr and `/token`.** A JWT with `amr` containing `pairing` can only request role `terminal`; role `device`
is 403 / 1006. A pairing-derived terminal socket is closed with code 4011 when its JWT expires. Desktop (`device`)
sockets are not closed at JWT expiry: the Desktop refreshes its JWT without reconnecting, and dropping the
Desktop socket would drop the paired phone (the relay closes the terminal when the device disconnects).
Consequence: a phone session now lasts at most `ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS` (default 1 hour, maximum 24).

**IPv6.** The anonymous per-IP limiter (15.2) buckets IPv6 addresses by their /64 prefix, so rotating the low 64
bits does not bypass it. Trusted-proxy matching still uses the full address.

**QR fragment.** `pk` moves from the query string to the fragment (`#pk=`) so web hosts never log it. The web
entry reads the fragment first and the query second (QRs from older Desktops), then strips both. Deploy
order: ship the web host (reads both) before the Desktop release (writes only the fragment).

**Clients.** The Desktop in `device-key` mode with a baked mode and no secret ( `ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE=device-key`
at build time) sends `{device_key}`; on 4012 with a `challenge` it solves the PoW and retries once, and
with a configured secret it keeps the old path. On 4503 it reports `relay-unavailable`. PoW runs on the main
process in chunks of 20000 hashes separated by `setImmediate`, abortable by the start signal.

**Acceptance scenarios** (tests in `packages/remote-relay/test`, `packages/desktop/test`, `packages/shared`):
valid PoW enrolls an `open` key and a later exchange needs no work; wrong nonce, insufficient zeros, a
challenge for another key, a tampered challenge, an expired challenge, a challenge from another process;
secret plus work is a 400; replay of a solved request; work in `secret` mode is denied; no work and no secret
gives 4012 with a challenge in `open` mode and without one in `secret` mode; breaker open by key cap and by
hourly rate answers 4503 while existing keys still exchange and the secret path still enrolls an owner key;
legacy key without usage row is `owner`; idle expiry removes only stale `open` keys; pairing JWT cannot take
role `device` and inherits the tier; `/token` per-identity rate limit; socket cap per identity, release on
close, owner 4x; inbound byte budget closes the socket; pairing terminal closes at JWT expiry while a
device socket does not; `2001:db8::1` and `2001:db8:0:0:ffff::2` share a limiter bucket while an IPv4
address does not; startup: unknown mode, `open` without secret starts, `secret` without secret fails; Desktop
PoW yields to timers and aborts; shared QR builder writes the fragment, parser reads it.
