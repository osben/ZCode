# Desktop Auth/Config E2E Cases

## Todo103 G09: integrated acceptance of fixed staging login behavior

This section is the integrated acceptance scope; it does not override or rewrite the historical run records below.

| Case | Source and action | Acceptance and limits |
| --- | --- | --- |
| AUTH-05 | d17cb6a800; formal `oauth-login-failure-cancel.test.ts`, delivers an invalid state through the preload callback | After the real Host rejects the callback the UI shows only the failure block; after cancel it returns to the provider list and the login entry does not close. Keeps the upstream formal case identity; not promoted by this round on its own |
| AUTH-06 | a172e9c398 / 71a195b6be / f26d4e75fb; pending `access-token-401-auto-logout.test.ts` | A case-local HTTP pauses the real Host userinfo, then returns 401; the current OAuth is cleared, Bot credentials kept, the expiry prompt shown once, and the existing RelaunchApp is confirmed as issued. The IPC truncates the actual restart; this does not pose as a verified real restart |

Both cases produce no model request; the manifest declares `providerRequestPolicy=none`. The business token/JWT of AUTH-06 are synthetic credentials with different values, and other control-plane HTTP returns 200, so the original JWT-invalidation path cannot mask the new access-token classification. The mock only counts whether the synthetic token was hit and never outputs credentials in artifacts. Service-layer controlled-timing tests own late 401, refresh write-back, duplicate candidates and accountIdentity protection; the Electron case does not claim those micro races. AUTH-06 stays pending; local Pro verification is not mobile shared-host / all-platform Windows verification; no new Host and no change of the continuous/replayable path.

The upstream AUTH-06 run record is kept as fixed-staging historical evidence and does not count as a pass of this branch; this round's actual results are in Todo103 ledger G09.

This document records the formal E2E cases of desktop auth/config. Scope: desktop local cold start, OAuth login-state restore and local config cleanup; it does not cover mobile `/remote`, remote workspace, replayable recovery or real OAuth browser callbacks.

Every case must:

- Have independent setup, action and assert; merely passing through the login page does not count as coverage.
- Declare `providerRequestPolicy: "none"` in the manifest if it triggers no model request.
- If it writes local config by WDIO seed, state the seed file and the cleanup boundary to verify.

## Default startup credential contract

Ordinary, local Personal Provider, remote replay and unknown specs by default write an empty object to `~/.zcode/v2/credentials.json` of the isolated HOME. A missing spec, empty list or suite glob must not implicitly restore fake OAuth / JWT either; a new ordinary case needs no "no-account exception" registration.

```text
worker's concrete spec -> existing account mock selection -> cold-start seed -> Electron / Host
                           |
                           +-- no account mock selected: empty credentials
                           +-- Coding Plan specific: synthetic OAuth of the matching account family only
                           +-- JWT specific: keeps the synthetic JWT that special case declares
```

Whether an account mock is enabled is passed from the existing WDIO fixture selection into the credential generator; no separate ordinary-case exclusion list is maintained. The BigModel special case seeds only BigModel OAuth, without a fake Z.AI identity. JWT is kept for existing explicit special cases and is not injected by default just because an account mock exists. Remote replay always starts without an account; real account import, corrupted ciphertext and expired JWT special cases keep their own explicit setup.

Regression requirements: unit tests cover default empty credentials, Windows / POSIX paths, explicit account fixtures, the JWT special case, remote priority and input immutability; Browser E2E checks that an ordinary startup has no account key; Coding Plan E2E checks only the matching account family and then performs the original real UI operations. Isolation must not be replaced by masking the login-invalidated dialog or loosening assertions.

## AUTH-01: Cold-start recovery from corrupted OAuth credentials

