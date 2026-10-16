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
  `plugin_mcp_server_disabled` 并禁用该 MCP；
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
   `auth.type = zcode_official` 且 url 指向 ZCode API origin，就能让客户端为它注入身份头。
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
   (pluginId, mcpKey, workspaceKey) 在本进程内首次发放时记一条 info 级
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
      | 是
      v
Does URL.origin === the runtime ZCode API origin and use HTTPS? -- No --> fail closed
      |                                                        (official_mcp_origin_untrusted)
      | 是
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
  `x-coding-plan-api-key`、`x-bigmodel-authorization`、`bigmodel-target-type`、
  `bigmodel-organization`、`bigmodel-project`，以及协议头 `mcp-session-id`、
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
`X-Coding-Plan-Api-Key`、`X-Bigmodel-Authorization`、`Bigmodel-Organization`、`Bigmodel-Project`、
the five headers `Bigmodel-Target-Type`, etc.; JWT `Authorization` is read separately by `requireAuth`. Key points:

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

#### 6.1.1 独立实现，不复用 Off-Peak Code（本阶段决策）

官方 MCP 的凭证解析与身份头构造**另写一套**，与 Off-Peak 逻辑等价但Code独立：

- **不复用** `resolveOffPeakCredentials(...)`、`buildOffPeakPlanIdentityHeaders(...)`、
  `resolveSelectedOffPeakCodingPlan(...)` 等 Off-Peak 函数，也不把它们改造成共享 helper；
- **Not modified** `packages/services/src/session/offPeakRuntimeModel.ts` 的任何现有导出与行为，
  Off-Peak 链路零改动、零回归风险；
- 新实现建议独立落位（如 `packages/services/src/official-mcp/` 下的
  `officialMcpCredentials.ts` / `officialMcpAuthHeaders.ts`），命名不带 Off-Peak 业务名。

理由：两者的判定规则**当前一致但未来Expected分叉**——官方 MCP 的套餐门槛、Team 支持Scope、
凭证通道（§6.1 的 `X-Bigmodel-Authorization` 技术债）都可能独立演进。共享 helper 会让任一侧的
调整变成Needs/Requires评估双方影响的改动；独立两套的重复成本远低于耦合成本。

代价是同一套规则存在两份实现，需靠Tests守住一致性：§8.2 的 OMCP-021 覆盖 credential kind 到请求头
的完整映射，OMCP-025 守住 Off-Peak 零回归。两份实现出现行为差异时，以本 spec 的 §6.1 为准，
而非以 Off-Peak Current State为准。

Off-Peak 现有实现中的四处特性，新实现需**照抄语义但自行编码**：

1. **`Bigmodel-Target-Type` 当前完全没有生产者**，属新增能力（按 credential kind 映射）；
2. **`zai-team` 与 Off-Peak 保持一致（本阶段决策）**：Off-Peak 的
   `buildOffPeakPlanIdentityHeaders` 以 `kind !== "bigmodel-team"` 提前返回空对象，因此 `zai-team`
   不发送 organization/project——尽管 `resolveSelectedOffPeakCodingPlan` 其实已解析出这两个值。
   新实现沿用该行为。**连带约束**：服务端 `CodingPlanContext.Valid()` 要求 `TargetType=TEAM` 时
   organization/project Must同时非空，故 `zai-team` 也**不能**发送 `Bigmodel-Target-Type: TEAM`
   （会被判 bad request）。`zai-team` 因此不发送 `Bigmodel-Target-Type`，落入服务端 fallback 分支，
   并继承与 Off-Peak 相同的已知风险（该分支并发查询 PERSONAL/TEAM，任一路失败即整体失败）。
   因此 §6.1 的 `Bigmodel-Target-Type` 不是无条件发送：ZAI Team 及所有 identity-only 快照均
   不发送该头。若后续要支持 ZAI Team 的精确 wire scope，在官方 MCP 侧单独放开即可，不Needs/Requires同步改
   Off-Peak；
3. **防竞态的凭证一致性检查Must保留，且需覆盖所有 identity-only 路径**：每轮先读取由
   `providerFamilyDomain`、选中连接指纹、`oauth:active_provider`、`zcodejwttoken` 组成的身份快照；
   在返回仅身份凭证或完整 Coding Plan 凭证前再读取一次。任一字段前后不一致即整轮重来，两轮
   仍不稳定则返回 `official_auth_unavailable`。完整凭证路径还Must把当前 family 的 MaaS JWT 纳入
   同一轮一致性检查。这样既能挡住跨 family 混搭，也能挡住同 family 的 token 轮换；JWT 原文只在
   内存比较，不进日志、不进错误信息；
4. **mock 凭证不得默认开启**：Off-Peak 的 `resolveOffPeakCredentials` 在 `ZCODE_OFFPEAK_MOCK=1`
   且未显式传 `allowMockCredentials: false` 时返回占位 JWT/Key。新实现**should not引入该 mock 分支**；
   官方 MCP 没有对应的 mock 网关，Tests通过依赖注入替换 credential 来源即可。若确需保留开关，
   Must默认关闭且使用独立环境变量，不复用 `ZCODE_OFFPEAK_MOCK`。

Start Plan 的套餐限制**在新实现中显式编码**（而非靠继承 Off-Peak）：选中连接为 Start Plan 时
返回 `official_auth_plan_required`，但仍允许连接/发现请求发送仅身份的 ZCode JWT。不要沿用
Off-Peak 的 `start_plan_not_supported` 等 reason 字符串；工具调用是否放行由服务端套餐校验决定。

身份认证与套餐凭证是两个独立维度。选中 Coding Plan、但无权益 Provider 已被 Registry 过滤时，
Must在要求 MaaS JWT **之前**识别该Status，并返回仅含 ZCode JWT 的 identity-only snapshot；不能因为
MaaS JWT 缺失把已登录请求降级成匿名。identity-only snapshot 的 `planScope` / `wireScope` 均为
`null`，且不包含 `codingPlanAuthorization`。

### 6.2 Status owner

- JWT 权威源：host `credentialService` 中当前 ZCode 登录身份；
- Coding Plan 选择态、MaaS JWT 与 Team context 权威源：host 当前 settings、credentialService 与同一份
  provider registry snapshot；业务 key 不作为官方 MCP 出站凭证；
- Plugin 配置只声明“Needs/Requires哪种鉴权”，不保存、不生成、不刷新凭证；
- Agent/MCP adapter 只消费一次请求所需的 header，不把 header 写入 `McpServerConfig`、Session
  snapshot、Plugin cache 或日志。

身份头解析不能推迟到模型真正发出 `tools/call` 时才首次执行：MCP 在模型调用工具之前Must先完成
`initialize` 与 `tools/list`，这两个请求同样Needs/Requires鉴权。因此解析发生在**每个 MCP HTTP 请求发送前**，
覆盖 `initialize`、`tools/list`、`tools/call` 及后续协议请求。

