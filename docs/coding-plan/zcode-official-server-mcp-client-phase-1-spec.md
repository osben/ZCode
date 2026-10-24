# ZCode Official Server MCP Client Integration (Phase 1, Historical Decision Log)

> Current implementation facts are consolidated in `zcode-official-server-mcp-auth-spec.md`. This document preserves the phase 1 design and the evolution of decisions; it is no longer the direct implementation reference for current authentication headers, scope, quotas or UI behavior.

Date: 2026-08-14 (implementation completed 2026-08-15)
Status: Implemented (client side; backend pending, see §12)
Scope: ZCode client/Agent runtime; no UI or official MCP backend changes; no fake capabilities in the production release directory.

## 1. Target

Phase 1 lets ZCode load remote Streamable HTTP MCP servers from official Plugins and inject the current user's Coding Plan identity headers for trusted official Origins before each actual HTTP request. Capabilities:

1. An individual HTTP MCP in a Plugin can declare `zcode_official`.
2. The `jwt_token` provider uses the current ZCode user JWT as a Bearer token; it appends `X-Bigmodel-Authorization` only when the Registry contains a valid Coding Plan Provider and a MaaS JWT is available, and adds `Bigmodel-Target-Type` and the Team organization/project according to the corresponding `wireScope` (§6.1; identity-only exception).
3. The MCP transport may obtain and inject identity headers only when the target Origin matches the current ZCode API origin. Originally the official Plugin identity, its MCP key and the exact Origin all had to match the host's trusted mapping; in 2026-08 this narrowed to Origin validation alone (§5.1).
4. A test-only fake official Plugin and fake HTTP MCP server cover Plugin parsing, trust decisions and the actual request headers for `initialize` / `tools/list` / `tools/call`.
5. No UI pages, components, stores, labels, i18n or settings fields are added or modified.

`serverId` and `capabilityId` are out of scope. The key under a Plugin's `mcpServers` is that Plugin's MCP identity; the runtime keeps the namespace `plugin:<pluginName>:<mcpKey>` to prevent cross-Plugin name collisions.

## 2. Code facts at design time

