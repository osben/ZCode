# ZCode Official Server MCP: Composer Notice When Unavailable (Quota Exhausted / No Coding Plan Entitlement)

- Status: T1 (server error code → composer notice) implemented; T2 (local classification after signing out and switching to API Key) is not implemented; see §10.2
- Current unified authentication and scope facts are documented in `zcode-official-server-mcp-auth-spec.md`; this document covers only quota/banner product behavior.
- Prerequisite: `zcode-official-server-mcp-client-phase-1-spec.md` (hereafter “phase 1”). Trust-validation criteria, the identity-header set,
  credential resolution, and failure classifications all follow phase 1 and are not repeated here.
- Involved repositories: `z-code` (client) and `zcode-server` (server); both share the same set of tool error codes.
- Driving requirement: The official Server MCP has entitlement requirements and a daily quota. If either requirement is unmet, the interface gives the user no explanation;
  the user only sees the model say “The tool call failed” and must guess why.
- Line numbers in this document are from the 2026-08-20 staging build, for locating code only; they may drift as the code changes. The §4 contract is defined by the server-side
  `internal/domain/servermcp/toolerror.go`.

## 1. Target

When the official Server MCP is unavailable due to **insufficient entitlement** or **exhausted daily quota**, show a readable notice above the composer
explaining the cause, which quota applies, and when it resets, with an upgrade entry point when entitlement is insufficient.

Reuse the existing `ConversationQuotaBanner`—the quota notice currently shown to Coding Plan users.

## 2. Current State: Why Nothing Is Displayed Today

### 2.1 Both Server-Side Failure Types Are Plain Text Only

Every official MCP tool call passes through `Service.authorize` (`internal/domain/servermcp/service.go:155`):

1. `CheckEligibility` returns `ErrCodingPlanRequired` when no Coding Plan is available
   (`internal/domain/servermcp/billing.go:58`);
2. `CheckQuota` returns `ErrQuotaExceeded` when the daily bucket quota is exhausted
   (`internal/domain/servermcp/quota.go:63`).

Both errors are converted to strings with `fmt.Errorf` and wrapped repeatedly. Finally, the five local tool handlers directly
`return nil, nil, fmt.Errorf(...)` (`internal/interfaces/web/controller/mcp_controller.go`).
At `mcp/server.go:381`, go-sdk wraps an ordinary handler error as
`CallToolResult{IsError: true}` plus plain-text content.

Result: **The client receives only free-form text**—no error code, bucket name, or reset time. Those fields were already available
in `CheckQuota` (`used` / `limit` / `conf.NextRefreshAt(now)`) but were discarded when converted to a string.

### 2.2 The Client Cannot Receive an “Error State”

On the CLI side, an MCP in-band `isError: true` counts as a **successful execution**: `turn-tools.ts:269` passes only `isError` to the
model message, while `result.success` remains `true`. Therefore, the v4 `toolCall` row has `status: "success"`
and no `error.code`.

⇒ The notice cannot rely on the row's error state. It must rely on a **structured identifier carried by the tool result itself**.

### 2.3 The “Sign Out and Switch to API Key” Path Never Sends Requests

This is the second scenario to cover and one of the easiest to miss:

The user first signs in with Coding Plan and configures the official MCP, then signs out and switches to an API Key. At this point,
`resolveOfficialMcpCredentials` (`packages/services/src/official-mcp/officialMcpCredentials.ts:173`)
classifies the state as `official_auth_plan_required`. Under phase 1 §6.3.3, **not a single byte is sent**; the official MCP connection fails,
the tool is not added to the registry, and the model cannot call it.

⇒ The server-side entitlement error code can **never reach the client** on this path. This failure classification is currently written only to logs
(`apps/zcode-cli/packages/adapters/src/mcp/index.ts:898`); it is not added to `McpServerStatus`, so the UI cannot access it.

### 2.4 The MCP Route Does Not Verify the Plan

`internal/interfaces/web/router.go:163` uses `WithCodingPlanContext()`—it parses identity headers only and **does not verify** them;
missing headers immediately return 400 (`/api/v1/mcp/usage` is the route that uses `WithCodingPlan` with a verifier). Plan invalidation is rejected by `CheckEligibility` inside the tool call,
which uses an in-band isError response rather than an HTTP error.

### 2.5 The Banner Has an Existing Pattern

`provider-limited` (`packages/ui/src/v4/sessionQuotaBannerState.ts:198`) implements “display the backend message directly + dismissible.”
The new kind can follow the same pattern and needs no new UI component.

## 3. Scope

### 3.1 In Scope

- The server gives the two failure types structured representations and includes a structured identifier in the tool result;
- The client parses that identifier and passes it through tool result display → v4 row → banner;
- The client promotes its local `official_auth_plan_required` classification into MCP Status, covering the scenario in §2.3;
- Bilingual labels, deduplication and priority rules, and the corresponding tests.