#### 6.2.1 允许 in-flight 去重，Prohibited时间维度缓存

每请求解析一次的成本不低：一次解析包含跨进程往返、两次 settings 读取（前后比对指纹以防连接在
读取期间被切换）、一次 provider registry snapshot，以及指纹不一致时的重解析。而 MCP 的调用频率是
每个协议请求一次——一个 agent loop 连续调用 N 个工具即 N 次解析，且全部位于用户等待的关键路径上。

因此第一阶段允许且仅允许 **in-flight 去重**：

- 同一时刻若已有一次解析在进行中，后续请求复用同一个 pending Promise，不重复发起；
- 该 Promise settle 后**立即丢弃**，下一个请求重新完整解析；
- 不做任何时间维度缓存（不缓存 N 秒、不按 Plugin/连接常驻、不写入任何持久层）。

安全性不变：只有真正并发的请求才共享结果，而并发请求本就应看到同一份凭证快照；任何请求都不会
读到已被替换的旧凭证。这与"缓存若干秒"是不同的机制，后者存在过期窗口，本阶段明确不采用。

去重判据只有一个：当前是否存在正在进行的解析。作用域为 **host 全局**，不按 `pluginId` /
`mcpKey` / `targetOrigin` / workspace 分桶——凭证是 host 级全局Status（§7.1），同一时刻不同 Plugin、
不同 MCP、不同 workspace 的请求本就应拿到同一份凭证。按维度分桶只会削弱去重效果，不提升隔离性。

### 6.3 与 OAuth 隔离，以及 `zcode_official` 自有的鉴权失败语义

`zcode_official` 与 MCP OAuth 是两条互斥的鉴权路径。官方鉴权失败是**用户身份/套餐Problem**，
只能由 ZCode 自身的登录与 Coding Plan 选择解决，不可能由Target MCP 的 OAuth 授权解决；把 401
交给 OAuth 会把"请重新登录 ZCode"错误地呈现成"请授权这个 MCP"。

#### 6.3.1 Must关闭隐式 OAuth 兜底

如 §2 所载，`http`/`sse` MCP 缺少 `oauth` 字段时会**默认**得到 `{type:"authorization_code"}`，
其唯一逃生口是静态 `headers` 里存在 `authorization`——而 §5.2 恰好Prohibited该静态头。因此本方案
Must在 OAuth 配置解析处新增一条Prerequisite短路：

```text
resolveAuthorizationCodeOAuthConfig(config):
  if auth?.type === "zcode_official" -> return undefined   # 新增，位于所有既有分支之前
  ...既有分支Remains unchanged
```

由此得到的硬性要求：

- `authProvider` Must为 `undefined`；不得创建 OAuth session，不得起 localhost 回调 server；
- 不得写入 `authorization` 字段到 MCP record status，不得调用 `onAuthorizationRequired`，
  不得调用 `openAuthorizationUrl`；
- 普通 MCP、显式 `oauth` MCP 的既有默认行为完全不变——本条短路只对 `zcode_official` 生效。

#### 6.3.2 身份头注入Must是最后一棒且为覆盖语义

身份头只能在传给 transport 的 `fetch`（即包裹 `createMcpTransportFetch(...)` 的 wrapper）内注入，
该处是 SDK 组装完 `_commonHeaders()` 与 `requestInit` 之后的唯一出口。

- 对 §6.1 的每个身份头使用**覆盖**语义（`set`），Prohibited `append`，Prohibited"缺失才补"。`append` 会产生
  逗号拼接的多值 `Authorization`，"缺失才补"会让非Expected的既有值存活；
- wrapper 不得修改 `mcp-session-id`、`mcp-protocol-version`，也不得删除 SDK 设置的
  `accept` / `content-type`。

#### 6.3.3 失败分类与响应处理

`zcode_official` 的 MCP 请求按下表处理；凭证缺失时不得回退 OAuth、不得读环境变量猜凭证：

> 本表适用于 `type:"http"`。stdio Form的失败语义**有意不同**（下发 `{ok:false, reason}` 而不是
> 置 failed，因为拿不到头的插件不会去打官方端点，不存在匿名请求），见
> `zcode-official-server-mcp-stdio-meta-phase-2-spec.md` §6.3。

| 情况                                                                                          | 分类                             | 行为                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| host auth port 不可用（如 standalone CLI）                                                    | `official_auth_unavailable`      | 连接置 failed，不发任何请求                                                                |
| 未登录，或无当前选中的 provider family / connection                                           | `official_auth_unavailable`      | 连接置 failed，不发任何请求                                                                |
| 已登录但持有的是 Start Plan、API Key 模式，或当前选中 Coding Plan Provider 已从 Registry 移除 | `official_auth_plan_required`    | 连接/发现请求仅发送 ZCode JWT，不发送 MaaS JWT 或 scope 头；工具调用仍由服务端判定套餐权益 |
| Origin/provenance 校验不通过（adapter 本地校验）                                              | `official_mcp_origin_untrusted`  | 连接置 failed，网络请求次数为 0                                                            |
| host 侧二次校验 Origin 不匹配                                                                 | `official_mcp_origin_untrusted`  | host 在读取凭据前拒绝，`resolveHeaders` 零调用；agent 侧置 failed                          |
| 后端 401                                                                                      | `official_auth_rejected`         | 按下方规则重试一次；仍 401 则置 failed                                                     |
| 后端 403                                                                                      | `official_auth_forbidden`        | 不重试，置 failed。403 Means身份有效但无权限/套餐不足，重取同一份凭证不会改变结果          |
| 后端 3xx                                                                                      | `official_auth_redirect_blocked` | 不跟随，置 failed（§5.2 `redirect: "manual"`）                                             |

`official_auth_plan_required` Must是独立分类，不得复用 Off-Peak 的
`start_plan_not_supported` 等 reason，也不得合并进 `official_auth_unavailable`——后者代表"环境/登录
态缺失"，前者代表"套餐层级不满足"，两者的后续Action不同（重新登录 vs 升级套餐），Needs/Requires可区分地
落到 record status 与日志。第一阶段两者的用户可见表现都只是该 MCP 处于 failed，不弹任何引导。

401 的重试规则（唯一允许的重试路径）：

- 重新解析身份头并重试，**上限一次**，无条件（不比较凭证是否变化）；
- 重试仍 401 → 置 failed，分类 `official_auth_rejected`；重试次数硬上限为 1，不存在自旋可能；
- 该重试只针对 `zcode_official`，Not changed普通 MCP 与 OAuth MCP 的既有 401 行为。

之所以无条件重试、不做"凭证变了才重试"的判定：身份头是每请求现解析的（§6.2），401 时凭证在毫秒
前才取得，能靠重试自愈的只有"请求发出后凭证恰好被刷新"这一窄竞态。为它引入跨进程的凭证变更
检测不划算；而持续 401 的连接会在 `initialize` 阶段即置 failed，无条件重试的代价只是每次连接尝试
多一个请求。

