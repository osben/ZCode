# OAuth Multi-Provider Implementation Notes (Desktop)

Last updated: 2026-04-03

## 1. Scope of This Round

This round performs structural reorganization for Desktop OAuth multi-provider support, aiming to enable peer-level provider extension, provider-encapsulated configuration, and no provider-specific exception logic written at common entry points.

## 2. Core Changes

### 2.1 Shared Keeps Only Domain Types

`packages/shared/src/oauth.ts` now only retains OAuth domain types and provider ids (`bigmodel`, `zai`), without placing provider default endpoint configs.

### 2.2 Provider Configs Pushed Down

New provider config modules in `packages/services/src/oauth/providers/`:

- `bigmodelProviderConfig.ts`
- `zaiProviderConfig.ts`
- `configUtils.ts`

Each provider maintains its own default config and environment variable mapping; `runtimeConfig.ts` only does aggregation.

### 2.3 Runtime Config Responsibilities Consolidated

`packages/services/src/oauth/runtimeConfig.ts` now only:

1. Define `OAuthProviderRuntimeConfig` / `OAuthRuntimeConfig`
2. Aggregate each provider's runtime config

No longer carries specific field assembly details for BigModel/ZAI.

### 2.4 Credential Repo Removes Global Legacy Provider Semantics

`packages/services/src/oauth/repo/oauthCredentialRepo.ts` only handles namespaced keys:

- `oauth:<provider>:access_token`
- `oauth:<provider>:refresh_token`
- `oauth:<provider>:user_info`
- `oauth:active_provider`

No longer infers or migrates providers through a global `LEGACY_PROVIDER_ID`.

BigModel `oauth:bigmodel:user_info` currently saves a normalized profile, marked with
`rawProfile.zcodeProfileSchemaVersion = 2` indicating it was generated according to the `customerName -> nickName -> "user"`
display name priority. During startup `restoreCachedSession()`, if it detects old BigModel cache lacks
this version marker or the version is below 2, it immediately returns the local cached display state, then tries a best-effort userinfo refresh using the access token under the BigModel
provider namespace in the background; cache with version higher than 2 is treated as future-version data, not requested, not rewritten, not degraded. On success, write back schema version 2 and the new display name. On 401/403, missing tokens, or hitting the `unknown/User` sentinel profile, continue preserving old cache display fields and
write schema version 2, avoiding triggering the definitively failing migration every subsequent startup. Temporary failures such as timeouts, offline, or 5xx only write
`rawProfile.zcodeProfileMigrationRetryAfter` backoff time, not schema version 2; the backoff window allows retrying migration again. Background migration writes must consistently target
`oauth:bigmodel:user_info`, and before saving, confirm the current active provider and BigModel cache are still the old state captured at startup; when the user has logged out, switched to ZAI, or re-logged into BigModel, old migration results must become invalid.

### 2.5 BigModel Fallback Secret Removed

BigModel no longer has a built-in historical fallback secret; when `BIGMODEL_OAUTH_APP_SECRET` is not explicitly configured, the runtime config remains `undefined`. Current BigModel callbacks are consumed only through the zcode OAuth token routing one-time code.

### 2.6 OAuth Callback Consolidation

Desktop OAuth uniformly uses `zcode://oauth/callback`:

- ZAI default `redirectUri` consolidated from `zcode://zai-auth/callback` to `zcode://oauth/callback`
- BigModel keeps `zcode://oauth/callback`
- The Desktop main process no longer recognizes `zcode://zai-auth/callback` / `zcode://bigmodel-auth/callback`
- `ZAI_OAUTH_REDIRECT_URI` / `BIGMODEL_OAUTH_REDIRECT_URI` and legacy redirect URI overrides have been removed

Provider ownership is not determined by the callback host, but by the `state` binding relationship registered when login is initiated.

## 3. Runtime Config Notes (Host Process)

BigModel environment variables:

- `BIGMODEL_OAUTH_ENABLED`
- `BIGMODEL_OAUTH_AUTHORIZE_URL`
- `BIGMODEL_OAUTH_TOKEN_URL`
- `BIGMODEL_OAUTH_USERINFO_URL`
- `BIGMODEL_OAUTH_APP_ID`
- `BIGMODEL_OAUTH_APP_SECRET`

ZAI environment variables:

- `ZAI_OAUTH_ENABLED`
- `ZAI_OAUTH_AUTHORIZE_URL`
- `ZAI_OAUTH_TOKEN_URL`
- `ZAI_OAUTH_USERINFO_URL`
- `ZAI_OAUTH_CLIENT_ID` (compatible with `ZAI_OAUTH_APP_ID`)
- `ZAI_BUSINESS_BASE_URL`: Derives `POST /api/auth/z/login`, used to exchange ZAI OAuth access tokens for business tokens; test environment is `https://api.z.ai`
- `ZAI_BUSINESS_LOGIN_URL`: Full business token exchange URL override, higher priority than `ZAI_BUSINESS_BASE_URL`

