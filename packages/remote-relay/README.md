# Self-hosted remote relay (V2)

This executable pairs the Desktop and Web remote-control clients over the V2 protocol
(`/api/v1/remote/*` HTTP and `/api/v1/remote/ws2` WebSocket). It issues its own relay
JWTs from the account login JWT, so it needs no account service. It does not serve the
Web frontend or run an Agent: Desktop must stay running to execute commands.

Protocol and client behavior: `docs/web-remote-control/relay-v2-pairing.md`.
Design, owner decisions and the test plan: `specs/relay-v2-migration.md` (sections 10 to 12).
Deployment notes in `self-hosted-remote-relay.md` describe the V1 design and are being
replaced by this README.

## Configuration

Startup fails closed: a missing or malformed required value stops the process, and the
error names the variable, never its value.

| Variable                                 | Required | Meaning                                                                                            |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `ZCODE_RELAY_DB_PATH`                    | yes      | SQLite file for device records. Keep it on a persistent volume, readable only by the relay user.   |
| `ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS`    | yes      | JSON array of private Ed25519 JWKs (`kty: OKP`, `crv: Ed25519`, `kid`, `d`, `x`). The first signs. |
| `ZCODE_REMOTE_RELAY_IDENTITY_ISSUER`     | yes      | Exact `iss` value the account login JWT must carry.                                                |
| `ZCODE_REMOTE_RELAY_IDENTITY_JWKS`       | yes      | JWK set (`{"keys": [...]}` or a JSON array) of public keys for EdDSA, ES256 or RS256 login tokens. |
| `ZCODE_REMOTE_RELAY_IDENTITY_AUDIENCE`   | no       | `aud` the login JWT must carry, when set.                                                          |
| `ZCODE_REMOTE_RELAY_IDENTITY_USER_CLAIM` | no       | Claim holding the user id. Default `sub`.                                                          |
| `ZCODE_REMOTE_RELAY_JWT_TTL_SECONDS`     | no       | Relay JWT lifetime. Default `3600`, maximum `86400`.                                               |
| `ZCODE_REMOTE_RELAY_AUTH_TIMEOUT_MS`     | no       | Deadline for `auth_init` after connecting. Default `15000`.                                        |
| `ZCODE_RELAY_HOST`, `ZCODE_RELAY_PORT`   | no       | Bind address (default `127.0.0.1`) and port (default `3031`).                                      |
| `ZCODE_RELAY_ALLOWED_ORIGINS`            | no       | Exact Web origins, comma-separated. Required when binding to a non-loopback address.               |
| `ZCODE_RELAY_TRUSTED_PROXIES`            | no       | Exact proxy IP addresses whose `X-Forwarded-For` is honored. Empty by default.                     |

Limits (defaults): `ZCODE_RELAY_MAX_CONNECTIONS` 2000, `ZCODE_RELAY_REGISTRATIONS_PER_MINUTE` 20
per source address (applies to `/session` and `/device`), `ZCODE_RELAY_MAX_REGISTRATIONS` 100000,
`ZCODE_RELAY_MAX_BUFFERED_BYTES` 2097152, `ZCODE_RELAY_MAX_TOTAL_BUFFERED_BYTES` 67108864.

`ZCODE_RELAY_STORAGE_KEY` from V1 is removed: device records hold no secret.

## Keys and rotation

Generate a relay signing key as an Ed25519 private JWK, give it a `kid`, and put it first
in `ZCODE_REMOTE_RELAY_JWT_SIGNING_KEYS`. To rotate, prepend the new key and restart. Keep
the old key until at least one TTL has passed, then remove it. Keys live in memory only.
This version is single-replica: every replica needs the same key array.

The login identity keys are public only. The relay never fetches them from the network.

## Routes

| Route                               | Auth              | Purpose                                          |
| ----------------------------------- | ----------------- | ------------------------------------------------ |
| POST `/api/v1/remote/session`       | login JWT in body | Exchange for a relay JWT                         |
| POST / GET `/api/v1/remote/device`  | relay JWT         | Register a device (new SID each call) / list own |
| POST `/api/v1/remote/device/delete` | relay JWT         | Delete an offline own device                     |
| POST `/api/v1/remote/token`         | relay JWT         | One-time 60 second WebSocket token               |
| WS `/api/v1/remote/ws2?token=`      | one-time token    | Pairing and forwarding                           |
| GET `/healthz`, `/readyz`           | none              | Liveness and readiness                           |

## Railway

1. Create a service from the repository. Set `RAILWAY_DOCKERFILE_PATH=packages/remote-relay/Dockerfile`
   and leave build and start overrides empty.
2. Attach a persistent volume at `/data`. Use one replica.
3. Set the variables above, using `ZCODE_RELAY_DB_PATH=/data/relay.sqlite`,
   `ZCODE_RELAY_HOST=0.0.0.0`, `ZCODE_RELAY_PORT=3031`, and your Web origin in
   `ZCODE_RELAY_ALLOWED_ORIGINS`. Set `RAILWAY_RUN_UID=0` because the volume is root-owned.
4. Generate a public domain on port `3031`, with health check path `/readyz`. Clients use
   `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<relay-domain>` (origin only; the path
   `/api/v1/remote/ws2` is derived).

Origins are exact HTTP(S) origins without paths or trailing slashes. Never put signing keys,
identity keys or the database file in a client build, a `VITE_` variable, a source file or a PR.

## Verification

From the repository root:

```bash
pnpm test:relay
pnpm build:relay
pnpm --filter @zcode/remote-relay test:bundle
docker build -f packages/remote-relay/Dockerfile -t zcode-remote-relay:local .
```

`test:bundle` runs the built `dist/entry.js` end to end: readiness, login exchange, device
registration, pairing, forwarding and restart persistence.