上述分类只进入 MCP record status 与日志（日志字段受 §5.2 约束）。第一阶段**不**因此弹出任何
登录引导、授权提示或其它 UI；`packages/ui` 保持零改动。用户可见表现即该 MCP 处于 failed，
与既有失败态渲染一致。

#### 6.3.4 第一阶段不启用 GET SSE 流

`zcode_official` MCP **不开启** SDK 的 GET `text/event-stream` 服务端推流。

Cause：该流的请求头在开流瞬间一次性算好，之后连接长期挂着，没有"下一次请求"可供重新注入。
若启用，§11 的"切换登录身份或 Coding Plan connection 后不复用旧 header"对这条流无法成立，
等于留下一条持有过期凭证的长连接。

实现与后端Conventions（已按 SDK 实际行为核对）：

- 该 GET 流**不是**在 `start()` 时开启的。SDK 的触发点是：客户端发出
  `notifications/initialized` 后，**若服务端对该通知返回 202 Accepted**，SDK 才开启 GET 流；
  另两个触发点（`send` 传入 `resumptionToken`、公开方法 `resumeStream(...)`）本方案都不会调用；
- 因此"不启用"的落地方式是：服务端对该端点的 GET 返回**任意非 2xx**，SDK 将其视为"服务端不支持
  推流"并正常返回、不重试、不报错。客户端会发出恰好一次 GET 探测（携带正常身份头），这是可接受的
  固定开销；
- 实测Current State：go-sdk 的 `StreamableHTTPOptions{Stateless: true}` 文档声明 GET/DELETE 返回 405，但
  gin 只为该路径注册了 POST（`router.go`），GET 根本到不了 handler，实际返回 **404**。对 SDK 行为
  等价，无需后端改动；
- 可选加固：fetch wrapper 可在本地直接短路对该 Origin 的 GET 请求并合成 405 响应，连探测都不发。
  第一阶段不强制，但若采用需保证与真实 405 的处理路径一致；
- 因此第一阶段官方 MCP 只有 client→server 的请求/响应语义，没有 server→client 主动推送。

若后续要开启推流，需同时补齐三件事，不能只让服务端开始支持 GET：服务端 GET SSE 且事件带 `id:`
（否则 `Last-Event-ID` 恢复形同虚设，断流即丢事件）、客户端的凭证变更检测与换流机制、
以及 `reconnectionOptions` 调优（SDK 默认 `maxRetries: 2`，对长连接偏少）。其中服务端事件 `id:`
最好在后端首版就做——后补属协议层改动，成本高于客户端侧。

## 7. Client-side ImplementationBoundaries

### 7.1 新端口

MCP adapter 不直接依赖 `packages/services`，通过依赖注入消费身份头：

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

契约要点：

- **失败走返回值而非抛异常**，返回 §6.3.3 定义的分类；adapter 不得把失败Cause从错误文本里解析。
  网络层错误（401/403/3xx）不属于该端口的职责，由 adapter 在收到响应后自行分类；
- `workspaceIdentity` / `workspacePath` **仅用于请求上下文与审计，不参与凭证选择**。凭证权威源是
  host 全局的登录身份与 app settings，不按 workspace 隔离——不要据此实现 per-workspace 身份。
  也**不用于路由**：响应经 `client.respond(request.id, ...)` 回到发起请求的那条 stdio 连接，
  路由由连接本身决定。但端口仍Must遵守仓库Conventions
  `workspaceKey = workspaceIdentity?.trim() || workspacePath` 并完整透传 identity（CR review CR-01），
  否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
  **剩余缺口**：CLI agent 进程当前没有 workspaceIdentity 来源
  （`RunZCodeProtocolAgentOptions` 仅有 cwd/env/… ，也无对应环境变量），故该字段实际退化为
  workspacePath。端口保证的是"拿到 identity 就正确透传"，不是"identity 一定存在"；
  若审计Needs/Requires真实远端身份，需在 spawn 或协议层把 identity 传给 agent，不在本阶段Scope；
- `pluginId` / `mcpKey` / `targetOrigin` 用于**host 侧的二次校验**与日志，不参与凭证选择。
  该校验已在 host 实现（CR review CR-01）：`zcodeAgentService` 的 handler 在调用凭据解析
  **之前**用同一份 shared registry 校验三元组，未命中即返回
  `official_mcp_origin_untrusted`，`resolveHeaders` 不被调用，因此没有任何凭据被读入内存。
  validator 缺省时一律拒绝（fail closed），不退化为"只做 schema 校验就发凭据"。

  **为什么不能只靠 adapter**：adapter 的 fetch wrapper 运行在 agent 进程内，而 host 才是
  身份权威。desktop-attached remote Scenario下 agent 跑在远端、host 持有本地用户身份，若只有
  adapter 校验，远端 runtime 只要发这个 RPC 就能取到本地 JWT 与 Coding Plan key；agent 侧
  wrapper 被改坏或被绕过时也没有兜底。等于让被审查方自己当审查者。

  Note dev 开关 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` Must**同时**对 host 生效
  （`node.ts` 装配时传入 `env`），否则本地自测会被 host 单方面拒绝。

职责分离：

1. Plugin loader：严格解析 `auth`，附加宿主生成的 official provenance；
2. Bootstrap：从 `OFFICIAL_PLUGIN_DEFINITIONS` 构造可信 Origin registry，并注入 MCP adapter；
3. MCP adapter：在动态 fetch 中先校验 provenance/Origin，再调用 `OfficialMcpAuthHeadersPort`；
4. MCP adapter：`zcode_official` 命中时短路 OAuth 配置解析，`authProvider` 传 `undefined`，并按
   §6.3.3 自行分类 401/403/3xx；
5. host/service：解析当前身份与 Coding Plan 凭证并返回条件化 header（独立实现、无 mock 分支，见
   §6.1.1）；
6. MCP adapter：以覆盖语义合并非保留静态 header 与动态身份头后发送请求（§6.3.2）。

### 7.2 Agent 协议

Desktop 启动的 Agent 进程不能自行成为用户身份权威。增加一个严格 schema 的内部请求：

```text
interaction/requestOfficialMcpAuthHeaders
```

命名与归类有现成先例：`interaction/requestProviderRuntimeHeaders` 同样是 Agent 发起、host 自动
响应、不产生任何 UI 的 header 请求。因此 `interaction/` 前缀并不等于"Needs/Requires用户交互"，本请求沿用
该惯例即可，无需新建命名空间。

请求只携带非敏感上下文：

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

响应只在现有私有 stdio/remote host attachment 链路上传输。成功：

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

失败：

```json
{ "ok": false, "reason": "official_auth_plan_required" }
```

schema 用 `.strict()`（与既有协议一致），`reason` 为 §6.3.3 的枚举而非自由文本。响应中**不含**
`errorMessage`：失败CauseMust可枚举，避免调用方按文本分流。

协议 schema 放在 `packages/shared/src/zcode-protocol/index.ts`。host 收到后由 service 自动解析并
响应，不产生 renderer event，也不经过 React controller。

Standalone CLI 若没有可用的 host auth port，第一阶段Must以 `official_auth_unavailable` 失败，不能
回退到无鉴权请求，也不能扫描环境变量猜测凭证。Standalone CLI 的本地 Coding Plan identity resolver
作为后续独立Scope处理。

### 7.3 请求时序

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
 |                      | ZCode JWT + 条件化套餐头（MaaS JWT / wire scope）     |
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

### 7.4 local / remote / web Boundaries

- Desktop local：请求通过当前 window-scoped Local Host 与其 Agent stdio 链路完成；
- desktop-attached SSH/WSL/Docker：继续复用既有 Remote Host 和
  `workspaceIdentity` / `remoteSessionId` 路由，不为 MCP 新建 Agent runtime；身份头只能响应给发起请求的
  已配对 Agent client；
- mobile `/remote`：只复用 desktop shared-host attachment 已有的 Agent/MCP runtime；relay 和
  desktop main 不保存 JWT、Coding Plan key 或 MCP session Status；
- desktop `continuous` 与 mobile `replayable` 的 conversation 投递语义不变。官方 MCP 鉴权是网络
  transport 能力，Not added conversation snapshot/queue Status。

远端 Agent 会在其进程内短暂持有本次请求 header，这是远端执行 HTTP MCP 的必要条件；header 不得
进入 runtime config、持久化或日志。实现时Must增加 desktop-attached remote 定向协议Tests；无法建立
真实远端环境时，应在验证记录中明确列为待补，不得把 local Tests宣称为 remote 已验证。

## 8. Fake Plugin 与Tests设计

### 8.1 目录与身份

fake Plugin 使用Tests fixture，不加入 `OFFICIAL_PLUGIN_DEFINITIONS`、SEA asset、Desktop bundle 或
remote prebuild 清单。建议目录：

```text
apps/zcode-cli/packages/bootstrap/tests/fixtures/zcode-official-http-mcp/
  .zcode-plugin/plugin.json
  .mcp.json
