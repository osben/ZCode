# Model Request Output Token Policy

How zcode-cli converts model-level `maxOutputTokens` into a per-request output budget. Desktop
local, remote workspaces and mobile web remote control share one agent request chain with one
policy.

## Model-level budget

ModelFactory creates the Active Model from the Effective Model Config. A normal Turn picks the
output budget from `model.optionSpecs.maxOutputTokens.max`, then applies this round's preflight cap;
Compact summary takes the smaller of that cap and 20,000. The final budget passes to the Model as
request-level `options.maxOutputTokens` — not part of a durable ModelSelection and never re-derived
from legacy Settings structures, Catalog, Provider ID or modelId.

```ts
const effectiveMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
```

32K is not a standalone global hard cap. A model declaring 64K yields 64K; declaring 16K yields
16K; there is no second `min(modelMaxOutputTokens, 32K)` clamp.

The builtin generic Model Config Rule declares the complete default Option Spec; specific models
and Personal Rules override only differing leaves. So the Active Model's
`optionSpecs.maxOutputTokens` is always complete; request-level budgets still validate through the
Model.

## Provider request fields

Core computes only the final `maxOutputTokens` for the round and attaches no request category or
provider field hints. The Active Model's `optionSpecs.maxOutputTokens.map` maps the final value to
the target API schema's raw JSON field:

- **Anthropic Messages**: usually `max_tokens`;
- **OpenAI Chat Completions**: usually `max_completion_tokens`; compatible protocols may declare
  `max_tokens`;
- **OpenAI Responses**: `max_output_tokens`.

The Adapter runs this map after AI SDK base serialization and protocol compatibility, before request
security checks and network send. It no longer passes a generic `maxOutputTokens` to AI SDK and has
no 32K fallback, Provider ID branches, fixed-thinking arithmetic or raw-field cleanup. The mapping
belongs only to the Model Config Rule matching the current `providerId/modelId/api.type/baseURL`;
the full contract is in
[Model Option Map and the raw request body](./working-memory/provider-refactor/design/model/model-option-map.md).

## Fixed budget policy (3.12.2)

All new runtimes (desktop local, remote workspace, mobile shared-host, pure CLI, subagents) use
`preflight-v1` uniformly. `client/configs.modelContextBudget.strategy` is no longer consumed; the
protocol field still accepts `legacy` for old Hosts but this runtime normalizes to the shared
constant `DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY`. Running old processes do not hot-switch;
runtimes created or cold-recovered after upgrade use the new rule.

`getModelContextBudgetStrategy()` keeps its service-compatible signature but returns only the shared
constant — no cache reads, requests, timers or background refresh. The local Host and remote
workspace preference bridges use the shared constant; `runtime-materialization` and
`user-execution` read only the necessary local Settings with scope isolation intact. The budget
value is never written to Settings, database or provider config; existing client-config requests
and other consumers are unchanged.

```text
necessary local Settings + fixed preflight-v1 -> runtime preferences -> Runtime -> subagents
client/configs -> plan/page/actual off-peak tool creation (not part of budget or chat startup)
```

Rationale: the old selectable algorithm waited up to 5 s on the remote per runtime creation,
serially amplified by repeated creation. The unified rule deletes remote selection and legacy
branches without extra caches, timeouts or background compensation.

## Auto Compact input window

Uniformly reserve at most a 21K output window; the legacy 95% threshold no longer applies:

```ts
const outputReserve = Math.min(effectiveMaxOutputTokens, 21_000);
const inputWindow = Math.max(0, contextWindow - outputReserve);
const compactThreshold = Math.max(0, inputWindow - 13_000);
```

With 128K context and 64K output, reserve is 21K, effective input 107K, compact threshold 94K.
Passing `legacy` or an old percent override does not change the algorithm; output caps below 21K
are kept as-is. Auto Compact token sourcing, the 13K buffer, failure circuit breaker and timeline
semantics are unchanged.

## Main request preflight cap

