# BigModel OAuth login design

## Overview

BigModel OAuth replaces username/password login. Login is optional — the app is usable without an
account. The top-right login button opens a LoginDialog; OAuth round-trips through the browser and
returns to the app via deep link. Desktop (Electron) only; Web is not supported for this flow.

## Overall flow (event order)

1. Login button → LoginDialog → "通过 BigModel 登录" → `useOAuth.startLogin()`.
2. RPC `oauthService.startOAuth()` returns `{ authorizeUrl, state }`; the renderer reports `state`
   to Main for deep link routing (`OAuthRegisterState`); the browser opens via
   `platform.openExternal(authorizeUrl)`.
3. BigModel authenticates the user and redirects to `zcode://bigmodel-auth/callback?code=xxx&state=xxx`.
4. Main captures the deep link, parses `state`, looks up the state→windowId map, and forwards only
   the URL: `targetWindow.webContents.send(PlatformChannels.OAuthCallback, url)`. Main holds no
   business logic.
5. The renderer (Root/App persistent listener, not the dialog) RPCs `oauthService.handleCallback(url)`:
   validate state (delete immediately on match, anti-replay) → POST tokenUrl with
   `code + code_verifier` → store the token via credentialService → optionally GET userinfoUrl.
6. Result updates the Zustand store (single source of truth) and closes the dialog.

## Custom protocol and deep link capture

Registration (before `app.whenReady()`): `app.setAsDefaultProtocolClient('zcode')` plus a single
instance lock (`app.requestSingleInstanceLock()`; quit when not held).

- macOS: `open-url` fires regardless of whether the app is running, but the handler must be
  registered before `app.whenReady()` or the cold-start event is lost. Packaged builds need
  `CFBundleURLTypes` via `electron-builder.config.js` `protocols: [{ name: 'zcode', schemes: ['zcode'] }]`.
- Windows/Linux: the protocol URL arrives as a command line argument — from `second-instance` argv
  when running (also focus/restore the existing window), or from `process.argv` on cold start.
- Cold start may deliver the deep link before the renderer mounts. Main caches it in a single
  `pendingDeepLinkUrl` and forwards it on `PlatformChannels.RendererReady`. The single value is
  safe because a cold start has exactly one window being created; deep links to a running app always
  route through the state→windowId map instead.
- `handleDeepLink` ignores URLs not starting with `zcode://bigmodel-auth/callback` and URLs without
  `state`.

## Main process duties (dispatch only)

1. Record state → webContents.id (`OAuthRegisterState`), with a 5-minute timeout cleanup and cleanup
   of all of a window's states when it closes.
2. Route deep links by state to the correct window.
3. Cache a cold-start deep link until `RendererReady`.

`OpenExternal` opens external URLs. No `OAuthSuccess`/`OAuthError` channels exist — the renderer
calls `handleCallback` over RPC and gets the result directly.

## IOAuthService (host-process RPC service)

`ServiceChannels.OAuth`; interface: `startOAuth(): Promise<{ authorizeUrl: string; state: string }>`
(generates state + PKCE, stores pendingStates with a 5-minute timeout),
`handleCallback(url: string): Promise<UserInfo>` (validate state → code-for-token exchange → persist
credentials → optional userinfo), `refreshToken(token: string): Promise<void>`,
`cancelPending(): Promise<void>`. Implementation in
`packages/services/src/oauth/oauthService.ts`, injecting `ICredentialService`; registered through the
standard service checklist (accessor, exports, `createLocalServices`, client ProxyChannel).

## Channels and platform surface

`ServiceChannels.OAuth = 'oauth'`; `PlatformChannels`:
`OpenExternal: 'zcode:open-external'`, `OAuthRegisterState: 'zcode:oauth-register-state'`,
`OAuthCallback: 'zcode:oauth-callback'`, `RendererReady: 'zcode:renderer-ready'`.

`IPlatformService` adds `openExternal(url)`, `registerOAuthState(state)`, `onOAuthCallback(cb)`
(returning a disposer that removes only that subscriber), `notifyRendererReady()`. The Web
implementation is no-op (or throws for `openExternal`); the desktop preload exposes the same four on
`window.zcode`, with `globals.d.ts` and the AGENTS.md allowlist kept in sync.