```

Tests通过 `officialPluginRoots` 注入该 root，并通过 adapter option 注入仅本Tests有效的 loopback
Origin。fake HTTP MCP server 监听 `127.0.0.1` 随机端口，避免固定端口冲突。

### 8.2 Case Planning

| Case ID  | Setup                                                                                               | Action                      | Assertions                                                                                                                                                        | 证据层                   |
| -------- | --------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| OMCP-001 | official fixture + 合法 auth                                                                        | 解析 Plugin                 | runtime name 为 `plugin:<name>:fake-official-search`；auth/provenance 保留                                                                                        | Adapter unit             |
| OMCP-002 | inline/third-party Plugin 复制相同 auth                                                             | 解析/连接                   | 不请求身份头，MCP fail closed                                                                                                                                     | Adapter unit             |
| OMCP-003 | official identity，但 URL Origin 与映射不符                                                         | 连接                        | `official_mcp_origin_untrusted`；网络请求次数为 0                                                                                                                 | Adapter unit             |
| OMCP-004 | official identity + 精确 loopback Origin                                                            | initialize/list/call        | fake server 三类请求均收到当前 ZCode JWT；有有效套餐凭证时同时收到 MaaS JWT 与对应 wire scope                                                                     | Adapter HTTP integration |
| OMCP-005 | BigModel Team snapshot 完整                                                                         | 发 MCP 请求                 | organization/project 成对出现                                                                                                                                     | Services + integration   |
| OMCP-006 | Team snapshot 缺任一字段                                                                            | 发 MCP 请求                 | 两个 Team header 均不存在                                                                                                                                         | Services unit            |
| OMCP-007 | Plugin 静态 header 覆盖任一保留头                                                                   | 解析                        | MCP 被禁用并产生明确 diagnostic                                                                                                                                   | Plugin unit              |
| OMCP-008 | backend 返回 3xx                                                                                    | 请求                        | 不跟随 redirect，Target Origin 未收到凭证                                                                                                                         | Adapter HTTP integration |
| OMCP-009 | JWT/套餐凭证/host auth port 缺失                                                                    | 连接                        | 身份-only Scenario仅发送 ZCode JWT；host auth port 不可用时 status 为 failed；日志不含 secret                                                                     | Adapter/Bootstrap unit   |
| OMCP-010 | 同 Plugin 两个 MCP、不同 key/origin                                                                 | 分别连接                    | 各自按映射授权，不共享或串用 identity                                                                                                                             | Bootstrap integration    |
| OMCP-011 | desktop-attached remote workspace identity（与 local 同 `workspacePath`、不同 `workspaceIdentity`） | 请求 auth                   | 响应只回到发起请求的那个 Agent client 与其 request id；同路径 local client 零调用；交错请求不串台                                                                 | Services protocol unit   |
| OMCP-012 | MCP connection pool 被多个 session 复用                                                             | 并发请求                    | 每个 HTTP 请求使用当时解析的 credential snapshot，不把首个 session 的 secret 固化进 config                                                                        | Adapter pool unit        |
| OMCP-013 | official fixture + `zcode_official`，无 `oauth` 字段、无静态 `authorization`                        | 建立连接                    | `authProvider` 为 `undefined`；未创建 OAuth session；未监听任何 localhost 回调端口                                                                                | Adapter unit             |
| OMCP-014 | 同上，fake server 对所有请求返回 401                                                                | initialize                  | 分类 `official_auth_rejected` 且 status 为 failed；`onAuthorizationRequired` / `openAuthorizationUrl` 零调用；record status 无 `authorization` 字段；未打开浏览器 | Adapter HTTP integration |
| OMCP-015 | 同上，fake server 返回 403                                                                          | initialize                  | 分类 `official_auth_forbidden`；请求次数恰为 1（不重试）                                                                                                          | Adapter HTTP integration |
| OMCP-016 | 首次 401，重解析后第二次 200                                                                        | initialize                  | 恰重试 1 次并最终成功；第二次请求携带重解析的凭证                                                                                                                 | Adapter HTTP integration |
| OMCP-017 | 持续 401                                                                                            | initialize                  | 恰重试 1 次后置 failed；请求次数恰为 2，No longer继续                                                                                                             | Adapter HTTP integration |
| OMCP-018 | `zcode_official` 与 `oauth` 同时配置                                                                | 解析 Plugin                 | `plugin_mcp_server_disabled` 并禁用，不做Priority裁决                                                                                                             | Plugin unit              |
| OMCP-019 | 普通 HTTP MCP（无 `auth`、无 `oauth`、无静态 `authorization`）                                      | 建立连接                    | 仍得到既有 authorization_code 兜底行为，回归不受官方短路影响                                                                                                      | Adapter unit             |
| OMCP-020 | 静态 `headers` 覆盖 `bigmodel-target-type` 或 `mcp-session-id`                                      | 解析                        | MCP 被禁用并产生明确 diagnostic                                                                                                                                   | Plugin unit              |
| OMCP-021 | 个人 / BigModel Team / ZAI Team 三种 credential kind                                                | 发 MCP 请求                 | wire scope 分别为 `PERSONAL` / `TEAM` / `null`；仅 `TEAM` 时 organization/project 成对出现                                                                        | Services unit            |
| OMCP-022 | 身份头注入前 header 已存在 `Authorization`                                                          | 发 MCP 请求                 | 最终请求恰有一个 `Authorization`，值为当前 JWT（覆盖而非 append）                                                                                                 | Adapter unit             |
| OMCP-023 | 已登录，但选中连接为 Start Plan                                                                     | 建立连接                    | 仅发送 ZCode JWT，不发送 MaaS JWT；记录服务端返回的登录/套餐错误分类                                                                                              | Services + Adapter unit  |
| OMCP-024 | `ZCODE_OFFPEAK_MOCK=1`                                                                              | 发 MCP 请求                 | 官方 MCP 不受该变量影响（新实现无此分支），不发送任何占位凭证                                                                                                     | Services unit            |
| OMCP-025 | 官方 MCP 全量用例执行前后                                                                           | 运行 Off-Peak 既有Tests套件 | Off-Peak 行为零变化，Tests全绿（验证 §6.1.1 的隔离）                                                                                                              | Services regression      |
| OMCP-026 | 并发发起 N 个 MCP 请求                                                                              | 并发                        | 底层凭证解析恰执行 1 次（in-flight 去重生效）；N 个请求拿到同一份 header                                                                                          | Services unit            |
| OMCP-027 | 一次解析 settle 后再发请求                                                                          | 顺序两次                    | 第二次重新完整解析（无时间维度缓存）；切换 Coding Plan connection 后第二次拿到新 header                                                                           | Services unit            |

本阶段没有 UI 行为，Not added WebdriverIO/UI E2E，也Not modified conversation session case catalog 或 coverage
matrix。核心证据应放在 contracts schema、Plugin parser、MCP adapter、Bootstrap 和 services protocol 的
unit/integration tests。

## 9. Impact Brief

### 9.1 must-inspect

| 关系          | 改动面                                                                                                                                   | Cause                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 配置合同      | `contracts/interfaces/mcp.port.ts`、Plugin MCP parser                                                                                    | `auth` Must从文件配置进入 runtime，且只允许 HTTP                                                             |
| 请求出口      | `adapters/src/mcp/index.ts`、`network.ts`                                                                                                | 所有 Streamable HTTP MCP 请求Must在唯一出口动态注入并校验 redirect                                           |
| OAuth 隔离    | `adapters/src/mcp/index.ts` 的 `resolveAuthorizationCodeOAuthConfig`、`createAuthorizationCodeOAuthOptions`、`adapters/src/mcp/oauth.ts` | `zcode_official` Must短路隐式 authorization_code 兜底并自行处理 401/403；同时不得影响普通 MCP 的既有兜底行为 |
| 官方身份      | `bootstrap/official-plugin-definitions.ts`、Plugin discovery                                                                             | Origin 映射和 bundled official provenance 是授权前提                                                         |
| 身份权威      | 新增 official MCP credential resolver（如 `services/official-mcp/`）、services 装配                                                      | JWT、Plan key、Team context Must来自同一当前 snapshot；独立于 Off-Peak 实现（§6.1.1）                        |
| Off-Peak 隔离 | `services/session/offPeakRuntimeModel.ts` 及其调用方                                                                                     | 本阶段**只读参考**，不得修改导出、签名或行为；Off-Peak 既有TestsMust全绿                                     |
| 跨进程协议    | shared zcode protocol、bootstrap protocol server、zcodeAgentService                                                                      | Agent 不持有身份权威，且实现不能依赖 UI 响应                                                                 |
| pool 隔离     | MCP connection pool                                                                                                                      | 共享连接不能把首个 session/workspace 的凭证固化或串给后续请求                                                |

### 9.2 should-inspect

- `mcp/list` control-plane 与 session runtime 共用 adapter；官方鉴权缺失时均应返回一致 failed Status，
  不能设置页探测匿名、session runtime 却带鉴权；
- Plugin cache/official root 可被本地文件修改，因此只有 Bootstrap 硬编码 Origin mapping 能作为 endpoint
  信任事实；
- HTTP proxy、自定义 CA、No Proxy 继续由 `createMcpTransportFetch` 生效，官方 auth wrapper 只能包裹
  它，不能绕过现有网络策略。

### 9.3 invariant-only

- Not modified `packages/ui`；
- Not modified Off-Peak 任何现有Code路径（`offPeakRuntimeModel.ts` 等）；官方 MCP 为独立实现（§6.1.1）；
- Not changed普通 HTTP/SSE MCP 的 headers/OAuth 行为；
- Not changed stdio MCP、`node_repl`、MCP 版本协商和 tool `_meta`；
- 不把鉴权Status下沉到 relay、desktop main、conversation snapshot 或 session persistence；
- Not added `serverId` / `capabilityId`，也不按 URL path、tool name 或模型输出推断官方身份。

### 9.4 建议的 feature graph delta

后续进入实现时，可新增 `capability.zcode-official-server-mcp-auth`，关联：

```text
official Plugin definition
  -> plugin MCP parser
  -> trusted Origin registry
  -> MCP HTTP transport
  -> host Coding Plan credential resolver
  -> private Agent protocol bridge
