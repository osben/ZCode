# Model Tool Call Validation

## Background

Providers return two distinct problems: an empty tool name (e.g. `{ id: "call_x", name: "", input: {...} }`),
or an id with a non-empty name whose final `tool-call.input` is malformed JSON or `null`.

For client-executed calls, an empty/whitespace tool name cannot hit the registry, but when the call
id is closable it still produces a paired error tool result. This branch keeps the provider's raw
name and follows stable recovery — it never guesses the real tool. For broken arguments the call
identity is likewise kept: normal tool schema / lookup produces the result and lets the model
recover within the current run, instead of escalating the error into a whole-request failure.

## Tool identity

- Only client-executed calls with `typeof toolName === "string" && toolName.trim().length === 0`
  are recovered. The raw empty or whitespace string must be preserved, never overwritten by
  wire/storage placeholders.
- Missing, `null`, numeric, object or other non-string `toolName` keeps returning
  `invalid_model_response`. Non-string name recovery is out of scope.
- `providerExecuted=true` with an empty/whitespace name keeps returning `invalid_model_response`.
- Valid non-empty names execute as before after trim.
- A non-empty but unregistered name still goes through the existing tool lookup; when not found the
  executor returns `Tool not found: <name>` and the runtime emits an `is_error=true` tool result
  paired with the original call id.
- Existing compatibility for a missing call id is unchanged in this ticket and is not conflated
  with malformed-argument recovery. `generateText` keeps `toolCallId ?? id ?? crypto.randomUUID()`;
  streaming adds no new id fallback. Empty names recover only when the current path already has a
  closable id.

Empty/whitespace names reuse the existing registry-miss lifecycle:

```text
provider final tool call (raw name)
                 │
                 ▼
client-executed + name.trim()==="" + closable id
                 │
                 ├── normal finish ──> forced registry miss
                 │                     ├── no Hook / permission / handler runs
                 │                     ├── same-id ToolCallError + error result
                 │                     └── continuation after sibling batch closes
                 │
                 └── stream cut before finish ──> existing stream_recovery_interrupted_tool
                                       not rewritten to a registry-miss error
```

The empty-name registry miss uses two clearly separated error contents:

- UI / log error: `Model returned an invalid tool call: tool name is empty.`
- provider `modelContent`:
  `<tool_use_error>Error: No such tool available: ${rawToolName}</tool_use_error>`

Ordinary non-empty unknown tools keep `Tool not found: <name>`; the existing copy is unchanged.

## Provider, persistence and app projection

Runtime assistant/tool-result history always stores the provider's raw name. Only protocol
boundaries that require non-empty use the fixed placeholder `empty_tool_name`:

| API format                | assistant tool call         | tool-result wire                       |
| ------------------------- | --------------------------- | -------------------------------------- |
| `anthropic-messages`      | raw empty/whitespace string | `tool_result` carries no name          |
| `openai-chat-completions` | `empty_tool_name`           | tool message carries no name           |
| `openai-responses`        | `empty_tool_name`           | `function_call_output` carries no name |

- Explicit `apiFormat` wins; when absent, only `providerKind="anthropic"` keeps the raw name —
  other providers use `empty_tool_name`. Never guess the protocol from URLs.
- `ToolPart.tool` stores `empty_tool_name`; `ToolPart.metadata.providerToolName` stores the raw
  name. Presence must be checked with `providerToolName !== undefined`, never a truthy check.
- Pending, running, completed/error and streaming-synthetic lifecycles all keep the same top-level
  metadata. Hydration restores the raw name first, then the current provider format decides the
  wire projection, so provider switches never mistake the storage placeholder for the model's raw
  name.
- App-visible product state silently filters only on the structured evidence of empty-name
  recovery, never by comparing the placeholder string: in live `model.streaming`, no V4
  `ToolCallRow` is created when the raw name trims to empty; a persisted `ToolPart` maps to no
  legacy message tool part, cold-hydration tool row or visible footprint only when
  `ToolPart.tool="empty_tool_name"` and `metadata.providerToolName` exists and trims to empty. The
  filter applies to desktop continuous and web remote replayable alike.
- Empty-name recovery calls publish no `ToolCallScheduled`. Scheduler, registry miss, persisted
  `ToolPart`, provider error result and continuation are unchanged; later `ToolCallError` / batch
  terminal events never back-create product tool rows.
- `empty_tool_name` is not a reserved tool name. A bare `ToolPart.tool="empty_tool_name"` without
  the metadata, and a live non-empty call the model returned under that same name, both execute and
  display as ordinary legal tool names — so builtin/alias/MCP/plugin tools registered under that
  name never hit an "executed but invisible" identity collision.
- App / remote mappers never expose `providerToolName`; public protocol and old sessions need no
  migration. Old data without metadata keeps using `ToolPart.tool`, including displaying bare
  `empty_tool_name` as an ordinary tool. Ordinary non-empty unknown tools skip the silent filter and
  keep their existing terminal error tool row.
