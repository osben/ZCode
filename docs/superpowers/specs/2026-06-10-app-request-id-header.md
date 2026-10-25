# App Network Request ID Header

App-side external business HTTP requests go through `ApiClient`, and diagnostics already read `x-request-id` / `x-trace-id` / `x-span-id` from backend responses. Outbound requests also carry a request-level `x-request-id` so local logs, captures, and server entry logs can be correlated before the backend assigns its own ID.

Rules:

- Every outbound external business HTTP request carries `x-request-id`: a UUID generated once per request.
- An explicit caller-supplied `x-request-id` / `X-Request-Id` is preserved, never overwritten.
- `NodeApiClient` covers all `ApiClient` paths uniformly: OAuth, model provider, usage, repo snapshot/wiki, default/test endpoints, and plain external APIs. Source-header override rules are unchanged (the ID is applied after endpoint rewrite and ZCode source header merge).
- The feedback API keeps its custom upload implementation, so `FeedbackHttpClient` applies the same helper to plain API requests, attachment init/complete, single uploads, and log chunk PUTs. Each chunk/attempt is an independent request with its own `x-request-id` so single failed requests can be located server-side.

Helper behavior (shared service layer): normalize caller headers via `Headers` (plain objects, arrays, `Headers` instances); if no `x-request-id` exists, call `createUuid()` and write lowercase `x-request-id`; otherwise keep the existing value.

Non-goals: no `@zcode/protocol` changes; no header on WebSocket, RPC, IPC, SSH, or local browser resource reads; no forced injection into third-party bot providers, MCP URL probes, or user-configured webhook URLs (third-party/CORS compatibility); `x-request-id` is never written to production info logs (only the header key may be logged).

Verification: `NodeApiClient` tests cover default generation, explicit-ID preservation, and header generation unaffected by external abort; endpoint-rewrite tests cover source headers coexisting with `x-request-id`; `FeedbackHttpClient` tests cover the API, log chunk PUT, and single attachment PUT.
