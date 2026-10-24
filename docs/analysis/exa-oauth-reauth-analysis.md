# Exa MCP OAuth Re-authentication Root Cause Analysis

> Analysis date: 2026-08-13
> Analysis baseline: `exa-oauth-analysis` / `bfc91c54a9507beae4820c58f86a25fc3c44104d`
> Scope: analysis only; no production code changes; no OAuth authorization or token requests executed
> MCP server: `plugin:exa:exa`
>
> Compaction note: source line numbers and test line ranges were dropped; locations are given as file paths. Full history: `git show 45f808f7:docs/analysis/exa-oauth-reauth-analysis.md`.

## 1. Conclusion Summary

### Problem 1: Why Re-authentication Is Required After a Period of Time

Confirmed direct mechanism:

1. The current ZCode implementation persists and loads refresh tokens, and after a successful refresh atomically updates the client/token pair. No code bug was found that makes refresh tokens get lost after a normal save and restart.
2. When MCP returns unauthorized, the MCP SDK first uses the saved refresh token. If Exa returns `invalid_grant`, the SDK deletes tokens, keeps the client, then retries and enters browser authorization.
3. The local state at the time was exactly "only client/discovery remains, no token/canonical pair", so entering re-authorization (not refresh) was inevitable.
4. 2026-08-12 logs show Exa connected at `08:54:49Z` and entered interactive authorization by `09:00:13Z`, matching "access token expired, refresh did not recover, tokens invalidated".

Logs do not record the Exa token endpoint's response status and OAuth error code, so the upstream cause of the refresh failure cannot be determined: Exa actively expired/revoked the refresh token; historical old versions or concurrent authorization once produced a client/token mismatch; or other Exa server-side policy or temporary errors.

The credential implementation already uses canonical pairs, cross-process file locks, and compare-and-delete against client/token interleaved overwrites. "Desktop and CLI's current code overwrite each other's tokens" is therefore not the confirmed root cause; legacy-key writes from un-upgraded old processes remain a compatibility-window risk.

Qualitative assessment:

- Re-authorization after refresh failure: normal OAuth degradation.
- Token endpoint error codes not recorded, so token expiry, revocation, client mismatch, and server errors cannot be told apart: **observability design defect**.
- Tokens missing from the current environment: **confirmed fact**; the specific deletion reason is affected by a manual reset on 2026-08-11 and is not all attributable to the program.
- Multiple independent runtimes can start OAuth/DCR for the same MCP simultaneously: **architecture design defect** that amplifies credential generation and re-authentication instability.

### Problem 2: Why Secondary Authentication Times Out

Confirmed direct root cause:

- The session startup path hard-codes the manual OAuth wait limit to **15 seconds**, overriding `oauth.ts`'s default **5 minutes**.
- After 15 seconds the connection is marked `MCP server plugin:exa:exa OAuth authorization timed out`, the local callback server is closed, and the current state's PKCE verifier is cleared.
- Logging in via browser, selecting a team, reading the page, and clicking Authorize usually cannot be done reliably within 15 seconds.

The settings page's own background connections do not pass 15 seconds and use 5 minutes. But the settings page lease and Session lease are different connections by default (session isolation) with different `mcpConnectionId`, callback ports, states, and browser URLs, so the settings page's 5-minute wait cannot extend or take over the Session's 15-second OAuth.

Qualitative assessment:

- Session limiting human-browser authorization to 15 seconds: **implementation bug / product behavior bug**.
- Settings page and Session creating multiple independent authorization transactions for the same OAuth identity, without cross-lease/process single-flight: **architecture design defect**.
- Callback listener and PKCE state timeout cleanup are basically correct and not the stale-state root cause.

### Exa `Server Components render` Error

Strongest ZCode-side contributor:

1. DCR registration writes the current random localhost port into `redirect_uris`.
2. Each later OAuth session listens on another random port.
3. ZCode prefers reusing the persisted old `client_id`.
4. A second authorization after refresh may therefore send "old `client_id` + new `redirect_uri`".

