# Agent Model Request Attribution Header

Adapter-layer model requests already send `TraceContext.traceId` as `x-zcode-trace-id`. One trace can span main/sub sessions, tool secondary model calls, and compact/title requests, so trace alone cannot aggregate by session; each HTTP request also needs a stable `x-request-id` to align backend entry logs, captures, and local `ModelStatusContext.requestId`.

Rules:

- All agent model requests keep sending `x-zcode-trace-id` (never renamed to `x-trace-id`).
- All agent model requests send `x-request-id` = current `ModelStatusContext.requestId`.
- All agent model requests send `x-session-id` = the agent session id with the internal `sess_` prefix stripped (kept as-is when absent).
- All agent model requests send `x-zcode-session-type`, one of `main`, `subagent`, `side_chat`, `other`, for server-side request-source statistics.
- With a valid `metadata.querySource`, send `x-zcode-query-source` so the server can filter by purpose (compact, Memory, title generation) instead of the host session's coarse class.
- `x-request-id` / `x-session-id` / `x-zcode-session-type` are observation/audit/attribution only — never auth, billing, rate limiting, or business routing.
- Streaming `streamText`, non-streaming `generateText`, adapter retries, and primary/secondary model paths share one header builder.
- OpenCode Go requests additionally send `x-opencode-session` (see below).

Non-goals: provider static config `headers` untouched (no session-level dynamic values cached in the provider registry); no app/agent protocol schema change (`TraceContext` and model request metadata already carry `sessionId`); no `x-zcode-query-source` for plain OpenCode Zen (`/zen/v1`) or other paths.

Design — headers merge in `apps/zcode-cli/packages/adapters/src/model/runner-options.ts`:

1. Provider static headers enter first.
2. The adapter generates observation attribution headers from `ModelStatusContext`.
3. Attribution headers override same-name provider headers, so request-level request/trace/session/type are never polluted by static config.

`x-zcode-session-type` (session class) and `x-zcode-query-source` (request purpose) are independent; session type is never inferred from `sessionId` prefixes, `querySource`, or telemetry `actorKind`. The runtime binds the class once when `createRuntimeModel` creates the model handle; callers only declare purpose, and the bound `generateText`/`streamText`/`bind` keep it — title, Memory, and in-tool requests no longer overwrite it to `other`.

```text
runtime.taskType ──→ session-type ──┐
caller querySource ─→ query-source ├─→ adapter → HTTP headers
workspace scope ───→ other ────────┘
```

| Request scope | `x-zcode-session-type` |
| --- | --- |
| interactive, fork, workflow parent | `main` |
| subagent child | `subagent` |
| selection side chat (incl. `/side`, `/btw`) | `side_chat` |
| workflow child, nested workflow child | `other` |
| in-session compact, goal verification, session/goal title, Memory, in-tool model requests | inherit the host class above, regardless of purpose |
| workspace-level Repo Wiki, Git copy, connectivity tests | `other` |

Workspace-level requests may borrow an existing session's runtime without belonging to it; their model creation entry passes `scope: "workspace"`, affecting only that handle's attribution (never runtime config or the provider factory). Default scope is session; there is no purpose-matching whitelist. This change adjusts attribution only — it does not enable previously disabled Memory/title paths and does not change model selection, retry, admission, tool execution, or UI/remote delivery semantics.

`side_chat` maps the existing `taskType: "selection_side_chat"` with no new persisted types or protocol fields. Its normal requests, compact, title, Memory, and in-tool requests inherit `side_chat`; `querySource` keeps its purpose value (`main_turn` for normal turns). Servers receiving this header must accept the new value; this repo only sends it and cannot confirm external service compatibility. System prompts never issue separate model requests (classified with their agent step), and the step after a plain tool call keeps the host class. Legacy callers without an explicit class allow only `agent_step + main/subagent actor` compat inference; everything else falls back to `other`. New clients send the header on every physical request; missing values or unknown values on the server side must be counted as `other`, never rejected.