```

本次只写 spec，不直接修改 feature graph。

## 10. 实现顺序

Must遵循 tests first：

1. 先补 contracts/parser 的失败与成功Tests；
2. 再补 trusted Origin、保留 header、redirect 的 adapter Tests；
3. 再补 OAuth 短路与 401/403/3xx 分类的 adapter Tests（OMCP-013 ~ OMCP-019、OMCP-022）；
4. 再补 host Coding Plan header resolver 和 Agent protocol Tests（含 `Bigmodel-Target-Type` 与
   mock 隔离，OMCP-021 / OMCP-024 / OMCP-025）；
5. 再加入 fake Plugin + fake HTTP MCP integration test；
6. 最后实现 contracts、parser、Bootstrap registry、protocol bridge、service resolver 和动态 fetch；
7. 运行定向Tests后执行 `pnpm typecheck` 与 `pnpm lint`。

## 11. Acceptance标准

- 官方 Plugin 的 HTTP MCP 能通过 `.mcp.json` 的 per-MCP `auth` 声明启用
  `zcode_official/jwt_token`；
- 正确官方 identity 但错误 Origin、正确 Origin 但第三方 Plugin、复制 auth 字段、跨 Origin redirect
  四种情况都不会发出任何敏感 header；
- MCP `initialize`、`tools/list`、`tools/call` 均携带当前 ZCode JWT（`Authorization`）；仅在
  Registry 存在有效 Coding Plan Provider 且当前 family 的 MaaS JWT 可用时携带
  `X-Bigmodel-Authorization`，并仅在存在对应 `wireScope` 时携带 `Bigmodel-Target-Type`。
  `TEAM` wire scope 时 organization/project Must成对出现；
- `zcode_official` MCP 不创建 OAuth session、不占用 localhost 回调端口，`authProvider` 为
  `undefined`；后端 401/403 时按 §6.3.3 分类为 failed，`onAuthorizationRequired` /
  `openAuthorizationUrl` 零调用，record status 不含 `authorization` 字段；
- 401 最多重试一次，持续 401 时请求次数恰为 2 且No longer继续；
- Start Plan、API Key 模式及 Registry 缺少有效 Coding Plan Provider 的官方 MCP 归类为
  `official_auth_plan_required`，`initialize` / `tools/list` / `tools/call` 的连接与发现请求仅
  发送 ZCode JWT（不发送 MaaS JWT 或 target/scope 头），与 `official_auth_unavailable` 可区分；
- 切换登录身份或 Coding Plan connection 后，后续请求不复用旧 header；
- fake Plugin 只存在于Tests fixture，不进入正式 bundled assets；
- 普通 MCP、OAuth MCP、stdio MCP 和现有 proxy/CA 行为回归通过，隐式 authorization_code 兜底对
  非 `zcode_official` 的 MCP Remains unchanged；
- 无任何 `packages/ui` 改动；
- `pnpm typecheck`、`pnpm lint` 通过。

## 12. 对后端的接口Conventions

后端实现不在本阶段Scope内（后续单独开发）。本节固定客户端**已确定会发出什么**、**如何解读响应**，
使后端可以据此实现而无需回头改客户端。客户端侧按本节实现即可推进，不阻塞。

### 12.1 Requests Sent by Client（已确定）

对每个可信官方 MCP 的每个 HTTP 请求：

| Header                     | 取值                                    | 条件                                                                                                         |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Authorization`            | `Bearer <zcode-jwt>`                    | 始终                                                                                                         |
| `X-Bigmodel-Authorization` | `Bearer <当前 family 的 MaaS 登录 JWT>` | 仅在 Registry 存在有效 Coding Plan Provider 且 MaaS JWT 可用时发送（2026-08 起替代 `X-Coding-Plan-Api-Key`） |
| `Bigmodel-Target-Type`     | `PERSONAL` \| `TEAM`                    | 仅在存在对应 wire scope 时发送；无 scope 时省略                                                              |
| `Bigmodel-Organization`    | organizationId                          | 仅 `TEAM`，与 project 成对                                                                                   |
| `Bigmodel-Project`         | projectId                               | 仅 `TEAM`，与 organization 成对                                                                              |

