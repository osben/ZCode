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