Sources (unchanged): `ModelStatusContext.sessionId` prefers `request.traceContext.sessionId` then `request.metadata.sessionId` — the root trace context already carries the current `sessionId` and children inherit it, so main turns, compact, title generation, prompt enhance, goal verification, and tool secondary calls all share the session header. `ModelStatusContext.requestId` prefers `request.metadata.requestId`, else the adapter generates a UUID — the same value flows into model status events, local logs, and the HTTP request. Adapter retries update `x-request-id` per physical request while `x-zcode-session-type` stays fixed for the logical call. These headers carry no credentials or user content and may enter sanitized request-header debug records.

### Query source header

`x-zcode-query-source` comes only from the current request's `metadata.querySource` via `ModelStatusContext.querySource` into the unified header builder — never inferred from prompt, session type, or `modelCall.operation`, with no new business state or protocol fields.

```text
caller metadata.querySource
  → Adapter ModelStatusContext.querySource
  → unified attribution header builder
  → generateText / streamText (reassembled per retry)
  → Provider HTTP header: x-zcode-query-source
```

- The value passes through trimmed, allowing 1–128 ASCII letters, digits, underscore, dot, colon, or hyphen. Missing, empty, or invalid values omit the header — an observation field never fails a model request.
- No purpose enum whitelist; new valid identifiers pass through. Common values: `main_turn`, `subagent`, `compact`, `session_title`, `goal_summary_title`, `project_memory_extract`, `project_memory_dream`, `project_memory_recall`.
- Request-level reserved: same-name entries in provider static headers (including SDK factory defaults) are removed case-insensitively before injection; missing/invalid sources never fall back to static values. Persisted config is unchanged.
- The static-value strip applies only to `x-zcode-query-source`; other headers keep the existing object merge order and SDK behavior (pre-existing case conflicts of other attribution headers are not fixed here).
- Retries of one logical call keep the same source; concurrent requests use their own. `x-zcode-session-type` still follows the host class, so compact can carry `main` + `compact` together.
- `skipTranscript` only controls model-io recording; Memory Extraction/Dream stays identifiable from the server-side header. No `querySource` in request bodies.
- Observation/filter/audit only — no auth, billing, rate limiting, or routing; servers treat missing fields as unknown source without rejecting. Desktop local, remote workspaces, and Web/mobile reuse the same Agent Adapter; `desktop-continuous` / `web-remote-replayable` delivery, queue, and recovery semantics and UI are unchanged.

### OpenCode Go session header

`x-opencode-session` is sent only when the request base URL host is `opencode.ai` or a subdomain and the normalized path is `/zen/go/v1` (case-insensitive, trailing slash allowed). The host + path combination avoids misclassifying plain Zen `/zen/v1` or other OpenCode APIs and does not depend on volatile provider ids. The value reuses `normalizeModelSessionIdForAttribution()`: `traceContext.sessionId` then `metadata.sessionId`, stripped of the internal `sess_`/sub-agent prefixes; omitted without a session id. The logic lives in the unified attribution header builder; runtime attribution values still override provider static headers.

Verification: contracts/core table-driven tests cover all session task types; runtime tests cover host-class inheritance for in-session title/Memory/tool requests, generate/stream/bind and concurrency isolation, and workspace requests staying `other`; `side_chat` covers type mapping, runtime inheritance, adapter validation, and real HTTP headers across the three API formats; adapter tests cover the four core headers in `generateText`/`streamText`; options tests cover merge order and static-header override prevention; retry tests cover request-id updates with stable session type; query-source tests cover purposes, unknown/empty/invalid values, case conflicts, omission, SDK-captured HTTP paths, retry stability, concurrency isolation, and `skipTranscript` neutrality; OpenCode Go tests cover domain/path boundaries and stable `x-opencode-session` across generate/stream/retry.