同时携带现有统一来源头（`User-Agent`、`X-Platform` 等），语义与其它 ZCode 业务接口一致，无新增
字段。**链路 id 例外**：`X-Request-Id` / `X-Trace-Id` 不发送，只从响应头读回，理由与口径见 §5.2
末条。传输为 Streamable HTTP MCP 协议，body 由 MCP SDK 生成。

凭证通道已于 2026-08 切换：满足上表条件时客户端只发 `X-Bigmodel-Authorization`（MaaS 登录
JWT），**No longer发送** `X-Coding-Plan-Api-Key`；identity-only 请求则只发 `Authorization`。Cause与
"为什么不能两个头都发"见 §6.1。
第一阶段那条"待后端确认是否Must使用 MaaS JWT 通道"的开放Field由此闭环。

### 12.2 Client Interpretation of Responses（已确定）

后端只需保证语义落在下表内即可；客户端不依赖具体业务码Label：

| 响应                         | Client Behavior                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| 2xx                          | 正常处理 MCP 协议响应                                                                       |
| 401                          | 凭证无效/过期。按 §6.3.3 最多重解析重试一次，随后 failed。**不会**触发 OAuth 授权流程       |
| 403                          | 身份有效但无权限/套餐不足。不重试，直接 failed                                              |
| 3xx                          | 不跟随（`redirect: "manual"`），直接 failed。正式 endpoint 需配置为 canonical URL，避免依赖 |
| 尾斜杠或大小写归一化的重定向 |
| 405（GET 流）                | 视为"不支持服务端推流"，属正常情况，不报错                                                  |

因此后端**should not**依赖 `WWW-Authenticate` 触发客户端 OAuth discovery——官方 MCP 路径已显式关闭该
能力（§6.3.1）。鉴权失败请用 401/403 表达。

客户端侧的请求约束，供后端了解流量特征：官方 MCP 为 Coding Plan 专属权益（§3.2）。Start Plan
用户与无 Coding Plan 连接的用户在连接/发现阶段仍可能到达后端，但只携带非空 ZCode JWT，不携带
`X-Bigmodel-Authorization`；选中Field仍指向 Coding Plan、但无权益 Provider 已从 Registry 移除时也遵循
同一规则。后端应据此区分已登录与未登录，并执行自身的套餐校验。客户端判定依据是"选中的连接
Form + 当前 Registry 是否仍有可用 Provider"，而不是 MaaS JWT 或业务 key 是否存在；只有 Registry
中存在有效 Coding Plan Provider 时，MaaS JWT 缺失才Means登录态不完整（2026-08 起业务 key No longer是
凭证，也No longer作门槛）。

### 12.3 Values Required from Backend/Publishing Side

已确认（`zcode-server`，2026-08 实测）：

1. **端点与路由**：`POST /api/v1/mcp/server/:mcp_group`（`internal/interfaces/web/router.go`）。
   两条Hard Constraints：`:mcp_group` **必填**（只写 `/api/v1/mcp/server/` 返回 404），且 **不能带尾斜杠**
   （`…/image_search/` 返回 307，客户端 `redirect: "manual"` 会判为
   `official_auth_redirect_blocked`，报错Cause与真实成因不相关）；
2. **鉴权中间件**：**复用** `requireAuth` + `WithCodingPlan`，与 off-peak 一致，§6.1 的 5 个头
   契约成立；
3. **group 清单**：目前仅 `image_search`（`internal/domain/servermcp/service.go` 的
   `MCPGroupTools`），暴露工具 `search_image`。每个 group 是独立端点，客户端侧对应独立 MCP 条目；
4. **无 session**：handler 用 `StreamableHTTPOptions{Stateless: true}`，**不下发**
   `Mcp-Session-Id`。因此真实端点下 session id 为空属Expected；只有 fake server 会下发。

Still Pending Backend Confirmation：

1. ~~§12.1 末尾的 `X-Bigmodel-Authorization` 取舍~~ —— **已闭环（2026-08）**：后端确认 API Key
   通道仅存量兼容，官方 MCP 在套餐凭证可用时改为只发 `X-Bigmodel-Authorization` + MaaS 登录 JWT
   （§6.1）；identity-only 请求只发 `Authorization`；