### Case definition

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/oauth-credential-recovery.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/oauth-credential-recovery.json` |
| Provider fixture | none, `providerRequestPolicy: "none"` |
| Status | promoted, formal-path cold-start case |

### Scenario

The user's local `credentials.json` retains an OAuth login state whose `oauth:active_provider` is ciphertext this machine cannot decrypt. On desktop cold start, OAuth session restore must not leave the login entry in a "load failed / no login provider" dead state; the system must clean the corrupted login state and show the login providers again.

This case verifies only "corrupted OAuth credentials -> cold-start recovery -> login providers visible -> corrupted login state cleaned". It does not cover real web login, OAuth callback, token refresh, purchase flow, remote workspace or model sending.

Business-token corruption regression (2026-10-12): run the same AUTH-01 with `ZCODE_E2E_CORRUPT_OAUTH_TOKEN_PROVIDER=bigmodel` or `zai`; the seed keeps the active provider, user profile and shared JWT healthy and only the business access token is undecryptable ciphertext. Verifies login providers visible, all OAuth credentials cleaned, independent Bot credentials kept. The default run still covers a corrupted active provider; recovery interleaved with a new login, ordinary IO errors and request cancellation are covered by service-layer controlled tests.

Limit: AUTH-01 currently covers only the desktop local host; OAuth corruption recovery of remote workspace and mobile `/remote` is protected by service-level regression tests; a formal remote E2E case is still to be added.

### Steps

1. WDIO `beforeSession` cleans the isolated HOME.
2. After `wdio.conf.ts` recognizes `oauth-credential-recovery.test.ts`, write the corrupted OAuth seed to `~/.zcode/v2/credentials.json`.
3. Start the desktop local default window.
4. Wait for the login entry to render.
5. Check both Z.ai and BigModel login providers are visible.
6. Check no OAuth error prompt is shown.
7. Read `credentials.json` in the isolated HOME and confirm the corrupted OAuth login state was cleaned.

### Verification items

| ID | Item | Why it is valid | Assertion location |
| --- | --- | --- | --- |
| AUTH-01-A | Z.ai login entry visible | Proves `oauthService.getProviders()` did not make the entry unavailable because of corrupted credentials | `waitForTestIdByDom(testId(TID_OAUTH_LOGIN_BUTTON, "zai"))` |
| AUTH-01-B | BigModel login entry visible | Proves the multi-provider login list still shows fully | `waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON)` |
| AUTH-01-C | No OAuth error prompt on the login page | Proves corrupted credentials are handled as a recoverable login state without exposing the low-level decrypt error | `expectNoOAuthErrorAlert()` |
| AUTH-01-D | OAuth-related corrupted credentials cleaned | Proves the next start does not stay stuck on the same invalid login state | `waitForCorruptOAuthCredentialsCleanup()` |

### Fixture contract

- No provider request: the manifest uses `providerRequestPolicy: "none"` and empty `requests`.
- The input fixture is the WDIO cold-start seed `~/.zcode/v2/credentials.json`.
- Keys to clean include `oauth:active_provider`, Z.ai/BigModel access token, refresh token, user info and the legacy `zcodejwttoken`.

### Promotion

The spec lives at the formal path `packages/desktop/test/e2e/oauth-credential-recovery.test.ts`, is collected by default `./test/e2e/**/*.test.ts` and is not under `manual-review/pending`, so the move flow of `promote-conversation-e2e.mjs` is not run; the promotion supplied the formal manifest and this coverage doc.

### Verification outcome

- 2026-07-09: `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/oauth-credential-recovery.test.ts` passed (1 spec / 1 case). On cold start with undecryptable OAuth credentials both providers are visible, no OAuth error prompt, corrupted state cleaned.
- 2026-10-12 business-token corruption fix: single BigModel/ZAI business token corruption and default active-provider corruption both pass isolated macOS Electron AUTH-01; login providers are available after OAuth cleanup, independent Bot credentials kept. ZAI initially stopped at the startup page; runtime RPC logs and the refresh chain located a background repository cleanup callback waiting for the Account Source's own next refresh; after fixing that circular wait the rebuild passed.
- 260 services-targeted unit tests and 18 login-recovery/onboarding unit tests pass, covering business/shared token corruption on both platforms, ordinary IO errors, old recovery interleaved with new login, verification fetch/body cancellation, original request timeout, observation budget and shared subscription cancellation. AUTH-06 on the same final build verifies invalidation cleanup, single prompt, entering the login entry after confirmation with no relaunch command. Typecheck, E2E typecheck, lint and architecture checks pass (baseline lint warnings kept).
- Not run: mobile shared-host, remote workspace, Windows/Linux, real backend revocation. The auth owner and the desktop-continuous / web-remote-replayable protocols are unchanged.
- Docker admission not run: the case does not depend on provider replay and is not in the conversation Docker preset.

## AUTH-02: Provider readiness gate and recovery

### Case definition

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/provider-readiness-agent-startup.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/provider-readiness-agent-startup.json` |
| Provider fixture | none, `providerRequestPolicy: "none"` |
| Status | promoted, formal-path cold-start case |

### Scenario

Desktop local cold-starts with an isolated HOME; the CLI session DB and the App tasks-index are seeded with the same interactive history, but the user has no OAuth login, API Key or any other structurally usable provider. After the login entry renders, the user skips for now and enters the default workspace; the sidebar must show the tasks-index history; a read-only subscription starts the sole session Agent on demand, clicking reads the persisted body from the CLI, while the home keeps showing the `modelConfigMissing` banner. Through the same project entry the user returns to a draft and types text; with no model the send button is disabled, the original text is kept and the pending command is empty. Then from the missing-model banner the user enters settings, creates a Personal Provider with an independent ID via the BigModel Template, and confirms save on API Key input blur; the same workspace must reuse that Agent, keep the count at 1, finish draft model hydration, clear the banner, and restore the send button while keeping the original text. The test does not click the restored send button.

This case verifies only local structural readiness, the process start boundary and draft hydration; it sends no prompt, does not verify provider connectivity over the network, and does not cover the plugin/MCP management Agent. Remote workspace uses service/integration cases for the boundary before and after the desktop registry delivers.

### Verification items

| ID | Item | Why it is valid |
| --- | --- | --- |
| AUTH-02-A | Login/provider entry available when unconfigured | `waitForTestIdByDom(TID_LOGIN_USE_API_KEY_BUTTON)` |
| AUTH-02-B | After skipping, the draft home shows the missing-model banner | `TID_CHAT_ERROR_BANNER` echoes "no model available" |
| AUTH-02-C | Send button disabled by UI admission when unconfigured | After typing the button stays disabled, composer text kept, pending command ledger empty |
| AUTH-02-D | History visible and readable when unconfigured | The seeded interactive CLI session's sidebar row, user body and assistant body are visible, proving the real sessions-index/conversation topic works |
| AUTH-02-E | No deferred draft/retry when unconfigured | service/UI focused tests assert `provider_not_ready` stays idle and projects the banner |
| AUTH-02-F | Read-only Agent count of the target workspace is 1 when unconfigured | The resource-manager snapshot asserts 1 by the `ZCodeProject` workspace tag; the system conversation sibling is not counted; only sessions-index/history reads are allowed and no session create/model command is produced |
| AUTH-02-G | After saving a provider the sole target-workspace Agent is reused | Agent rows of the same workspace stay at 1 and a second assertion after a stable window is still 1; read -> write does not start a duplicate |
| AUTH-02-H | After configuration model hydrated, draft kept and sendable again | The model trigger points to the new Personal Provider instance with a non-empty model; banner gone, original text kept, send button enabled |

