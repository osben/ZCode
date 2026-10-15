# ZCode Official Server MCP Authentication and Quota Status Specification

> Status: Current implementation facts (2026-08-22)
>
> This document is the authoritative entry for the official Server MCP client authentication, HTTP/stdio delivery, and quota status.
> Historical stage designs are preserved in the phase-1 / phase-2 documents as Decision Log only, and are no longer used as implementation references.

## 1. Identity and Responsibilities

- The Host/service is the user credential authority; the Renderer, relay, and desktop main do not hold credentials.
- The Agent requests the current identity headers from the Host via `interaction/requestOfficialMcpAuthHeaders`.
- HTTP MCP is validated per-request by the adapter fetch wrapper for origin; `server/discover`, `initialize`, notifications,
  `ping`, `tools/list`, GET probes, and `tools/call` all resolve and inject the current identity headers to the Host. When resolution fails, anonymous requests are still sent; the server determines authority based on the request method; user entitlements should not determine tool catalog visibility.
- stdio MCP obtains the current identity payload in `_meta["com.zcode/official-mcp-auth"]` for `server/discover`, `initialize`, notifications, `ping`, `tools/list`, and `tools/call`; credentials must not enter the process environment variables.
- `Authorization` carries the ZCode JWT; `X-Bigmodel-Authorization` carries the current family's MaaS JWT.
- `X-Coding-Plan-Api-Key` belongs to the server's existing compatibility channel only; the client must not send it or allow plugins to statically inject it.

## 2. Product Scope and Wire Scope

Plan ownership and actual request headers are two separate semantics; wire fields must not be used to reverse-engineer the product connection type:

| Connection              | planScope (quota ownership)     | wireScope (identity headers)    |
| ----------------------- | ------------------------------- | ------------------------------- |
| ZAI / BigModel Personal | `PERSONAL`                      | `PERSONAL`                      |
| BigModel Team           | `TEAM + organization + project` | `TEAM + organization + project` |
| ZAI Team                | `TEAM + organization + project` | `null`                          |

The wire behavior for ZAI Team is consistent with Off-Peak: it does not send `Bigmodel-Target-Type`,
`Bigmodel-Organization`, or `Bigmodel-Project`; the server falls back to identification; but local quota ownership must remain TEAM,
otherwise the entitlement's Team request scope will be incorrectly classified as Personal and skip `/api/v1/mcp/usage`.

Old or malformed Team keys missing organization/project must not fall back to Personal. Tool calls can continue with the existing fallback,
but no quota scope that can be precisely attributed is generated.

## 3. Quota and Banners

- The HTTP official MCP server validates ZCode identity and Coding Plan when requests enter the route; the client uniformly carries available identity headers for connection, discovery,
  and invocation requests. When logged in but without a Coding Plan, only the ZCode JWT is carried (no MaaS JWT),
  and the server returns protocol-layer error codes; quota failures at the tool invocation layer still return structured results with `isError=true`.
- If the HTTP adapter cannot resolve the identity header before sending any request, it hands the request without headers to the server for authoritative determination;
  `official_auth_unavailable` / `official_auth_plan_required` must not be elevated to connection failures.
- `/api/v1/mcp/usage` is the optional data plane for entitlements; failures only clear `mcpQuota`.
- The server's `total_usage` is mapped to a single `MCP_USAGE_LIMIT`; the percentage maintains the "used ratio" semantics.
- Quota scopes match precisely by family, Personal/Team, and organization/project.
- The structured `quota_exceeded` / `coding_plan_required` from the HTTP official MCP can be projected as Composer banners;
  stdio results are produced by the plugin process and are not trusted UI facts.
- Banner dismissal is saved in the current renderer's memory as `(sessionId, dismissKey)`, up to 256 entries;
  localStorage, Host, snapshots, and relays are not written; prompts are allowed again after application restart.
- New successful calls for the same `(serverName, toolName)` override old failures; new failure rows form new prompt instances.

## 4. Remote and Auditing

- Workspace identity uses `workspaceIdentity?.trim() || workspacePath`; `workspacePath` is used only for execution/display.
- The Host logs one info entry for the first identity header issuance per `(pluginId, mcpKey, workspaceKey)`; subsequent issuances log debug.
- When credential resolution succeeds, the MaaS JWT remaining expiration must be logged as info (seconds only, never the token itself): the MaaS JWT has no refresh
  pipeline; after expiration, the server folds the upstream 401 into "coding plan is required"; this value is the client's only self-provable
  distinction clue; production builds do not persist debug, so info is mandatory. Resolution and official MCP request counts are in the same order of magnitude; deduplication must use
  `(providerFamily, planTargetType, expiration hour buckets | expired | unparsable)` as the key — the same key is not logged repeatedly; token changes, switching PERSONAL/TEAM, crossing buckets (including past midnight) always produce new keys.
- Audit collections must be bounded; different SSH/WSL/Docker identities on the same path must not suppress each other.
- Host validation only ensures credentials flow to the current ZCode API origin; stdio identity headers entering the plugin process are a known boundary.

## 5. Acceptance Invariants

- When unauthenticated or the login state is incomplete, HTTP MCP control plane requests using the existing anonymous degradation semantics; when logged in but without a Coding Plan,
  the ZCode JWT must be sent, the MaaS JWT must not be sent, allowing the server to distinguish `1006` from `3101`.
- The identity is re-resolved for each HTTP request and outgoing official stdio protocol message; login, upgrade, or logout after connection takes effect on the next request without reconnecting.
- Anonymous or unentitled calls must not reach gateway/upstream; no quota is checked or deducted; usage is not written.
- Untrusted origin still fails before any network request or credential read; it is not within the scope of anonymous degradation.
- ZAI Team quotas are visible, but wire headers remain consistent with Off-Peak.
- Personal/Team/family/project quotas do not cross-contaminate each other.
- Closing the same banner and switching session/pane before returning still hides it; new failures re-display.
- The final 401 saves the server request id before releasing the response body.
- Desktop continuous and Web remote replayable delivery semantics are unchanged.

Core use cases:

| ID            | Scenario                          | Assertion                                                                                                                    |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OMCP-CALL-001 | Valid Coding Plan                 | Connection, discovery, GET probes, and `tools/call` all inject the latest identity and succeed                               |
| OMCP-CALL-002 | Not logged in or no auth port     | Requests using anonymous degradation; when the server returns unauthenticated errors, the corresponding request id is logged |
| OMCP-CALL-003 | Logged in but no Coding Plan      | Connection requests carry the ZCode JWT, not the MaaS JWT; server errors distinguish login state from plan state             |
| OMCP-CALL-004 | Login or upgrade after connection | No reconnect; the next call re-resolves identity and succeeds                                                                |
| OMCP-STDIO-01 | Official stdio logged in          | `initialize`, `tools/list`, and `tools/call` `_meta` all carry the current identity payload                                  |
