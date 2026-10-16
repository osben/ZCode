# ZCode Official Server MCP Client Integration (Phase 1, Historical Decision Log)

> Current implementation facts are consolidated in `zcode-official-server-mcp-auth-spec.md`. This document preserves the phased design and evolution of decisions;
> it is no longer the direct implementation reference for current authentication headers, scope, quotas, or UI behavior.

> Date: 2026-08-14 (implementation completed 2026-08-15)  
> Status: Implemented (client side; backend pending, see §12)  
> Scope: ZCode client/Agent runtime; no UI or official MCP backend changes; do not include fake capabilities in the production release directory

## 1. Target

Phase 1 enables ZCode to load remote Streamable HTTP MCP servers from official Plugins and inject the current user's Coding Plan identity headers for trusted official Origins before each actual HTTP request.

This phase delivers the following capabilities:

1. An individual HTTP MCP in a Plugin can declare `zcode_official`;
2. The `jwt_token` provider uses the current ZCode user JWT as a Bearer token; append
   `X-Bigmodel-Authorization` only when the Registry contains a valid Coding Plan Provider and a MaaS JWT is available, and add
   `Bigmodel-Target-Type` and the Team organization/project according to the corresponding `wireScope` (see §6.1 for the complete header set and
   the identity-only exception);
3. The MCP transport may obtain and inject identity headers only when the target Origin matches the current ZCode API origin
   (the original requirement was for the official Plugin identity, its MCP key, and the exact Origin all to match the host's trusted mapping;
   in 2026-08 this was narrowed to Origin validation alone. See §5.1 for the rationale and residual risks);
4. Add a test-only fake official Plugin and fake HTTP MCP server covering Plugin parsing, trust decisions, and
   the actual request headers for MCP `initialize` / `tools/list` / `tools/call`;
5. Do not add or modify UI pages, components, stores, labels, i18n, or settings fields.

`serverId` and `capabilityId` are out of scope. The key under a Plugin's `mcpServers` is that Plugin's MCP identity;
the runtime continues to use the existing namespace `plugin:<pluginName>:<mcpKey>` to prevent name collisions across Plugins.

## 2. Current Code Facts

| Current fact                                                                                                                                                                                                                                                             | Code location                                                                                                                                                                                                    | Phase 1 conclusion                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP runtime config already supports `stdio`, `http`, and `sse`; HTTP currently supports only `headers` / `oauth`                                                                                                                                                         | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`                                                                                                                                                   | Extend only the official-auth declaration in the HTTP config; do not add a new MCP transport                                                                                                                |
| The Plugin loader projects the MCP key from `.mcp.json` to `plugin:<pluginName>:<mcpKey>`, but currently discards unknown `auth` fields                                                                                                                                  | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`                                                                                                                                                            | Strictly parse `zcode_official` at the Plugin parsing boundary while preserving host-generated provenance                                                                                                   |
| The Streamable HTTP transport sends requests through `createMcpTransportFetch(...)`; static headers are added to `requestInit`                                                                                                                                           | `apps/zcode-cli/packages/adapters/src/mcp/index.ts`, `network.ts`                                                                                                                                                | Sensitive identity headers must be injected by a dynamic fetch wrapper, not written back to config or kept in `requestInit` long-term                                                                       |
| **When an `http`/`sse` MCP has no `oauth` field and its static `headers` lack `authorization`, it is assigned `{type:"authorization_code"}` by default**, which creates an OAuth session, starts a localhost callback server, and passes `authProvider` to the transport | `resolveAuthorizationCodeOAuthConfig` / `hasAuthorizationHeader` in `adapters/src/mcp/index.ts`; transport construction is in the HTTP branch of the same file                                                   | `zcode_official` must explicitly exit this default path (§6.3). This design prohibits static `authorization` and omits `oauth`; without an explicit opt-out, official MCP would fall into implicit OAuth    |
| With `authProvider`, the SDK turns 401/403 into an OAuth reauthorization flow and writes the authorization URL to MCP record status through `onAuthorizationRequired`                                                                                                    | The 401/403 branch of `streamableHttp` in the `@modelcontextprotocol/sdk` client; `redirectToAuthorization` in `adapters/src/mcp/oauth.ts`; `createAuthorizationCodeOAuthOptions` in `adapters/src/mcp/index.ts` | Conflicts with the goal of automatic authentication without UI. `zcode_official` needs its own 401/403 semantics (§6.3) and must not trigger an authorization URL or browser                                |
| When the SDK assembles request headers, `requestInit.headers` takes precedence over `Authorization` written by `authProvider` and can override `mcp-session-id` / `mcp-protocol-version`                                                                                 | `_commonHeaders()` in the SDK client's `streamableHttp`                                                                                                                                                          | The reserved-header denylist must include protocol headers, and identity headers must be injected as the final step in the fetch wrapper (§6.3)                                                             |
| The JWT, API key, and Team organization/project for the selected Coding Plan can already be resolved into one credential snapshot                                                                                                                                        | `packages/services/src/session/offPeakRuntimeModel.ts`                                                                                                                                                           | **Use as a logical reference, but do not reuse or modify it** (§6.1.1). Implement the equivalent logic separately for official MCP to avoid coupling to Off-Peak                                            |
| The Bootstrap manifest manages the built-in identity, version, and bundle root for official Plugins                                                                                                                                                                      | `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`                                                                                                                                       | This manifest **does not participate** in official MCP authorization (the mapping was removed in §5.1); a Plugin-declared URL is still untrusted, but validation uses the runtime-resolved ZCode API origin |

This scan used static code in the current workspace and `rg` evidence. A codegraph index was unavailable in this environment,
so unverified indirect reachability was not treated as a product fact.

## 3. Scope and Non-Goals

### 3.1 In Scope

- `http` / Streamable HTTP MCP;
- Declaring the authentication type per MCP in official Plugins;
- Resolving the current Coding Plan identity in the client host/service;
- Automatic authentication request/response in the Agent protocol, without UI;
- Dynamic header injection and Origin validation in the MCP HTTP transport;
- Targeted adapter/bootstrap/service tests using a fake Plugin and fake HTTP MCP.

### 3.2 Out of Scope

- `zcode_official` for `stdio` and `sse` MCPs;
- **Tool-call entitlement for Start Plan users.** Official Server MCP tool calls remain an entitlement exclusive to Coding Plan users;
  Start Plan has only a ZCode JWT and no usable Coding Plan Provider. API Key mode and a Registry with no valid
  Coding Plan Provider use the same identity-only semantics: connection/discovery requests carry only the ZCode JWT, not the MaaS
  JWT, so the server can distinguish sign-in-state errors from plan-state errors (`1006` / `3101`).
- Official MCP backend tool implementation, billing, rate limiting, and business API design;
- `/api/v1/client/configs` rollout logic; Phase 1 only preserves the existing rollout behavior;
- UI changes to MCP settings, Plugin settings, status display, sign-in guidance, and similar surfaces;
- Adding usage-record or capabilities endpoints (the endpoints themselves are already implemented by the backend; see §12.3);
- Short-lived token issuance. In Phase 1, `jwt_token` uses the existing user JWT; the client does not generate a new token;
- Shipping the fake MCP in the official installer.

## 4. Plugin Configuration Contract

### 4.1 `.mcp.json` Example

The test Plugin has the following configuration shape:

```json
{
  "mcpServers": {
    "fake-official-search": {
      "type": "http",
      "url": "${ZCODE_FAKE_OFFICIAL_MCP_URL}",
      "auth": {
        "type": "zcode_official",
        "provider": "jwt_token"
      },
      "timeoutMs": 30000
    }
  }
}
```

Field semantics:

| Field                             | Semantics                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpServers.fake-official-search` | MCP key within the Plugin; used only to associate credential resolution and logs (not authorization, §5.1); no longer declares a duplicate `serverId`                                                       |
| `type: "http"`                    | Uses the existing Streamable HTTP MCP client                                                                                                                                                                |
| `url`                             | MCP endpoint; it can use the existing Plugin template resolution, but the resolved value must also undergo Origin validation                                                                                |
| `auth.type`                       | Exact value `zcode_official` (case-sensitive); aliases and case variants such as `zcode-official_auth`, `zcode-official`, and `zcode_official_auth` are rejected to avoid divergent configuration semantics |
| `auth.provider`                   | Only `jwt_token` is allowed in Phase 1; if short-lived tokens are added later, add a provider rather than changing the existing meaning of this value                                                       |
| `timeoutMs`                       | Reuses the existing MCP protocol request timeout                                                                                                                                                            |

Place `auth` on the individual MCP definition, not at the top level of `plugin.json`. A Plugin can contain multiple MCPs, each
with a different URL or authentication method; a Plugin-level declaration would incorrectly broaden the scope of credential injection.

### 4.2 Types

```ts
export interface ZCodeOfficialMcpAuthConfig {
  type: "zcode_official";
  provider: "jwt_token";
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ZCodeOfficialMcpAuthConfig;
}
```

Constraints:

- `auth` is allowed only with `type: "http"`; if it appears on stdio/sse, the Plugin loader reports
  `plugin_mcp_server_disabled` and disables the MCP;
- **Revised in Phase 2:** stdio can now also declare `zcode_official`; identity headers are delivered through `_meta` on `tools/call`.
  See `zcode-official-server-mcp-stdio-meta-phase-2-spec.md`. `sse` is still rejected;
- Phase 1 does not allow the same MCP to configure both `oauth` and `zcode_official`; if both appear, the Plugin loader reports
  `plugin_mcp_server_disabled` and disables the MCP without a priority decision;
- When `zcode_official` matches, **explicitly disable** this MCP's implicit OAuth fallback: pass `undefined` for `authProvider`,
  do not create an OAuth session or start a localhost callback server. Merely omitting the `oauth` field is not enough;
  see §2 for the existing default behavior and §6.3 for the reason;
- The `auth` string alone does not establish official identity. The Plugin loader still generates runtime
  provenance that `.mcp.json` cannot control: `pluginId`, the original `mcpKey`, and `source`; they are used to associate logs and credential resolution, **but have not participated in trust decisions since 2026-08** (see §5.1);
- Therefore, a third-party Plugin that copies the same `auth` field and points its URL to the ZCode API origin **can obtain identity headers**.
  This is an intentional consequence of removing the marketplace check: credentials flow only to the real ZCode backend, so the risk is abuse rather than exfiltration,
  with server-side entitlement/quota checks as a safeguard. See residual risk 1 in §5.1.

## 5. Trust Model and Origin Mapping

### 5.1 Authoritative Mapping

Trust validation is implemented in `packages/shared/src/official-mcp-auth.ts`
（`isOfficialMcpOriginTrusted` / `createOfficialMcpTrustedOriginRegistry`）。

**Rule (the decision changed twice; this is the current version):**

```text
Target origin === current ZCode API origin (https)
```

**Why `pluginId` is no longer required to come from the official marketplace (2026-08 decision):** This check once existed as a second
control (requiring `pluginId` to end in `@zcode-plugins-official`). It was removed for two reasons:

1. **It prevented official Plugins from being tested before release.** A locally installed Plugin has an ID such as `official-tools@inline`
   (`plugins.dirs`) or `official-tools@<local marketplace>` and never gets the official suffix. The dev
   loopback switch allows only HTTP loopback and cannot enable a test against the real HTTPS endpoint. The result was “to test the real backend,
   you must first publish to the official marketplace”—a deadlock;
2. **Other controls already cover the scenario this check was meant to defend against.** A third-party Plugin trying to claim credentials could also include a hook /
   command, which is arbitrary code executed as the user and can directly read the same credentials under `~/.zcode`. This check therefore was not a real barrier against third parties obtaining credentials.

**Why a per-`mcpKey` allowlist is no longer maintained:** Official Plugins are not always released with the app and can be updated through out-of-band channels.
Maintaining an `mcpKey` list would mean a new MCP added in a Plugin update could not be used until the next client release, creating real release
friction; the list would provide almost no protection against local tampering (the names are constants and can simply be copied). Therefore,
`OfficialPluginDefinition` no longer declares `trustedMcpOrigins`, and there is no canonical-domain table.

**Why resolve the domain at runtime instead of hard-coding it:** The ZCode API origin varies by environment (production/test,
self-hosted); hard-coding the production domain would make all non-production environments fail closed. The resolution rules match those used by background tasks
(the host uses `resolveCurrentZCodeEndpointOrigin`, including settings overrides; the CLI uses
`resolveRuntimeZCodeEndpointOrigin(env)`）。

**Why trusting this Origin does not broaden the trust boundary:** The same Origin **already** receives the same credentials: background tasks send
`authorization` + `x-coding-plan-api-key` (`offPeakServerClient`), while Coding Plan reset / usage endpoints send
`authorization` + `x-bigmodel-authorization`; since 2026-08 the official MCP has used the latter (§6.1).
This is therefore an equivalence argument, not “the official domain is trusted because it is official.”

**Why this belongs in shared rather than CLI bootstrap:** There are two consumers in packages that cannot see each other—the MCP adapter
(before sending a request) and host/services (the second validation at the identity-authority boundary, depending only on `@zcode/shared`). A single source is a hard
requirement; divergent checks in two places could let one side allow a request while the other rejects it. The CLI-side file only forwards the request.

**The only control and the residual risks:**

| Control                                      | Prevents what                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Origin matches (https, no username/password) | Credentials being sent to an attacker-controlled server — **the only load-bearing control** |

Because only one control remains, this check must stay strict: require HTTPS, reject URLs containing credentials, and require an exact character-for-character match with the runtime-resolved value.

There are five known and accepted residual risks:

1. **Any Plugin can declare official authentication** (a risk introduced by removing the marketplace check). A third-party Plugin can
   set `auth.type = zcode_official` and point its URL to the ZCode API origin, allowing the client to inject identity headers for it.
   Credentials flow only to the real ZCode backend, so this is **not exfiltration**, but it is abuse: quota can be consumed as the user and official endpoints with side effects can be triggered. Mitigation relies on the server—official MCP endpoints use `requireAuth` + `WithCodingPlan`, and the server checks entitlement and quota on every call;
2. A local attacker who can write to the official Plugin cache directory can add an MCP to an official Plugin and receive injected credentials. As above, this is
   abuse rather than exfiltration; a per-`mcpKey` allowlist would not help with this scenario anyway;
3. Validation constrains “which requests we approve,” not “what the Agent does after receiving the bytes.” After the host returns identity headers to
   the Agent, a compromised Agent (especially a desktop-attached remote) can use them elsewhere. A complete solution would have the
   host send the request so credentials never leave the host; that is a larger design change and is out of scope for this phase. The current design is therefore
   **defense in depth** (against Agent-side bugs and new code that bypasses the wrapper), not protection against a compromised Agent.
   Also correcting an earlier mistaken inference (SG-03): targetOrigin validation **cannot stop a requester that knows the Origin**—the Agent knows it through `ZCODE_BASE_URL`, and a Plugin can specify it in its config. Its purpose is only to pin the credential
   **flow** to the ZCode Origin;
4. **There is no user-visible authorization confirmation.** A Plugin can declare official authentication and the host can issue identity headers without the user noticing. Adding one-time confirmation
   would tighten the flow (see the end of `isOfficialMcpOriginTrusted`); this requires a product decision and was not implemented;
5. **Auditing covers only the “first issuance.”** The host now records for each
   (pluginId, mcpKey, workspaceKey) tuple in this process, it records an info-level
   `official MCP identity headers resolved` (`firstIssuance: true`) on the first issuance of each
   (pluginId, mcpKey, workspaceKey) tuple in a process; later requests for the same tuple remain at debug. This can answer
   “which Plugin obtained credentials,” but not “how many times.” Logging every issuance at info would cause message-scale log growth,
   so it is out of scope for this phase.

**If tighter controls are needed later:** Do not restore the marketplace-suffix check (it would recreate the deadlock above). The right approach is to keep an explicit bypass for the dev
scenario, or require a user-visible one-time authorization confirmation when a Plugin declares official authentication.

### 5.2 Security Rules

```text
Plugin MCP configuration
      |
      v
Is auth exactly zcode_official/jwt_token? -- No --> regular MCP path
      | Yes
      v
Does URL.origin === the runtime ZCode API origin and use HTTPS? -- No --> fail closed
      |                                                        (official_mcp_origin_untrusted)
      | Yes
      v
Request current identity headers from the host --> dynamically inject them into this HTTP request
```

Validation no longer includes the checks “is this an official marketplace Plugin?” and “does (pluginId, mcpKey) match a trusted mapping?”;
`pluginId` / `mcpKey` are still passed with the request, but are used only to associate logs and credential resolution.

The validation inputs differ for stdio (there is no URL to validate, and the client resolves targetOrigin itself); see
`zcode-official-server-mcp-stdio-meta-phase-2-spec.md` §5。

- Production validation allows only `https:` and rejects usernames/passwords in URLs;
- Unit/integration tests add `http://127.0.0.1:<ephemeral-port>` through dependency injection; local testing explicitly registers loopback Origins through
  `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`. Neither path may allow non-loopback hosts;
- Authenticated fetch uses `redirect: "manual"`. In Phase 1, any 3xx fails immediately, preventing a Bearer token
  from being sent through a cross-Origin redirect; production endpoints should use a canonical URL;
- Static Plugin `headers` must not contain (case-insensitively) any reserved headers: `authorization`,
  `x-coding-plan-api-key`, `x-bigmodel-authorization`, `bigmodel-target-type`,
  `bigmodel-organization`, `bigmodel-project`, and the protocol headers `mcp-session-id`,
  `mcp-protocol-version`; disable the MCP during parsing rather than silently overriding. See §2 for why protocol headers must be on the denylist:
  during SDK request assembly, `requestInit.headers` takes precedence over protocol headers, so static config can override the session ID;
- The reserved-header denylist and the headers actually injected in §6.1 must share one source: keep the constants in `packages/shared` and reference them from both the Plugin parser and
  MCP adapter; adding an identity header should require changing one place. Also enforce the denylist again at the fetch-wrapper merge point in §6.3.2,
  not only during parsing;
- Logs record only `pluginId`, `mcpKey`, Origin, failure classification, HTTP status, and request/trace IDs; never record
  JWTs, Coding Plan keys, complete request headers, or credential fingerprints;