### Fixture contract

- The manifest uses `providerRequestPolicy: "none"` and empty `requests`; the whole case produces no model request.
- The input fixture seeds both the Agent CLI SQLite interactive session/message/part and the App `tasks-index` membership; the sidebar row comes from tasks-index and the body must be read through a real read-only conversation subscription. The rest is the empty auth/provider state of the isolated HOME and the local Personal Provider config created and saved through the Template during the test.
- Process assertions read the process snapshot shared by the resource manager and the main-process lifecycle registry, not `pgrep`/`ps` that fit a single OS.

### Verification outcome

- 2026-07-20: `pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/provider-readiness-agent-startup.test.ts` passed (1 spec / 1 case). `upstream-provider.json` `records` is empty, matching `providerRequestPolicy: "none"`. With an empty provider cold start real history is visible and openable, the first send of a new draft is still rejected by the gate; after saving a provider the same target-workspace Agent is reused and model hydration completes.
- 2026-10-16 rerun after the fix: 1 spec / 1 case passed. The new assertions confirm that after the first Provider is ready the original text is kept, the send button enabled, the pending command still empty, the same-workspace Agent stays at 1; the model control validates the Personal instance identity via the shared decode function. Shared hook unit tests cover local/remote identity; a real mobile pairing E2E was not run.
- Docker admission not run: an auth/config case with no provider replay dependency, not in the conversation Docker preset.

## AUTH-03: Re-authentication after ZCode JWT expiry

Isolated Electron automatic recheck (2026-10-12): 1 case passed; it confirms that this round's runtime recovery entry changes did not break cold-start expiry cleanup and the login entry; the case stays pending.

### Case definition

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/manual-review/pending/jwt-expiry-reauthentication.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/jwt-expiry-reauthentication.json` |
| Provider fixture | none, `providerRequestPolicy: "none"` |
| Status | candidate case, awaiting human confirmation of the expiry prompt and re-login entry before promotion |

### Scenario

Desktop local cold-starts with an isolated HOME; `credentials.json` is seeded with a complete cached Z.ai OAuth session and a `zcodejwttoken` whose `exp` is clearly in the past. When the Local Host restores the cached session it must first clean the invalid authentication facts and then notify the renderer to show the "login expired" prompt; after the user clicks "重新登录" (Log in again) it goes straight to the existing Welcome login page, with no active-logout confirmation and no App relaunch.

This case verifies only desktop local cold-start recovery and the UI interaction; it triggers no real OAuth callback, token refresh or provider/model request, and does not change remote workspace, mobile `/remote` or task/session realtime state.

### State and operation order

```text
WDIO cold-start seed
  complete OAuth cache + expired JWT
             |
             v
Local Host restoreCachedSessionState
             |
             +--> first clean active provider / token / user_info / JWT
             |
             v
renderer shows the "login expired" AlertDialog
             |
             +--> while the dialog is still open read credentials.json to confirm cleanup finished
             |
             v
user clicks "重新登录"
             |
             v
Welcome shows the Z.ai + BigModel login entries
```

### Verification items

| ID | Item | Why it is valid |
| --- | --- | --- |
| AUTH-03-A | Expiry prompt title and description visible | Proves the structured `reauthentication-required` reached the renderer instead of restoring a fake login state |
| AUTH-03-B | Authentication credentials cleaned before the prompt is confirmed | Proves the AlertDialog is not the blocking point for cleaning authentication facts |
| AUTH-03-C | Clicking "重新登录" enters Welcome | Proves the user can get from the expired state back to the existing login flow, not a dead state with no exit / no re-login |
| AUTH-03-D | Z.ai and BigModel login entries visible | Proves the re-authentication page has full provider choice |
| AUTH-03-E | No active-logout confirmation shown | Proves expiry recovery did not go through the "confirm disconnect" or running-session second-confirmation flow |

### Fixture contract

- The manifest uses `providerRequestPolicy: "none"`, `noProviderRequests: true` and empty `requests`.
- The input fixture is `~/.zcode/v2/credentials.json` written by WDIO into the isolated HOME before the App starts.
- The JWT contains only test header/payload/signature; the payload `exp` is fixed in the past and does not depend on signature validity.
- Keys to clean include `oauth:active_provider`, Z.ai access token, refresh token, user info and `zcodejwttoken`.
- Currently in `manual-review/pending`; only after human confirmation of the visual interaction may it move to the formal path and this section's status be updated.

### Automatic run outcome

2026-08-06: `ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/manual-review/pending/jwt-expiry-reauthentication.test.ts` passed (1 spec / 1 case). Found and fixed at runtime: `open=false` of the provider startup gate unconditionally cleared `session-expired`, so after the user's confirmation the re-login page was covered by the workspace; the gate now closes only its own `startup-provider-required`. The provider capture has no model request, matching `providerRequestPolicy: "none"`. Only the automatic run is done; no human visual acceptance is recorded, so it stays in `manual-review/pending` with no promotion or Docker admission.

<!-- The fixed-staging JWT scenario was originally numbered AUTH-05, colliding with the login-cancel number above; it is named AUTH-JWT-401 here, and historical evidence does not count as a pass of this round. -->

## AUTH-JWT-401: Running-session ZCode JWT 401 logs out and restarts

### Current behavior (2026-10-12)

The shared JWT and the business access_token use the same expiry prompt entry; confirming goes straight to the Welcome login page. The case now uses a local HTTP fixture to pause the real Host balance request and return HTTP 401; it no longer substitutes a main `net.fetch` mock for the Host transport. Before confirmation OAuth/JWT are cleaned and independent Bot credentials kept; after confirmation it asserts the login entry is visible and neither app.relaunch nor quit was called. Isolated Electron recheck: 1 case passed. The case stays pending; the restart assertions and run records below are historical background.

### Case definition

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/manual-review/pending/jwt-401-auto-logout.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/jwt-401-auto-logout.json` |
| Provider fixture | none, `providerRequestPolicy: "none"` |
| Status | candidate case, awaiting human confirmation of the 401 trigger prompt, credential cleanup and restart action before promotion |

