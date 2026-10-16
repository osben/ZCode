# Exa MCP OAuth Re-authentication Root Cause Analysis

> Analysis date: 2026-08-13
> Analysis baseline: `exa-oauth-analysis` / `bfc91c54a9507beae4820c58f86a25fc3c44104d`
> Scope: Analysis only, no production code changes, no OAuth authorization or token requests executed
> MCP server: `plugin:exa:exa`

## 1. Conclusion Summary

### Problem 1: Why Re-authentication Is Required After a Period of Time

The confirmed direct mechanism is:

1. The current ZCode implementation persists and loads refresh tokens; after successful refresh, it also atomically updates the client/token pair. No code bug was found in the current implementation that causes "refresh tokens must be lost after normal save and restart."
2. The MCP SDK, when MCP returns unauthorized, prioritizes using saved refresh tokens. If Exa returns `invalid_grant`, the SDK deletes tokens, retains the client, then retries and enters browser authorization.
3. The local runtime environment at the time was exactly "only client/discovery remains, no token/canonical pair," so the current state must necessarily enter re-authorization rather than continuing refresh.
4. 2026-08-12 logs show Exa could connect at `08:54:49Z`, and by `09:00:13Z` had entered interactive authorization, matching the timeline of "access token expired, refresh did not recover, tokens were invalidated."

However, existing logs do not record the Exa token endpoint's response status and OAuth error codes, so it cannot be uniquely determined from the current evidence alone whether the upstream cause of refresh failure is:

- Exa actively expired/revoked the refresh token;
- historical old versions or concurrent authorization once generated client/token mismatches;
- other Exa server-side policies or temporary errors.

The current credential implementation has already used canonical pairs, cross-process file locks, and compare-and-delete to handle client/token interleaved overwrites. Therefore, "desktop and CLI's current code still commonly overwrite each other's tokens" is not the confirmed root cause of this case; writing legacy keys from un-upgraded old processes remains a compatibility window risk.

**Qualitative assessment:**

- Re-authorization after refresh failure: normal OAuth degradation behavior.
- Token endpoint error codes not recorded, unable to distinguish between token expiry, revocation, client mismatch, and server errors: **observability design defect**.
- Tokens missing from the current environment: **confirmed fact**; the specific deletion reason is influenced by 2026-08-11's manual reset operation, not all attributable to programs.
- Multiple independent runtimes can simultaneously initiate OAuth/DCR for the same MCP: **architecture design defect**, amplifying credential generation and re-authentication instability.

### Problem 2: Why Secondary Authentication Times Out

The direct root cause is confirmed:

- The session startup path hard-codes the manual OAuth wait limit to **15 seconds**.
- This value overrides `oauth.ts`'s default **5 minutes**.
- After 15 seconds, the connection is marked as `MCP server plugin:exa:exa OAuth authorization timed out`, the local callback server is closed, and the current state's PKCE verifier is cleared.
- Users logging in via browser, selecting teams, reading pages, and clicking Authorize typically cannot stably complete within 15 seconds.

The settings page's own background connections typically do not pass 15 seconds, instead using 5 minutes; but the settings page lease and Session lease are established with different connections by default based on session isolation, so they have different `mcpConnectionId`, callback ports, states, and browser URLs. The settings page's 5-minute wait cannot extend or take over the Session's 15-second OAuth.

**Qualitative assessment:**

- Session limiting human-browser authorization to 15 seconds: **implementation bug / product behavior bug**.
- Settings page and Session establishing multiple independent authorization transactions for the same OAuth identity, lacking cross-lease/process single-flight: **architecture design defect**.
- The callback listener and PKCE state timeout cleanup itself is basically correct, not the stale state root cause.

### Exa `Server Components render` Error

The strongest ZCode-side contributor is:

1. DCR registration writes the current random localhost port into `redirect_uris`.
2. Subsequent OAuth sessions each re-listen to another random port.
3. ZCode prioritizes reusing the persisted old `client_id`.
4. Post-refresh second authorization therefore may send "old `client_id` + new `redirect_uri`."

