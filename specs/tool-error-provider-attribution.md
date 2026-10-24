# Provider failure facts in failed tool results

Status: implemented, pending review.

## Problem

When a foreground Agent tool call fails because its child hit a terminal provider error, the parent model sees only the error text, for example `request has been blocked due to unusual activity.`. The child error carried attribution (`statusCode: 405`, `providerErrorCode: "3012"`, `retryable: false`), but none of it reached the parent. Without those facts the parent model invents causes and retry plans ("probably a concurrency limit").

Related but separate: `specs/subagent-inherited-model-invocation-context.md` (session-type classification of inherited subagent models). The 405/3012 block itself is provider-side and is not explained or handled here.

## Facts from the code (at the time of the spec)

- `apps/zcode-cli/packages/core/src/errors/error-payload.ts` `projectExecutionErrorPayload` already projects `attribution` from the cause chain (`source`, `statusCode`, `providerErrorCode`, `retryable`, plus `providerId`, `modelId`, …). The innermost non-wrapper `retryable` wins over the turn wrapper's `retryable: true`.
- `apps/zcode-cli/packages/core/src/tool/executor/errors.ts` `createErrorResult` drops `projectedError.attribution`.
- `apps/zcode-cli/packages/core/src/runtime/helpers/tool-result.ts` `stringifyToolResultOutput` returns `modelContent` when set, else `error.message`.
- Persistence (`runtime/methods/tool-result-settlement.ts`) saves a string `modelContent` into the error part's `metadata.modelContent`; cold resume (`agent/session-history-hydrator.ts`) replays that string, else `state.error` (= `error.message`). Model-facing text that is not stored as `modelContent` would differ between the live run and a resumed session.
- `tool/executor/call-runner.ts` rebuilds `modelContent` from `error.message` when PreToolUse/PostToolUseFailure hooks add context; only handler failures keep their own `modelContent`.
- `result.error` is emitted as `ToolCallErrorPayload.error: ErrorPayload`. `ErrorPayload.attribution?: ErrorAttribution` already exists in `@zcode/contracts`; the v1 `tool.updated` error payload uses the strict `zcodeProtocolErrorDetailSchema`, which already declares `attribution`, and the v4 projection copies only `type`/`message`. No wire-contract change is needed.
- The foreground child turn throws the live error chain (`runtime/methods/turn.ts` throws `createTurnFailureError(error)` with the adapter error as `cause`), and the Agent handler does not catch it, so it reaches `call-runner`'s catch and `createErrorResult`.
- The adapter (`adapters/src/model/runner-retry.ts`) sets `source: "provider"` whenever the failure has an HTTP status or is a provider business error.

## Product rules

1. `ToolExecutionResult.error.attribution` carries a safe subset of the projected attribution: `providerErrorCode`, `statusCode`, `retryable`. Never credentials, URLs, request/trace ids, provider ids or model ids.
2. The subset is set whenever any of the three fields is present, for every tool. `createErrorResult` is generic: no tool-name branches.
3. Model-facing text gets the facts only for a terminal provider failure: projected `attribution.source === "provider"`, `attribution.retryable === false`, and at least one of `statusCode` / `providerErrorCode`.
4. For such a failure the text is the existing message, a blank line, then one factual line:
   `Provider failure: status=<statusCode> provider_error_code=<providerErrorCode> retryable=false`
   (missing fields are omitted). No guessed cause, no retry instruction.
5. The text is stored as `result.modelContent`, so persistence and cold resume replay the same text the live run sent.
6. When hooks add context to a failed result, the base text keeps the provider facts line.
7. Everything else keeps today's text: retryable failures (429, 5xx), `source` other than `provider` (or missing), handler failures (`<tool_use_error>` content), input-validation errors, permission denials and plan/workflow feedback.
8. No matching on message text (for example "unusual activity"). No cooldown, no retry-policy change.
9. `error.message` (UI and logs) is unchanged.

## Source of state

- Facts: the adapter's error context, projected by `projectExecutionErrorPayload`.
- Owner of the model-facing text: `createErrorResult` (sets `modelContent`). `call-runner` only appends hook context to it.

```
adapter error {source, statusCode, providerCode, retryable:false}
  └─ turn failure wrapper (retryable:true) └─ Agent wrapper (Wrapper role)
        │ thrown out of the Agent handler
        ▼
call-runner catch → createErrorResult
        ├─ error.attribution = {providerErrorCode, statusCode, retryable}
        └─ modelContent = message + "\n\nProvider failure: …"   (terminal provider only)
        ▼
call-runner hook context (optional, appended to modelContent)
        ▼
settlement: model history ← modelContent; persisted metadata.modelContent ← same string
        ▼
cold resume replays metadata.modelContent
```

## Interface

- `tool/types.ts`: `ToolExecutionResult.error.attribution?: ToolErrorAttribution`, where `ToolErrorAttribution = Pick<ErrorAttribution, "providerErrorCode" | "statusCode" | "retryable">`.
- `tool/executor/errors.ts`: `createErrorResult` fills `error.attribution` and, for terminal provider failures, `modelContent`.
- `tool/executor/call-runner.ts`: the hook base text uses the attributed `modelContent` when `createErrorResult` set one.

## Out of scope / follow-ups

- Background Agent failures (`subagent/runner.ts` `finalizeBackgroundFailure`) report through task notifications, not `createErrorResult`; they still carry only the message.
- Provider business errors normalized by `createCoreErrorFromProviderBusinessLike` set no `source`, so they get no facts line until that attribution gap is fixed at the source.

## Acceptance

- Through the real `createExploreSubagentPort` foreground run (`tests/subagent-selection-error-runner.test.ts`): a child that throws the turn failure wrapper around the adapter error yields a parent tool result with the facts line.
- An Agent tool call whose child fails with `{source:"provider", statusCode:405, providerCode:"3012", retryable:false}` behind the turn and Agent wrappers: the parent tool result text contains `status=405`, `provider_error_code=3012`, `retryable=false`, and no provider id, model id or request id. `error.attribution` equals exactly `{providerErrorCode:"3012", statusCode:405, retryable:false}`.
- A retryable 429 provider failure: text is exactly `error.message`, no `modelContent`.
- A non-provider failure with `retryable:false`: text is exactly `error.message`.
- With a PostToolUseFailure hook context, the terminal provider facts line stays in `modelContent`.
- Existing `tool-executor-error` and `tool-hook-context` tests pass unchanged.