Before each main model step (including tool continuations) is sent, reuse Auto Compact's existing
usage estimation: scan back from the tail of the current provider-visible message projection for
the most recent committed real assistant with valid `tokens`. That assistant's provider usage is
the context baseline; only messages after it get local incremental estimation; with no valid
assistant, do a full local estimate. Usage attribution comes from the existing
`AssistantMessageInfo.tokens` — no second `providerUsage` persistence field, no persisted absolute
message index as anchor. Uncommitted responses never join the scan. After Compact replaces the old
provider-visible prefix, a preserved assistant's original usage no longer represents the current
context: runtime and cold-start projections zero the usage only on the preserved copy. Assistants
added after Compact keep their own tokens; original tokens in the persisted transcript are never
modified. Old Compact data without a preserved segment keeps the compatibility path.

Local increments reuse Compact's shared estimator: each message estimates
`ceil(provider-visible chars / 3)`; assistant tool call names and serialized arguments count toward
the characters. OTB09 locks the boundary with `inputTokens=1` and a 255,984-char user message; the
provider usage anchor already covers the previous assistant, so the suffix estimates only new user
messages after it: `estimatedCurrentUsage = 1 + 85,328 = 85,329`. With a 128K context this round
sends `max_tokens = 128,000 - 85,329 - 1,000 = 41,671`.

```ts
const estimatedAvailable = Math.floor(contextWindow - estimatedCurrentUsage - 1_000);
const finalMaxOutputTokens =
  Number.isFinite(estimatedAvailable) && estimatedAvailable > 0
    ? Math.min(effectiveMaxOutputTokens, estimatedAvailable)
    : effectiveMaxOutputTokens;
```

- No minimum sendable, no `<3000` branch; 2,999 or 1 is sent as computed.
- The Reasoning Map and output-cap Map each read their own final Option value; core does not infer
  a provider thinking budget here.
- The cap belongs to the current model step only — no mutation of request, Settings or model config;
  recomputed after Compact.
- Compact summary, title, TCV, workspace/internal requests do not use the preflight cap.
- Still over-window after capping: no provider number parsing or reduction retry; existing error
  classification and reactive compact continue.

### Mixed-length smoke contract

Two fixed seed sets validate the full chain from baseline, continuous cap to Auto Compact:

| Scenario                            | effective input window  |                cap start | Auto Compact threshold |
| ----------------------------------- | ----------------------: | -----------------------: | ---------------------: |
| `64K context + 48K maxOutputTokens` |      `64K - 21K = 43K` |  `64K - 48K - 1K = 15K` |     `43K - 13K = 30K`  |
| `200K context + 128K maxOutputTokens` |  `200K - 21K = 179K` | `200K - 128K - 1K = 71K` |   `179K - 13K = 166K`  |

```text
empty session
   |
   v
fixed-seed real user messages of varying lengths
   |
   +-- estimated usage <= cap start --> max_tokens=baseline
   |
   +-- cap start < estimated usage < Auto Compact threshold
   |        `--> max_tokens=min(baseline, context - usage - 1K), monotonically shrinking for at least two rounds
   |
   `-- estimated usage >= Auto Compact threshold
            `--> Auto Compact summary(max_tokens=20K)
                                      |
                                      v
                              continue the original pending user message
                                      |
                                      v
                              recompute the cap from post-compact usage
