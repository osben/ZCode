# OAuth Multi-Provider Final Refactoring Plan (Final)

Document status: Updated per the 2026-07-16 OAuth callback consolidation decision. Current Desktop OAuth only supports the unified callback `zcode://oauth/callback`, no longer supporting provider-specific callback hosts.

Related documents:

- `docs/superpowers/specs/2026-03-31-bigmodel-oauth-login-design.md` (current live BigModel single-provider solution)

## 0. Scope and Boundaries

- This plan covers **Desktop (Electron)** only for this round.
- Web OAuth is not in scope for this round; related designs and implementations are deferred.

## 1. Background

The current branch has completed the BigModel OAuth login closed loop, satisfying "single-provider login" from an availability standpoint.
But if more OAuth providers (e.g., GitHub, Google, enterprise SSO) need to be integrated in the future, the existing implementation still favors single-provider across service interfaces, deep link routing, credential storage namespaces, and UI models.

This document provides the final target structure and phased implementation path, aiming to upgrade OAuth capabilities to a "pluggable, multi-provider, sustainably evolving" architecture without breaking the existing BigModel login experience.

## 2. Current Problems (Based on Current Code)

1. OAuth configuration and implementation strongly tied to BigModel protocol details: `authCode` parameter, `tokenByAuthCode` exchange contract, specific userinfo fields.
2. The historical BigModel single-provider phase once used provider-specific deep links; now consolidated to unified `zcode://oauth/callback`.
3. `IOAuthService` has no provider dimension; callers cannot express "I want to initiate which provider's login."
4. Credential keys are not namespaced by provider; future multi-provider would overwrite each other's tokens and userinfo.
5. UI copy and interaction model is "single-button BigModel login," with no provider list/strategy extension point.
6. No explicit concurrent login strategy defined (behavior of clicking different providers rapidly in the same window is undefined).

## 3. Final Targets

### 3.1 Capability Targets

1. The same OAuth main flow can integrate multiple providers (Provider Adapters are pluggable).
2. Each provider independently manages state, token, userinfo, and error handling, without polluting each other.
3. The UI layer can display provider entries driven by configuration, enabling/disabling providers on demand.
4. Compatible with existing BigModel login data and login entries, enabling smooth migration.

### 3.2 Product Strategy (Explicit Constraints)

1. **Single active provider**: Only maintain one `active_provider` at a time.
2. After successful new provider login, update `active_provider` to the new provider (old provider tokens may be retained or cleaned per strategy, see Service strategy).
3. **Single-window single pending login**: Only one in-progress OAuth flow per window; initiating a new login automatically cancels the old pending.

### 3.3 Architecture Targets (Following Layering)

Maintain one-way dependencies within the OAuth domain:

`Types -> Config -> Repo -> Service -> Runtime -> UI`

Cross-cutting concerns (authentication) are unified through the Providers entry point; do not let UI/business layers bypass Providers to directly splice third-party OAuth protocol details.

## 4. Target Structure Design

### 4.1 Types Layer

Add OAuth domain types in `packages/shared`:

- `OAuthProviderId` (e.g., `"bigmodel" | "github" | ...`)
- `OAuthStartRequest` / `OAuthStartResponse`
- `OAuthCallbackParams` (normalized `code/state/...`)
- `OAuthTokenSet`
- `OAuthUserProfile`
- `OAuthProviderMeta`
- `OAuthLogoutScope` (`"active" | "all"`)

Principle: Types express only generic domain semantics, without specific vendor field names.

### 4.2 Config Layer

- Only retain public config (authorize URL, redirect template, display name, enabled status, sorting, etc.).
- Do not place sensitive fields like `clientSecret`, private exchange parameters, etc., into `packages/shared` or renderer-visible paths.
- Sensitive config is injected at runtime by the host process.

Desktop constraints for this round:

1. Development environment: use local `.env.local` (already `gitignore`) injected into the host process.
2. Packaging environment: inject runtime environment variables through the build pipeline, without writing to the source repository.
3. Risk annotation: If a third-party interface requires the client to carry `appSecret`, it is a protocol-level high risk and must be clearly documented as "can be reverse-extracted."
4. Recommended direction: In the medium-to-long term, move token exchange down to a controlled backend; Desktop only holds short-lived authorization codes.

### 4.3 Providers Layer (Core)

Directory suggestion: `packages/services/src/oauth/providers/`.

Define the provider adapter interface (illustrative):

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

Constraints: Adapters only handle protocol differences, never directly operate on `credentialService`, maintaining pure protocol responsibilities.

### 4.4 Repo Layer

Directory suggestion: `packages/services/src/oauth/repo/`.

Unified key namespace:

- `oauth:<provider>:access_token`
- `oauth:<provider>:refresh_token`
- `oauth:<provider>:user_info`
- `oauth:active_provider`

Old key migration uses **lazy migration** (avoiding startup-phase full migration races):

1. Read new keys first.
2. When new keys are missing, fallback to reading old keys (`auth_token` / `refresh_token` / `user_info`).
3. Upon reading old values, immediately write new keys.
4. After successful writes, delete old keys.

### 4.5 Service Layer

`IOAuthService` upgraded to provider-aware (illustrative):

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

State structure:

- `state -> { provider, createdAt, timeout, sourceWindowId? }`

Concurrency strategy:

1. When `startOAuth` finds an existing pending, first `cancelPending()` then create a new state.
2. Prevents unclear callback ownership from same-window concurrent logins.

Logout strategy:

1. Default `logout()`: Only logout the current `active_provider`.
2. `logout(provider)`: Logout a specified provider (compatible with future "non-active pre-cleanup" scenarios).
3. `logoutAll()`: Clean all provider credentials.
4. When `active_provider` is logged out, nullify or switch to the most recent still-valid provider per strategy (this round suggests nullifying, the clearest behavior).

### 4.6 Runtime / Platform Layer

Desktop main deep link routing unified to a single entry:

- Current path: `zcode://oauth/callback?...`
- Removed old path: `zcode://bigmodel-auth/callback?...`
- Removed old path: `zcode://zai-auth/callback?...`

Consolidation strategy:

1. When new clients initiate OAuth, regardless of provider, use `zcode://oauth/callback` as the `redirect_uri`.
2. The Desktop main process only recognizes the `oauth` host; provider ownership is not inferred from the callback host.
3. Callback routing still uses `state` as the authoritative index; the renderer-side `OAuthService` finds the provider that initiated login from the pending state.
4. `ZAI_OAUTH_REDIRECT_URI` / `BIGMODEL_OAUTH_REDIRECT_URI` and legacy redirect URI environment variable overrides are no longer provided, preventing production environments from re-producing old callbacks.

`registerOAuthState` can optionally attach a provider; the final authority remains `state`.

### 4.7 UI Layer

- `useOAuth` changed to `startLogin(provider)`.
- LoginDialog upgraded from "single-button" to "provider list driven."
- i18n copy changed to generic templates + provider display name mapping, removing hardcoded BigModel copy.
- BigModel remains置顶 by default, ensuring existing user paths are unchanged.

## 5. Phased Implementation Plan

### Phase 0: Security and Stanching (Must be done first)

1. Remove hardcoded sensitive information from code (especially `clientSecret`).
2. Complete key rotation.
3. Add secret scanning in CI (pre-commit + pipeline).
4. Add "client-side secret risk" documentation alerts and pre-release checks.

**Exit criteria**: No plaintext secrets in the repository; new builds can log in to BigModel through runtime config; risk statements are explicit.

### Phase 1: Service Layer Abstraction (No UI Behavior Changes)

1. Introduce Provider Adapter (including `parseCallbackParams`).
2. Clarify `OAuthProviderContext`.
3. Introduce `repo/` layer and complete provider namespace keys.
4. Implement old key **lazy migration** in the `repo/` layer (read new key, fallback to old key on failure, write back new key, then delete old key).
5. `IOAuthService` adds provider, logout, and active provider capabilities.
6. Keep UI showing only BigModel (internal abstraction only).

**Exit criteria**: BigModel functionality does not regress; adding new providers requires only a new adapter + config.

### Phase 2: Deep Link Generic Routing + Transition Compatibility

1. Main process supports dual routing for old and new paths.
2. Complete the redirect URI switch process (client first, then server).
3. Complete cold-start/multi-window routing tests.

**Exit criteria**: Any provider callback can route correctly; BigModel migration has no interruptions.

### Phase 3: UI and i18n Expansion

1. Login dialog provider list-ification.
2. Copy changed from BigModel-specific to generic keys.
3. Implement "single active provider" interaction copy (e.g., login replacement prompts).

**Exit criteria**: The same UI can initiate logins for multiple providers, without hardcoded brand names.

### Phase 4: Compatibility and Wrapping Up

1. Complete old key cleanup (lazy migration already implemented in Phase 1).
2. Complete e2e: multi-provider, cancel login, state expiration, callback anomalies, window close, etc.
3. Full regression: Desktop multi-platform (macOS, Windows, Linux).

**Exit criteria**: Pass typecheck, lint, unit tests, and core e2e; BigModel old users can migrate without awareness.

## 6. Test Strategy

1. Provider Adapter contract tests: Introduce `MockProviderAdapter`; all providers share the same contract cases.
2. Adapter fixture tests: Each provider only supplements fixtures (authorize URL params, callback examples, token/userinfo response examples).
3. Service tests:
   - Multi-provider state isolation
   - Single pending concurrency protection
   - `active_provider` switching
   - `logout()` / `logout(provider)` / `logoutAll()` behavior
   - Lazy migration flow
4. Desktop integration tests: Deep link cold-start/hot-start, multi-window routing, old/new path compatibility.
5. Regression tests: Behavior is identical to the current version with only BigModel enabled.

## 7. Risks and Countermeasures

1. **Risk:** Large provider contract differences (parameter names, token formats, userinfo interface differences).
   **Countermeasure:** Force isolation through the Adapter layer; Services only consume normalized results.
2. **Risk:** Client-side storage or use of `clientSecret` has reverse-extraction risks.
   **Countermeasure:** Runtime injection + key rotation + explicit risk warnings; medium-to-long-term migration to server-side exchange.
3. **Risk:** Old credential overwriting or loss.
   **Countermeasure:** Provider namespace keys + lazy migration + atomic writes then delete old keys.
4. **Risk:** Deep link behavior differences across OS leading to callback loss.
   **Countermeasure:** Retain single-instance lock, cold-start cache, platform-specific e2e, and maintain old/new path transition compatibility.
5. **Risk:** Concurrent login causing state confusion.
   **Countermeasure:** Single-window single pending; cancel old flows before initiating new logins.

## 8. Recommended Implementation Order (Execution Suggestions)

1. Phase 0 (Security)
2. Phase 1 (Service Abstraction)
3. Phase 2 (Deep Link Generic)
4. Phase 3 (UI Expansion)
5. Phase 4 (Compatibility and Wrapping)

This order maintains "publishable state" at each phase and reduces the risk of a single large change.

---

Last updated: 2026-04-01