The current client's registered redirect URI port is `54735`; 2026-08-13's failed authorization used new ports `58670`, `58676`. If Exa performs exact matching on DCR redirect URIs, this triggers redirect validation failure; when Exa Next.js authorization pages do not render this as a normal OAuth error page, it may manifest as a generic Server Components production error.

This is a **high-confidence inference, not directly captured Exa server-side stack traces**. RFC 8252 allows arbitrary ports for loopback native client authorization during authentication; compliant servers may ignore port differences; this case has no logged-in network trace, cannot confirm whether Exa implements this exception. Anonymous read-only probes show both redirects first `307` to login entries, indicating Exa delays final validation to post-login, failing to confirm or exclude mismatch at the anonymous stage.

Additionally, multi-connection concurrency produces multiple client/state/authorization URLs, causing users to click on already-timed-out URLs or non-target connection URLs; this is a confirmed amplifier. Exa pages using generic SSR errors instead of structured OAuth errors is also the other party's page robustness issue.

## 2. Fact Boundaries and Evidence Levels

This document uses the following markers:

- **Confirmed**: Code, logs, or local persistent state can directly prove.
- **Strong consistent inference**: Implementation behavior matches on-site form, but missing token endpoint or Exa server logs.
- **Candidate contributor**: Valid in the protocol, current evidence cannot be ordered to the unique root cause.

Key evidence not obtained:

- Exa `/api/oauth/token` HTTP status, `error`, `error_description` for failed refresh responses.
- Logged-in state browser Network trace and Next.js digest for `dashboard.exa.ai` / `auth.exa.ai`.
- Exa server-side client registry, redirect validation, and Server Components stack traces.

Therefore this document will not write `invalid_grant`, `invalid_redirect_uri`, or Exa deleting DCR clients as directly observed facts.

## 3. Actual Plugin Configuration and OAuth Discovery

### 3.1 Actually Loaded Plugin Configuration

Actual official plugin manifest:

`~/.zcode/cli/plugins/cache/claude-plugins-official/exa/3.4.0/.claude-plugin/plugin.json:10-17`

```json
{
  "exa": {
    "type": "http",
    "url": "https://mcp.exa.ai/mcp?client=claude-code-plugin",
    "headers": {
      "x-exa-source": "claude-code-plugin"
    }
  }
}
```

The plugin root directory additionally has `mcp.json:3-9`, with URL parameter `client=agent-plugin`. But the current loader by default looks for `.mcp.json` (with leading dot), and that directory has no `.mcp.json`; actual definitions come from the manifest. If `.mcp.json` existed, the loader would use `{ ...fromFile, ...fromManifest }`, with manifest overriding same-named items, see:

- `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:17-24`
- `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:34-42`

Therefore the current actual configuration and credential prefix correspond to the `claude-code-plugin` URL; the root directory's `mcp.json` does not enter this loading path.

The manifest has no explicit OAuth configuration. For HTTP/SSE MCP without Authorization headers, ZCode automatically enables authorization_code discovery:

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:1012-1025`

### 3.2 2026-08-13 On-site Discovery

A credential-less read-only request was made to the MCP endpoint:

```text
HTTP 401
WWW-Authenticate:
  Bearer resource_metadata="https://mcp.exa.ai/.well-known/oauth-protected-resource/mcp"
