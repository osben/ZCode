# Chat error detail telemetry

Bounded error-chain projection from Core through to the `chat_error_banner` event:

```text
Core bounded error-chain projection
   -> TurnErrorPayload
   -> ProductProjection / V4 lastError schema
   -> SessionPane / UI error normalization
   -> chat_error_banner
```

- `underlyingErrorMessage`: the message of the deepest non-wrapper frame.
- `underlyingErrorDetail`: the detail / errorDetails / details of that same frame.
- With no non-wrapper frame, use the last frame; omit the field when no matching content exists. Keep the original error chain's loop protection and length caps; never traverse arbitrary context / headers / responseBody.
- The UI only passes structured fields and does not re-infer the underlying cause. The underlying message may be reported as `error_detail_message` after inspection; existing event names, deduplication, and classification dimensions are unchanged.
- Explicit divergence from upstream: `docs/monitoring/conversation-telemetry-v4.md` forbids uploading full detail, URLs, auth headers, or raw responses. Upstream's direct `error_detail_text` reporting is therefore not restored; truncating to 500 characters is not redaction. `underlyingErrorDetail` stays in the internal protocol / UI only and must not enter telemetry.
- The added message reporting respects length limits; a fixed redaction placeholder is used when credentials / auth headers, URLs, or raw HTML responses are detected; local display detail is unaffected. This text check is not a complete detector of arbitrary sensitive content; error producers still must not stuff full prompt/tool content into messages.
- Both live and snapshot schemas keep the fields; a type must not be widened only for a middle conversion to drop it, and desktop continuous / web replayable routing is unchanged.

Acceptance: Core multi-layer cause and same underlying frame; missing / wrapper / loop cases; projection and runtime schema round-trip; UI normalization wrapper paths; banner conversion and final payload; recognized sensitive text and overlong underlying messages are restricted; underlying detail is never reported.
