# Remote relay (V2 server)

The relay is the sole owner of device records, one-time WebSocket tokens, live
connections and the `(SID, role)` owner of each pair. It holds no task, workspace,
stream, snapshot or queue state.

Public entrypoints: `contract.ts` (ports and option types) and `adapters/nodeServer.ts`
(`createRelayServer`). The wire format is the shared V2 contract in
`@zcode/shared/web-remote-relay`; every frame the relay sends is parsed with that schema
in tests.

Identity:

- `POST /api/v1/remote/session` verifies the account login JWT once, against the
  configured issuer and public JWK set. No network call is made at runtime.
- Every other `/api/v1/remote/*` call and every token request needs the relay JWT
  this process signed (EdDSA, kid rotation via `ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS`).
- WebSocket admission uses a token from `POST /api/v1/remote/token`: 16 random bytes,
  bound to user and role, valid 60 seconds, consumed atomically at upgrade, capped at
  32 outstanding per user. Tokens are never reused.

Pairing rules:

- A newly authenticated socket replaces the previous owner of its `(SID, role)` slot,
  which receives `KICKED` and is closed. Cleanup is bound to the exact connection, so a
  late close cannot remove the replacement.
- When a device disconnects, the terminal receives `waiting`, then `DEVICE_OFFLINE`, and is closed.
- Opaque `data` frames are forwarded to the other role of the same SID only. Client
  timestamps are ignored; `server_ts` is always set by the relay.

Limits: every outbound frame reserves per-socket and aggregate bytes before sending
and releases them once on completion or close. Anonymous POSTs (`/session`,
`/device`) are rate limited per source address. Store IO runs on a worker thread.
Unauthenticated sockets are closed after `ZCODE_REMOTE_RELAY_AUTH_TIMEOUT_MS`.

Wire protocol and deployment: `docs/web-remote-control/relay-v2-pairing.md` and
`specs/relay-v2-migration.md` (section 12).

## Identity modes

`RelaySessionService.mode` is `zai-jwt` or `device-key` (`specs/relay-v2-migration.md` section 15).
`exchange` (login JWT) serves `zai-jwt` only; `exchangeDeviceKey` and `exchangePairing`/`createPairing`
serve `device-key` only and return a denial in the other mode. `RelayDeviceKeyStore` (enrolled public keys,
table `fork_relay_device_keys`) is implemented by the same SQLite store as device records.

Open enrollment (`specs/relay-v2-migration.md` section 15.6): `RelayDeviceKeyStore.lookup/enroll/touch` carry a
key tier (`owner` or `open`; a key without a usage row is `owner`), table `fork_relay_identity_usage`. Relay
JWTs carry the `tier` claim; `RelaySessionService.claims` returns `{userId, tier, expiresAt, viaPairing}`.
`POST /session` also accepts `{device_key, work: {challenge, nonce}}`; a 401 / 4012 may carry
`data: {challenge, difficulty, expires_in}`; a 503 / 4503 means no new open enrollments right now.