```

Resource metadata:

```text
resource              https://mcp.exa.ai/mcp
authorization_server  https://auth.exa.ai
scope                 mcp:tools
```

Authorization server metadata:

```text
authorization_endpoint              https://auth.exa.ai/oauth/authorize
token_endpoint                      https://auth.exa.ai/api/oauth/token
registration_endpoint               https://auth.exa.ai/api/oauth/register
grant_types_supported               authorization_code, refresh_token
code_challenge_methods_supported    S256
token_endpoint_auth_methods         none
```

Exa explicitly declares support for refresh tokens and public clients. Its scopes do not include `offline_access`, but one cannot claim it does not issue refresh tokens on this basis; the MCP SDK only appends this scope when the server declares `offline_access`.

## 4. First Authorization Timing

The following timing combines code and 2026-08-11 real logs. Three OAuth connections appeared simultaneously that day; two failed around 15 seconds, another succeeded around 74 seconds.

```text
User/Browser          Settings page lease       Session lease A/B       OAuth Provider       Exa Auth        Credentials file
    |                  |                       |                       |                 |              |
    |                  | connect              | connect               |                 |              |
    |                  +---------------------->|                       |                 |              |
    |                  |                       +---------------------->|                 |              |
    |                  |                       |   Each connection builds its own callback server          |              |
    |                  |                       |   Ports 54723 / 54726 / 54735                             |              |
    |                  |                       |<----------------------|                 |              |
    |                  |                       |                       | discovery       |              |
    |                  |                       |                       +---------------->|              |
    |                  |                       |                       | DCR: redirect_uri=current port      |
    |                  |                       |                       +---------------->|              |
    |                  |                       |                       |<-- client_id ----|              |
    |                  |                       |                       | save client_information         |
    |                  |                       |                       +------------------------------->|
    |<-----------------+-----------------------+--- Display one or more authorization URLs ----|              |
    |                  |                       |                       |                 |              |
    |                  |                       |-- 15 second timeout ----------X                 |              |
    |                  |                       | close callback + clear current state verifier  |              |
    |                  |                       | failed / tools=0                                |              |
    |                  |                       |                       |                 |              |
    |  Login/select team/click Authorize (approx 74s) |                       |                 |              |
    +---------------------------------------------------------------->|<-- callback code-|              |
    |                  |                       |                       | code exchange    |              |
    |                  |                       |                       +---------------->|              |
    |                  |                       |                       |<-- access/refresh tokens -------|
    |                  |                       |                       | saveMany(canonical, client, tokens)
    |                  |                       |                       +------------------------------->|
    |                  | connected / 2 tools   |                       |                 |              |
```

Real logs (fields minimized, no URLs, codes, or tokens included):

```text
~/.zcode/cli/log/zcode-2026-08-11.jsonl

3779  11:25:53.335Z authorization.required connection=9df9... callback=54723
3781  11:25:53.627Z authorization.required connection=06c8... callback=54726 session=yes
3785  11:25:54.502Z authorization.required connection=85a0... callback=54735
3819  11:26:08.351Z failed connection=9df9... OAuth authorization timed out
3824  11:26:08.631Z failed connection=06c8... OAuth authorization timed out
3936  11:27:08.338Z authorization.completed connection=85a0...
3948  11:27:11.248Z connected connection=85a0... tools=2
```

From `11:25:54.502Z` to `11:27:08.338Z` is approximately 73.8 seconds, directly proving that human authorization time can far exceed 15 seconds, while being less than 5 minutes.

## 5. Problem 1: Refresh Token Saving, Loading, and Invalidation

### 5.1 Current Implementation Saves and Loads Refresh Tokens

The OAuth provider reads clients and tokens from the same credential pair:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:182-199`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:213-215`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:434-505`

After token exchange or refresh, `saveTokens` publishes:

- `authorization_credentials`: canonical client/token pair;
- `client_information`: legacy client mirror;
- `tokens`: legacy token mirror;

