# OAuth Multi-Provider Architecture (Final Plan)

Status: aligned with the 2026-07-16 OAuth callback consolidation decision. Desktop OAuth supports
only the unified callback `zcode://oauth/callback`; provider-specific callback hosts are gone.

Related: `docs/superpowers/specs/2026-03-31-bigmodel-oauth-login-design.md` (BigModel
single-provider solution).

## 0. Scope

Desktop (Electron) only. Web OAuth is out of scope.

## 1. Background

BigModel OAuth login works end to end, but the original implementation favored a single provider in
service interfaces, deep-link routing, credential key namespaces and the UI model. The plan makes
OAuth pluggable and multi-provider (for example GitHub, Google, enterprise SSO) without breaking
the BigModel login experience.

## 2. Original problems

1. OAuth config and implementation tied to BigModel protocol details (`authCode` parameter,
   `tokenByAuthCode` exchange contract, userinfo fields).
2. BigModel once used provider-specific deep links; now consolidated to `zcode://oauth/callback`.
3. `IOAuthService` had no provider dimension.
4. Credential keys were not namespaced by provider, so tokens/userinfo would overwrite each other.
5. UI was a single BigModel login button with no provider list/extension point.
6. No concurrent login strategy (rapid clicks on different providers in one window were undefined).

## 3. Targets

### 3.1 Capabilities

1. One OAuth main flow integrates multiple providers (pluggable Provider Adapters).
2. Each provider manages its own state, token, userinfo and errors without polluting others.
3. The UI shows provider entries driven by configuration, enabled/disabled on demand.
4. Existing BigModel login data and entries migrate smoothly.

### 3.2 Product strategy

1. **Single active provider**: one `active_provider` at a time. After a successful login of a new
   provider, `active_provider` becomes that provider (old provider tokens may be kept or cleaned per
   the Service strategy).
2. **One pending login per window**: initiating a new login cancels the old pending flow.

### 3.3 Layering

One-way dependencies within the OAuth domain: `Types -> Config -> Repo -> Service -> Runtime -> UI`.
Authentication cross-cuts through the Providers entry; UI/business layers must not bypass Providers
to assemble third-party OAuth protocol details.

## 4. Target structure

### 4.1 Types (`packages/shared`)

`OAuthProviderId` (e.g. `"bigmodel" | "github" | ...`), `OAuthStartRequest` / `OAuthStartResponse`,
`OAuthCallbackParams` (normalized `code/state/...`), `OAuthTokenSet`, `OAuthUserProfile`,
`OAuthProviderMeta`, `OAuthLogoutScope` (`"active" | "all"`). Types express generic domain
semantics only, no vendor field names.

### 4.2 Config

- Only public config (authorize URL, redirect template, display name, enabled flag, ordering).
- Sensitive fields (`clientSecret`, private exchange parameters) never go into `packages/shared` or
  renderer-visible paths; the host process injects them at runtime.
- Development: local `.env.local` (gitignored) injected into the host process. Packaging: runtime
  environment variables injected by the build pipeline, not written to the repository.
- Risk: if a third-party interface requires the client to carry `appSecret`, that is a high
  protocol-level risk ("can be reverse-extracted") and must be documented. Medium-to-long term,
  token exchange moves to a controlled backend and Desktop holds only short-lived authorization
  codes.

### 4.3 Providers (core)

Location: `packages/services/src/oauth/providers/`. Adapter interface (illustrative):

```ts
interface OAuthProviderContext {
  providerId: OAuthProviderId;
  redirectUri: string;
  state: string;
  now: () => number;
}

interface OAuthProviderAdapter {
  providerId: OAuthProviderId;
  parseCallbackParams(url: string): OAuthCallbackParams; // Required: adapt authCode/code differences
  buildAuthorizeUrl(ctx: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, ctx: OAuthProviderContext): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, ctx: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, ctx: OAuthProviderContext): Promise<OAuthTokenSet>;
  normalizeError(error: unknown): Error;
}
```

Adapters handle protocol differences only and never touch `credentialService`.

### 4.4 Repo

Location: `packages/services/src/oauth/repo/`. Key namespace: `oauth:<provider>:access_token`,
`oauth:<provider>:refresh_token`, `oauth:<provider>:user_info`, `oauth:active_provider`.

Old keys (`auth_token` / `refresh_token` / `user_info`) migrate **lazily** (no startup-phase full
migration races): read new keys first; when missing, read old keys; on an old-key hit write the new
keys immediately; delete the old keys after the write succeeds.

### 4.5 Service

`IOAuthService` is provider-aware (illustrative):