| Fact | Location | Phase 1 conclusion |
| --- | --- | --- |
| MCP runtime config supports `stdio`, `http`, `sse`; HTTP supports only `headers` / `oauth` | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts` | Extend only the official-auth declaration in the HTTP config; no new transport |
| The Plugin loader projects the `.mcp.json` key to `plugin:<pluginName>:<mcpKey>` but discards unknown `auth` fields | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` | Strictly parse `zcode_official` at the Plugin parsing boundary and preserve host-generated provenance |
| Streamable HTTP sends requests through `createMcpTransportFetch(...)`; static headers go into `requestInit` | `adapters/src/mcp/index.ts`, `network.ts` | Sensitive identity headers are injected by a dynamic fetch wrapper, never written back to config or kept in `requestInit` |
| An `http`/`sse` MCP with no `oauth` and no static `authorization` header defaults to `{type:"authorization_code"}`, creating an OAuth session, a localhost callback server and an `authProvider` | `resolveAuthorizationCodeOAuthConfig` / `hasAuthorizationHeader` in `adapters/src/mcp/index.ts` | `zcode_official` must explicitly exit this default (§6.3). Static `authorization` is prohibited and `oauth` omitted, so without an explicit opt-out official MCP would fall into implicit OAuth |
| With `authProvider` the SDK turns 401/403 into an OAuth reauthorization flow and writes the URL to MCP record status via `onAuthorizationRequired` | SDK `streamableHttp` 401/403 branch; `redirectToAuthorization` in `adapters/src/mcp/oauth.ts`; `createAuthorizationCodeOAuthOptions` | Conflicts with UI-less automatic auth. `zcode_official` needs its own 401/403 semantics (§6.3) and must not trigger an authorization URL or browser |
| In the SDK's request assembly `requestInit.headers` takes precedence over `authProvider`'s `Authorization` and can override `mcp-session-id` / `mcp-protocol-version` | SDK `_commonHeaders()` | The reserved-header denylist includes protocol headers, and identity headers are injected as the final step in the fetch wrapper (§6.3) |
| JWT, API key and Team organization/project of the selected Coding Plan already resolve into one credential snapshot | `packages/services/src/session/offPeakRuntimeModel.ts` | Logical reference only; do not reuse or modify (§6.1.1) |
| The Bootstrap manifest manages built-in identity, version and bundle root of official Plugins | `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | Does not participate in official MCP authorization (the mapping was removed in §5.1); a Plugin-declared URL stays untrusted but validation uses the runtime-resolved ZCode API origin |

## 3. Scope and non-goals

### 3.1 In scope

- `http` / Streamable HTTP MCP; per-MCP auth declaration in official Plugins.
- Resolving the current Coding Plan identity in the client host/service.
- Automatic authentication request/response in the Agent protocol, without UI.
- Dynamic header injection and Origin validation in the MCP HTTP transport.
- Targeted adapter/bootstrap/service tests using a fake Plugin and fake HTTP MCP.

### 3.2 Out of scope

- `zcode_official` for `stdio` and `sse` (stdio was later added in Phase 2).
- Tool-call entitlement for Start Plan users. Official Server MCP tool calls remain exclusive to Coding Plan users; Start Plan has only a ZCode JWT. API Key mode and a Registry with no valid Coding Plan Provider use the same identity-only semantics: connection/discovery requests carry only the ZCode JWT, not the MaaS JWT, so the server can distinguish sign-in-state errors from plan-state errors (`1006` / `3101`).
- Official MCP backend tool implementation, billing, rate limiting, business API design; `/api/v1/client/configs` rollout (Phase 1 preserves existing rollout behavior).
- UI changes to MCP settings, Plugin settings, status display, sign-in guidance.
- New usage-record or capabilities endpoints (already implemented by the backend; §12.3).
- Short-lived token issuance: `jwt_token` uses the existing user JWT.
- Shipping the fake MCP in the official installer.

## 4. Plugin configuration contract

### 4.1 `.mcp.json` example

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

| Field | Semantics |
| --- | --- |
| `mcpServers.fake-official-search` | MCP key within the Plugin; used only to associate credential resolution and logs (not authorization, §5.1); no duplicate `serverId` |
| `type: "http"` | Existing Streamable HTTP MCP client |
| `url` | MCP endpoint; may use existing Plugin template resolution, but the resolved value must also pass Origin validation |
| `auth.type` | Exact value `zcode_official` (case-sensitive); aliases and case variants such as `zcode-official_auth`, `zcode-official`, `zcode_official_auth` are rejected |
| `auth.provider` | Only `jwt_token` in Phase 1; short-lived tokens later add a provider rather than changing this value |
| `timeoutMs` | Reuses the existing MCP protocol request timeout |

`auth` goes on the individual MCP definition, not the top level of `plugin.json`: a Plugin may contain several MCPs with different URLs or auth methods, and a Plugin-level declaration would broaden credential injection.

### 4.2 Types and constraints

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

- `auth` is allowed only with `type: "http"`; on stdio/sse the Plugin loader reports `plugin_mcp_server_disabled` and disables the MCP. Revised in Phase 2: stdio can also declare `zcode_official` and delivers identity headers through `_meta` (see `zcode-official-server-mcp-stdio-meta-phase-2-spec.md`); `sse` is still rejected.
- The same MCP must not configure both `oauth` and `zcode_official`; the loader reports `plugin_mcp_server_disabled` and disables it without a priority decision.
- When `zcode_official` matches, the implicit OAuth fallback is explicitly disabled: `authProvider` is `undefined`, no OAuth session and no localhost callback server. Omitting `oauth` alone is not enough (§2, §6.3).
- The `auth` string alone does not establish official identity. The loader still generates runtime provenance `.mcp.json` cannot control (`pluginId`, original `mcpKey`, `source`) to associate logs and credential resolution, but it has not participated in trust decisions since 2026-08 (§5.1).
- Consequently a third-party Plugin that copies the same `auth` field and points its URL at the ZCode API origin can obtain identity headers. This is an intentional consequence of removing the marketplace check: credentials flow only to the real ZCode backend, so the risk is abuse rather than exfiltration, with server-side entitlement/quota checks as the safeguard (residual risk 1 in §5.1).

## 5. Trust model and Origin mapping

### 5.1 Authoritative rule

Trust validation lives in `packages/shared/src/official-mcp-auth.ts` (`isOfficialMcpOriginTrusted` / `createOfficialMcpTrustedOriginRegistry`). The rule (changed twice; this is the current version):

```text
Target origin === current ZCode API origin (https)
```

Why `pluginId` no longer has to come from the official marketplace (2026-08 decision): the check (`pluginId` ends in `@zcode-plugins-official`) was removed because (1) it prevented testing official Plugins before release (a local Plugin has an ID like `official-tools@inline` and never gets the official suffix; the dev loopback switch allows only HTTP loopback, so testing against the real HTTPS endpoint required publishing first, a deadlock), and (2) other controls already cover the scenario it defended against: a third-party Plugin could also ship a hook/command, which is arbitrary code run as the user that can read the same credentials under `~/.zcode`.

Why no per-`mcpKey` allowlist: official Plugins can be updated out of band; an `mcpKey` list would block a new MCP until the next client release while giving almost no protection against local tampering (names are constants). So `OfficialPluginDefinition` no longer declares `trustedMcpOrigins`, and there is no canonical-domain table.

Why resolve the domain at runtime: the ZCode API origin varies by environment (production/test/self-hosted); hard-coding production would fail closed everywhere else. Resolution matches background tasks: host `resolveCurrentZCodeEndpointOrigin` (including settings overrides), CLI `resolveRuntimeZCodeEndpointOrigin(env)`.

Why trusting this Origin does not broaden the trust boundary: the same Origin already receives the same credentials (background tasks send `authorization` + `x-coding-plan-api-key` via `offPeakServerClient`; Coding Plan reset/usage send `authorization` + `x-bigmodel-authorization`, which official MCP has used since 2026-08, §6.1). It is an equivalence argument, not "official so trusted".

Why in shared rather than CLI bootstrap: two consumers in packages that cannot see each other need a single source: the MCP adapter (before sending) and host/services (second validation at the identity-authority boundary, depending only on `@zcode/shared`). The CLI-side file only forwards.

| Control | Prevents |
| --- | --- |
| Origin matches (https, no username/password) | Credentials sent to an attacker-controlled server (the only load-bearing control) |

Because only one control remains it must stay strict: HTTPS required, URLs containing credentials rejected, exact character-for-character match with the runtime-resolved value.

Known and accepted residual risks:

1. Any Plugin can declare official authentication (introduced by removing the marketplace check). Credentials flow only to the real ZCode backend, so not exfiltration, but abuse is possible (consume quota as the user, trigger side-effect endpoints). Mitigation is server-side: official MCP endpoints use `requireAuth` + `WithCodingPlan` and check entitlement and quota on every call.
2. A local attacker who can write the official Plugin cache directory can add an MCP to an official Plugin and receive injected credentials (abuse, not exfiltration; a per-`mcpKey` allowlist would not help).
3. Validation constrains which requests are approved, not what the Agent does with the bytes. After the host returns identity headers, a compromised Agent (especially a desktop-attached remote) can use them elsewhere. A complete solution has the host send the request so credentials never leave the host; out of scope. The design is defense in depth (against Agent-side bugs and code bypassing the wrapper). Also correcting an earlier inference (SG-03): targetOrigin validation cannot stop a requester that knows the Origin (the Agent knows it via `ZCODE_BASE_URL`; a Plugin can specify it); it only pins the credential flow to the ZCode Origin.
4. No user-visible authorization confirmation: a Plugin can declare official auth and the host issues identity headers silently. A one-time confirmation would tighten this (see the end of `isOfficialMcpOriginTrusted`) but needs a product decision and is not implemented.
5. Auditing covers only the first issuance: the host logs an info-level `official MCP identity headers resolved` (`firstIssuance: true`) on the first issuance of each (pluginId, mcpKey, workspaceKey) tuple per process; later requests stay at debug. This answers "which Plugin obtained credentials", not "how many times"; info-logging every issuance would grow logs at message scale.

If tighter controls are needed later: do not restore the marketplace-suffix check (it recreates the deadlock). Keep an explicit dev bypass or require a user-visible one-time authorization confirmation when a Plugin declares official auth.

### 5.2 Security rules

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

There is no "official marketplace Plugin?" or "(pluginId, mcpKey) matches a trusted mapping?" check; `pluginId` / `mcpKey` still travel with the request but only associate logs and credential resolution. Validation inputs differ for stdio (no URL; the client resolves targetOrigin itself): see Phase 2 spec §5.

- Production validation allows only `https:` and rejects usernames/passwords in URLs.
- Unit/integration tests add `http://127.0.0.1:<ephemeral-port>` through dependency injection; local testing registers loopback Origins via `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`. Neither may allow non-loopback hosts.
- Authenticated fetch uses `redirect: "manual"`; any 3xx fails immediately so a Bearer token is never sent through a cross-Origin redirect. Production endpoints use a canonical URL.
- Static Plugin `headers` must not contain (case-insensitively) any reserved header: `authorization`, `x-coding-plan-api-key`, `x-bigmodel-authorization`, `bigmodel-target-type`, `bigmodel-organization`, `bigmodel-project`, and the protocol headers `mcp-session-id`, `mcp-protocol-version`; the MCP is disabled during parsing rather than silently overridden. Protocol headers are on the list because `requestInit.headers` outranks them in SDK assembly.
- The denylist and the headers actually injected in §6.1 share one source: constants in `packages/shared`, referenced by both the Plugin parser and the MCP adapter. The denylist is enforced again at the fetch-wrapper merge point (§6.3.2), not only at parsing.
- Logs record only `pluginId`, `mcpKey`, Origin, failure classification, HTTP status and request/trace IDs; never JWTs, Coding Plan keys, complete request headers or credential fingerprints.
- Server request-ID correlation: the client does not send `X-Request-Id` / `X-Trace-Id` (the server generates its own `logx.RequestID()` and ignores inbound values); it reads `x-request-id` only from response headers as the sole correlation key. Therefore:
  - Successful responses log at `debug`.
  - Every non-2xx response logs at `warn` with `httpStatus` and `serverRequestId` (production minimum level is `Info`, `getDefaultMinLevel`).
  - Messages for the §6.3.3 classifications (401 / 403 / 3xx) include the ID so the cause appears with the MCP record.
  - In-band failures (HTTP 200 + `isError: true`, such as quota exhaustion) must include the ID too. Only the fetch wrapper sees response headers, so it reports the ID to the adapter through a callback; the adapter associates it with this `tools/call` by span, writes an `mcp.tool.call` warning and adds `zcode/officialMcpServerRequestId` to the result `_meta` (omitted on success).
  - The correlation key must be the span, not the traceId (a traceId spans the whole top-level session, so multiple calls share it). If no span is available (`initialize` / `tools/list` have no `_meta`, or the caller passed no trace), omit the field; never fall back to the "most recent response".