- **Server request-ID correlation:** The client does not send `X-Request-Id` / `X-Trace-Id` (the server
  generates its own `logx.RequestID()` and does not accept inbound values); it reads `x-request-id` only from the **response headers** as the sole correlation key between client and server logs. Therefore:
  - Log successful responses at `debug` (they are high-frequency and do not need correlation when successful);
  - **Log every non-2xx response at `warn`**, with `httpStatus` and `serverRequestId` fields. The production
    logger's minimum level is `Info` (`getDefaultMinLevel`), so logging only at debug would make this ID unavailable when an error occurs;
  - Include the ID in the messages for the §6.3.3 error classifications (401 / 403 / 3xx), so the failure cause appears with the MCP record
    rather than only in the logs;
  - **In-band failures (HTTP 200 + `isError: true`, such as quota exhaustion) must also include this ID**. These failures count as success at the
    HTTP layer, so the non-2xx warning above does not cover them. Only the fetch wrapper can see response headers (above it,
    the MCP SDK exposes only the JSON-RPC result). Therefore, the wrapper reports the ID to the adapter through a callback; the adapter
    associates it with this `tools/call` by **span**, writes an `mcp.tool.call` warning, and adds `zcode/officialMcpServerRequestId` to the result's `_meta`
    (omit it on success to avoid adding diagnostic fields to every call).
  - The correlation key **must** be the span, not the traceId: a traceId covers the entire top-level session, so multiple calls in one session
    share it and would be miscorrelated. If a span is unavailable (`initialize` / `tools/list` have no `_meta`, or the caller
    did not pass a trace), **omit** this field; never fall back to the “most recent response”—that could attach the previous call's ID to this
    failure, which is worse than having no ID.

## 6. Authentication Headers and Credential Attribution

### 6.1 Request Headers for `jwt_token`

Generate the following dynamically for every HTTP request to a trusted MCP:

```http
Authorization: Bearer <current-zcode-jwt>        # validated by server requireAuth; always sent
X-Bigmodel-Authorization: Bearer <current-family-maas-jwt>   # sent only when a valid Coding Plan Provider and MaaS JWT are available
Bigmodel-Target-Type: PERSONAL | TEAM            # sent only when the corresponding wire scope exists
Bigmodel-Organization: <organization-id>         # TEAM only, and only when project is also present
Bigmodel-Project: <project-id>                   # TEAM only, and only when organization is also present
```

Server contract basis (checked against current `zcode-server` code): the `WithCodingPlan` middleware reads
`X-Coding-Plan-Api-Key`, `X-Bigmodel-Authorization`, `Bigmodel-Organization`, `Bigmodel-Project`,
and `Bigmodel-Target-Type`; JWT `Authorization` is read separately by `requireAuth`. Key points:

- **Send `Bigmodel-Target-Type` only when the corresponding `wireScope` exists**, with value `PERSONAL` / `TEAM`.
  For BigModel Personal/Team, the wire scopes are PERSONAL/TEAM respectively; ZAI Team has a wire scope of
  `null`, so omit this header and use the server fallback branch. For identity-only requests (Start Plan, API Key
  mode, or a Registry without a valid Coding Plan Provider), also omit this header; these requests carry only the ZCode JWT.
  When this header is sent as TEAM, organization/project must be present as a pair; if either is missing, omit both.
- The server's `CodingPlanContext.Valid()` requires both organization and project to be non-empty when `TargetType=TEAM`.
  The client therefore preserves pair atomicity too: if either is missing, omit both; sending only half of the identity headers is rejected as a bad request;
- **Credential channel (2026-08 change; supersedes the Phase 1 decision):** `X-Bigmodel-Authorization` and
  `X-Coding-Plan-Api-Key` are **mutually exclusive** channels on the server (`credential := cmp.Or(Authorization, APIKey)`,
  with Authorization taking precedence). Phase 1 decided to “continue using `X-Coding-Plan-Api-Key` and not send a MaaS JWT,” and recorded the switch
  as technical debt. After backend confirmation (`middleware/coding_plan.go` documents the API Key channel as “for existing clients only;
  new integrations must use the MaaS JWT header”), official MCP now sends **only
  `X-Bigmodel-Authorization`** when plan credentials are available. Identity-only requests still send only the ZCode JWT. Three key points:
  - **This changes the credential, not only the header name.** The new header must carry a **MaaS sign-in JWT**
    (`oauth:<family>:access_token`, the same token as the Coding Plan reset/usage endpoints). The server uses
    `ParseWithoutVerification` to extract its `customer_id` and requires it to match the current user. Putting a Coding Plan business key
    in the new header fails parsing directly;
  - **Do not send both headers.** The JWT takes precedence for ZAI binding and quota lookup, but the API key ownership check
    (`validateIdentityFromApiKey`) still runs. An expired key or one that does not belong to the user causes the entire request to return 403/3101.
    This is replacement, not addition;
  - **The value includes the `Bearer ` prefix.** The server uses `strings.CutPrefix(..., "Bearer ")` and also accepts a bare token;
    send it in the format specified by `zcode-server/docs/api_server_mcp.md`.
    Off-Peak and model relay still use `X-Coding-Plan-Api-Key` (a different API family with a different server contract); this change intentionally leaves them alone;
- Header names are case-insensitive (the server normalizes them through Gin `GetHeader` and `textproto`); send them using the casing shown in the HTTP block above,
  with no separate case adaptation.

#### 6.1.1 Independent Implementation; Do Not Reuse Off-Peak Code (Phase 1 Decision)

Implement credential resolution and identity-header construction for official MCP **separately**: equivalent to Off-Peak logic but independent in code:

- **Do not reuse** `resolveOffPeakCredentials(...)`, `buildOffPeakPlanIdentityHeaders(...)`,
  `resolveSelectedOffPeakCodingPlan(...)`, or other Off-Peak functions, and do not turn them into shared helpers;
- **Do not modify** any existing exports or behavior in `packages/services/src/session/offPeakRuntimeModel.ts`;
  leave the Off-Peak path unchanged, with no regression risk;
- Put the new implementation in a separate location (for example, under `packages/services/src/official-mcp/` as
  `officialMcpCredentials.ts` / `officialMcpAuthHeaders.ts`), with names that do not use Off-Peak business terminology.

Rationale: Their validation rules **currently match but are expected to diverge**—the official MCP plan requirement, Team support scope,
and credential channel (the `X-Bigmodel-Authorization` technical debt in §6.1) may all evolve independently. A shared helper would make any
change on either side require assessing the impact on both; the cost of duplicating two independent implementations is far lower than the cost of coupling them.

The trade-off is two implementations of the same rules, so tests must keep them consistent: OMCP-021 in §8.2 covers the full mapping from credential kind to request headers;
OMCP-025 guards against Off-Peak regressions. If the two implementations behave differently, follow §6.1 of this spec,
not the Off-Peak current state.

The new implementation must **preserve the semantics but implement independently** four characteristics of the existing Off-Peak implementation:

1. **`Bigmodel-Target-Type` currently has no producer at all**; this is a new capability (mapped from credential kind);
2. **`zai-team` stays consistent with Off-Peak (Phase 1 decision):** Off-Peak's
   `buildOffPeakPlanIdentityHeaders` returns an empty object early when `kind !== "bigmodel-team"`; therefore, `zai-team`
   does not send organization/project, although `resolveSelectedOffPeakCodingPlan` has already resolved both values.
   The new implementation preserves this behavior. **Related constraint:** the server's `CodingPlanContext.Valid()` requires organization/project
   to both be non-empty when `TargetType=TEAM`, so `zai-team` also **must not** send `Bigmodel-Target-Type: TEAM`
   (it would be rejected as a bad request). Therefore, `zai-team` omits `Bigmodel-Target-Type`, falls through to the server fallback branch,
   and inherits the same known risk as Off-Peak (the branch queries PERSONAL/TEAM concurrently, and failure of either causes the whole request to fail).
   Thus, §6.1's `Bigmodel-Target-Type` is not sent unconditionally: ZAI Team and all identity-only snapshots omit this header.
   If exact wire-scope support for ZAI Team is needed later, enable it separately on the official MCP side; Off-Peak does not need to change in tandem;
3. **Retain the race-prevention credential consistency check and cover every identity-only path:** at the start of each resolution, read the identity snapshot composed of
   `providerFamilyDomain`, the selected connection fingerprint, `oauth:active_provider`, and `zcodejwttoken`;
   read it again before returning identity-only or full Coding Plan credentials. If any field differs, restart the entire resolution; if it remains unstable after two attempts,
   return `official_auth_unavailable`. The full-credential path must also include the current family's MaaS JWT in the same consistency check.
   This prevents both cross-family credential mixing and token rotation within one family. Compare the raw JWT only in memory;
   never include it in logs or error messages;
4. **Mock credentials must not be enabled by default:** Off-Peak's `resolveOffPeakCredentials` returns a placeholder JWT/Key when `ZCODE_OFFPEAK_MOCK=1`
   and `allowMockCredentials: false` is not explicitly passed. The new implementation **must not introduce this mock branch**;
   official MCP has no corresponding mock gateway, and tests can replace the credential source through dependency injection. If a switch must be retained,
   disable it by default and use a dedicated environment variable; do not reuse `ZCODE_OFFPEAK_MOCK`.

Encode the Start Plan restriction **explicitly in the new implementation** rather than inheriting it from Off-Peak: when the selected connection is Start Plan,
return `official_auth_plan_required`, but still allow connection/discovery requests to send the identity-only ZCode JWT. Do not reuse
Off-Peak reason strings such as `start_plan_not_supported`; the server-side plan check determines whether tool calls are allowed.

Authentication and plan credentials are two independent dimensions. If Coding Plan is selected but the ineligible Provider has been filtered out of the Registry,
recognize this status **before** requiring a MaaS JWT and return an identity-only snapshot containing only the ZCode JWT. Do not let
a missing MaaS JWT downgrade a signed-in request to anonymous. The identity-only snapshot has `planScope` / `wireScope` both set to
`null` and does not include `codingPlanAuthorization`.

### 6.2 Status Owner

- JWT authority: the current ZCode signed-in identity in the host's `credentialService`;
- Coding Plan selection, MaaS JWT, and Team context authority: the host's current settings, credentialService, and the same
  provider registry snapshot; a business key is not an outbound credential for official MCP;