via one `saveMany` publish:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:217-250`

`saveMany` updates multiple keys in one read-modify-write:

- `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:152-161`

The entire read-modify-write is protected by cross-process file locks, then atomically written back:

- `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:260-270`

The credential file permission on-site is `0600`.

Conclusion: In the current implementation, refresh tokens are not only in memory, nor does desktop and CLI without locks each independently overwrite the entire file.

### 5.2 Client/Token Pairing Protection

The current canonical v2 logic explicitly handles the following concurrent situations:

- When legacy tokens are deleted, do not revive old tokens from canonical: `oauth.ts:439-447`
- Only continue using the canonical pair when legacy tokens match canonical tokens: `oauth.ts:448-460`
- When client is unchanged, can accept new refresh results written by old processes: `oauth.ts:461-467`
- When both client and token change and cannot prove belonging to the same transaction, retain client, discard untrustworthy tokens: `oauth.ts:468-476`
- When invalidating old snapshots, use compare-and-delete, do not delete new pairs just written by other transactions: `oauth.ts:334-373`

Corresponding tests:

- Concurrent adapter PKCE state isolation: `mcp-oauth.e2e.test.ts:248-349`
- DCR clients bound to their own transactions: `mcp-oauth.e2e.test.ts:351-375`
- Canonical pair atomic publish: `mcp-oauth.e2e.test.ts:482-512`
- Mixed-version read/write: `mcp-oauth.e2e.test.ts:514-601`
- Reject stitching legacy client/tokens from different transactions: `mcp-oauth.e2e.test.ts:603-643`
- Compare-and-delete: `mcp-oauth.e2e.test.ts:645-680`
- Refresh using the winning canonical pair: `mcp-oauth.e2e.test.ts:686-773`

Therefore, "clients and refresh tokens are frequently overwritten by concurrency into wrong combinations" has no static or testing evidence support in the current version. Historical old versions did have this risk, which is the fix reason for the above compatibility and canonical logic; if machines simultaneously run un-upgraded processes, legacy writes may still cause new readers to actively discard tokens and require re-authorization due to inability to prove pairing.

### 5.3 SDK Behavior After Access Token Expiration

Repository lock:

`apps/zcode-cli/packages/adapters/package.json:105`

```text
@modelcontextprotocol/client 2.0.0
```

Read-only verification of the npm published package `@modelcontextprotocol/client@2.0.0/dist/index.mjs`:

- `754-779`: When refresh tokens exist, first call the token endpoint, call `provider.saveTokens` after successful refresh.
- `780-790`: No available refresh, or after recoverable refresh errors, generate new authorization URLs, PKCE verifiers, and enter interactive authorization.
- `610-624`:
  - `invalid_grant`: retry after invalidating tokens;
  - `invalid_client` / `unauthorized_client`: retry after invalidating clients and tokens.

ZCode provider's invalidate implementation is located at:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:296-305`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:334-373`

Therefore, the path after access token expiration is:

```text
MCP 401
  -> SDK tries refresh_token
     -> Success: saveTokens, new access token persisted
     -> invalid_grant: delete tokens, retain clients, transition to browser authorization
     -> invalid_client: delete clients + tokens, re-DCR/authorization
     -> Partial server_error: can fall back to browser authorization directly, may not first delete old clients
```

### 5.4 Local Credential On-site

The authoritative credential file is:

```text
~/.zcode/v2/credentials.json
mode: 0600
Exa credential prefix: mcp:oauth:c50fd1fa63fb88a233be0688
```

Currently only:

```text
discovery_state
client_information
```

Currently does not have:

```text
tokens
authorization_credentials
code_verifier
```

The current client information is only recorded as anonymized summaries:

```text
client_id SHA-256 first 12 characters: d31ae07a373b
client_name: ZCode plugin:exa:exa
client_secret: none
client_id_issued_at: 2026-08-11T11:25:54Z
grant_types: authorization_code, refresh_token
registered redirect URI:
  http://127.0.0.1:54735/oauth/callback/mcp/plugin%3Aexa%3Aexa
```

`credentials.json:27-28` also only shows the above two Exa keys; this document does not read or record any token plaintext.

Historical human backup/reset file Exa keys also only contain client/discovery/verifier, no tokens, and clients change multiple times:

```text
credentials.json.exa-backup-20260725-215609   client hash c27de9b37128
credentials.json.exa-backup-20260725-215921   client hash 1ed8dd1faa86
credentials.json.exa-backup-20260725-220036   client hash a040da9c8465
credentials.json.exa-reset-20260811-192515    client hash fa0c35e0d90f
credentials.json                              client hash d31ae07a373b
```

These file names themselves indicate the on-site contains human backup/reset. Therefore:

- "Currently no tokens" is a fact;
- "All tokens were abnormally deleted by programs" is not a provable conclusion;
- Repeatedly generating new DCR clients is a fact, consistent with multi-authorization transaction concurrency and human resets.

The user-specified `~/.zcode/db` does not exist locally; actual SQLite is at `~/.zcode/cli/db/db.sqlite`. Its schema has no OAuth credential/MCP credential tables; the OAuth credential authority source is still `~/.zcode/v2/credentials.json`.

### 5.5 Runtime Timeline

```text
~/.zcode/cli/log/zcode-2026-08-12.jsonl