2. 新 group 上线时的通知机制——每个 group 一个端点，Means新增 group 仍需改 `.mcp.json`，
   与"新增官方 MCP 零改动"的Target存在张力（见下段部署约束）。

canonical HTTPS Origin **No longer是待锁定Field**：官方 MCP Must与 ZCode API 同 origin，客户端运行时
解析（§5.1）。若后端要把官方 MCP 部署到独立域名，则Needs/Requires回到显式清单并承担发版摩擦——
这是一条Needs/Requires提前对齐的部署约束。

以上未确定时，客户端可完成 fake fixture 与全部依赖注入Tests（本地自测经 loopback dev 开关）。

## 13. Implementation Locations

客户端侧已按本 spec 实现。文件与职责对应关系：

| 职责                                                    | 文件                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 头集合 / 保留头黑名单（两侧同源，§5.2）                 | `packages/shared/src/official-mcp-auth.ts`                                                                               |
| Agent 协议 schema（§7.2）                               | `packages/shared/src/zcode-protocol/index.ts`                                                                            |
| 凭证解析 + 身份头构造 + in-flight 去重（§6.1 / §6.2.1） | `packages/services/src/official-mcp/officialMcpCredentials.ts`                                                           |
| host 侧反向请求处理（§7.2）                             | `packages/services/src/zcode-agent/zcodeAgentService.ts`                                                                 |
| 装配（host 为唯一身份权威）                             | `packages/services/src/node.ts`                                                                                          |
| 配置合同与端口类型（§4.2 / §7.1）                       | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`                                                           |
| Plugin 严格解析 + provenance（§4.2）                    | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts`                                                                    |
| 动态注入 + Origin 校验 + 失败分类（§6.3.2 / §6.3.3）    | `apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts`                                                              |
| OAuth 短路（§6.3.1）                                    | `apps/zcode-cli/packages/adapters/src/mcp/index.ts` 的 `resolveAuthorizationCodeOAuthConfig` / `createOfficialAuthFetch` |
| 可信 Origin registry（§5.1）                            | `packages/shared/src/official-mcp-auth.ts`                                                                               |
| Agent 侧 auth port（§7.1）                              | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts`                                         |
| 运行时装配                                              | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`                                                     |

Test Case Locations：`plugin-official-mcp-auth.test.ts`（解析）、`packages/shared/test/officialMcpTrust.test.ts`（信任）、
`mcp-official-auth.test.ts`（注入与分类）、`mcp-official-auth-integration.test.ts`（fake 端到端）、
`officialMcpCredentials.test.ts`（凭证）、`officialMcpAuthProtocol.test.ts`（协议 schema）、
`officialMcpAuthRemoteRouting.test.ts`（desktop-attached remote 路由）、
`official-mcp-auth-port.test.ts`（端口→协议参数构造，含同路径不同 identity 的可区分性）。
共 87 个用例，OMCP-001 ~ OMCP-027 均有对应断言（OMCP-025 为 Off-Peak 回归Action，Command记录在
`officialMcpCredentials.test.ts` 头注释）。

### 13.1 Three Facts Clarified During Implementation

1. **§6.3.4 的 GET 探测已实测固化**：SDK 在 `notifications/initialized` 收到 202 后会发起
   **恰好一次** GET，服务端 405 后安全放弃且连接保持 connected。该数字由
   `mcp-official-auth-integration.test.ts` 断言锁定，避免后续误以为"客户端完全不发 GET"。
2. **保留头黑名单只在官方鉴权路径生效**：普通/第三方 HTTP MCP 静态携带 `authorization`
   是既有合法用法（`resolveAuthorizationCodeOAuthConfig` 正依赖它退出 OAuth 兜底），
   全局拦截会造成回归。OMCP-019 锁定该Boundaries。
3. **失败分类不能从 error 对象读**：SDK 的 version negotiation 会把 `OfficialMcpAuthError`
   重新包装成普通 `Error`（message 前缀 `Version negotiation probe failed: `，对象身份丢失），
   因此 `instanceof` 在 `failConnection` 处不可靠；按错误文本反解又违反"不依赖错误文本做流程判断"。
   最终在**抛出点**经 `onAuthFailure` 上报分类，adapter 用 per-server 暂存槽在
   `failConnection` 取用后立即清除，并在每次 connect 开始时清空以免串台。
   §6.3.3 的分类由此可在生产日志按 `officialAuthKind` 字段检索。

### 13.2 Real-device Verification Record（2026-08-16）

在本机 desktop（`pnpm dev:desktop`）+ 本地 fake 官方 MCP（`scripts/dev-official-mcp-server.mjs`）

- 真实登录身份与个人 Coding Plan 下验证通过：agent 日志出现 `mcp.server.connected`
  （`plugin:dev-official-mcp:dev-search`），零 `mcp.server.failed`、零 `official MCP` 鉴权失败，
  fake server 收到 `initialize` / `tools/list` 并携带完整身份头，GET 推流探测被 405 安全放弃。

自测所需的两Field本地设施：

- `scripts/dev-official-mcp-server.mjs`——loopback fake MCP，打印每个请求的鉴权头
  （JWT 与 Coding Plan key 脱敏，`Bigmodel-Target-Type` / organization / project 原样显示）；
- `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`——本地 dev 开关，**只**接受 http loopback
  （`normalizeTrustedOrigin` 的 `"loopback"` 模式会拒绝 https 与非 loopback 主机，
  避免一个环境变量就把真实 JWT 导向远端）。不设置时行为与实现前完全一致。

Self-testing Pitfall Record（供后续复现时省时间）：

- 本地 plugin 经 `~/.zcode/cli/config.json` 的 `plugins.dirs` 加载，**不是**
  `~/.zcode/v2/config.json`（后者是 desktop/services 配置），也不是设置页的「添加 marketplace」
  （那个入口要 marketplace 目录）；