### Scenario (historical restart variant)

Desktop local cold-starts with an isolated HOME and restores a valid OAuth session. After entering the workspace the test uses an Electron network mock so later ZCode control-plane requests return a plain HTTP 401; the request carries an Authorization equal to the local `zcodejwttoken`, so it must trigger the Host's unified logout rather than show an ordinary network error. The test asserts credentials were cleaned before the prompt is confirmed, and after the user confirms the existing `RelaunchApp` is called, to avoid really quitting the test process.

This case verifies only the running desktop local 401 invalidation observation, credential cleanup, prompt and restart command; it does not cover real revoke, Agent model transport, Official MCP, remote workspace or mobile `/remote`.

### State and operation order

```text
valid OAuth session + zcodejwttoken
             |
             v
open model provider settings, trigger a ZCode request
             |
             v
Electron net.fetch mock returns 401
             |
             v
Host compares the current JWT -> logout cleans credentials -> broadcasts the invalidation event
             |
             v
Renderer shows "login expired"
             |
             +--> before confirmation: credentials.json has no OAuth/JWT key
             |
             v
user confirms -> DesktopCommandIds.RelaunchApp
```

### Verification items

| ID | Item | Why it is valid |
| --- | --- | --- |
| AUTH-JWT-401-A | A running 401 shows the login-expired prompt | Proves the request-exit observation and the Host broadcast chain actually work |
| AUTH-JWT-401-B | OAuth/JWT credentials cleaned before confirmation | Proves the prompt does not block cleaning authentication facts |
| AUTH-JWT-401-C | `RelaunchApp` called after confirmation | Proves the prompt action reuses the existing restart flow |
| AUTH-JWT-401-D | Plain 401 mock does not depend on a dedicated response header | Proves compatibility with a server that currently has no `X-ZCode-JWT-Invalid` response header |

### Fixture contract

- The manifest uses `providerRequestPolicy: "none"`, `noProviderRequests: true` and empty `requests`.
- The input fixture is the default E2E startup credential seed; the running 401 is injected by the Electron `net.fetch` mock and never reaches a real service.
- The mock returns only status and success flag and never records or exposes Authorization/JWT values.
- Currently in `manual-review/pending`; promote after human confirmation; no Docker admission.

## AUTH-04: Subagent Coding Plan Model Selection ready after login

### Case definition

| Field | Content |
| --- | --- |
| Spec | `packages/desktop/test/e2e/subagent-coding-plan-login-catalog-stale.test.ts` |
| Fixture manifest | `packages/desktop/test/e2e/fixtures/cases/auth-config/subagent-coding-plan-login-catalog-stale.json` |
| Provider fixture | No model request; OAuth, `release/latest`, `client/configs`, plan and API key endpoints are fixed by a case-local HTTP mock |
| Status | Promoted; formal-path post-login UI usability and current Environment Model Selection readiness case |

### Scenario

Desktop local cold-starts with an isolated HOME and empty OAuth credentials. If career onboarding covers the app, close it with a real Escape first, then observe Welcome or the logged-out workspace. The current Local Host is preloaded with a custom DeepSeek model that has reasoning levels. After the user completes BigModel OAuth, without restart and without manually saving a Provider, the user opens Subagent settings and in the same `general-purpose` row selects the custom model and then the Coding Plan GLM-5.3.

The sole source of model membership and capabilities in Settings is the Local Host Model Selection View. E2E reads only the View props the Subagent row actually consumes, verifying the model catalog and reasoning control before/after login; it no longer reads the workspace `configOptions` that left the model-catalog responsibility, nor artificially writes ready. This case covers only desktop local; mobile `/remote` is verified separately.

### State and operation order

```text
isolated HOME -> close career onboarding -> logged-out workspace
                                  ↓
                   Subagent Local Host View contains the custom model
                                  ↓
                       BigModel OAuth callback
                                  ↓
                 Account Overlay / Local Host View refresh
                                  ↓
                    Subagent selects the custom model: effort available
                                  ↓
                    select Coding Plan GLM-5.3: effort available
                                  ↓
                 the View the page consumes contains GLM-5.3 high / max
```

### Verification items

- Before login the custom model exists and the Coding Plan model does not.
- The real OAuth URL, state and deep link complete the login.
- After login the existing custom model stays available, reasoning includes high / max.
- The Coding Plan model and reasoning are selectable without restart; the page's Model Selection View ends up ready and contains the same capability.

### Fixture contract and boundary

