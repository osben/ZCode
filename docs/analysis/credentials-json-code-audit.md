> **Todo103 / G09: preserved as a historical audit, not the current refactoring contract.** It comes from staging commit `846b31c21b`; "current" below means baseline `baffd62dcf`. Code paths apply only to that baseline; to verify older files use `git show 45f808f7:<repo-relative-path>`, and do not treat the current branch's same-named files as original evidence. The old model-provider / preset / family paths are replaced by the current Account, Provider Runtime, and Model Selection boundaries; this document does not restore the old interfaces. G09's 401 fix is in the [current contract](../oauth/jwt-401-auto-logout.md), including in-queue credential verification and accountIdentity cleanup. The CLI, MCP, encryption, and cross-process transaction issues listed here do not automatically become fix tasks. Single-connection transitional state and the Todo101 delay ruling are unchanged. The findings and verification records below are not Todo103 current-code verification.
>
> Compaction note: source line numbers and per-claim link lists were dropped; code locations are given as repo-relative paths. Full history: `git show 45f808f7:docs/analysis/credentials-json-code-audit.md`.

# credentials.json Credential and Lifecycle Code Audit

Audit date: 2026-09-08. Code baseline: `baffd62dcf7e5762b24bee9d0003128793101a11` (`origin/staging`).

This document records code facts of the baseline for later checking and fixing; it does not mean the listed issues are fixed. Examples and runtime verification use synthetic credentials only, with no real tokens, user profiles, or decrypted local data.