- Plugin configuration declares only which authentication method is required; it does not store, generate, or refresh credentials;
- The Agent/MCP adapter consumes only the headers needed for one request and does not write them to `McpServerConfig`, a Session
  snapshot, Plugin cache, or logs.

Identity-header resolution must not be deferred until the model actually sends `tools/call`: MCP must complete
`initialize` and `tools/list` before the model can call a tool, and these requests also require authentication. Therefore, resolve headers **before every MCP HTTP request**,
covering `initialize`, `tools/list`, `tools/call`, and subsequent protocol requests.

#### 6.2.1 Allow In-Flight Deduplication; Prohibit Time-Based Caching

Resolving once per request has a meaningful cost: one resolution involves a cross-process round trip, two settings reads (comparing fingerprints before and after to detect a connection
switch during the reads), one provider registry snapshot, and re-resolution if the fingerprints differ. MCP calls occur once per protocol request—
an Agent loop calling N tools in sequence performs N resolutions, all on the critical path while the user waits.

Therefore, Phase 1 allows only **in-flight deduplication**:

- If a resolution is already in progress, concurrent requests reuse the same pending Promise instead of starting another;
- **Discard** the Promise as soon as it settles; the next request performs a fresh, complete resolution;
- Do not cache over time: do not cache for N seconds, keep it resident by Plugin/connection, or write it to persistent storage.

Security remains unchanged: only genuinely concurrent requests share a result, and concurrent requests should see the same credential snapshot; no request can
read credentials that have already been replaced. This differs from “caching for a few seconds,” which has an expiration window and is explicitly excluded from this phase.

There is only one deduplication criterion: whether a resolution is currently in progress. Its scope is **host-global**, not partitioned by `pluginId` /
`mcpKey` / `targetOrigin` / workspace—credentials are host-global state (§7.1), and requests from different Plugins,
MCPs, and workspaces at the same time should receive the same credentials. Partitioning by dimension only weakens deduplication without improving isolation.

### 6.3 OAuth Isolation and `zcode_official`'s Own Authentication-Failure Semantics

`zcode_official` and MCP OAuth are mutually exclusive authentication paths. An official-auth failure is a **user identity/plan issue**,
resolvable only through ZCode sign-in and Coding Plan selection, not OAuth authorization for the target MCP. Passing a 401
to OAuth would misrepresent “Please sign in to ZCode again” as “Please authorize this MCP.”

#### 6.3.1 Disable Implicit OAuth Fallback

As described in §2, an `http`/`sse` MCP with no `oauth` field is **defaulted** to `{type:"authorization_code"}`;
the only escape hatch is `authorization` in static `headers`—exactly the static header prohibited by §5.2. Therefore, this design
must add an early short-circuit to OAuth configuration resolution:

```text
resolveAuthorizationCodeOAuthConfig(config):
  if auth?.type === "zcode_official" -> return undefined   # new; before all existing branches
  ...existing branches remain unchanged
```

This yields the following hard requirements:

- `authProvider` must be `undefined`; do not create an OAuth session or start a localhost callback server;
- Do not write an `authorization` field to MCP record status; do not call `onAuthorizationRequired`
  or `openAuthorizationUrl`;
- Existing default behavior for regular MCP and MCP with explicit `oauth` remains unchanged—this short-circuit applies only to `zcode_official`.

#### 6.3.2 Inject Identity Headers Last, Using Overwrite Semantics

Identity headers may be injected only in the `fetch` passed to the transport (the wrapper around `createMcpTransportFetch(...)`),
which is the only egress after the SDK assembles `_commonHeaders()` and `requestInit`.

- Use **overwrite** semantics (`set`) for every identity header in §6.1; do not use `append` or “fill only if missing.” `append` can produce
  comma-joined, multi-value `Authorization`; “fill only if missing” would allow unexpected existing values to survive;
- The wrapper must not modify `mcp-session-id` or `mcp-protocol-version`, and must not delete the SDK-set
  `accept` / `content-type` headers.

#### 6.3.3 Failure Classification and Response Handling

Handle `zcode_official` MCP requests as shown below. If credentials are missing, do not fall back to OAuth or infer credentials from environment variables:

> This table applies to `type:"http"`. Failure semantics for stdio are **intentionally different** (send `{ok:false, reason}` instead of
> marking the connection failed, because a Plugin that receives no headers will not call the official endpoint and no anonymous request is made); see
> `zcode-official-server-mcp-stdio-meta-phase-2-spec.md` §6.3。

| Case                                                                                                   | Classification                   | Behavior                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host auth port unavailable (for example, standalone CLI)                                               | `official_auth_unavailable`      | Mark the connection failed; send no requests                                                                                                                               |
| Not signed in, or no provider family / connection currently selected                                   | `official_auth_unavailable`      | Mark the connection failed; send no requests                                                                                                                               |
| Signed in but using Start Plan or API Key mode, or selected Coding Plan Provider removed from Registry | `official_auth_plan_required`    | Connection/discovery sends only the ZCode JWT, no MaaS JWT or scope headers; the server still checks plan entitlement for tool calls                                       |
| Origin/provenance validation fails (adapter-side validation)                                           | `official_mcp_origin_untrusted`  | Mark the connection failed; zero network requests                                                                                                                          |
| Host-side second Origin validation does not match                                                      | `official_mcp_origin_untrusted`  | Host rejects before reading credentials; `resolveHeaders` is never called; Agent marks failed                                                                              |
| Backend 401                                                                                            | `official_auth_rejected`         | Retry once according to the rules below; if still 401, mark failed                                                                                                         |
| Backend 403                                                                                            | `official_auth_forbidden`        | Do not retry; mark failed. 403 means the identity is valid but permission/plan entitlement is insufficient; fetching the same credentials again will not change the result |
| Backend 3xx                                                                                            | `official_auth_redirect_blocked` | Do not follow; mark failed (§5.2 `redirect: "manual"`)                                                                                                                     |

`official_auth_plan_required` must be a separate classification. Do not reuse Off-Peak reasons such as
`start_plan_not_supported` or merge it into `official_auth_unavailable`: the latter means the environment/sign-in
state is missing, while the former means the plan tier is insufficient. Their follow-up actions differ (sign in again vs upgrade the plan), so they
must be distinguishable in record status and logs. In Phase 1, users see only that the MCP is failed in either case; no guidance is displayed.

401 retry rules (the only permitted retry path):

- Resolve identity headers again and retry **at most once**, unconditionally (do not compare whether credentials changed);
- If the retry still returns 401, mark failed with classification `official_auth_rejected`; the hard retry limit is one, so spinning is impossible;
- This retry applies only to `zcode_official`; existing 401 behavior for regular MCP and OAuth MCP remains unchanged.

The retry is unconditional rather than checking “retry only if credentials changed” because identity headers are resolved for each request (§6.2), and credentials were obtained milliseconds
before the 401. The only race a retry can recover from is credentials being refreshed just after the request was sent. Adding cross-process credential-change
detection for this narrow race is not worthwhile; a connection with persistent 401s is marked failed during `initialize`, so an unconditional retry costs only
one additional request per connection attempt.

These classifications are recorded only in MCP record status and logs (log fields follow §5.2). Phase 1 does **not** display sign-in guidance,
authorization prompts, or other UI for them; `packages/ui` remains unchanged. The user sees only that the MCP is failed,
consistent with existing failure-state rendering.

#### 6.3.4 Do Not Enable the GET SSE Stream in Phase 1

Do **not enable** the SDK's GET `text/event-stream` server stream for `zcode_official` MCP.

Reason: the request headers for this stream are resolved once when it opens; the connection then stays open for a long time, with no “next request” into which fresh headers can be injected.
If enabled, §11's requirement not to reuse old headers after switching the sign-in identity or Coding Plan connection cannot be met for this stream,
leaving a long-lived connection holding expired credentials.

Implementation and backend conventions (verified against actual SDK behavior):

- This GET stream does **not** open during `start()`. The SDK trigger is: after the client sends
  `notifications/initialized`, **if the server returns 202 Accepted** for that notification, the SDK opens the GET stream;
  this design does not use the other two triggers (`resumptionToken` passed to `send`, or the public `resumeStream(...)` method);
- Therefore, to keep it disabled, the server returns **any non-2xx** for GET on this endpoint. The SDK treats that as “the server does not support
  streaming” and returns normally without retrying or reporting an error. The client sends exactly one GET probe (with normal identity headers), which is acceptable
  fixed overhead;
- Observed current state: the go-sdk `StreamableHTTPOptions{Stateless: true}` documentation says GET/DELETE return 405, but
  Gin registers only POST for this path (`router.go`), so GET never reaches the handler and actually returns **404**. This is
  equivalent for SDK behavior and requires no backend change;
- Optional hardening: the fetch wrapper can short-circuit GET requests to this Origin locally and synthesize a 405 response, so no probe is sent.
  This is not required in Phase 1; if adopted, ensure handling matches the real 405 path;
- Therefore, Phase 1 official MCP supports only client-to-server request/response semantics, with no server-to-client push.

If streaming is enabled later, complete all three items together; do not only enable GET on the server: server-side GET SSE with event `id:`
(otherwise `Last-Event-ID` resumption is ineffective and events are lost when the stream drops), client-side credential-change detection and stream replacement,
and `reconnectionOptions` tuning (the SDK default `maxRetries: 2` is too low for a long-lived connection). Server event `id:`
should ideally be implemented in the first backend version; adding it later is a protocol-level change and costs more than a client-side change.

## 7. Client-side ImplementationBoundaries

### 7.1 New Port

The MCP adapter does not depend directly on `packages/services`; it consumes identity headers through dependency injection:

```ts
type OfficialMcpAuthFailureReason = "official_auth_unavailable" | "official_auth_plan_required";

type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}
```

Contract details:

- **Failures are returned rather than thrown as exceptions**, using the classifications defined in §6.3.3; the adapter must not infer failure causes from error text.
  Network errors (401/403/3xx) are outside this port's responsibility; the adapter classifies them after receiving the response;
- `workspaceIdentity` / `workspacePath` are **used only for request context and auditing, not for credential selection**. The credential authority is the host-wide signed-in identity and app settings; credentials are not isolated by workspace, so do not implement per-workspace identity.
  These fields are **not used for routing** either: `client.respond(request.id, ...)` returns the response over the stdio connection that issued the request,
  and the connection determines routing. However, the port must follow repository conventions:
  pass through the full identity and set `workspaceKey = workspaceIdentity?.trim() || workspacePath` (CR review CR-01),
  so remote workspaces with the same path but different identities remain distinguishable in audit context.
  **Remaining gap:** the CLI Agent process currently has no source for `workspaceIdentity`
  (`RunZCodeProtocolAgentOptions` has only cwd/env/… and there is no corresponding environment variable), so this field currently falls back to
  `workspacePath`. The port guarantees “pass through the identity correctly when provided,” not “an identity is always available.”
  If audit requirements need the real remote identity, pass it to the Agent during spawn or through the protocol; that is out of scope for this phase;
- `pluginId` / `mcpKey` / `targetOrigin` are used for **secondary validation on the host** and logging, not credential selection.
  This validation is implemented on the host (CR review CR-01): before resolving credentials, the `zcodeAgentService` handler
  validates the tuple against the same shared registry. If it does not match, the handler returns
  `official_mcp_origin_untrusted` without calling `resolveHeaders`, so no credentials are loaded into memory.
  If the validator is unavailable, reject the request (fail closed); do not fall back to sending credentials after schema validation alone.

  **Why adapter-only validation is insufficient:** the adapter's fetch wrapper runs inside the Agent process, while the host is
  the identity authority. In a desktop-attached remote scenario, the Agent runs remotely while the host holds the local user's identity.
  If validation existed only in the adapter, the remote runtime could obtain the local JWT and Coding Plan key simply by issuing this RPC;
  there would also be no fallback if the Agent-side wrapper were changed or bypassed. That would let the party being checked act as its own checker.

  Note that the dev switch `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` must also apply on the host
  (`env` is passed during assembly in `node.ts`), or the host will reject local tests on its own.

Separation of responsibilities:

1. Plugin loader: strictly parse `auth` and attach host-generated official provenance;
2. Bootstrap: build the trusted Origin registry from `OFFICIAL_PLUGIN_DEFINITIONS` and inject it into the MCP adapter;
3. MCP adapter: validate provenance/Origin during dynamic fetch before calling `OfficialMcpAuthHeadersPort`;
4. MCP adapter: when `zcode_official` matches, skip OAuth configuration resolution, pass `undefined` as `authProvider`, and classify 401/403/3xx as described in §6.3.3;
5. Host/service: resolve the current identity and Coding Plan credentials and return conditional headers (independent implementation, no mock branch; see §6.1.1);
6. MCP adapter: merge non-reserved static headers with dynamic identity headers using override semantics, then send the request (§6.3.2).

### 7.2 Agent Protocol

An Agent process started by Desktop cannot serve as the authority for the user's identity. Add an internal request with a strict schema:

```text
interaction/requestOfficialMcpAuthHeaders
```

There is an existing precedent for naming and classification: `interaction/requestProviderRuntimeHeaders` is also a header request initiated by the Agent,
answered automatically by the host, and requiring no UI. Therefore, the `interaction/` prefix does not imply user interaction; follow this convention without creating a new namespace.

The request carries only non-sensitive context:

```json
{
  "requestId": "mcp-auth-...",
  "workspace": {
    "workspacePath": "/repo",
    "workspaceIdentity": "optional-remote-identity"
  },
  "pluginId": "zcode-tools@zcode-plugins-official",
  "mcpKey": "image-search",
  "targetOrigin": "https://mcp.zcode.example"
}
```

The response travels only over the existing private stdio/remote host attachment link. On success:

```json
{
  "ok": true,
  "headers": {
    "Authorization": "Bearer <jwt>",
    "X-Bigmodel-Authorization": "Bearer <maas-jwt>",
    "Bigmodel-Target-Type": "TEAM",
    "Bigmodel-Organization": "<org-id>",
    "Bigmodel-Project": "<project-id>"
  }
}
```

On failure:

```json
{ "ok": false, "reason": "official_auth_plan_required" }
```

Use `.strict()` for the schema, consistent with the existing protocol, and make `reason` an enum from §6.3.3 rather than free text.
The response **does not contain** `errorMessage`: failures must be enumerable so callers do not branch on message text.

Put the protocol schema in `packages/shared/src/zcode-protocol/index.ts`. When the host receives the request, the service resolves it and
responds automatically; it does not emit a renderer event or pass through a React controller.

If the standalone CLI has no host auth port available, Phase 1 must fail with `official_auth_unavailable`.
It must not fall back to an unauthenticated request or scan environment variables for credentials. A local Coding Plan identity resolver for the standalone CLI
is a separate scope for a later phase.

### 7.3 Request Sequence

```text
User            ZCode host/service        Agent + Plugin loader       HTTP MCP backend
 |                      |                           |                         |
 | start/resume task    |                           |                         |
 |--------------------->| create/reuse Agent        |                         |
 |                      |-------------------------->| load official Plugin    |
 |                      |                           | parse per-MCP auth       |
 |                      |                           | verify official provenance
 |                      |                           | verify exact Origin      |
 |                      |                           |                         |
 |                      |<--------------------------| request auth headers    |
 |                      | resolve one credential snapshot                     |
 |                      | ZCode JWT + conditional plan headers (MaaS JWT / wire scope) |
 |                      |-------------------------->| private response         |
 |                      |                           | inject headers           |
 |                      |                           |------------------------>|
 |                      |                           | initialize / tools/list  |
 |                      |                           |<------------------------|
 | model selects tool   |                           |                         |
 |------------------------------------------------->| resolve headers again   |
 |                      |<--------------------------|                         |
 |                      |-------------------------->|                         |
 |                      |                           | tools/call + headers     |
 |                      |                           |------------------------>|
 |                      |                           |<------------------------|
 |<--------------------------------------------------------------------------|
```

### 7.4 Local / Remote / Web Boundaries

- Desktop local: requests use the current window-scoped Local Host and its Agent stdio link;
- desktop-attached SSH/WSL/Docker: continue using the existing Remote Host and
  `workspaceIdentity` / `remoteSessionId` routing; do not create an Agent runtime for MCP. Identity headers may be returned only to the
  paired Agent client that issued the request;
- mobile `/remote`: reuse only the Agent/MCP runtime already attached to the desktop shared host; the relay and
  desktop main do not store JWTs, Coding Plan keys, or MCP session status;
- The conversation-delivery semantics of desktop `continuous` and mobile `replayable` remain unchanged. Official MCP authentication is a network
  transport capability; it does not add conversation snapshot or queue state.

The remote Agent temporarily holds the request headers in its process, which is necessary to execute HTTP MCP remotely; the headers must not
be added to runtime config, persisted, or logged. Add protocol tests specifically for desktop-attached remote routing. If a real remote environment is unavailable,
record that verification as outstanding; do not claim local tests verify remote behavior.

## 8. Fake Plugin and Test Design

### 8.1 Directory and Identity

Use a fake Plugin as a test fixture; do not include it in `OFFICIAL_PLUGIN_DEFINITIONS`, SEA assets, the Desktop bundle, or
the remote prebuild manifest. Suggested directory:

```text
apps/zcode-cli/packages/bootstrap/tests/fixtures/zcode-official-http-mcp/
  .zcode-plugin/plugin.json
  .mcp.json
```

Inject this root through `officialPluginRoots` in tests, and inject a loopback Origin used only by these tests through an adapter option.
The fake HTTP MCP server listens on a random port at `127.0.0.1` to avoid fixed-port conflicts.

### 8.2 Test Cases