The registered redirect URI port is `54735`; failed authorizations on 2026-08-13 used new ports `58670`, `58676`. If Exa matches DCR redirect URIs exactly, redirect validation fails; if the Exa Next.js authorization page does not render this as a normal OAuth error page, it can show as a generic Server Components production error.

This is a **high-confidence inference, not a captured Exa server-side stack trace**. RFC 8252 allows arbitrary ports for loopback native client authorization, so compliant servers may ignore port differences; without a logged-in network trace, whether Exa implements the exception cannot be confirmed. Anonymous read-only probes show both redirects first `307` to login entries, so Exa defers final validation to after login; match or mismatch at the anonymous stage is neither confirmed nor excluded.

Multi-connection concurrency produces multiple client/state/authorization URLs, so users may click timed-out URLs or non-target connection URLs; this is a confirmed amplifier. Exa pages using a generic SSR error instead of a structured OAuth error is the other party's page robustness issue.

## 2. Fact Boundaries and Evidence Levels

- **Confirmed**: code, logs, or local persistent state prove it directly.
- **Strong consistent inference**: implementation behavior matches the on-site form, but token endpoint or Exa server logs are missing.
- **Candidate contributor**: valid in the protocol; current evidence cannot rank it as the unique root cause.

Key evidence not obtained: Exa `/api/oauth/token` HTTP status, `error`, `error_description` for failed refresh responses; logged-in browser Network trace and Next.js digest for `dashboard.exa.ai` / `auth.exa.ai`; Exa server-side client registry, redirect validation, and Server Components stack traces. This document therefore does not state `invalid_grant`, `invalid_redirect_uri`, or Exa deleting DCR clients as observed facts.

## 3. Actual Plugin Configuration and OAuth Discovery

### 3.1 Loaded Plugin Configuration

The official plugin manifest `~/.zcode/cli/plugins/cache/claude-plugins-official/exa/3.4.0/.claude-plugin/plugin.json` defines:

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

The plugin root also has `mcp.json` with URL parameter `client=agent-plugin`, but the loader looks for `.mcp.json` (leading dot), which does not exist there; definitions come from the manifest. If `.mcp.json` existed, the loader would use `{ ...fromFile, ...fromManifest }` with the manifest overriding same-named items (`apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`). The actual configuration and credential prefix correspond to the `claude-code-plugin` URL; the root `mcp.json` is not on this loading path.

The manifest has no explicit OAuth configuration. For HTTP/SSE MCP without Authorization headers, ZCode enables authorization_code discovery automatically (`apps/zcode-cli/packages/adapters/src/mcp/index.ts`).

### 3.2 2026-08-13 On-site Discovery

A credential-less read-only request to the MCP endpoint returned:

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

Exa declares support for refresh tokens and public clients. Its scopes do not include `offline_access`, but that does not show it issues no refresh tokens; the MCP SDK appends this scope only when the server declares `offline_access`.

## 4. First Authorization Timing

Combines code and real 2026-08-11 logs. Three OAuth connections appeared simultaneously that day; two failed around 15 seconds and one succeeded around 74 seconds.

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

Real logs (fields minimized, no URLs, codes, or tokens):

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

`11:25:54.502Z` to `11:27:08.338Z` is about 73.8 seconds, proving human authorization can take far longer than 15 seconds while staying under 5 minutes.

## 5. Problem 1: Refresh Token Saving, Loading, and Invalidation

### 5.1 Current Implementation Saves and Loads Refresh Tokens

The OAuth provider (`apps/zcode-cli/packages/adapters/src/mcp/oauth.ts`) reads client and tokens from one credential pair. After token exchange or refresh, `saveTokens` publishes `authorization_credentials` (canonical client/token pair), `client_information` (legacy client mirror), and `tokens` (legacy token mirror) in one `saveMany`. `saveMany` updates multiple keys in one read-modify-write (`apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`), protected by the cross-process file lock and written back atomically. The credential file mode on-site is `0600`.

Refresh tokens are therefore not memory-only, and desktop and CLI do not overwrite the whole file independently without locks.