- `tool_input_start` and `model.streaming` keep the raw empty name; the placeholder is used only at
  App/storage or OpenAI-compatible wire boundaries that require a legal non-empty name.

## Malformed tool input JSON

The Adapter parses only the AI SDK final `tool-call.input`; streaming deltas are display-only.
Normalization rules:

- `undefined`, missing input, empty string → `{}`, no parse-fail recorded;
- string input strips at most one leading BOM, then strict `JSON.parse`;
- JSON parse failure, parsed `null`, or native `null` input → one warn and degrade to `{}`;
- other non-string values pass through for normal tool schema judgment;
- no partial JSON repair, no tail trimming or bracket guessing.

```text
AI SDK final tool-call(input)
              │
              ▼
       strict normalize once
        │             │
        │ valid       │ malformed / null
        ▼             ▼
   parsed input    warn + input={}
        │             │
        └──────┬──────┘
               ▼
       normal tool lookup / schema
        │                 │
        │ reject          │ accept
        ▼                 ▼
same-id is_error=true   normal tool execution
tool result
        │
        ▼
next model request in the same run attempts recovery
```

Malformed adds no `inputIssue` or parse-failed marker. If the tool schema accepts `{}`, the tool
still executes normally; if it rejects, use the existing recoverable input-validation error. Unknown
but non-empty tool names enter the existing `Tool not found` path with the same `{}` and call id.

## Provider-visible input validation error

When the first model input fails `inputSchema.safeParse`, the runtime formats the full validation
error and returns an error tool result with the same call id:

```text
<tool_use_error>InputValidationError: ${formattedError}</tool_use_error>
```

The provider projection must keep these fields and values, adding no internal telemetry metadata:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "<original tool call id>",
      "is_error": true,
      "content": "<tool_use_error>InputValidationError: ...</tool_use_error>"
    }
  ]
}
```

The formatter emits recognizable issues in this order:

1. missing: `invalid_type` with a message containing `received undefined`;
2. unexpected: `unrecognized_keys`, outputting keys only, not the issue's own path;
3. wrong type: remaining `invalid_type`.

Exact line templates:

```text
The required parameter `${path}` is missing
An unexpected parameter `${key}` was provided
The parameter `${path}` type is expected as `${expected}` but provided as `${received}`
```

Paths join with `.` for string fields and `[n]` for numeric fields; an empty path yields an empty
string. Wrong-type `received` extracts from the issue message via `/received (\w+)/`, falling back
to `unknown`. With any recognizable issue present, output:

```text
${toolName} failed due to the following ${count > 1 ? "issues" : "issue"}:
${lines.join("\n")}
```

Other error kinds in the same issue batch are not shown then. With none of the three kinds, return
the full Zod 4.0 error message: the issues array uses English default messages, drops internal
`input` / `inst` / `continue` fields, and serializes via `JSON.stringify(issues, replacer, 2)` with
a bigint-to-string replacer. The provider-visible formatter uses the full issue list, unaffected by
the internal log cap of 20 errors.

First model input has two existing boundaries, runtime normalization and provider JSON Schema:

```text
runtimeInputSchema.safeParse
       │
       ├── success ──> normalized input
       │
       └── failure ──> raw input + retained parser issues
                                      │
                                      ▼
                         provider JSON Schema gate
                            │                   │
                            │ success           │ failure
                            ▼                   ▼
                   hooks / permission     exact error modelContent
                                                   │
                                                   ▼
                                 same-id, is_error=true tool result
```

- JSON Schema still decides accept/reject for this first input; retaining parser issues must not
  add rejections.
- Runtime parse success but JSON Schema failure: use the JSON Schema issues.
- Both failing: project both sides into one ordered canonical issue list — the runtime parser
  decides the actual failing items and fallback order; a matched JSON issue only replaces the field
  structure with the target version; provider-only required/unexpected structural issues are
  supplemented by JSON issues.
- Runtime parse failure but JSON Schema success: keep the existing flow; do not early-return a
  parameter error.
- Dynamic tools without a runtime schema keep full JSON Schema issues.

Defaults and preprocess/transform semantics come from the actual parser, never re-derived in the
JSON Schema validator; the canonical projection is the single owner of provider-visible order, and
the formatter only consumes it — it never merges or reorders the two error sets itself. Parameter
errors still classify missing → unexpected → wrong type; the non-parameter fallback keeps the
runtime parser's field/custom-validation order, only moving local parser array-level bounds after
array child-item issues to match the target traversal order. Never use "all JSON issues first,
runtime-only issues appended" — that would move an earlier field's regex/refine error after a later
field's. This projection changes error presentation only, never schema acceptance.

This contract covers only the first schema failure of a model's raw arguments. The optional
tool-level `validateInput` after schema success is semantic/environment validation whose failures
never pass through the parameter-error formatter; inputs modified by PreToolUse hooks and REPL
inner tool calls are separate call sites. ZCode has no deferred/discovered-tool surface, so no
deferred tool-discovery schema hint is generated. No new interface or behavior is added for these
branches.

There is no provider/model gate: all tool-calling models share one branch, with no per-model
checks.

Live execution and cold recovery must project the same error content to the model:

```text
live ToolExecutionResult.modelContent
                │
                ├──> current turn's provider history
                │
                └──> error tool part metadata.modelContent
                                      │
                                      ▼
                         resume / hydration provider history