## 6. Authentication headers and credential attribution

### 6.1 Request headers for `jwt_token`

Generated dynamically for every HTTP request to a trusted MCP:

```http
Authorization: Bearer <current-zcode-jwt>        # validated by server requireAuth; always sent
X-Bigmodel-Authorization: Bearer <current-family-maas-jwt>   # sent only when a valid Coding Plan Provider and MaaS JWT are available
Bigmodel-Target-Type: PERSONAL | TEAM            # sent only when the corresponding wire scope exists
Bigmodel-Organization: <organization-id>         # TEAM only, and only when project is also present
Bigmodel-Project: <project-id>                   # TEAM only, and only when organization is also present
```

Server contract basis (checked against `zcode-server`): `WithCodingPlan` reads `X-Coding-Plan-Api-Key`, `X-Bigmodel-Authorization`, `Bigmodel-Organization`, `Bigmodel-Project`, `Bigmodel-Target-Type`; JWT `Authorization` is read separately by `requireAuth`.

- `Bigmodel-Target-Type` is sent only when the corresponding `wireScope` exists, with value `PERSONAL` / `TEAM`. BigModel Personal/Team have wire scopes PERSONAL/TEAM; ZAI Team has `null`, so the header is omitted (server fallback branch). Identity-only requests (Start Plan, API Key mode, Registry without a valid Coding Plan Provider) also omit it.
- The server's `CodingPlanContext.Valid()` requires organization and project to be non-empty when `TargetType=TEAM`, so the client keeps pair atomicity: if either is missing, omit both; half an identity is rejected as a bad request.
- Credential channel (2026-08 change, supersedes the Phase 1 decision): `X-Bigmodel-Authorization` and `X-Coding-Plan-Api-Key` are mutually exclusive on the server (`credential := cmp.Or(Authorization, APIKey)`, Authorization first). Phase 1 first decided to keep `X-Coding-Plan-Api-Key` and not send a MaaS JWT, recording the switch as technical debt. After backend confirmation (`middleware/coding_plan.go` documents the API Key channel as "for existing clients only; new integrations must use the MaaS JWT header") official MCP sends only `X-Bigmodel-Authorization` when plan credentials are available; identity-only requests send only the ZCode JWT.
  - This changes the credential, not just the header name: the header carries a MaaS sign-in JWT (`oauth:<family>:access_token`, the same token as Coding Plan reset/usage endpoints). The server extracts its `customer_id` via `ParseWithoutVerification` and requires it to match the current user; a Coding Plan business key in this header fails parsing.
  - Never send both headers: the JWT wins for ZAI binding and quota lookup, but the API key ownership check (`validateIdentityFromApiKey`) still runs, and an expired or foreign key makes the whole request return 403/3101. Replacement, not addition.
  - The value includes the `Bearer ` prefix (the server uses `strings.CutPrefix(..., "Bearer ")` and also accepts a bare token); send it as specified by `zcode-server/docs/api_server_mcp.md`. Off-Peak and model relay still use `X-Coding-Plan-Api-Key` (different API family, different server contract) and are intentionally untouched.
- Header names are case-insensitive on the server; send them with the casing shown above.

#### 6.1.1 Independent implementation; do not reuse Off-Peak code

Credential resolution and identity-header construction for official MCP are implemented separately: equivalent to Off-Peak logic but independent in code.

- Do not reuse `resolveOffPeakCredentials(...)`, `buildOffPeakPlanIdentityHeaders(...)`, `resolveSelectedOffPeakCodingPlan(...)` or other Off-Peak functions, and do not turn them into shared helpers.
- Do not modify any existing export or behavior in `packages/services/src/session/offPeakRuntimeModel.ts`.
- The new implementation lives in a separate location (for example `packages/services/src/official-mcp/` as `officialMcpCredentials.ts` / `officialMcpAuthHeaders.ts`) with names free of Off-Peak business terms.

Rationale: the validation rules currently match but are expected to diverge (official MCP plan requirement, Team scope, credential channel); a shared helper would force impact assessment on both sides for every change, which costs more than duplicating two implementations. Tests keep them consistent: OMCP-021 covers the full credential-kind-to-header mapping; OMCP-025 guards Off-Peak regressions. If they differ, follow §6.1 of this spec, not the Off-Peak current state.

The new implementation preserves the semantics of four Off-Peak characteristics but implements them independently:

1. `Bigmodel-Target-Type` had no producer at all; this is a new capability (mapped from credential kind).
2. `zai-team` stays consistent with Off-Peak: `buildOffPeakPlanIdentityHeaders` returns an empty object when `kind !== "bigmodel-team"`, so `zai-team` sends no organization/project although `resolveSelectedOffPeakCodingPlan` resolves both. Because the server requires both when `TargetType=TEAM`, `zai-team` also must not send `Bigmodel-Target-Type: TEAM`; it omits the header, falls to the server fallback branch and inherits Off-Peak's known risk (the branch queries PERSONAL/TEAM concurrently and failure of either fails the request). So `Bigmodel-Target-Type` is not unconditional: ZAI Team and all identity-only snapshots omit it. Exact wire-scope support for ZAI Team would be enabled separately on the official MCP side.
3. Keep the race-prevention credential consistency check, covering every identity-only path: at the start of each resolution read the identity snapshot (`providerFamilyDomain`, selected connection fingerprint, `oauth:active_provider`, `zcodejwttoken`) and read it again before returning identity-only or full Coding Plan credentials. If any field differs restart the resolution; if still unstable after two attempts return `official_auth_unavailable`. The full-credential path includes the current family's MaaS JWT in the same check. This prevents cross-family mixing and token rotation within a family. Compare raw JWTs only in memory; never log them.
4. Mock credentials are not enabled by default: Off-Peak returns placeholder JWT/Key when `ZCODE_OFFPEAK_MOCK=1` and `allowMockCredentials: false` is not passed. The new implementation must not introduce this mock branch (tests replace the credential source by dependency injection). If a switch is needed it is off by default with a dedicated environment variable, never `ZCODE_OFFPEAK_MOCK`.

The Start Plan restriction is encoded explicitly rather than inherited: when the selected connection is Start Plan, return `official_auth_plan_required`, but still allow connection/discovery requests to send the identity-only ZCode JWT. Do not reuse Off-Peak reason strings such as `start_plan_not_supported`; the server-side plan check decides tool calls.

Authentication and plan credentials are independent dimensions. If Coding Plan is selected but the ineligible Provider was filtered out of the Registry, recognize this before requiring a MaaS JWT and return an identity-only snapshot containing only the ZCode JWT, so a missing MaaS JWT does not downgrade a signed-in request to anonymous. The identity-only snapshot has `planScope` / `wireScope` both `null` and no `codingPlanAuthorization`.

### 6.2 Status owner

- JWT authority: the current ZCode signed-in identity in the host's `credentialService`.
- Coding Plan selection, MaaS JWT and Team context authority: the host's current settings, credentialService and the same provider registry snapshot; a business key is not an outbound credential for official MCP.
- Plugin configuration declares only which auth method is required; it stores, generates and refreshes no credentials.
- The Agent/MCP adapter consumes only the headers needed for one request and does not write them to `McpServerConfig`, a Session snapshot, Plugin cache or logs.

