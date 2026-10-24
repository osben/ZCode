# Todo 80: Streaming JSON Schema Output Support

> Status: draft, to be discussed
>
> Date: 2026-09-04

## Problem

`responseJsonSchema` takes effect only on the non-streaming `generateText` path:

```text
generateText -> passes and encodes the JSON Schema
streamText   -> currently does not pass the JSON Schema
```

This is inconsistent with "when JSON Schema is supported, requests follow the same contract", but production callers mainly use the non-streaming path, so it is unconfirmed whether this is a capability to widen now or a boundary to keep explicitly.

## Initial ideas

- Research separately whether streaming JSON Schema needs support and whether the result should be the final object or object increments.
- Prefer not adding a `ModelStreamEvent`: if only the final result is needed, take the complete object at stream end and reuse the existing result contract.
- If object increments are really needed, design the stream events and the Core/UI consumption chain separately; not assumed here.
- Research Anthropic Messages first; no other API Schema.

## Not handled here

No production code change; no change to non-streaming JSON Schema behavior; no full streaming event protocol; no PDF, tool-calling or Provider Config layering work.
