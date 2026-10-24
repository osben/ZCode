# OpenAI Responses Non-stream JSON Minimal Compatibility

> Update 2026-07-15: the JSON normalizer and provider boundary below remain valid; the "compact fixed non-stream" contract is superseded by the [Compact Stream-first → Non-stream Fallback design](./2026-07-15-compact-stream-first-nonstream-fallback-design.md). The compat fetch now serves the HTTP fallback leg after compact streaming fails. The fixed non-stream descriptions below reflect the 2026-07-11 baseline.

## Background

Some third-party OpenAI Responses services return SSE events the AI SDK accepts for streaming, but omit fields the official Responses structure requires in non-stream JSON responses:

- `output[].type === "message"` with `id` missing;
- `output[].content[].type === "output_text"` with `annotations` missing.

The main session defaults to streaming, while compact called `modelAdapter.generateText()` (fixed non-stream at the time). The same provider/model could complete the main session yet have the compact HTTP 200 body rejected by the AI SDK as `Invalid JSON response` inside `OpenAIResponsesLanguageModel.doGenerate()`. The workspace's `@ai-sdk/openai` requires both fields in the non-stream Responses schema. This is incomplete third-party non-stream JSON, not a request-parameter, auth, network, or prompt problem.

## Goal

Let confirmed field-missing Responses JSON pass AI SDK validation and return text — without changing the compact non-stream contract, modifying the AI SDK, or affecting other protocols.

## Compatibility boundary

A standalone OpenAI Responses JSON fetch compat wrapper, composed only in the adapter registry's `providerKind === "openai"` factory branch:

```ts
const providerFetch = createProviderBusinessErrorFetch(...);

createOpenAI({
  ...,
  fetch: createOpenAIResponsesJsonCompatFetch(providerFetch),
}).responses;
```

`createProviderBusinessErrorFetch()` stays responsible only for the network proxy and business-error identification shared by all providers. The Responses body compat must not go into that shared fetch nor into the `anthropic`, `gateway`, or `openai-compatible` factories.

The provider type contract maps `providerKind === "openai"` uniquely to `apiFormat === "openai-responses"`. The registry must explicitly return the AI SDK `provider.responses` factory so the factory composition itself is the protocol test; the compat wrapper never re-guesses the protocol from request URL, method, model name, or baseURL.

The wrapper processes only responses from that Responses factory that satisfy all of:

1. HTTP status 2xx;
2. response is not `text/event-stream`;
3. body parses as a JSON object with `output` an array.

Otherwise it returns the original `Response`.

## Minimal normalization rules

Normalize only the two field gaps confirmed by historical logs and a current AI SDK minimal reproduction:

1. For an output item with `type === "message"` and `id === undefined`:
   - only fill the ID when the top-level `response.id` is a non-empty string;
   - generate `msg_<UUIDv4>` via Node `node:crypto` `randomUUID()`, avoiding the predictable namespace of IDs the provider already returns; no new UUID dependency or collision resolver.
2. For a `type === "output_text"` content item of such a message with `annotations === undefined`, fill `annotations: []`.

Everything else stays out of scope and goes to AI SDK validation untouched: other schema problems, non-message output items, non-output_text content items, message ID missing when the top-level `response.id` is invalid, invalid JSON, error responses, and SSE.

Rebuild the `Response` only when normalization actually happened: keep status, statusText, and other headers, drop the now-invalid `content-length` and `content-encoding`. A legal Responses response must return the original `Response` instance.

## Explicitly not done

- compact is not switched to `streamText()`; its non-stream request contract stays (superseded only by the stream-first design above).
- No stream retry after non-stream failure (duplicate requests, double billing, side effects).
- No AI SDK schema modification, fork, or relaxation.
- No ID backfill for every output item; no compatibility for unobserved missing fields.
- No name lists based on model, provider, or baseURL.
- No Responses protocol inference from URL pathname or HTTP method.
- No changes to Chat Completions, Anthropic, Gateway, reasoning policy, or request payload.
- No new model-io, prompt-trajectory, telemetry fields, or protocol events.

## Error and diagnostics contract

When the wrapper cannot parse or the minimal rules do not apply, return the original response so the AI SDK keeps its existing `AI_APICallError: Invalid JSON response` with concrete validation issues. Never swallow errors, rewrite to empty text, or trigger extra retries.

## Verification

### Unit and integration tests

- Pure normalizer: fills only the missing message `id` and output*text `annotations`; message ID matches `msg*<UUIDv4>`.
- Legal Responses JSON returns the original `Response` with body unchanged.
- Unknown output items are not modified.
- SSE and non-2xx responses pass through unchanged.
- With a fake API key and local fake HTTP server, drive the real `AiSdkModelRegistry -> AiSdkModelAdapter.generateText -> @ai-sdk/openai doGenerate` path and show the historical field-missing JSON finally returns compact summary text.
- Registry integration: `openai` explicitly selects the Responses factory; nearest-neighbor OpenAI-compatible Chat Completions is the negative control whose response body never enters the wrapper; Anthropic and Gateway mutually exclusive factory branches unchanged.

### E2E

One case-local fake Responses server scenario:

1. Main session `stream: true` returns legal SSE and succeeds.
2. `/compact` issues a non-stream `/responses` request.
3. The fake server's non-stream JSON deliberately omits message `id` and output_text `annotations`.
4. compact finally publishes a completed boundary and keeps the summary marker.
5. Packet capture proves the provider response really missed the fields, and no Chat Completions endpoint request was made.

Tests use only a fake API key and a local server; no real provider. The scenario supplements the existing manual compact success product state F08 — no new independent conversation product case, automation abbreviation, or coverage-audit rule, and no product case statistics change.

When extending the compact harness, keep the existing artifact contract: the dry-run top-level `model`/`baseURL` and the suite result top-level `model` remain. Running a case-local-model scenario alone may put that scenario's exact value in the top-level `model`; multi-case runs keep the default model and express exceptions per-case via the case `model` field. Case registry resolution must sit inside the suite's unified `try/finally` so registry exceptions still reach failure persistence and the existing diagnostics-retention policy.

## Acceptance criteria

- The historical field-missing minimal reproduction under the current AI SDK turns from failure to success.
- compact still sends non-stream Responses requests (per the superseding stream-first design).
- Main-session SSE behavior unchanged.
- Request/response bytes of other provider kinds and protocols unchanged.
- No extra requests or retries.
- Related tests, `pnpm typecheck`, `pnpm lint` pass.