1816  08:54:49.770Z  Exa connected, tools=2
1899  09:00:13.958Z  Exa authorization.required, callback=61820
1909  09:00:28.969Z  OAuth authorization timed out
```

"First connection success, approximately 5 minutes later new connections enter authorization" rules out "first authorization never saved/never took effect." This is consistent with tokens subsequently becoming un-refreshable.

### 5.6 Problem 1 Root Cause Conclusion

| Layer                            | Conclusion                                                               |          Evidence Level | Qualitative                    |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------: | ------------------------------ |
| Direct trigger                   | Currently no available tokens, SDK can only re-authorize                 |               Confirmed | State fact                     |
| Refresh flow                     | Has refresh tokens, will load, try refresh, persist after success        |               Confirmed | Implementation correct         |
| After refresh failure            | `invalid_grant` deletes tokens; `invalid_client` deletes client+tokens   |               Confirmed | Reasonable degradation         |
| This specific refresh error      | Logs do not record, cannot uniquely determine                            |           Confirmed gap | Observability design defect    |
| Current multi-process overwrites | Canonical pairs + file locks already protect normal writes               |               Confirmed | Not current primary root cause |
| Old process/legacy mixed writes  | Cannot prove pairing will actively discard tokens                        | Confirmed code behavior | Compatibility risk             |
| Concurrent OAuth/DCR             | Different leases/processes can repeatedly authorize and register clients |               Confirmed | Architecture design defect     |

## 6. Problem 2: 15-Second Timeout Chain and Connection Isolation

### 6.1 Where the 15 Seconds Are Passed In

Session runtime definition:

- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts:5`

```ts
const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;
```

Passed in at session startup:

- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts:37-46`

```ts
connectConfiguredServers(servers, {
  oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
  // ...
});
```

Passed by the adapter to OAuth sessions:

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:680-719`
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:770-787`

```ts
authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs;
```

Actual use when waiting for callbacks `oauthSession.timeoutMs`:

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:570-600`

```ts
withTimeout(
  oauthSession.waitForAuthorizationCallback(),
  oauthSession.timeoutMs,
  `MCP server ${name} OAuth authorization timed out`,
);
```

The OAuth module's default 5 minutes only takes effect when callers do not override:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:20`
- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:96-107`

```ts
timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS;
```

Therefore, secondary authentication triggered by Session startup definitely hits 15 seconds, not 5 minutes.

### 6.2 Why the Settings Page Cannot Rescue the Session

The settings page `mcp/list` does not pass `oauthAuthorizationTimeoutMs` when initiating background connections:

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:81-105`

This connection typically uses the default 5 minutes. Logs show multiple instances of connections timing out after approximately `300xxx ms`, for example:

```text
~/.zcode/cli/log/zcode-2026-08-11.jsonl:1920
durationMs=300864
error=MCP server plugin:exa:exa OAuth authorization timed out
```

But the protocol entrypoint issues different leases for settings pages and Sessions:

- Settings page: `protocol-settings`
- Session: `appOptions.sessionId`

See:

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts:101-115`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts:126-133`

The connection pool default isolation is `session`, and connection keys for non-workspace-isolated servers use `leaseId`:

- `apps/zcode-cli/packages/adapters/src/mcp/pool.ts:296-308`
- `apps/zcode-cli/packages/adapters/src/mcp/pool.ts:317-328`

Therefore:

```text
protocol-settings lease
  -> connection A
  -> callback port A
  -> state A
  -> Default 5 minutes

session lease
  -> connection B
  -> callback port B
  -> state B
  -> 15 seconds
```

`index.ts:153-168` pending connection reuse only applies within the same adapter/record, cannot share across pool entries.

### 6.3 2026-08-13 Concurrent Runtime Evidence

