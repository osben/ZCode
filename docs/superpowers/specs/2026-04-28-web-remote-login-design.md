# Web remote-control page login validation design (historical)

> Superseded by the [Web remote Relay V2 spec](../../issues/web-remote-control-relay-v2/01-relay-v2-login-pairing.md).
> The current login entry, QR code, and device selection follow [Relay V2](../../web-remote-control/relay-v2-pairing.md).
> This file keeps the rules of the OAuth-gated `/web-remote` login flow. `remoteControlToken` /
> `relayOrigin` describe the legacy `/web-remote` behavior and do not apply to the new `/remote` QR
> route, which uses the external relay `sid/hash/t/mid/name/app_version` parameters and must never
> put `sid` or `hash` into the OAuth state.

## Goal

The web remote-control page (`packages/web`) required no identity check before exposing tasks and
chat. This design added the same ZAI OAuth login as desktop — ZAI provider only — in front of it.

## Constraints

| Constraint             | Value                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment domain      | `https://zcode.z.ai` (already in the ZAI OAuth allowlist)                                                                                                                                                                                                               |
| OAuth provider         | ZAI (`chat.z.ai/auth`), **not** the desktop `zcode://` deep link                                                                                                                                                                                                        |
| Token storage          | Web `localStorage`, keys shared with desktop: `zcodejwttoken`, `oauth:zai:access_token`, `oauth:zai:user_info`, `oauth:active_provider`                                                                                                                                 |
| Production same-origin | page at `zcode.z.ai` calls `zcode.z.ai/api/v1/oauth/token` same-origin, no CORS issue                                                                                                                                                                                   |
| Development            | local origin injected via env; the ZAI callback first lands on the production domain and is forwarded back to the LAN IP; local token exchange must go through a Vite proxy or a backend CORS allowlist — the local Vite origin has no `/api/v1/oauth/token` of its own |

## Scope and integration boundary

Frontend scope: login page when logged out, ZAI OAuth start, callback handling, and persisting the
backend `zcodejwttoken` plus ZAI keys to `localStorage`. The backend (device list by JWT, real
remote connection after device selection, relay/server JWT auth) was out of scope; the localStorage
gate is UI-entry convergence only, not full server-side auth. After login the entry splits by URL:

1. URL has `remoteControlToken`: legacy remote link — return to the original URL and continue relay
   bootstrap with `remoteControlToken` / `relayOrigin`.
2. URL has no `remoteControlToken`: render the logged-in waiting page; do not connect plain `/ws`.
   (Later the device-list API would take over.)

Legacy parameters: `remoteControlToken` is the relay's one-time session token for one remote
session; the web uses it on `/api/remote-control/bootstrap/:token` to get `wsUrl`, workspace, and
initial task info, then connects `/ws/remote-control/:token`. `relayOrigin` is the relay origin used
to build relay API URLs (defaults to `window.location.origin`). Neither is the ZAI JWT or a user
identity; both must survive the OAuth round trip via `app_return_to` or the legacy link loses its
relay session.

## Flows

Production: `/web-remote?remoteControlToken=xxx&relayOrigin=...` → login page → authorize at
`https://chat.z.ai/api/oauth/authorize` with
`redirect_uri=https://zcode.z.ai/web-remote/callback` and a state carrying `app_return_to` →
callback page (same origin) exchanges the token directly → store JWT + ZAI keys → `replace` to
`app_return_to`, preserving `remoteControlToken`/`relayOrigin`.

Development (`VITE_DEV_ORIGIN=http://192.168.x.x:5173`): the phone opens the LAN origin; the state
additionally carries `return_to` (the local callback URL). The production callback page acts only as
a relay: it does not validate the local nonce and does not exchange the token, it only allowlist
checks `return_to` and 302s to `http://192.168.x.x:5173/web-remote/callback?code=...&state=...`.
The final local page validates the nonce and exchanges the token via the Vite proxy (or backend
CORS) back to `https://zcode.z.ai/api/v1/oauth/token`, then stores and redirects like production.

## `state` structure

`state = base64url(JSON.stringify(payload))`. base64url must use a shared codec — never raw
`atob(state)` — because the state travels in a URL query (`+`, `/`, `=` must be re-encoded; padding
restored on parse).

Payload: `nonce` (CSRF random, compared against `sessionStorage['oauth_pending_nonce']`),
`app_return_to?` (full URL to return to, preserving legacy query params), `return_to?` (dev-only
local callback URL; production never sets it).