### 3.2 Out of Scope

- Blocking input (`blocksSubmit` remains `false`): MCP unavailability does not affect model conversations;
- Quota-value display: the composer popover already has an MCP quota entry; this document adds only an “unavailable” notice;
- The server-side quota policy itself (bucket divisions and per-tier quotas);
- Interfaces outside v4 `SessionPane` (the existing quota banner appears only there).

## 4. Protocol Contract: `error_code` in Tool Error Content

> This section was updated to match the server implementation as of 2026-08-20. The initial design assumed the identifier would be placed under the
> `com.zcode/mcp-unavailable` key in `CallToolResult._meta`; the server ultimately chose to render it in **the JSON text of the tool error content**,
> and the client implements the latter.

### 4.1 Format

`ToolError.Error()` in server file `internal/domain/servermcp/toolerror.go` outputs a single line of JSON, sent as
text content of the tool error (`IsError: true`):

```json
{
  "error_code": "quota_exceeded",
  "message": "daily quota exceeded for bucket search_image (5/5), retry tomorrow or upgrade your coding plan",
  "request_id": "..."
}
```

There are two output paths: a local tool handler returns `ToolErrorFor(err, requestID)` (go-sdk wraps the ordinary error as an
`IsError` result), while upstream forwarding uses `ToolErrorResult` to construct a result of the same shape directly.

### 4.2 Codes

| Code                   | Meaning                                                                     | Client behavior                                                                                           |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `quota_exceeded`       | Daily bucket quota exhausted / no quota available                           | Show “Today's quota is used up”; dismissible; no action                                                   |
| `coding_plan_required` | No available Coding Plan (context missing or signature verification failed) | Show “Coding Plan required”; dismissible; include an upgrade entry point                                  |
| `internal_error`       | Fallback mask for all other failures                                        | **Do not recognize or show a notice**—details remain in server logs; users cannot resolve this themselves |

### 4.3 Conventions

- `error_code` is the sole routing criterion. **Do not fall back to label matching**; a one-line server message change could silently break it;
- `message` is English and used only for logs and troubleshooting. UI labels always use i18n, so the client does not display it in the banner
  (unlike `provider-limited`, whose message is a Chinese product label);
- `request_id` is used to correlate with server logs;
- Parse strictly: the value must be a JSON object and `error_code` must match a known code; otherwise ignore the entire payload;
- Single declaration point: `OFFICIAL_MCP_TOOL_ERROR_CODES` and `parseOfficialMcpToolError` in
  `packages/shared/src/official-mcp-tool-error.ts`, consumed by CLI core, the v4 row schema,
  and the UI to avoid one side recognizing a new code while another drops it.
- If the code is unknown, a field is missing, or a type does not match, the client **ignores the entire payload** without guessing or displaying a notice;
- `IsError` remains `true` and `content` still contains the same text—the identifier is additional information only, and model-side behavior is unchanged.

## 5. Server-Side Implementation (`zcode-server`, completed)

### 5.1 Unified `ToolError` Carrier

`internal/domain/servermcp/toolerror.go`:

- `ToolError{Code, Message, RequestID}` renders the §4.1 JSON from `Error()`. `Unwrap()` returns the internal
  sentinel (`ErrQuotaExceeded` / `ErrCodingPlanRequired`), preserving `errors.Is` semantics
  without exposing the internal error chain to the client;
- `ToolErrorFor(err, requestID)` maps service errors to a client-visible form: an existing `ToolError` passes through directly
  (adding the request ID); the two sentinels map to their corresponding codes; **everything else** (upstream, gateway, and infrastructure failures)
  is masked uniformly as `internal_error`, with details remaining only in server logs;
- `ToolErrorResult(err, requestID)` is the version for bare handlers (upstream forwarding) and constructs an `IsError` result directly.

### 5.2 Interception Points

- `CheckQuota` (`quota.go`) returns `ToolError{Code: quota_exceeded}` in all three cases: the bucket has no owner,
  the tier has no quota, or the daily quota is exhausted (the label includes the bucket name and used/limit);
- `CheckEligibility` (`billing.go`) returns `ToolError{Code: coding_plan_required}` in both cases:
  Coding Plan context is missing or signature verification fails;
- All five local tool handlers and upstream forwarding are wired up (`mcp_controller.go`).

### 5.3 Fields Unused by the Client

The server label includes the bucket name and used/limit but **does not include** `next_refresh_at`. Therefore, the UI does not promise a specific reset time;
it only says “Resets tomorrow.” The calendar-day reset is ensured by `QuotaConfig.NextRefreshAt`; the exact reset date is also available in the MCP quota
entry in the composer popover.