### 5.2 Client/Token Pairing Protection

The canonical v2 logic handles these concurrent cases (`oauth.ts`):

- When legacy tokens are deleted, old tokens are not revived from canonical.
- The canonical pair keeps being used only when legacy tokens match canonical tokens.
- When the client is unchanged, new refresh results written by old processes are accepted.
- When both client and token changed and the same transaction cannot be proven, the client is kept and untrusted tokens are discarded.
- When invalidating old snapshots, compare-and-delete is used so a pair just written by another transaction is not deleted.

Covering tests (`mcp-oauth.e2e.test.ts`): concurrent adapter PKCE state isolation; DCR clients bound to their own transactions; canonical pair atomic publish; mixed-version read/write; rejecting stitched legacy client/tokens from different transactions; compare-and-delete; refresh using the winning canonical pair.

"Clients and refresh tokens are frequently overwritten into wrong combinations by concurrency" has no static or test evidence in the current version. Historical old versions had the risk, which is why the compatibility and canonical logic exists. If a machine also runs un-upgraded processes, legacy writes can still make new readers discard tokens (pairing cannot be proven) and require re-authorization.

### 5.3 SDK Behavior After Access Token Expiration

The repository locks `@modelcontextprotocol/client 2.0.0` (`apps/zcode-cli/packages/adapters/package.json`). Read-only verification of the published `dist/index.mjs`:

- When a refresh token exists, the token endpoint is called first and `provider.saveTokens` after success.
- With no usable refresh, or after recoverable refresh errors, the SDK generates a new authorization URL and PKCE verifier and enters interactive authorization.
- `invalid_grant`: retry after invalidating tokens; `invalid_client` / `unauthorized_client`: retry after invalidating clients and tokens.

ZCode's provider invalidate implementation is in `oauth.ts`. Path after access token expiration:

```text
MCP 401
  -> SDK tries refresh_token
     -> Success: saveTokens, new access token persisted
     -> invalid_grant: delete tokens, retain clients, transition to browser authorization
     -> invalid_client: delete clients + tokens, re-DCR/authorization
     -> Partial server_error: can fall back to browser authorization directly, may not first delete old clients
```

### 5.4 Local Credential On-site

The authoritative credential file is `~/.zcode/v2/credentials.json` (mode `0600`), Exa credential prefix `mcp:oauth:c50fd1fa63fb88a233be0688`. It currently holds only `discovery_state` and `client_information`; it has no `tokens`, `authorization_credentials`, or `code_verifier`. Anonymized client summary:

```text
client_id SHA-256 first 12 characters: d31ae07a373b
client_name: ZCode plugin:exa:exa
client_secret: none
client_id_issued_at: 2026-08-11T11:25:54Z
grant_types: authorization_code, refresh_token
registered redirect URI:
  http://127.0.0.1:54735/oauth/callback/mcp/plugin%3Aexa%3Aexa
```

Historical manual backup/reset files also contain only client/discovery/verifier for Exa, no tokens, and the client changes several times:

```text
credentials.json.exa-backup-20260725-215609   client hash c27de9b37128
credentials.json.exa-backup-20260725-215921   client hash 1ed8dd1faa86
credentials.json.exa-backup-20260725-220036   client hash a040da9c8465
credentials.json.exa-reset-20260811-192515    client hash fa0c35e0d90f
credentials.json                              client hash d31ae07a373b
```

The file names show manual backup/reset on-site. "Currently no tokens" is a fact; "all tokens were abnormally deleted by the program" is not provable; repeatedly generated new DCR clients are a fact, consistent with concurrent authorization transactions and manual resets. No token plaintext was read or recorded.

The user-specified `~/.zcode/db` does not exist locally; the SQLite file is `~/.zcode/cli/db/db.sqlite` and its schema has no OAuth/MCP credential tables. The OAuth credential authority remains `~/.zcode/v2/credentials.json`.

### 5.5 Runtime Timeline

```text
~/.zcode/cli/log/zcode-2026-08-12.jsonl

1816  08:54:49.770Z  Exa connected, tools=2
1899  09:00:13.958Z  Exa authorization.required, callback=61820
1909  09:00:28.969Z  OAuth authorization timed out
```