`app_return_to` validation (URL API only, never blind redirect):

1. Production: origin must be `https://zcode.z.ai` and pathname `/web-remote` or `/web-remote/`.
2. Dev: origin must equal the origin that started the login; if `return_to` is also present, both
   must share an origin.
3. Only allowlisted query params survive — at minimum `remoteControlToken`, `relayOrigin`; any
   future param must be added to the allowlist explicitly.
4. On failure, fall back to `/web-remote`; never redirect to an arbitrary external URL.

`return_to` forwarding requires ALL of: present, parseable by `new URL`, origin different from the
current callback page, matching the private-network regex
`/^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/`,
pathname exactly `/web-remote/callback`, and an explicit build/deployment opt-in for dev
forwarding. Public production builds default to off; using `https://zcode.z.ai` as a dev relay
requires a backend signature or a dedicated test deployment — an unsigned private-network
`return_to` must never be accepted in public production. If checks fail, no cross-origin redirect:
the local callback page continues with nonce validation and token exchange (never `replace` back to
itself); a production callback without a valid dev `return_to` proceeds with the normal token
exchange.

CSRF: before starting, `crypto.randomUUID()` is written to `sessionStorage['oauth_pending_nonce']`.
On callback, the transit branch forwards without touching `sessionStorage`; the final page compares
and removes the nonce. `sessionStorage` does not cross origins, so nonce validation can only happen
after returning to the local origin. A mismatch throws (CSRF failure).

## Module layout (`packages/web/src/auth/`)

Layering `Providers → Repo → Service → Runtime/App wiring`; no auth cross-cutting logic in
`main.tsx`; ZAI protocol details stay in the provider module.

- `oauthStateCodec.ts` — pure functions: `buildOAuthState`/`parseOAuthState`,
  `encodeBase64Url`/`decodeBase64Url`, `parseOptionalUrl`, `isTrustedDevReturnTo`,
  `resolveSafeAppReturnTo`, `buildReturnToCallbackUrl(returnTo, { code?, error?, state })`.
- `webZaiOAuthConfig.ts` — authorize URL `https://chat.z.ai/api/oauth/authorize`; token URL
  same-origin `/api/v1/oauth/token` (dev via Vite proxy to `https://zcode.z.ai`); shared ZAI client
  id; redirect URI always `https://zcode.z.ai/web-remote/callback`; dev forwarding off by default.
- `zaiWebOAuthProvider.ts` — `buildAuthorizeUrl`, `parseCallbackParams` (`code`/`state`/`error`),
  `exchangeToken` (validates response shape), `toUserInfo`.
- `browserOAuthCredentialRepo.ts` — the only `localStorage`/`sessionStorage` writer:
  `saveTokenSet` (`oauth:zai:access_token` + `zcodejwttoken`), `saveUserInfo`, `setActiveProvider("zai")`,
  `loadCachedSession`, `clearAll`. `loadCachedSession` succeeds only when all hold:
  `oauth:active_provider === "zai"`, `zcodejwttoken` and `oauth:zai:access_token` non-empty after
  trim, and `oauth:zai:user_info` parses into a `UserInfo`. Otherwise treat as logged out and clear
  the partial ZAI keys.
- `webAuthService.ts` — desktop `OAuthService` equivalent, orchestrating provider + repo:
  `startLogin({ devReturnTo?, appReturnTo? })` (stores the nonce, builds the authorize URL,
  `appReturnTo` defaults to the current full URL), `handleCallback(url)` (state parse, transit/nonce
  handling, token exchange, persistence), `restoreCachedSession()` (local cache only, no remote
  userinfo call), `logout()`.
- `WebLoginPage.tsx` — full-screen login UI. Follows `DESIGN.md`: semantic color tokens
  (`bg-background`, `text-foreground`, `bg-card`, `border-border`), Zai light/dark themes,
  zh-CN/en-US copy via a lightweight pre-bootstrap locale resolver, existing button system, phone
  portrait / desktop wide / long-English layouts.
- `WebCallbackPage.tsx` — the only callback handler. Branch by state: `error` → failure page with
  retry; valid cross-origin trusted dev `return_to` → relay `location.replace`; same-origin or no
  `return_to` → nonce check → token exchange → persist → `replace(app_return_to)`. The branch
  condition is the state's `return_to`, never the presence of `code` (ZAI always sends `code`).
  `main.tsx` only routes to this component.