Resolution cannot wait until the model sends `tools/call`: MCP must complete `initialize` and `tools/list` first and those also need auth. So headers are resolved before every MCP HTTP request (`initialize`, `tools/list`, `tools/call`, later protocol requests).

#### 6.2.1 In-flight deduplication allowed; time-based caching prohibited

One resolution is costly (a cross-process round trip, two settings reads comparing fingerprints before and after, one provider registry snapshot, re-resolution if fingerprints differ), and an Agent loop calling N tools resolves N times on the critical path. Phase 1 allows only in-flight deduplication:

- If a resolution is in progress, concurrent requests reuse the same pending Promise.
- Discard the Promise as soon as it settles; the next request performs a fresh, full resolution.
- No time-based cache, no per-Plugin/connection residency, no persistent storage.

Only genuinely concurrent requests share a result. The scope is host-global, not partitioned by `pluginId` / `mcpKey` / `targetOrigin` / workspace, because credentials are host-global state (§7.1); partitioning would only weaken deduplication.

### 6.3 OAuth isolation and `zcode_official` failure semantics

`zcode_official` and MCP OAuth are mutually exclusive. An official-auth failure is a user identity/plan issue resolvable only through ZCode sign-in and Coding Plan selection; passing a 401 to OAuth would misrepresent "sign in to ZCode again" as "authorize this MCP".

#### 6.3.1 Disable implicit OAuth fallback

An `http`/`sse` MCP with no `oauth` defaults to `{type:"authorization_code"}`; the only escape hatch is a static `authorization` header, which §5.2 prohibits. So OAuth configuration resolution gets an early short-circuit:

```text
resolveAuthorizationCodeOAuthConfig(config):
  if auth?.type === "zcode_official" -> return undefined   # new; before all existing branches
  ...existing branches remain unchanged
```

- `authProvider` is `undefined`; no OAuth session, no localhost callback server.
- No `authorization` field is written to MCP record status; `onAuthorizationRequired` and `openAuthorizationUrl` are never called.
- Default behavior for regular MCP and MCP with explicit `oauth` is unchanged.

#### 6.3.2 Inject identity headers last, with overwrite semantics

Identity headers are injected only in the `fetch` passed to the transport (the wrapper around `createMcpTransportFetch(...)`), the single egress after the SDK assembles `_commonHeaders()` and `requestInit`.

- Use `set` (overwrite) for every §6.1 identity header; never `append` (could produce comma-joined multi-value `Authorization`) or "fill only if missing".
- The wrapper never modifies `mcp-session-id` or `mcp-protocol-version` and never deletes the SDK-set `accept` / `content-type`.

#### 6.3.3 Failure classification and response handling

If credentials are missing, do not fall back to OAuth or infer credentials from environment variables. This table applies to `type:"http"`; stdio failure semantics intentionally differ (send `{ok:false, reason}` instead of marking the connection failed; Phase 2 spec §6.3).

| Case | Classification | Behavior |
| --- | --- | --- |
| Host auth port unavailable (for example standalone CLI) | `official_auth_unavailable` | Mark the connection failed; send no requests |
| Not signed in, or no provider family / connection selected | `official_auth_unavailable` | Mark the connection failed; send no requests |
| Signed in but Start Plan or API Key mode, or selected Coding Plan Provider removed from Registry | `official_auth_plan_required` | Connection/discovery sends only the ZCode JWT, no MaaS JWT or scope headers; the server still checks plan entitlement for tool calls |
| Origin/provenance validation fails (adapter-side) | `official_mcp_origin_untrusted` | Mark failed; zero network requests |
| Host-side second Origin validation mismatch | `official_mcp_origin_untrusted` | Host rejects before reading credentials; `resolveHeaders` never called; Agent marks failed |
| Backend 401 | `official_auth_rejected` | Retry once per the rules below; still 401 -> failed |
| Backend 403 | `official_auth_forbidden` | No retry; failed. The identity is valid but permission/plan is insufficient; the same credentials will not change the result |
| Backend 3xx | `official_auth_redirect_blocked` | Do not follow; failed (§5.2 `redirect: "manual"`) |

`official_auth_plan_required` is a separate classification (not Off-Peak reasons such as `start_plan_not_supported`, not merged into `official_auth_unavailable`): unavailable means environment/sign-in state is missing, plan-required means the plan tier is insufficient, and follow-up actions differ (sign in again vs upgrade), so record status and logs must distinguish them. In Phase 1 users see only that the MCP is failed in either case.

401 retry rules (the only permitted retry path):

- Resolve identity headers again and retry at most once, unconditionally (no comparison of whether credentials changed).
- A retry that still returns 401 marks failed with `official_auth_rejected`; the hard limit of one makes spinning impossible.
- The retry applies only to `zcode_official`; 401 behavior for regular and OAuth MCP is unchanged.

The retry is unconditional because headers are resolved per request (§6.2) and credentials were obtained milliseconds before the 401; the only recoverable race is credentials refreshed just after the request was sent, and cross-process change detection for that is not worth it. A connection with persistent 401s fails during `initialize`, so the cost is one extra request per connection attempt.

Classifications are recorded only in MCP record status and logs (fields per §5.2). Phase 1 shows no sign-in guidance or other UI; `packages/ui` is unchanged.

#### 6.3.4 GET SSE stream not enabled in Phase 1

The SDK's GET `text/event-stream` server stream is not enabled for `zcode_official` MCP: its request headers are resolved once when it opens and the connection then stays open with no "next request" to inject fresh headers, so the §11 requirement not to reuse old headers after a sign-in or Coding Plan switch could not be met.

- The GET stream does not open during `start()`. The SDK opens it after the client sends `notifications/initialized` if the server returns 202 Accepted for it; this design uses neither of the other triggers (`resumptionToken` passed to `send`, public `resumeStream(...)`).
- To keep it disabled, the server returns any non-2xx for GET on this endpoint; the SDK then treats it as "streaming unsupported" and returns normally without retry or error. The client sends exactly one GET probe (with normal identity headers), an acceptable fixed overhead.
- Observed: the go-sdk `StreamableHTTPOptions{Stateless: true}` docs say GET/DELETE return 405, but Gin registers only POST for this path (`router.go`), so GET actually returns 404. Equivalent for SDK behavior; no backend change needed.
- Optional hardening: the fetch wrapper could short-circuit GET to this Origin locally with a synthetic 405 so no probe is sent (not required in Phase 1; if adopted, handling must match the real 405 path).
- Phase 1 official MCP supports only client-to-server request/response, no server-to-client push.

If streaming is enabled later, complete all three together: server-side GET SSE with event `id:` (else `Last-Event-ID` resumption is ineffective and events are lost when the stream drops; ideally in the first backend version because adding it later is a protocol-level change), client-side credential-change detection and stream replacement, and `reconnectionOptions` tuning (SDK default `maxRetries: 2` is too low).

## 7. Client-side implementation boundaries

### 7.1 New port

The MCP adapter does not depend on `packages/services` directly; it consumes identity headers through dependency injection:

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