- The manifest is `providerRequestPolicy: "none"`, no model request; OAuth, release/latest, client/configs, plan and credential endpoints are fixed by a case-local HTTP mock.
- Every beforeSession resets the mock mode by the current worker spec, so other Coding Plan cases do not inherit login catalog state.
- OAuth polling stays pending and the deep link completes the login, avoiding mixing in polling-completion semantics.
- release/latest uses different config_version before/after login; client/configs serves an immutable catalog per version.
- After login the current built-in GLM-5.3 must provide high and max levels; the release payload is no longer a model-membership source. The real UI and the read-only View together prove the refresh; no renderer catalog is injected.

### Run outcome

Passed on the formal path (1 spec / 1 case, no provider request, first-pass rate 100%, no flaky or infra failure), including the isolated regression running AUTH-04 followed by `coding-plan-team-usage.test.ts` (2 specs / 19 cases; the later 18 ordinary Coding Plan cases all recovered the default Team Plan mock state), the rerun after review optimization (different `config_version` before/after login, immutable versioned catalog), and the 2026-08-27 rerun after merging `origin/staging` and adapting the Desktop OAuth polling mock (the catalog stays `loading` with GLM-5.2 missing, the control is verified supported first, then switched to `ready` and waits for the runtime catalog to show Coding Plan `high` / `max`). Command: `pnpm --filter @zcode/desktop test:e2e:serial -- --spec ./test/e2e/subagent-coding-plan-login-catalog-stale.test.ts`.

### Promotion

The case moved from `manual-review/pending` to the formal path. It sends no model request, does not depend on provider replay and is not in the conversation Docker preset; formal admission is bounded by the case manifest's `providerRequestPolicy: "none"`, the local formal-path run and default desktop E2E collection.

<!-- The AUTH-06 scenario and run records below come from fixed staging; the run numbers are not Todo103 results of this round. -->

## AUTH-06: User-profile access token HTTP/business 401 reuses the logout prompt

### Current behavior (2026-10-12)

- Both platforms select a synthetic login identity through `ZCODE_E2E_AUTH_EXPIRY_PROVIDER=bigmodel|zai`; HTTP `401` or a `200` with numeric business `401` both reuse the conditional logout.
- BigModel additionally covers `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200 ZCODE_E2E_AUTH_EXPIRY_RESPONSE_KIND=empty`: the real Host recognizes remote logout after a zero-byte 200 from customerInfo.
- Before confirmation the current OAuth/JWT/profile are cleaned and independent Bot credentials kept; the expiry prompt appears only once; the confirm button reads "重新登录", the Welcome login entry appears directly, RelaunchApp is not executed. The original IPC record is kept to assert there is no restart command.
- Business empty response after identity verification, normal identity not logged out, ZAI empty identity response with insufficient evidence, concurrent dedupe, and old verification not clearing a new session are covered by service-layer controlled tests; Electron does not claim exact network races.
- The earlier record of confirm-then-restart below is historical acceptance, not the current behavior.

CR-01 bare-token verification regression: `ZCODE_E2E_AUTH_VALIDATION_HEADER=1` uses a valid synthetic ZAI identity; the PAT profile read gets the organization/project, and later business APIs return an empty 200 or a plain 403 per `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200|403`. All customerInfo requests (including the PAT profile read and the post-exception identity verification) accept only a bare token; Bearer returns 401. It requires the real Host to have issued the abnormal business request and the correct identity verification; after startup enters the workspace OAuth/JWT and Bot credentials still exist and the UI shows no expiry prompt; this scenario calls no website API and produces no model request. The existing real-invalidation login-entry case keeps regressing; all stay pending.

CR-01 local isolated Electron regression (2026-10-12), three groups each 1 case passed: ZAI valid identity + business plain 403; ZAI valid identity + business empty 200; ZAI genuine 401 into re-login. The first two closing records show business abnormal requests 5, post-exception bare-token identity reads 8, authorization-header rejections 0; whether a real backend rejects Bearer is not the conclusion of this fixture. This round's isolated Electron automatic recheck (2026-10-12), three groups each 1 case passed: BigModel identity endpoint with empty body HTTP 200; ZAI HTTP 200 + numeric business 401; BigModel HTTP 401. They use a local HTTP fixture and synthetic credentials; the case stays pending. Real backend, mobile or Windows/Linux devices are not verified and no formal CI admission is claimed.

- Candidate spec: `packages/desktop/test/e2e/manual-review/pending/access-token-401-auto-logout.test.ts`.
- Manifest: `packages/desktop/test/e2e/fixtures/cases/auth-config/access-token-401-auto-logout.json`.
- Input: the isolated HOME's legacy BigModel user-profile cache, a business access token of a different value, a ZCode JWT not judged expired, and an independent Bot credential.
- Action: the startup profile migration really issues a userinfo request; a local HTTP fixture pauses the response and, once the UI is usable, returns HTTP 401 or, via `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200`, HTTP 200 + `{"code":401,"msg":"登录状态已过期","success":false}`. The case confirms the status code the fixture actually enabled; other control-plane requests return a normal 200, so JWT 401 cannot mask the new classification.
- Assertions (historical restart variant): the fixture confirms the request used the business token; the original expiry dialog appears; before confirmation active/token/profile/JWT are cleared and Bot credentials kept; after confirmation the original RelaunchApp command is issued through preload. The test truncates the command at the main-process IPC boundary and does not really quit/restart, so the Host shutdown barrier does not disturb WDIO teardown.
- The HTTP fixture does not record credential plaintext; it never reaches a real platform and needs no model request. Payment, API key, old request and multi-platform judgment are covered by service-layer unit tests.
- The HTTP/Host/Renderer chain of desktop local must run and pass automatically; until human acceptance, mobile shared-host and cross-platform UI regression are done it stays pending and does not claim full multi-client verification.