```ts
interface IOAuthService {
  getProviders(): Promise<OAuthProviderMeta[]>;
  getActiveProvider(): Promise<OAuthProviderId | null>;
  startOAuth(provider: OAuthProviderId): Promise<{ authorizeUrl: string; state: string }>;
  handleCallback(url: string): Promise<UserInfo>;
  refreshToken(provider?: OAuthProviderId): Promise<void>;
  logout(provider?: OAuthProviderId): Promise<void>; // If not passed, logout active provider
  logoutAll(): Promise<void>;
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}
```

- Pending state: `state -> { provider, createdAt, timeout, sourceWindowId? }`.
- Concurrency: when `startOAuth` finds an existing pending flow, it calls `cancelPending()` first and
  then creates the new state, so callback ownership is never ambiguous.
- Logout: `logout()` logs out only the current `active_provider`; `logout(provider)` logs out a
  named provider; `logoutAll()` clears all provider credentials. When `active_provider` is logged
  out it becomes null (the clearest behavior for this round).

### 4.6 Runtime / platform

Desktop main routes deep links through a single entry `zcode://oauth/callback?...`. The old paths
`zcode://bigmodel-auth/callback` and `zcode://zai-auth/callback` are removed.

1. Every provider uses `zcode://oauth/callback` as `redirect_uri`.
2. Main recognizes only the `oauth` host; provider ownership is not inferred from the callback host.
3. Callback routing is indexed by `state`; the renderer-side `OAuthService` finds the initiating
   provider from the pending state.
4. `ZAI_OAUTH_REDIRECT_URI` / `BIGMODEL_OAUTH_REDIRECT_URI` and legacy redirect URI environment
   overrides no longer exist, so production cannot reintroduce old callbacks.

`registerOAuthState` may attach a provider; the final authority remains `state`.

### 4.7 UI

- `useOAuth` becomes `startLogin(provider)`.
- LoginDialog is driven by a provider list instead of a single button.
- i18n uses generic templates + provider display-name mapping, no hardcoded BigModel copy.
- BigModel stays first by default so existing user paths are unchanged.

## 5. Delivery phases

Each phase keeps a publishable state.

- **Phase 0, security (first)**: remove hardcoded sensitive information (especially
  `clientSecret`), rotate keys, add secret scanning in CI (pre-commit + pipeline), add client-side
  secret risk notes and pre-release checks. Exit: no plaintext secrets in the repository; new
  builds log in to BigModel through runtime config.
- **Phase 1, service abstraction (no UI change)**: Provider Adapter (incl. `parseCallbackParams`),
  `OAuthProviderContext`, `repo/` layer with provider namespace keys and lazy old-key migration,
  provider/logout/active-provider capabilities in `IOAuthService`; UI still shows only BigModel.
  Exit: no BigModel regression; a new provider needs only an adapter + config.
- **Phase 2, generic deep-link routing + transition**: main supports old and new paths during the
  transition; redirect URI switch is client first, then server; cold-start/multi-window routing
  tests. Exit: any provider callback routes correctly with no BigModel migration interruption.
- **Phase 3, UI and i18n**: provider-list login dialog, generic copy keys, "single active provider"
  interaction copy (such as login replacement prompts). Exit: one UI starts logins for multiple
  providers without hardcoded brand names.
- **Phase 4, compatibility and wrap-up**: remaining old key cleanup, e2e (multi-provider, cancel
  login, state expiration, callback anomalies, window close), full multi-platform regression
  (macOS, Windows, Linux). Exit: typecheck, lint, unit tests and core e2e pass; BigModel old users
  migrate without noticing.

## 6. Test strategy

1. Provider Adapter contract tests with a `MockProviderAdapter`; all providers share the same
   contract cases.
2. Adapter fixture tests: per provider authorize URL params, callback examples, token/userinfo
   response examples.
3. Service tests: multi-provider state isolation, single-pending concurrency protection,
   `active_provider` switching, `logout()` / `logout(provider)` / `logoutAll()`, lazy migration.
4. Desktop integration: deep-link cold/hot start, multi-window routing, old/new path compatibility.
5. Regression: behavior identical to the earlier version with only BigModel enabled.

## 7. Risks and countermeasures

1. Large provider contract differences: isolate in the Adapter layer; Services consume normalized
   results only.
2. Client-side storage/use of `clientSecret` can be reverse-extracted: runtime injection + key
   rotation + explicit warnings; migrate to server-side exchange.
3. Old credentials overwritten or lost: namespaced keys + lazy migration + atomic write then delete
   old keys.
4. OS differences in deep-link behavior lose callbacks: single-instance lock, cold-start cache,
   platform e2e, and old/new path transition compatibility.
5. Concurrent login confuses state: one pending per window; cancel old flows before a new login.

Full history: `git show b8876e8b:docs/oauth/oauth-multi-provider-final-plan.md`