```

- `ToolStateError.error` keeps the generic UI/log error, not the provider wrapper.
- The error result attaches `modelContent` to `ToolStateError.metadata.modelContent` only when
  `modelContent` itself is a string; the persistence protocol for structured content is not
  extended here.
- Hydration prefers a string `metadata.modelContent`; old data, missing or non-string values fall
  back to `state.error` — no migration.
- `metadata.modelContent` is for agent cold recovery only and must be stripped when mapping
  App/remote messages; ZCode protocol and UI-visible tool metadata are unchanged.
- Hydration never reformats historical errors against the current tool schema, so schema or
  formatter version changes never rewrite what the model actually saw.

## Data and diagnostics boundaries

- Raw malformed string/null never enters provider-visible history, persisted tool parts or
  structured warns.
- Strings record the real `inputLength` only; native null records `inputType: "null"` with no fake
  length.
- Warns record `toolName`, `source`, parse error kind and recovery; once per final malformed call.
- streamText, generateText and model-io reuse the same normalization result — no double parsing,
  duplicate warns, or diagnostics disagreeing with the runtime's actual input.
- The `tool-error.input` AI SDK generates for an invalid call reuses the final call's normalized
  input by call id; raw malformed string/null never enters runtime or model-io through
  `toolResults`.
- model-io's structured `response.toolCalls` and `response.toolResults` record the normalized `{}`,
  never raw malformed input.
- Empty/whitespace tool names keep the raw value in model-io, runtime history and internal
  persisted metadata; the `empty_tool_name` projected at non-empty boundaries never flows back into
  registry lookup. A non-empty string a provider returns under that same name is ordinary tool
  identity with normal registry lookup.
- Lower-level provider raw evidence keeps the existing collection and redaction boundaries.

## Acceptance criteria

- A client-executed empty/whitespace tool name produces a same-id `is_error=true` tool result; the
  model receives
  `<tool_use_error>Error: No such tool available: ${rawToolName}</tool_use_error>` and the same
  turn continues.
- Empty names force a registry miss: handler, hooks, permission and `ToolCallStarted` never run;
  the ordinary non-empty unknown-tool copy is unchanged.
- Anthropic assistant history keeps the raw name; Chat Completions and Responses assistant tool
  calls use `empty_tool_name` only at the wire boundary; none of the three tool-result wires carry
  a name.
- A normal streaming finish enters registry miss; a stream cut after final but before finish still
  returns the existing `stream_recovery_interrupted_tool`.
- Live and cold hydration restore `providerToolName` and the exact `modelContent`; App
  messages/snapshots materialize neither the raw empty name nor placeholder tool rows carrying
  empty `providerToolName` metadata, and never expose the provider's raw empty-name metadata. Bare
  `empty_tool_name` without that metadata displays as an ordinary tool; old sessions need no
  migration.
- A legal call whose registered name or alias is exactly `empty_tool_name` publishes the normal
  streaming/scheduled/result lifecycle, executes the handler and displays across
  live/cold/legacy product state — never hit by the empty-name silent filter.
- Missing/non-string names, provider-executed empty names, existing id normalization and general
  ToolCall hook lifecycle are unchanged.
- An 884-char malformed AskUserQuestion fixture yields `input={}`, warns once, never throws
  `invalid_model_response`.
- String `"null"`, native null, BOM, undefined, empty string and valid object all follow the matrix
  above.
- Partial JSON is never repaired.
- A required-schema tool receiving `{}` produces a same-id `is_error=true` tool result and the next
  model request in the same run.
- Tools accepting `{}` execute normally.
- Unregistered non-empty names produce a same-id `Tool not found` error result.
- In a parallel batch, malformed, normal and unknown calls all close before the next model request.
- The provider-visible next-round message uses `tool_use.input={}` with a paired
  `tool_result.is_error=true`; no raw malformed string/null appears.
- The first schema failure's `tool_result.content` uses the full
  `<tool_use_error>InputValidationError: ...</tool_use_error>` — never degrades to
  `Tool input failed inputSchema validation`.
- Session resume reuses the persisted string provider content; old sessions without that metadata
  keep using `state.error`.
- Missing, unexpected, wrong-type and non-parameter fallback ordering, newlines, singular/plural,
  paths and the Zod 4.0 JSON message are byte-for-byte verified against source goldens.
- When one input has both runtime-only and JSON-expressible constraints, an earlier field must not
  move after a later one via JSON-first merging; at minimum cover regex + sibling bound and field
  refine + sibling enum production schemas.