```text
isolated legacy cache -> background userinfo request -> fixture paused
                                      |
                             test releases HTTP 401
                                      |
                     current access token matches -> original logout
                                      |
                        clear credentials -> dialog -> confirm restart
```

### Verification outcomes (2026-09-08 to 2026-10-08, all macOS arm64, case stays pending)

- 2026-09-08: the service layer first reproduced 4 failures on the original JWT judgment; after adding the match, credential classification plus existing API client regression 41 tests passed, and 4 original OAuth logout/profile migration cleanup regressions passed. Electron E2E 1/1 passed. A first-round parallel typecheck overwrote the Host build output and broke startup; run separately, the mock restart still ran the Host shutdown barrier and caused a WDIO teardown timeout, fixed by recording the command at the IPC boundary. Typecheck, E2E typecheck and lint pass. The fixture checker does not support auth/config pending specs and returns unsupported directory; this is not counted as fixture-check pass.
- 2026-09-09 SG-01: service layer with controlled credential read and refresh write-back covers "the preliminary classification read the old token and then the same-platform token was updated", queued conditional logout, and an expired refresh must not revive a logged-out session. Electron reran the isolated AUTH-06: the real Host userinfo 401 of the current token still completes credential cleanup, Bot independence, single prompt and the confirm-restart command. The exact read/enqueue race is covered by those service-layer tests and is not recorded as Electron concurrency coverage. 148/148 service tests (including 9 new race/notification regressions); typecheck, E2E typecheck, lint and architecture check pass; rebased onto `a1fcf91ec11ab34d263b6347bc704b5dd09ac016` (the WDIO conflict keeps both per-case-enabled entries: the safety-check fixture and the auth fixture), AUTH-06 1/1 after rebuild.
- 2026-09-09 CR-01 URL config: 25 new URL boundary tests (BigModel/ZAI invalid, relative, non-HTTP(S) and blank config; a bad candidate does not affect a valid one; invalid request and all candidates invalid; unrelated config does not take part in userinfo classification; the original JWT branch stays compatible); 13 failed before the implementation; classifier tests 51/51 after the fix and 173/173 across the five service test files. A real NodeApiClient/helper synthetic-credential probe: invalid business base + valid userinfo, and invalid userinfo + valid customerInfo, both keep HTTP 401 and each trigger one invalidation callback. Electron verifies the normal 401 interaction chain; abnormal config branches are covered by service tests.
- 2026-10-08 HTTP 200 business 401 regression: cause was that a business login expiry returning HTTP 200 + JSON numeric code=401 did not enter the logout and restart-prompt chain in the old request observer. Identity, enterprise pricing and team subscription details reuse the same current-credential allowlist and session-queue recheck. 8 service test files 260/260 (BigModel/ZAI three endpoints, concurrent single cleanup/notification, old response after re-login/refresh does not clear the new session, original response body readable, empty/corrupt body and SSE not misjudged); typecheck, E2E typecheck, lint, architecture check and format check pass. The pending replay needs an explicit `E2E_PROVIDER_HTTP_MODE=replay` and `E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json`, then run with `ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS=200` or `401`; no model request; the fixture checker currently supports only conversation-session/plugin, not this auth-config path; the AUTH-06 manifest keeps the no-model-request declaration. HTTP 200 + business 401 and HTTP 401 both pass 1/1.
- Both runs verify pre-confirmation credential cleanup, Bot credential retention, the single original expiry dialog and the RelaunchApp command after confirmation. The IPC truncation is kept and no actual process restart is claimed; mobile shared-host and Windows/Linux real-device regression not done. The original UI, broadcast and restart action are reused; the continuous/replayable boundary is not changed.

## HC-01 to HC-05: Help config migration

Formal case: `help-client-config.test.ts` (8 cases), promoted from staging with user authorization and kept in default desktop E2E collection. Covers the real help menu, zh/en links, successful cache, same-language defaults, the built-in feedback dialog, cross-endpoint feedback addresses, HTTP/business/JSON failure recovery, and the HTTP cache behavior after narrow-screen Chromium Web reload. Uses a case-local HTTP fixture; no model request. Historical verification does not count as this round's pass. Detailed coverage matrix, pruning and fixture contract: [help config verification](help-client-config-e2e.md). Todo103 run evidence of this round is in the staging-integration ledger.

## HM-01 to HM-04: Help menu app entries

Promoted with user confirmation on 2026-09-16. Formal case `packages/desktop/test/e2e/help-menu-about.test.ts`; default desktop E2E collects the Preview branch, production runs separately with `ZCODE_E2E_HELP_MENU_FLAVOR=production` and a production build. HM-02 verifies the action text and the version pill separately for the download-complete state, and verifies the version again after closing and reopening. 4 cases: draft page/settings page, zh/en About window, update state with disable/reopen, real dev-build check-update receipt and Preview hiding. No model request and no provider replay fixture dependency; synthetic update events are used only for menu state display. Full matrix and run commands: [desktop help menu](../windows-caption-help-menu.md).

## AUTH-07: OAuth callback and polling-completion race (pending)