| Case ID  | Setup                                                                                           | Action                      | Assertions                                                                                                                                                                            | Evidence layer           |
| -------- | ----------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| OMCP-001 | Official fixture + valid auth                                                                   | Parse Plugin                | Runtime name is `plugin:<name>:fake-official-search`; auth/provenance are preserved                                                                                                   | Adapter unit             |
| OMCP-002 | Inline/third-party Plugin copies the same auth                                                  | Parse/connect               | No identity headers are requested; MCP fails closed                                                                                                                                   | Adapter unit             |
| OMCP-003 | Official identity, but URL Origin does not match the mapping                                    | Connect                     | `official_mcp_origin_untrusted`; zero network requests                                                                                                                                | Adapter unit             |
| OMCP-004 | Official identity + exact loopback Origin                                                       | initialize/list/call        | Fake server receives the current ZCode JWT on all three request types; with valid plan credentials, it also receives the MaaS JWT and matching wire scope                             | Adapter HTTP integration |
| OMCP-005 | Complete BigModel Team snapshot                                                                 | Send MCP request            | Organization/project are sent as a pair                                                                                                                                               | Services + integration   |
| OMCP-006 | Team snapshot is missing either field                                                           | Send MCP request            | Neither Team header is sent                                                                                                                                                           | Services unit            |
| OMCP-007 | Static Plugin header overrides a reserved header                                                | Parse                       | MCP is disabled with a clear diagnostic                                                                                                                                               | Plugin unit              |
| OMCP-008 | Backend returns 3xx                                                                             | Request                     | Redirect is not followed; Target Origin receives no credentials                                                                                                                       | Adapter HTTP integration |
| OMCP-009 | JWT/plan credentials/host auth port is missing                                                  | Connect                     | Identity-only scenario sends only the ZCode JWT; status is failed when host auth port is unavailable; logs contain no secrets                                                         | Adapter/Bootstrap unit   |
| OMCP-010 | Two MCPs in the same Plugin have different keys/Origins                                         | Connect separately          | Each is authorized according to its mapping; identity is neither shared nor mixed                                                                                                     | Bootstrap integration    |
| OMCP-011 | Desktop-attached remote identity (same `workspacePath` as local, different `workspaceIdentity`) | Request auth                | Response returns only to the requesting Agent client and request ID; same-path local client makes zero calls; interleaved requests remain isolated                                    | Services protocol unit   |
| OMCP-012 | MCP connection pool is reused by multiple sessions                                              | Concurrent requests         | Each HTTP request uses the credential snapshot resolved at that time; the first session's secret is not frozen into config                                                            | Adapter pool unit        |
| OMCP-013 | Official fixture + `zcode_official`, no `oauth` field or static `authorization`                 | Connect                     | `authProvider` is `undefined`; no OAuth session is created; no localhost callback port is opened                                                                                      | Adapter unit             |
| OMCP-014 | Same as above; fake server returns 401 for every request                                        | initialize                  | Classified as `official_auth_rejected` and status is failed; zero calls to `onAuthorizationRequired` / `openAuthorizationUrl`; no `authorization` in record status; no browser opened | Adapter HTTP integration |
| OMCP-015 | Same as above; fake server returns 403                                                          | initialize                  | Classified as `official_auth_forbidden`; exactly one request (no retry)                                                                                                               | Adapter HTTP integration |
| OMCP-016 | First request returns 401; second returns 200 after re-resolution                               | initialize                  | Exactly one retry, then success; second request carries the re-resolved credentials                                                                                                   | Adapter HTTP integration |
| OMCP-017 | Persistent 401                                                                                  | initialize                  | Failed after exactly one retry; exactly two requests, then stop                                                                                                                       | Adapter HTTP integration |
| OMCP-018 | `zcode_official` and `oauth` are configured together                                            | Parse Plugin                | `plugin_mcp_server_disabled`; disabled without choosing a priority                                                                                                                    | Plugin unit              |
| OMCP-019 | Ordinary HTTP MCP (no `auth`, no `oauth`, no static `authorization`)                            | Connect                     | Existing `authorization_code` fallback still works; official OAuth bypass causes no regression                                                                                        | Adapter unit             |
| OMCP-020 | Static `headers` override `bigmodel-target-type` or `mcp-session-id`                            | Parse                       | MCP is disabled with a clear diagnostic                                                                                                                                               | Plugin unit              |
| OMCP-021 | Three credential kinds: Personal / BigModel Team / ZAI Team                                     | Send MCP request            | Wire scopes are `PERSONAL` / `TEAM` / `null`, respectively; organization/project are paired only for `TEAM`                                                                           | Services unit            |
| OMCP-022 | `Authorization` already exists before identity headers are injected                             | Send MCP request            | Final request has exactly one `Authorization`, with the current JWT (overwritten, not appended)                                                                                       | Adapter unit             |
| OMCP-023 | User is signed in, but selected connection is Start Plan                                        | Connect                     | Send only the ZCode JWT, not the MaaS JWT; record the server's login/plan error classification                                                                                        | Services + Adapter unit  |
| OMCP-024 | `ZCODE_OFFPEAK_MOCK=1`                                                                          | Send MCP request            | Official MCP is unaffected by this variable (the new implementation has no such branch); no placeholder credentials are sent                                                          | Services unit            |
| OMCP-025 | Before and after running all official MCP cases                                                 | Run existing Off-Peak tests | Off-Peak behavior is unchanged and all tests pass (verifies the isolation in §6.1.1)                                                                                                  | Services regression      |
| OMCP-026 | Concurrently issue N MCP requests                                                               | Concurrent                  | Underlying credential resolution runs exactly once (in-flight deduplication works); all N requests receive the same headers                                                           | Services unit            |
| OMCP-027 | Issue a request after the first resolution has settled                                          | Two sequential requests     | The second request performs a fresh full resolution (no time-based cache); after switching Coding Plan connection, the second request gets new headers                                | Services unit            |

This phase has no UI behavior, so it adds no WebdriverIO/UI E2E tests and does not modify the conversation session case catalog or coverage
matrix. The core evidence belongs in unit/integration tests for the contracts schema, Plugin parser, MCP adapter, Bootstrap, and services protocol.

## 9. Impact Summary

### 9.1 Must Inspect

| Relationship           | Affected areas                                                                                                                           | Reason                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration contract | `contracts/interfaces/mcp.port.ts`, Plugin MCP parser                                                                                    | `auth` must flow from file configuration into runtime and is allowed only for HTTP                                                                  |
| Request egress         | `adapters/src/mcp/index.ts`, `network.ts`                                                                                                | Dynamically inject headers and validate redirects at the single egress point for all Streamable HTTP MCP requests                                   |
| OAuth isolation        | `resolveAuthorizationCodeOAuthConfig`, `createAuthorizationCodeOAuthOptions` in `adapters/src/mcp/index.ts`; `adapters/src/mcp/oauth.ts` | `zcode_official` must bypass the implicit `authorization_code` fallback and handle 401/403 without affecting the existing fallback for ordinary MCP |
| Official identity      | `bootstrap/official-plugin-definitions.ts`, Plugin discovery                                                                             | Origin mapping and bundled official provenance are prerequisites for authorization                                                                  |
| Identity authority     | New official MCP credential resolver (for example, `services/official-mcp/`) and service assembly                                        | JWT, plan key, and Team context must come from the same current snapshot; implementation is independent of Off-Peak (§6.1.1)                        |
| Off-Peak isolation     | `services/session/offPeakRuntimeModel.ts` and its callers                                                                                | Read-only reference in this phase: do not change exports, signatures, or behavior; existing Off-Peak tests must pass                                |
| Cross-process protocol | Shared ZCode protocol, Bootstrap protocol server, `zcodeAgentService`                                                                    | The Agent is not the identity authority, and the implementation must not depend on a UI response                                                    |
| Pool isolation         | MCP connection pool                                                                                                                      | A shared connection must not freeze or leak the first session/workspace's credentials to later requests                                             |

### 9.2 Should Inspect

- `mcp/list` control plane and session runtime share an adapter; both must return the same failed status when official authentication is unavailable.
  The Settings page must not probe anonymously while the session runtime sends authentication;
- The Plugin cache/official root can be modified locally, so only the Origin mapping enforced by Bootstrap can establish endpoint trust;
- HTTP proxies, custom CAs, and No Proxy must continue to work through `createMcpTransportFetch`. The official auth wrapper may wrap it, but must not bypass existing network policies.

### 9.3 Invariants Only

- Do not modify `packages/ui`;
- Do not modify any existing Off-Peak code path (`offPeakRuntimeModel.ts`, etc.); official MCP has a separate implementation (§6.1.1);
- Do not change headers or OAuth behavior for ordinary HTTP/SSE MCP;
- Do not change stdio MCP, `node_repl`, MCP version negotiation, or tool `_meta`;
- Do not move authentication status into the relay, desktop main, conversation snapshots, or session persistence;
- Do not add `serverId` / `capabilityId`, or infer official identity from URL paths, tool names, or model output.

### 9.4 Suggested Feature Graph Delta

When implementation proceeds, add `capability.zcode-official-server-mcp-auth` and associate it with:

```text
official Plugin definition
  -> plugin MCP parser
  -> trusted Origin registry
  -> MCP HTTP transport
  -> host Coding Plan credential resolver
  -> private Agent protocol bridge
```

This change only updates the spec; it does not modify the feature graph.

## 10. Implementation Order

Follow a test-first approach:

1. First add success and failure tests for contracts/parser;
2. Then add adapter tests for trusted Origins, reserved headers, and redirects;
3. Add adapter tests for the OAuth bypass and 401/403/3xx classification (OMCP-013 through OMCP-019, OMCP-022);
4. Add tests for the host Coding Plan header resolver and Agent protocol, including `Bigmodel-Target-Type` and
   mock isolation (OMCP-021 / OMCP-024 / OMCP-025);
5. Add a fake Plugin + fake HTTP MCP integration test;
6. Then implement contracts, parser, Bootstrap registry, protocol bridge, service resolver, and dynamic fetch;
7. Run targeted tests, then `pnpm typecheck` and `pnpm lint`.

## 11. Acceptance Criteria

- An official Plugin's HTTP MCP can enable `zcode_official/jwt_token` through a per-MCP `auth` declaration in `.mcp.json`;
- None of these four cases sends sensitive headers: correct official identity with the wrong Origin, correct Origin with a third-party Plugin, a copied auth field, or a cross-Origin redirect;
- MCP `initialize`, `tools/list`, and `tools/call` all send the current ZCode JWT (`Authorization`); send
  `X-Bigmodel-Authorization` only when the Registry contains a valid Coding Plan Provider and the current family has a MaaS JWT, and send `Bigmodel-Target-Type` only when a matching `wireScope` exists.
  For `TEAM` wire scope, organization/project must be present as a pair;
- `zcode_official` MCP does not create an OAuth session or occupy a localhost callback port; `authProvider` is
  `undefined`. Classify backend 401/403 responses as failed per §6.3.3; make zero calls to `onAuthorizationRequired` /
  `openAuthorizationUrl`, and do not include an `authorization` field in record status;
