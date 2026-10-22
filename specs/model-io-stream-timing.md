# Model-io stream timing

## Problem

A model-io record has `startedAt`, `completedAt` and `durationMs`, but no time-to-first-token. The adapter already measures it (`timeToFirstProviderEventMs`, `timeToFirstContentMs`, `timeToFirstTextMs` in `runner-stream.ts`) and publishes it only in the in-memory `model_request_completed` status and debug log lines, so no durable record can split a call into waiting and decoding. The persisted `model_usage.time_to_first_token_ms` is keyed by assistant message, not by `requestId`, counts only text and reasoning deltas, and is empty for most tool-call responses.

## Owner

Runtime writer: `recordStreamTextDebug` and `recordGenerateTextDebug` in `apps/zcode-cli/packages/adapters/src/model/runner-debug.ts`, fed by the stream locals in `runner-stream.ts`. Readers: the Host trajectory v2 projection (`specs/model-trajectory-v2.md`). The v1 reader ignores the field.

## Contract

Every model-io record written by this build carries a top-level `timing` object. It is top level because `response` is absent when a call fails before producing output.

```json
"timing": {
  "stream": true,
  "timeToFirstProviderEventMs": 412,
  "timeToFirstContentMs": 655,
  "timeToFirstTextMs": 1890
}
```

## Product rules

1. All values are integer milliseconds measured from the attempt's `startedAt`, the same origin as `durationMs`. They include admission wait and auth or model resolution that happen after `startedAt`.
2. `timeToFirstContentMs` is the trajectory TTFT: the first text, reasoning or tool-input event. Decoding time is `durationMs - timeToFirstContentMs`.
3. A streaming call writes `stream: true` and each measured value. A value that was never reached (for example no text in a tool-only response) is omitted, never written as `null` or `0`.
4. A streaming call that fails after the first event writes the values measured so far. A failure before any event writes `{ "stream": true }` only.
5. A non-streaming call writes `{ "stream": false }`. It has no TTFT.
6. The field is additive. Production trimming, compaction and redaction keep it. Records written before this change have no `timing`; readers show TTFT as unknown.
7. Field names match the existing `model_request_completed` status so the two never drift.

## Acceptance scenarios

Unit tests: `apps/zcode-cli/packages/adapters/tests/runner-debug-stream-timing.test.ts` (included in the root vitest config so CI runs it).

1. A successful stream records all three values, each at most `durationMs`.
2. A stream that fails after the first event records the partial values.
3. A stream that fails before any event records `{ stream: true }`.
4. A generate call records `{ stream: false }`.
5. A production (non-development) record keeps `timing` after trimming.
