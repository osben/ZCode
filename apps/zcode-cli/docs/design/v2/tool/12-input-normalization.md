# Tool Input Normalization Design v2

Implementation status (2026-05-08): landed. The adapter layer handles stringified tool input returned by `generateText()` and `streamText()` in `packages/adapters/src/model/tool-input-normalization.ts`; the executor layer runs a top-level JSON safe parse and `runtimeInputSchema.safeParse()` uniformly on the initial input, on input updated by a `PreToolUse` hook, and on input modified by the permission broker, in `packages/core/src/tool/input-normalization.ts`. Regression coverage is in `packages/adapters/tests/tool-input-normalization.test.ts` and `packages/core/tests/tool-input-normalization.test.ts`, including malformed JSON degradation, runtime schema defaults, hook updated input and broker modified input.

## Background

Some provider / model adapters return tool input as a JSON string instead of an object. For example:

```json
{
  "name": "Bash",
  "input": "{\"command\":\"python3 -c \\\"print(1)\\\"\"}"
}
```

If the runtime hands this string directly to the tool handler, `inputSchema` / the runtime schema easily fails before execution, and in the worst case the exception path spreads to boundaries that should not crash. ZCode v2 converges such abnormal input into a "recoverable input error", instead of letting the process die from an unexpected exception in JSON parsing or tool parsing.

## Goals

1. Be compatible with the provider anomaly of "top-level tool input wrapped as a JSON string".
2. The compatibility logic must have two layers, so that all dirty-input assumptions are not pushed onto a single tool handler.
3. Both layers must use safe parse; a parse failure may only degrade, record a diagnostic and continue on the recoverable error path, never crash the process directly.
4. Tool-aware normalization must go through an explicit contract; modules outside the handler must not depend on a tool's internal implementation details.

## Two-layer strategy

### Layer 1: generic Model Adapter normalization

Location: `packages/adapters/src/model/*`

Responsibilities:

- When the provider returns `toolCall.input` / `toolCall.args` as a string, try to parse it as JSON.
- If parsing succeeds, pass the parsed value downstream as the tool call input.
- If parsing fails, keep the original string and record minimal diagnostics, such as tool name, source stage and string length.
- The diagnostics must not contain the full original input, to avoid leaking user content in logs.

Failure semantics:

- Must not throw.
- The adapter layer must not forge a failed input into a valid business object.
- After a failure the original value is still handed to layer 2 / the executor, so later schema validation returns a structured error.

Coverage:

- `toolCalls` of `generateText()`
- `tool_call` events in `streamText()`

### Layer 2: Tool-aware normalization in the Tool Runtime

Location: `packages/core/src/tool/*`

Responsibilities:

- Before `validateInput`, permission, hook and handler, the executor runs one more tool-aware normalization of the tool input.
- This layer first retries the residual "top-level string JSON", covering non-adapter sources such as old transcripts, hook-modified input and permission-broker-modified input.
- It then uses `runtimeInputSchema.safeParse()` for safe normalization:
  - On success, execution continues with the parsed, standardized result.
  - On failure, the previous step's input is kept and the existing `inputSchema` validation and recoverable error return continue.

"Tool-aware" here means:

- Each tool's runtime schema decides defaults, field pruning, strictness and extra constraints.
- The executor does not hardcode the internal rules of Bash / Read / Edit; it only consumes the explicit `runtimeInputSchema` contract.
- If a tool later needs legacy field mapping or more complex compatibility, it must be extended in the same layer, not scattered inside handlers.

Failure semantics:

- A `safeParse` failure must not throw.
- A failure must degrade to the normal schema validation / permission error path.
- After a hook or permission broker returns `modifiedInput`, layer 2 normalization must run again.

## Execution order

The tool runtime scheduling order:

1. The adapter layer normalizes the raw tool input returned by the provider
2. Executor-layer tool-aware normalization
3. `validateInput`
4. `PreToolUse` hook
5. If the hook updated the input, run layer 2 normalization again
6. permission check / broker
7. If the broker modified the input, run layer 2 normalization again
8. handler execution

## Non-goals

- Automatic expansion of arbitrarily deep recursively nested string JSON is not supported in this implementation.
- Do not bypass a tool's explicit schema to accommodate wrong input.
- Do not silently replace malformed JSON with a default business object and continue to run a tool that has side effects.

## Test requirements

Cover at least these scenarios:

1. The adapter layer successfully restores a stringified object to an object.
2. The adapter layer does not throw on an invalid JSON string and keeps the original value.
3. The stream `tool_call` event uses the same normalization strategy.
4. The executor layer can still restore a stringified object to an object when the adapter did not handle it.
5. The executor layer consumes defaults or the standardized result of `runtimeInputSchema.safeParse()`.
6. The executor layer does not throw on an invalid JSON string and returns the existing recoverable input error.
7. When a `PreToolUse` hook returns `updatedInput`, the executor must run layer 2 normalization again.
8. When the permission broker returns `modifiedInput`, the executor must run layer 2 normalization again.