- Spec: `packages/desktop/test/e2e/manual-review/pending/oauth-completion-race.test.ts`.
- Fixture: `helpers/oauth-completion-race-fixture.ts` starts a local HTTP; after init the real Host polls; the preload callback starts the token exchange and hangs it; only after poll ready returns is the token HTTP 500 released.
- First hang one exchange and cancel it through the UI, release the successful exchange response; wait for the Host callback to finish, confirm logged-out with no error, then start login again.
- Assertions: the client keeps logging in with the polling credential, the login panel exits, no failure prompt, attribution parameters kept; then deliver a late callback of the same state: attribution updates and the token request count stays 1.
- No model request, no real third-party login. Browser opening is intercepted by an Electron mock while the Host OAuth service stays real.
- Both first-arrival orders, double failure, cancellation and stale responses are covered by service-layer controlled-Promise tests; this E2E covers only the user-visible fallback on desktop local and claims no mobile shared-host or Windows coverage. Stays pending for human review.

### AUTH-07 verification (2026-09-17, macOS)

- Electron E2E passed. The Host log confirms that after `/oauth/token` 500 `oauth.pollPendingOAuth` and `oauth.handleCallback` returned normally; the assertions on the encrypted persisted business token, attribution fields, login panel exit and that a late callback no longer exchanges all pass.
- OAuth service tests 109 and UI/bridge boundary tests 38 pass; service and E2E typecheck, lint and architecture gate pass.
- The full-repo `pnpm typecheck` was at that time blocked by baseline duplicate-key TS1117 in `packages/ui/src/i18n/locales/en-US.ts` and `zh-CN.ts` (not changed on this branch); after rebasing onto `origin/staging` `c7a795d2df` the duplicate keys no longer existed, and full typecheck, lint (0 errors / 54 warnings), architecture gate and 151 related unit tests pass; AUTH-07 passes after rebuilding the App.
- The fixture checker does not support the auth-config pending directory; the no-model-request manifest is kept; no promotion/CI admission. Mobile and Windows/Linux not tested.

### !2703 Suggestions regression (2026-09-17, macOS)

- SG-01: the manifest points to the actual pending spec path.
- SG-02: the service declares a nullable callback and Root ignores an invalidated result; a unit test reproduced the original TypeError and then verified the fix. E2E first cancels the hung exchange, releases the success response, confirms credentials were not replaced and no login error; then logs in again to complete the original fallback scenario.
- SG-03: when both paths fail, each original error is kept, verified for both arrival orders.
- SG-04: a controllable clock verifies callbacks received within the window while pending and after success still save attribution even if queued over 30 seconds, and new callbacks outside the window are rejected; no expiry judgment at processing time was added.
- 151 related unit tests pass; Electron E2E passes (1 case).

## AUTH-08: Desktop remote-control login gate (pending)

- Device-identity save failure regression (CR-02): `manual-review/pending/web-remote-control-session-events.test.ts`, after the first registration is complete, stops remote control through the real dialog, deletes the old SID in the loopback relay, then makes the isolated HOME's setting.json and its parent directory read-only (file read and endpoint kept, only atomic write blocked). Reopening the dialog triggers `AUTH_FAILED` recovery registration; asserts startup immediately enters `error`, no QR code, the new device was compensatingly deleted, and the device count does not grow beyond the first backoff window; after restoring permissions, the user reopening the dialog starts normally. Reuses the loopback V2 relay, no model request; does not pose as real disk-full, online relay or Windows/Linux verification. Stays pending for human review.
- Credential-completion event regression: the same spec uses a single window, real Host OAuth and the loopback V2 relay. After pairing it holds the isolated HOME's setting.json write lock (keeping valid settings reads and independent credential writes), then logs out from the real user menu; asserts credentials emptied, Main `auth-required`, the old terminal WS closed and not by restart. It additionally asserts `setting.update FAIL` appears after credential clearing, and the write lock is released in cleanup. This candidate does not cover multiple windows nor represent real OAuth or online relay acceptance.

- Spec: `packages/desktop/test/e2e/manual-review/pending/web-remote-control-auth-gate.test.ts`.
- Precondition: the isolated HOME's OAuth/JWT credentials are empty; the last enabled target is kept; a case-local HTTP/WS counting service is connected to main's endpoint and relay URL before Electron starts.
- Action: open the mobile remote-control dialog, check Zai Light/Dark x zh-CN/en-US in turn, click the login entry.
- Assertions: main stays `auth-required`; title, description and login button visible; no QR code, copy link or generating placeholder; the real login provider is reachable; remote-control HTTP and WS Upgrade counts are both zero.
- Re-authentication regression: restore the cached user and a synthetic JWT so remote-control HTTP returns 401; the global user is kept; clicking the remote-control login button must create a new login attempt by the current OAuth provider, start one authorization and stay on the waiting page, and must not complete immediately because of the cached user. The button is disabled while providers load; with an existing user but a provider read failure, keep the dialog, show the failure and reread, and allow retry after the read recovers.
- Evidence: four dialog screenshots and the network count JSON in the E2E artifacts. `providerRequestPolicy: none`, no model request; not a substitute for real OAuth, mobile login or Windows/Linux verification.
- Status: accepted semantics, pending implementation verification and human screenshot review; promote after human confirmation. This auth-config path is not part of conversation/provider replay or Docker conversation admission.

### AUTH-08 verification (2026-09-19 to 2026-10-11, macOS arm64, case stays pending)

