# OAuth Multi-Provider Implementation Notes (Desktop)

Last updated: 2026-04-03

## 1. Scope

Structural reorganization of Desktop OAuth for peer-level provider extension, with provider-owned
configuration and no provider-specific exception logic at common entry points.

## 2. Structure

### 2.1 Shared keeps only domain types

`packages/shared/src/oauth.ts` keeps only OAuth domain types and provider ids (`bigmodel`, `zai`);
no provider default endpoint config.

### 2.2 Provider configs live with providers

`packages/services/src/oauth/providers/` holds `bigmodelProviderConfig.ts`,
`zaiProviderConfig.ts` and `configUtils.ts`. Each provider owns its default config and environment
variable mapping. `packages/services/src/oauth/runtimeConfig.ts` only defines
`OAuthProviderRuntimeConfig` / `OAuthRuntimeConfig` and aggregates the provider runtime configs.

### 2.3 Credential repo

`packages/services/src/oauth/repo/oauthCredentialRepo.ts` handles only namespaced keys:
`oauth:<provider>:access_token`, `oauth:<provider>:refresh_token`, `oauth:<provider>:user_info`,
`oauth:active_provider`. It no longer infers or migrates providers through a global
`LEGACY_PROVIDER_ID`.

BigModel `oauth:bigmodel:user_info` stores a normalized profile marked with
`rawProfile.zcodeProfileSchemaVersion = 2`, meaning the display name follows the priority
`customerName -> nickName -> "user"`. During startup `restoreCachedSession()`:

- An old BigModel cache without the marker or with a version below 2 returns the local cached
  display state immediately, then a best-effort background userinfo refresh runs with the access
  token under the BigModel provider namespace.
- A cache with a version above 2 is future-version data: not requested, not rewritten, not
  degraded.
- On success, schema version 2 and the new display name are written back. On 401/403, a missing
  token, or the `unknown/User` sentinel profile, the old cache display fields are kept and schema
  version 2 is written, so a definitively failing migration is not retried at every startup.
- Temporary failures (timeout, offline, 5xx) only write the backoff time
  `rawProfile.zcodeProfileMigrationRetryAfter` and not schema version 2; after the backoff window
  the migration may retry.
- Background migration writes always target `oauth:bigmodel:user_info`, and before saving they
  confirm the current active provider and BigModel cache are still the state captured at startup;
  if the user logged out, switched to ZAI or re-logged into BigModel, the old migration result is
  invalid.

### 2.4 BigModel fallback secret removed

BigModel has no built-in historical fallback secret; without an explicit
`BIGMODEL_OAUTH_APP_SECRET` the runtime config stays `undefined`. BigModel callbacks are consumed
only through the zcode OAuth token routing one-time code.

### 2.5 Callback consolidation

Desktop OAuth uniformly uses `zcode://oauth/callback`: the ZAI default `redirectUri` moved from
`zcode://zai-auth/callback` to it, BigModel keeps it, Desktop main no longer recognizes
`zcode://zai-auth/callback` / `zcode://bigmodel-auth/callback`, and `ZAI_OAUTH_REDIRECT_URI` /
`BIGMODEL_OAUTH_REDIRECT_URI` and legacy redirect URI overrides are removed. Provider ownership is
determined by the `state` binding registered when login starts, not by the callback host.

## 3. Runtime config (host process)

BigModel environment variables: `BIGMODEL_OAUTH_ENABLED`, `BIGMODEL_OAUTH_AUTHORIZE_URL`,
`BIGMODEL_OAUTH_TOKEN_URL`, `BIGMODEL_OAUTH_USERINFO_URL`, `BIGMODEL_OAUTH_APP_ID`,
`BIGMODEL_OAUTH_APP_SECRET`.

ZAI environment variables:

- `ZAI_OAUTH_ENABLED`, `ZAI_OAUTH_AUTHORIZE_URL`, `ZAI_OAUTH_TOKEN_URL`, `ZAI_OAUTH_USERINFO_URL`
- `ZAI_OAUTH_CLIENT_ID` (also accepts `ZAI_OAUTH_APP_ID`)
- `ZAI_BUSINESS_BASE_URL`: derives `POST /api/auth/z/login`, used to exchange ZAI OAuth access
  tokens for business tokens; the test environment is `https://api.z.ai`
- `ZAI_BUSINESS_LOGIN_URL`: full business token exchange URL override, higher priority than
  `ZAI_BUSINESS_BASE_URL`

