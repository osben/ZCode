# ZCode Official Server MCP: Composer Notice When Unavailable (Quota Exhausted / No Coding Plan Entitlement)

- Status: T1 (server error code -> composer notice) implemented; T2 (local classification after signing out and switching to API Key) not implemented (§10.2).
- Current unified authentication and scope facts are in `zcode-official-server-mcp-auth-spec.md`; this document covers only quota/banner product behavior.
- Prerequisite: `zcode-official-server-mcp-client-phase-1-spec.md` ("phase 1"). Trust validation, the identity-header set, credential resolution and failure classifications follow phase 1.
- Repositories: `z-code` (client) and `zcode-server` (server); both share the same tool error codes.
- Requirement: the official Server MCP has entitlement requirements and a daily quota. When either is unmet, the user gets no explanation (the model only says "The tool call failed").
- Line numbers refer to the 2026-08-20 staging build and only locate code. The §4 contract is defined by the server's `internal/domain/servermcp/toolerror.go`.

## 1. Target

When the official Server MCP is unavailable because of insufficient entitlement or exhausted daily quota, show a readable notice above the composer explaining the cause, which quota applies and when it resets, with an upgrade entry point when entitlement is insufficient. Reuse the existing `ConversationQuotaBanner` (the quota notice shown to Coding Plan users).

## 2. Why nothing was shown before

### 2.1 Both server failures were plain text only

Every official MCP tool call passes `Service.authorize` (`internal/domain/servermcp/service.go:155`): `CheckEligibility` returns `ErrCodingPlanRequired` without an available Coding Plan (`billing.go:58`); `CheckQuota` returns `ErrQuotaExceeded` when the daily bucket quota is exhausted (`quota.go:63`). Both were turned into strings with `fmt.Errorf`; the five local tool handlers `return nil, nil, fmt.Errorf(...)` (`internal/interfaces/web/controller/mcp_controller.go`), and go-sdk (`mcp/server.go:381`) wraps an ordinary handler error as `CallToolResult{IsError: true}` plus plain text. The client got free-form text without error code, bucket name or reset time, although `CheckQuota` had `used` / `limit` / `conf.NextRefreshAt(now)`.

### 2.2 The client cannot see an "error state"

On the CLI side an MCP in-band `isError: true` counts as a successful execution: `turn-tools.ts:269` passes only `isError` to the model message while `result.success` stays `true`, so the v4 `toolCall` row has `status: "success"` and no `error.code`. The notice must rely on a structured identifier carried by the tool result itself, not the row's error state.

### 2.3 "Sign out and switch to API Key" never sends requests

After signing in with Coding Plan and configuring the official MCP, signing out and switching to an API Key makes `resolveOfficialMcpCredentials` (`packages/services/src/official-mcp/officialMcpCredentials.ts:173`) classify `official_auth_plan_required`. Under phase 1 §6.3.3 nothing is sent, the official MCP connection fails, the tool is not registered and the model cannot call it. The server entitlement code never reaches the client on this path, and the classification is only logged (`apps/zcode-cli/packages/adapters/src/mcp/index.ts:898`), not in `McpServerStatus`.

### 2.4 The MCP route does not verify the plan

`internal/interfaces/web/router.go:163` uses `WithCodingPlanContext()`: it parses identity headers without verifying them, and missing headers return 400 (`/api/v1/mcp/usage` uses `WithCodingPlan` with a verifier). Plan invalidation is rejected by `CheckEligibility` inside the tool call as an in-band isError, not an HTTP error.

### 2.5 Banner pattern exists

`provider-limited` (`packages/ui/src/v4/sessionQuotaBannerState.ts:198`) implements "show the backend message directly + dismissible"; the new kinds follow it with no new UI component.

## 3. Scope

In scope: the server gives the two failure types a structured representation in the tool result; the client parses it and passes it through tool result display -> v4 row -> banner; promoting the local `official_auth_plan_required` classification into MCP Status (§2.3; not done, §10.2); bilingual labels, dedup and priority rules, tests.