- Login gate (2026-09-19): pending Electron E2E 1/1 after a full App/Agent build. `auth-required-network.json` is `{remoteHttp: 0, wsUpgrades: 0}`; four screenshots `auth-required-{zh-CN,en-US}-{zai-light,zai-dark}.png` plus the collage `auth-required-review.png`. Manager, full workspace snapshot, IPC and UI hook/render regressions pass; the mixed-workspace coverage problem found in Standards/Spec review was fixed and rechecked. The fixture checker supports only conversation-session/plugins and rejects the auth-config path; this case's manifest declares no model request and the canonical formal path, verified directly per the auth-config contract.
- Remote 401 re-login (2026-09-19): two Electron E2E pass after the final-source full build; the source fingerprint is identical before and after the build and the original four-theme/language gate stays passing. `remote-401-relogin.json` records one remote HTTP, zero WS Upgrade and one `zai` OAuth initialization; the cached user is still visible before the click and after the click the real unified login waiting page appears; the authorization link is intercepted by an Electron shell mock and no real OAuth provider is reached. UI and login targeted regression (four files, 27 tests) covers ZAI/BigModel, provider loading, retry after a read failure and the logged-out entry; `typecheck:e2e` passes.
- Credential events and settings failure (2026-09-22): `web-remote-control-session-events.test.ts` 1/1. `remote-logout-settings-failure.json` records credentials emptied, Main `auth-required`, the paired terminal WS closed, zero restart calls. A real setting.json directory fault makes the UI settings write fail while the user projection remains, proving closing does not depend on a UI update or restart. OAuth owner, RPC, Root hook, Main/loopback relay and adjacent login/logout regressions: 9 files / 158 tests pass. The original login gate and the 401 re-login both pass; the case waits for the post-workspace-restore remote-control button to be visible and initializes the re-login scenario's language independently, avoiding a startup intermediate state or a previous case's failure causing false reports.
- CR-02 (2026-10-09): `web-remote-control-session-events.test.ts` two cases pass. `remote-device-save-failure.json` records Main `error`, `relay-unavailable`, no QR link, device lists empty before and after compensation; the real log confirms the new identity save failed because the settings lock directory `mkdir` returned `EACCES`. After restoring permissions, manual start succeeds and the existing credential-completion/logout regressions keep passing. 77 focused unit tests across manager, transport, HTTP and build entry; full typecheck, lint (0 errors / 68 warnings), E2E typecheck and architecture gate pass. Real disk-full, online relay, real mobile or Windows/Linux not verified.
- Module-migration recheck (2026-10-11): the login gate and 401 re-authentication cases pass; the fixture adds a loopback config for an independent business API so synthetic credentials do not reach an external business endpoint and cause an early logout. Registration compensation and credential events pass; the test keeps a valid setting.json and exclusively holds its write lock; the real log confirms `setting.update FAIL` after credential clearing, Main `auth-required`, terminal closed, restart not called.
- Not a substitute for real OAuth/relay, mobile or Windows/Linux acceptance.

## PAT-LOCATION-RECOVERY: Local recovery from abnormal project-location ciphertext (pending)

- Spec: `packages/desktop/test/e2e/manual-review/pending/project-location-decrypt-recovery.test.ts`.
- A valid BigModel OAuth coexists with a bad location of the same account; the real Host atomically deletes the bad location, requeries automatically and exchanges the token.
- Assertions: the original OAuth ciphertext and Bot credentials are kept; the avatar recovers; no login-invalidated prompt, no OAuth polling, no restart.
- The same case, via local HTTP control, creates a cache fault and a metadata 503 again, asserts that failed recovery still keeps the current login; after the server is restored, a real ProviderSettingsFacade refresh succeeds, without creating an additional login-state source.
- Two independent credential services, repaired records, ordinary IO, invalidation during lock wait, client clear and pending merge are covered by service-layer unit tests; confirmed business login invalidation is still covered by the existing 401 verification case.
- The local HTTP is a synthetic account; stays pending, no claim of real OAuth, Windows/Linux or mobile device verification.
- 2026-10-15 macOS Electron: 1 case passed; automatic recovery, 503 keeping the login, manual refresh token exchange and the connected plan/unbind entry are all asserted. HTTP: 7 location queries, 2 issuances, 0 OAuth polling logins. A log recheck shows the real Host log in order `project_token_location_unreadable` and `project_token_location_recovery`, covering first recovery and the rebuild 503; the two events contain only family, stage, fixed code. In-recovery IO failure is covered by client unit tests. 135 targeted unit tests pass; the final affected run (1,384 specs) passes (15,435 tests passed, 6 skipped); root typecheck, E2E typecheck, lint and architecture check pass (210 existing lint warnings).
- The fixture checker does not support the auth-config pending path; local JSON/path static checks pass; the case stays pending with no manual promotion or CI admission. The old "immediate logout then re-login" evidence does not apply to this scheme.

## PAT-KEY-UPGRADE: Valid login state coexisting with a bad old Key

Candidate case: `packages/desktop/test/e2e/manual-review/pending/account-key-usage-scene.test.ts`. It reuses the Z.AI recovery case in that file: the isolated HOME's credentials.json stores a valid synthetic OAuth and account profile, while the same account's `account-provider:*:api-key` is written as corrupted ciphertext; restart Electron and require the workspace to recover directly, the Host to create a dedicated Key with usageScene=1 and issue a Token, not call Copy, and the original bad old record to stay unchanged. The BigModel case covers the create/exchange path with no old Key.

This case triggers no model inference; HTTP is the existing local Coding Plan mock and does not represent real-backend integration. Mobile/remote paths are covered by Provisioning and auth service tests; no device-level remote E2E is claimed this round. Stays pending, not promoted automatically. Automatic recheck 2026-09-23: 2 cases passed; no human confirmation or promotion; mobile, real backend and mixed-version remotes are outside this case.