The default ZAI login chain uses backend JWT token exchange; the authorization entry and the token
exchange entry follow `ZCODE_ENV=test|production`:

- Authorization page: derived from `ZAI_<ENV>_OAUTH_ORIGIN` + `/api/oauth/authorize`; production
  defaults to `https://chat.z.ai/api/oauth/authorize`.
- Token exchange: derived from `ZCODE_<ENV>_BASE_URL` + `/api/v1/oauth/token`.
- Desktop request body: `{ code, redirect_uri, state }`.
- The locally saved `oauth:zai:access_token` is the backend-returned `data.token`.

## 4. ZAI backend JWT login chain

Desktop does not call the third-party ZAI token endpoint directly. It opens the authorization page,
receives the `zcode://oauth/callback` deep link, and sends `code`, `redirect_uri` and `state` to
the backend `https://zcode.z.ai/api/v1/oauth/token`. The backend completes the z.ai token
exchange, userinfo fetch, user creation and JWT signing. The client saves `data.token` as
`oauth:zai:access_token`, maps `data.user` as `oauth:zai:user_info`, and sets
`oauth:active_provider` to `zai`.

## 5. Credential encryption

OAuth tokens/userinfo are encrypted transparently at the credential service layer:

- Entry: `packages/services/src/credential/credentialService.ts`; implementation:
  `packages/services/src/credential/providers/credentialCipherProvider.ts`.
- Cipher format: `enc:v1:<iv>.<authTag>.<cipherText>` (AES-256-GCM).
- `credentialService.save` encrypts and writes to `~/.zcode/v2/credentials.json`;
  `credentialService.load` decrypts and returns plaintext. Historical plaintext values (no `enc:v1:`
  prefix) stay readable so upgrades do not lose login state.
- Key: environment variable `ZCODE_CREDENTIAL_SECRET` first; otherwise a fallback key generated from
  the local context (minimal usable encryption for local/remote modes).
- Tests: `packages/services/test/credentialService.test.ts` (non-plaintext on disk, automatic
  decryption on read, historical plaintext compatibility).

## 6. Startup login state recovery

Login state recovery is consolidated in `oauthService.restoreSession()` (interface
`packages/services/src/oauth/oauth.ts`, implementation
`packages/services/src/oauth/oauthService.ts`, UI call entry `packages/ui/src/Root.tsx`):

1. The UI no longer reads tokens/userinfo directly at startup.
2. `restoreSession` verifies real validity by calling the provider's `fetchUserInfo` with the active
   provider's access token.
3. An unauthorized response (401/403) immediately runs the logout flow and cleans local login state.

BigModel compatibility: the legacy `auth_token` / `refresh_token` read logic lives in the provider
directory (`bigmodelProviderAdapter.ts`); on a compatibility hit it backfills the namespaced keys
`oauth:bigmodel:access_token` / `oauth:bigmodel:refresh_token`.

Tests in `packages/services/test/oauthService.test.ts`: startup verification success restores the
session; BigModel legacy tokens are restored and migrated; startup 401 triggers logout and
credential cleanup.

## 7. Post-OAuth preset model provider completion (ZAI)

After a successful OAuth, the ZAI preset model provider is synchronized, aligned with the key-fetch
logic of `getZaiApiKey` in `z-work`:

1. Exchange `oauth:zai:access_token` for a ZAI business token with
   `POST https://api.z.ai/api/auth/z/login`.
2. Call `GET /api/biz/customer/getCustomerInfo` with the business token to pick the default
   organization/project.
3. Call `GET /api_keys` to find `zcode-api-key`; if absent, `POST /api_keys` to create one.
4. Call `GET /api_keys/copy/{apiKey}` to get the `secretKey`.
5. Write the preset provider's `apiKey` as `apiKey.secretKey`.

Implementation: `packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts`. Tests in
`packages/services/test/modelProviderService.test.ts` (names kept as in the file):
`Synchronizes OAuth ZAI supplier config to preset model supplier`,
`Does not write preset model supplier when ZAI business token exchange fails`,
`Does not write preset model supplier when ZAI plaintext key fetch fails`.

Compatibility: BigModel keeps the original fallback (a `copy` response missing `secretKey` can fall
back to the bare key); ZAI strictly requires `secretKey` so unusable bare API keys are never stored.

## 8. Verification (at last update)

`pnpm vitest run packages/services/test/oauthService.test.ts`, `pnpm typecheck` and `pnpm lint`
passed.