## 6. Client-Side Implementation (`z-code`, T1 completed)

| Trigger | Scenario                                                              | Signal                              | Status                     |
| ------- | --------------------------------------------------------------------- | ----------------------------------- | -------------------------- |
| T1      | Credentials present, request sent: quota exhausted / plan invalid     | `error_code` in tool error content  | Implemented                |
| T2      | Signed out and switched to API Key, or not signed in: no request sent | Local `official_auth_plan_required` | Not implemented; see §10.2 |

### 6.1 Single Contract Declaration Point

`packages/shared/src/official-mcp-tool-error.ts` declares `OFFICIAL_MCP_TOOL_ERROR_CODES` and
`parseOfficialMcpToolError`. It belongs in shared because three consumers in separate packages need one source of truth: CLI core (parses results),
the v4 row schema (validates the code), and the UI (chooses a label and action based on the code).

`McpToolDescriptor` adds `official?: boolean` (see §6.2).

### 6.2 Trust Only HTTP Official MCP (Security-Related, Cannot Be Skipped)

Without checking the source, **any MCP server could put the same payload in a result and forge a Coding Plan notice**.
Credentials are not exposed, but this could mislead users into buying or upgrading a plan.

The criterion is **who produced the result**, not “who owns the Plugin” (SG-02 correction):

| Form                                 | Result producer                                                                                      | Can forge `error_code`?                                                                   | Flagged |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| `http` + `auth.type=zcode_official`  | ZCode backend (while the connection is alive, per-request Origin validation passed and fails closed) | No—the Plugin can only send requests to real ZCode and does not control the response body | ✓       |
| `stdio` + `auth.type=zcode_official` | The Plugin process                                                                                   | **Yes**, any string                                                                       | ✗       |
| Other                                | Third-party server                                                                                   | Yes                                                                                       | ✗       |

**Intentionally, this does not check whether the Plugin comes from the official marketplace**: that would make official Plugins from unofficial installation sources (local testing,
`zcode-plugins-test`) stop working outright, and this is not a real security boundary (see the “Known Residual Risks” section of `isOfficialMcpOriginTrusted`).

Known cost: failures from the official stdio Plugin (`video-agent-kit`) no longer trigger a notice. This does not cause a practical loss of capability—it emits its own error label
(`[ERROR] zcode_speech transcription failed: …`), which does not match `parseOfficialMcpToolError`'s strict parser in the first place. If stdio later needs to pass through structured server failures,
define a separate host-validated channel rather than weakening this validation.

- `apps/zcode-cli/packages/adapters/src/mcp/index.ts`: at the `normalizeMcpToolDescriptor` call site, pass `official` based on
  `config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE`;
  `descriptor.ts` passes it through;
- `apps/zcode-cli/packages/core/src/mcp/index.ts` passes the marker into `mcpPresentation`;
- Add the field to `mcpPresentation` in `core/src/tool/types.ts` as well.

### 6.3 Result-Level Display → v4 Row

- `core/src/tool/executor/result-display.ts`: `createMcpToolDisplay` adds an optional `output` parameter;
  for official sources, it reads `error_code` from text blocks in `output.content` and, if matched, adds
  `unavailable: { code }` to the `mcp_tool` display. `createToolResultDisplay` passes the result through (`call-runner.ts` already
  calls it with `output`, so the caller does not need to change);
- **Add the same field to both `.strict()` schemas**, otherwise row validation rejects it:
  `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts` (`mcpToolResultDisplayPayloadSchema`)
  and `packages/shared/src/zcode-protocol-v4/rows.ts` (`toolCallMcpDisplaySchema`); both code
  enums come from the single declaration in §6.1;
- `product-projection.ts` already passes `payload.result.display` through as a whole to the `toolCall` row; no changes to the projection layer.

### 6.4 Banner

- `packages/ui/src/v4/mcpUnavailableBannerNotice.ts`: `resolveMcpUnavailableNotice(rows)` produces `{ code, serverName, toolName, rowId }` from the
  **latest** `mcp_tool` row in the window that has `display.unavailable`. Use the latest rather than the first: the same session may first hit a quota limit, then switch connections and hit an entitlement issue; the notice should reflect the latest event;
- `sessionQuotaBannerState.ts`: add kinds `mcp-quota-exhausted` / `mcp-plan-required`,
  **after `provider-limited` and before the Start-Plan-only early return** (Coding Plan sessions always hit that early return, so placing these after it would make them unreachable); add `mcpServerName` / `mcpNoticeRowId` state fields, with the latter included in the dismiss key;