First connection succeeded and about 5 minutes later new connections entered authorization. This rules out "first authorization never saved/never took effect" and is consistent with tokens later becoming un-refreshable.

### 5.6 Problem 1 Root Cause Conclusion

| Layer                            | Conclusion                                                               |          Evidence Level | Qualitative                    |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------: | ------------------------------ |
| Direct trigger                   | No available tokens now, SDK can only re-authorize                       |               Confirmed | State fact                     |
| Refresh flow                     | Has refresh tokens, loads them, tries refresh, persists after success    |               Confirmed | Implementation correct         |
| After refresh failure            | `invalid_grant` deletes tokens; `invalid_client` deletes client+tokens   |               Confirmed | Reasonable degradation         |
| This specific refresh error      | Logs do not record it, cannot uniquely determine                         |           Confirmed gap | Observability design defect    |
| Current multi-process overwrites | Canonical pairs + file locks already protect normal writes               |               Confirmed | Not current primary root cause |
| Old process/legacy mixed writes  | Cannot prove pairing, so tokens are actively discarded                   | Confirmed code behavior | Compatibility risk             |
| Concurrent OAuth/DCR             | Different leases/processes can repeatedly authorize and register clients |               Confirmed | Architecture design defect     |

## 6. Problem 2: 15-Second Timeout Chain and Connection Isolation

### 6.1 Where the 15 Seconds Are Passed In

Session runtime (`apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts`):

```ts
const MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS = 15_000;
```

passed in at session startup:

```ts
connectConfiguredServers(servers, {
  oauthAuthorizationTimeoutMs: MCP_SESSION_OAUTH_AUTHORIZATION_TIMEOUT_MS,
  // ...
});
```

The adapter (`apps/zcode-cli/packages/adapters/src/mcp/index.ts`) forwards it to OAuth sessions:

```ts
authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs;
```

and uses `oauthSession.timeoutMs` when waiting for callbacks:

```ts
withTimeout(
  oauthSession.waitForAuthorizationCallback(),
  oauthSession.timeoutMs,
  `MCP server ${name} OAuth authorization timed out`,
);
```

The OAuth module's default 5 minutes applies only when callers do not override:

```ts
timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS;
```

Secondary authentication triggered by Session startup therefore hits 15 seconds, not 5 minutes.

### 6.2 Why the Settings Page Cannot Rescue the Session

The settings page `mcp/list` does not pass `oauthAuthorizationTimeoutMs` when starting background connections (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts`), so it uses the default 5 minutes. Logs show connections timing out after about `300xxx ms`, e.g. `zcode-2026-08-11.jsonl` `durationMs=300864`, `error=MCP server plugin:exa:exa OAuth authorization timed out`.

But the protocol entrypoint issues different leases to the settings page (`protocol-settings`) and Sessions (`appOptions.sessionId`) (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`). The connection pool default isolation is `session`, and connection keys for non-workspace-isolated servers use `leaseId` (`apps/zcode-cli/packages/adapters/src/mcp/pool.ts`):

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

Pending-connection reuse in `mcp/index.ts` applies only within the same adapter/record and cannot share across pool entries.

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

Two connections created different callback ports and states for the same Exa server at the same moment and each failed after about 15 seconds. The runtime has no global OAuth single-flight.

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

If the settings page connects independently, the last point is usually 5 minutes and may run in parallel with the Session's 15-second transaction.

### 6.5 Whether Timeouts Leave Stale State

- Callback server (`apps/zcode-cli/packages/adapters/src/auth/localhost-callback.ts`): listens randomly on `127.0.0.1:0`, strictly checks path, state, and code, and `close()` closes the HTTP server.
- OAuth session (`oauth.ts`): `close()` closes callback servers first, then the provider; provider `close()` clears current state verifiers; verifier keys contain the complete state.

No Exa `code_verifier` exists in the current credentials, consistent with successful cleanup. `discovery_state` is retained as reusable discovery metadata, not callback stale state.

