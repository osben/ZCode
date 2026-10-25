# Standalone client config service (phase 1: plugin ordering)

## Scope

A standalone ClientConfigService exists, but the legacy read path is not migrated.
Phase 1 only moves the plugin-ordering read added with it out of
CodingPlanSubscriptionService; subscriptions, security checks, forced updates,
off-peak, help, Built-in, Desktop Main gray-release, and the standalone CLI keep
their existing requests, caching, auth, and failure policies. The Nacos
pluginStoreOrder format is unchanged; already-published config needs no adjustment.

## Responsibilities and interface

- `packages/shared/src/clientConfig.ts`: public config response schema and the
  trimmed ClientConfigSnapshot.
- `packages/services/src/client-config/clientConfig.ts`: the IClientConfigService
  contract and service channel.
- `packages/services/src/client-config/clientConfigService.ts`: request, validation,
  caching, refresh, and in-flight merging.
- `getSnapshot({ forceRefresh? })` returns validated public fields; currently
  pluginStoreOrder, zsrcUrl, and uiPluginRecommendations. It never returns the whole
  remote response and never exposes account or provider data to the Renderer.
- On service success with a missing/withdrawn pluginStoreOrder it returns null; a
  single malformed pattern still degrades per the existing ordering contract.
  Envelope/HTTP/network failures reject that read and keep the service's existing
  snapshot; the business side decides default display.

```mermaid
flowchart LR
  D[desktop plugin store] --> P[client-config RPC]
  M[mobile shared-host attachment] --> P
  R[remote workspace service view] --> P
  P --> C[window Local Host ClientConfigService]
  C --> A[injected ApiClient and window network policy]
  A --> E[/client/configs]
  O[existing subscription consumers] --> L[legacy read path, unchanged]
```

## State and timing

- One instance per window-scoped Local Host; the remote workspace set explicitly
  injects and registers that same instance — no separate remote ordering-config
  owner. Mobile uses it through the existing attachment, with no extra request or
  Host.
- Plain Web/server Hosts get their own instance from createLocalServices. The Web
  home page without a connected Host returns an empty public snapshot and sends no
  network request.
- Phase 1 supports only public, unauthenticated reads: credentials=omit, no
  credentialService dependency. The cache key is the actual request URL (canonical
  endpoint, app_version, platform); the request context is injected by the Host
  assembly. Different contexts share no snapshot/in-flight request, and late results
  write back only to their own key.
- A valid snapshot has a 1-hour TTL; in-flight requests merge within the same
  context. A forced refresh bypasses the valid snapshot but does not clear it. While
  a forced refresh runs, plain reads still return the valid old snapshot
  immediately; only a successful refresh atomically replaces it.
- The HTTP request and body read use a 15-second overall AbortSignal budget;
  failures are not cached as errors and never permanently lock the in-flight state.
- Callers get a copy of the snapshot so same-process consumers cannot mutate the
  cache. The UI adds no extra request TTL; the existing hook generation keeps
  isolating unmount/overlapping refresh/late results from different services.
- Task/session/owner/queue/stream are untouched; desktop-continuous and
  web-remote-replayable recovery semantics are unchanged. Public ordering config is
  not bucketed by workspacePath or workspaceIdentity.

## Impact

Layers changed: option-source / persistence (in-memory cache owner) / delivery (new
plain service channel). must-inspect: Local Host assembly, IServiceAccessor,
RemoteServiceAccess, remote workspace service set, Web home-only,
usePluginStoreOrder. should-inspect: list ordering after service failure/switch,
refresh and mode switching. invariant-only: all legacy client/configs read paths,
plugin lifecycle, Main/relay, and session recovery. The shared component is
PluginStoreListView; the UI still reads from the hook, and category ordering and
category-migration rules are unchanged. The product capability map has no dedicated
ClientConfig node yet; record it as a graph gap for platform public config
capability — this feature's semantic graph seeds the real code and the unique owner.

## Acceptance

| ID     | Setup / action / assertion                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CCF-01 | Parallel reads in one context → one HTTP request only, later reads hit cache; no credentials read                                                                           |
| CCF-02 | Valid snapshot exists → plain reads during a forced refresh return the old value; on refresh failure the old value stays readable, and a successful withdrawal returns null |
| CCF-03 | Switch endpoint/version/platform, late old requests → snapshots stay isolated per key, no cross-overwrite                                                                   |
| CCF-04 | Error envelope/HTTP/hanging body → rejected and retryable; timeout cancels the whole request                                                                                |
| CCF-05 | RPC getSnapshot → strictly typed public fields, unknown fields not passed through, callers cannot mutate the cache                                                          |
| CCF-06 | Multiple remote workspaces / server remote service sets → the same injected instance is registered                                                                          |
| CCF-07 | Real dev / browser → Code, Work, refresh, empty categories, and legacy guides merging hold; logs use client-config.getSnapshot                                              |
| CCF-08 | Diff the three subscription source files against the MR target branch → zero changes from this MR, legacy-path tests pass                                                   |

Browser E2E keeps the existing manual-review/pending cases, injecting the new
service contract; cases are not promoted on their own.

Known limitation: real mobile shared-host/SSH/WSL/Docker setups have not been
integration-tested on devices; same-instance reuse at the service assembly layer has
unit tests.

## UI recommendation field

`uiPluginRecommendations` returns a validated `{ pluginId, surfaceId }[]`; a missing
or invalid value returns an empty array and does not affect other public fields. The
recommendation entry reuses this service and adds no request caching or polling.
Configuration and exposure rules live in
[plugin marketplace spec](plugins/plugin-market-interactions-scope.md#side-pane-服务端推荐配置).