- Failures are returned, not thrown, using the §6.3.3 classifications; the adapter never infers causes from error text. Network errors (401/403/3xx) are outside this port; the adapter classifies them after receiving the response.
- `workspaceIdentity` / `workspacePath` are used only for request context and auditing, not credential selection (credentials are host-wide signed-in identity and app settings, not isolated by workspace) and not routing (`client.respond(request.id, ...)` returns over the stdio connection that issued the request). The port still follows repository convention: pass through the full identity and set `workspaceKey = workspaceIdentity?.trim() || workspacePath` (CR review CR-01), so remote workspaces with the same path but different identities remain distinguishable in audit context. Remaining gap: the CLI Agent process has no source for `workspaceIdentity` (`RunZCodeProtocolAgentOptions` has only cwd/env/... and no corresponding environment variable), so it currently falls back to `workspacePath`. The port guarantees passing the identity through when provided, not that one is always available; real remote identity for audit would have to be passed at spawn or through the protocol (out of scope).
- `pluginId` / `mcpKey` / `targetOrigin` are used for secondary validation on the host and logging, not credential selection. Before resolving credentials the `zcodeAgentService` handler validates the tuple against the same shared registry; on mismatch it returns `official_mcp_origin_untrusted` without calling `resolveHeaders`, so no credentials are loaded. If the validator is unavailable, reject (fail closed).
- Why adapter-only validation is insufficient: the adapter's fetch wrapper runs inside the Agent process while the host is the identity authority. In a desktop-attached remote the Agent runs remotely while the host holds the local user's identity; with adapter-only validation the remote runtime could obtain the local JWT and Coding Plan key simply by issuing this RPC, and there is no fallback if the wrapper is changed or bypassed (the checked party would be its own checker).
- The dev switch `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` must also apply on the host (`env` passed during assembly in `node.ts`), or the host rejects local tests itself.

Separation of responsibilities:

1. Plugin loader: strictly parse `auth` and attach host-generated official provenance.
2. Bootstrap: build the trusted Origin registry and inject it into the MCP adapter.
3. MCP adapter: validate provenance/Origin during dynamic fetch before calling `OfficialMcpAuthHeadersPort`.
4. MCP adapter: when `zcode_official` matches, skip OAuth configuration resolution, pass `undefined` as `authProvider`, classify 401/403/3xx per §6.3.3.
5. Host/service: resolve current identity and Coding Plan credentials and return conditional headers (independent implementation, no mock branch; §6.1.1).
6. MCP adapter: merge non-reserved static headers with dynamic identity headers using overwrite semantics, then send (§6.3.2).

### 7.2 Agent protocol

An Agent started by Desktop is not the identity authority. A strict internal request is added:

```text
interaction/requestOfficialMcpAuthHeaders
```

Precedent: `interaction/requestProviderRuntimeHeaders` is also an Agent-initiated header request answered automatically by the host without UI, so the `interaction/` prefix does not imply user interaction.

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

The response travels only over the existing private stdio/remote host attachment link. Success:

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

Failure:

```json
{ "ok": false, "reason": "official_auth_plan_required" }
```

The schema uses `.strict()`, `reason` is an enum from §6.3.3 (not free text), and the response has no `errorMessage` so callers never branch on message text. The schema lives in `packages/shared/src/zcode-protocol/index.ts`. The host service resolves and responds automatically, without a renderer event or React controller.

If the standalone CLI has no host auth port, Phase 1 fails with `official_auth_unavailable`; it must not fall back to an unauthenticated request or scan environment variables. A local Coding Plan identity resolver for the standalone CLI is a later-phase scope.

### 7.3 Request sequence

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

### 7.4 Local / remote / Web boundaries

- Desktop local: the current window-scoped Local Host and its Agent stdio link.
- Desktop-attached SSH/WSL/Docker: existing Remote Host and `workspaceIdentity` / `remoteSessionId` routing; no Agent runtime is created for MCP. Identity headers return only to the paired Agent client that issued the request.
- Mobile `/remote`: reuses only the Agent/MCP runtime already attached to the desktop shared host; the relay and desktop main store no JWTs, Coding Plan keys or MCP session status.
- Desktop `continuous` and mobile `replayable` conversation-delivery semantics are unchanged; official MCP auth is a network transport capability with no conversation snapshot or queue state.

The remote Agent temporarily holds request headers in its process (necessary to execute HTTP MCP remotely); they must not be added to runtime config, persisted or logged. Protocol tests cover desktop-attached remote routing; if a real remote environment is unavailable, record that verification as outstanding and do not claim local tests verify remote behavior.

## 8. Fake Plugin and tests

### 8.1 Directory and identity

The fake Plugin is a test fixture, not part of `OFFICIAL_PLUGIN_DEFINITIONS`, SEA assets, the Desktop bundle or the remote prebuild manifest:

```text
apps/zcode-cli/packages/bootstrap/tests/fixtures/zcode-official-http-mcp/
  .zcode-plugin/plugin.json
  .mcp.json
```

Tests inject this root through `officialPluginRoots` and a loopback Origin through an adapter option. The fake HTTP MCP server listens on a random port at `127.0.0.1`.

### 8.2 Test cases

| ID | Setup | Action | Assertions | Layer |
| --- | --- | --- | --- | --- |
| OMCP-001 | Official fixture + valid auth | Parse Plugin | Runtime name is `plugin:<name>:fake-official-search`; auth/provenance preserved | Adapter unit |
| OMCP-002 | Inline/third-party Plugin copies the same auth | Parse/connect | No identity headers requested; MCP fails closed | Adapter unit |
| OMCP-003 | Official identity, URL Origin does not match | Connect | `official_mcp_origin_untrusted`; zero network requests | Adapter unit |
| OMCP-004 | Official identity + exact loopback Origin | initialize/list/call | Fake server receives the ZCode JWT on all three; with valid plan credentials also the MaaS JWT and matching wire scope | Adapter HTTP integration |
| OMCP-005 | Complete BigModel Team snapshot | Send MCP request | Organization/project sent as a pair | Services + integration |
| OMCP-006 | Team snapshot missing either field | Send MCP request | Neither Team header sent | Services unit |
| OMCP-007 | Static Plugin header overrides a reserved header | Parse | MCP disabled with a clear diagnostic | Plugin unit |
| OMCP-008 | Backend returns 3xx | Request | Redirect not followed; Target Origin gets no credentials | Adapter HTTP integration |
| OMCP-009 | JWT/plan credentials/host auth port missing | Connect | Identity-only scenario sends only the ZCode JWT; failed when host auth port unavailable; logs contain no secrets | Adapter/Bootstrap unit |
| OMCP-010 | Two MCPs in one Plugin with different keys/Origins | Connect separately | Each authorized per its mapping; identity neither shared nor mixed | Bootstrap integration |
| OMCP-011 | Desktop-attached remote identity (same `workspacePath` as local, different `workspaceIdentity`) | Request auth | Response returns only to the requesting Agent client and request ID; same-path local client makes zero calls; interleaved requests isolated | Services protocol unit |
| OMCP-012 | MCP connection pool reused by multiple sessions | Concurrent requests | Each HTTP request uses the credential snapshot resolved at that time; first session's secret not frozen into config | Adapter pool unit |
| OMCP-013 | Official fixture + `zcode_official`, no `oauth` or static `authorization` | Connect | `authProvider` is `undefined`; no OAuth session; no localhost callback port | Adapter unit |
| OMCP-014 | Same; fake server returns 401 for every request | initialize | `official_auth_rejected`, status failed; zero `onAuthorizationRequired` / `openAuthorizationUrl` calls; no `authorization` in record status; no browser | Adapter HTTP integration |
| OMCP-015 | Same; fake server returns 403 | initialize | `official_auth_forbidden`; exactly one request (no retry) | Adapter HTTP integration |
| OMCP-016 | First request 401; second 200 after re-resolution | initialize | Exactly one retry then success; second request carries re-resolved credentials | Adapter HTTP integration |
| OMCP-017 | Persistent 401 | initialize | Failed after exactly one retry; two requests then stop | Adapter HTTP integration |
| OMCP-018 | `zcode_official` and `oauth` configured together | Parse Plugin | `plugin_mcp_server_disabled`; disabled without choosing a priority | Plugin unit |
| OMCP-019 | Ordinary HTTP MCP (no `auth`, `oauth`, static `authorization`) | Connect | Existing `authorization_code` fallback still works | Adapter unit |
| OMCP-020 | Static `headers` override `bigmodel-target-type` or `mcp-session-id` | Parse | MCP disabled with a clear diagnostic | Plugin unit |
| OMCP-021 | Credential kinds Personal / BigModel Team / ZAI Team | Send MCP request | Wire scopes `PERSONAL` / `TEAM` / `null`; organization/project paired only for `TEAM` | Services unit |
| OMCP-022 | `Authorization` already exists before injection | Send MCP request | Exactly one `Authorization` with the current JWT (overwritten) | Adapter unit |
| OMCP-023 | Signed in, selected connection is Start Plan | Connect | Only the ZCode JWT, not the MaaS JWT; server login/plan error classification recorded | Services + Adapter unit |
| OMCP-024 | `ZCODE_OFFPEAK_MOCK=1` | Send MCP request | Unaffected by the variable; no placeholder credentials | Services unit |
| OMCP-025 | Before and after all official MCP cases | Run existing Off-Peak tests | Off-Peak behavior unchanged, all pass (verifies §6.1.1 isolation) | Services regression |
| OMCP-026 | N concurrent MCP requests | Concurrent | Underlying credential resolution runs once; all N get the same headers | Services unit |
| OMCP-027 | Request after the first resolution settled | Two sequential requests | Second performs a fresh full resolution (no time-based cache); after switching Coding Plan connection it gets new headers | Services unit |

