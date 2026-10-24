# Model attempt error diagnostic fields

## 1. Background and goal

`model_attempt` kept only the normalized error message. A stream failure wrapped as
`TerminalStreamChunkError` can hide the real network exception in the wrapper's cause chain, so ARMS only
saw `terminated` and could not tell connection reset, DNS, TLS or another transport error apart.

When a failed `model_attempt` span ends, keep the existing sanitized fields and additionally write
diagnostics from the end of the cause chain: `error.cause.type`, `error.cause.code`,
`error.cause.message`. Values go through the existing error sanitizer with the same length and charset
limits as `error.type` / `error.message`; never write request bodies, credentials or full response
content.

## 2. Collection rules

1. `TerminalStreamChunkError` exposes the wrapped error as `cause` so classifier and telemetry can read
   the original exception.
2. Cause fields are written only when a nested error exists and the source error is claimed for the
   first time; parent spans do not repeat the error body.
3. Without a cause chain behavior is unchanged; a telemetry field failure must never affect the model
   request.
4. Traversal follows one wrapper chain, cause first, then adapterError, then error; the original
   eight-level cap and cycle detection stay (no scanning of arbitrary error object properties). A plain
   Error or self-referencing cause never registers itself as the root cause.

## 3. Query example

```sql
json_extract_scalar(attributes, '$["error.cause.type"]')
json_extract_scalar(attributes, '$["error.cause.code"]')
json_extract_scalar(attributes, '$["error.cause.message"]')
```

Aggregate with `zcode.model_attempt.error_category`, `zcode.model_attempt.failure_stage`, HTTP status and
request/session id.

## 4. Todo103 merge boundary and acceptance

Source `79413e33cb`. The old `registry.ts` and nested `statusContext.model` are not restored; model
selection, retry count, request fields and user-visible error copy are unchanged.

- G13-A01: the terminal stream wrapper keeps the real cause; without a cause it keeps adapterError;
  message and adapterError identity do not change.
- G13-A02: nested causes are sanitized; plain errors and self-references yield no invented cause; deep
  chains and cycles are bounded.
- G13-A03: with a real in-memory OTel exporter the first span receives the sanitized root cause, the
  parent span does not repeat it, and a span without nested cause gains no cause attribute.
- G13-A04: streaming usage, raw finish reason, partial tool input and off-peak retry regressions. The
  raw finish reason test that still references the deleted AiSdkModelRegistry is only migrated to the
  existing TestProviderConfigFixture in this file, never deleted or weakened.
- Log/telemetry side effects only; no App interaction change and no new UI E2E; verified by real
  exporter and adapter unit tests. Other-source commits of the chat error Banner are verified separately
  in G13 follow-up and are not covered by this subgroup.