ZAI default login chain has switched to backend JWT token exchange, with the authorization entry and business token exchange entry selected based on `ZCODE_ENV=test|production`:

- Authorization page: derived from `ZAI_<ENV>_OAUTH_ORIGIN` `/api/oauth/authorize`, production defaults to `https://chat.z.ai/api/oauth/authorize`
- Token exchange: derived from `ZCODE_<ENV>_BASE_URL` `/api/v1/oauth/token`
- Desktop request body: `{ code, redirect_uri, state }`
- The locally saved `oauth:zai:access_token` is the backend-returned `data.token`

## 4. ZAI Backend JWT Login Chain (Incremental)

ZAI OAuth login is no longer directly requested by the desktop to the third-party ZAI token endpoint. The desktop only opens the authorization page, receives the `zcode://oauth/callback` deep link, and passes `code`, `redirect_uri`, and `state` to the backend `https://zcode.z.ai/api/v1/oauth/token`.

The backend completes the z.ai token exchange, userinfo fetch, user creation, and JWT signing. The client saves `data.token` from the response as `oauth:zai:access_token`, maps `data.user` as `oauth:zai:user_info`, and sets `oauth:active_provider` to `zai`.

## 5. Verification Results

Executed:

- `pnpm vitest run packages/services/test/oauthService.test.ts`
- `pnpm typecheck`
- `pnpm lint`

Result: Passed.

## 6. OAuth Credentials Auto Encryption/Decryption (Incremental)

To prevent OAuth tokens / userinfo from being stored in plaintext, this round adds transparent encryption/decryption at the credential service layer:

- Entry: `packages/services/src/credential/credentialService.ts`
- Encryption/decryption implementation: `packages/services/src/credential/providers/credentialCipherProvider.ts`
- Cipher format: `enc:v1:<iv>.<authTag>.<cipherText>` (AES-256-GCM)

Behavior notes:

1. `credentialService.save` automatically encrypts and writes to `~/.zcode/v2/credentials.json`
2. `credentialService.load` automatically decrypts and returns plaintext to upper-layer business
3. Historical plaintext values (without `enc:v1:` prefix) remain compatibly readable, avoiding login state loss after upgrades

Key notes:

- Priority use of environment variable `ZCODE_CREDENTIAL_SECRET`
- When not configured, use a fallback key generated from the local context (for minimal usable encryption in local/remote modes)

Tests:

- `packages/services/test/credentialService.test.ts`
  - Verify non-plaintext on disk
  - Verify automatic decryption on read
  - Verify historical plaintext compatibility

## 7. Startup Login State Recovery Refactoring (Incremental)

To avoid determining "logged in" solely from local file values at startup, this round consolidates login state recovery to `oauthService.restoreSession()`:

- Interface: `packages/services/src/oauth/oauth.ts`
- Implementation: `packages/services/src/oauth/oauthService.ts`
- UI call entry: `packages/ui/src/Root.tsx`

Behavior changes:

1. Startup recovery no longer directly reads tokens/userinfo in the UI
2. `restoreSession` calls the provider's `fetchUserInfo` using the active provider's access token for real validity verification
3. If the response is unauthorized (401/403), immediately execute the logout flow and clean local login state

BigModel compatibility migration:

- Legacy `auth_token` / `refresh_token` read logic pushed down to the provider directory (`bigmodelProviderAdapter.ts`)
- On compatibility hit, automatically backfill namespaced keys: `oauth:bigmodel:access_token` / `oauth:bigmodel:refresh_token`

Tests:

- `packages/services/test/oauthService.test.ts`
  - Successful startup verification can restore sessions
  - BigModel legacy tokens can be restored and migrated
  - Startup verification 401 triggers logout and credential cleanup

## 8. Post-OAuth Preset Model Supplier Completion (ZAI)

This round completes the ZAI preset model supplier synchronization chain after successful OAuth, aligning with the key-fetch logic of `getZaiApiKey` in `z-work`:

1. Use `oauth:zai:access_token` to call `POST https://api.z.ai/api/auth/z/login` to exchange ZAI business tokens
2. Use business tokens to call `GET /api/biz/customer/getCustomerInfo` to select the default organization/project
3. Call `GET /api_keys` to find `zcode-api-key`; if not found, `POST /api_keys` to create one
4. Call `GET /api_keys/copy/{apiKey}` to get the `secretKey`
5. Write the preset provider's `apiKey` as `apiKey.secretKey`

Implementation and tests:

- Implementation: `packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts`
- Tests: `packages/services/test/modelProviderService.test.ts`
  - `Synchronizes OAuth ZAI supplier config to preset model supplier`
  - `Does not write preset model supplier when ZAI business token exchange fails`
  - `Does not write preset model supplier when ZAI plaintext key fetch fails`

Compatibility strategy:

- BigModel keeps the original fallback behavior (`copy` missing `secretKey` can fall back to bare key)
- ZAI strictly requires `secretKey` to avoid storing unusable bare API keys on disk