This phase has no UI behavior, so it adds no WebdriverIO/UI E2E tests and does not modify the conversation session case catalog or coverage matrix.

## 9. Impact summary

### 9.1 Must inspect

| Relationship | Affected areas | Reason |
| --- | --- | --- |
| Configuration contract | `contracts/interfaces/mcp.port.ts`, Plugin MCP parser | `auth` flows from file configuration into runtime, HTTP only |
| Request egress | `adapters/src/mcp/index.ts`, `network.ts` | Dynamic header injection and redirect validation at the single egress for all Streamable HTTP MCP requests |
| OAuth isolation | `resolveAuthorizationCodeOAuthConfig`, `createAuthorizationCodeOAuthOptions` in `adapters/src/mcp/index.ts`; `adapters/src/mcp/oauth.ts` | `zcode_official` bypasses the implicit `authorization_code` fallback and handles 401/403 without affecting ordinary MCP |
| Official identity | `bootstrap/official-plugin-definitions.ts`, Plugin discovery | Bundled official provenance (Origin mapping later removed) |
| Identity authority | New official MCP credential resolver (`services/official-mcp/`) and service assembly | JWT, plan key and Team context from the same current snapshot; independent of Off-Peak (§6.1.1) |
| Off-Peak isolation | `services/session/offPeakRuntimeModel.ts` and callers | Read-only reference: no change to exports, signatures or behavior; existing tests must pass |
| Cross-process protocol | Shared ZCode protocol, Bootstrap protocol server, `zcodeAgentService` | The Agent is not the identity authority; no UI response dependency |
| Pool isolation | MCP connection pool | A shared connection must not freeze or leak the first session/workspace's credentials |

### 9.2 Should inspect

- `mcp/list` control plane and session runtime share an adapter and must return the same failed status when official auth is unavailable; Settings must not probe anonymously while the session runtime authenticates.
- The Plugin cache/official root can be modified locally, so only the runtime-resolved Origin check establishes endpoint trust.
- HTTP proxies, custom CAs and No Proxy must keep working through `createMcpTransportFetch`; the auth wrapper wraps it and never bypasses network policy.

### 9.3 Invariants

- Do not modify `packages/ui`.
- Do not modify any existing Off-Peak code path; official MCP has a separate implementation (§6.1.1).
- Do not change headers or OAuth behavior for ordinary HTTP/SSE MCP.
- Do not change stdio MCP, `node_repl`, MCP version negotiation, or tool `_meta`.
- Do not move authentication status into the relay, desktop main, conversation snapshots or session persistence.
- Do not add `serverId` / `capabilityId`, or infer official identity from URL paths, tool names or model output.

### 9.4 Suggested feature graph delta

Add `capability.zcode-official-server-mcp-auth` associated with: official Plugin definition -> plugin MCP parser -> trusted Origin registry -> MCP HTTP transport -> host Coding Plan credential resolver -> private Agent protocol bridge. The feature graph itself was not modified by this spec.

## 10. Implementation order (test-first)

1. contracts/parser success and failure tests.
2. Adapter tests for trusted Origins, reserved headers, redirects.
3. Adapter tests for OAuth bypass and 401/403/3xx classification (OMCP-013 to OMCP-019, OMCP-022).
4. Host Coding Plan header resolver and Agent protocol tests, including `Bigmodel-Target-Type` and mock isolation (OMCP-021 / 024 / 025).
5. Fake Plugin + fake HTTP MCP integration test.
6. Implement contracts, parser, Bootstrap registry, protocol bridge, service resolver, dynamic fetch.
7. Targeted tests, then `pnpm typecheck` and `pnpm lint`.

## 11. Acceptance criteria

- An official Plugin's HTTP MCP can enable `zcode_official/jwt_token` through a per-MCP `auth` declaration in `.mcp.json`.
- None of these cases sends sensitive headers: correct official identity with the wrong Origin, correct Origin with a third-party Plugin, a copied auth field, a cross-Origin redirect.
- `initialize`, `tools/list` and `tools/call` all send the ZCode JWT (`Authorization`); `X-Bigmodel-Authorization` only when the Registry has a valid Coding Plan Provider and the current family has a MaaS JWT; `Bigmodel-Target-Type` only when a matching `wireScope` exists; for `TEAM`, organization/project as a pair.
- `zcode_official` MCP creates no OAuth session and occupies no localhost callback port (`authProvider` is `undefined`). Backend 401/403 is classified failed per §6.3.3 with zero `onAuthorizationRequired` / `openAuthorizationUrl` calls and no `authorization` field in record status.
- 401 is retried at most once; a persistent 401 makes exactly two requests then stops.
- Start Plan, API Key mode, or a Registry without a valid Coding Plan Provider classify as `official_auth_plan_required`; connection and discovery requests send only the ZCode JWT (no MaaS JWT or target/scope headers), distinguishable from `official_auth_unavailable`.
- After changing the signed-in identity or Coding Plan connection, later requests do not reuse old headers.
- The fake Plugin exists only in test fixtures, not in production bundled assets.
- Ordinary MCP, OAuth MCP, stdio MCP and existing proxy/CA behavior pass regression checks; the implicit `authorization_code` fallback for non-`zcode_official` MCP is unchanged.
- No changes to `packages/ui`; `pnpm typecheck` and `pnpm lint` pass.

## 12. Backend interface conventions

Backend implementation is out of scope for this phase. This section records what the client sends and how it interprets responses so the backend can implement against the contract without client changes.

### 12.1 Requests sent by the client (confirmed)

For every HTTP request to a trusted official MCP:

| Header | Value | Condition |
| --- | --- | --- |
| `Authorization` | `Bearer <zcode-jwt>` | Always |
| `X-Bigmodel-Authorization` | `Bearer <current family's MaaS sign-in JWT>` | Only when the Registry has a valid Coding Plan Provider and a MaaS JWT is available (replaced `X-Coding-Plan-Api-Key` in 2026-08) |
| `Bigmodel-Target-Type` | `PERSONAL` or `TEAM` | Only when a corresponding wire scope exists |
| `Bigmodel-Organization` | organizationId | `TEAM` only, paired with project |
| `Bigmodel-Project` | projectId | `TEAM` only, paired with organization |

Existing shared source headers (`User-Agent`, `X-Platform`, ...) are also sent with the same semantics as other ZCode business APIs. Correlation ID exception: do not send `X-Request-Id` / `X-Trace-Id`; read them only from response headers (§5.2). Transport is Streamable HTTP MCP; the MCP SDK generates the body. The credential channel changed in 2026-08: when conditions are met the client sends only `X-Bigmodel-Authorization` (the MaaS sign-in JWT), no longer `X-Coding-Plan-Api-Key`; identity-only requests send only `Authorization` (§6.1). This resolves the Phase 1 open question on whether the backend required the MaaS JWT channel.

### 12.2 Client interpretation of responses (confirmed)

| Response | Client behavior |
| --- | --- |
| 2xx | Process the MCP protocol response normally |
| 401 | Credentials invalid/expired. Re-resolve and retry at most once (§6.3.3), then fail. Do not start OAuth authorization |
| 403 | Identity valid but lacks permission/plan entitlement. No retry; fail immediately |
| 3xx | Do not follow (`redirect: "manual"`); fail immediately. Production endpoints use a canonical URL, not trailing-slash or case-normalization redirects |
| 405 (GET stream) | "Server-side streaming unsupported"; normal, not an error |

The backend should not rely on `WWW-Authenticate` to trigger client OAuth discovery (disabled, §6.3.1); express auth failures with 401/403.

Constraints for backend traffic analysis: official MCP is a Coding Plan entitlement (§3.2). Start Plan users and users without a Coding Plan connection may still reach the backend during connection/discovery but send only a non-empty ZCode JWT and no `X-Bigmodel-Authorization`; the same applies when the selected field still points to Coding Plan but its ineligible Provider was removed from the Registry. The backend distinguishes authenticated from unauthenticated users and performs its own plan checks. The client determines this from the selected connection form and whether the Registry still has an available Provider, not from the presence of a MaaS JWT or business key. A missing MaaS JWT indicates an incomplete sign-in only when the Registry contains a valid Coding Plan Provider (since 2026-08 the business key is no longer a credential or requirement).

### 12.3 Backend/publishing-side values

Confirmed (`zcode-server`, 2026-08):

1. Endpoint: `POST /api/v1/mcp/server/:mcp_group` (`internal/interfaces/web/router.go`). `:mcp_group` is required (`/api/v1/mcp/server/` alone returns 404) and the URL must not have a trailing slash (`…/image_search/` returns 307, which the client classifies as `official_auth_redirect_blocked`, unrelated to the real cause).
2. Auth middleware: reuse `requireAuth` + `WithCodingPlan`, as Off-Peak does; the §6.1 header contract applies.
3. Group list: currently only `image_search` (`MCPGroupTools` in `internal/domain/servermcp/service.go`), exposing `search_image`. Each group has its own endpoint and a corresponding MCP entry on the client.
4. No session: the handler uses `StreamableHTTPOptions{Stateless: true}` and sends no `Mcp-Session-Id`; an empty session ID from the real endpoint is expected (only the fake server sends one).

Still pending backend confirmation:

1. Notification mechanism for new groups: each group has a separate endpoint, so adding one still requires changing `.mcp.json`, which conflicts somewhat with adding official MCPs without a client change.
2. Deployment constraint: official MCP must share the ZCode API Origin, which the client resolves at runtime (§5.1). If the backend deploys official MCP on a separate domain the design must return to an explicit allowlist and accept the release friction; align in advance.

(The `X-Bigmodel-Authorization` decision was resolved in 2026-08: the API key channel is retained only for backward compatibility, §6.1.) While these items are open the client can complete the fake fixture and all dependency-injection tests (local testing uses the loopback dev switch).

## 13. Implementation locations