```

The 200K/128K tail uses a few fine-grained messages to push actual `max_tokens` to ~34.3K and
~33.1K; the theoretical boundary is `200K - 166K - 1K = 33K`. The first message crossing the 166K
threshold must Compact first and must not send a main request at or below 33K. This covers both
sides of the boundary without many tiny turns.

"Using up the window" here means reaching the effective input threshold defined by the 21K preserve
and 13K buffer together — never bypassing Auto Compact to fill the raw context window. The tests
fix only two input-length sequences and synthetic provider usage; no runtime random seeds, provider
errors, tool calls, queue or remote-control combinations.

## Compact request boundary

Compact summary uses the smaller of the effective value and the existing 20K task budget:

```ts
const compactSummaryMaxOutputTokens = Math.min(effectiveMaxOutputTokens, 20_000);
```

So effective=16K uses 16K for the Compact request; effective=64K uses 20K. Compact decides only
this round's `maxOutputTokens` value; it projects onto the final raw request body through the same
Option Map chain as the reasoning level, with no adapter fixed-thinking budget conversion.

## Output-limit continue recovery

Normal Main Agent, subagents and workflow children share one output-limit recovery path. A
successful model response with no complete tool call enters recovery on any of:

- normalized `finishReason === "length"`;
- raw reason `max_tokens`, `max_output_tokens` or `model_context_window_exceeded`.

A successful response's `model_context_window_exceeded` with a valid partial still recovers via
Continue. The only new exception: explicitly over-window with no body, valid reasoning (including
opaque metadata) or complete tool call — the Adapter converts it to the existing
`ModelContextExceeded` before a successful finish, Core's existing exception path runs reactive
compact and retries the request, appending no Continue. Usage does not participate in the
empty-output decision.

Empty content previously going through three Continues was intentional; only that empty over-window
boundary changed. Valid partials keep body/thinking and continue per the original rules; plain
`length` and output token caps are unchanged; Core's existing successful over-window compatibility
branch and its explanatory comments stay. The Adapter does not decide Continue-ability and does not
change non-streaming metadata pass-through.

Protocol adapter normalization boundary — the runtime consumes only normalized/raw facts and never
re-infers from HTTP event names:

| Protocol             | provider raw terminal state                                              | adapter normalized finish reason |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------- |
| Anthropic Messages   | `stop_reason=max_tokens`                                                 | `length`                        |
| Chat Completions     | `finish_reason=length`                                                   | `length`                        |
| OpenAI Responses API | `response.incomplete` + `incomplete_details.reason=max_output_tokens`    | `length`                        |

Some non-standard OpenAI-compatible services return `finish_reason=max_tokens` on Chat Completions.
AI SDK keeps `rawFinishReason=max_tokens` for the unknown enum and the normalized value may be
`other`; the runtime's raw-reason compatibility branch still recovers. The adapter focused wire
test pins that `other + raw=max_tokens` case; Desktop OTC11 uses both standard protocols' native
terminal states to verify end-to-end normalization. Once the runtime confirms an output limit for
the step from normalized/raw reason plus complete tool-call facts, it must unify the canonical
`finishReason` to `length` before emitting `ModelComplete`, usage facts and the transcript finish;
adapter network/model-io, runtime diagnostics and `providerMetadata.rawFinishReason` keep the
provider's raw facts.

True request-error context overflows are out of scope here and keep the existing reactive compact.
A complete tool call outranks output-limit; the check uses all tool calls the adapter assembled,
not only locally executable ones. Only on the output-limit criteria above may a response empty of
text, reasoning and usage recover; other empty responses stay on the suspicious-empty error path.

Recovery appends at most 3 user-role Continues, so one recovery chain produces at most 4 normal
model requests. The copy must stay exactly:

```text
Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.
```

A Continue is a query-local plain user message, never wrapped as `<system-reminder>`. It is visible
to this round's later provider requests but never enters canonical `MessageHistory`, session
events/transcript, UI user bubbles, hydration, fork/edit input, or latest-real-user detection. At
Turn end the query-local state dies outright — no cleanup, history cursor sync, or full copyback.

Compact respects the same boundary: even if the to-summarize part contains earlier Continues, the
actual provider request keeps them, but the `querySource=compact` `ModelRequest` event must use the
filtered recordable projection — never write the actual request array into the event. Regression
covers reactive Compact after two Continues: Continue visible to the summary request, invisible to
events and persisted messages. Anthropic wire acceptance covers one and three Continues: after
adjacent user merging, the exact copy and its occurrence count are unchanged, with no
`<system-reminder>` wrapper.

```text
Turn entry
  query.entries = [...borrowReadOnlyRuntimeEntries()]   # O(n) pointer shallow snapshot
        |
        v
