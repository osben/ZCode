# Coding Plan Webview Upgrade E2E Cases

Desktop E2E cases for the Coding Plan upgrade entry that now opens the official site in an embedded webview. Scope: desktop local workspace only; the interface is a WDIO case-local mock server, and no real BigModel / Z.AI plan API is accessed.

## Coverage principles

- Every case has an independent setup, action and assert; "the webview was opened" never counts as purchase-completion coverage.
- After opening the upgrade page, assert that the Windows/Linux minimize, maximize and close window buttons are visible and their hit areas are not covered; macOS shows no such custom-drawn buttons. The difference between the button commands and closing the web page is regression-tested by `overlayWindowControls.test.ts`.
- App semantics after the official-site webview completes payment: close the upgrade webview first, then refresh the current Coding Plan provider.
- The provider refresh goes through the current ProviderSettingsService / Account credential boundary and covers at least the post-purchase `subscription/list` and enterprise-plan queries; account credentials must never be written into the Personal Provider Config.
- These cases send no model request and generate no DeepSeek provider replay fixture.
- CPUW-01 starts with a Personal/Start entitlement that must be resolved through the real Account control plane: the initial customerInfo supplies the organization/project, a controlled mock profile keeps the JWT that queries Start, and the old Personal apiKey is not used to fake an account connection. Inventory loading/error copy covers both the zh and en startup languages.

## Accepted Cases

Current authentication follows the [PAT spec](../model-provider-project-access-token.md): account initialization queries/creates a dedicated Key ID and then issues a PAT; Copy Secret is removed. CPUW-01 checks the PAT request and Copy=0, that the entry's full inventory and the WebView share one funnel, and that refresh/reload does not report twice; CPUW-01/03 also assert that account credentials do not leak into the Personal Config. The request-ledger position is frozen before purchase completion and only the subsequent entitlement refresh is checked, so startup requests cannot stand in as purchase-callback evidence; a valid PAT may be reused and re-issuing after purchase is not required.

The mock PAT here is valid for 10 minutes and the post-purchase subscription query reuses the PAT issued in this case; the enterprise catalog keeps using the current family's OAuth. The two request kinds are checked separately and no credential content is printed.

Latest regression (2026-10-14, macOS Electron, `desktop-e2e-tests-only-20261014c`): CPUW-01/03 passed (2 passed, 0 failed); evidence is `summary.json` in the same-named local artifact directory. It does not claim all desktop E2E or Windows/Linux.

| Case    | Scenario                                                                              | Setup                                                                                                         | Action                                           | Assertions                                                                                                         |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CPUW-01 | The official-site webview notifies the App to close the upgrade dialog and refresh the current provider | Logged into BigModel, current connection is a personal Coding Plan; local mock supports a dedicated Key ID/PAT and a purchase-complete signal | Open the upgrade webview from the avatar menu, trigger purchase completion | Webview closes; afterwards subscription and enterprise plan are queried; initialization issues a PAT, Copy=0, Personal Config has no account credentials |
| CPUW-02 | Official-site webview external link / load failure does not fall back to the old built-in purchase panel | Mock official page fails to load or the interface returns system busy                                         | Open the upgrade entry                           | App shows the webview shell or the load-failure fallback; the old `CodingPlanPurchasePanel` personal-plan buttons are not rendered |
| CPUW-03 | The Z.ai official-site webview notifies the App to close the upgrade dialog and refresh the current provider and Team Plan products | Logged into Z.ai, the webview injects that family's OAuth and JWT, no BigModel credentials injected           | Open the upgrade webview from the avatar menu, trigger Z.ai purchase completion | Webview closes; afterwards subscription and enterprise plan are queried with Z.ai credentials; Personal Config has no account credentials |

## Pruned Cases

| Decision | Pruned combination                  | Reason                                                                                                                                | Representative coverage                                                                                                                                              |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPUW-P01 | Z.AI PayPal / Stripe real payment completion | Needs real third-party payment authorization and cannot run stably in desktop CI; App-side completion semantics are covered by the Z.ai mock webview completion | CPUW-03 covers the Z.ai bridge + App close/refresh; payment methods keep internal unit/component tests                                                              |
| CPUW-P02 | Mobile `/remote` webview completion | Mobile remote control creates no independent official-site purchase webview; the current upgrade webview is a desktop renderer local overlay | CPUW-01 stays in desktop local scope; a remote Environment's Provider Runtime owns its configuration and Registry independently, and this case does not verify cross-Environment Provisioning |
| CPUW-P03 | Full enterprise Team Plan webview purchase | The official-site completion signal's close/refresh semantics for the App equal the personal plan; enterprise product refresh only needs the `refreshTeamPlanProducts` unit assertion | `modelProviderCodingPlan.test.ts` covers Team products refresh; CPUW-01 covers the real webview IPC                                                                  |

## Fixture Contract

- The WDIO mock server provides:
  - `/coding-plan`: simulates the official embedded page.
  - `/api/v2/releases/latest`
  - `/api/v1/client/configs`
  - `/api/biz/customer/getCustomerInfo`
  - `/api/biz/v1/organization/:organizationId/projects/:projectId/api_keys`
  - `/api/biz/v1/organization/:organizationId/projects/:projectId/api_keys/:apiKeyId/access_tokens`
  - `/api/biz/subscription/list`
  - `/api/monitor/usage/quota/limit`
- The mock server offers `/__e2e/coding-plan/requests` for the spec to assert requests.
- `CPUW-01` / `CPUW-03` use `fast-text` timing and do not depend on real streaming model requests.
- The Coding Plan webview origin is a Vite build-time constant. Both targeted runs and the default full glob must start the same shard-owned mock origin before the desktop build; the origin cannot be injected only at worker `beforeSession`.
- One full shard may run sold-out, system-busy and refresh-provider in turn. The mock origin stays unchanged over the shard lifetime; each upgrade worker resets `scenario`, purchase state and the request ledger through the test control endpoint before starting Electron; other workers must not shut down the launcher-owned server.