- `ConversationQuotaBanner.tsx`: add two `MESSAGE_IDS` mappings and pass `server` as a label variable;
- `useV4SessionQuotaBanner.ts`: add `mcpUnavailableNotice` as an input (the caller parses it from rows—it is a session-event projection unrelated to the entitlement service, so do not fetch it in this hook);
- `SessionPane.tsx`: parse the notice with `useMemo` and pass it into the hook. Rendering conditions remain unchanged—composer errors still take precedence.

## 7. Display Specification

| Field        | `mcp-quota-exhausted`                                                       | `mcp-plan-required`                                                                  |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Label        | `chat.quota.mcp.quotaExhausted` (names the server; says it resets tomorrow) | `chat.quota.mcp.codingPlanRequired` (names the server; says Coding Plan is required) |
| Action       | None (wait for the calendar-day reset)                                      | Reuse the banner's existing `onUpgrade` (Coding Plan upgrade / purchase dialog)      |
| Dismissible  | Yes                                                                         | Yes                                                                                  |
| Blocks input | No                                                                          | No                                                                                   |
| Priority     | 6                                                                           | 8; both are below all model quota kinds                                              |
| Dedup key    | `kind` + `serverName` + `rowId`                                             | Same as the left column                                                              |

Two hard requirements:

- **Priority must be lower than model quota kinds**: model quota exhaustion directly affects the conversation; the MCP notice must not take precedence;
- **Use i18n for the label rather than the server message.** This differs from `provider-limited`, whose message is a Chinese product label that can be displayed directly. The official MCP message is English (`daily quota exceeded for bucket ...`); displaying it directly in a Chinese interface is unacceptable. The server message is only logged.

Including `rowId` in the dedup key means that after dismissing a notice, it will not reappear for the same call; a new failed call will show it again.
Switching to another MCP server also shows a new notice.

i18n keys have been added for both en-US and zh-CN.

## 8. Tests

Server: `toolerror_test.go` covers code mapping and the `internal_error` mask. Client:

- shared: `packages/shared/test/officialMcpToolError.test.ts` — normal parsing, omitted optional fields,
  `internal_error` and unknown codes not recognized, and no label-based fallback for non-JSON text;
- core: `apps/zcode-cli/packages/core/tests/tool-result-display.test.ts` — produces both codes and passes
  the strict schema, **ignores non-official sources**, and produces no identifier for unknown codes, non-JSON, or successful results;
- ui: `packages/ui/test/v4SessionQuotaBannerState.test.ts` — routes by code, does not block input,
  model quota kinds have higher priority, the dismiss key follows server and rowId, and `resolveMcpUnavailableNotice`
  selects the latest row.

## 9. Acceptance

1. Server: `go test ./internal/domain/servermcp/... ./internal/interfaces/web/controller/...`;
2. Client: `pnpm typecheck` (two strict schemas changed; note cross-package compilation) + `pnpm lint` + the Vitest tests above;
3. **Quota:** lower a bucket's daily quota (`internal/config` MCP quota config) → start the server locally →
   call the official MCP tool for that bucket in ZCode until its quota is exceeded → a notice appears above the composer and names the server; after dismissal it does not appear again;
   trigger a new failure afterward to show it again;
4. **Entitlement:** make `CheckEligibility` fail (remove Coding Plan context or make verification fail) → the notice changes to
   “Coding Plan required” and includes an upgrade entry point;
5. **Forgery check:** configure a local third-party MCP (`scripts/dev-official-mcp-server.mjs`) with non-official auth to return the same
   `{"error_code":"quota_exceeded"}` in its result, and confirm that the banner does **not** appear.

## 10. Known Gaps and Trade-offs

1. **`rows.window` is a windowed view:** after scrolling far through a session, an old identifier may leave the window and the banner will disappear.
   The latest call is always in the window, which is acceptable; strict retention would require promoting this to session-level state rather than storing it on a row.
2. **T2 (sign out and switch to API Key) is not implemented.** On that path, the client locally classifies `official_auth_plan_required`,
   and no request is sent, so the server code can never reach the client. To cover this path, promote the classification from logs into `McpServerStatus`
   and have the UI fall back to it. The trade-off is one notice per new session in API Key mode (dismissible); the product must decide whether to implement this.
3. **MCP in-band `isError` still leaves row `status: "success"`** (unchanged current behavior); the banner also does not take over
   composer errors—these are separate information channels.
4. **`internal_error` shows no notice.** It is a fallback mask for all other server failures, which users cannot resolve themselves.
5. **The server does not send `next_refresh_at`**, so the label only says “Resets tomorrow” and does not promise a specific time. The exact reset date is visible in
   the MCP quota entry in the composer popover.
6. **The `official` marker must be preserved end to end:** Plugin config → descriptor → `mcpPresentation` → display construction.
   If any step drops it, any MCP could forge a Coding Plan notice. Preserve this invariant when changing these points.
