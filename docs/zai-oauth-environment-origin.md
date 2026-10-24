# ZAI OAuth Environment Origin

## Background

The ZAI OAuth login entry uses the `/api/oauth` prefix; the production default is
`https://chat.z.ai/api/oauth/authorize`. To support a test-environment login entry without
scattering full authorization URLs across clients, URLs derive from per-environment constants.

## Approach

- Host/service and Web/Vite read only link constants grouped by `ZCODE_ENV=test|production`.
- `ZAI_<ENV>_OAUTH_ORIGIN` derives the ZAI OAuth `authorizeUrl` and `userinfoUrl`.
- `ZAI_<ENV>_BUSINESS_BASE_URL` derives the ZAI business token-exchange endpoint `/api/auth/z/login`.
- Existing full-URL overrides are kept: `ZAI_OAUTH_AUTHORIZE_URL` and `ZAI_OAUTH_USERINFO_URL` take priority over the origin-derived values, for compatibility with old config.
- The full business-login URL override is kept: `ZAI_BUSINESS_LOGIN_URL` takes priority over `ZAI_BUSINESS_BASE_URL`, for tests or endpoint-path migration only.
- Token exchange goes to the ZCode API derived from `ZCODE_<ENV>_BASE_URL`: desktop/host uses `${baseUrl}/api/v1/oauth/token`; Web requests `/api/v1/oauth/token` by default and the Vite proxy forwards to the base url selected by `ZCODE_ENV`.

## Test environment config

```env
ZCODE_TEST_BASE_URL=https://zcode.z.ai
ZAI_TEST_OAUTH_CLIENT_ID=client_P8X5CMWmlaRO9gyO-KSqtg
ZAI_TEST_OAUTH_ORIGIN=https://chat.z.ai
ZAI_TEST_BUSINESS_BASE_URL=https://api.z.ai
```

Local development defaults to `ZCODE_ENV=test`, so `pnpm dev:web` and `pnpm dev:desktop:test` both use
the test login entry. Do not write `ZCODE_ENV` in `.env*`; the launch script or CI injects the current
environment.

Production configures the production client id explicitly in `.env.production`:

```env
ZCODE_PRODUCTION_BASE_URL=https://zcode.z.ai
ZAI_PRODUCTION_OAUTH_ORIGIN=https://chat.z.ai
ZAI_PRODUCTION_BUSINESS_BASE_URL=https://api.z.ai
ZAI_PRODUCTION_OAUTH_CLIENT_ID=client_P8X5CMWmlaRO9gyO-KSqtg
```
