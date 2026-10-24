# Model Anomaly Fallbacks

## Document scope

Fallback strategies for model-anomaly behavior in the agent loop: excessive tool calls, repeated
tool calls, provider finishing anomalies, stream failures, context overflow, and malformed tool
calls.

Core principle: **ZCode targets long-horizon tasks — no hard stop on tool call count and no global
limit such as 100 calls.** Hard stops exist only for explicit resource or safety boundaries: user
cancellation, permission denial, tool timeout, output truncation, process termination, provider
retry limits, unrecoverable context overflow.

---

## 1. Common fallbacks

- No global hard `max tool calls` limit; `tool_calls` counts are metrics. Even when a `maxSteps`-
  style config exists, the runtime still passes tools to the model — it is a prompt-level soft
  limit.
- The turn loop is driven by `needs_follow_up`: execute tools and feed results back as long as the
  model asks; end only when there is no tool follow-up.
- Repeated identical tool + JSON input is a doom-loop signal, handled by permission confirmation
  or a model-visible warning.
- When the provider returns `stop` but also carries tool calls, process the tool calls instead of
  ending early.
- Malformed/unsupported tool calls are repaired first; on failure they become model-visible error
  output. Only fatal errors end the turn.
- Stream retry and request retry have separate limits; context limit can trigger auto compact.
- API/stream errors, context overflow, oversized tool output, and bash/webfetch timeouts each have
  their own fallback.

---

## 2. ZCode design principles

1. **Long-horizon first**: tool call counts are telemetry/diagnostic input only, never a runtime
   gate; no default call-count limit.
2. **Observable fallbacks**: every retry, compaction, and fallback emits an event carrying
   `traceId`, `turnId`, `spanId`, or a linkable parent/child relation.
3. **The model self-corrects first**: any anomaly warning is a model-visible prompt only — it never
   disables tools, throws `ToolMaxCalls`, or ends the turn.
4. **Resource boundaries stay hard**: tool timeouts, output size, process cancellation, permission
   denial, user interruption, and unrecoverable provider errors may hard-fail or interrupt.
5. **Never swallow errors**: low-level errors keep their original cause; only the loop boundary
   decides whether to convert them into a model-visible warning, a user prompt, or a turn error.

Model network retries are executed by ZCode's own adapter, not the AI SDK's internal retry.
Default retry count is 10, i.e. `maxAttempts = 11` in events; logs record both `maxAttempts` and
the derived `maxRetries`. Backoff supports exponential backoff, jitter, `retry-after-ms`, and
`retry-after`; a provider header overrides local backoff only when its wait time is reasonable.

---

## 3. Tool call counting policy

### 3.1 Config contract

`maxToolCalls` is no longer a runtime config. Tool call counts serve logs, traces, metrics, and
diagnostic views. No global tool call warning threshold is provided by default; if anomaly
reminders are needed later, they go into a separate guard config with non-blocking semantics.

```typescript
interface ModelAnomalyGuardConfig {
  /**
   * Optional: when cumulative tool calls in one turn exceed this value, inject a
   * warning to the model. No warning when unset. Not a hard stop.
   */
  toolCallWarningThreshold?: number;

  /**
   * How many consecutive identical tool name + stable JSON input occurrences
   * trigger a repeated-call warning. Default 3.
   */
  repeatedToolCallWarningThreshold?: number;

  /**
   * Maximum budget-style warnings injected per turn, so warnings themselves do
   * not become context noise. Default 3.
   */
  maxBudgetWarningsPerTurn?: number;
}
```

The historical `maxToolCalls` config must not affect runtime behavior. During migration the config
parser may ignore it or mark it deprecated, but core runtime must not read it or throw
`ToolMaxCalls`.

### 3.2 Runtime behavior

The runtime evaluates context/token compaction before every model request. As long as the model
still needs tool follow-up, tools keep executing and results keep flowing back. If active context
reaches the compact threshold, a mid-turn compact runs before the next model request and the task
continues after it succeeds. When the provider explicitly returns context overflow, each model-step
retry chain performs at most one reactive compact; in-place retries do not reopen compaction — the
guard resets only after a full tool result batch advances to the next model step. Auto/reactive
compact also share the `<3 tool turns / 3 consecutive refills` rapid-refill breaker: the
`next_turn` guard reset and the rapid-refill breaker.

Exceeding any total tool call number never changes the tools list, never injects
no-more-tools messages, and never ends the turn.

### 3.3 Event contract