Reading order: storage and permission boundaries → OAuth fields and consumers → CLI/MCP lifecycle → Bot/remote/relay → [Audit conclusions and verification records](#audit-conclusions-and-verification-records).

## Scope and Aligned Rules

App ZAI / BigModel login is mutually exclusive: after login completes, old platform login credentials are cleaned up, keeping only the current platform's login state and the new JWT. `zcodejwttoken` is the shared field for the current App session, not a credential held per platform.

Deleting the old JWT itself is therefore not a problem. The checkpoints are whether the old login is fully cleaned up, whether new credentials come from the same login, and whether any active provider or login credential remains after logout. The cancellation flow must not "restore the old JWT" without confirmation.

```text
Current platform session
    |
    +-- New login completes --> Clean old login credentials --> New session for current platform
    |
    +-- Logout --------------------> No App active provider / login credentials

Other credential domains: MCP authorization / Bot / remote connection / relay device authentication
    `-- Each has its own update, invalidation, and deletion workflows; current App logout does not clear the entire file
```

The single-platform rule applies to App login identity. MCP, Bot, SSH, and relay credentials live in the same file but are not in the full-deletion scope of App login switching. Whether to add account-binding cleanup is a separate design decision.

## Storage Implementation and Access Boundaries

### File Locations

| Entry                  | Path Rule                                                                                                                                                          | Code                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Desktop / Node service | `{dataBaseDir}/.zcode/v2/credentials.json`                                                                                                                         | `packages/services/src/credential/credentialService.ts`           |
| service's dataBaseDir  | `setDataBaseDir()` override > `ZCODE_DATA_BASE_DIR` read at module initialization > `HOME` > `os.homedir()`; first three have leading/trailing whitespace stripped | `packages/services/src/paths.ts`                                  |
| CLI / MCP shared store | Explicit `filePath` first; otherwise `{baseDir ?? env.ZCODE_DATA_BASE_DIR ?? os.homedir()}/.zcode/v2/credentials.json`; supports `~`, `~/`, and absolute paths     | `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts` |

"Shared file" holds only when both sides resolve the same data directory. The CLI does not call the App's `setDataBaseDir()`, and blank-path handling differs; filename alone does not prove all processes use the same file.

### Consumers and Persistent Location

```text
Desktop renderer
    `-- hook / RPC --> ICredentialService (Host) --------+
Desktop main's relay / telemetry service --------------+--> Local credential file
CLI login / MCP --> SharedZCodeCredentialStore -----------+
                         (shared when resolved to the same path)

SSH / WSL / Docker workspace
    `-- Local OAuth / credential service --------------------> Local credential file

Server remote
    `-- connectionServices.credentialService RPC -----------> Server's credential file

Browser own OAuth
    `-- BrowserOAuthCredentialRepo --------------------------> localStorage
        pending login (nonce/provider/callback URL) ---------> localStorage
```

- `ICredentialService` exposes `load/save/delete` (`packages/services/src/credential/credential.ts`); UI uses `useCredentials()` and related hooks (`packages/ui/src/hooks/useCredentials.ts`). The generic storage layer is a key/value store and does not understand OAuth providers, accounts, or workspaces.
- Local services register the credential service in `createLocalServices` (`packages/services/src/node.ts`); Desktop main also creates the same file service for relay and telemetry (`packages/desktop/src/main/index.ts`). It is not only one Host instance that accesses the file.
- SSH/WSL/Docker workspace service collections explicitly create local credential/OAuth services; Server remote delegates to the connection target's services (`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`). These are two different ownership boundaries.
- Browser OAuth reuses the names `oauth:active_provider`, `zcodejwttoken`, `oauth:zai:*`, but stores them in localStorage, not `credentials.json` (`packages/web/src/auth/browserOAuthCredentialRepo.ts`). Track the browser's login state and the connected Host services separately.
- This document does not change the message recovery boundary of desktop continuous or mobile replayable; credential ownership does not imply another mobile Agent/runtime.

### File Format, Encryption, and Compatibility

The top level is `Record<string, string>`. Complex values are serialized to JSON strings, then encrypted per value; key names stay plaintext. The file has no top-level version, global account ID, or token type tag; semantics are decided by the key's caller.

```text
Business value / JSON string
    --> AES-256-GCM
    --> "enc:v1:<base64url(iv)>.<base64url(authTag)>.<base64url(cipherText)>"
    --> credentials.json[key]
```

| Item                   | Current Behavior                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm              | AES-256-GCM; 12-byte random IV, 16-byte auth tag                                                                                                      |
| Key                    | `SHA-256(secret)`; prefers `ZCODE_CREDENTIAL_SECRET`, otherwise `zcode-credential-fallback:<platform>:<homedir>:<username>`                           |
| Desktop/CLI difference | Desktop uses a non-null environment variable as-is; CLI `trim()`s first and falls back to default when only whitespace                                |
| Old plaintext          | Values not starting with `enc:v1:` are returned directly; not re-encrypted on a single read                                                           |
| Normal read            | Key missing returns `null`; file missing is treated as an empty object                                                                                |
| Corrupted file         | Illegal JSON/schema: keeps `.corrupt-<hash>.bak` named by content hash, then throws; never overwritten with an empty object                           |
| Decryption failure     | Desktop throws a structured credential decrypt error; CLI cipher throws a generic `Error`. The business layer decides whether to clean OAuth sessions |

Code: `packages/services/src/credential/providers/credentialCipherProvider.ts`, `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts`, `packages/shared/src/validation.ts`, `packages/shared/src/node/privateFilePersistence.ts`.

The default key is derived from system information, not a random key held in the OS keychain; the AES-GCM format does not mean `Electron safeStorage` is used. Changing the key source needs a separate old-ciphertext migration design, not just a new derivation function.

The whitespace difference for `ZCODE_CREDENTIAL_SECRET` was verified with the real cipher implementations and synthetic values: normal strings decrypt on both sides; the same string with leading/trailing whitespace, or a fully-whitespace string, makes Desktop/CLI mutual decryption fail. A fix must also consider ciphertext written under the original rules so old credentials do not become invalid.

### Atomic Write Is Not a Login Transaction

Both stores reuse the same cross-process file lock and atomic replacement tool (`packages/shared/src/node/privateFilePersistence.ts`, `packages/shared/src/node/atomicFileLock.ts`):

```text
Same-process write requests queued
    --> <credentials path>.lock directory lock
    --> Read latest file --> Modify needed key
    --> Same-directory 0600 temp file --> rename replacement --> Release lock
```

The lock has an owner, process liveness check, orphan recovery, and a default 8-second wait cap; rename retries common Windows occupation errors. Backups are also `0600`. Platform permission semantics still depend on the file system; POSIX mode is not Windows ACL.

| Layer                        | Existing Guarantee                                                                                           | Outside Guarantee Scope                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Desktop `save/delete`        | One key change covers a complete read-modify-write; does not drop other processes' independent key updates   | Multiple `save/delete` within one login are not a cross-process transaction                             |
| CLI `saveMany` / login save  | Multiple key changes within one callback are published once                                                  | Network before the call and config update after the call are not in the file transaction                |
| CLI conditional delete       | `deleteIfValue`, `deleteManyIfValue` compare the old value then delete inside the lock                       | Per-key `deleteIfValues` is not a whole-group credential conditional delete                             |
| Desktop OAuth mutation queue | Serializes login completion, logout, etc. of the same OAuthService instance                                  | Not a login-level queue across multiple windows, Hosts, or CLI                                          |
| Read                         | Atomic replacement means readers usually see a complete file; CLI `loadMany` reads multiple keys in one read | Multiple independent `load` calls can straddle other processes' writes and are not one session snapshot |

Stores: `packages/services/src/credential/credentialService.ts`, `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`; queue: `packages/services/src/oauth/oauthService.ts`. This is a concurrency boundary fact, not proof of an existing online race.

The CLI also exports `loadSharedZCodeCredentialSync`: any error in the synchronous read returns `undefined` and keeps no corruption evidence, unlike the async path. No production callers were found; do not describe it as current behavior for all CLI reads.

### Entire File Deletion and Data Directory Migration

- **Clear All Data deletes the whole directory.** After the user confirms, `clearAllDataAndRelaunch` recursively deletes the passed `credentialsDir`, from the current `getAppConfigDir()` (default `~/.zcode/v2`, follows a custom data directory). It removes App OAuth, MCP, Bot, remote connection, relay and other credentials and configuration in that directory, then clears browser storage and restarts. It also purges the WebView partition. This differs from targeted deletion in ordinary logout and does not delete remote Server data. Code: `packages/desktop/src/main/desktopCommandHandlers.ts`, `packages/desktop/src/main/desktopRuntimeEnv.ts`.
- **Data directory changes copy the credential file.** The setting service calls `copyDataDirectory` to copy the old `.zcode/v2` to the new location. Filters exclude `setting.json`, its temp siblings, and symlinks; `credentials.json` is not excluded and its values are not decrypted-then-re-encrypted. The helper copies and does not delete the original, so a successful new path does not mean the old copy is gone; copying across users/systems may fail decryption because of different key material. Code: `packages/services/src/setting/settingService.ts`, `packages/services/src/paths.ts`.

### Log and Archive Boundaries

- RPC middleware success logs record only channel, command, and duration, not credential parameters or return values; failure logs include error objects (`packages/rpc/src/logging-middleware.ts`).
- Desktop log export excludes `credentials.json` and `.credentials.json` by filename; the feedback fallback archive uses path matching including `credentials.json` (`packages/desktop/src/main/exportLogs.ts`, `packages/services/src/feedback/compactLogArchive.ts`). Other business logs must still be checked per caller; these two do not prove all tokens are excluded from logs.

## OAuth / ZCode Platform Login Credentials: Code Facts

"Platform" here means the Z.AI / BigModel identity domains, not macOS / Windows / Linux.

### Confirmed Single-Platform Constraint and Existing Implementation

User-confirmed rule: **login cleans all old platform JWTs; after login completes, only one platform identity is active.** Old platform JWTs do not coexist as accounts. Undecided: whether cleanup happens at login click or at ready/token-exchange completion submission, and how old sessions are handled on cancellation or failure (to be settled with that submission boundary). "Login clears old" must not be read as "log out the old session at login click". OAuth cleanup scope and the lifecycle of SSH, bot, and remote-control pairing credentials are defined separately.

The source already marks `oauth:active_provider` as "the sole source of truth for the exclusive provider domain" and cleans opposite-platform fields before persistence. Cleanup occurs in `persistOAuthSession` after token exchange; initiating login only replaces the pending flow, and rollback restores the old session when persistence is cancelled. Keeping the old session during the pending phase cannot by itself be judged a violation of the user rule. Normal success paths clean the opposite platform's namespace fields but not legacy `auth_token/refresh_token`, so "all old platform credentials cleared" cannot be claimed. Code: `packages/services/src/oauth/repo/oauthCredentialRepo.ts`, `packages/services/src/oauth/oauthService.ts`.

```text
Target identity relationship
  Not logged in
    -> Initiate platform P login
    -> Clean all old platform login JWTs at explicit login submission boundary
       (at click or ready submission: not yet decided)
    -> P login completes: save only P's platform business token + current ZCode JWT
    -> oauth:active_provider = P

  At any time: Z.AI identity XOR BigModel identity
  Forbidden: P's active provider + another platform's business JWT + previous generation ZCode JWT

Current code success path
  startOAuth / startOAuthWithPolling
    -> Only create or replace pending flow; old persisted session can still exist
    -> deep link or polling obtains new token
    -> persistOAuthSession
       -> Temporarily store old two-domain token / profile / active provider (for rollback)
       -> clearProvider(opposite platform): business token, refresh token, user_info, shared JWT
       -> saveTokenSet(current platform): business token, optional refresh token, new shared JWT
       -> saveUserProfile(current platform)
       -> saveActiveProvider(current platform)
```

### Fields in credentials.json

Values are strings via `ICredentialService`; user profiles and attribution are JSON-serialized first. Provider types allow extensible strings; the built-in domains are `zai`, `bigmodel`; known corruption cleanup sets always contain both, and other registered adapter IDs can be added (`packages/shared/src/oauth.ts`, `oauthCredentialRepo.ts`).

| key                            | Semantics / Data Source                                                                                               | Normal Write                                                                                     | Normal Read / Cleanup                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth:active_provider`        | Current App platform identity, built-in `zai` / `bigmodel`; not a token                                               | Written as the last login step; managed by `saveActiveProvider`                                  | Decides cache recovery and which platform model/official MCP/idle plan usage uses; removed by active logout, all logout, corrupt recovery                                                                                  |
| `zcodejwttoken`                | ZCode backend `data.token`; shared JWT for the current platform login identity, key not split per platform            | Saved by the ZAI / BigModel adapter after exchange as `OAuthTokenSet.zcodeJwtToken`              | ZCode business, Start Plan, official MCP, feedback; any built-in platform's `clearProvider` deletes it                                                                                                                     |
| `oauth:zai:access_token`       | **Z.AI business token / MaaS login JWT**: original Z.AI OAuth access token converted via the business login interface | Desktop ZAI adapter converts and saves via both deep link and polling                            | `/api/biz/*`, `/api/pay/*`, plan projects and business API key retrieval, official MCP plan identity, reset; deleted on logout or switching                                                                                |
| `oauth:bigmodel:access_token`  | **BigModel business token / MaaS login JWT** from the backend response                                                | Desktop BigModel adapter / polling, normalized                                                   | BigModel customer, plan, project API key retrieval, official MCP plan identity, reset; deleted on logout or switching                                                                                                      |
| `oauth:bigmodel:refresh_token` | BigModel optional refresh token (`data.bigmodel.refresh_token` / `refreshToken`)                                      | Saved if present from deep link / polling, old value deleted if absent                           | Generic refresh interface reads it, but the built-in BigModel adapter has no refresh implementation; deleted with platform cleanup                                                                                         |
| `oauth:zai:refresh_token`      | Same-named field supported by the generic Repo; **the ZAI adapter produces no refresh tokens**                        | Acceptable from generic `saveTokenSet`; normal ZAI login deletes the old value (no refreshToken) | No built-in renewal use; deleted with platform cleanup                                                                                                                                                                     |
| `oauth:zai:user_info`          | User profile JSON; with rawProfile, saved as backend `data.user` as-is                                                | Written at login; `user_id/name/email/avatar` converted to display profile at read               | Caches login, account ID / display; not a token; deleted with platform cleanup                                                                                                                                             |
| `oauth:bigmodel:user_info`     | Normalized profile JSON including display fields; current profile schema marker added at login save                   | Login / legacy profile background migration                                                      | Caches login display; not a token; deleted with platform cleanup                                                                                                                                                           |
| `oauth:login_attribution`      | JSON `channel_id`, `utm_source`, `utm_campaign`; not a token                                                          | Written by attribution/auth callback; only non-null strings saved                                | Reads accept only these three fields, compatible with old `{params, expiresAt}`; no TTL, logout does not clean; unparseable or effective fields empty → deleted                                                            |
| `auth_token`                   | Old BigModel access token key                                                                                         | Not written by current OAuth login; history-compatibility read only                              | Read by `BigModelProviderAdapter.loadLegacyTokenSet` and `useAuthToken.getToken`; `restoreSession` fills the namespace key; OAuth logout / corrupt cleanup does not delete it, `useAuthToken.clearToken` does for BigModel |
| `refresh_token`                | Old BigModel refresh token key                                                                                        | Not written by current OAuth login                                                               | BigModel legacy loader compatibility read; not deleted by normal OAuth cleanup or `useAuthToken.clearToken`; not an alias for namespace fields                                                                             |

Code: `oauthCredentialRepo.ts`, `packages/services/src/oauth/providers/{bigmodel,zai}ProviderAdapter.ts`, `oauthService.ts`, `packages/ui/src/hooks/useCredentials.ts`.

`OAuthTokenSet` has `expiresAt` and the ZAI adapter computes it from backend `expires_in`, but **OAuthCredentialRepo does not save `expiresAt` nor restore it in `loadTokenSet`**. Do not add `oauth:*:expires_at` to the field list based on the type alone.

Not stored in credentials.json in Desktop normal login (the CLI's deviation of persisting the original ZAI OAuth token is in the CLI section): one-time authorization `code/authCode`, `state`, polling `flowId/pollToken/expiresAt`, and the pre-conversion original ZAI OAuth access token. Pending data lives only in `OAuthService.pendingState`; the business token resolver cache lives only in adapter instance memory (`packages/services/src/providers/zaiBusinessTokenResolver.ts`).

### Three Types of Credentials Cannot Be Mixed

1. **ZCode JWT**: `zcodejwttoken`, identifies the ZCode login identity.
2. **Platform business token / MaaS JWT**: `oauth:<platform>:access_token`, identifies the platform business login identity; used for business interfaces and plan identity verification.
3. **Model / Coding Plan / Team Plan API key**: used for model and monitor requests; obtainable by calling business interfaces with the business token, but not the business token itself.

ZAI's business token may itself be a JWT and the code allows it to equal the ZCode JWT string; judge by source, field, and consumer, not token appearance or equality. BigModel defends against historical miswrites: if `oauth:bigmodel:access_token === zcodejwttoken`, the plan entry refuses to use the polluted state. Code: `packages/services/src/model-provider/modelProviderService.ts`, `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`, `packages/shared/src/official-mcp-auth.ts`.

App model configuration reads/serializes `config.json` `provider[id].options.apiKey`. An explicit refresh obtains the Coding Plan key through the business interface; normal preset sync does not treat the ZCode JWT as a Coding Plan API key. `model-provider:<id>:api-key` is written to the CLI workspace model catalog memory secrets Map, not to a persistent credentials.json key (see CLI section). Code: `packages/services/src/model-provider/modelProviderServiceStorage.ts`, `repo/oauthPresetProviderRepo.ts`.

### Token Source and Conversion Pipeline

```text
Desktop ZAI deep link
  Browser authorization code + state
    -> POST ZCode /api/v1/oauth/token
       body = { provider: "zai", code, redirect_uri, state }
       data.token ---------------------------> zcodejwttoken
       data.zai.access_token (original OAuth token)
          -> POST ZAI /api/auth/z/login
             body = { token: original OAuth token }
             data.access_token / accessToken -> oauth:zai:access_token (business token)
       data.user ----------------------------> oauth:zai:user_info

Desktop BigModel deep link
  Browser authCode/code + state
    -> POST ZCode /api/v1/oauth/token
       body = { provider: "bigmodel", code, redirect_uri, state }
       data.token ---------------------------> zcodejwttoken
       data.bigmodel.access_token/accessToken -> oauth:bigmodel:access_token
       data.bigmodel.refresh_token/refreshToken -> optional refresh_token
    -> BigModel getCustomerInfo ----------------> user_info

Desktop polling (both platforms share completion persistence logic)
  Client random pollToken
    -> POST /api/v1/oauth/cli/init, Authorization: Bearer pollToken
    -> GET /api/v1/oauth/cli/poll/<flowId>, same pollToken
    -> ready.token + ready.<platform>.access_token + ready.user
       ZAI: still first goes through business token conversion
       BigModel: reads optional refresh_token, directly uses business access token
    -> runPendingSessionCompletion -> persistOAuthSession
```

BigModel deep-link access token parsing keeps historical response-shape compatibility: it reads `data.bigmodel.access_token`, `data.bigmodel.accessToken`, `data.access_token`, `data.accessToken` in order; the polling branch accepts only the two keys within `ready.bigmodel`. The BigModel one-time code goes only to the ZCode token route, is not consumed first via `tokenByAuthCode`, and is not used to exchange a JWT again during Start Plan balance check (`packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts`).

Endpoints are built from runtime config per environment; production examples are `zcode.z.ai`, `chat.z.ai`, `api.z.ai`, `bigmodel.cn`; test environments and env overrides change the domain (`packages/services/src/oauth/providers/{zai,bigmodel}ProviderConfig.ts`).

### Major Consumers and Real Authentication Headers

| Consumption Scenario                                | Credential Used                                                                             | Real Header / Boundary                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZAI business plans, projects, payment APIs          | `oauth:zai:access_token` business token                                                     | `Authorization: <token>`, no Bearer added                                                                                                                                                          |
| BigModel customer, plans, and project business APIs | `oauth:bigmodel:access_token`                                                               | `Authorization: <token>`; detects old ZCode JWT miswrite                                                                                                                                           |
| ZAI adapter userinfo compensation request           | `OAuthTokenSet.accessToken` (on Desktop already the converted business token)               | `Authorization: Bearer <token>`, not the raw header of the business APIs above; reused preferentially when the backend user exists                                                                 |
| ZCode billing preview / claim / Start Plan balance  | `zcodejwttoken`                                                                             | `Authorization: Bearer <JWT>`                                                                                                                                                                      |
| Start Plan model runtime config                     | Current projection of ZCode JWT                                                             | The current credentialService JWT overrides the old provider/runtime header; `Authorization: Bearer <JWT>`                                                                                         |
| Coding Plan reset / reset history                   | ZCode JWT + **selected family's business JWT**                                              | `Authorization: Bearer <ZCode JWT>`; `X-Bigmodel-Authorization: <businessJWT>` (raw token); may include organization/project/target type                                                           |
| Official Server MCP and quota credential parsing    | ZCode JWT + selected Coding Plan family's business JWT                                      | `Authorization: Bearer <ZCode JWT>`; `X-Bigmodel-Authorization: Bearer <businessJWT>`; Bearer is added here, unlike reset                                                                          |
| Coding Plan monitor usage / Team Plan usage         | Real Coding Plan / project API key                                                          | Uses the selected provider or team project API key; no fallback to OAuth, normal API key, other platforms, or environment variables                                                                |
| Team Plan project API key retrieval                 | Business token of the corresponding family                                                  | First obtains the API key of a specific organization/project via business login identity; that key is then used for team models/monitor                                                            |
| Idle plan execution                                 | ZCode JWT + Coding Plan API key                                                             | `Authorization: Bearer <JWT>`; `X-Coding-Plan-Api-Key: <model business key>`; plus ticket and plan identity headers. This is still the API key channel; official MCP's MaaS JWT rules do not apply |
| Feedback APIs                                       | `zcodejwttoken`, added only when present                                                    | `Authorization: Bearer <JWT>`; also `X-Device-Mid`                                                                                                                                                 |
| Repo snapshot upload                                | Current active tokenSet; prefers ZCode JWT, falls back to platform accessToken when missing | Final `Authorization: Bearer <token>`; existing fallback; whether it is allowed is a backend-contract question, not automatically a bug because token types differ                                 |

Code: `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts`, `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts`, `packages/services/src/model-provider/modelProviderService.ts`, `packages/services/src/official-mcp/officialMcpCredentials.ts`, `packages/shared/src/official-mcp-auth.ts`, `packages/services/src/session/offPeakRuntimeModel.ts`, `packages/services/src/feedback/feedbackService.ts`, `packages/services/src/node.ts`, `packages/services/src/repo-snapshot/repoSnapshotUploadClient.ts`.

Official MCP validates `settings.providerFamilyDomain === oauth:active_provider` during parsing and rechecks the identity snapshot and business JWT at the end of async parsing; idle plans also check the selected family against the active provider. Both prevent stitching credentials of different generations or platforms. Some historical consumers still allow caching `provider.apiKey` as a Start Plan JWT fallback, or reading the shared JWT when no active provider exists; "any JWT in the current file is valid" cannot be derived.

### Renderer Read Entry, Purchase Auth, and WebView Copy

**`useAuthToken` is the access token hook, not the ZCode JWT hook.** `getToken()` checks the active provider, then reads `oauth:<active>:access_token`; only when active is BigModel and the namespace token is missing does it fall back to legacy `auth_token`. `setToken()` writes only the active platform access token; `clearToken()` deletes only that access token (plus `auth_token` for BigModel), never `zcodejwttoken`, refresh tokens, user_info, or active provider. `clearToken` is therefore not OAuth logout and cannot implement "clear all old platform JWTs". It is a public hook with no call sites found in the repository.

**Purchase page `authenticated` is a local availability judgment.** `readCodingPlanPurchaseTokenState` reads the active provider and two business access tokens in parallel, marks "active exactly matches the family and that business token is non-null" as authenticated, and maps it to that family's Coding Plan and Start Plan entries. It does not read the ZCode JWT, check `exp`, or validate remotely. `ModelProviderSection.refreshCodingPlanPurchaseTokenState` uses the same local judgment. The boolean does not prove platform tokens, JWT, and plan entitlements are valid. Code: `packages/ui/src/settings/model-provider-section/codingPlanPurchaseAuth.ts`, `packages/ui/src/settings/ModelProviderSection.tsx`.

**Purchase WebView copies Host credentials into independent persistent-partition localStorage.** `getCodingPlanCredentialKeys` returns `oauth:zai:access_token` and `zcodejwttoken` for ZAI and only `oauth:bigmodel:access_token` for BigModel, so the BigModel purchase page does not get the shared ZCode JWT through this injection. The Dialog reads the values from credentialService and generates scripts to inject into the current trusted purchase page. It selects fields by purchase target provider and the injection function does not read `oauth:active_provider`; identity correctness depends on peripheral selection and old credential cleanup.

```text
Host credentials.json / CredentialService
  -> Renderer CodingPlanEmbeddedWebviewDialog.injectAuth
     -> Validate webview current URL is trusted coding-plan page
     -> Read target provider credentials
     -> Clear webview localStorage of three credential keys first
     -> Write current provider corresponding values, dispatch zcode-coding-plan-auth-ready
        ZAI:      ZAI access token + ZCode JWT; delete BigModel token
        BigModel: BigModel access token; delete ZAI token + ZCode JWT
     -> Official site completes purchase with current partition credentials

Persistent partition: persist:zcode-coding-plan (independent from App renderer / Web browser storage)
```

The trust check targets the **current navigation URL**, not just the initial src; leaving the trusted page only cleans that origin and injects nothing. PayPal's trusted `/coding-plan/payment/callback` redirect still allows injection through same-origin returnTo rules. Cleanup and injection run sequentially in one `executeJavaScript`. On close it tries to clean the three token keys and report context, allowing failure when the WebView is already destroyed. Root active logout and settings provider unlink send `ClearCodingPlanWebviewStorage` and Main clears the whole persistent partition; Clear All Data also clears it. The completion message closes the purchase page and refreshes current provider key/entitlements/team projects; it does not write the purchase site's new token back to credentials.json. Code: `packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx`, `packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts`, `packages/ui/src/root/useRootWorkspaceActions.ts`, `packages/ui/src/settings/CodingPlanUpgradeDialog.tsx`, `packages/desktop/src/main/desktopCommandHandlers.ts`.

**Legacy cleanup boundaries.** Normal login switching, `clearProvider`, OAuth logout, and corrupt recovery do not delete disk legacy `auth_token/refresh_token`; only `useAuthToken.clearToken`'s BigModel logic deletes `auth_token`, still not the old `refresh_token`. WebView three-key cleanup is not disk legacy cleanup. For "clear all old JWTs", verify the cleanup strategy for these compatibility fields; correct namespace switching alone does not prove legacy is cleared.

### Expiry, Refresh, 401, and Corruption Recovery

**Expiry.** Shared `resolveJwtExpiration` decodes only JWT `exp`, does not verify the signature, and treats the token as expired 30 seconds early. Missing `exp` or malformed tokens return `unknown` and continue to server judgment. Desktop cached restore reads active provider, user_info, and shared JWT; on explicit expiry it re-compares generation/provider/profile/JWT in the mutation queue, clears the current login and derived providers, and returns `reauthentication-required: jwt-expired`. ZAI with missing JWT returns signed-out; BigModel has no such missing-JWT threshold and can still recover authenticated from user_info. Code: `packages/shared/src/oauth.ts`, `oauthService.ts`.

**Refresh.** `OAuthService.refreshToken` is only a generic adapter extension entry: it requires the adapter to have refreshToken, the target to be the current active provider, and an existing refresh token, then exchanges and saves. The ZAI / BigModel adapters do not implement it, so saving a BigModel refresh token does not mean auto-renewal and does not guarantee the platform business JWT or ZCode JWT is renewed. `ZaiBusinessTokenResolver`'s 5-minute offset only controls the in-process cache of the converted business token for the same original OAuth token; it is neither persistent nor a background renewer.

**401.** At the audit baseline the Node API client identifies expiry by whether the outgoing `Authorization` equals the **current local** `Bearer zcodejwttoken`. The 2026-09-08 minimal fix adds the current active platform's userinfo/customerInfo business `access_token` (raw token or Bearer) and limits it to the current environment's origin/path; payment, API key management, and other business paths are excluded. On a match the Host still deduplicates and runs `oauthService.logout()`, clears derived providers, and broadcasts `auth:zcode-jwt-invalid`. The mechanism does not refresh tokens, does not handle HTTP 200 business errors, and does not override WebView or Agent transport. Scope is in the [401 auto-logout spec](../oauth/jwt-401-auto-logout.md); implementation in `packages/services/src/oauth/oauthUnauthorizedRequest.ts` and `packages/services/src/providers/api/nodeApiClient.ts`.

`restoreSession` is another active network verification path: it calls provider userinfo and logs out when the error text matches 401/403/unauthorized/forbidden; other errors keep throwing.

**Decryption corruption.** OAuthCredentialRepo captures stable `CredentialDecryptError` during active provider, tokenSet, and user_info reads: it clears access/refresh/user_info of the two built-in platforms and other registered platforms, the shared JWT, and the active provider, then notifies cleanup of derived model keys (derived cleanup exceptions only log warn). It does not delete SSH, bot, or other non-OAuth keys, old `auth_token/refresh_token`, or attribution keys. The model-provider OAuth-aware wrapper reuses this behavior. Attribution key decryption failure only returns null and does not trigger full-account logout. Cached restore reads `zcodejwttoken` directly, bypassing the Repo's unified recovery, so a single corrupted JWT still throws (see deviation table). Code: `oauthCredentialRepo.ts`, `modelProviderService.ts`, `oauthService.ts`.

### Logout, Cancellation, and Concurrency Boundaries

| Operation                                   | Current Code Behavior                                                                                                                                         | Meaning for the Single-Platform Constraint                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Initiate normal login                       | Clears pending in the mutation queue, generates new state; does not clear persisted login                                                                     | Cleanup point is currently completed submission; user has not decided whether to move it to initiation                                       |
| Initiate polling login                      | Increases flow generation, replaces pending; init async return verifies generation                                                                            | Old init does not overwrite the new flow; does not clear old persisted login                                                                 |
| deep link / polling complete simultaneously | Same pending shares completionPromise; serially enters mutation queue; validates pending is still valid before and after exchange and before each persistence | Avoids duplicate completion and late login writeback; multi-key IO itself is not one OAuth transaction                                       |
| Successful login                            | Cleans opposite platform namespaces and shared JWT, then saves current tokenSet/profile/active provider                                                       | Single-platform intent at normal completion; the process still has multiple independent IO intermediate states                               |
| `logout()`                                  | Checks current active provider, cleans current platform access/refresh/user_info/JWT, then deletes active; cancels platform pending and cleans derived keys   | Not a full scan of remaining platform fields; does not delete an orphaned JWT when active is missing                                         |
| `logout(provider)`                          | Cleans login and notifies derived cleanup only when the parameter equals active provider; also cancels matching pending                                       | Non-current platform unlink must not delete the current shared JWT; does not scan non-current remaining fields                               |
| `logoutAll()`                               | Cleans all registered adapters' platforms, deletes active, cancels pending, cleans derived keys                                                               | Scope set by registered adapters; differs from Repo corrupt cleanup, which always includes the two built-in domains                          |
| `cancelPending()` / timeout                 | Invalidates pending or flow generation; normal cancellation does not clear the persisted old session                                                          | Not logout; cancelled persistence enters current rollback; cancellation semantics should be settled with the final login submission boundary |

Code: `oauthService.ts`, `oauthCredentialRepo.ts`. The standard `onProviderLogout` handler also cleans the corresponding family's Coding Plan and Start Plan API keys so single OAuth field deletion leaves no derived credentials in running configs; it does not equate manually configured normal model API keys with OAuth session keys (`packages/services/src/oauth/oauthProviderLogout.ts`).

### Web Browser Same-Named Fields Are an Independent Boundary

Web `BrowserOAuthCredentialRepo` stores same-named ZAI fields in **localStorage**, not disk credentials.json; the in-progress login record `oauth_pending_logins` is also in localStorage, keyed by nonce. The browser implementation supports only the ZAI active provider. Browser token exchange saves backend `data.zai.access_token` directly without the Desktop `ZaiBusinessTokenResolver` conversion, so `oauth:zai:access_token` has different source semantics in the two storages and must not be mixed.

Browser cached restore requires active = zai with JWT/access/user_info all present; any incomplete state or illegal user JSON triggers clearAll; explicit JWT expiry returns reauthentication-required. Browser logout clears only its own localStorage and is not Desktop credentialService's OAuth logout. Code: `packages/web/src/auth/{browserOAuthCredentialRepo,zaiWebOAuthProvider,webAuthService}.ts`.

### Current Deviations and Follow-up Check Items

Confirmed implementation issues, compatibility residuals, and boundaries needing clarification. Undetermined cleanup timing is not listed as an established bug. Implementation is not modified here.

| Item                                                                            | Evidence / Current Result                                                                                                | Category and Boundary                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login cleanup submission timing and cancellation semantics undetermined         | `oauthService.ts` start paths only replace the flow; rollback writes back old two-domain sessions                        | **Boundary to be determined.** User confirmed cleaning old results and single-platform identity, not immediate cleanup on click; another platform's JWT must not be designed as normal coexisting login; cancellation behavior must not change without confirmation                        |
| Inconsistent rollback session fields after same-platform re-login cancellation  | Rollback restores JWT, then clears the opposite platform; Repo `clearProvider` deletes the shared JWT                    | **Verified with in-memory fake credentials**: ZAI / BigModel both restore old access/user/active but lose the JWT. Current rollback produces incomplete sessions; the fix must align with final login submission/cancellation semantics and must not lead to dual-platform JWT coexistence |
| Single ZCode JWT decryption corruption bypasses unified recovery                | `oauthService.ts` cached restore calls credentialService directly; unified cleanup lives in `oauthCredentialRepo.ts`     | **Verified with a controlled decryption error**: cached restore throws `ZCODE_CREDENTIAL_DECRYPT_FAILED` and active is not cleared; include the single-field JWT corruption scenario                                                                                                       |
| BigModel missing JWT can still recover authenticated                            | Cached restore's missing-JWT check is limited to ZAI, then uniformly returns success                                     | **Two platforms' recovery conditions are inconsistent.** New single-platform complete-session rules must remove incomplete states                                                                                                                                                          |
| Old BigModel `auth_token/refresh_token` may remain after normal platform switch | Repo does not delete legacy; BigModel adapter still reads it; `useCredentials` deletes only `auth_token`                 | **Statically confirmed compatibility residual; cleanup boundary to be verified.** Namespace cleanup does not prove legacy cleared; "clear all old JWTs" must check these two separately without expanding to deleting all of credentials.json                                              |
| Isolated OAuth fields and adapter cleanup set inconsistent                      | logout clears only active; all-logout uses the adapters list; corrupt cleanup always includes the two built-in platforms | **Cleanup set needs clarifying.** Remaining fields when active is missing or an adapter is disabled/unregistered need independent coverage                                                                                                                                                 |
| Generic refresh lacks generation / mutation queue protection                    | `oauthService.ts` async exchange, then saves by the latest active                                                        | **Extension interface risk.** Built-in adapters have no refresh; do not describe built-in auto-refresh chaining as occurring                                                                                                                                                               |
| Some consumers have cross-type / copy fallback                                  | repo snapshot (`node.ts`) falls back to business accessToken; Start Plan JWT helper allows provider.apiKey copy          | **Static audit item.** Under new cleanup semantics check whether these copies let old accounts keep requesting; fallbacks are not automatically wrong                                                                                                                                      |
| `expiresAt` not persisted, business JWT has no auto-refresh pipeline            | Repo saves only access/refresh/JWT; the official MCP comment states business JWT has no refresh pipeline                 | **Capability boundary.** Relies on re-login or server rejection; adding refresh is a later design choice                                                                                                                                                                                   |
| Historical document states wrong ZAI token semantics                            | `docs/oauth/oauth-multi-provider-implementation.md` writes `data.token` and describes conversion at consumption          | **Document drift.** Desktop converts at login and saves business tokens; the ZCode JWT is saved separately                                                                                                                                                                                 |

Runtime evidence used only in-memory fixtures and functions loaded from current source, no real tokens. Formal fixes must first add tests/spec per repository rules, covering login cleanup, cancellation/failure, two-platform switching, independent JWT corruption, derived key cleanup, and desktop/web remote control boundaries.

## CLI and MCP credentials.json Usage

Based on 2026-09-08 source; code facts and synthetic runtime verification only. Examples are structural diagrams with no real tokens. Product rule adopted: "only one platform can be logged in; login deletes all old JWTs". It applies to ZCode App's ZAI/BigModel login sessions and does not extend to unrelated third-party MCP OAuth, SSH, Bot, or independent model API Keys. Storage path, encryption, and file lock are above; this section covers CLI and MCP behavior.

### CLI Application Login Fields

Constants and write entry: `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`. Values below are **decrypted values**.

| Complete key              | Value Structure/Semantics                                                                                                                           | Current CLI Behavior                                      | Status                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `oauth:active_provider`   | provider string; CLI ZAI login writes `zai`. Identity selection marker, not a token                                                                 | Login overwrites; logout deletes only when value is `zai` | Current main path                                                      |
| `oauth:zai:access_token`  | Desktop requires the MaaS business JWT returned by `/api/auth/z/login`; CLI actually stores `ready.data.zai.access_token`, the original OAuth token | ZAI login overwrites; logout deletes                      | Current main path, semantic split exists                               |
| `zcodejwttoken`           | Backend ready response `data.token`, ZCode application identity JWT; ZAI/BigModel share the key                                                     | ZAI login overwrites; logout deletes unconditionally      | Current main path                                                      |
| `oauth:zai:user_info`     | `JSON.stringify(user)`; CLI user is `{user_id: string, avatar?: string, email?: string, name?: string}`                                             | ZAI login overwrites; logout deletes                      | Current main path, non-token                                           |
| `oauth:zai:refresh_token` | Refresh token string left by historical/other writers                                                                                               | CLI login neither produces nor clears it; logout deletes  | CLI only cleans a compatibility field; not output of current CLI login |

The CLI OAuth ready response type contains only `status`, `token`, `user`, `zai.access_token` (`apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts`), with no refresh token or persistent expiry; the CLI login storage method also takes no `expiresAt`, so application JWT auto-refresh management cannot be inferred.

The three BigModel keys below are defined by the desktop OAuth repo; CLI ZAI login and logout do not process them. They are old session state to consider when verifying "single-platform login", not output of the CLI BigModel Coding Plan setup.

| Complete key                   | Decrypted Value                    |
| ------------------------------ | ---------------------------------- |
| `oauth:bigmodel:access_token`  | BigModel business access token/JWT |
| `oauth:bigmodel:refresh_token` | Optional refresh token string      |
| `oauth:bigmodel:user_info`     | User profile JSON string           |

### CLI Login, Logout, and Model Key Lifecycle

#### ZAI CLI Login

Actual timing of `loginZCodeCli` (`apps/zcode-cli/packages/bootstrap/src/auth-login.ts`):

```text
Generate temporary poll_token
  |
  +--> POST /oauth/cli/init (Bearer poll_token)
  +--> Display/open authorize_url
  +--> GET /oauth/cli/poll/:flow_id (Bearer same poll_token)
          |
          +--> pending: continue waiting
          +--> failed/timeout/cancel: end, this method has not yet written shared credentials
          +--> ready
                |
                +--> Save active=zai + original ZAI OAuth access + ZCode JWT + user
                |      Old BigModel namespace, old ZAI refresh not currently cleared
                |
                +--> POST api.z.ai/api/auth/z/login (use original OAuth access to exchange MaaS JWT)
                +--> Query organizations/projects with MaaS JWT, find or create zcode-api-key, copy secret
                +--> Final model API Key writes to ~/.zcode/cli/config.json
```

- init/poll's `poll_token` is only a request credential for the current device authorization flow and is not written to `credentials.json`.
- Shared credentials are persisted before business token exchange and config updates.
- The MaaS business token is used inside the resolver, which returns only the final model API Key and does not give the token back to the shared store (`apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts`).
- The model API Key is written by the config adapter, not the credential store (`apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts`).

#### CLI BigModel Coding Plan setup / Manual API Key setup

`loginBigmodelCodingPlan()` obtains a model API Key and configures the CLI: a localhost callback receives the auth code, exchanges the BigModel access token, obtains the API Key, writes config, and closes the callback server. It **has no shared credential store and does not write `oauth:bigmodel:*` or `zcodejwttoken`**; it is not another entry for desktop BigModel application login. Manual API Key setup only verifies non-empty and writes provider config, without application OAuth state.

#### CLI Logout

`logoutZCodeCli()` only calls `clearZaiLoginCredentials()`, which deletes ZAI access/refresh/user and shared `zcodejwttoken` in a single file-lock transaction; the active marker is deleted only when it equals `zai`, and the BigModel namespace is fully preserved. It does not delete model API Keys in `~/.zcode/cli/config.json` or `mcp:oauth:*`. Application account logout, CLI model call credentials, and third-party MCP authorization are three different lifecycles.

### MCP OAuth Namespace and Isolation Scope

Only MCP authorization-code OAuth uses this shared store. `createOAuthClientProvider()` returns `createMcpOAuthTokenProvider()` for HTTP/SSE authorization-code; stdio and official authorization do not use this provider; client-credentials mode creates the SDK `ClientCredentialsProvider` directly without this store (`apps/zcode-cli/packages/adapters/src/mcp/index.ts`).

Namespace function (`apps/zcode-cli/packages/adapters/src/mcp/oauth.ts`):

```text
serverName
serverUrl (complete original string)
config.clientId or ""
config.scope or ""
config.redirectPath or ""
        |
        +-- Joined by "\n"
        +-- SHA-256, first 24 characters of hex
        +-- P = "mcp:oauth:" + hash
```

Isolation scope:

- Within the same credential file, CLI/Host/sessions with the same `serverName + serverUrl + clientId + scope + redirectPath` share the OAuth pair, refresh lock, and authorization lease.
- `workspacePath`, `workspaceIdentity`, current ZCode provider/account, OAuth issuer, `clientSecret`, `clientName` do not enter the hash.
- Changing server name/URL/scope/client ID/redirect path changes the namespace; the old namespace is not deleted automatically.
- `issuer` is stored separately in canonical and participates in discovery cache consistency checks, **not in the credential namespace**.
- The state is "shared file + MCP config authorization semantics" isolation, not "workspace + application login account" isolation. Adding the latter is a product/architecture decision, and the missing workspace dimension is not by itself a bug.

### MCP OAuth Persistent Fields

`P` is `mcp:oauth:<hash>`. All JSON is `JSON.stringify`-ed first, then written as an encrypted string.

| Complete key template          | Decrypted Structure and Purpose                                                                                                  | Current Status/Write Source                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `P:authorization_credentials`  | Canonical credential pair, structure below                                                                                       | Current main record; published on interactive authorization/refresh success         |
| `P:client_information`         | SDK `OAuthClientInformationMixed` JSON; at least `client_id`, may contain `client_secret` and registration return fields         | Legacy reader mirror, still maintained; not removable trash                         |
| `P:tokens`                     | SDK `OAuthTokens` JSON; `access_token`, `token_type`, may have `refresh_token`, `expires_in`, scope and other SDK/server fields  | Legacy reader mirror, still maintained                                              |
| `P:discovery_state`            | Raw SDK `OAuthDiscoveryState` JSON; code reads `authorizationServerUrl`, `authorizationServerMetadata`, `resourceMetadata`, etc. | Metadata cache, not a business token                                                |
| `P:discovery_state_fetched_at` | `String(Date.now())`, millisecond epoch decimal string                                                                           | Discovery cache timestamp                                                           |
| `P:pending_authorization`      | `{attempt_id, authorization_url, baseline_generation?, expires_at, state}` JSON                                                  | Shared state of the authorization transaction, not a long-term refresh/access token |
| `P:code_verifier:<state>`      | PKCE verifier original string                                                                                                    | Old provider's persistent form; current Phase 2 keeps it only in memory             |

Constants, types, and atomic publish: `mcp/oauth-credentials.ts`, `mcp/oauth-shared.ts`, `mcp/oauth-lease.ts`, `mcp/oauth.ts` (same directory as above).

`authorization_credentials` structure:

| Field                | Meaning                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | Readers support 1, 2; the writer is 2                                                                                                          |
| `client_information` | Client information object for the same authorization as the token                                                                              |
| `tokens`             | Token object for the same authorization as the client                                                                                          |
| `published_by`       | Authorization publisher/transaction identifier; refresh writes `refresh:<P>`                                                                   |
| `generation?`        | 16 random bytes hex generated per publication; not a token. Old records lacking it can derive generation from the canonical original text hash |
| `obtained_at?`       | Millisecond epoch of token acquisition                                                                                                         |
| `expires_at?`        | `obtained_at + expires_in * 1000`; defaults when the server returns no usable `expires_in`                                                     |
| `issuer?`            | Authorization server issuer/URL, for discovery metadata consistency, does not change the key                                                   |

Full storage of SDK objects does not mean local independent schemas exist for every SDK extension field; the canonical shape checker mainly checks version, `published_by`, client ID, access token, and token type.

### MCP OAuth Authorization, Refresh, Invalidation, and History Compatibility

#### Current main path is two-phase

```text
Phase 1: Pure AuthProvider (runtime requests)
  token()
    +-- Read canonical + mirrors, derive one pair
    +-- Not near expiry: deliver access token
    +-- Near expiry and has refresh: enter independent refresh lock
    +-- No token: request without token, classify 401 again
  onUnauthorized()
    +-- Has refresh: refresh in lock
    +-- No refresh: requires interactive authorization

Phase 2: Interactive Authorization Transaction
  Get authz lease isolated by P
  +-- follower: observe shared pending/generation
  +-- leader: fresh localhost listener -> discovery -> fresh DCR/static client
                     -> pending URL/state -> wait for callback -> code exchange
                     -> Atomic write canonical + two mirrors
                     -> Close listener, delete pending by attempt, release lease
```

Phase 1 is `mcp/oauth-provider.ts`. Near-expiry remainder is 30 seconds; missing `expires_at` is also near-expiry, but without a refresh token the existing access token is used until the resource server returns 401.

Phase 2 (`mcp/oauth-interactive.ts`) waits 5 minutes by default for the authorization transaction; leader/follower use the authz lease; pending TTL only affects display/readability, not lock ownership. The DCR-registered client and PKCE verifier stay in the transaction's memory, and the whole client/token pair is published only when tokens are obtained. Callback wait can time out/cancel; the code exchange phase waits for settlement before releasing the lease, so tokens are never written back after the old transaction released the lock.

#### Refresh and Token Deletion

Refresh uses a lock path independent of the credentials file, with a 45-second wait budget (`mcp/oauth-refresh.ts`). It observes generation, acquires the lock, and re-reads: if another process already changed generation, its result is reused, so several processes never consume the same rotating refresh token. On success it regenerates generation and one `saveMany` atomically updates canonical and both mirrors.

| Trigger Condition                                                                               | Current Handling                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_grant` with canonical original text snapshot                                           | Canonical original text is the CAS guard; delete canonical and tokens mirror, retain client mirror; transition to interactive authorization |
| Dynamic client's `invalid_client` / `unauthorized_client` with canonical original text snapshot | Same canonical CAS guard deletes canonical, tokens mirror, and client mirror; transition to interactive authorization                       |
| Static client's `invalid_client` / `unauthorized_client`                                        | Reported as a configuration error, avoiding repeated authorization with the same invalid client                                             |
| Network/5xx/discovery temporary errors                                                          | Not treated as grant failure; proactive refresh can continue with the existing token, reactive throws a temporary refresh error             |
| Legacy-only pair, no canonical `raw`                                                            | The canonical delete helper does not run; errors are still classified into interactive authorization/configuration error                    |

Deleting `tokens` removes the stored record; no revoke request is sent to the OAuth server.

#### Metadata, Pending, and Lock Files

- Discovery metadata TTL is 24 hours; a missing valid cache, expiry, or issuer mismatch returns undefined and triggers rediscovery. Reading an expired entry does not delete the key; the next save overwrites state + timestamp.
- Pending is written when the leader provides the authorization URL and at the end is deleted only by its own attempt via compare-and-delete. An expired read is treated as non-existent, not physically cleaned; a crash can leave expired pending, which later authorization overwrites/cleans.
- Authz/refresh locks sit in the same directory as credentials, with resource paths `<sanitized-P>.authz` / `<sanitized-P>.refresh` (colons and other characters removed from the prefix); the underlying lock directory appends `.lock`. They are process-mutual-exclusion metadata, not `credentials.json` fields or business tokens.
- No business entry traverses and deletes the whole `mcp:oauth:<hash>` namespace in the CLI/MCP adapter, bootstrap, and service MCP/plugin code. Disconnecting, disabling, or removing MCP does not necessarily clear all authorization materials; visible clean-up is successful overwrite, deterministic invalidation CAS, and pending/verifier cleanup.

#### Mirrors Are Not Obsolete; the Old Provider Is Not the Main Path

`loadCredentialPair()` reads canonical and both mirrors and stays compatible with old readers/writers by version and content. v1 without mirrors is normal; deleting the tokens mirror in v2 means an old writer has expired and tokens must not be revived from canonical; when the client is unchanged and legacy tokens change, an old process refresh is acceptable; when both client and token change and the same transaction cannot be proven, no stitching is guessed.

`mcp/oauth.ts` still contains the complete old `ZCodeMcpAuthorizationCodeProvider` and `createMcpAuthorizationCodeOAuthSession()`, but the session factory is used only in `mcp-oauth.e2e.test.ts`; production creation points use the pure token provider. The old provider still writes the PKCE verifier to `P:code_verifier:<state>` and tries to clean on close, and per-key CAS compatibility code remains. Do not describe production Phase 2 as persisting verifiers, nor per-key CAS risks in the old provider as proven production bugs.

### Official MCP Read Tokens and Actual Request Carries

Official MCP adds no new `official-mcp:*` credential key and does not use third-party MCP's canonical OAuth pair. The Host service resolves shared credentials by current application login and model plan selection:

```text
Host setting's provider family / selected connection
  + oauth:active_provider
  + zcodejwttoken
  + oauth:<current family>:access_token (MaaS JWT)
        |
        +-- Pre- and post-read identity snapshot, check selection, active provider, and both tokens match
        +-- Construct identity header
        +-- Official auth port, relay CLI response through existing protocol
              +-- HTTP official MCP: Request headers
              +-- stdio official MCP: params._meta["com.zcode/official-mcp-auth"]
```

The Host requires `oauth:active_provider` to match the current setting family and a ZCode JWT to exist; it never falls back across families to another MaaS token; complete plan paths compare the MaaS JWT before and after. When plans are missing there is an identity-only branch that can carry just the ZCode JWT and let the server decide entitlements; when plan providers exist but the MaaS JWT is missing it returns unavailable. Code: `packages/services/src/official-mcp/officialMcpCredentials.ts`.

| Header                     | Source                                           | When Sent                                                                                          |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `Authorization`            | `Bearer <zcodejwttoken>`                         | Sent after application identity is parsed successfully                                             |
| `X-Bigmodel-Authorization` | `Bearer <oauth:<family>:access_token>`, MaaS JWT | Sent when complete Coding Plan identity is available; ZAI also uses this historically named header |
| `Bigmodel-Target-Type`     | `PERSONAL` / `TEAM`                              | When wire scope exists                                                                             |
| `Bigmodel-Organization`    | Selected Team connection's organization ID       | TEAM scope and organization/project can be paired                                                  |
| `Bigmodel-Project`         | Selected Team connection's project ID            | Same as above                                                                                      |

Constants: `packages/shared/src/official-mcp-auth.ts`. `X-Coding-Plan-Api-Key` is an old-server compatibility channel that clients no longer send, and plugins are still forbidden from injecting it via static headers.

HTTP adapters rewrite the auth port for each request (`apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts`); when the endpoint/origin is untrusted, credentials are not parsed and no network request is made. **Identity parse failure and untrusted origin are different branches**: the HTTP implementation sends an anonymous request for the former, letting the server decide, and does not use old tokens. An identity request receiving 401 can at most re-fetch identity and retry once; this is not an OAuth refresh exchange and deletes no credentials. 403/redirects are failures.

Stdio official MCP injects the same-named namespace via `requestMetaProvider` on every outbound protocol message; normal third-party stdio MCP does not. A missing auth port returns `{ok:false, reason:"official_auth_unavailable"}` and no fallback identity is searched in env or credentials files (`mcp/index.ts`). Standalone CLI does not build official MCP identity headers just because local credentials files exist; the protocol auth port needs Host context and workspace service resolvers (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts`).

### Related Secrets Not Written to credentials.json

| Secret/Field                                                          | Current Save or Pass Location                                                                                            | Boundary                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI final model API Key                                               | `~/.zcode/cli/config.json` provider config (`file-config.adapter.ts`)                                                    | Desktop provider storage is covered by the general document; do not generalize CLI rules to Desktop                                       |
| Model environment variable API Key                                    | Runtime reads provider `apiKeyEnv` or default env name (`apps/zcode-cli/packages/adapters/src/model/registry.ts`)        | Prefers explicit provider `apiKey`; no shared credential fallback                                                                         |
| App-server model `session-secret`                                     | `catalog.secrets` memory Map isolated by `workspace.workspaceKey`, key shaped like `model-provider:<providerId>:api-key` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`; the credential-key-like name is not a key of this file |
| App-server model `env` secret reference                               | Keeps the env reference, resolved from the passed env at read time                                                       | Same file                                                                                                                                 |
| ZAI CLI `poll_token`, flow/state                                      | Current login method memory and init/poll requests                                                                       | Not long-term access/refresh tokens                                                                                                       |
| CLI BigModel setup intermediate access token                          | Memory variable after callback exchange, used to obtain the final model API Key                                          | `auth-login.ts`                                                                                                                           |
| Current MCP Phase 2 PKCE verifier, DCR client with unexchanged tokens | Interactive authorization provider memory                                                                                | `mcp/oauth-interactive.ts`; after success the client enters canonical/mirror                                                              |
| MCP client-credentials config `clientId/clientSecret`                 | MCP config object passed to SDK `ClientCredentialsProvider`                                                              | This branch does not inject the shared store; it does not write `P:tokens`                                                                |
| MCP static headers / stdio env                                        | MCP config/process startup environment passes them directly                                                              | Not credentials expanded automatically from the shared store                                                                              |
| `ZCODE_CREDENTIAL_SECRET`                                             | Local encryption key material in the environment                                                                         | `credential-cipher.ts`; not a business JWT                                                                                                |

Model registry replacement clears old `model-provider:*` memory secrets and removing providers deletes the corresponding secrets; this does not modify credentials files.

### Three Verified CLI Issues

#### CLI-1: Same ZAI Access Key, Split Token Type

The CLI writes the ready original OAuth access token to `oauth:zai:access_token`; the Desktop requires this key to hold the MaaS JWT returned by `/api/auth/z/login` and normalizes it in its own polling adapter. The CLI does obtain the MaaS JWT but uses it only inside the API Key resolver. CLI login can therefore overwrite the MaaS token that Desktop/official MCP/business consumers depend on (`auth-login.ts`, `zaiProviderAdapter.ts`).

A synthetic harness ran the real CLI login, OAuth adapter, API Key resolver, encrypted storage, and locks with synthetic HTTP responses and a stub config writer. Result: business requests used the MaaS JWT = true; shared store holds the original OAuth token = true; shared store holds the MaaS JWT = false; final model API Key config succeeded = true. No real network login.

`apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts` already provides different OAuth token and business JWT responses but asserts that the original OAuth token persists to the shared key. A fix should first update this regression test and add cross-Desktop consumer contract coverage.

#### CLI-2: Successful Login Does Not Fully Replace the Old Platform Session

`saveZaiLoginCredentials()` overwrites only four keys and does not clean BigModel access/refresh/user or the old ZAI refresh. Under the "one platform, clear old JWT" contract this is a direct inconsistency after successful publication; replacing the active marker with zai is not complete cleanup (`shared-credentials.ts`).

#### CLI-3: CLI Logout from a BigModel Session Cleans Only Half

`clearZaiLoginCredentials()` deletes the shared ZCode JWT unconditionally and keeps active=bigmodel and the whole BigModel namespace. The issue is that the **global single session is not fully logged out**; per the latest user rule, a fix must not be written as "keep the other platform's login".

CLI-2/3 were verified with two independent temp files, real shared-storage source, and real encryption/lock execution (output limited to the active provider and key existence):

| key / marker                   | After BigModel -> CLI ZAI Login Publish          | After BigModel -> CLI Logout |
| ------------------------------ | ------------------------------------------------ | ---------------------------- |
| `oauth:active_provider`        | `zai`                                            | `bigmodel` remains           |
| `zcodejwttoken`                | Present (new value overwrites same-named record) | Absent                       |
| `oauth:bigmodel:access_token`  | Present, old session remains                     | Present, old session remains |
| `oauth:bigmodel:refresh_token` | Present, old session remains                     | Present, old session remains |
| `oauth:bigmodel:user_info`     | Present, old session remains                     | Present, old session remains |
| `oauth:zai:access_token`       | Present                                          | Absent                       |
| `oauth:zai:refresh_token`      | Present, old value remains                       | Absent                       |
| `oauth:zai:user_info`          | Present                                          | Absent                       |

**Confirmed vs undetermined.** Confirmed by rules and runtime results: successful publication must leave a consistent single-platform credential set, and logout must fully clear the current application session. Undetermined (cleanup timing and transaction boundaries, not derivable from the single-platform rule): logging out the old session immediately at login click, whether a cancelled login leaves the user logged out, and whether API Key/config update failure rolls back application login. Third-party MCP OAuth and independent model Keys are not part of the application login JWT cleanup set.

## Bot, Remote Connections, and Relay Credentials

Table values are decrypted business values. ICredentialService is a generic dictionary; this section lists the producer-defined key families, not a whitelist of historical file contents.

### Bot Credentials: Same Key, Content Interpreted by Provider

| Key Pattern                                              | Decrypted Content                                    | Source                                                                                              | Major Consumer                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bot:<botId>:credential`, provider=`telegram`            | Telegram Bot token                                   | User-submitted token in the Bot credentials input box; usually from BotFather                       | Telegram `getMe`, menu sync, message sending, long polling                                    |
| `bot:<botId>:credential`, provider=`feishu` / `lark`     | Feishu/Lark application app secret, not access token | Manually filled, or `client_secret` from scan-registration result                                   | App secret exchanges `tenant_access_token`, Feishu WebSocket and application APIs             |
| `bot:<botId>:credential`, provider=`weixin`              | Weixin iLink Bot token                               | Scan-login response `bot_token`, compatible field `token`; generic services also accept manual fill | iLink request's `Authorization: Bearer ...` and polling                                       |
| `bot:<botId>:webhook-secret`, provider=`webhook`         | Custom webhook shared secret                         | Provided by `saveBot({ webhookSecretValue })` callers                                               | Inbound callback comparison; outbound uses a custom header name, default `x-zcode-bot-secret` |
| `bot:<botId>:webhook-secret`, provider=`feishu` / `lark` | Event callback verification token                    | Provided by `saveBot({ webhookSecretValue })` callers                                               | Compared with payload top-level `token` or `header.token`                                     |

Keys are generated in `packages/services/src/bots/config.ts`. `botId` is trimmed in `saveBot`; keys have no workspace or OAuth provider dimension; each Bot is isolated by its ID. `BotConfig` stores `credentialRef` / `webhookSecretRef` (`packages/shared/src/bots.ts`) and actual values live in the credential repository. The service accepts any existing ref, and reading and deletion follow the ref itself, so non-standard key names do not make a record useless.

Evidence: generic UI save in `packages/ui/src/BotsDialog.tsx` (manual submit; scan-registration shares the same save entry: Feishu `appSecret`, Weixin `botToken`); Feishu registration returns `pollResponse.client_secret` as `appSecret` (`packages/services/src/bots/providers/feishuAppRegistration.ts`); Weixin reads response `bot_token` / `token` (`weixinRegistration.ts`); Telegram puts the ref value into `https://api.telegram.org/bot${token}/getMe` (`telegramProvider.ts`); Feishu app secret exchanges the tenant access token (`feishuProvider.ts`), cached in the module-internal `accessTokenCache`, not a new `credentials.json` key; Weixin Authorization header in `weixinProvider.ts`; webhook/Feishu callback verification in `botsService.ts`, webhook outbound header in `webhookProvider.ts`. The `BotsDialog` `saveBot` wrapper passes only `credentialValue`; `webhookSecretValue` is a service API capability, not an editing field in all Bot UIs.

```text
User manual fill / scan-registration returns secret
            |
            v
BotsDialog -> IBotsService.saveBot
            |
            +-> credentialValue / webhookSecretValue non-empty -> trim
            |      -> credentialService.save (fixed bot key, secret)
            |      -> BotConfig only saves ref
            |
            +-> resolveName -> normalize -> validate -> repo.writeConfig
                   -> Refresh provider runtime

provider runtime / provider adapter
    -> Read by BotConfig.ref calls credentialService.load
    -> Decrypted value used for third-party authentication
```

Updates and recovery (`packages/services/src/bots/botsService.ts`):

1. `saveBot` overwrites the same bot key for non-empty new values; with no non-empty new value it writes nothing and keeps the caller-provided BotConfig/ref. Order: write secrets, parse names, validate, write config.
2. Saving then refreshes Telegram, Weixin, and Feishu runtimes; the runtime fingerprint includes the actual credential for the ref, so changing a value under the same ref is detected (`telegramChannelRuntime.ts`, `weixinChannelRuntime.ts`, `feishuChannelRuntime.ts`).
3. `removeBotSecret` stops related runtimes, removes both refs and bound identities, clears state, then deletes the ref-pointed credentials; the Bot is kept for re-binding.
4. `deleteBot` deletes configuration and state and the credentials pointed to by both refs. Ordinary disabling uses neither entry, so it does not revoke or delete credentials.
5. `saveConfig` replaces normalized Bot configurations directly and refreshes runtime, without scanning removed Bots' credentials. There is no generic orphan GC over `bot:*`; cleanup depends on the special deletion entries and retained refs.
6. Bot main credentials have no expiresAt/refresh token structure; after invalidation re-provide values or re-scan. Feishu's short-term tenant token cache/refresh is provider memory, not a persistent key.

### Remote Connection Credentials: Isolated by Workspace Identity

| Key Pattern                                              | Value                                                           | Associated Config Field                    |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `remote-workspace:<workspaceKey>:password`               | SSH password, original value, no trim                           | `target.passwordCredentialKey`             |
| `remote-workspace:<workspaceKey>:private-key-passphrase` | SSH private key passphrase, original value                      | `target.privateKeyPassphraseCredentialKey` |
| `remote-workspace:<workspaceKey>:server-token`           | Token for connecting to a complete ZCode Server, original value | `target.tokenCredentialKey`                |

Constructors are in `packages/ui/src/lib/remoteWorkspaceHistory.ts`. `workspaceKey = resolvedWorkspaceIdentity?.trim() || workspacePath`; connection identity is derived by `buildRemoteWorkspaceIdentity` (SSH: host, port, username, workspace path; WSL: distro/optional user; Docker: container; Server reuses `buildServerRemoteWorkspaceIdentity`). WSL/Docker have no password/token keys.

The source is the connection/reconnection `RemoteTarget.password`, `privateKeyPassphrase`, `token`. `createRemoteTargetSnapshot` converts these plaintexts to refs and puts only non-sensitive connection parameters and refs in persistent history. Existing same-type snapshot refs are reused, so early or custom refs may remain valid; not every historical ref can be recomputed by the current formula.

```text
Connection Input RemoteTarget (password / passphrase / server token)
   -> buildRemoteWorkspaceSessionMutation
      +-> snapshot (host/path/identity + credential refs)
      +-> credentialsToSave
      +-> credentialKeysToDelete
   -> commitRemoteWorkspaceSessionMutation
      -> Attempt to delete old keys -> Write new keys -> Update lastWorkspaceSession

Reconnect/Reconnection
   -> Refs in lastWorkspaceSession.target
   -> credentialService.load
   -> createRemoteTargetFromSnapshot
   -> connectRemoteWorkspaceTarget
```

- UI restores SSH passwords, passphrases, and Server tokens in `packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts`, rebuilds the target, then calls the connection entry. Bot recovery of remote SSH workspaces reads settings history refs (`packages/services/src/bots/botRemoteWorkspaceBridge.ts`); its explicit credential rebuild covers SSH only.
- On changes, refs no longer used in old snapshots go to the deletion list; entries evicted by the 20-entry history limit also add their refs to it.
- The write entry first attempts deletion, then writes new values, then saves settings; deletion failures log warn and continue, write failures throw (`packages/ui/src/root/useRemoteWorkspaceHistory.ts`). This is multiple single-key operations plus one settings write, not a cross-file transaction.
- On explicit removal of remote workspaces/tabs, history is saved first, then referenced credentials are deleted; failures log warn. Ordinary disconnect or temporary bridge separation is not history removal and deletes no credentials.
- There is no remote credential expiry/refresh protocol; updates happen when new connection inputs are saved; no generic GC over `remote-workspace:*`.

### External Relay Pairing Credentials

The only fixed key: `web-remote-control:external-relay:pass_hash` (`packages/desktop/src/main/webRemoteControlRelayAuthStorageProvider.ts`). The value is a `passHash` string; despite the name it is used to generate authentication proofs and is authentication material. `deviceSid` is the non-sensitive supporting identity, saved in settings `webRemoteControlExternalRelayDevice.deviceSid`, not a credential key.

First registration produces a 24-byte random password, SHA-256 then base64 as passHash; the proof is `HMAC-SHA256(passHash, nonce|role|deviceSid)`, base64url output (`webRemoteControlRelayAuthProvider.ts`). The random original password is not saved to credentials.json.

```text
Main manager.start
   -> authStorage.load
       +-> Already has complete {deviceSid, passHash}: persisted auth
       +-> Missing: random password -> passHash -> relay registration
   -> Transport ready + registeredAuth
   -> Settings write deviceSid
   -> credentialService writes passHash

relay challenge -> Generate proof using passHash
invalid persisted auth / resetPairing
   -> Clear settings deviceSid + delete pass_hash
   -> Next start re-registers
```

- Main injects credential/settings services (`packages/desktop/src/main/index.ts`); the manager reads and selects persisted/register at start and saves after a new registration succeeds (`webRemoteControlManager.ts`).
- `load` reads both settings/deviceSid and credentials/passHash; both missing returns undefined; only one present clears first and returns undefined.
- `save` patches settings first, then writes passHash; `clear` clears settings first, then deletes passHash; public `rotate` is clear then save. Not a two-file transaction, but load repairs a one-sided missing state.
- The manager calls clear on invalid persisted auth; user resetPairing stops the old runtime, clears, then starts. Ordinary starts reuse complete pairing materials, so closing a runtime is not deleting pairing credentials.
- The key has no workspace isolation suffix; it is desktop application external relay pairing state, unrelated to model service OAuth tokens, Bot tokens, and Server workspace tokens.

### Desktop, Mobile Web, and Remote Host Ownership Boundaries

```text
Desktop local workspace  -------------------------> Local credentialService
Desktop SSH/WSL/Docker workspace -----------------> Local credentialService
Mobile /remote -> shared-host attachment ---------> The attached scope's service
                                                    |
                                     local/SSH/WSL/Docker: Local credentials
                                     Server remote: Server's own credentials
Desktop Main external relay auth ------------------> Local credentialService

Server tokens needed for connections:
  Stored in the initiating side's remote history credentials; server business credentials after connection establishment are provided separately by the Server.
```

- Desktop base services create the credential service in `packages/services/src/node.ts` and inject it into Bots.
- SSH/WSL/Docker host scopes keep local settings/credential services while proxying remote files/tasks (`remoteWorkspaceServiceCollection.ts`); the renderer merge covers only workspace services and keeps base credential/Bot services (`packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts`). Bot/connection authentication is not written to a remote machine merely because the workspace path is remote.
- Server remote is the exception: a complete Server is the business state authority and credential/Bot services delegate to it (`remoteWorkspaceServiceCollection.ts`; renderer Server merge in `remoteWorkspaceSessionServices.ts`).
- Mobile Web establishes the bridge and receives services through the protocol (`packages/web/src/main.tsx`); `RemoteServiceAccess` makes credential/Bot services RPC proxies (`packages/client/src/remoteServiceAccess.ts`). Unconnected home-only credential load returns null; no browser-side credentials.json is created.
- Mobile `/remote` depends on the window's existing shared-host scope; credential file ownership is the same as the attachment, and no other credential store/Agent is started for mobile replayable streams. Desktop `desktop-continuous` and mobile `web-remote-replayable` are message delivery boundaries, not key naming rules. Fact sources: [task-realtime-sync.md](../web-remote-control/task-realtime-sync.md), [web-remote-control-task-command-queue.md](../web-remote-control-task-command-queue.md).

### Verified Behaviors and Issues Pending Verification

| Item                                                                   | Evidence Level                                  | Observations and Impact                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook provider.test reports success even with missing stored values  | Synthetic runtime replay executed               | Importing the real `createWebhookBotProvider` on Node v24 with a ref present, no webhookUrl, and `load` always returning null returns `{ok:true,message:"Webhook bot is enabled for inbound callbacks."}` with credential read count 0 (`webhookProvider.ts`). Verifies only the test-connection branch, not the complete inbound service. |
| Bot callback skips verification when secret is missing                 | Static high-confidence candidate, not fully run | `botsService.ts` rejects only when expectedSecret/expectedToken are truthy and unequal; a ref present but `load` returning null/empty string skips the check. The provider.test replay does not replay this line.                                                                                                                          |
| Bot save rejection may still update credentials or leave orphans       | Static candidate, not run                       | `credentialService.save` runs before `validateBotConfig`. For example a duplicate providerUserId validation failure can happen after the secret write; needs a complete service fixture and a transaction-boundary decision.                                                                                                               |
| Remote failure reconnection may overwrite existing correct credentials | Static candidate, not run                       | `remoteWorkspaceHistory.ts` preserves the old snapshot on failure/currentEntry but still builds credentialsToSave with the submitted target. Needs a real connection-failure/persistence call chain test; not claimed as reproduced.                                                                                                       |

## Audit Conclusions and Verification Records

### Synthetic Runtime Evidence

| Scenario                                                     | Result                                                                                                                   | Scope of Conclusion                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop ZAI → BigModel, BigModel → ZAI successful submission | Both directions delete the opposite platform's namespace keys; JWT order is delete → save; new JWT retained              | Synthetic verification of current Repo and persistOAuthSession source methods. Does not verify legacy keys fully cleared or real UI E2E                                                   |
| CLI ZAI login                                                | Business requests use the converted MaaS JWT, but the shared access key still holds the original OAuth token             | CLI-1 confirmed: semantic split in shared field writes                                                                                                                                    |
| CLI login ZAI from old BigModel session                      | Active becomes zai, new JWT overwrites; old BigModel access/refresh/user and old ZAI refresh retained                    | CLI-2 confirmed: old credential cleanup incomplete; does not mean two active providers are simultaneously active                                                                          |
| CLI logout from a BigModel session                           | JWT disappears, active=bigmodel and BigModel namespace retained                                                          | CLI-3 confirmed: session cleaned only half; the issue is not deleting retained old JWTs                                                                                                   |
| Desktop cached restore with a single JWT decryption error    | Throws; active marker not cleaned by the Repo's unified recovery                                                         | Real restore method with error injection; corruption recovery test cases are needed                                                                                                       |
| Desktop same-platform re-login cancelled during persistence  | Rollback writes back old access/profile; the restored old JWT is then deleted by another domain's clearProvider          | Confirms inconsistent rollback state. Whether to keep old sessions or stay logged out depends on the submission/cancellation contract; restoring old JWTs is not automatically the repair |
| Desktop/CLI encryption env variable containing whitespace    | Normal values decrypt on both sides; leading/trailing whitespace and fully-whitespace values make mutual decryption fail | Real cipher synthetic interoperability verification, no real tokens or keys                                                                                                               |
| Inbound-only Webhook test                                    | Ref present but does not call loadCredential and still returns success                                                   | Verifies the test branch only; not a replay of complete callback credential verification                                                                                                  |

Scenarios ran current source (or methods extracted from it) on Node 24 with HTTP, config writing, or peripheral dependencies injected by fixture. They prove the results of those function paths but do not replace Desktop, mobile, real server, and cross-OS end-to-end verification.

### Boundaries Needing Continued Verification or Clarification

- **Login transaction timing.** Click start, ready/exchange completion, credential publishing, and model API key/config updates are different moments; the final state when the user cancels or a step fails should be decided with the submission boundary.
- **Old session cleanup set.** Legacy `auth_token/refresh_token`, orphaned JWT when active is missing, residuals of unregistered providers, built-in Coding Plan/Start Plan credentials of the old OAuth session, and WebView copies belong in the cleanup scenario checklist (derived cleanup: `packages/services/src/oauth/oauthProviderLogout.ts`). Manually entered normal model API keys stay outside App login cleanup. "Clear old JWT" must not be implemented as clearing the whole credentials file.
- **Cross-process consistency.** File write locks exist, but multiple independent key operations, multiple reads, and multiple OAuthService instances are not a global login transaction. Whether batch publishing/snapshot reading is needed should be decided with interleaved reproduction.
- **Bot and remote candidates.** Callback skipping verification on missing secret, Bot validation failing after the secret write, and reconnection after failure still queueing new credential saves are static candidates; the call chains were not executed.
- **MCP and App account relationship.** The MCP namespace has no App account/workspace dimension; App logout does not revoke MCP authorization. Following App account cleanup is a separate design choice.
- **Local encryption migration.** The default key source and the whitespace difference must account for old files; changing only the new key derivation is not enough. Plaintext compatibility and unknown encryption prefixes should be defined with the version migration strategy.
- **Archive variants.** Desktop excludes credentials.json by exact filename; the feedback fallback excludes by path substring; the handling of corruption backups and temp files in the two archive paths needs separate test cases. Not all credential copies are claimed excluded.

### Existing Test and Documentation Check Entry Points

| Coverage Direction                                                         | Test Files                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic storage encryption, concurrent writes, corrupted JSON retention    | `packages/services/test/credentialService.test.ts`, `apps/zcode-cli/packages/adapters/tests/auth.test.ts`                                                           |
| Desktop login platform switching, expiry/corruption recovery, cancellation | `packages/services/test/oauthService.test.ts`                                                                                                                       |
| CLI login exchange and field persistence                                   | `apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts` (the assertion that the original OAuth token persists to the shared key needs correcting per contract) |
| MCP OAuth, cross-process authorization/refresh                             | `apps/zcode-cli/packages/adapters/tests/mcp-oauth-refresh.test.ts`, `apps/zcode-cli/packages/adapters/tests/mcp-oauth-cross-process.e2e.test.ts`                    |
| Official MCP identity selection                                            | `packages/services/test/officialMcpCredentials.test.ts`                                                                                                             |
| Browser independent login storage                                          | `packages/web/test/browserOAuthCredentialRepo.test.ts`                                                                                                              |
| Desktop interaction regression entry                                       | [desktop-auth-config-e2e-cases.md](../testing/desktop-auth-config-e2e-cases.md); login interaction changes need corresponding E2E, not only private-method coverage |

Existing documents cannot replace current code facts: [OAuth implementation notes](../oauth/oauth-multi-provider-implementation.md) still describe the old ZAI token source and conversion timing, and [CLI auth-login](../../apps/zcode-cli/docs/design/v2/auth-login.md) records the CLI's original OAuth token persistence, which is inconsistent with the Desktop same-file consumer contract. Later changes should unify these specs and tests so code fixes do not keep contradictory conventions.

This pass only added the organization document, without fixes. The baseline freshness check passed; `pnpm typecheck` and `pnpm lint` were executed but the worktree had no node_modules, so tsc / oxlint could not run. Vitest, Desktop E2E, mobile remote control E2E, and Windows/Linux regressions are not declared passed.