each outer loop
  requestEntries = [...query.entries]                   # shallow spread before request
        |
        +-- output-limit --> query = [...request, partial assistant?, Continue]
        +-- tool ---------> query = [...request, assistant, tool results]
        +-- Compact ------> query = compactResult.entries
        `-- normal end ----> Guide / Stop Hook / Turn complete
```

Entry/message/content are used as immutable values once in `MessageHistory` or query state.
Synchronous immediate read-only use goes through `borrowReadOnlyRuntimeEntries()`; across `await`
at query/compact boundaries only array pointers are copied, never `toRuntimeEntries()` deep clones.
Provider projection is the only necessary content-clone boundary before a request.

### Partials, Compact and external input

- With real text or reasoning, the current assistant commits via the existing step path; when
  recovery is unexhausted and both are empty, no empty assistant is appended to canonical or
  query-local history. The exhausted 4th-attempt durable error boundary is in the next section.
- `TurnResult.response` still returns only the last real model response; partials are never
  concatenated into one string.
- The output-limit branch returns to the outer loop before Guide and Stop Hook; both resume normal
  behavior after the recovery chain ends normally.
- During recovery, pause pending runtime commands, async project-memory updates and new runtime
  notice consumption so that `partial assistant → Continue` is atomic; Abort, micro/auto compact,
  MCP/tools, projection and token budgeting keep running.
- Micro/auto/reactive compact uses the current query-local entries. The compact boundary and
  summary persist immediately per existing rules; standalone Continues are filtered from canonical
  post-compact entries, and the recovery count is not reset by compact. Manual compact has no
  query-local input and keeps using canonical history directly.
- Compact recent-preserve keeps its boundary: normal assistants may enter the preserved segment;
  transcript error carriers with `info.error` never enter provider history. On exhaustion, real
  partials and the error carrier persist separately, so compact's message classification needs no
  extension.
- The recovery chain is one atomic Turn: model, language or output-style refreshes inside the chain
  never rewrite the current query-local prefix; if a refresh races a turn-local compact, the compact
  commits canonical history keeping the already-refreshed canonical prefix, so changes take effect
  only in the next independent Turn.
- The canonical transcript still saves every real partial assistant per request, and
  `TurnResult.response` still returns only the last response; display reduction happens only in the
  V4 ProductProjection. Only when `ModelComplete` explicitly carries `stopReason="length"`,
  `toolCallCount=0`, and the next body is in the same product turn visually adjacent to the previous
  `assistantText` does the projection reopen the original row and append directly, inserting no
  newline. The final row's stable `rowId` is unchanged; message/action identity advances to the
  last assistant. Tools, reasoning, visible users, timeline, different product turns, non-`length`
  and missing tool-call facts all keep the original segmentation.

```text
p1 text ─ ModelComplete(length, tools=0) ─ p2 text ─ ... ─ p3 text
   │                  same turn, adjacent                  │
   └──────── ProductProjection: same assistant row ────────┘

tool / reasoning / user / timeline / turn boundary
   └──────── ProductProjection: new assistant row
```

### Exhaustion and usage

When the 4th response still hits the output limit, no 5th request is sent. If it has real text or
reasoning, commit it first as a normal assistant without `info.error` with its real usage; then
write a separate error-only assistant with a new message ID and matching `step-finish` to the
session transcript. If the response is fully empty, write only the error-only carrier. The
carrier's `tokens` are zero placeholders: never a usage anchor, never in live or cold-hydrated
provider history. It reuses the existing assistant error structure: the stable error code in
`error.name`, `data.message/retryable/attribution` restoring the message, UI recoverable flag and
provider source — no generic hydration extension. Request-level real usage is still recorded by the
existing `ModelComplete` and usage observability. The existing `ModelError` / `TurnError` funnel
then shows the error in the live UI with no `TurnComplete(success)`. The error only terminates the
current Turn command: no new `CoreErrorType`, no agent runtime or interactive CLI shutdown, and the
error display copy never enters provider history. All the above output-limit reasons use the
neutral copy `The model's response exceeded the output token maximum.`.