- Retry 401 at most once; for a persistent 401, make exactly two requests and then stop;
- Classify official MCP for Start Plan, API Key mode, or a Registry without a valid Coding Plan Provider as
  `official_auth_plan_required`. Connection and discovery requests (`initialize` / `tools/list` / `tools/call`) send only
  the ZCode JWT (no MaaS JWT or target/scope headers), and this is distinguishable from `official_auth_unavailable`;
- After changing the signed-in identity or Coding Plan connection, later requests do not reuse old headers;
- The fake Plugin exists only in test fixtures and is not included in production bundled assets;
- Ordinary MCP, OAuth MCP, stdio MCP, and existing proxy/CA behavior pass regression checks; the implicit `authorization_code` fallback for
  MCPs that are not `zcode_official` remains unchanged;
- No changes to `packages/ui`;
- `pnpm typecheck` and `pnpm lint` pass.

## 12. Backend Interface Conventions

Backend implementation is out of scope for this phase and will be developed separately. This section records what the client
is committed to sending and how it interprets responses, so the backend can implement against that contract without requiring client changes.
Client-side work can proceed using this contract and is not blocked.

### 12.1 Requests Sent by the Client (Confirmed)

For every HTTP request to a trusted official MCP:

| Header                     | Value                                        | Condition                                                                                                                              |
| -------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`            | `Bearer <zcode-jwt>`                         | Always                                                                                                                                 |
| `X-Bigmodel-Authorization` | `Bearer <current family's MaaS sign-in JWT>` | Send only when the Registry has a valid Coding Plan Provider and a MaaS JWT is available (replaced `X-Coding-Plan-Api-Key` in 2026-08) |
| `Bigmodel-Target-Type`     | `PERSONAL` \| `TEAM`                         | Send only when a corresponding wire scope exists; omit when there is no scope                                                          |
| `Bigmodel-Organization`    | organizationId                               | `TEAM` only, paired with project                                                                                                       |
| `Bigmodel-Project`         | projectId                                    | `TEAM` only, paired with organization                                                                                                  |

Existing shared source headers (`User-Agent`, `X-Platform`, etc.) are also sent, with semantics matching other ZCode business APIs and no new
fields. **Correlation ID exception:** do not send `X-Request-Id` / `X-Trace-Id`; read them only from response headers. See the final item in §5.2
for the rationale and contract. Transport uses Streamable HTTP MCP, and the MCP SDK generates the body.

The credential channel changed in 2026-08: when the table's conditions are met, the client sends only
`X-Bigmodel-Authorization` (the MaaS sign-in JWT) and no longer sends `X-Coding-Plan-Api-Key`; identity-only requests send only `Authorization`.
See §6.1 for the reason and why both headers must not be sent.
This resolves the Phase 1 open question about whether the MaaS JWT channel was required by the backend.

### 12.2 Client Interpretation of Responses (Confirmed)

The backend only needs to provide the semantics shown below; the client does not depend on specific business-code labels:

| Response         | Client behavior                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2xx              | Process the MCP protocol response normally                                                                                                                                         |
| 401              | Credentials are invalid/expired. Re-resolve and retry at most once per §6.3.3, then fail. **Do not** start OAuth authorization.                                                    |
| 403              | Identity is valid but lacks permission/plan entitlement. Do not retry; fail immediately.                                                                                           |
| 3xx              | Do not follow (`redirect: "manual"`); fail immediately. Configure production endpoints with a canonical URL rather than relying on trailing-slash or case-normalization redirects. |
| 405 (GET stream) | Treat as “server-side streaming is unsupported”; this is normal and not an error.                                                                                                  |

Therefore, the backend **should not** rely on `WWW-Authenticate` to trigger client OAuth discovery; the official MCP path explicitly disables that
behavior (§6.3.1). Express authentication failures with 401/403.

Client request constraints for backend traffic analysis: official MCP is a Coding Plan entitlement (§3.2). Start Plan users and users
without a Coding Plan connection may still reach the backend during connection/discovery, but send only a non-empty ZCode JWT and no
`X-Bigmodel-Authorization`. The same applies when the selected field still points to Coding Plan but its ineligible Provider has been removed from the Registry.
The backend should distinguish authenticated from unauthenticated users and perform its own plan checks. The client determines this from the selected connection
form and whether the current Registry still has an available Provider—not from the presence of a MaaS JWT or business key. A missing MaaS JWT indicates an incomplete sign-in only when the Registry contains a valid Coding Plan Provider (since 2026-08, the business key is no longer a credential or a requirement).

### 12.3 Values Required from the Backend/Publishing Side

Confirmed (`zcode-server`, verified in 2026-08):

1. **Endpoint and routing:** `POST /api/v1/mcp/server/:mcp_group` (`internal/interfaces/web/router.go`).
   Two hard constraints: `:mcp_group` is **required** (using only `/api/v1/mcp/server/` returns 404), and the URL **must not have a trailing slash**
   (`…/image_search/` returns 307, which the client classifies as `official_auth_redirect_blocked` with a reason unrelated to the actual cause);
2. **Authentication middleware:** **reuse** `requireAuth` + `WithCodingPlan`, as Off-Peak does; the five-header contract in §6.1 applies;
3. **Group list:** currently only `image_search` (`MCPGroupTools` in `internal/domain/servermcp/service.go`), exposing the `search_image` tool. Each group has a separate endpoint and a corresponding MCP entry on the client;
4. **No session:** the handler uses `StreamableHTTPOptions{Stateless: true}` and does **not** send `Mcp-Session-Id`. Therefore, an empty session ID from the real endpoint is expected; only the fake server sends one.

Still pending backend confirmation:

1. ~~The `X-Bigmodel-Authorization` decision at the end of §12.1~~ — **resolved (2026-08):** the backend confirmed that the API key
   channel is retained only for backward compatibility. Official MCP now sends only `X-Bigmodel-Authorization` + the MaaS sign-in JWT when plan credentials are available
   (§6.1); identity-only requests send only `Authorization`;
2. Notification mechanism for new groups: each group has a separate endpoint, so adding a group still requires changing `.mcp.json`,
   which conflicts somewhat with the goal of adding official MCPs without a client change (see the deployment constraint below).

The canonical HTTPS Origin is **no longer unresolved**: official MCP must share the ZCode API Origin, which the client resolves at runtime
(§5.1). If the backend deploys official MCP on a separate domain, the design must return to an explicit allowlist and accept the associated release friction—
this deployment constraint needs alignment in advance.

While these items remain unresolved, the client can complete the fake fixture and all dependency-injection tests (local testing uses the loopback dev switch).

## 13. Implementation Locations

The client side is implemented according to this spec. Files and their responsibilities:

| Responsibility                                                                                 | File                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Header set / reserved-header denylist (shared by both sides, §5.2)                             | `packages/shared/src/official-mcp-auth.ts`                                                                               |
| Agent protocol schema (§7.2)                                                                   | `packages/shared/src/zcode-protocol/index.ts`                                                                            |
| Credential resolution + identity-header construction + in-flight deduplication (§6.1 / §6.2.1) | `packages/services/src/official-mcp/officialMcpCredentials.ts`                                                           |
| Host-side handling of reverse requests (§7.2)                                                  | `packages/services/src/zcode-agent/zcodeAgentService.ts`                                                                 |
| Assembly (host is the sole identity authority)                                                 | `packages/services/src/node.ts`                                                                                          |
| Configuration contract and port types (§4.2 / §7.1)                                            | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`                                                           |
| Strict Plugin parsing + provenance (§4.2)                                                      | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`                                                                    |
| Dynamic injection + Origin validation + failure classification (§6.3.2 / §6.3.3)               | `apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts`                                                              |
| OAuth bypass (§6.3.1)                                                                          | `resolveAuthorizationCodeOAuthConfig` / `createOfficialAuthFetch` in `apps/zcode-cli/packages/adapters/src/mcp/index.ts` |
| Trusted Origin registry (§5.1)                                                                 | `packages/shared/src/official-mcp-auth.ts`                                                                               |
| Agent-side auth port (§7.1)                                                                    | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts`                                         |
| Runtime assembly                                                                               | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`                                                     |

Test case locations: `plugin-official-mcp-auth.test.ts` (parsing), `packages/shared/test/officialMcpTrust.test.ts` (trust),
`mcp-official-auth.test.ts` (injection and classification), `mcp-official-auth-integration.test.ts` (fake end-to-end),
`officialMcpCredentials.test.ts` (credentials), `officialMcpAuthProtocol.test.ts` (protocol schema),
`officialMcpAuthRemoteRouting.test.ts` (desktop-attached remote routing),
`official-mcp-auth-port.test.ts` (port-to-protocol parameter construction, including distinguishing identities with the same path).
There are 87 cases, with assertions corresponding to OMCP-001 through OMCP-027 (OMCP-025 is the Off-Peak regression action; its command is recorded in
the header comment of `officialMcpCredentials.test.ts`).

### 13.1 Three Facts Clarified During Implementation

1. **The GET probe in §6.3.4 is verified and locked by a test:** after receiving 202 for `notifications/initialized`, the SDK sends
   **exactly one** GET. The server responds with 405, which the client safely abandons while the connection remains connected. The assertion in
   `mcp-official-auth-integration.test.ts` locks this count to prevent future assumptions that “the client sends no GET at all.”
2. **The reserved-header denylist applies only to the official-auth path:** static `authorization` on ordinary/third-party HTTP MCP is a valid existing use
   (`resolveAuthorizationCodeOAuthConfig` relies on it to exit the OAuth fallback). A global block would cause a regression. OMCP-019 locks this boundary.