- 经 `dirs` 加载的 plugin marketplace 固定为 `inline`，故 pluginId 形如
  `dev-official-mcp@inline`。该后缀**does not affect授权**（§5.1 移除了 marketplace 检查），
  本地自测能否通过只取决于 Origin：https 端点需等于当前 ZCode API origin，
  http loopback 需列入 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`；
- MCP 连接在 session 建立时一次性发起，失败后停留在 failed 不自动重连；Must**先起 fake server
  再启动 desktop**。desktop 的 MCP Status展示存在刷新滞后（重启后才与 agent 实际Status一致），
  属既有行为，不在本阶段Scope（§9.3 Not changed `packages/ui`）。

### 13.2.1 设置页Status刷新时机（既有行为，非本次引入）

Discovered During Self-testing"agent 已 connected、设置页仍显示旧Status，重启才正常"。查明是既有刷新机制与官方 MCP
特性叠加的结果，**不在本阶段修**（§9.3 invariant-only：Not changed `packages/ui`），此处记录供后续立Field。

`McpSettingsSection.tsx` 只有三个刷新Trigger Source：

| Trigger Source                | 条件                                                                                                                                                                                                                   | 对官方 MCP                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| key 变化自动刷新              | `autoStatusListRefreshKey` 变化才刷（`transitionMcpAutoStatusListRefreshKey` 的 `previousKey !== nextKey`）。该 key = workspaceIdentity + workspacePath + `serverStatusListKey`，而后者由 **servers/plugins 列表**算出 | ❌ 连接Status变化Not changed列表，key 不变 |
| 1 秒轮询                      | 需存在待授权 OAuth server（`pendingMcpOAuthAuthorizationRefreshKey` 非空），上限 5 分钟                                                                                                                                | ❌ 官方鉴权按 §6.3.1 无 `authorizationUrl` |
| 窗口 focus / visibilitychange | 同样被 `pendingMcpOAuthAuthorizationRefreshKey` 门控                                                                                                                                                                   | ❌ 同上                                    |

即：**没有面向"连接Status变化"的订阅，也没有非 OAuth server 的定时刷新**。官方 MCP 三条路全不通。

**实测Conclusion（2026-08-16，纠正早期推断）**：关闭 fake server 后，切换设置 tab、切换 workspace、
**开关 plugin** 三者都不会让Status转为失败。开关 plugin 时设置页链路确实被取用
（出现 `sess=-` 的 `protocol-settings` lease 取/放），但**未产生任何 dev-search 探测事件**，
因此显示的仍是旧快照。日志证据——13:55 之后
所有 MCP 事件都带 `sessionId` 且 `mcpIsolation: session`，没有一条来自设置页的
`protocol-settings` lease：

```text
13:50:27  mcp.server.connected  sess_fb0c0db  session   （服务在）
13:55:36  mcp.server.failed     sess_8517a98  session   （服务已关）
13:55:36  mcp.server.failed     sess_95448b8  session
13:55:37  mcp.server.failed     sess_72bae46  session
13:55:37 ~ 13:59 切 workspace / 切设置 tab → 零条新事件
```

Cause是 `serverStatusListKey` 只由 servers/plugins **列表**算出，连接Status变化Not changed这个 key；
设置页切 tab 时组件保持挂载，`lastAutoStatusListRefreshKeyRef` 不重置，因此
`transitionMcpAutoStatusListRefreshKey` 返回 `shouldRefresh: false`。
**重启 app 是当前唯一可靠重建该 store 的方式。**

Needs Differentiation的两条链路：设置页走 entrypoint 的 `protocol-settings` lease，session 走各自的
session lease；两者共用连接池但Status互不回灌。因此"session 侧已知失败"不会反映到设置页。

另外确认：`mcp/list` 默认（connect）模式**会真正重连**（`bootstrap/src/zcode-protocol/mcp.ts`
调用 `connectConfiguredServers`），并非只读缓存。所以Problem不是"读到旧缓存"，而是"没人去读"。

Plugin 列表同理：`pluginManagementStore.initialize` 按 workspace 在 `useEffect` 调用，
`refresh()` 只在启用/禁用/安装/卸载等变更后主动触发，无定时器。因此手工编辑
`~/.zcode/cli/config.json` 的 `plugins.dirs` 后，UI 不会自行发现。

Limited Impact on Regular MCP（有 OAuth 的走轮询；无 OAuth 的通常连接够快，在首次挂载前后就已完成），
但官方 MCP 的连接是 session 级按需发起、时间上常晚于设置页挂载，因此必然看到旧Status。
Future Fix Direction：给 `serverStatusListKey` 之外增加连接Status变化订阅，或为非 OAuth server 开低频轮询。
两者都属 UI 层改动，应单独立Field。

### 13.2.2 Local Fault Injection for Error Paths

`scripts/dev-official-mcp-server.mjs` 支持注入故障，用于验证 §6.3.3 的分类。两个参数：
`--mode ok|401|403|redirect|tool-quota`、`--fail-on all|initialize|tools/call`。

| Scenario           | Command                           | Expected                                                                                 |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| 连接时无额度       | `--mode 403 --fail-on initialize` | `officialAuthKind=official_auth_forbidden`，MCP failed，注入日志**仅一次**（403 不重试） |
| 连上后调用撞 403   | `--mode 403 --fail-on tools/call` | MCP 保持 connected、工具已挂载；仅该次 tool call 失败                                    |
| tool call 额度耗尽 | `--mode tool-quota`               | HTTP 200 + `isError: true` 业务错误；MCP 保持 connected                                  |
| 凭证被拒           | `--mode 401`                      | `official_auth_rejected`；注入日志**恰好两次**（1 原始 + 1 重试），超过即为自旋缺陷      |
| 重定向劫持         | `--mode redirect`                 | `official_auth_redirect_blocked`；Target Origin 收不到任何请求                           |

**Key Distinction**：`--fail-on tools/call` 与 `tool-quota` 都**不会**产生 `officialAuthKind`——前者发生在连接
建立之后的单次调用上，后者根本不是鉴权Problem。MCP 业务错误走 in-band `isError` 而非 HTTP Status码，
因此"额度耗尽"should not让连接断开。这是设计Expected，不是漏报。

一个**不Needs/Requires服务端**的 fail-closed Scenario（验证"拒绝时不泄露凭证"，比服务端故障更重要）：

- `official_mcp_origin_untrusted`：不设 `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` 启动，同样零请求。

统一判读：`grep '"officialAuthKind"' ~/.zcode/cli/log/zcode-<日期>.jsonl`。
Note连接时故障需重启 desktop 才会重连（§13.2.1 的刷新盲区），tool-call 时故障不Needs/Requires。

### 13.3 已知未接通Field

- ~~正式 `OFFICIAL_PLUGIN_DEFINITIONS` 尚未登记任何 `trustedMcpOrigins`~~：该机制已随 §5.1
  的决策变更删除。registry No longer持有映射表，判定改为"Target origin 等于运行时解析的 ZCode API
  origin"，因此不存在"待填入 Origin"这一步；未解析出 origin 时仍 fail closed
  （`zcode_origin_unresolved`）；
- desktop-attached remote 的**定向协议Tests已补**（`officialMcpAuthRemoteRouting.test.ts`，
  OMCP-011）：覆盖"同 `workspacePath`、不同 `workspaceIdentity`"两条独立链路的响应路由、
  交错请求不串台、plan-required 原样透传、无 resolver 时 `official_auth_unavailable`、
  以及畸形参数走 `respondError` 且不触发凭证解析。
  **剩余风险**：该Tests在 service 层以假 Agent client 验证路由与响应通道，未在真实
  SSH/WSL/Docker 环境跑通完整链路。真实远端的进程启动、传输与网络出口仍未验证，
  按 §7.4 的要求在此明确保留，不宣称"真实远端已验证"。
