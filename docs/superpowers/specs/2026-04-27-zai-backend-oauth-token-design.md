# ZAI backend OAuth token exchange design

## Overview

The desktop keeps its multi-provider OAuth architecture, but ZAI login no longer talks to the
third-party ZAI token/userinfo endpoints from the client. The desktop only opens the ZAI authorize
page and receives the deep link callback; with `code` and `state` it calls the owned backend
`https://zcode.z.ai/api/v1/oauth/token`, which exchanges the token with z.ai, fetches userinfo,
creates the user, and issues a JWT. The backend JWT becomes the stored ZAI login token. Existing UI,
deep link, credential storage, and the multi-provider `OAuthService` + provider adapter architecture
are unchanged.

## Scope

- Only the ZAI OAuth provider protocol contract changes.
- BigModel login is unchanged. No new UI entries, no login-dialog redesign, no separate login
  service.

## Data flow

1. UI calls `oauthService.startOAuth("zai")`.
2. `ZaiProviderAdapter.buildAuthorizeUrl` builds the authorize URL: `https://chat.z.ai/api/oauth/authorize`,
   `client_id=client_P8X5CMWmlaRO9gyO-KSqtg`, `redirect_uri=zcode://zai-auth/callback`,
   `state=<random-state>`.
3. The browser opens via the platform layer; after the user authorizes, the deep link returns
   `zcode://zai-auth/callback?code=<code>&state=<state>`.
4. `OAuthService.handleCallback` validates the pending state, then the ZAI adapter POSTs to the
   backend:

```http
POST https://zcode.z.ai/api/v1/oauth/token
Content-Type: application/json

{
  "code": "<code>",
  "redirect_uri": "zcode://zai-auth/callback",
  "state": "<state>"
}
```

5. The backend responds:

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "token": "eyJ...",
    "expires_in": 86400,
    "user": {
      "user_id": "u_xxxxx",
      "email": "user@example.com",
      "avatar": "https://...",
      "created_at": "2026-04-27T10:00:00Z"
    }
  }
}
```

6. The client stores `oauth:zai:access_token` = `data.token`, mapped user info under
   `oauth:zai:user_info`, and `oauth:active_provider` = `zai`.

## Provider config mapping

- `authorizeUrl`: `https://chat.z.ai/api/oauth/authorize`
- `tokenUrl`: `https://zcode.z.ai/api/v1/oauth/token`
- `userinfoUrl`: kept in config but not called on the success path
- `appId`: `client_P8X5CMWmlaRO9gyO-KSqtg`
- `redirectUri`: `zcode://zai-auth/callback`
- `legacyRedirectUri`: `zcode://oauth/callback` stays for old deep link parsing

Token mapping: `OAuthTokenSet.accessToken` = `data.token`; `OAuthTokenSet.expiresAt` =
`now() + data.expires_in * 1000`; the backend provides no refresh token, so `refreshToken` is not
written.

User mapping: `OAuthUserProfile.id` = `data.user.user_id`; `username` prefers `data.user.email` and
falls back to the user id; `displayName` = username; `avatarUrl` = `data.user.avatar`.

## Error handling

- HTTP non-2xx keeps raising `ApiError` from `readApiJson`.
- Business response `code !== 0` is a token-exchange failure; the error message prefers `msg`.
- Missing `data.token` raises an explicit error — never persist an empty login state.
- Missing `data.user` does not block login; the existing fallback profile applies (the goal is the
  backend JWT; display info can be filled in later).

## Tests

`packages/services/test/oauthService.test.ts` covers: the new authorize URL with unchanged client
id; the JSON token request body (`code`, `redirect_uri`, `state`); storing `data.token` as
`oauth:zai:access_token`; `expires_in` → `expiresAt` conversion; failure on `code !== 0` and missing
`data.token`. Verification: `pnpm typecheck` and `pnpm lint`.

## Docs

`docs/oauth/oauth-multi-provider-implementation.md` records that ZAI login uses the backend JWT
exchange chain.