## UI layer

- `useOAuth` (LoginDialog-scoped) only starts the login flow: `startOAuth` → `registerOAuthState` →
  `openExternal`.
- The OAuth callback listener and `notifyRendererReady()` live in Root/App (persistent), so a closed
  or crashed dialog never loses the callback; on callback success `setUser(userInfo)`, on failure log
  via `packages/ui/src/logger.ts`.
- `LoginDialog` (converted from the former full-screen WelcomeScreen, shadcn Dialog):
  `LoginDialog({ open, onOpenChange })`, states `idle → waiting → success` with
  `error` on timeout/failure/cancel and retry back to idle. i18n copy; test IDs
  `TID_OAUTH_LOGIN_BUTTON`, `TID_OAUTH_CANCEL` (username/password IDs such as `TID_USERNAME_INPUT`
  were removed).
- Top-right button: logged out → open LoginDialog; logged in → show user info, click to logout.
- Auth state: the Zustand store is the single source of truth (the old unused `useState` user and
  `MOCK_USER` are gone). On startup Root reads the token via `useAuthToken()`; if present, restore
  the cached `user_info`; never block on missing token.

## Startup

Main always calls `createWindow()` — no login window, no `hasAuthToken()` branch, no
`loginSuccess`/`logout` platform methods or channels; logout is UI/hook-level only (delete
credentials, `setUser(null)`; no window close or reload).

## Token management

Storage via `credentialService` (`~/.zcode/v2/credentials.json`): `auth_token` (access token, key
unchanged), `refresh_token` (if BigModel returns one), `user_info` (cached JSON).

Refresh lives in a persistent `useTokenRefresh` hook, not in `useOAuth` (the dialog is usually
unmounted): listen for a global 401 signal (store flag or broadcastService) →
`oauthService.refreshToken(refreshToken)` → retry on success; on failure clear credentials and
`setUser(null)`. Logout deletes the three keys and sets `user` to null.

## OAuth configuration

Design-time config (originally `packages/shared/src/oauth.ts`; provider endpoint config has since
moved into the provider modules under services):

```ts
export const BIGMODEL_OAUTH_CONFIG = {
  authorizeUrl: "https://bigmodel.cn/login",
  tokenUrl: "https://bigmodel.cn/api/oauth/token", // 待确认
  userinfoUrl: "https://bigmodel.cn/api/oauth/userinfo", // 待确认，可选
  appId: "zcode-bigmodel-app", // 待确认
  redirectUri: "zcode://bigmodel-auth/callback",
};
```

Desktop is a public client: no `clientSecret`; PKCE provides the security.

## Security measures

- `state`: random 32-byte hex per request, stored in a Map, validated then deleted immediately on
  callback (anti-replay).
- PKCE is mandatory (public client): S256 `code_verifier` (43-128 random chars) +
  `code_challenge` (SHA256, base64url). If BigModel lacks PKCE support, record it as a known risk
  and add mitigations.
- Timeout: 5 minutes without a callback clears the pending state and surfaces a timeout in the UI.
- Duplicate clicks are ignored while a pending state exists (per OAuthService instance, i.e. per
  window host process; never blocks other windows).

## Edge cases

| Scenario                                           | Handling                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| User closes the browser after clicking login       | 5-minute timeout; OAuthService clears state; renderer shows timeout                                          |
| Repeated login clicks                              | pendingStates check ignores duplicates (per host process)                                                    |
| Deep link arrives with the app closed (cold start) | macOS `open-url`; Windows/Linux `process.argv`. State cannot match (memory lost) → error, user logs in again |
| Deep link arrives with the app running             | state→windowId routing to the correct window                                                                 |
| Deep link before renderer ready                    | Main caches the URL until `RendererReady`                                                                    |
| State mismatch                                     | rejected with an error                                                                                       |
| Token exchange network failure                     | error surfaced, retryable                                                                                    |
| Stored token expired at startup                    | load optimistically; a later 401 triggers refresh or re-login in the hook layer                              |
| Multiple windows logging in concurrently           | each window has its own host OAuthService; state→windowId routes each callback correctly                     |
