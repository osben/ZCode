# TUI Network Status Projection

Updated: 2026-07-15

## Current behavior

The TUI normalizes the `network_request_status` of the generic HTTP boundary and the `model_network_status` of provider model requests into the same in-memory `NetworkRequest` group. These states are shown in the `APIs` section of the right sidebar; a standalone network panel below the input box is no longer kept.

```text
session event
  -> app-session-event-handler
  -> app-network-events (normalize, merge by request id, keep at most 8)
  -> app.tsx networkRequests state
  -> app-sidebar-api.tsx (summary + latest 5, the rest shown as more)
```

The sidebar summary shows:

- the number of model requests in the current session usage;
- the number of WebFetch / WebSearch calls;
- the pending, error and recent counts of in-memory network requests;
- when expanded, at most 5 recent requests, with status, method, target and the duration when available.

## Events and identity

- A generic HTTP event must contain a stable `requestId`, `method`, `url` and a `pending | complete | error` status.
- A provider model event maps to `source=model`, `method=POST`, with the target parsed from provider/model/base URL metadata.
- The current merge key is `request.id` (built from `requestId`); a new status with the same id replaces the old row and moves it to the top.
- Memory holds at most 8 entries and the sidebar renders at most 5; these numbers are UI capacity, not a persistent protocol.
- `model_retry_scheduled` also updates the footer status; a request row is formed only after a new outbound attempt arrives.
- A cache-hit WebFetch produces no network row, because there is no outbound request.

## Authority boundary

The network list is a live TUI projection; it is not persisted, does not poll a debug proxy, and is not a second authority of runtime network state. After a session is restored only live network events received since restoration are shown. The usage summary may persist accumulated counts but cannot reconstruct each historical request.

## Layout

`APIs` is a collapsible sidebar section whose expanded state is held by the sidebar state. When the terminal is narrow or the sidebar is closed the section is not rendered; this does not affect request execution or event collection. The old description of "a fixed three-line network panel below the input box, collapsed by priority on short terminals" is obsolete.

## Current code and tests

- `packages/contracts/src/events/session.events.ts`
- `packages/tui/src/app-network-events.ts`
- `packages/tui/src/app-sidebar-api.tsx`
- `packages/tui/src/app-session-event-handler.ts`
- `packages/tui/tests/tui-sidebar.test.ts`
- `packages/tui/tests/tui-sidebar-render.test.ts`
- `packages/core/tests/webfetch-tool.test.ts`
- `packages/core/tests/websearch.test.ts`

## Not yet covered

- Cold recovery of the network request list (the current product semantics explicitly do not restore it);
- An explicit composite identity across attempts. If a future requestId can have multiple concurrent attempts, the merge key and the event contract must be changed first; a column cannot simply be added in the UI.