Out of scope: blocking input (`blocksSubmit` stays `false`); quota-value display (the composer popover already has an MCP quota entry); the server's quota policy; interfaces outside v4 `SessionPane`.

## 4. Protocol contract: `error_code` in tool error content

The server renders the identifier in the JSON text of the tool error content (the initial design of `com.zcode/mcp-unavailable` in `CallToolResult._meta` was dropped).

### 4.1 Format

`ToolError.Error()` in `internal/domain/servermcp/toolerror.go` outputs one JSON line as the text content of the tool error (`IsError: true`):

```json
{
  "error_code": "quota_exceeded",
  "message": "daily quota exceeded for bucket search_image (5/5), retry tomorrow or upgrade your coding plan",
  "request_id": "..."
}
```

A local tool handler returns `ToolErrorFor(err, requestID)` (go-sdk wraps the ordinary error as an `IsError` result); upstream forwarding uses `ToolErrorResult` to construct a result of the same shape.

### 4.2 Codes

| Code                   | Meaning                                                                     | Client behavior                                                                         |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `quota_exceeded`       | Daily bucket quota exhausted / no quota available                           | Show "Today's quota is used up"; dismissible; no action                                 |
| `coding_plan_required` | No available Coding Plan (context missing or signature verification failed) | Show "Coding Plan required"; dismissible; upgrade entry point                           |
| `internal_error`       | Fallback mask for all other failures                                        | Do not recognize or show a notice; details stay in server logs; users cannot resolve it |

### 4.3 Conventions

- `error_code` is the sole routing criterion; never fall back to label matching (a one-line server message change could silently break it).
- `message` is English, for logs and troubleshooting only. UI labels always use i18n; the client does not show it in the banner (unlike `provider-limited`, whose message is a Chinese product label).
- `request_id` correlates with server logs.
- Parse strictly: the value must be a JSON object and `error_code` a known code; otherwise ignore the whole payload (unknown code, missing field or type mismatch: no guessing, no notice).
- Single declaration point: `OFFICIAL_MCP_TOOL_ERROR_CODES` and `parseOfficialMcpToolError` in `packages/shared/src/official-mcp-tool-error.ts`, consumed by CLI core, the v4 row schema and the UI.
- `IsError` stays `true` and `content` still contains the same text; the identifier is additional and model-side behavior is unchanged.

## 5. Server side (`zcode-server`, completed)

