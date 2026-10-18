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
   `ZCODE_SERVER_AUTH_TOKEN`). The `authRequired` flag passed to the guard is never used
   to decide enforcement.
2. **With a token, auth is deny-by-default.** A request may skip the token only when its
   method is `GET` or `HEAD` and none of its path forms falls under `/api` or `/ws`.
   The middleware decides this on the path forms the router could see, not only on the
   raw URL path, because Hono routes on `decodeURI(rawPath)` (so `/%61pi/server-info`
   routes to `/api/server-info`). The forms it checks are:
   - Hono's routing path (`c.req.path`) and the raw `URL.pathname`.
   - Each of those repeatedly percent-decoded until stable. This catches double
     encoding and `%2F`/`%2f`.
   - Each form lowercased, with `\` turned into `/` and repeated slashes collapsed.

   This set of forms is a superset of what can route to a protected handler, so
   unusual spellings fail closed (401). Every non-`GET`/`HEAD` request needs the token,
   including bot callbacks under `/api/bots/*`. Public `GET`s cover only the static
   Web assets and the SPA fallback.

3. **Default bind is loopback.** When `options.host` is unset or blank, the server
   listens on the literal `127.0.0.1`. It does not use `localhost` (which may resolve to
   `::1` only) or Node's default (`::`, all interfaces).
4. **A non-loopback bind requires auth.** If the effective host is not `127.0.0.1`,
   `::1`, or `localhost` and no token is configured, `createHttpServer` throws
   synchronously, before listening. `entry-http.ts` takes the host from
   `ZCODE_SERVER_HOST`, falling back to `HOST` (both trimmed), and validates it before it
   creates any local service. The error names `ZCODE_SERVER_HOST` / `HOST` and
   `ZCODE_SERVER_AUTH_TOKEN`. No "allow unauthenticated" escape hatch exists.
5. **Reported auth matches enforced auth.** `/api/server-info.authRequired` is
   `options.authRequired ?? Boolean(authToken)`. `http.ts` does not read an auth
   env var.
6. **The log prints the real bound address.** The listen callback logs
   `server.address()` (IPv6 in brackets), not the requested host or a hardcoded
   `localhost`.
7. **Remote connection ids are unguessable.** `/api/connect-remote` ids come from
   `crypto.randomUUID()`.

## Distribution runner

`zcode --web --host <non-loopback> --no-token` would now start a server that refuses
to listen. The runner rejects that combination up front, before spawning, with a clear
message. Its loopback check is case-insensitive, matching the server's (`LOCALHOST` is loopback). The default `--host 0.0.0.0` path, which auto-generates a token, and loopback
`--no-token` are unchanged.

## Dev web proxy

The Vite proxy in `packages/web/vite.config.ts` targets `127.0.0.1:3030` to match the
loopback-only default bind.

## Acceptance scenarios

| Token | Host        | Result                                                                                                              |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| none  | unset       | listens on `127.0.0.1`; `authRequired: false`                                                                       |
| none  | `0.0.0.0`   | `createHttpServer` throws; nothing listens                                                                          |
| none  | `localhost` | listens on loopback                                                                                                 |
| set   | `0.0.0.0`   | listens; `/api/*` and `/ws*` return 401 without the token                                                           |
| set   | any         | `POST /api/rpc-host-capability` and `/api/connect-remote` → 401 without token; `authRequired: true`                 |
| set   | any         | encoded/case/slash variants (`/%61pi/...`, `/%2561pi/...`, `/API/...`, `//api/...`, `/api%2F...`, WS `/%77s`) → 401 |

## Open risks (not covered)

- **Cross-origin access without a token on loopback.** A no-token loopback server
  checks neither `Origin` nor `Host`. A web page in the user's browser can use DNS
  rebinding, or open a cross-origin WebSocket to `/ws` (browsers do not apply CORS to
  WebSocket upgrades). That page could reach the RPC services and mint `/ws/host`
  capabilities. Closing this requires a product decision on Origin/Host allow-lists
  (dev Vite proxy, `zcode --web`, Desktop connector). Until then, loopback without a
  token is only as safe as the browsers running on that machine.

## Follow-ups (not in this change)

- `remoteConnections` entries that are never claimed by `/ws/remote/:id` have no TTL
  and keep their remote connection open.
