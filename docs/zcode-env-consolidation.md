# ZCODE_ENV consolidation

## Background

Historically the desktop app used `ZCODE_ENV`, `ZCODE_API_ENV` and `ZCODE_DESKTOP_BUILD_ENV*` for build
shape, API environment and release-artifact environment, which let test artifacts carry dev behavior
and made CI defaults hard to judge.

## Goal

`ZCODE_ENV` is the single product environment variable; the enum keeps only:

- `test`: test environment, uses test API / OAuth endpoints, may show test-only menus.
- `production`: production environment, uses production API / OAuth endpoints, hides test-only menus.

Local development is not a product environment. A generic builder that does not set `ZCODE_ENV`
explicitly defaults to `test`; the default desktop launch and remote init entries select production
explicitly (rules below). Local debugging capability is decided by run shape, e.g. whether Electron is
packaged, Vite dev mode or a dedicated debug switch.

## Configuration rules

`.env*` files hold only links and public settings such as the OAuth client id, never the current
product environment. Links are grouped by environment prefix so host, Vite and business code do not
redeclare the same URL:

- `ZCODE_TEST_BASE_URL`, `ZCODE_PRODUCTION_BASE_URL`
- `ZAI_TEST_OAUTH_ORIGIN`, `ZAI_PRODUCTION_OAUTH_ORIGIN`
- `ZAI_TEST_BUSINESS_BASE_URL`, `ZAI_PRODUCTION_BUSINESS_BASE_URL`
- `ZAI_TEST_OAUTH_CLIENT_ID`, `ZAI_PRODUCTION_OAUTH_CLIENT_ID`

Build config picks the matching links by `ZCODE_ENV` and injects public `VITE_*` values into the
renderer. The ZCode API, remote-control links and zcode-plan OpenAI/Anthropic entries in renderer,
host/service and agent are all derived by the `@zcode/shared` endpoint resolver; business code must
not hand-write the `zcode.z.ai` zcode-plan URL again.

## Endpoint resolver

`packages/shared/src/zcodeEndpoint.ts` is the single source of truth for product-environment domains.
Runtime callers must pass the current `env` to the resolver explicitly and must not read the
compile-time global `ZCODE_ENV` inside a service/provider.

Default domain matrix:

| Product environment | ZCode API              | ZAI OAuth             | ZAI Business API     | BigModel API          |
| ------------------- | ---------------------- | --------------------- | -------------------- | --------------------- |
| `test`              | `https://zcode.z.ai`   | `https://chat.z.ai`   | `https://api.z.ai`   | `https://bigmodel.cn` |
| `production`        | `https://zcode.z.ai`   | `https://chat.z.ai`   | `https://api.z.ai`   | `https://bigmodel.cn` |

Override priority:

1. Full URL overrides first, e.g. `ZAI_OAUTH_AUTHORIZE_URL`, `BIGMODEL_OAUTH_AUTHORIZE_URL`.
2. Un-prefixed origin/base overrides next, e.g. `ZCODE_BASE_URL`, `ZAI_OAUTH_ORIGIN`, `ZAI_BUSINESS_BASE_URL`, `BIGMODEL_API_BASE_URL`.
3. Environment-scoped overrides next, e.g. `ZCODE_TEST_BASE_URL`, `ZAI_PRODUCTION_OAUTH_ORIGIN`, `BIGMODEL_TEST_API_BASE_URL`.
4. Finally the shared resolver's built-in default domains.

`.env.development` holds only the test-environment link constants commonly used in local development
and does not select the product environment itself. The desktop launch scripts inject `ZCODE_ENV`
explicitly per chosen command; the default `pnpm dev:desktop` currently points to production, and the
test environment must be chosen explicitly with `pnpm dev:desktop:test`.

## Launch and CI

- `pnpm dev:desktop` defaults to `pnpm dev:desktop:prod`.
- `pnpm dev:desktop:test` injects `ZCODE_ENV=test` explicitly.
- `pnpm dev:desktop:prod` injects `ZCODE_ENV=production` explicitly.
- `pnpm bootstrap:with-remote` injects `production` into all build subprocesses when `ZCODE_ENV` is unset or blank; an explicit `test|production` is preserved and an invalid value is rejected before any init action. Test-environment artifacts pair with `pnpm dev:desktop:test`; see [Bootstrap commands](bootstrap.md).
- CI defaults to `production` when `ZCODE_ENV` is not passed.
- CI accepts only `ZCODE_ENV=test|production` and no longer reads `ZCODE_DESKTOP_BUILD_ENV*` or `ZCODE_API_ENV`.
- `ZCODE_ENV=test` may only build, collect and upload test artifacts; `publish-release.sh` rejects calling the production release API from a test environment.

## Installer naming

Production installers keep the original file name, e.g. `ZCode-3.0.0-mac-x64.dmg`. Test installers
append `_TEST` after the architecture, e.g. `ZCode-3.0.0-mac-x64_TEST.dmg`. The same rule applies to
macOS, Windows and Linux artifacts so test and production packages are not confused during download,
upload or manual acceptance. The build-artifact Feishu notification shows a "test environment" /
"production environment" marker; the release publish notification is for production releases only.