```typescript
interface ModelAnomalyWarningPayload {
  category: 'tool_call_budget' | 'repeated_tool_call' | 'provider_finish_mismatch' | 'malformed_tool_call';
  severity: 'info' | 'warning';
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: string;
}
```

Event rules:

- `traceId` is required and reuses the current turn's.
- `turnId` is required.
- The event itself does not mean the turn failed.
- Warning text containing model input summaries must be redacted and truncated.

---

## 4. Repeated tool call warnings

Repetition is a stronger loop signal than totals. Identify consecutive repetition by
`toolName + stableJson(input)`:

- Default: 3 consecutive occurrences trigger a warning.
- Model warning only; repetition itself never hard-stops.
- Side-effecting tools still go through the permission system and tool contract for approval or
  denial.
- `stableJson` must use structured serialization, never plain string concatenation.

Warning content includes the tool name and repeat count but never the full sensitive input.

### 4.1 Exact definition of "consecutive"

The runtime keeps a repeated-tool-call streak scoped to one turn's lifecycle:

- The comparison key is `toolName + stableJson(input)`.
- Tool calls enter the streak check one by one in the order the model produced them; when one
  assistant response returns multiple tool calls, they are still processed in return order.
- The streak increments only when the **current** tool call's key exactly equals the **previous**
  one; otherwise it resets to 1 and switches to the new key.
- Runtime-injected events (`tool` results, permission events, scheduler events, compact events) do
  not participate in the comparison and do not by themselves interrupt the streak.
- Any new user input entering the current turn resets the streak, so continued attempts after an
  explicit user correction are not misread as a doom loop.
- A new turn resets the streak.

### 4.2 Warning trigger semantics

- The warning fires once, when the streak **first crosses** the threshold: with the default
  threshold of 3, the 3rd identical call triggers it; the 4th and 5th do not re-inject the same
  warning until the streak breaks and rebuilds.
- The warning both emits a session event and injects a visible `<system-reminder>` prompt before
  the next model request.
- The reminder exposes only `toolName` and the repeat count, never the full input; a redacted
  summary may stay in the runtime log.
- Once a turn's injections reach `maxBudgetWarningsPerTurn`, the event is still emitted with
  `warningInjected=false`, so reminders themselves do not become context noise.

---

## 5. Other model anomaly fallbacks

| Scenario | Fallback | Hard stop |
|----------|----------|-----------|
| Many tool calls | Telemetry/trace only; optional non-blocking warning | No |
| Consecutive identical tool calls | Model warning + event; permission policy for side effects | No |
| Provider `stop` with tool calls | Process tool calls first; record provider mismatch | No |
| Malformed tool arguments | Model-visible tool/function error so the model corrects | No, unless schema/adapter cannot build the feedback |
| Empty non-stop model result | Convert to `model_error`, emit `turn_error`, show in TUI transcript | Yes |
| Unsupported tool name | Feed back a model-visible error naming the available tool range | No |
| Stream dropped / idle timeout | Retry per provider policy; turn error at the limit | Yes at the limit |
| Request 429/5xx/network | Retry per policy, record attempts and backoff | Yes at the limit |
| Context overflow | Try auto compact; continue on success | Yes if compaction fails |
| Oversized tool output | Truncate and keep an artifact/ref | No |
| Tool timeout / user cancel | Aborted/timeout tool result or turn cancel | Per tool contract |

---

## 6. Follow-up implementation tasks

1. Contracts: add the `ModelAnomalyWarning` event and payload schema.
2. Runtime config: remove core runtime's `maxToolCalls` read path.
3. Runtime: delete the hard-stop logic that throws `ToolMaxCalls` above `maxToolCalls`.
4. Keep the normal tool follow-up sequence in prompt/message history; ensure >100 tool calls in a
   turn produce no special provider-visible message.
5. Add repeated tool call detection by consecutive identical `toolName + stableJson(input)`.
6. Tests:
   - >100 tool calls in one turn does not throw.
   - Tool result follow-up still runs after >100 tool calls.
   - Tool call counts never generate a provider-visible no-more-tools message.
   - Consecutive repeated tool calls trigger the repeated warning.
7. Keep resource hard-protection tests: tool timeout, output truncation, and user cancel still
   follow the tool contract.

---

## 7. Current implementation divergence

Target state: `packages/core/src/runtime.ts` no longer uses `maxToolCalls` as a hard limit; tool
call counts serve logging and result statistics only.

`packages/contracts/src/errors/index.ts` still contains `ToolMaxCalls`. It may stay temporarily for
compatibility with historical events or old tests, but the new runtime must not treat tool call
budget overflow as a turn error.