The recovery chain keeps no extra usage snapshot or absolute message cursor. Partial assistants
with real text, reasoning or tool calls commit to canonical and query-local history with their
normalized `tokens`; the next request reuses the existing backward scan from the latest valid
assistant usage, locally estimating only later Continues and messages. Empty output limits produce
no assistant entry or transcript message in the first three recovery middle states; at exhaustion
only the durable error-only assistant remains. After live and cold hydration it neither overwrites
the last valid usage nor enters provider history; with a real partial, the normal assistant keeps
its original usage while the separate error carrier stays zero-usage. After recovery ends, the
query-only Continues vanish naturally and the next independent user message still sits after the
latest canonical assistant, so no re-anchoring or temporary usage cleanup is needed. Compact keeps
deriving its baseline from the post-compact entries' own assistant tokens, with no Continue-specific
invalidation.

### Automation evidence boundaries

Continue automation is layered by responsibility; the same state matrix is not copied into Desktop:

- Core runtime tests cover normalized/raw reason, empty responses, text/reasoning partials, the
  three-attempt cap, exhaustion, partial assistant vs error-only carrier separation, the carrier's
  zero usage/provider isolation and cold error recovery, streaming/non-streaming/tool priority,
  Abort, Guide/Stop Hook, external notices, the shared Main/subagent loop, and raw-compatible
  output-limit unification to live/durable `length`.
- Compact focused tests cover micro/auto/reactive handling of query-local entries and the recovery
  count not resetting on compact; existing manual compact tests keep proving the canonical default
  path.
- Agent E2E uses a local scripted OpenAI-compatible provider through the bootstrap app, real
  adapter, HTTP request, SessionStore and cold recovery, verifying exact Continue wire, no 5th
  request, real partial persistence, the exhausted durable error-only assistant, continuation into
  the next Turn/runtime, and neither the carrier nor Continues leaking into cold-recovery requests.
- E2E helpers must wait for async app creation and pass through `resume/sessionId`; cold-recovery
  assertions confirm session identity and original history, not merely that the new request has no
  Continue. Case-declared context/output caps must enter a complete valid Provider Registry; the
  output Option Map writes real request bodies per protocol. The Continue case fixes 100,000 context
  and 16,000 output; both normal recovery and cold-recovery requests assert `max_tokens=16000`,
  never overwritten by a helper's generic default.
- ProductProjection focused tests verify the live strict reuse predicate, accumulated body, final
  action/message anchors and boundary negatives; transcript hydration focused tests verify that
  persisted `assistant.info.finish="length"` rebuilds the same cold result without injecting the
  Continue user into events or protocol.
- Desktop OTC08 uses a case-local provider replay verifying that three real main requests end as a
  single accumulated assistant DOM block; this pending manual-review case does not enter the default
  conversation gate until confirmed.
- Desktop OTC11 pushes OTC09's same Markdown seam through Chat Completions and the Responses API,
  verifying both standard protocols normalize to `length`, trigger the same Continue chain and form
  one accumulated assistant DOM block.
- The OpenAI-compatible adapter wire test pins non-standard Chat `finish_reason=max_tokens` mapping
  to normalized `other` with `rawFinishReason=max_tokens`, so Desktop standard-protocol cases are
  not confused by compatible inputs.
- The Anthropic wire test only adds the exact copy after adjacent user serialization; the full
  recovery loop is not duplicated per BYOK provider.

Continue creates no new user row, protocol event, delivery state or React special case. Desktop
`continuous` and mobile `replayable` consume the same server-side ProductProjection result; live
`TurnError` mapping to the existing product projection stays with the bootstrap error-projection
tests.

## Derived child runtimes

