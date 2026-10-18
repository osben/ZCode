# Web server bind and authentication defaults

## Scope

`packages/server` (`createHttpServer`, started by `entry-http.ts`) is the HTTP/WebSocket
server behind `pnpm dev:web` and the `zcode --web` distribution runner
(`scripts/zcode-distribution/runner.mjs`). It exposes routes that grant local
capabilities:

- `POST /api/rpc-host-capability` mints a one-time capability for the trusted
  `desktop-continuous` relay on `/ws/host`.
- `POST /api/connect-remote` opens SSH / WSL / Docker / server connections, then
  `/ws/remote/:id` bridges file, git, system, and terminal services.
- `/ws` exposes local file, git, system, terminal, and agent services.

`packages/zcode-server-cli` already refuses non-loopback listeners
(`server-core/http.ts`). This spec gives `packages/server` the same fail-closed default.
`remote-relay` and `zcode-server-cli` do not change.

## Rules

1. **The token is the single source of truth for auth.** Auth is enforced only when
   `options.authToken?.trim()` is non-empty (`entry-http.ts` reads it from
   `ZCODE_SERVER_AUTH_TOKEN`). The token middleware then protects `/ws`, `/ws/*`, and
   `/api/*`. The `authRequired` flag passed to the guard is never used to decide
   enforcement.
2. **Default bind is loopback.** When `options.host` is unset or blank, the server
   listens on the literal `127.0.0.1`. It does not use `localhost` (which may resolve to
   `::1` only) or Node's default (`::`, all interfaces).
3. **A non-loopback bind requires auth.** If the effective host is not `127.0.0.1`,
   `::1`, or `localhost` and no token is configured, `createHttpServer` throws
   synchronously, before listening. The error names `ZCODE_SERVER_HOST` / `HOST` and
   `ZCODE_SERVER_AUTH_TOKEN`. No "allow unauthenticated" escape hatch exists.
4. **Reported auth matches enforced auth.** `/api/server-info.authRequired` is
   `options.authRequired ?? Boolean(authToken)`. `http.ts` does not read an auth
   env var.
5. **The log prints the real bound address.** The listen callback logs
   `server.address()` (IPv6 in brackets), not the requested host or a hardcoded
   `localhost`.
6. **Remote connection ids are unguessable.** `/api/connect-remote` ids come from
   `crypto.randomUUID()`.

## Distribution runner

`zcode --web --host <non-loopback> --no-token` would now start a server that refuses
to listen. The runner rejects that combination up front, before spawning, with a clear
message. The default `--host 0.0.0.0` path, which auto-generates a token, and loopback
`--no-token` are unchanged.

## Dev web proxy

The Vite proxy in `packages/web/vite.config.ts` targets `127.0.0.1:3030` to match the
loopback-only default bind.

## Acceptance scenarios

| Token | Host        | Result                                                                                              |
| ----- | ----------- | --------------------------------------------------------------------------------------------------- |
| none  | unset       | listens on `127.0.0.1`; `authRequired: false`                                                       |
| none  | `0.0.0.0`   | `createHttpServer` throws; nothing listens                                                          |
| none  | `localhost` | listens on loopback                                                                                 |
| set   | `0.0.0.0`   | listens; `/api/*` and `/ws*` return 401 without the token                                           |
| set   | any         | `POST /api/rpc-host-capability` and `/api/connect-remote` → 401 without token; `authRequired: true` |

## Follow-ups (not in this change)

- `remoteConnections` entries that are never claimed by `/ws/remote/:id` have no TTL
  and keep their remote connection open.