- `WebLoggedInWaitingPage.tsx` — placeholder for "logged in, no `remoteControlToken`": same locale
  resolver/theme tokens as the login page, zh-CN/en-US copy, display-only props (`user`,
  `onLogout?`), no direct storage or repo access, no plain-`/ws` connection.

`bootstrapWebApp()` order: callback path (pathname `/web-remote/callback` with `state` and
`code`/`error`) renders the callback page; otherwise `restoreCachedSession()` gates the app — logged
out renders the login page; logged in without `remoteControlToken` renders the waiting page; with
`remoteControlToken` continue the legacy relay bootstrap.

## Routing and storage

SPA routing by `window.location.pathname`: `/web-remote?remoteControlToken=...&relayOrigin=...`
(legacy entry, login required), `/web-remote` (login + waiting page), `/web-remote/callback`
(callback processing). No router library.

| localStorage key         | Value                                                                     | Purpose                                                         |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `zcodejwttoken`          | backend JWT (`data.token`)                                                | business API auth; future device list identifies the user by it |
| `oauth:zai:access_token` | ZAI access token (`data.zai.access_token`)                                | matches the desktop ZAI token set                               |
| `oauth:zai:user_info`    | JSON; backend `data.user` raw structure, mapped to `UserInfo` for display | user name/avatar; compatible with `OAuthCredentialRepo` restore |
| `oauth:active_provider`  | `"zai"`                                                                   | active login method                                             |
| `oauth:zai:expires_at`   | timestamp                                                                 | optional expiry check (later iteration)                         |

`sessionStorage['oauth_pending_nonce']` holds the CSRF UUID. Keys match the existing
`OAuthCredentialRepo` naming; display uses `@zcode/shared`'s `UserInfo` (never imported from
`@zcode/ui` backwards).

## Token exchange

```http
POST https://zcode.z.ai/api/v1/oauth/token
Content-Type: application/json

{
  "code": "<ZAI auth code>",
  "redirect_uri": "https://zcode.z.ai/web-remote/callback",
  "state": "<state>"
}
```

Success response (same shape as desktop):

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiJ9...",
    "zai": { "access_token": "zai_access_token_xxx" },
    "expires_in": 86400,
    "user": {
      "user_id": "u_xxxxx",
      "name": "User Name",
      "email": "user@example.com",
      "avatar": "https://..."
    }
  }
}
```

Errors: HTTP non-2xx maps via `WebRemoteControlFailureReason` (e.g. "unexpected-error"); business
`code !== 0` shows a retryable failure and keeps the login page; missing `data.token` or
`data.zai.access_token` fails the same way and forbids writing a half login state.

## Environment variables

Dev: `VITE_DEV_ORIGIN=http://192.168.x.x:5173` in `.env.local` (or Vite CLI). The dev token path
must be explicit: either a dedicated Vite proxy entry — which must precede the existing catch-all
`/api` → `localhost:3030` proxy, otherwise `/api/v1/oauth/token` is misrouted to the local server —
or the local server itself forwards `/api/v1/oauth/token`. `VITE_DEV_ORIGIN` only makes the local
page put `return_to` into the state; whether the production deployment accepts dev forwarding is
decided by that deployment (explicit switch, dedicated test deployment, or backend signature), not
by a local `.env.local`. Production builds leave `VITE_DEV_ORIGIN` undefined: no `return_to` in
state, unsigned dev forwarding rejected, token URL same-origin.

## Test plan

Unit: codec round-trips and invalid base64/JSON fallbacks, base64url `-`/`_`/padding edges,
private-network `return_to` allowlist, `app_return_to` origin/path/query rules; repo key writes/clears and
`loadCachedSession()` null + cleanup on any missing key; service success/failure exchange paths and
no half login state; callback transit vs final-local branch behavior (transit never reads production
`sessionStorage`; same-origin `return_to` does not self-replace).

Manual E2E: first production login; legacy link login preserving `remoteControlToken`/`relayOrigin`;
no-token login landing on the waiting page; cached revisit; expired token (mock 401); dev login via
LAN IP through the production relay page; cancel on the ZAI page.

Mechanical: `pnpm typecheck`, `pnpm lint`.

## Later iterations (out of scope here)

JWT active refresh (no backend refresh_token yet), logout UI, other providers (BigModel), cross
-client login sync, device-list flow after the backend API lands, and wiring the JWT (or a
server-issued short-lived ticket) into bootstrap/WebSocket.