```text
~/.zcode/cli/log/zcode-2026-08-13.jsonl

6657  08:25:15.711Z required
      connection=461a95... session=yes callback=58676 state=17f0...
6658  08:25:15.747Z required
      connection=fb8aa7... session=no  callback=58670 state=7c51...

6680  08:25:30.722Z connection=461a95... timed out
6683  08:25:30.754Z connection=fb8aa7... timed out
```

Two connections established different callback ports and states for the same Exa server at the same moment, each failing after approximately 15 seconds. This directly proves the current runtime does not form a global OAuth single-flight.

### 6.4 Secondary Authorization Failure Timing

```text
Session/Settings page    OAuth Provider        Credentials file      MCP SDK          Exa Auth/Page       Browser
     |                    |                   |                 |                    |               |
     | connect            |                   |                 |                    |               |
     +------------------->| load client/tokens|                 |                    |               |
     |                    +------------------>|                 |                    |               |
     |                    |<-- Old clients; tokens may/may not exist |                    |               |
     |                    |                   |                 | MCP 401 / refresh |
     |                    +------------------------------------>|------------------->|
     |                    |                   |                 |                    |
     |                    |                   |      Refresh failed/unavailable              |
     |                    |<------------------------------------|                    |
     |                    | invalidate tokens (specific error not recorded)            |
     |                    +------------------>| delete token    |                    |
     |                    |                   |                 |                    |
     |                    | New random callback port + new state            |                    |
     |                    | Reuse old client_id                     |                    |
     |                    +------------------------------------>| authorize request  |
     |                    |                                     | Old client_id       |
     |                    |                                     | New redirect_uri    |
     |                    |                                     +------------------->|
     |                    |                                     |                    | Authorize page
     |                    |                                     |                    | May show SSR error
     |                    |                                     |                    |
     |<-- authorization URL/status -----------------------------+                    |
     |                                                                 15s timer      |
     |--------------------------- 15 seconds ------------------------------X               |
     |                    | close callback server                                  |
     |                    | clear current state verifier                           |
     |<-- failed/tools=0  |                                                         |
     |                                                                 User later clicks  |
     |                                                                 callback to old port |
     |                                                                 -> closed/failed   |
```

If the settings page makes independent connections, the last timing point is typically 5 minutes; it may still exist in parallel with the Session's 15-second transaction.

### 6.5 Whether Timeouts Leave Stale State

Callback servers:

- Randomly listen on `127.0.0.1:0`: `apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts:69-83`
- Strictly check paths, states, and codes: `localhost-callback.ts:32-59`
- `close()` closes HTTP server: `localhost-callback.ts:83-90`

OAuth sessions:

- `close()` first closes callback servers, then closes providers: `oauth.ts:96-100`
- Provider `close()` clears current state verifiers: `oauth.ts:312-331`
- Verifier keys contain complete states: `oauth.ts:538-545`

No Exa `code_verifier` exists in the current credentials, consistent with successful cleanup. `discovery_state` will be retained; it is reusable discovery metadata, not callback stale state.

What truly remains is:

- Browser URLs still open, but callback ports already closed;
- DCR clients already registered but no longer in use on Exa server-side;
- Users facing multiple URLs cannot know which remain valid.

Therefore:

- Callback listener not cleaned up: **No, not found**.
- PKCE verifier cross-state mis-deletion/leave: **Current implementation and on-site do not support this judgment**.
- Stale browser URLs / stale DCR clients: **Exist a design-possible generation path**.

## 7. Evidence Chain for Exa Server Components Errors

### 7.1 Old Clients with New Redirect URIs

Each OAuth session creates new states and random ports:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:67-80`
- `apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts:69-83`

DCR metadata uses the current complete callback URL:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:163-175`

Subsequent prioritizes reading and storing clients:

- `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts:182-199`

The MCP SDK constructs authorization requests using:

- `clientInformation`: old clients;
- `provider.redirectUrl`: current new random port.

See npm packages:

- `@modelcontextprotocol/client@2.0.0/dist/index.mjs:698-730`
- `@modelcontextprotocol/client@2.0.0/dist/index.mjs:780-790`

On-site comparison:

```text
Register redirect port: 54735
Subsequent log port examples: 61820, 58670, 58676
```