Subagents inherit the context-budget strategy fixed at parent runtime creation; after the actual
`childModelRef` resolves, they read that model's `contextWindow` and `maxOutputTokens` from the
current runtime catalog/overlay and build the child runtime with the same 32K fallback formula.
Registry refresh affects only later-created children; running children never change budget
dynamically.

Normal workflow children and script workflow children are created from the parent main runtime's
`runtimeConfig`, so they likewise inherit the strategy fixed at parent creation; they do not request
a strategy from the Host separately and never hot-switch mid-run. This policy changes nothing else
about workflow children's lifecycle, model selection or tool behavior.

## Context exceeded recovery

The adapter recognizes provider-explicit over-context errors from Error, `cause` and the standard
JSON response body. Both `error.code` and `error.message` of the standard body are inputs; the
outer `APICallError.message` alone is not enough because compatibility layers often rewrite it to
`Bad Request`.

Only forms stably distinguishable from other 400/422 errors in official docs or repos are
collected:

| Source                         | Recognizable signal                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| OpenAI-compatible / Azure OpenAI | existing context codes like `context_length_exceeded`; or an explicit token-limit message like `maximum context length` |
| Anthropic                      | `prompt is too long`; the existing `model_context_window_exceeded` stop reason/code                  |
| Google Gemini                  | `input token count ... exceeds the maximum number of tokens allowed`                                 |
| Alibaba Cloud Model Studio     | `Range of input length should be [1, ...]`; `Total message token length exceed model limit`          |
| BigModel                       | existing provider business code `1261`                                                              |

References:

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Anthropic context window overflow behavior](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-overflow-behavior)
- [Azure OpenAI Chat Completions context error](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
- [Google Gemini CLI official repository issue #10199](https://github.com/google-gemini/gemini-cli/issues/10199)
- [Alibaba Cloud Model Studio error codes](https://help.aliyun.com/en/model-studio/error-code)
- [Mistral known limitations](https://docs.mistral.ai/resources/known-limitations)
- [DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes/)
- [MiniMax error codes](https://platform.minimaxi.com/docs/api-reference/errorcode)
- [Amazon Bedrock runtime errors](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)

OpenAI Responses with auto-truncation off only promises a `400` with no stable dedicated error
content; Mistral only documents generic `400 Bad Request`; DeepSeek only lists generic `400 Invalid
Format` / `422 Invalid Parameters`; Amazon Bedrock only gives generic `ValidationException` /
`400`. These statuses are not stably distinguishable from other invalid requests, so there is no
status-code fallback. MiniMax `1039` can also mean an output `max_tokens` limit and is not
classified as context overflow.

On a hit, classify as `ModelContextExceeded` and hand to core's reactive compact — at most once per
model-step retry chain; it reopens only after the full tool result batch enters the next model
step:

```text
provider error
      |
      v
adapter context signal classifier
      |
      +-- no hit --> existing 400/422 classification
      |
      `-- hit --> ModelContextExceeded
                     |
                     v
              reactive compact
                     |
                     v
             replay current model step
```

The recovery path reuses the compact module's fast backfill circuit breaker; the adapter adds no
second retry or compaction state.

## Constraints

- The Effective Model Config's Option Spec declares the output cap; the execution chain computes
  the request budget from it; ModelSelection stores no output budget.
- The builtin generic Rule provides complete defaults; if 32K is a default it may only be declared
  there, never as a request-path fallback.
- Main requests, Target Completion Verification, Auto Compact and Microcompact use the same
  effective value.
- Compact summary uses `min(effective, 20_000)`.
- Provider field differences are expressed only by the current Effective Option Spec's `map`; the
  generic budget result is unchanged.
- All Option Maps run at the final JSON request body boundary, before the official request security
  checks.
- Only an optional strategy was added to the existing session runtime preferences protocol,
  defaulting to `preflight-v1` when absent; no new public capability, Settings entry or global
  environment variable.
- Non-output-limit empty-completion states, existing reactive compact counts, error recognition and
  other automatic retries are unchanged.
- `legacy` remains protocol-input compatibility only, with no runtime algorithm branch.
