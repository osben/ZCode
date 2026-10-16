> **Todo103 / G09: Preserved as historical audit, not current refactoring contract.** This comes from staging commit `846b31c21b`; "current" below refers to `baffd62dcf`. Code links/line numbers only apply to this baseline; to verify older files, use `git show baffd62dcf:<repo-relative-path>`; do not treat the current branch's same-named files as original evidence. The old model-provider / preset / family paths are already replaced by the current Account, Provider Runtime, and Model Selection boundaries; this document does not restore old interfaces from. G09's 401 fix is in [current contract](../oauth/jwt-401-auto-logout.md), including in-queue credential verification and accountIdentity cleanup. The existing CLI, MCP, encryption, cross-process transaction, etc. issues listed in this document do not automatically become fix tasks upon merge. Single-connection transitional state and Todo101 delay ruling remain unchanged. The original audit content and verification records below are preserved as-is, not counted as Todo103 current code verification passed.

# credentials.json Credential and Lifecycle Code Audit

Audit date: 2026-09-08. Code baseline: `baffd62dcf7e5762b24bee9d0003128793101a11` (`origin/staging`).

This document records the code facts of this baseline, for subsequent checking and fixing; it does not represent that the issues in the document have been fixed. Examples and runtime verification use synthetic credentials only, containing no real tokens, user profiles, or decrypted local data. Document source links start from `docs/analysis/`; line numbers correspond to the above baseline.

