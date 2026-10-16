# Resource Manager Network Request Observability

## Confirmed Scope

- The Network tab follows CPU, Memory, and Storage, and displays only time, process/PID, method, and URL; it does not collect headers, request/response bodies, or SSE/WS messages, and does not display completion state or duration.
- Include only local Main, window Host, the App's own Renderer, and managed CLI; include requests made by the plugin-management CLI itself. Exclude MCP transport/authentication, Bash/MCP child processes, external pages in the built-in browser, remote CLI, and raw SSH/TCP connections.
- The App's own subscription and rewards pages remain in scope; do not exclude them categorically based on webview type.
- The Resource Manager window is the sole owner of start/stop: when it is closed, do not install this feature's network listener or create a collection timer; after opening, continue collecting across tabs; on close, renderer crash, or destruction, stop immediately and release records. Reopening uses a new captureId and does not accept old batches. Clearing also rotates the captureId, clears pending batches in every process, and rejects results still in flight from before the clear.
- Record only requests created after the listener becomes active; do not backfill history or SSE/WS connections that already existed. The UI shows the latest 1,000 entries and makes the number evicted visible; data is not persisted. Remove usernames, passwords, and fragments from URLs; redact all query values uniformly and limit their length.

## Implementation and Invariants

```text
Window opens → Main captureId → Chromium observer + Main Node observer
                           → Existing/later-started Host → Node observer + local CLI control notification
CLI Node observer → Bounded batch → Host → Main's sole list → Dedicated preload → Network tab
Window closes → Unregister observers + notify Host/CLI to stop → Clear cache → Reject old captureId
```

Node subscribes to diagnostics_channel and does not replace fetch/http, the dispatcher, or Agent, or change proxy, noProxy, custom CA, retry, or cancellation behavior. For an HTTP proxy absolute path, reconstruct the target URL; CONNECT is an internal proxy connection and is no longer recorded as a business request. Chromium uses the shared onBeforeRequest dispatcher and coexists with other registered observers (such as security-check diagnostics in the official build); disabling this feature does not unregister other observers.

CLI process/networkCapture control notifications are handled immediately; they do not enter the business FIFO, wait for database preparation, refresh idle time, start the CLI, or trigger the watchdog. Release listeners when a connection/process closes. Transport and callback failures affect observability only; batches are bounded by count and interval, and diagnostic batches are dropped when stdio is congested rather than accumulating bodies or blocking business operations.

Host connects only to the local CLI registry already present in this process; a newly registered client inherits the current collection state. Remote services, relay, conversation continuous/replayable, owner/lease, and task snapshots are not connected to diagnostic data. Main holds diagnostic data only, not task business state.

## Impact Scope

| Level | Entry point/owner | Change and isolation |
| --- | --- | --- |
| Required change | Help/question mark → ResourceManagerApp → dedicated preload | Shared singleton window; network display projection, filtering as local UI state; explicitly enable CPU/memory polling by tab |
| Required change | resourceManagerWindow / desktopHostProcess / Host index | Window start/stop, Host lifecycle, bounded batches with captureId |
| Required change | Node diagnostics adapter / local CLI registry / stdio control | No listener by default; support new processes; diagnostics do not participate in business lifecycle |
| Required change | MCP transport fetch | Exclude through async context; preserve existing proxy and authentication behavior |
| Must verify | Other observers on the shared onBeforeRequest dispatcher / three proxy egress paths | Electron single-listener constraint; direct, proxy, noProxy, certificates, and failure paths |
| Isolated | Web/mobile, remote CLI, external browser | Add no entry point, do not propagate collection controls, and do not change task recovery semantics |

Code-scan entry points: ResourceManagerApp, openResourceManager, registerHostProcess, ZCodeAgentProcessManager, createMcpTransportFetch, and ZCodeProtocolNdjsonConnection. Follow direct callers through to Host/CLI; do not expand the review to every statically reachable feature. Desktop is not currently a managed module under architecture-policy, so passing the architecture gate does not replace runtime evidence.

Add network aliases, node entry points, and window-lifecycle invariants to the feature graph. No product scope remains pending decision; the user explicitly pruned bodies, remote traffic, and raw sockets, while theme/platform coverage uses representative cases.

## Acceptance Cases and Evidence

| ID | Setup/action | Assertion | Evidence |
| --- | --- | --- | --- |
| NET-01 | Send requests separately while closed, open, and after closing | New listener exists only while open; reopening shows no old records | Node unit tests + desktop E2E |
| NET-02 | Four local process types make HTTP requests and SSE/WS handshakes | One row per request; no bodies; MCP/Bash absent | Collection/Host/CLI unit tests + App run |
| NET-03 | Direct, HTTP proxy, CONNECT, noProxy, custom CA | Business route/results unchanged; list shows target URL; no duplicate CONNECT | Local upstream/proxy integration test |
| NET-04 | Toggle listener while a long CLI business request is pending | Control takes effect immediately; does not terminate business or trigger watchdog | Protocol transport test |
| NET-05 | New client/Host, close/reopen, late notification | New process inherits state; old captureId is discarded; no implicit spawn | Registry/lifecycle test |
| NET-06 | High event volume, clear, switch tabs | Bounded memory; clear works; Network tab does not poll CPU; light/dark themes and English/Chinese work | Unit tests + desktop E2E |
| NET-07 | Another onBeforeRequest observer is active while network collection is toggled | Existing observer remains; listener failure does not block requests | Dispatcher regression (run security-check diagnostic regression separately in official build) |

Write the regressions above before implementation; desktop E2E uses a local HTTP service and does not depend on a real model or the public internet. Before release, run root typecheck/lint, CLI typecheck/lint, affected unit tests, and Resource Manager E2E; accurately list any unrun cross-OS checks in the commit description.

## Implementation Verification (2026-09-28)

- macOS arm64, Node 24.14.0, Electron 41.0.3: 13 affected root unit-test files / 95 cases passed; 4 CLI files / 45 cases passed.
- Verified Host CONNECT, CLI forward proxy, and noProxy against a real local upstream/proxy; original responses/routes were unchanged and CONNECT was not recorded twice. MCP direct and proxy requests were both absent from the list. SSE, native WebSocket, and ws-library handshakes each produced only one metadata entry.
- Desktop E2E passed: actual Main/Renderer requests, external-session exclusion, cross-tab collection, filtering, clearing, and reopening without history; dark English/light Chinese screenshots were manually inspected. Run record: `desktop-e2e-20260928-030204-914`, executed after rebuilding the App/CLI from current source.
- `pnpm typecheck`, root `pnpm lint`, CLI `typecheck`, and `architecture:check --changed` passed. New feature-graph seeds parse and no dangling edges were added (the original graph already had 4).
- Standalone CLI `lint` still reports existing `max-lines` violations, including large debug, contracts, adapters, and bootstrap files not exempted in the standalone subproject configuration; root lint has no new errors from this change. An additional check found existing rootDir/type errors in desktop `tsconfig.main.json`; the network module had no errors.
- Windows/Linux hardware testing and enterprise proxy custom-CA integration were not performed; existing proxy/CA implementation was reused and existing policy unit tests passed. Existing SSE/WS connections are not backfilled; diagnostics may be dropped under stdio backpressure, and the business protocol is not throttled.