This proves ZCode indeed constructs "persisted clients + new callback port" combinations.

### 7.2 Why Only Defined as High-Confidence Inference

A read-only probe without logged-in state or authorization clicks was performed on the current anonymized clients:

```text
Registered redirect  -> HTTP 307 -> auth.exa.ai /?callbackUrl=...
Mismatched redirect  -> HTTP 307 -> auth.exa.ai /?callbackUrl=...
```

Both requests first enter the login page; anonymous responses do not expose the final redirect validation results, nor show Server Components errors. Therefore:

- Cannot claim having caught `invalid_redirect_uri`;
- Cannot exclude Exa correctly allowing loopback port changes per RFC 8252;
- User login state pages' generic SSR errors still require Network traces or Exa logs for confirmation.

Pages can still display `Authorize ZCode plugin:exa:exa`, indicating it at least obtained the client display information; this reduces the probability of "client_id completely not existing," but cannot exclude incomplete client states, team binding anomalies, or authorization record abnormalities.

### 7.3 Other Candidate Contributors

Ordered by current evidence:

1. **Old DCR clients + new callback port redirect validation/page handling anomalies**
   ZCode combination is confirmed; whether Exa rejects is unconfirmed.
2. **Concurrent authorization URLs / timed-out URLs**
   Multi-connections, multi-states, multi-ports already confirmed by logs. Users may log in or click on incorrect transactions.
3. **Exa Personal team / account server-side data anomalies**
   Compatible with the pages' Server Components errors, but no ZCode-side verifiable evidence.
4. **Repeated DCR itself conflicts**
   ZCode generating multiple clients is confirmed; but DCRs usually allow registering multiple clients; no evidence of Exa returning conflicts currently.

### 7.4 Qualitative Assessment

- ZCode long-term reuses DCR clients bound to specific callback URIs while using random callback ports each time: **implementation/design boundary defect**. Even if Exa supports loopback port exceptions, should not rely on unverified server-side lax behavior.
- ZCode lacks single-flight for the same OAuth identity, generating multiple URLs and multiple DCR clients: **architecture design defect**.
- Exa pages displaying OAuth parameter/account data issues as generic Server Components production errors: **Exa page robustness bug**.

## 8. Test Coverage and Gaps

Existing tests cover:

- Single adapter reusing pending OAuth, bounded caller timeouts do not close shared connections: `mcp.test.ts:880-932`
- Per-connect OAuth timeout takes effect: `mcp.test.ts:994-1032`
- Two adapters concurrent PKCE isolation: `mcp-oauth.e2e.test.ts:248-349`
- DCR client transaction binding, canonical pairs, mixed-version, refresh: see Section 5.2.

Key gaps:

1. No tests for "DCR clients registering ports different from new callback ports after session rebuild."
2. No strict simulation of authorization servers performing exact `redirect_uri` matching or RFC 8252 loopback port exceptions.
3. No coverage of `protocol-settings lease + session lease` parallel authorization for the same server.
4. No tests for complete ZCode state, logs, and secondary authorization URLs after refresh returns `invalid_grant`.
5. No human-machine authorization time exceeding 15 seconds product behavior tests.
6. No assertions that token endpoint errors are sensitively recorded as diagnosable events.

## 9. Repair Suggestions (Suggestions Only, Not Implemented)

### P0: Fix 15-Second Human-Machine Authorization Timeout

Do not equate Session startup's blocking budget with OAuth transaction lifecycle:

```text
Session startup budget 15 seconds
  -> Only decides "whether this Session continues waiting"
  -> Does not close global/settings page OAuth transactions

OAuth transaction lifecycle
  -> Independent 5 minutes or user cancel
  -> Status continues displaying on settings page
  -> Subsequent Sessions automatically reuse credentials after success
```

If the lifecycle cannot be split for now, at minimum do not use 15-second hard closures for OAuth transactions that have already entered browser interactions.

### P0: Add Single-Flight for the Same OAuth Identity

Coordination keys should be based on OAuth credential identity, not connection leases:

```text
serverName + serverUrl + clientId + scope + redirectPath
```

Allow only one leader:

- Execute discovery/DCR;
- Hold callback servers/states/verifiers;
- Expose unique authorization URLs;
- Publish client/token pairs.

Other settings/session connections only subscribe to transaction results; each 15-second startup waiters' timeouts cannot cancel leaders.

Cross-Node processes require file locks/leases or centralize management in shared hosts; single-adapter `record.connecting` is insufficient.

### P0: Stabilize DCR and Callback URI Relationships

Evaluate in priority order:

1. Use stable callback brokers/deep links, then forward to current transactions by ZCode;
2. If sticking with loopback, register native redirects without fixed ports, and confirm Exa supports arbitrary ports per RFC 8252;
3. If Exa only accepts exact URIs, when current callback URIs are not in the client registration set, first invalidate old clients and re-DCR, do not reuse old clients;
4. Include redirect compatibility in discovery/DCR capability caching and testing.

### P1: Add Anonymized OAuth Diagnostic Events

Should record but must not record tokens, codes, or client secrets:

```text
event=mcp.oauth.refresh.failed
mcpServerName
oauthErrorCode=invalid_grant | invalid_client | server_error | transport_error
httpStatus
clientIdHash
credentialPairVersion
credentialSource=canonical | legacy
willInvalidate=client | tokens | none
willStartInteractive=true/false
```

When authorize pages fail, also record:

```text
clientIdHash
registeredRedirectOrigin/path/portHash
currentRedirectOrigin/path/portHash
stateIdHash
connectionId
leaseId/isolation
```

### P1: Improve Stale URL UX

- After authorization URL timeouts, settings pages should clearly display "This link has expired, please generate a new link."
- When multiple connections request the same OAuth, only display the leader URL.
- When callbacks arrive at closed ports, if using brokers, display recoverable pages, not browser connection failures.

### P1: Complete Regression Tests

At minimum, add:

- `refresh invalid_grant -> tokens invalidated -> one interactive transaction`
- `stored DCR clients + new loopback ports`
- `settings lease + N session leases -> one DCR/one URL`
- `session waiter 15s timeout -> leader remains alive -> callbacks at 60s succeed`
- `old browser URLs after replacement -> explicit stale responses`
- `OAuth error logs contain codes/status but never contain tokens/codes/secrets`

## 10. Final Qualitative Table

| Problem                                    | Root Cause/Factors                                                                                    | Qualitative                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Periodic re-authentication required        | Tokens no longer exist; interactive authorization entered after refresh did not recover               | Direct mechanism confirmed                                       |
| Whether refresh tokens are saved/loaded    | Current implementation saves, loads, updates after refresh                                            | Not a bug                                                        |
| Why this specific refresh failed           | Token endpoint error codes missing, cannot uniquely determine                                         | Observability design defect                                      |
| Cross-process client/token overwrites      | Current canonical pairs + file locks already protected; old processes still have compatibility risks  | Current not primary root cause / historical implementation risks |
| Secondary authentication timed out         | Session hard-coded 15 seconds and closed its own OAuth sessions                                       | Implementation bug                                               |
| Why settings page 5 minutes is ineffective | Settings/sessions are different leases and connections                                                | Architecture design defect                                       |
| Callback/verifier after timeout            | Listeners closed, current state verifiers cleaned up                                                  | Implementation basically correct                                 |
| Stale state                                | Old browser URLs, obsolete DCR clients, multiple URLs coexisting                                      | Design defect                                                    |
| Exa Server Components errors               | Most likely triggered by old clients/new redirects or concurrent stale URLs; server errors not caught | ZCode boundary defects + Exa page robustness bugs                |

## 11. One-Sentence Root Cause

ZCode incorrectly implemented "Sessions can wait for MCP at most 15 seconds" as "OAuth human-authorization transactions can only live 15 seconds", while settings pages and Sessions create OAuth/DCR transactions individually by lease; after refresh becomes unavailable, the system will reuse or rebuild clients across multiple random callback ports and generate multiple authorization URLs, ultimately causing inevitable short timeouts and high-probability triggering of Exa authorization pages' non-robust handling of client/redirect/stale transactions.