Reading order: storage and permission boundaries → OAuth fields and consumers → CLI/MCP lifecycle → Bot/remote/relay → [Audit conclusions and verification records](#audit-conclusions-and-verification-records).

## Scope and Aligned Rules

App's ZAI / BigModel login mutual exclusion: after login completes, old platform login credentials must be cleaned up, keeping only the current platform's login state and new JWT. `zcodejwttoken` is the shared field for the current App session, not a credential held by each platform separately.

Accordingly, deleting the old JWT itself is not a problem. The checkpoint is whether the old login is fully cleaned up, whether new credentials come from the same login, whether there are still active providers or login credentials after logout. Cancellation flow must not repair "restore old JWT" without confirmation.

```text
Current platform session
    |
    +-- New login completes --> Clean old login credentials --> New session for current platform
    |
    +-- Logout --------------------> No App active provider / login credentials

Other credential domains: MCP authorization / Bot / remote connection / relay device authentication
    `-- Each has its own update, invalidation, and deletion workflows; current App logout does not clear the entire file
```

Single-platform rules apply to App login identity. MCP, Bot, SSH, relay credentials are also saved in the same file, but the current code does not include them in the full deletion scope of App login switching. Whether to add account binding cleanup policy is a separate design decision.

## Storage Implementation and Access Boundaries

### File Locations

| Entry                  | Path Rule                                                                                                                                                                      | Code Reference                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Desktop / Node service | `{dataBaseDir}/.zcode/v2/credentials.json`                                                                                                                                     | [credentialService.ts](../../packages/services/src/credential/credentialService.ts#L27)             |
| service's dataBaseDir  | `setDataBaseDir()` override value > `ZCODE_DATA_BASE_DIR` read at module initialization > `HOME` > `os.homedir()`; first three items have leading/trailing whitespace stripped | [paths.ts](../../packages/services/src/paths.ts#L57)                                                |
| CLI / MCP shared store | Explicit `filePath` first; otherwise `{baseDir ?? env.ZCODE_DATA_BASE_DIR ?? os.homedir()}/.zcode/v2/credentials.json`; supports `~`, `~/`, and absolute paths                 | [shared-credentials.ts](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L257) |

Therefore, the premise of "shared file" is that both sides parse the same data directory. The CLI does not call the App's `setDataBaseDir()`, and blank path handling is not exactly the same; one cannot infer that all processes use the same file from filename alone.

### Consumers and the Actual Persistent Location

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
        pending nonce --------------------------------------> sessionStorage
```

- `ICredentialService` exposes `load/save/delete`; UI uses `useCredentials()` and other hooks. The generic storage layer does not understand OAuth providers, accounts, or workspaces, only accepting key/value. [Interface](../../packages/services/src/credential/credential.ts#L11), [hook](../../packages/ui/src/hooks/useCredentials.ts#L8).
- Local services create and register credential service in `createLocalServices`; Desktop main also creates the same file service for relay and telemetry, so it cannot be described as having only one Host instance accessing the file. [services/node.ts](../../packages/services/src/node.ts#L1213), [main/index.ts](../../packages/desktop/src/main/index.ts#L675).
- SSH/WSL/Docker workspace service collections explicitly create local credential/OAuth services; Server remote delegates to the connection target's services. These are two different ownership boundaries. [remoteWorkspaceServiceCollection.ts](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L83), [Server branch](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L315).
- Browser OAuth, although it reuses `oauth:active_provider`, `zcodejwttoken`, `oauth:zai:*` names, its local storage is not `credentials.json`. The browser's own login state and connected Host services should be tracked separately. [browserOAuthCredentialRepo.ts](../../packages/web/src/auth/browserOAuthCredentialRepo.ts#L11).
- This document does not change the message recovery boundary for desktop continuous or mobile replayable; credential ownership cannot be derived from this as creating another mobile Agent/runtime.

### File Format, Encryption, and Compatibility

The top level is `Record<string, string>`. Complex values are first serialized to JSON strings, then encrypted per value; key names are still saved in plaintext. The file has no top-level version, global account ID, or token type tag; semantics are determined by the key's caller.

```text
Business value / JSON string
    --> AES-256-GCM
    --> "enc:v1:<base64url(iv)>.<base64url(authTag)>.<base64url(cipherText)>"
    --> credentials.json[key]
```

| Item                   | Current Behavior                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Algorithm              | AES-256-GCM; 12-byte random IV, 16-byte auth tag                                                                                                 |
| Key                    | `SHA-256(secret)`; prefers `ZCODE_CREDENTIAL_SECRET`, otherwise uses `zcode-credential-fallback:<platform>:<homedir>:<username>`                 |
| Desktop/CLI difference | Desktop uses non-null environment variable as-is; CLI `trim()` first, falls back to default when only whitespace                                 |
| Old plaintext          | Values not starting with `enc:v1:` are returned directly; not automatically re-encrypted on a single read                                        |
| Normal read            | Key missing returns `null`; file missing treated as empty object                                                                                 |
| Corrupted file         | JSON/schema illegal: keeps `.corrupt-<hash>.bak` named by content hash, then throws; forbidden to overwrite with empty object                    |
| Decryption failure     | Desktop throws structured credential decrypt error; CLI cipher throws generic `Error`. Business layer decides whether to clean up OAuth sessions |

Code references: [Desktop cipher](../../packages/services/src/credential/providers/credentialCipherProvider.ts#L6), [CLI cipher](../../apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts#L4), [schema](../../packages/shared/src/validation.ts#L365), [backup](../../packages/shared/src/node/privateFilePersistence.ts#L109).

The current default key is derived from system information, not a random key hosted in the OS keychain; AES-GCM format does not mean `Electron safeStorage` was used. If the key source changes, a separate design for old ciphertext migration is needed, not just replacing the key derivation function.

The two sides' whitespace handling differences for `ZCODE_CREDENTIAL_SECRET` have been verified with real cipher implementations and synthetic values: normal strings are mutually decryptable; the same string with leading/trailing whitespace, or the same fully-whitespace string, both cause Desktop/CLI mutual decryption failure. Fixes should simultaneously consider historically written ciphertext under the original rules, avoiding letting old credentials become invalid to unify new writes.

### Atomic Write Does Not Equal Complete Login Transaction

Both stores reuse the same cross-process file lock and atomic file replacement tool:

```text
Same-process write requests queued
    --> <credentials path>.lock directory lock
    --> Read latest file --> Modify needed key
    --> Same-directory 0600 temp file --> rename replacement --> Release lock
```

The lock has owner, process liveness check, orphan recovery, and default 8-second wait cap; rename retries for common Windows occupation errors. Backup files are also created with `0600`. Platform permission semantics still depend on the file system; one cannot equate POSIX mode with Windows ACL. [privateFilePersistence.ts](../../packages/shared/src/node/privateFilePersistence.ts#L46), [atomicFileLock.ts](../../packages/shared/src/node/atomicFileLock.ts#L177).

| Layer                        | Existing Guarantee                                                                                              | Outside Guarantee Scope                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Desktop `save/delete`        | One key change covers complete read-modify-write, does not drop other processes' independent key updates        | Multiple `save/delete` within one login are not a cross-process transaction                                                       |
| CLI `saveMany` / login save  | Multiple key changes within one callback published once                                                         | Network before call, config update after call not in file transaction                                                             |
| CLI conditional delete       | `deleteIfValue`, `deleteManyIfValue` compare old value then delete inside lock                                  | Per-key `deleteIfValues` not equal to whole-group credential conditional delete                                                   |
| Desktop OAuth mutation queue | Serializes the same OAuthService instance's login completion, logout, etc.                                      | Not a login-level queue shared across multiple windows, multiple Hosts, CLI                                                       |
| Read                         | Atomic replacement makes readers usually see some complete file; CLI `loadMany` reads multiple keys in one read | Multiple independent `load` can still cross other processes' writes, cannot automatically be treated as the same session snapshot |

Code references: [Desktop store](../../packages/services/src/credential/credentialService.ts#L90), [CLI store](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L88), [OAuth queue](../../packages/services/src/oauth/oauthService.ts#L366). This is a concurrency boundary fact; one cannot infer existing online cross-threading from it alone.

The CLI also exports `loadSharedZCodeCredentialSync`: any error during synchronous read returns `undefined`, and does not keep corruption evidence along the asynchronous read path. No production callers were found in this search; it cannot be described as the current behavior for all CLI reads. [Synchronous compatibility entry](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L234).

### Entire File Deletion and Data Directory Migration

- **Clear All Data is the full-file deletion entry.** After Desktop user confirms clearing all data, `clearAllDataAndRelaunch` performs recursive deletion on the passed `credentialsDir`; this directory comes from the current `getAppConfigDir()`, default `~/.zcode/v2`, but can follow a custom data directory. The operation removes App OAuth, MCP, Bot, remote connections, relay, and other credentials and configurations in that directory, not just OAuth fields; then clears browser storage and restarts. The command also calls WebView partition purchase cleanup. This differs from targeted deletion of ordinary App logout, and does not delete remote Server data. [Clear implementation](../../packages/desktop/src/main/desktopCommandHandlers.ts#L162), [Directory source](../../packages/desktop/src/main/desktopRuntimeEnv.ts#L81), [Command dispatch](../../packages/desktop/src/main/desktopCommandHandlers.ts#L763).
- **Data directory changes copy the credential file.** Setting service calls `copyDataDirectory` to copy old `.zcode/v2` to the new location. Filters exclude `setting.json` and its temp siblings, symlinks; no special exclusion for credentials.json, no decrypt-then-encrypt of its values; this helper is a copy, does not delete the original directory. Therefore, successful new-path resolution does not mean the old file copy has been destroyed; cross-user/system copying may fail decryption due to different key material. [Caller](../../packages/services/src/setting/settingService.ts#L452), [Copy implementation](../../packages/services/src/paths.ts#L587).

### Log and Archive Boundaries

- RPC middleware regular success logs record only channel, command, and duration, not credential request parameters or return values; failure logs include error objects. [logging-middleware.ts](../../packages/rpc/src/logging-middleware.ts#L40).
- Desktop log export excludes `credentials.json` and `.credentials.json` by filename; feedback fallback archive uses path matching including `credentials.json`. Other business logs should still be checked per-caller; one cannot derive from these two that all tokens are excluded from logs. [Desktop export](../../packages/desktop/src/main/exportLogs.ts#L716), [Feedback archive](../../packages/services/src/feedback/compactLogArchive.ts#L15).

## OAuth / ZCode Platform Login Credentials: Code Facts

"Platform" in this chapter refers to Z.AI / BigModel identity domains, not macOS / Windows / Linux.

### Confirmed Single-Platform Constraint and Existing Implementation

This audit adopts the user-confirmed rule: **login cleans all old platform JWTs; after login completes, only one platform identity is allowed to be active.** Old platform JWTs are not retained as coexisting accounts. The user has not yet determined whether cleanup should occur at login click time or at ready/token exchange completion submission; handling of old sessions on cancellation or failure should also be clarified with that submission boundary; one cannot independently interpret "login clears old" as "logout old immediately upon login click." OAuth cleanup scope and the lifecycle of SSH, bot, remote control pairing, and other independent credentials are defined separately.

The existing source code has already annotated `oauth:active_provider` as "the sole source of truth for the exclusive provider domain," and cleans opposite-platform fields before persistence; cleanup occurs in `persistOAuthSession` after completing token exchange; initiating login only replaces pending flow, with rollback restoring old session on cancelled persistence. These are current timing facts; retaining old sessions during pending phase itself cannot be directly judged as violating the user rule. Normal success paths clean fields for the opposite platform's namespace, but do not clean legacy `auth_token/refresh_token`, so one cannot claim "all old platform credentials have been cleared."

References: [oauthCredentialRepo.ts:172](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L172); [oauthService.ts:374](../../packages/services/src/oauth/oauthService.ts#L374), `:554`, `:791`.

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

Field values are saved as strings through `ICredentialService`; user profiles and attribution are first JSON-serialized. The credential file's encryption, key, permissions, lock, and path are explained in the storage chapter. OAuth provider types allow extensible strings, but the current built-in domains are `zai`, `bigmodel`; known corruption cleanup sets always contain both, and other registered adapter IDs can be added.

References: [oauth.ts:56](../../packages/shared/src/oauth.ts#L56), `:132`; [oauthCredentialRepo.ts:13](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L13), `:36`.

| key                            | Actual Semantics / Data Source                                                                                        | Normal Write                                                                                           | Normal Read / Cleanup                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth:active_provider`        | Current App platform identity, built-in values `zai` / `bigmodel`; not a token                                        | Written as the last login step; managed by `saveActiveProvider`                                        | Determines cache recovery, which platform for model/official MCP/idle plan usage; active logout, all logout, corrupt recovery deletion                                                                                                |
| `zcodejwttoken`                | ZCode backend `data.token`; shared JWT for current platform login identity, key not split by platform                 | Saved by ZAI / BigModel adapter after exchange with `OAuthTokenSet.zcodeJwtToken`                      | ZCode business, Start Plan, official MCP, feedback; any built-in platform's `clearProvider` will delete                                                                                                                               |
| `oauth:zai:access_token`       | **Z.AI business token / MaaS login JWT**: original Z.AI OAuth access token converted through business login interface | Desktop ZAI adapter converts and saves via both deep link and polling paths                            | `/api/biz/*`, `/api/pay/*`, plan projects and business API key retrieval, official MCP plan identity, reset; deletion on logout or switching                                                                                          |
| `oauth:bigmodel:access_token`  | **BigModel business token / MaaS login JWT**: BigModel business access token from backend response                    | Desktop BigModel adapter / polling normalized and saved                                                | BigModel customer, plan, project API key retrieval, official MCP plan identity, reset; deletion on logout or switching                                                                                                                |
| `oauth:bigmodel:refresh_token` | BigModel optional refresh token, from `data.bigmodel.refresh_token` / `refreshToken`                                  | Saved if present from deep link / polling, old value deleted if absent                                 | Generic refresh interface reads this, but built-in BigModel adapter currently has no refresh implementation; deleted with platform cleanup                                                                                            |
| `oauth:zai:refresh_token`      | Same-named field supported by generic Repo; **current ZAI adapter does not produce refresh tokens**                   | Acceptable from generic `saveTokenSet`; normal ZAI login deletes old value due to missing refreshToken | No built-in renewal purpose currently; deleted with platform cleanup                                                                                                                                                                  |
| `oauth:zai:user_info`          | User profile JSON; with rawProfile, saves as backend `data.user` as-is                                                | Written at login; converts `user_id/name/email/avatar` to display profile at read                      | Cache login, account ID / display; not a token; deleted with platform cleanup                                                                                                                                                         |
| `oauth:bigmodel:user_info`     | Normalized user profile JSON, including display fields; adds current profile schema marker at login save              | Login / legacy profile background migration                                                            | Cache login display; not a token; deleted with platform cleanup                                                                                                                                                                       |
| `oauth:login_attribution`      | JSON: `channel_id`, `utm_source`, `utm_campaign`; not a token                                                         | Attribution callback / auth callback with attribution written; only saves non-null strings             | Reads only accepting these three fields, compatible with old `{params, expiresAt}`; no TTL currently, logout does not clean; unresolvable or effective fields empty → deletion                                                        |
| `auth_token`                   | Old BigModel access token key                                                                                         | Not written by current OAuth normal login; only retains history-compatibility read                     | `BigModelProviderAdapter.loadLegacyTokenSet` and `useAuthToken.getToken` read; `restoreSession` fills namespace key; current OAuth logout / corrupt cleanup does not delete, `useAuthToken.clearToken` specially deletes for BigModel |
| `refresh_token`                | Old BigModel refresh token key                                                                                        | Not written by current normal OAuth login                                                              | BigModel legacy loader compatibility read; not deleted by normal OAuth cleanup or useAuthToken.clearToken; not an alias for current namespace fields                                                                                  |

References: [oauthCredentialRepo.ts:151](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L151), `:226`, `:284`, `:292`, `:321`, `:398`, `:415`; [bigmodelProviderAdapter.ts:196](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L196), `:274`; [zaiProviderAdapter.ts:364](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L364); [oauthService.ts:476](../../packages/services/src/oauth/oauthService.ts#L476), `:753`; [useCredentials.ts:28](../../packages/ui/src/hooks/useCredentials.ts#L28). Login save profile schema processing entry point is [oauthService.ts:420](../../packages/services/src/oauth/oauthService.ts#L420).

`OAuthTokenSet` type has `expiresAt`; ZAI adapter also calculates it from backend `expires_in`; **OAuthCredentialRepo does not save expiresAt, nor restores it in loadTokenSet**. Do not add `oauth:*:expires_at` to the field list based on type alone. Code references: [oauth.ts:132](../../packages/shared/src/oauth.ts#L132); [zaiProviderAdapter.ts:389](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L389); [oauthCredentialRepo.ts:292](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L292), `:321`.

The following values in Desktop normal login are not stored in credentials.json (CLI's current deviation of persisting original ZAI OAuth tokens separately, see CLI chapter): one-time authorization `code/authCode`, `state`, polling `flowId/pollToken/expiresAt`, and pre-converted original ZAI OAuth access token. Pending data exists only in `OAuthService.pendingState`; business token resolver cache exists only in adapter instance memory. References: [oauthService.ts:43](../../packages/services/src/oauth/oauthService.ts#L43), `:568`, `:638`; [zaiBusinessTokenResolver.ts:17](../../packages/services/src/providers/zaiBusinessTokenResolver.ts#L17), `:35`.

### Three Types of Credentials Cannot Be Mixed

1. **ZCode JWT**: `zcodejwttoken`, identifies ZCode current login identity.
2. **Platform business token / MaaS JWT**: `oauth:<platform>:access_token`, identifies the corresponding platform's business login identity, used for business interfaces and plan identity verification.
3. **Model / Coding Plan / Team Plan API key**: Used for model and monitor requests, obtainable through business token calling business interfaces, but not the business token itself.

ZAI's business token may itself be a JWT, and the code explicitly allows it to be string-equal to ZCode JWT; judgment should be based on source, fields, and consumers, not just token appearance or equality. BigModel has a special defense for historical miswrites: if `oauth:bigmodel:access_token === zcodejwttoken`, the plan entry refuses to use the old polluted state.

References: [modelProviderService.ts:968](../../packages/services/src/model-provider/modelProviderService.ts#L968); [bigmodelCodingPlanSubscriptionProvider.ts:813](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L813); [official-mcp-auth.ts:15](../../packages/shared/src/official-mcp-auth.ts#L15).

App model configuration read/serialization `config.json` `provider[id].options.apiKey`; explicit refresh Coding Plan key obtained through business interface, normal preset sync does not treat ZCode JWT as Coding Plan API key. `model-provider:<id>:api-key` currently writes CLI workspace model catalog memory secrets Map, not credentials.json persistent key, see CLI chapter.

References: [modelProviderServiceStorage.ts:93](../../packages/services/src/model-provider/modelProviderServiceStorage.ts#L93), `:942`, `:1137`; [oauthPresetProviderRepo.ts:535](../../packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts#L535).

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

BigModel access token parsing for deep link retains historical response shape compatibility: sequentially reads `data.bigmodel.access_token`, `data.bigmodel.accessToken`, `data.access_token`, `data.accessToken`; polling branch only accepts two keys within `ready.bigmodel`. BigModel one-time code is only given to ZCode token routing, not consumed first through `tokenByAuthCode`, nor used to exchange JWT again during Start Plan balance check phase.

References: [zaiProviderAdapter.ts:318](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L318), `:364`; [zaiBusinessTokenResolver.ts:70](../../packages/services/src/providers/zaiBusinessTokenResolver.ts#L70); [bigmodelProviderAdapter.ts:130](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L130), `:301`; [oauthService.ts:554](../../packages/services/src/oauth/oauthService.ts#L554), `:683`, `:729`; [bigmodelStartPlanZcodeJwt.ts:31](../../packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts#L31).

Endpoints are constructed from runtime config per environment; production examples are `zcode.z.ai`, `chat.z.ai`, `api.z.ai`, `bigmodel.cn`; test environments and explicit env overrides change the domain. Do not treat example domains as the only allowed deployment environments. References: [zaiProviderConfig.ts:30](../../packages/services/src/oauth/providers/zaiProviderConfig.ts#L30); [bigmodelProviderConfig.ts:25](../../packages/services/src/oauth/providers/bigmodelProviderConfig.ts#L25).

### Major Consumers and Real Authentication Headers

| Consumption Scenario                                | Credential Used                                                                                | Real Header / Boundary                                                                                                                                                                                      | Code Reference                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZAI business plans, projects, payment APIs          | `oauth:zai:access_token` business token                                                        | `Authorization: <token>`, no Bearer added                                                                                                                                                                   | [bigmodelCodingPlanSubscriptionProvider.ts:963](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L963), `:1206`                                                                                                                           |
| BigModel customer, plans, and project business APIs | `oauth:bigmodel:access_token`                                                                  | `Authorization: <token>`; detects old ZCode JWT miswrite                                                                                                                                                    | [bigmodelProviderAdapter.ts:245](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L245); [bigmodelCodingPlanSubscriptionProvider.ts:813](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L813), `:1197`            |
| ZAI adapter userinfo compensation request           | `OAuthTokenSet.accessToken`, Desktop currently is already converted business token             | `Authorization: Bearer <token>`, not the raw header for above business APIs; preferred reuse when existing backend user                                                                                     | [zaiProviderAdapter.ts:398](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L398)                                                                                                                                                                                     |
| ZCode billing preview / claim / Start Plan balance  | `zcodejwttoken`                                                                                | `Authorization: Bearer <JWT>`                                                                                                                                                                               | [bigmodelCodingPlanSubscriptionProvider.ts:258](../../packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts#L258), `:322`; [bigmodelUsageQuotaProvider.ts:491](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L491) |
| Start Plan model runtime config                     | ZCode JWT's current runtime projection                                                         | Current credentialService's JWT overrides old provider/runtime header; `Authorization: Bearer <JWT>`                                                                                                        | [modelProviderService.ts:707](../../packages/services/src/model-provider/modelProviderService.ts#L707), `:1163`, `:1215`                                                                                                                                                                |
| Coding Plan reset / reset history                   | ZCode JWT + **selected family's business JWT**                                                 | `Authorization: Bearer <ZCode JWT>`; `X-Bigmodel-Authorization: <businessJWT>` (raw token), may include organization/project/target type                                                                    | [bigmodelUsageQuotaProvider.ts:673](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L673), `:1045`                                                                                                                                                      |
| Official Server MCP and quota credential parsing    | ZCode JWT + selected Coding Plan family's business JWT                                         | `Authorization: Bearer <ZCode JWT>`; `X-Bigmodel-Authorization: Bearer <businessJWT>`; Bearer actually added here, differs from reset                                                                       | [officialMcpCredentials.ts:216](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L216), `:330`, `:382`; [official-mcp-auth.ts:22](../../packages/shared/src/official-mcp-auth.ts#L22)                                                                                 |
| Coding Plan monitor usage / Team Plan usage         | Real Coding Plan / project API key                                                             | Uses selected provider or team project API key; cannot fall back to OAuth, normal API key, other platforms, or environment variables                                                                        | [bigmodelUsageQuotaProvider.ts:708](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L708), `:834`, `:853`                                                                                                                                               |
| Team Plan project API key retrieval                 | Business token for corresponding family                                                        | First obtains API key for specific organization/project via business login identity; the latter is then used for team models/monitor                                                                        | [bigmodelUsageQuotaProvider.ts:869](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L869)                                                                                                                                                               |
| Idle plan execution                                 | ZCode JWT + Coding Plan API key                                                                | `Authorization: Bearer <JWT>`; `X-Coding-Plan-Api-Key: <model business key>`; additionally carries ticket and plan identity headers. Still API key channel here, cannot apply official MCP's MaaS JWT rules | [offPeakRuntimeModel.ts:251](../../packages/services/src/session/offPeakRuntimeModel.ts#L251), `:403`                                                                                                                                                                                   |
| Feedback APIs                                       | `zcodejwttoken`, added only when present                                                       | `Authorization: Bearer <JWT>`; also `X-Device-Mid`                                                                                                                                                          | [feedbackService.ts:76](../../packages/services/src/feedback/feedbackService.ts#L76)                                                                                                                                                                                                    |
| Repo snapshot upload                                | Current active tokenSet; prefers ZCode JWT, currently missing fallback to platform accessToken | Final `Authorization: Bearer <token>`; this is the existing fallback; whether permitted must be judged by backend contract, cannot directly declare bug just because token types differ                     | [node.ts:1288](../../packages/services/src/node.ts#L1288); [repoSnapshotUploadClient.ts:117](../../packages/services/src/repo-snapshot/repoSnapshotUploadClient.ts#L117)                                                                                                                |

Official MCP validates `settings.providerFamilyDomain === oauth:active_provider` during parsing, and rechecks identity snapshot and business JWT at async parsing end; idle plans also check selected family against active provider. Both prevent different generation or different platform credential stitching. Some historical consumption entries still allow caching `provider.apiKey` as Start Plan JWT fallback, or reading shared JWT when no active provider exists; one cannot derive "any JWT in the current file is valid" from this.

References: [officialMcpCredentials.ts:222](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L222), `:341`; [offPeakRuntimeModel.ts:251](../../packages/services/src/session/offPeakRuntimeModel.ts#L251); [bigmodelStartPlanZcodeJwt.ts:18](../../packages/services/src/model-provider/bigmodelStartPlanZcodeJwt.ts#L18); [oauthPresetProviderRepo.ts:587](../../packages/services/src/model-provider/repo/oauthPresetProviderRepo.ts#L587); [bigmodelUsageQuotaProvider.ts:491](../../packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts#L491).

### Renderer Read Entry, Purchase Auth, and WebView Copy

**`useAuthToken` is the access token hook, not the ZCode JWT hook.** `getToken()` first checks active provider, then reads `oauth:<active>:access_token`; only when active is BigModel and namespace token is missing, falls back to legacy `auth_token`. `setToken()` only writes active platform access token; `clearToken()` only deletes that access token, and for BigModel additionally deletes `auth_token`, never deleting `zcodejwttoken`, refresh tokens, user_info, or active provider. Therefore `clearToken` is not OAuth logout, and cannot serve as the implementation for "clearing all old platform JWTs." It is a publicly exported hook; current repository search found no function call sites; this fact indicates existing read/write APIs exist, not asserting the current interface is calling it.

References: [useCredentials.ts:28](../../packages/ui/src/hooks/useCredentials.ts#L28); [index.ts:43](../../packages/ui/src/hooks/index.ts#L43); [index.ts:70](../../packages/ui/src/index.ts#L70).

**Purchase page's `authenticated` is a local availability judgment.** `readCodingPlanPurchaseTokenState` parallel reads active provider and two business access tokens, marking "active exactly matches family and that business token is non-null" as authenticated, and maps to that family's Coding Plan and Start Plan entries. It does not read ZCode JWT, does not check `exp`, does not perform remote validation. `ModelProviderSection.refreshCodingPlanPurchaseTokenState` has the same local judgment. One cannot interpret this boolean as having verified that platform tokens, JWT, and plan entitlements are all valid.

References: [codingPlanPurchaseAuth.ts:25](../../packages/ui/src/settings/model-provider-section/codingPlanPurchaseAuth.ts#L25); [ModelProviderSection.tsx:648](../../packages/ui/src/settings/ModelProviderSection.tsx#L648).

**Purchase WebView copies Host credentials to independent persistent partition localStorage.** `getCodingPlanCredentialKeys` returns `oauth:zai:access_token` and `zcodejwttoken` for ZAI, only `oauth:bigmodel:access_token` for BigModel. Therefore the BigModel purchase page does not obtain the shared ZCode JWT from this injection entry. The Dialog reads these values from credentialService, generating scripts to inject into the current trusted purchase page; it selects fields by purchase target provider, and the injection function itself does not read `oauth:active_provider`; identity correctness depends on peripheral selection and old credential cleanup.

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

Trusted check targets **current navigation URL**, not just trusting initial src; leaving the trusted page only executes cleanup for that origin, without injecting App credentials. PayPal's trusted `/coding-plan/payment/callback` redirect continues to allow injection through same-origin returnTo rules. Cleanup before injection and injection execute sequentially in the same `executeJavaScript`. On close, attempts cleanup of three token keys and report context, but allows failure when WebView is already destroyed; Root active logout and settings page provider unlink separately send `ClearCodingPlanWebviewStorage`, Main clears entire persistent partition; Clear All Data also explicitly clears this partition.

References: [CodingPlanEmbeddedWebviewDialog.tsx:149](../../packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx#L149), `:386`, `:540`; [codingPlanEmbeddedWebview.ts:60](../../packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts#L60), `:124`, `:175`, `:257`; [useRootWorkspaceActions.ts:298](../../packages/ui/src/root/useRootWorkspaceActions.ts#L298), `:315`; [ModelProviderSection.tsx:1087](../../packages/ui/src/settings/ModelProviderSection.tsx#L1087); [desktopCommandHandlers.ts:213](../../packages/desktop/src/main/desktopCommandHandlers.ts#L213), `:763`.

Completion message is used to close purchase page and refresh current provider key/entitlements/team projects; it does not write the purchase site's new token back to credentials.json. References: [CodingPlanEmbeddedWebviewDialog.tsx:340](../../packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx#L340); [CodingPlanUpgradeDialog.tsx:52](../../packages/ui/src/settings/CodingPlanUpgradeDialog.tsx#L52), `:66`, `:108`.

**Legacy cleanup boundaries must be listed separately.** Current normal login switching, `clearProvider`, OAuth logout, corrupt recovery do not delete disk legacy `auth_token/refresh_token`; only `useAuthToken.clearToken`'s special BigModel logic deletes `auth_token`, still not deleting old `refresh_token`. WebView's three-key cleanup is also not disk legacy cleanup. When users request "clear all old JWTs," one should verify the cleanup strategy for these historical compatibility fields; one cannot declare legacy fully cleared just because namespace switching is correct.

References: [oauthCredentialRepo.ts:415](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L415), `:432`; [bigmodelProviderAdapter.ts:274](../../packages/services/src/oauth/providers/bigmodelProviderAdapter.ts#L274); [useCredentials.ts:63](../../packages/ui/src/hooks/useCredentials.ts#L63); [codingPlanEmbeddedWebview.ts:257](../../packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts#L257).

### Expiry, Refresh, 401, and Corruption Recovery

**Expiry.** Shared `resolveJwtExpiration` only decodes JWT `exp`, does not verify signature; defaults to 30 seconds early as expired. Missing `exp`, format anomalies return `unknown`, continuing to server judgment. Desktop cached restore reads active provider, user_info, shared JWT; explicit expiry then re-compares generation/provider/profile/JWT in mutation queue, clears current login and derived providers, returns `reauthentication-required: jwt-expired`. ZAI missing JWT returns signed-out; BigModel currently does not set the same missing JWT threshold, can still recover from user_info authenticated.

References: [oauth.ts:164](../../packages/shared/src/oauth.ts#L164); [oauthService.ts:177](../../packages/services/src/oauth/oauthService.ts#L177), `:253`, `:266`.

**Refresh.** `OAuthService.refreshToken` only has generic adapter extension entry: requires adapter has refreshToken, target is current active provider, and existing refresh token, then exchanges and saves. Current ZAI / BigModel adapters have not implemented this method; therefore saving BigModel refresh token does not mean implementing auto-renewal, and cannot guarantee platform business JWT or ZCode JWT will be renewed. `ZaiBusinessTokenResolver`'s 5-minute offset only controls in-process cache of the same original OAuth token converted to business token; it is not persistent, nor a background login renewer.

References: [oauthService.ts:913](../../packages/services/src/oauth/oauthService.ts#L913); [providerAdapter.ts:31](../../packages/services/src/oauth/providers/providerAdapter.ts#L31); [zaiBusinessTokenResolver.ts:4](../../packages/services/src/providers/zaiBusinessTokenResolver.ts#L4), `:44`, `:99`.

**401.** The audit baseline's Node API client identifies expiration based on whether the outgoing `Authorization` precisely equals the **current local** `Bearer zcodejwttoken` at that time. The 2026-09-08 minimal fix在此基础上 adds current active platform userinfo/customerInfo's business `access_token` (raw token or Bearer), and limits the current environment's origin/path; payment, API key management, and other business paths are not included in the new judgment. After matching, the Host still deduplicates and executes `oauthService.logout()`, clears derived providers, and broadcasts `auth:zcode-jwt-invalid`. This mechanism does not refresh tokens, does not handle HTTP 200 business errors, and does not automatically override WebView or Agent transport. Detailed scope is in [401 auto-logout spec](../oauth/jwt-401-auto-logout.md); implementation in [oauthUnauthorizedRequest.ts](../../packages/services/src/oauth/oauthUnauthorizedRequest.ts).

`restoreSession` is another active network verification path: calls provider userinfo; when error text matches 401/403/unauthorized/forbidden, logs out; other errors continue to throw.

References: [nodeApiClient.ts:134](../../packages/services/src/providers/api/nodeApiClient.ts#L134); [node.ts:1226](../../packages/services/src/node.ts#L1226), `:1872`; [oauthService.ts:518](../../packages/services/src/oauth/oauthService.ts#L518), `:1061`.

**Decryption corruption.** OAuthCredentialRepo captures stable `CredentialDecryptError` during active provider, tokenSet, user_info reads: clears two built-in platforms and other registered platforms' access/refresh/user_info, shared JWT, active provider, then notifies cleanup of derived model keys; derived cleanup exceptions only log warn. This path does not delete SSH, bot, and other non-OAuth keys, nor old `auth_token/refresh_token`, attribution keys. The model-provider's OAuth-aware wrapper read also reuses this Repo behavior.

Attribution key decryption failure only returns null, does not trigger full-account logout. Current cached restore directly reads `zcodejwttoken`, bypassing Repo unified recovery; individual JWT decryption corruption still throws errors, see deviation table.

References: [oauthCredentialRepo.ts:159](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L159), `:241`, `:292`, `:346`, `:432`; [modelProviderService.ts:136](../../packages/services/src/model-provider/modelProviderService.ts#L136); [oauthService.ts:206](../../packages/services/src/oauth/oauthService.ts#L206).

### Logout, Cancellation, and Concurrency Boundaries

| Operation                                   | Current Code Behavior                                                                                                                                         | Meaning for Single-Platform Constraint                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initiate normal login                       | Clears pending in mutation queue, generates new state; does not clear persisted login                                                                         | Currently uses completed submission as cleanup point; user has not decided whether to advance to initiation                                                              |
| Initiate polling login                      | Increases flow generation, replaces pending; init async return verifies generation                                                                            | Old init does not overwrite new flow; does not handle clearing old persisted login                                                                                       |
| deep link / polling complete simultaneously | Same pending shares completionPromise; serially enters mutation queue; validates pending is still valid before and after exchange and before each persistence | Avoids duplicate completion, late login writeback; multiple key IO itself is not one OAuth transaction                                                                   |
| Successful login                            | Cleans opposite platform namespaces and shared JWT, then saves current tokenSet/profile/active provider                                                       | Single-platform intent at normal completion; current process still has multiple independent IO intermediate states                                                       |
| `logout()`                                  | Checks current active provider, cleans current platform access/refresh/user_info/JWT, then deletes active; cancels platform pending and cleans derived keys   | Not a full cleanup scanning all remaining platform fields; does not delete orphaned JWT when active is missing                                                           |
| `logout(provider)`                          | Only cleans login and notifies derived cleanup when parameter equals active provider; additionally cancels matching pending                                   | Non-current platform unlink should not misdelete current shared JWT; does not actively scan non-current remaining fields                                                 |
| `logoutAll()`                               | Cleans all registered adapters' corresponding platforms, deletes active, cancels pending, cleans derived keys                                                 | Scope determined by registered adapters; differs from Repo corrupt cleanup always including two built-in domains                                                         |
| `cancelPending()` / timeout                 | Invalidates pending or flow generation; normal cancellation does not directly clear persisted old session                                                     | Cannot interpret this as logout; cancelled persistence enters current rollback; cancellation semantics should be clarified together with final login submission boundary |

References: [oauthService.ts:367](../../packages/services/src/oauth/oauthService.ts#L367), `:374`, `:431`, `:554`, `:630`, `:791`, `:948`, `:980`, `:990`; [oauthCredentialRepo.ts:284](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L284), `:424`.

`onProviderLogout`'s standard handler simultaneously cleans corresponding family's Coding Plan and Start Plan API keys, avoiding single OAuth field deletion leaving derived credentials in running configs. It does not auto-equate manually configured normal model API keys with OAuth session keys. References: [oauthProviderLogout.ts:14](../../packages/services/src/oauth/oauthProviderLogout.ts#L14).

### Web Browser Same-Named Fields Independent Boundary

Web `BrowserOAuthCredentialRepo` places same-named ZAI fields in **localStorage**, not disk credentials.json; `oauth_pending_nonce` goes to sessionStorage. The current browser implementation only supports ZAI active provider. Browser token exchange directly saves backend `data.zai.access_token`, without going through Desktop `ZaiBusinessTokenResolver`'s business conversion, so same-named `oauth:zai:access_token` has different source semantics in the two storage systems and cannot be directly mixed.

Browser cached restore requires active is zai, JWT/access/user_info all present; any incomplete state, user JSON illegality triggers clearAll; explicit JWT expiry returns reauthentication-required. Browser logout only clears its own localStorage; it is not Desktop credentialService's OAuth logout. Remote control attachment/Host authority and credential forwarding limits are explained in the remote control chapter.

References: [browserOAuthCredentialRepo.ts:11](../../packages/web/src/auth/browserOAuthCredentialRepo.ts#L11), `:58`, `:94`, `:137`; [zaiWebOAuthProvider.ts:102](../../packages/web/src/auth/zaiWebOAuthProvider.ts#L102), `:180`; [webAuthService.ts:128](../../packages/web/src/auth/webAuthService.ts#L128), `:160`.

### Current Deviations and Subsequent Check Items

The following contains confirmed implementation issues, current compatibility residuals, and boundaries needing clarification; does not list undetermined cleanup timing as established bugs. This chapter does not modify implementation.

| Item                                                                                  | Evidence / Current Result                                                                                                                                                             | Category and Boundary                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login cleanup submission timing and cancellation semantics undetermined               | `oauthService.ts:554`, `:791` only replaces flow; `:390` rollback writes back old two-domain sessions                                                                                 | **Boundary to be determined**. User confirmed is cleaning old results and single-platform identity, not immediate cleanup on click; must not design another platform's JWT as normal coexisting login, cannot change cancellation behavior without confirmation                                                                     |
| Inconsistent rollback session fields after same-platform re-login cancellation        | `oauthService.ts:391` restores JWT, `:397` then clears opposite platform; Repo `:420` deletes shared JWT                                                                              | **Already verified with memory fake credentials obtaining runtime evidence**: ZAI / BigModel both restore old access/user/active but lose JWT. Indicates current rollback generates incomplete sessions; specific fix should align with final login submission/cancellation semantics, cannot lead to dual-platform JWT coexistence |
| Individual ZCode JWT decryption corruption bypasses unified recovery                  | `oauthService.ts:206`, `:275` directly calls credentialService; Repo unified cleanup in `oauthCredentialRepo.ts:432`                                                                  | **Already verified with controlled decryption error obtaining runtime evidence**: cached restore directly throws `ZCODE_CREDENTIAL_DECRYPT_FAILED`, active not cleared; should include single-field JWT corruption scenario                                                                                                         |
| BigModel missing JWT can still recover authenticated                                  | Cached restore `oauthService.ts:253` missing JWT check is limited to ZAI, `:262` uniformly returns success                                                                            | **Current two-platform recovery conditions inconsistent**. New single-platform complete session rules need to clarify eliminating incomplete states                                                                                                                                                                                 |
| Old BigModel `auth_token/refresh_token` may still remain after normal platform switch | `oauthCredentialRepo.ts:415` does not delete legacy; `bigmodelProviderAdapter.ts:274` still reads; `useCredentials.ts:63` only specially deletes `auth_token`                         | **Static confirmation of compatibility residuals, cleanup boundary to be verified**. Normal switching success only proves namespace key cleanup, not legacy fully cleared; users requesting to clear all old JWTs must check these two items separately, cannot expand to deleting all credentials.json                             |
| Isolated OAuth fields and adapter cleanup set inconsistent                            | logout only clears active; all cleanup takes adapters list; corrupt cleanup always includes two built-in platforms                                                                    | **Needs clarified cleanup set**. Remaining fields when active is missing or adapter is disabled/unregistered should be independently covered                                                                                                                                                                                        |
| Generic refresh lacks generation / mutation queue protection                          | `oauthService.ts:936` async exchange after `:945` saves by latest active                                                                                                              | **Extension interface risk**. Built-in adapters currently have no refresh; cannot describe this as current built-in auto-refresh chaining already occurring                                                                                                                                                                         |
| Some consumers have cross-type / copy fallback                                        | repo snapshot `node.ts:1294` falls back to business accessToken; Start Plan JWT helper allows provider.apiKey copy                                                                    | **Static confirmation audit item**. Under new cleanup semantics, must check whether these copies can continue letting old accounts make requests; cannot directly declare fallbacks are all using wrong credentials                                                                                                                 |
| `expiresAt` not persisted, business JWT has no auto-refresh pipeline                  | Repo only saves access/refresh/JWT; official MCP comment also explicitly states business JWT has no refresh pipeline                                                                  | **Capability boundary**. Currently depends on re-login or server rejection; whether to add refresh is a subsequent design choice                                                                                                                                                                                                    |
| Historical documents write wrong ZAI token semantics                                  | [oauth-multi-provider-implementation.md:99](../../docs/oauth/oauth-multi-provider-implementation.md#L99), `:105` writes as `data.token`; `:173` describes consumption then conversion | **Document fact drift**. Current Desktop is login-stage conversion then saving business tokens, ZCode JWT saved separately                                                                                                                                                                                                          |

This round's preceding runtime evidence only uses memory fixtures and functions loaded from current source code, without reading real tokens; this chapter does not repeat runs. Formal fixes still need to first add tests/spec per repository requirements, covering login cleanup, cancellation/failure, two-platform switching, independent JWT corruption, derived key cleanup, and desktop/web remote control boundaries.

## CLI and MCP credentials.json Usage

This chapter organizes based on 2026-09-08 current source code, only describing code facts and synthetic runtime verification completed in this round. All examples are structural diagrams, containing no real tokens. Product rules adopt this round's user-confirmed "only one platform can be logged in; login requires deleting all old JWTs"; this rule applies to ZCode App's ZAI/BigModel login sessions, and cannot automatically extend to deleting unrelated third-party MCP OAuth, SSH, Bot, or independent model API Keys.

Storage path, encryption, and file lock are in the preceding text; the following focuses on CLI and MCP business behavior.

### CLI Application Login Field Complete List

Field constants and CLI write entries are referenced in [shared-credentials.ts:11](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L11), [shared-credentials.ts:215](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L215). The table below describes **decrypted values**.

| Complete key              | Value Structure/Semantics                                                                                                                         | Current CLI Behavior                                      | Status                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `oauth:active_provider`   | provider string; CLI ZAI login writes `zai`. Identity selection marker, not a token                                                               | Login overwrites; logout only deletes when value is `zai` | Current main path                                                      |
| `oauth:zai:access_token`  | Desktop requires `/api/auth/z/login` returned MaaS business JWT; CLI currently actually stores `ready.data.zai.access_token` original OAuth token | ZAI login overwrites; logout deletes                      | Current main path, semantic split exists                               |
| `zcodejwttoken`           | Backend ready response `data.token`, ZCode application identity JWT; ZAI/BigModel share same-named key                                            | ZAI login overwrites; logout unconditionally deletes      | Current main path                                                      |
| `oauth:zai:user_info`     | `JSON.stringify(user)`; CLI user is `{user_id: string, avatar?: string, email?: string, name?: string}`                                           | ZAI login overwrites; logout deletes                      | Current main path, non-token                                           |
| `oauth:zai:refresh_token` | Refresh token string left by historical/other writers                                                                                             | CLI login does not produce nor clear; logout deletes      | CLI only cleans compatibility fields, not current CLI new login output |

CLI OAuth ready response source code type only contains `status`, `token`, `user`, `zai.access_token`, without refresh token and persistent expiration fields: [cli-oauth.ts:32](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L32). CLI login storage method also has no `expiresAt` parameter; therefore one cannot infer from this method that application JWT auto-refresh management exists.

The following three BigModel keys are defined by the desktop OAuth repo; current CLI ZAI login and logout do not process them. These are old session states that must be considered together when verifying "single-platform login", not current CLI BigModel Coding Plan setup's disk output:

| Complete key                   | Decrypted Value                    | Code Reference                                                                                 |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `oauth:bigmodel:access_token`  | BigModel business access token/JWT | [oauthCredentialRepo.ts:24](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L24) |
| `oauth:bigmodel:refresh_token` | Optional refresh token string      | [oauthCredentialRepo.ts:28](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L28) |
| `oauth:bigmodel:user_info`     | User profile JSON string           | [oauthCredentialRepo.ts:32](../../packages/services/src/oauth/repo/oauthCredentialRepo.ts#L32) |

### CLI Login, Logout, and Model Key Lifecycle

#### ZAI CLI Login

The actual timing of [loginZCodeCli](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L130):

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

- init/poll's `poll_token` is only used as current device authorization flow request credentials, not written to `credentials.json`: [cli-oauth.ts:88](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L88), [cli-oauth.ts:106](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L106).
- Shared credentials are persisted before business token exchange and config updates: [auth-login.ts:165](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L165).
- MaaS business token is used within the resolver; the resolver currently returns only the final model API Key, not given back to shared store: [coding-plan-api-key.ts:96](../../apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts#L96), [coding-plan-api-key.ts:111](../../apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts#L111).
- Model API Key is written by config adapter, not the credential store: [file-config.adapter.ts:331](../../apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L331).

#### CLI BigModel Coding Plan setup / Manual API Key setup

`loginBigmodelCodingPlan()` is the "obtain model API Key and configure CLI" flow: localhost callback receives auth code, exchanges BigModel access token, obtains API Key, writes config, closes callback server. This method **has no shared credential store, does not write `oauth:bigmodel:*` or `zcodejwttoken`**, and cannot be treated as another entry for desktop BigModel application login. [auth-login.ts:212](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L212), [auth-login.ts:254](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L254).

Manual API Key setup similarly only verifies non-empty then writes provider config, without writing application OAuth state: [auth-login.ts:279](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L279).

#### CLI Logout

`logoutZCodeCli()` only calls `clearZaiLoginCredentials()`. The latter deletes ZAI access/refresh/user and shared `zcodejwttoken` in a single file lock transaction, but the active marker is only deleted when it equals `zai`; BigModel namespace is completely preserved. [auth-login.ts:298](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L298), [shared-credentials.ts:70](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L70).

This CLI logout path does not delete model API Keys in `~/.zcode/cli/config.json`, nor traverses or deletes `mcp:oauth:*`. Application account logout, CLI model call credentials, and third-party MCP authorization are three different lifecycles in the current code.

### MCP OAuth Namespace and Isolation Scope

Only MCP authorization-code OAuth uses this shared store. The current runtime entry `createOAuthClientProvider()` returns `createMcpOAuthTokenProvider()` for HTTP/SSE authorization-code; stdio and official authorization do not go through this provider; client-credentials mode directly creates SDK `ClientCredentialsProvider`, without injecting this store into it. [mcp/index.ts:1527](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1527).

Namespace functions are in [oauth.ts:558](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L558):

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

Actual isolation scope:

- Within the same credential file, the same `serverName + serverUrl + clientId + scope + redirectPath` CLI/Host/session share OAuth pair, refresh lock, and authorization lease.
- `workspacePath`, `workspaceIdentity`, current ZCode provider/account, OAuth issuer, `clientSecret`, `clientName` are not involved in this hash.
- Changing server name/URL/scope/client ID/redirect path changes the namespace; old namespace will not be automatically deleted just because the key changed.
- `issuer` is separately stored in canonical, participates in discovery cache consistency checks, **does not participate in credential namespace**.
- Therefore, the current state is "shared file + MCP config authorization semantics" isolation, not "workspace + application login account" isolation. Whether to add the latter belongs to product/architecture decisions, not a bug solely due to missing workspace.

### MCP OAuth All Persistent Fields

The following `P` refers to `mcp:oauth:<hash>` from the previous section. All JSON is first `JSON.stringify`, then written as an encrypted string to the outer dictionary.

| Complete key template          | Decrypted Structure and Purpose                                                                                                          | Current Status/Write Source                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `P:authorization_credentials`  | Canonical pair of credentials, see next structure table                                                                                  | Current main record; interaction authorization/refresh success publish                             |
| `P:client_information`         | SDK `OAuthClientInformationMixed` JSON; at least `client_id`, may contain `client_secret` and registration return fields                 | Legacy reader mirror still maintained in current, not removable trash that can be directly deleted |
| `P:tokens`                     | SDK `OAuthTokens` JSON; contains `access_token`, `token_type`, may have `refresh_token`, `expires_in`, scope and other SDK/server fields | Legacy reader mirror still maintained in current                                                   |
| `P:discovery_state`            | Raw SDK `OAuthDiscoveryState` JSON; current code reads `authorizationServerUrl`, `authorizationServerMetadata`, `resourceMetadata`, etc. | Current metadata cache, not business token                                                         |
| `P:discovery_state_fetched_at` | `String(Date.now())`, millisecond epoch decimal string                                                                                   | Current discovery cache timestamp                                                                  |
| `P:pending_authorization`      | `{attempt_id, authorization_url, baseline_generation?, expires_at, state}` JSON                                                          | Current authorization transaction shared state, not long-term refresh/access token                 |
| `P:code_verifier:<state>`      | PKCE verifier original string                                                                                                            | Old provider's persistent form; current Phase 2 only in memory                                     |

Constants, types, and atomic publish for the first three keys are in [oauth-credentials.ts:6](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L6), [oauth-credentials.ts:143](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L143). The latter four categories are in [oauth-shared.ts:5](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-shared.ts#L5), [oauth-lease.ts:82](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L82), [oauth.ts:535](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L535).

The complete local packaging structure for `authorization_credentials`:

| Field                | Meaning                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`            | Readers support 1, 2; current writer is 2                                                                                                  |
| `client_information` | Client information object for the same authorization as the token                                                                          |
| `tokens`             | Token object for the same authorization as the client                                                                                      |
| `published_by`       | Authorization publisher/transaction identifier; refresh writes `refresh:<P>`                                                               |
| `generation?`        | 16 random bytes hex generated per publication; not a token. Old records lacking it can derive generation from canonical original text hash |
| `obtained_at?`       | Millisecond epoch of token acquisition                                                                                                     |
| `expires_at?`        | `obtained_at + expires_in * 1000`; defaults when server does not return usable `expires_in`                                                |
| `issuer?`            | Authorization server issuer/URL, for discovery metadata consistency, does not change key                                                   |

Types and read rules are in [oauth-credentials.ts:19](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L19), [oauth-credentials.ts:62](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L62). Full storage of SDK objects does not mean the local defines independent schemas for each SDK extended field; current canonical shape checker mainly checks version, `published_by`, client ID, access token, and token type.

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

Phase 1 is at [oauth-provider.ts:47](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-provider.ts#L47). Near-expiry remainder is 30 seconds; missing `expires_at` also treated as near-expiry, but without refresh token, waits for the resource server to ultimately return 401 with the existing access token: [oauth-credentials.ts:179](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L179).

Phase 2 defaults to waiting 5 minutes for the authorization transaction; leader/follower use authz lease; pending TTL only determines display/readability, not lock ownership. DCR registration client and PKCE verifier are retained in the current transaction memory, only publishing the entire client/token pair when tokens are obtained; callback wait can timeout/cancel, code exchange phase waits for settlement before releasing lease, avoiding tokens being written back but old transaction releasing lock early. [oauth-interactive.ts:37](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L37), [oauth-interactive.ts:77](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L77), [oauth-interactive.ts:168](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L168), [oauth-interactive.ts:246](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L246).

#### Refresh and Token Deletion

Refresh uses a lock path independent of the credentials file, wait budget 45 seconds. First observes generation, acquires lock, re-reads: other processes that have already changed generation reuse the result, avoiding multiple processes simultaneously consuming the same rotation refresh token. After success, regenerate generation, one `saveMany` atomically updates canonical and two mirrors. [oauth-refresh.ts:70](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L70), [oauth-refresh.ts:127](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L127).

| Trigger Condition                                                                               | Current Handling                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_grant` with canonical original text snapshot                                           | Use canonical original text as CAS guard, delete canonical and tokens mirror, retain client mirror; transition to interactive authorization |
| Dynamic client's `invalid_client` / `unauthorized_client` with canonical original text snapshot | Same canonical CAS guard deletes canonical, tokens mirror, client mirror; transition to interactive authorization                           |
| Static client's `invalid_client` / `unauthorized_client`                                        | Report as configuration error, avoiding repeatedly authorizing with the same invalid client                                                 |
| Network/5xx/discovery temporary errors                                                          | Do not treat as grant definitely failed; proactive can continue existing token, reactive throws temporary refresh error                     |
| Legacy-only pair, no canonical `raw`                                                            | The above canonical delete helper does not execute; still classifies errors into interactive authorization/configuration error              |

Code: [oauth-refresh.ts:173](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L173), [oauth-refresh.ts:190](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L190), [oauth-credentials.ts:207](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L207). Here `tokens` failure deletes the stored record, not sending a revoke request to the OAuth server.

#### Metadata, Pending, and Lock Files

- Discovery metadata TTL is 24 hours; missing valid cache, expired, or issuer mismatch returns undefined, triggering rediscovery; reading expired does not itself delete the key, next save overwrites state + timestamp. [oauth-shared.ts:43](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-shared.ts#L43).
- Pending is written when leader provides the authorization URL; at end, only delete by belonging attempt via compare-and-delete. Reading expired treats as non-existent, not equivalent to physical cleanup; process crashes can leave expired pending, subsequent authorization will overwrite/clean up. [oauth-lease.ts:108](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L108), [oauth-lease.ts:148](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L148).
- Authz/refresh locks and credentials are in the same directory, deriving `<sanitized-P>.authz` / `<sanitized-P>.refresh` as lock resource paths by removing colons and other characters from the prefix; the underlying lock directory appends `.lock`. These locks are process-mutual-exclusion metadata, not `credentials.json` fields or business tokens. [oauth-lease.ts:33](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-lease.ts#L33), [oauth-refresh.ts:285](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-refresh.ts#L285).
- No business entry was found in this round's current CLI/MCP adapter, bootstrap, and service MCP/plugin code for traversing deletion by the entire `mcp:oauth:<hash>` namespace. Cannot claim disconnect, disable, or remove MCP will necessarily clear all authorization materials; currently explicitly visible are successful overwrites, deterministic invalidation CAS, and pending/verifier cleanup.

#### Mirrors Do Not Equal Obsolete Credentials; Old Provider Is Not Current Main Path

`loadCredentialPair()` reads canonical and two mirrors at once, compatible with old readers/writers based on version and content compatibility. v1 without mirrors is normal state; v2 deleting tokens mirror means old writer has expired, cannot revive tokens from canonical; when client is unchanged and legacy tokens change, old process refresh is acceptable; when both client and token change and cannot prove same transaction, does not guess stitch. [oauth-credentials.ts:239](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L239), [oauth-credentials.ts:289](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-credentials.ts#L289).

`oauth.ts` still contains the complete old `ZCodeMcpAuthorizationCodeProvider` and `createMcpAuthorizationCodeOAuthSession()`, but current repository call search only uses this session factory in `mcp-oauth.e2e.test.ts`; production creation points have switched to pure token provider. This old provider still writes PKCE verifier to `P:code_verifier:<state>` and attempts cleanup on close; per-key CAS compatibility code also still exists. Do not describe current production Phase 2 persisting verifiers based on this, nor treat per-key CAS risks in the old provider as proven production main path bugs. [oauth.ts:67](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L67), [oauth.ts:289](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L289), [oauth.ts:361](../../apps/zcode-cli/packages/adapters/src/mcp/oauth.ts#L361), [mcp/index.ts:1537](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1537).

### Official MCP Read Tokens and Actual Request Carries

Official MCP does not separately add a new `official-mcp:*` credential key, nor uses third-party MCP's canonical OAuth pair. The source is the Host service resolving shared credentials by current application login and model plan selection:

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

The Host requires `oauth:active_provider` to match the current setting family and have ZCode JWT; cannot fall back across families to find another MaaS token; complete plan paths also compare MaaS JWT before and after. Missing plans have an identity-only branch, which can carry only ZCode JWT, letting the server determine entitlements; when plan providers are present but MaaS JWT is missing, returns unavailable. [officialMcpCredentials.ts:216](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L216), [officialMcpCredentials.ts:283](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L283), [officialMcpCredentials.ts:330](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L330).

| Header                     | Source                                              | When Sent                                                                                          |
| -------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Authorization`            | `Bearer <zcodejwttoken>`                            | Sent after successfully parsing application identity                                               |
| `X-Bigmodel-Authorization` | `Bearer <oauth:<family>:access_token>`, is MaaS JWT | Sent when complete Coding Plan identity is available; ZAI also uses this historically named header |
| `Bigmodel-Target-Type`     | `PERSONAL` / `TEAM`                                 | When wire scope exists                                                                             |
| `Bigmodel-Organization`    | Selected Team connection's organization ID          | TEAM scope and organization/project can be paired                                                  |
| `Bigmodel-Project`         | Selected Team connection's project ID               | Same as above                                                                                      |

Constants and construction: [official-mcp-auth.ts:22](../../packages/shared/src/official-mcp-auth.ts#L22), [officialMcpCredentials.ts:382](../../packages/services/src/official-mcp/officialMcpCredentials.ts#L382). `X-Coding-Plan-Api-Key` is an old server compatibility channel, clients no longer send it currently, and plugins are still prohibited from injecting via static headers: [official-mcp-auth.ts:41](../../packages/shared/src/official-mcp-auth.ts#L41).

HTTP adapters rewrite auth port for each request; when endpoint/origin is untrusted, does not parse credentials, does not make network requests. **Identity parse failure and untrusted origin are different branches**: the current HTTP implementation sends anonymous requests for the former, letting the server authority decide, does not use old tokens; existing identity requests receiving 401 can at most re-fetch identity and retry once; this is not OAuth refresh token exchange, and does not delete credentials. 403/redirects are classified as failures. [official-auth.ts:115](../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts#L115), [official-auth.ts:155](../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts#L155), [official-auth.ts:296](../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts#L296).

Stdio official MCP injects the same-named namespace through `requestMetaProvider` for each outbound protocol message; normal third-party stdio MCP does not inject. Missing auth port explicitly returns `{ok:false, reason:"official_auth_unavailable"}`, does not find fallback identity through env or credentials files. [mcp/index.ts:568](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L568), [mcp/index.ts:599](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L599), [mcp/index.ts:1428](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1428).

Standalone CLI does not automatically construct official MCP identity headers just because local credentials files exist; protocol auth ports need Host context and workspaces to request service resolvers. [official-mcp-auth-port.ts:48](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts#L48).

### Which Relevant Secrets Are Not Written to credentials.json by This Path

| Secret/Field                                                            | Current Save or Pass Location                                                                                            | Reference and Boundary                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI final model API Key                                                 | `~/.zcode/cli/config.json` provider config                                                                               | [file-config.adapter.ts:331](../../apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts#L331); Desktop provider storage separately see the general document, do not generalize CLI rules to Desktop                                                                                                            |
| Model environment variable API Key                                      | Runtime reads provider `apiKeyEnv` or default env name                                                                   | [registry.ts:493](../../apps/zcode-cli/packages/adapters/src/model/registry.ts#L493); prefers explicit provider `apiKey`, no shared credential fallback                                                                                                                                                                      |
| App-server model `session-secret`                                       | `catalog.secrets` memory Map isolated by `workspace.workspaceKey`, key shaped like `model-provider:<providerId>:api-key` | [workspace-model-catalog.ts:1275](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L1275), [workspace-model-catalog.ts:1446](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L1446); this name resembling a credential key is not this file's key |
| App-server model `env` secret reference                                 | Retains env reference, resolves from passed env at read time                                                             | [workspace-model-catalog.ts:1523](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L1523)                                                                                                                                                                                               |
| ZAI CLI `poll_token`, flow/state                                        | Current login method memory and init/poll requests                                                                       | [cli-oauth.ts:88](../../apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts#L88); not long-term access/refresh tokens                                                                                                                                                                                                     |
| CLI BigModel setup intermediate access token                            | Memory variable after callback exchange, used to obtain final model API Key                                              | [auth-login.ts:254](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L254)                                                                                                                                                                                                                                          |
| Current MCP Phase 2's PKCE verifier, DCR client with unexchanged tokens | Current interactive authorization provider memory                                                                        | [oauth-interactive.ts:246](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L246), [oauth-interactive.ts:409](../../apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts#L409); after success, client enters canonical/mirror                                                                    |
| MCP client-credentials config `clientId/clientSecret`                   | MCP config object passed to SDK `ClientCredentialsProvider`                                                              | [mcp/index.ts:1547](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1547); this branch does not inject shared store, cannot claim writes `P:tokens`                                                                                                                                                                 |
| MCP static headers / stdio env                                          | MCP config/process startup environment directly passes                                                                   | [mcp/index.ts:1423](../../apps/zcode-cli/packages/adapters/src/mcp/index.ts#L1423); not credentials automatically expanded from shared store                                                                                                                                                                                 |
| `ZCODE_CREDENTIAL_SECRET`                                               | Local encryption key material in the environment                                                                         | [credential-cipher.ts:87](../../apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts#L87); not business JWT                                                                                                                                                                                                        |

Model registry replacement clears old `model-provider:*` memory secrets; removing providers deletes corresponding secrets: [workspace-model-catalog.ts:245](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L245), [workspace-model-catalog.ts:370](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts#L370). This does not equal modifying credentials files.

### Three Verified CLI Issues This Round

#### CLI-1: Same ZAI Access Key Token Type Split

The CLI writes the ready original OAuth access token to `oauth:zai:access_token`; the Desktop has explicitly clarified this key must store the MaaS JWT returned by `/api/auth/z/login`, and normalizes it in its own polling adapter. The CLI subsequently does obtain the MaaS JWT, but only uses it within the API Key resolver. The impact is that CLI login may overwrite the MaaS token that Desktop/official MCP/business usage consumers depend on. [auth-login.ts:166](../../apps/zcode-cli/packages/bootstrap/src/auth-login.ts#L166), [zaiProviderAdapter.ts:307](../../packages/services/src/oauth/providers/zaiProviderAdapter.ts#L307).

This round's synthetic harness executed real CLI login, OAuth adapter, API Key resolver, encrypted storage, and locks, injecting synthetic HTTP responses, with the final config writer as a stub recording only parameters; results: business requests using MaaS JWT=true, shared store storing original OAuth token=true, shared store storing MaaS JWT=false, final model API Key config success=true. No real network login was performed.

Existing [auth-login.test.ts:95](../../apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts#L95) already provides different OAuth token and business JWT responses, but [auth-login.test.ts:176](../../apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts#L176) incorrectly asserts original OAuth tokens persisting to the shared key. Subsequent fixes should first update this regression test and cross-Desktop consumer contract coverage.

#### CLI-2: Successful Login Does Not Completely Replace Old Platform Sessions

`saveZaiLoginCredentials()` only overwrites four keys, does not clean BigModel access/refresh/user, nor old ZAI refresh. Per the user's "only one platform login allowed, clear old JWT" contract, this is a direct inconsistency after successful publication; one cannot simply replace the active marker with zai and consider cleanup complete. [shared-credentials.ts:215](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L215).

#### CLI-3: Executing CLI Logout from BigModel Current Session Only Cleans Half

`clearZaiLoginCredentials()` unconditionally deletes shared ZCode JWT, retaining active=bigmodel and all BigModel namespaces. The issue is **global single session has not fully logged out**; per the user's latest rules, repair suggestions cannot be written as "retain the other platform's login." [shared-credentials.ts:70](../../apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts#L70).

CLI-2/3 have been verified with two independent temporary files, real shared storage source code, and real encryption/lock execution. Only outputting active provider and key existence:

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

**Confirmed issues separated from undetermined timing:** successful publication must guarantee single-platform credential set consistency; logout must completely clear current application sessions, already confirmable by rules and runtime results. "Logout old session immediately upon login click," "whether canceled user sessions remain logged out," "whether API Key/config update failure rolls back application login" are cleanup timing and transaction boundaries, which cannot be independently derived from the single-platform rule. This round does not independently determine these behaviors, and does not include third-party MCP OAuth and independent model Keys in the application login JWT cleanup set.

## Bot, Remote Connections, and Relay Credentials

Table values refer to decrypted business values. ICredentialService is a generic dictionary; this section lists the current producer-defined key families, not a whitelist limiting historical file contents.

### Bot Credentials: Same Key, Content Interpreted by Provider

| Key Pattern                                              | Decrypted Content                                    | Source                                                                                              | Major Consumer                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bot:<botId>:credential`, provider=`telegram`            | Telegram Bot token                                   | User-submitted token in Bot credentials input box; usually from BotFather                           | Telegram `getMe`, menu sync, message sending, long polling                                  |
| `bot:<botId>:credential`, provider=`feishu` / `lark`     | Feishu/Lark application app secret, not access token | Manually filled, or `client_secret` from scan-registration result                                   | App secret exchanges `tenant_access_token`, Feishu WebSocket and application APIs           |
| `bot:<botId>:credential`, provider=`weixin`              | Weixin iLink Bot token                               | Scan-login response `bot_token`, compatible field `token`; generic services also accept manual fill | iLink request's `Authorization: Bearer ...` and polling                                     |
| `bot:<botId>:webhook-secret`, provider=`webhook`         | Custom webhook shared secret                         | Provided by `saveBot({ webhookSecretValue })` callers                                               | Inbound callback comparison; outbound uses custom header name, default `x-zcode-bot-secret` |
| `bot:<botId>:webhook-secret`, provider=`feishu` / `lark` | Event callback verification token                    | Provided by `saveBot({ webhookSecretValue })` callers                                               | Compared with payload top-level `token` or `header.token`                                   |

Keys are generated by [config.ts:70](../../packages/services/src/bots/config.ts#L70), `:74`. The `botId` is trimmed in `saveBot`; keys have no workspace or user OAuth provider dimension; each Bot is isolated by its ID. `BotConfig` saves `credentialRef` / `webhookSecretRef`; actual values are stored separately in the credential repository. The current service accepts existing any ref, reading and deletion follow the ref itself; one cannot judge records as useless merely from non-standard key names ([bots.ts:96](../../packages/shared/src/bots.ts#L96), [botsService.ts:6127](../../packages/services/src/bots/botsService.ts#L6127), `:6221`).

Source and usage code evidence:

- Generic UI save: [BotsDialog.tsx:347](../../packages/ui/src/BotsDialog.tsx#L347); manual submission: `:816`. After scan-registration shares the same save entry, Feishu `appSecret` at `:438` / `:445`, Weixin `botToken` at `:564` / `:572`.
- Feishu registration returns `pollResponse.client_secret` as `appSecret`: [feishuAppRegistration.ts:164](../../packages/services/src/bots/providers/feishuAppRegistration.ts#L164). Weixin reads response `bot_token` / `token`: [weixinRegistration.ts:167](../../packages/services/src/bots/providers/weixinRegistration.ts#L167).
- Telegram reads ref and places into `https://api.telegram.org/bot${token}/getMe`: [telegramProvider.ts:323](../../packages/services/src/bots/providers/telegramProvider.ts#L323), `:327`.
- Feishu app secret exchanges tenant access token: [feishuProvider.ts:1093](../../packages/services/src/bots/providers/feishuProvider.ts#L1093). The obtained token is placed in module-internal `accessTokenCache`, not a new `credentials.json` key (`:1105`, `:1130`).
- Weixin read and Authorization header: [weixinProvider.ts:97](../../packages/services/src/bots/providers/weixinProvider.ts#L97), `:105`.
- Webhook/Feishu callback verification: [botsService.ts:3273](../../packages/services/src/bots/botsService.ts#L3273), `:3284`. Webhook outbound header: [webhookProvider.ts:211](../../packages/services/src/bots/providers/webhookProvider.ts#L211).
- Current `BotsDialog`'s `saveBot` wrapper only passes `credentialValue` ([BotsDialog.tsx:347](../../packages/ui/src/BotsDialog.tsx#L347)); `webhookSecretValue` is a service API support item, should not be written as all Bot UIs providing this field editing currently.

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

Updates and Recovery:

1. `saveBot` overwrites the same bot key for non-empty new values; when no non-empty new value is provided, does not write, keeping what the caller passed as BotConfig/ref. Writing secrets, parsing names, validation, and writing config sequence is in [botsService.ts:6127](../../packages/services/src/bots/botsService.ts#L6127), `:6140`, `:6171`, `:6174`.
2. Saving then refreshes Telegram, Weixin, Feishu runtime; runtime fingerprint is included in the actual credentials corresponding to the ref, so changing values under the same ref can also be recognized ([botsService.ts:6175](../../packages/services/src/bots/botsService.ts#L6175); `telegramChannelRuntime.ts:64`, `weixinChannelRuntime.ts:46`, `feishuChannelRuntime.ts:51`, all in the same directory).
3. `removeBotSecret` stops related runtimes, removes both refs and bound identities, clears state, then deletes ref-pointed credentials; the Bot itself is retained for re-binding ([botsService.ts:6183](../../packages/services/src/bots/botsService.ts#L6183), `:6199`, `:6221`).
4. `deleteBot` deletes configurations and state, and deletes credentials pointed to by both refs ([botsService.ts:6229](../../packages/services/src/bots/botsService.ts#L6229)). Ordinary disabling does not go through these two deletion entries, therefore not equivalent to revocation/deletion of credentials.
5. `saveConfig` directly replaces normalized Bot configurations and refreshes runtime, without scanning removed Bots' credentials for differential recovery ([botsService.ts:6099](../../packages/services/src/bots/botsService.ts#L6099)). No traversal of `bot:*` generic orphan credential GC has been seen currently. Cleanup depends on calling special deletion entries and retained refs.
6. Bot main credentials themselves have no expiresAt/refresh token structure; after invalidation, re-provide values or re-scan. Feishu short-term tenant token's cache/refresh exchange belongs to the provider memory layer and should not be counted in the persistent key list.

### Remote Connection Credentials: Isolated by Workspace Identity

| Key Pattern                                              | Value                                                               | Associated Config Field                    |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `remote-workspace:<workspaceKey>:password`               | SSH password, keeps original value, no trim                         | `target.passwordCredentialKey`             |
| `remote-workspace:<workspaceKey>:private-key-passphrase` | SSH private key passphrase, keeps original value                    | `target.privateKeyPassphraseCredentialKey` |
| `remote-workspace:<workspaceKey>:server-token`           | Token for connecting to complete ZCode Server, keeps original value | `target.tokenCredentialKey`                |

Constructor is in [remoteWorkspaceHistory.ts:30](../../packages/ui/src/lib/remoteWorkspaceHistory.ts#L30), `:34`, `:38`. `workspaceKey = resolvedWorkspaceIdentity?.trim() || workspacePath` (`:402`); connection identity is derived uniformly by `buildRemoteWorkspaceIdentity` (`:202`), SSH includes host, port, username, workspace path, WSL contains distro/optional user, Docker contains container, Server reuses `buildServerRemoteWorkspaceIdentity`. WSL/Docker currently has no such password/token keys.

The source is connection/reconnection submitted `RemoteTarget.password`, `privateKeyPassphrase`, `token`. `createRemoteTargetSnapshot` converts these plaintexts to refs, putting only non-sensitive connection parameters and refs into persistent history ([remoteWorkspaceHistory.ts:237](../../packages/ui/src/lib/remoteWorkspaceHistory.ts#L237)). Existing same-type snapshot refs will be reused, so early or custom refs may also continue to be valid; one cannot forcefully assume all refs in historical records can be recalculated by the current formula.

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

Reading and Recovery:

- UI restores SSH passwords, private key passphrases, and Server tokens: [reconnectRemoteWorkspaceHistoryEntry.ts:121](../../packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts#L121), `:132`; rebuilds target then calls connection entry (`:136`). Bot recovery of remote SSH workspaces also reads from settings history refs, see [botRemoteWorkspaceBridge.ts:115](../../packages/services/src/bots/botRemoteWorkspaceBridge.ts#L115), `:141`; this helper's explicit credential rebuild branch currently only covers SSH.
- On changes, refs no longer used in old snapshots are added to the deletion list; entries exceeding the 20-entry historical limit that are evicted, their refs are also added to the deletion list ([remoteWorkspaceHistory.ts:13](../../packages/ui/src/lib/remoteWorkspaceHistory.ts#L13), `:344`, `:429`, `:440`). Saved values are at `:451`.
- The specific write entry first attempts deletion, then writes new values, finally saves settings; deletion failures log warn then continue, write failures throw ([useRemoteWorkspaceHistory.ts:746](../../packages/ui/src/root/useRemoteWorkspaceHistory.ts#L746)). This is multiple single-key operations plus one settings write, not a cross-file transaction.
- On explicit removal of remote workspaces/tabs, history is saved after removal first, then the referenced credentials are deleted, failures logged as warn ([useRemoteWorkspaceHistory.ts:1358](../../packages/ui/src/root/useRemoteWorkspaceHistory.ts#L1358), `:1382`, `:1397`). Ordinary disconnect/temporary bridge separation does not equal removal history, will not automatically delete credentials based on this.
- There is no independent remote credential expiration/refresh protocol; updates occur when new connection inputs are saved; no scanning of all `remote-workspace:*` generic GC.

### External Relay Pairing Credentials

The only fixed key: `web-remote-control:external-relay:pass_hash` ([webRemoteControlRelayAuthStorageProvider.ts:4](../../packages/desktop/src/main/webRemoteControlRelayAuthStorageProvider.ts#L4)). The value is a `passHash` string; despite the name hash, it is used to generate authentication proofs, and is authentication material. `deviceSid` is the supporting non-sensitive identity, saved in settings' `webRemoteControlExternalRelayDevice.deviceSid`, not another credential key.

Source: the first registration produces 24 bytes of random password, SHA-256 then base64-encoded as passHash; the authentication proof is `HMAC-SHA256(passHash, nonce|role|deviceSid)`, base64url output ([webRemoteControlRelayAuthProvider.ts:15](../../packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts#L15)). The random original password is not separately saved to credentials.json.

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

Call chain and lifecycle:

- Main injects credential/settings services: [index.ts:931](../../packages/desktop/src/main/index.ts#L931). Starts reading and selecting persisted/register: [webRemoteControlManager.ts:1327](../../packages/desktop/src/main/webRemoteControlManager.ts#L1327); saving after new registration success: `:1446`.
- `load` reads both settings/deviceSid and credentials/passHash; both missing returns undefined, only one existing first clears then returns undefined ([webRemoteControlRelayAuthStorageProvider.ts:54](../../packages/desktop/src/main/webRemoteControlRelayAuthStorageProvider.ts#L54)).
- `save` first patches settings then writes passHash (same file `:80`); `clear` first clears settings then deletes passHash (`:44`); public `rotate` is clear then save (`:96`). Also not a two-file transaction, but load repairs unilateral missing state.
- The manager calls clear upon receiving invalid persisted auth ([webRemoteControlManager.ts:1398](../../packages/desktop/src/main/webRemoteControlManager.ts#L1398)); users resetPairing stops old runtime, clear, then starts (`:1537`). Ordinary starts reuse complete pairing materials, so closing one runtime should not be described as deleting pairing credentials.
- This key has no workspace isolation suffix, belonging to the desktop application's external relay pairing state. It is unrelated to model service OAuth tokens, Bot tokens, Server workspace tokens.

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

- Desktop base services create credential services at [node.ts:1213](../../packages/services/src/node.ts#L1213), injecting Bots (`:1919`).
- SSH/WSL/Docker host scopes explicitly retain local settings/credential services, while proxying remote files/tasks; [remoteWorkspaceServiceCollection.ts:83](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L83), `:239`, `:247`, `:255`. The corresponding renderer merge only covers workspace services, retaining base credential/Bot services: [remoteWorkspaceSessionServices.ts:3](../../packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts#L3). One cannot write Bot/connection authentication to a remote machine merely because the current workspace path is remote.
- Server remote is the exception: a complete Server is the business state authority, credential/Bot services directly delegate to the Server ([remoteWorkspaceServiceCollection.ts:316](../../packages/desktop/src/host/remoteWorkspaceServiceCollection.ts#L316), `:334`, `:339`; renderer same-file Server merge entry point is at [remoteWorkspaceSessionServices.ts:53](../../packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts#L53)).
- Mobile Web establishes bridge then receives services through the protocol, see [main.tsx:1838](../../packages/web/src/main.tsx#L1838); `RemoteServiceAccess` makes credential/Bot services into RPC proxies, see [remoteServiceAccess.ts:113](../../packages/client/src/remoteServiceAccess.ts#L113), `:134`. Unconnected home-only state credential load returns null ([main.tsx:1109](../../packages/web/src/main.tsx#L1109)), does not create browser-side credentials.json.
- Mobile `/remote` depends on windows' existing shared-host scope; credential file ownership is the same as attachment, and does not start another credential store/Agent for mobile replayable streams. Desktop `desktop-continuous` and mobile `web-remote-replayable` are message delivery boundaries, not this file's key naming rules. Current factual sources: [task-realtime-sync.md:9](../../docs/web-remote-control/task-realtime-sync.md#L9), `:22`; [web-remote-control-task-command-queue.md:20](../../docs/web-remote-control-task-command-queue.md#L20).

### Verified Behaviors and Issues Pending Verification

| Item                                                                   | Evidence Level                                  | Observations and Impact                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook provider.test reports success even with missing stored values  | Synthetic runtime replay executed               | Directly importing real `createWebhookBotProvider` with Node v24, with ref present, no webhookUrl, load always returning null, returns `{ok:true,message:"Webhook bot is enabled for inbound callbacks."}`, credential read count is 0. Source code [webhookProvider.ts:172](../../packages/services/src/bots/providers/webhookProvider.ts#L172). Only verifies the test connection branch, not the complete inbound service. |
| Bot callback skipping verification when missing secret                 | Static high-confidence candidate, not fully run | [botsService.ts:3273](../../packages/services/src/bots/botsService.ts#L3273), `:3284` only rejects when expectedSecret/expectedToken are truthy and not equal; ref present but load returns null/empty string will skip this check. Cannot treat the previous provider.test replay as this line being fully replayed.                                                                                                         |
| Bot save rejection may still update credentials or leave orphans       | Static candidate, not run                       | First `credentialService.save` (`botsService.ts:6127`) then `validateBotConfig` (`:6171`). For example, duplicate providerUserId validation failure may occur after secret writing; requires complete service fixture verification and determining transaction boundaries.                                                                                                                                                    |
| Remote failure reconnection may overwrite existing correct credentials | Static candidate, not run                       | `remoteWorkspaceHistory.ts:404` preserves old snapshot when failed/currentEntry, but `:451` still builds credentialsToSave with the submitted target. Requires real connection failure/persistent call chain testing; not claimed as reproduced from this.                                                                                                                                                                    |

## Audit Conclusions and Verification Records

### Synthetic Runtime Evidence Obtained

| Scenario                                                              | Result                                                                                                                              | Scope of Conclusion                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop ZAI → BigModel, BigModel → ZAI successful submission          | Both directions delete the opposite platform's namespace keys; JWT operation order is delete → save; new JWT retained               | Synthetic verification of current Repo and persistOAuthSession source code methods. Did not verify legacy keys fully cleared, does not mean real UI E2E passes                                             |
| CLI ZAI login                                                         | Business requests use the converted MaaS JWT, but shared access key still holds original OAuth token                                | CLI-1 confirmed: semantic split in shared field writes                                                                                                                                                     |
| CLI logging ZAI from old BigModel session                             | Active becomes zai, new JWT overwrites; old BigModel access/refresh/user and old ZAI refresh retained                               | CLI-2 confirmed: old credential cleanup incomplete; cannot directly express retained fields as two active providers being active simultaneously                                                            |
| Executing CLI logout from BigModel session                            | JWT disappears, active=bigmodel and BigModel namespace retained                                                                     | CLI-3 confirmed: session only cleaned half; the correct issue is not deleting retained old JWTs                                                                                                            |
| Desktop cached restore encountering JWT decryption error individually | Throws error, active marker not cleaned through Repo's unified recovery logic                                                       | Real restore method paired with error injection; needs corresponding corruption recovery test cases added                                                                                                  |
| Desktop same-platform re-login cancellation during persistence        | Rollback writes back old access/profile, the previously restored old JWT is then deleted by another domain's clearProvider          | Confirms current rollback state inconsistency. Whether to retain old sessions or remain logged out depends on the submission/cancellation contract, cannot directly treat restoring old JWTs as the repair |
| Desktop/CLI encrypted environment variable contains whitespace        | Normal values are mutually decryptable; both leading/trailing whitespace and fully-whitespace cases cause mutual decryption failure | Real cipher synthetic interoperability verification, no real tokens or keys                                                                                                                                |
| Inbound-only Webhook's test                                           | Ref present but does not call loadCredential and still returns success                                                              | Only verifies the test branch; does not pretend to be the complete callback service's credential verification replay                                                                                       |

The table above executes current source code or actual methods extracted from source code using Node 24; HTTP, configuration writing, or peripheral dependencies are injected via fixtures per scenario. They can prove the results of corresponding function paths, but cannot replace Desktop, mobile, real servers, and cross-OS end-to-end verification.

### Boundaries Needing Continued Verification or Clarification

- **Login transaction timing:** Clicking start, ready/exchange completion, credential publishing, and model API key/config updates are not the same moment; the final state when the user cancels or any step fails should be determined together with the submission boundary.
- **Old session cleanup set:** Legacy `auth_token/refresh_token`, orphaned JWT when active is missing, residuals of unregistered providers, old OAuth session's corresponding built-in Coding Plan/Start Plan credentials, and WebView copies should all be included in the cleanup scenario checklist ([Derived cleanup implementation](../../packages/services/src/oauth/oauthProviderLogout.ts#L14)). Normal manually-entered model API keys do not therefore get included in App login cleanup scope. Cannot implement "clear old JWT" as clearing the entire credentials file.
- **Cross-process consistency:** File write locks already exist, but multiple independent key operations, multiple reads, and multiple OAuthService instances do not constitute a global login transaction. Whether batch publishing/snapshot reading is needed should be decided in conjunction with interleaved reproduction.
- **Bot and remote candidates:** Callback skipping verification when missing secret, Bot validation writing secret before failure, reconnection after failure still queueing new credential saves are currently static candidates; the complete call chain has not been executed.
- **MCP and App account relationship:** The MCP namespace currently has no App account/workspace dimension; App logout does not automatically revoke MCP authorization. Whether to follow App account cleanup is an independent design choice.
- **Local encryption migration:** The default key source and two-sides' whitespace differences need to account for old files; changing only the new key derivation is not sufficient. Plaintext compatibility and unknown encryption prefixes should also be defined together with the version migration strategy.
- **Archive variants:** Desktop currently excludes credentials.json by exact filename; feedback fallback excludes by path substring; the actual handling of corruption backups and temp files in the two archive paths requires separate test cases; this document does not claim all credential copies are excluded.

### Existing Test and Documentation Check Entry Points

| Coverage Direction                                                         | Currently Checkable Test Files                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic storage encryption, concurrent writes, corrupted JSON retention    | [credentialService.test.ts](../../packages/services/test/credentialService.test.ts), [CLI auth.test.ts](../../apps/zcode-cli/packages/adapters/tests/auth.test.ts)                                                           |
| Desktop login platform switching, expiry/corruption recovery, cancellation | [oauthService.test.ts](../../packages/services/test/oauthService.test.ts)                                                                                                                                                    |
| CLI login exchange and field persistence                                   | [auth-login.test.ts](../../apps/zcode-cli/packages/bootstrap/tests/auth-login.test.ts); the original OAuth token persisting to shared key assertion needs correction per contract                                            |
| MCP OAuth, cross-process authorization/refresh                             | [mcp-oauth-refresh.test.ts](../../apps/zcode-cli/packages/adapters/tests/mcp-oauth-refresh.test.ts), [mcp-oauth-cross-process.e2e.test.ts](../../apps/zcode-cli/packages/adapters/tests/mcp-oauth-cross-process.e2e.test.ts) |
| Official MCP identity selection                                            | [officialMcpCredentials.test.ts](../../packages/services/test/officialMcpCredentials.test.ts)                                                                                                                                |
| Browser independent login storage                                          | [browserOAuthCredentialRepo.test.ts](../../packages/web/test/browserOAuthCredentialRepo.test.ts)                                                                                                                             |
| Desktop interaction regression entry                                       | [desktop-auth-config-e2e-cases.md](../testing/desktop-auth-config-e2e-cases.md); actual login interaction changes need corresponding E2E added; do not only cover private methods                                            |

Existing documents cannot replace current code facts: for example, [OAuth implementation notes](../oauth/oauth-multi-provider-implementation.md) still has old descriptions of ZAI token source and conversion timing, [CLI auth-login](../../apps/zcode-cli/docs/design/v2/auth-login.md) records the current CLI's original OAuth token persistence method, which is inconsistent with the Desktop's same-file consumer contract. Subsequent modifications should unify these specs and tests, avoiding fixing code alone while continuing to preserve contradictory conventions.

This pass only adds the organization document, without implementing fixes. The baseline freshness check passed; `pnpm typecheck` and `pnpm lint` have been executed, but the current worktree has no node_modules, so neither tsc / oxlint could run respectively. Vitest, Desktop E2E, mobile remote control E2E, Windows/Linux regressions are not declared as passed.