| Responsibility | File |
| --- | --- |
| Header set / reserved-header denylist (shared, §5.2); trusted Origin registry (§5.1) | `packages/shared/src/official-mcp-auth.ts` |
| Agent protocol schema (§7.2) | `packages/shared/src/zcode-protocol/index.ts` |
| Credential resolution + identity-header construction + in-flight deduplication (§6.1 / §6.2.1) | `packages/services/src/official-mcp/officialMcpCredentials.ts` |
| Host-side handling of reverse requests (§7.2) | `packages/services/src/zcode-agent/zcodeAgentService.ts` |
| Assembly (host is the sole identity authority) | `packages/services/src/node.ts` |
| Configuration contract and port types (§4.2 / §7.1) | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts` |
| Strict Plugin parsing + provenance (§4.2) | `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` |
| Dynamic injection + Origin validation + failure classification (§6.3.2 / §6.3.3) | `apps/zcode-cli/packages/adapters/src/mcp/official-auth.ts` |
| OAuth bypass (§6.3.1) | `resolveAuthorizationCodeOAuthConfig` / `createOfficialAuthFetch` in `apps/zcode-cli/packages/adapters/src/mcp/index.ts` |
| Agent-side auth port (§7.1) | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts` |
| Runtime assembly | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` |

Test files: `plugin-official-mcp-auth.test.ts` (parsing), `packages/shared/test/officialMcpTrust.test.ts` (trust), `mcp-official-auth.test.ts` (injection and classification), `mcp-official-auth-integration.test.ts` (fake end-to-end), `officialMcpCredentials.test.ts` (credentials), `officialMcpAuthProtocol.test.ts` (protocol schema), `officialMcpAuthRemoteRouting.test.ts` (desktop-attached remote routing), `official-mcp-auth-port.test.ts` (port-to-protocol parameter construction, including same-path identities). 87 cases cover OMCP-001 to OMCP-027 (OMCP-025 is the Off-Peak regression action; its command is in the header comment of `officialMcpCredentials.test.ts`).

### 13.1 Three facts clarified during implementation

1. The GET probe in §6.3.4 is verified and locked by a test: after 202 for `notifications/initialized` the SDK sends exactly one GET; the server responds 405; the client safely abandons it and stays connected. The assertion in `mcp-official-auth-integration.test.ts` locks the count so no one assumes "the client sends no GET at all".
2. The reserved-header denylist applies only to the official-auth path: static `authorization` on ordinary/third-party HTTP MCP is a valid existing use (`resolveAuthorizationCodeOAuthConfig` relies on it to exit the OAuth fallback); a global block would regress. OMCP-019 locks this boundary.
3. Failure classifications cannot be recovered from the error object: during version negotiation the SDK wraps `OfficialMcpAuthError` in a plain `Error` (message prefix `Version negotiation probe failed: `), losing identity, so `instanceof` is unreliable in `failConnection` and parsing error text would violate the rule against text-based control flow. The classification is instead reported through `onAuthFailure` at the throw site; the adapter stores it in a per-server slot, consumes and clears it in `failConnection`, and clears it at the start of every connect to prevent cross-talk. The §6.3.3 classification is searchable in production logs by the `officialAuthKind` field.

### 13.2 Real-device verification (2026-08-16)

Verified on local Desktop (`pnpm dev:desktop`) with the local fake official MCP (`scripts/dev-official-mcp-server.mjs`): with a real signed-in identity and a Personal Coding Plan, the Agent log showed `mcp.server.connected` (`plugin:dev-official-mcp:dev-search`) with no `mcp.server.failed` or official MCP auth failures. The fake server received `initialize` / `tools/list` with the complete identity headers, and the GET streaming probe was safely abandoned after a 405.

Local facilities:

- `scripts/dev-official-mcp-server.mjs`: a loopback fake MCP that prints the auth headers of each request (JWTs and Coding Plan keys redacted; `Bigmodel-Target-Type` / organization / project shown as is).
- `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`: accepts only HTTP loopback (`normalizeTrustedOrigin` in `"loopback"` mode rejects HTTPS and non-loopback hosts, so one environment variable cannot direct a real JWT to a remote host). Unset, behavior is exactly as before.

Self-test pitfalls:

- Load a local Plugin through `plugins.dirs` in `~/.zcode/cli/config.json`, not `~/.zcode/v2/config.json` (Desktop/services configuration) or the Settings page's "Add marketplace" flow (which requires a marketplace directory).
- A Plugin loaded through `dirs` always uses the `inline` marketplace (ID like `dev-official-mcp@inline`). This suffix does not affect authorization (§5.1): success depends only on the Origin (an HTTPS endpoint must equal the current ZCode API Origin; an HTTP loopback Origin must be in `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS`).
- MCP connections are initiated once when a session is created; a failed connection stays failed and does not reconnect automatically. Start the fake server before Desktop. The Desktop MCP status display can lag until restart (existing behavior, §9.3).

### 13.2.1 Settings-page status refresh timing (existing behavior, known limitation)

Observed: "the Agent is connected but Settings still shows the old status until restart." This is existing refresh behavior combined with official MCP's connection pattern; not fixed in this phase (§9.3: no `packages/ui` changes), recorded for a future task.

`McpSettingsSection.tsx` has three refresh triggers:

| Trigger | Condition | Effect on official MCP |
| --- | --- | --- |
| Automatic refresh on key change | Only when `autoStatusListRefreshKey` changes (`previousKey !== nextKey` in `transitionMcpAutoStatusListRefreshKey`); key = workspaceIdentity + workspacePath + `serverStatusListKey`, which derives from the servers/plugins list | A connection-status change does not change the list, so the key stays the same |
| 1-second polling | Requires a pending OAuth server (`pendingMcpOAuthAuthorizationRefreshKey` non-empty); capped at 5 minutes | Official auth has no `authorizationUrl` (§6.3.1) |
| Window focus / visibilitychange | Also gated by `pendingMcpOAuthAuthorizationRefreshKey` | Same |

There is no subscription for connection-status changes and no periodic refresh for non-OAuth servers. Verified (2026-08-16): after stopping the fake server, switching the Settings tab, switching workspaces or toggling the Plugin does not change the status to failed. Toggling the Plugin acquires and releases a `protocol-settings` lease (`sess=-`) but produces no dev-search probe event, so the displayed status stays the old snapshot. All MCP events after 13:55 had a `sessionId` and `mcpIsolation: session`; none came from a Settings `protocol-settings` lease (log: 13:50:27 `mcp.server.connected` sess_fb0c0db; 13:55:36 `mcp.server.failed` for sess_8517a98 / sess_95448b8 / sess_72bae46; 13:55:37-13:59 workspace/tab switches produced no new events).

Cause: `serverStatusListKey` derives only from the servers/plugins list, which does not change with connection status; the Settings component stays mounted across tab switches, so `lastAutoStatusListRefreshKeyRef` is not reset and `transitionMcpAutoStatusListRefreshKey` returns `shouldRefresh: false`. Restarting the app is the only reliable way to rebuild this store. Settings uses the entrypoint's `protocol-settings` lease while each session uses its own session lease; they share a connection pool but status does not flow between them, so a failure known to the session side is not reflected in Settings. The default (connect) mode of `mcp/list` does reconnect (`bootstrap/src/zcode-protocol/mcp.ts` calls `connectConfiguredServers`); the problem is that nobody requests an update.

The Plugin list behaves similarly: `pluginManagementStore.initialize` runs in `useEffect` per workspace and `refresh()` only after enable/disable/install/uninstall, with no timer, so manually editing `plugins.dirs` in `~/.zcode/cli/config.json` is not discovered by the UI.

Impact on regular MCP is limited (OAuth servers are polled; non-OAuth servers usually connect quickly around initial mount). Official MCP connections are initiated on demand per session, often after Settings has mounted, so Settings necessarily shows stale status. Future fix directions (UI layer, separate task): a connection-status subscription beyond `serverStatusListKey`, or low-frequency polling for non-OAuth servers.

### 13.2.2 Local fault injection for error paths

`scripts/dev-official-mcp-server.mjs` accepts `--mode ok|401|403|redirect|tool-quota` and `--fail-on all|initialize|tools/call`.

| Scenario | Command | Expected |
| --- | --- | --- |
| No entitlement during connection | `--mode 403 --fail-on initialize` | `officialAuthKind=official_auth_forbidden`; MCP fails; one injection log only (403 not retried) |
| 403 during a call after connection | `--mode 403 --fail-on tools/call` | MCP stays connected and tools stay mounted; only that tool call fails |
| Quota exhausted during tool call | `--mode tool-quota` | HTTP 200 + `isError: true` business error; MCP stays connected |
| Credentials rejected | `--mode 401` | `official_auth_rejected`; exactly two injection logs (original + one retry); more indicates a retry loop |
| Redirect hijack | `--mode redirect` | `official_auth_redirect_blocked`; Target Origin gets no requests |

Neither `--fail-on tools/call` nor `tool-quota` produces `officialAuthKind`: the former is a single call after the connection is established, the latter is not an auth problem. MCP business errors use in-band `isError`, not an HTTP status, so quota exhaustion does not disconnect; this is by design.

A fail-closed scenario that does not need the backend: `official_mcp_origin_untrusted` by starting without `ZCODE_OFFICIAL_MCP_DEV_TRUSTED_ORIGINS` (zero requests).

Readout: `grep '"officialAuthKind"' ~/.zcode/cli/log/zcode-<date>.jsonl`. A connection-time failure requires restarting Desktop to reconnect (the §13.2.1 refresh blind spot); a tool-call failure does not.

### 13.3 Known gaps

- The earlier gap "no production `OFFICIAL_PLUGIN_DEFINITIONS` entry has registered `trustedMcpOrigins`" is moot: the mechanism was removed with the §5.1 decision change. Trust is now whether the Target Origin equals the runtime-resolved ZCode API Origin; if it cannot be resolved the client fails closed (`zcode_origin_unresolved`).
- Targeted protocol tests for desktop-attached remote routing exist (`officialMcpAuthRemoteRouting.test.ts`, OMCP-011): response routing over two paths with the same `workspacePath` but different `workspaceIdentity`, isolation of interleaved requests, pass-through of `plan-required`, `official_auth_unavailable` when no resolver exists, and malformed parameters going through `respondError` without resolving credentials. Remaining risk: these service-layer tests use a fake Agent client; the full path has not been exercised in a real SSH/WSL/Docker environment (remote process startup, transport, network egress unverified). Do not claim "verified on a real remote" (§7.4).