3. **Failure classifications cannot be recovered from the error object:** during version negotiation, the SDK wraps `OfficialMcpAuthError`
   in a plain `Error` (with the message prefix `Version negotiation probe failed: `), losing object identity. Therefore, `instanceof` is unreliable in
   `failConnection`; parsing error text would violate the rule against using error text for control flow. Instead, report the classification through
   `onAuthFailure` at the **throw site**. The adapter stores it in a per-server slot, consumes and immediately clears it in `failConnection`, and clears it
   again at the start of every connect to prevent cross-talk. The §6.3.3 classification is then searchable in production logs by the `officialAuthKind` field.

### 13.2 Real-device Verification Record (2026-08-16)

Verified on the local Desktop (`pnpm dev:desktop`) with the local fake official MCP (`scripts/dev-official-mcp-server.mjs`):

- Verification passed with a real signed-in identity and a Personal Coding Plan: the Agent log showed `mcp.server.connected`
  (`plugin:dev-official-mcp:dev-search`), with no `mcp.server.failed` events or official MCP authentication failures. The fake server received
  `initialize` / `tools/list` with the complete identity headers, and the GET streaming probe was safely abandoned after a 405.

Two local facilities are needed for self-testing:

- `scripts/dev-official-mcp-server.mjs` — a loopback fake MCP that prints the authentication headers for each request
  (JWTs and Coding Plan keys are redacted; `Bigmodel-Target-Type` / organization / project are shown as-is);
- `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` — a local dev switch that accepts **only** HTTP loopback
  (`normalizeTrustedOrigin` in `"loopback"` mode rejects HTTPS and non-loopback hosts, preventing a single environment variable from directing a real JWT to a remote host). When unset, behavior is exactly as before the implementation.

Self-testing pitfalls (to save time when reproducing later):

- Load a local Plugin through `plugins.dirs` in `~/.zcode/cli/config.json`, **not**
  `~/.zcode/v2/config.json` (Desktop/services configuration) or the Settings page's “Add marketplace” flow
  (that flow requires a marketplace directory);
- A Plugin loaded through `dirs` always uses the `inline` marketplace, so its ID looks like
  `dev-official-mcp@inline`. This suffix **does not affect authorization** (the marketplace check was removed in §5.1).
  Whether local testing succeeds depends only on the Origin: an HTTPS endpoint must equal the current ZCode API Origin,
  and an HTTP loopback Origin must be listed in `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`;
- MCP connections are initiated once when a session is created. If the connection fails, it remains failed and does not reconnect automatically;
  **start the fake server before starting Desktop**. The Desktop MCP status display can lag (it matches the Agent's actual status only after restart);
  this is existing behavior and out of scope for this phase (§9.3: do not change `packages/ui`).

### 13.2.1 Settings-page Status Refresh Timing (Existing Behavior)

During self-testing, we observed that “the Agent is connected, but Settings still shows the old status until restart.” This results from existing refresh behavior combined with official MCP's
connection pattern. **Do not fix it in this phase** (§9.3 invariants only: do not change `packages/ui`); it is recorded here for a future task.

`McpSettingsSection.tsx` has only three refresh triggers:

| Trigger source                  | Condition                                                                                                                                                                                                                                                       | Effect on official MCP                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Automatic refresh on key change | Refreshes only when `autoStatusListRefreshKey` changes (`previousKey !== nextKey` in `transitionMcpAutoStatusListRefreshKey`). The key = workspaceIdentity + workspacePath + `serverStatusListKey`, and the latter is derived from the **servers/plugins list** | ❌ A connection-status change does not change the list, so the key stays the same |
| 1-second polling                | Requires a pending OAuth server (`pendingMcpOAuthAuthorizationRefreshKey` is non-empty); capped at 5 minutes                                                                                                                                                    | ❌ Official auth has no `authorizationUrl` per §6.3.1                             |
| Window focus / visibilitychange | Also gated by `pendingMcpOAuthAuthorizationRefreshKey`                                                                                                                                                                                                          | ❌ Same as above                                                                  |

In other words, **there is no subscription for connection-status changes and no periodic refresh for non-OAuth servers**. None of the three paths refreshes official MCP status.

**Verified findings (2026-08-16; correcting an earlier assumption):** after stopping the fake server, switching the Settings tab, switching workspaces,
or **toggling the Plugin** does not change the status to failed. Toggling the Plugin does use the Settings-page link
(a `protocol-settings` lease is acquired and released with `sess=-`), but **it does not produce any dev-search probe event**,
so the displayed status remains the old snapshot. Log evidence: after 13:55,
all MCP events have a `sessionId` and `mcpIsolation: session`; none comes from a Settings-page
`protocol-settings` lease:

```text
13:50:27  mcp.server.connected  sess_fb0c0db  session   (server running)
13:55:36  mcp.server.failed     sess_8517a98  session   (server stopped)
13:55:36  mcp.server.failed     sess_95448b8  session
13:55:37  mcp.server.failed     sess_72bae46  session
13:55:37–13:59  switch workspace / switch Settings tab → no new events
```

The cause is that `serverStatusListKey` is derived only from the servers/plugins **list**, which does not change when a connection status changes.
The Settings component remains mounted when switching tabs, so `lastAutoStatusListRefreshKeyRef` is not reset;
as a result, `transitionMcpAutoStatusListRefreshKey` returns `shouldRefresh: false`.
**Restarting the app is currently the only reliable way to rebuild this store.**

The two paths must be distinguished: Settings uses the entrypoint's `protocol-settings` lease, while each session uses its own
session lease. They share a connection pool, but status does not flow between them. Therefore, a failure known to the session side is not reflected in Settings.

Also confirmed: the default (connect) mode of `mcp/list` **actually reconnects** (`bootstrap/src/zcode-protocol/mcp.ts`
calls `connectConfiguredServers`); it does not just read a cache. So the problem is not “reading stale cache,” but “nobody requests an update.”

The Plugin list behaves similarly: `pluginManagementStore.initialize` is called in `useEffect` for each workspace,
and `refresh()` runs only after changes such as enabling/disabling/installing/uninstalling; there is no timer. Therefore, after manually editing
`plugins.dirs` in `~/.zcode/cli/config.json`, the UI does not discover the change on its own.

Impact on regular MCP is limited (OAuth servers are polled; non-OAuth servers usually connect quickly, around the initial mount).
Official MCP connections are initiated on demand at the session level, often after Settings has mounted, so Settings necessarily shows stale status.
Future fix direction: add a connection-status subscription beyond `serverStatusListKey`, or add low-frequency polling for non-OAuth servers.
Both approaches change the UI layer and should be handled as a separate task.

### 13.2.2 Local Fault Injection for Error Paths

`scripts/dev-official-mcp-server.mjs` supports fault injection to verify the classifications in §6.3.3. It accepts two options:
`--mode ok|401|403|redirect|tool-quota`、`--fail-on all|initialize|tools/call`。

| Scenario                           | Command                           | Expected                                                                                                     |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No entitlement during connection   | `--mode 403 --fail-on initialize` | `officialAuthKind=official_auth_forbidden`; MCP fails; one injection log only (403 is not retried)           |
| 403 during a call after connection | `--mode 403 --fail-on tools/call` | MCP remains connected and tools stay mounted; only that tool call fails                                      |
| Quota exhausted during tool call   | `--mode tool-quota`               | HTTP 200 + `isError: true` business error; MCP remains connected                                             |
| Credentials rejected               | `--mode 401`                      | `official_auth_rejected`; exactly two injection logs (one original + one retry); more indicates a retry loop |
| Redirect hijack                    | `--mode redirect`                 | `official_auth_redirect_blocked`; Target Origin receives no requests                                         |

**Key distinction:** neither `--fail-on tools/call` nor `tool-quota` produces `officialAuthKind`: the former occurs on a single call after the connection
has been established, and the latter is not an authentication problem at all. MCP business errors use in-band `isError`, not an HTTP status code,
so quota exhaustion should not disconnect the connection. This is expected by design, not a missing report.

One fail-closed scenario that **does not require the backend** (verifying “no credentials leak on rejection,” which is more important than a server failure):

- `official_mcp_origin_untrusted`: start without setting `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`; this also results in zero requests.

Use this command for a consistent readout: `grep '"officialAuthKind"' ~/.zcode/cli/log/zcode-<date>.jsonl`.
Note: a connection-time failure requires restarting Desktop to reconnect (the refresh blind spot in §13.2.1); a tool-call failure does not.

### 13.3 Known Gaps

- ~~No production `OFFICIAL_PLUGIN_DEFINITIONS` entry has registered a `trustedMcpOrigins` value~~: this mechanism was removed after the decision in §5.1 changed.
  The registry no longer holds a mapping table; trust is now determined by whether the Target Origin equals the runtime-resolved ZCode API
  Origin. There is no Origin value left to populate; if the Origin cannot be resolved, the client still fails closed
  （`zcode_origin_unresolved`）；
- **Targeted protocol tests for desktop-attached remote routing have been added** (`officialMcpAuthRemoteRouting.test.ts`,
  OMCP-011). They cover response routing over two independent paths with the same `workspacePath` but different `workspaceIdentity`,
  isolation of interleaved requests, pass-through of `plan-required`, `official_auth_unavailable` when no resolver exists,
  and malformed parameters going through `respondError` without resolving credentials.
  **Remaining risk:** these service-layer tests use a fake Agent client to verify routing and the response channel; the full path has not been exercised in a real
  SSH/WSL/Docker environment. Remote process startup, transport, and network egress remain unverified, as explicitly recorded here per §7.4; do not claim “verified on a real remote.”