What remains: browser URLs still open while callback ports are closed; DCR clients registered but no longer used on the Exa side; users with several URLs cannot tell which are valid.

- Callback listener not cleaned up: **not found**.
- PKCE verifier cross-state mis-deletion/leftover: **not supported by implementation or on-site state**.
- Stale browser URLs / stale DCR clients: **the design can produce them**.

## 7. Evidence Chain for Exa Server Components Errors

### 7.1 Old Clients with New Redirect URIs

Each OAuth session creates a new state and random port (`oauth.ts`, `localhost-callback.ts`). DCR metadata uses the current complete callback URL; later sessions prefer reading and storing clients. The MCP SDK builds authorization requests from `clientInformation` (old client) and `provider.redirectUrl` (current new random port) (`@modelcontextprotocol/client@2.0.0/dist/index.mjs`).

```text
Register redirect port: 54735
Subsequent log port examples: 61820, 58670, 58676
```

ZCode does build "persisted client + new callback port" combinations.

### 7.2 Why Only a High-Confidence Inference

A read-only probe without login or authorization clicks, against the current anonymized client:

```text
Registered redirect  -> HTTP 307 -> auth.exa.ai /?callbackUrl=...
Mismatched redirect  -> HTTP 307 -> auth.exa.ai /?callbackUrl=...
```

Both first go to the login page; anonymous responses expose neither the final redirect validation result nor the Server Components error. So `invalid_redirect_uri` is not claimed as caught, Exa correctly allowing loopback port changes per RFC 8252 is not excluded, and generic SSR errors on logged-in pages still need Network traces or Exa logs.

The page can still show `Authorize ZCode plugin:exa:exa`, so it obtained the client display information. That lowers the probability of "client_id does not exist" but does not exclude incomplete client state, team binding anomalies, or authorization record abnormalities.

### 7.3 Other Candidate Contributors (by current evidence)

1. **Old DCR clients + new callback port redirect validation/page handling anomalies.** The ZCode combination is confirmed; whether Exa rejects it is unconfirmed.
2. **Concurrent authorization URLs / timed-out URLs.** Multiple connections, states, and ports are confirmed by logs; users may log in or click on the wrong transaction.
3. **Exa Personal team / account server-side data anomalies.** Compatible with the Server Components errors; no ZCode-side evidence.
4. **Repeated DCR itself conflicts.** ZCode generating multiple clients is confirmed; DCR usually allows multiple clients; no evidence of Exa conflicts.

### 7.4 Qualitative Assessment

- Long-term reuse of DCR clients bound to specific callback URIs while using random callback ports each time: **implementation/design boundary defect**. Even if Exa supports the loopback port exception, ZCode should not depend on unverified server leniency.
- No single-flight for the same OAuth identity, producing multiple URLs and DCR clients: **architecture design defect**.
- Exa pages showing OAuth parameter/account data issues as a generic Server Components production error: **Exa page robustness bug**.

## 8. Test Coverage and Gaps

Existing coverage: single adapter reusing pending OAuth, with bounded caller timeouts not closing shared connections, and per-connect OAuth timeout taking effect (`mcp.test.ts`); two adapters' concurrent PKCE isolation; DCR client transaction binding, canonical pairs, mixed-version, refresh (§5.2).

Gaps:

1. No test for "DCR client registered port differs from the new callback port after session rebuild".
2. No strict authorization server simulation of exact `redirect_uri` matching or the RFC 8252 loopback port exception.
3. No coverage of `protocol-settings lease + session lease` parallel authorization for the same server.
4. No test of complete ZCode state, logs, and secondary authorization URL after refresh returns `invalid_grant`.
5. No product behavior test for human authorization taking longer than 15 seconds.
6. No assertion that token endpoint errors are recorded sensitively as diagnosable events.

## 9. Repair Suggestions (Not Implemented)

### P0: Fix the 15-Second Human Authorization Timeout

Do not equate Session startup's blocking budget with the OAuth transaction lifecycle:

```text
Session startup budget 15 seconds
  -> Only decides "whether this Session continues waiting"
  -> Does not close global/settings page OAuth transactions

OAuth transaction lifecycle
  -> Independent 5 minutes or user cancel
  -> Status continues displaying on settings page
  -> Subsequent Sessions automatically reuse credentials after success
```

If the lifecycle cannot be split now, at least do not hard-close OAuth transactions that already entered browser interaction at 15 seconds.

### P0: Add Single-Flight for the Same OAuth Identity

Coordinate on OAuth credential identity, not connection leases: `serverName + serverUrl + clientId + scope + redirectPath`. Only one leader may run discovery/DCR, hold callback servers/states/verifiers, expose the unique authorization URL, and publish client/token pairs. Other settings/session connections subscribe to the transaction result; the 15-second startup waiters' timeouts must not cancel the leader. Across Node processes this needs file locks/leases or centralization in shared hosts; single-adapter `record.connecting` is insufficient.

### P0: Stabilize the DCR and Callback URI Relationship

Evaluate in priority order:

1. Use a stable callback broker/deep link, then forward to the current transaction inside ZCode.
2. If sticking with loopback, register native redirects without fixed ports and confirm Exa supports arbitrary ports per RFC 8252.
3. If Exa accepts only exact URIs, invalidate old clients and re-DCR when the current callback URI is not in the client registration set, instead of reusing old clients.
4. Include redirect compatibility in discovery/DCR capability caching and testing.

### P1: Add Anonymized OAuth Diagnostic Events

Record, never including tokens, codes, or client secrets:

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

- After authorization URL timeouts, settings pages show "This link has expired, please generate a new link."
- When several connections request the same OAuth, show only the leader URL.
- When callbacks reach closed ports, a broker (if used) shows a recoverable page instead of a browser connection failure.

### P1: Regression Tests

- `refresh invalid_grant -> tokens invalidated -> one interactive transaction`
- `stored DCR clients + new loopback ports`
- `settings lease + N session leases -> one DCR/one URL`
- `session waiter 15s timeout -> leader remains alive -> callbacks at 60s succeed`
- `old browser URLs after replacement -> explicit stale responses`
- `OAuth error logs contain codes/status but never contain tokens/codes/secrets`

## 10. Final Qualitative Table

| Problem                                    | Root Cause/Factors                                                                                    | Qualitative                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Periodic re-authentication required        | Tokens no longer exist; interactive authorization entered after refresh did not recover               | Direct mechanism confirmed                                      |
| Whether refresh tokens are saved/loaded    | Current implementation saves, loads, updates after refresh                                            | Not a bug                                                       |
| Why this specific refresh failed           | Token endpoint error codes missing, cannot uniquely determine                                         | Observability design defect                                     |
| Cross-process client/token overwrites      | Current canonical pairs + file locks protect; old processes still carry compatibility risk            | Not current primary root cause / historical implementation risk |
| Secondary authentication timed out         | Session hard-coded 15 seconds and closed its own OAuth sessions                                       | Implementation bug                                              |
| Why settings page 5 minutes is ineffective | Settings/sessions are different leases and connections                                                | Architecture design defect                                      |
| Callback/verifier after timeout            | Listeners closed, current state verifiers cleaned up                                                  | Implementation basically correct                                |
| Stale state                                | Old browser URLs, obsolete DCR clients, multiple URLs coexisting                                      | Design defect                                                   |
| Exa Server Components errors               | Most likely triggered by old clients/new redirects or concurrent stale URLs; server errors not caught | ZCode boundary defects + Exa page robustness bugs               |

## 11. One-Sentence Root Cause

ZCode implemented "Sessions can wait for MCP at most 15 seconds" as "OAuth human-authorization transactions can live only 15 seconds", while settings pages and Sessions create OAuth/DCR transactions per lease. After refresh becomes unavailable, the system reuses or rebuilds clients across multiple random callback ports and produces multiple authorization URLs, causing inevitable short timeouts and a high chance of triggering Exa's authorization page's non-robust handling of client/redirect/stale transactions.