- `ToolError{Code, Message, RequestID}` renders the §4.1 JSON from `Error()`; `Unwrap()` returns the internal sentinel (`ErrQuotaExceeded` / `ErrCodingPlanRequired`), keeping `errors.Is` without exposing the internal chain. `ToolErrorFor(err, requestID)` passes an existing `ToolError` through (adding the request ID), maps the two sentinels to their codes and masks everything else (upstream, gateway, infrastructure) as `internal_error`. `ToolErrorResult(err, requestID)` is the bare-handler (upstream forwarding) version.
- `CheckQuota` (`quota.go`) returns `quota_exceeded` when the bucket has no owner, the tier has no quota, or the daily quota is exhausted (the label includes bucket name and used/limit). `CheckEligibility` (`billing.go`) returns `coding_plan_required` when the Coding Plan context is missing or verification fails. All five local handlers and upstream forwarding are wired (`mcp_controller.go`).
- The server label does not include `next_refresh_at`, so the UI does not promise a reset time; it says "Resets tomorrow" (calendar-day reset by `QuotaConfig.NextRefreshAt`; the exact date is visible in the composer popover's MCP quota entry).

## 6. Client side (`z-code`, T1 completed)

| Trigger | Scenario                                                              | Signal                              | Status                  |
| ------- | --------------------------------------------------------------------- | ----------------------------------- | ----------------------- |
| T1      | Credentials present, request sent: quota exhausted / plan invalid     | `error_code` in tool error content  | Implemented             |
| T2      | Signed out and switched to API Key, or not signed in: no request sent | Local `official_auth_plan_required` | Not implemented (§10.2) |

### 6.1 Single contract declaration point

`packages/shared/src/official-mcp-tool-error.ts` declares `OFFICIAL_MCP_TOOL_ERROR_CODES` and `parseOfficialMcpToolError` (shared because CLI core parses results, the v4 row schema validates the code and the UI picks label/action). `McpToolDescriptor` adds `official?: boolean`.

### 6.2 Trust only HTTP official MCP (security-related)

Without a source check, any MCP server could put the same payload in a result and forge a Coding Plan notice (no credential exposure, but it could mislead users into buying or upgrading). The criterion is who produced the result, not who owns the Plugin (SG-02):

| Form                                 | Result producer                                                                         | Can forge `error_code`?                                                                    | Flagged |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| `http` + `auth.type=zcode_official`  | ZCode backend (connection alive, per-request Origin validation passed and fails closed) | No: the Plugin can only send requests to real ZCode and does not control the response body | yes     |
| `stdio` + `auth.type=zcode_official` | The Plugin process                                                                      | Yes, any string                                                                            | no      |
| Other                                | Third-party server                                                                      | Yes                                                                                        | no      |

The Plugin's marketplace origin is intentionally not checked: it would break official Plugins from unofficial install sources (local testing, `zcode-plugins-test`) and is not a real security boundary (see "Known Residual Risks" in `isOfficialMcpOriginTrusted`).

Known cost: failures from the official stdio Plugin (`video-agent-kit`) no longer trigger a notice. No practical capability loss: it emits its own error label (`[ERROR] zcode_speech transcription failed: …`), which `parseOfficialMcpToolError` never matched. If stdio later needs to pass structured server failures, define a separate host-validated channel rather than weakening this validation.

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`: at the `normalizeMcpToolDescriptor` call site pass `official` from `config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE`; `descriptor.ts` passes it through.
- `apps/zcode-cli/packages/core/src/mcp/index.ts` passes the marker into `mcpPresentation`; `core/src/tool/types.ts` `mcpPresentation` gains the field.

### 6.3 Result-level display -> v4 row

- `core/src/tool/executor/result-display.ts`: `createMcpToolDisplay` takes an optional `output`; for official sources it reads `error_code` from text blocks in `output.content` and, if matched, adds `unavailable: { code }` to the `mcp_tool` display. `createToolResultDisplay` passes the result through (`call-runner.ts` already calls it with `output`).
- Add the same field to both `.strict()` schemas or row validation rejects it: `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts` (`mcpToolResultDisplayPayloadSchema`) and `packages/shared/src/zcode-protocol-v4/rows.ts` (`toolCallMcpDisplaySchema`); both code enums come from the §6.1 declaration.
- `product-projection.ts` already passes `payload.result.display` whole to the `toolCall` row; no projection change.

### 6.4 Banner

- `packages/ui/src/v4/mcpUnavailableBannerNotice.ts`: `resolveMcpUnavailableNotice(rows)` produces `{ code, serverName, toolName, rowId }` from the latest `mcp_tool` row in the window that has `display.unavailable` (latest, not first: a session may first hit quota then switch connections and hit entitlement).
- `sessionQuotaBannerState.ts`: kinds `mcp-quota-exhausted` / `mcp-plan-required`, placed after `provider-limited` and before the Start-Plan-only early return (Coding Plan sessions always hit that early return, so later placement would be unreachable); state fields `mcpServerName` / `mcpNoticeRowId`, the latter in the dismiss key.
- `ConversationQuotaBanner.tsx`: two `MESSAGE_IDS` mappings; `server` passed as a label variable.
- `useV4SessionQuotaBanner.ts`: `mcpUnavailableNotice` as an input (the caller parses it from rows; it is a session-event projection unrelated to the entitlement service).
- `SessionPane.tsx`: parse the notice with `useMemo` and pass it into the hook. Rendering conditions unchanged; composer errors still take precedence.

## 7. Display specification

| Field        | `mcp-quota-exhausted`                                               | `mcp-plan-required`                                                             |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Label        | `chat.quota.mcp.quotaExhausted` (names the server; resets tomorrow) | `chat.quota.mcp.codingPlanRequired` (names the server; Coding Plan required)    |
| Action       | None (wait for calendar-day reset)                                  | Reuse the banner's existing `onUpgrade` (Coding Plan upgrade / purchase dialog) |
| Dismissible  | Yes                                                                 | Yes                                                                             |
| Blocks input | No                                                                  | No                                                                              |
| Priority     | 6                                                                   | 8; both below all model quota kinds                                             |
| Dedup key    | `kind` + `serverName` + `rowId`                                     | same                                                                            |

- Priority must be lower than model quota kinds: model quota exhaustion directly affects the conversation.
- The label uses i18n, not the server message (English, `daily quota exceeded for bucket ...`; unacceptable in a Chinese UI). The server message is only logged.
- Including `rowId` in the dedup key means a dismissed notice does not reappear for the same call; a new failed call or another MCP server shows a new notice.
- i18n keys exist for en-US and zh-CN.

## 8. Tests

Server: `toolerror_test.go` covers code mapping and the `internal_error` mask. Client:

- shared `packages/shared/test/officialMcpToolError.test.ts`: normal parsing, omitted optional fields, `internal_error` and unknown codes not recognized, no label-based fallback for non-JSON text.
- core `apps/zcode-cli/packages/core/tests/tool-result-display.test.ts`: both codes produced and passing the strict schema, non-official sources ignored, no identifier for unknown codes, non-JSON or successful results.
- ui `packages/ui/test/v4SessionQuotaBannerState.test.ts`: routing by code, input not blocked, model quota kinds higher priority, dismiss key follows server and rowId, `resolveMcpUnavailableNotice` selects the latest row.

## 9. Acceptance

1. Server: `go test ./internal/domain/servermcp/... ./internal/interfaces/web/controller/...`.
2. Client: `pnpm typecheck` (two strict schemas changed; cross-package compilation) + `pnpm lint` + the Vitest tests above.
3. Quota: lower a bucket's daily quota (`internal/config` MCP quota config), start the server locally, call the bucket's official MCP tool in ZCode until exceeded: a notice appears above the composer naming the server; after dismissal it does not return; a new failure shows it again.
4. Entitlement: make `CheckEligibility` fail (remove Coding Plan context or fail verification): the notice becomes "Coding Plan required" with an upgrade entry point.
5. Forgery check: a local third-party MCP (`scripts/dev-official-mcp-server.mjs`) with non-official auth returning `{"error_code":"quota_exceeded"}` must not show the banner.

## 10. Known gaps and trade-offs

1. `rows.window` is a windowed view: after scrolling far through a session an old identifier may leave the window and the banner disappears. The latest call is always in the window (acceptable); strict retention would need session-level state rather than storing it on a row.
2. T2 (sign out and switch to API Key) is not implemented. The client classifies `official_auth_plan_required` locally and sends no request, so the server code never arrives. Covering it means promoting the classification from logs into `McpServerStatus` and having the UI fall back to it; trade-off: one dismissible notice per new session in API Key mode. Needs a product decision.
3. MCP in-band `isError` still leaves row `status: "success"` (unchanged); the banner does not take over composer errors (separate channels).
4. `internal_error` shows no notice.
5. The server does not send `next_refresh_at`, so the label only says "Resets tomorrow".
6. The `official` marker must be preserved end to end: Plugin config -> descriptor -> `mcpPresentation` -> display construction. If any step drops it, any MCP could forge a Coding Plan notice.
