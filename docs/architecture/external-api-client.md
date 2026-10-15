# Consolidating External API Requests

## Scope

This change consolidates external business APIs only; requests all go through `ApiClient`:

- OAuth provider token / userinfo / business API key paths
- Remote config and release queries for model providers

Explicitly excluded:

- Local `/api/*`
- WebSocket
- SSH
- RPC / IPC
- Browser-local resource reads

## Shared Abstraction

The shared layer adds `packages/shared/src/api.ts`, which defines three basic contracts:

- `ApiClient`: the project's sole standard HTTP interface, kept `fetch-compatible`
- `ApiRequestInit`: based on `RequestInit`, with `timeoutMs` added
- `ApiError`: consistently carries `url`, `method`, `status`, and the error message

This way, repos/adapters depend only on the shared contract and do not need to know about Node-specific implementation details.

## Default Implementation

The default implementation for Node/Desktop hosts is in `packages/services/src/providers/api/`:

- `nodeApiClient.ts`: calls Node global `fetch` internally
- `apiJson.ts`: consistently handles JSON reads, non-2xx errors, and parse failures
- `apiEndpoints.ts`: centralizes external API endpoint constants

Node's global `fetch` uses `undici` underneath, so:

- We benefit from `undici` runtime capabilities.
- The business layer does not import `undici` directly.
- If advanced `undici` capabilities become necessary, only the provider implementation layer needs to change.

## Injection

Under the layering constraints, `ApiClient` is a cross-cutting capability injected only through `Providers`:

- `packages/services/src/node.ts` creates the default `NodeApiClient`.
- The desktop Host reuses the same `NodeApiClient`.
- OAuth and model-provider services consume `ApiClient` through dependency injection.
- Tests can substitute a mock client.

Business repos/adapters no longer call raw `fetch` directly or expose `fetchImpl?: typeof fetch` to the business layer.

## Migrated Paths

- `packages/services/src/oauth/providers/*`
- `packages/services/src/model-provider/repo/*`
- `packages/services/src/model-provider/modelProviderService.ts`
- `packages/services/src/model-provider/modelProviderConnectivityHelpers.ts`

These paths now access external business APIs through `ApiClient`.

## Current Boundaries

Version 1 standardizes only the following capabilities:

- timeout
- Header merging
- Request-level `x-request-id`
- JSON/text reading helpers
- Normalization of non-2xx errors

The following are intentionally out of scope:

- Retries
- Interceptors
- Exposing advanced connection-pool configuration to the business layer
- Unifying non-HTTP protocols

## Future Constraints

When adding an external business API, follow these rules:

1. Business code depends only on `ApiClient`.
2. Keep endpoint constants in the provider/config layer; do not scatter hard-coded URLs across repos/services.
3. Use `x-request-id` for request-level diagnostic IDs. `ApiClient` generates it at the egress point and preserves the value when the caller supplies one.

This keeps implementation boundaries stable across desktop/web/remote modes and prevents Node runtime semantics from leaking into the business layer.
