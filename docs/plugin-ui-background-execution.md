# MCP page retention and background execution

## Problem and boundary

The protocol handshake can finish before editor initialization, and a stopped session does not mean the plugin has no internal work. The host cannot infer from either state when a plugin may stop frames, and must not require plugins to add private execution reporting. Waiting for React mounting when there is no anchor, putting the guest under `display:none`, or destroying guests on an idle deadline all break background initialization or `requestAnimationFrame`-dependent work.

## Lifecycle

### Connection barrier on first open and session restore

Session restore completing does not mean the target MCP is connected. `mcp/uiOpenInstance` must wait for that server's existing connection task to finish, then read the connection identity and issue the page credential. The wait is owned by the MCP adapter/pool, does not wait for other servers, does not reconnect, and adds no polling, delays, or retry counters in the UI.

```text
session restore → open App → wait for the target MCP's existing connecting
                            ├─ connected → validate session / lease / connection identity → create page
                            └─ failed / owner released or replaced → refuse creation
```

Synchronous identity validation of an existing page does not wait and does not reconnect. A failed connection still shows the error and keeps the reload entry. If the session is closed or replaced, the lease released, or the connection swapped while waiting, the old request must not issue a credential to the new owner. The Web/mobile/remote unsupported fallbacks and the continuous/replayable boundary are unchanged.

Regression `PLM-UI-CONNECTION-READY`: a real Electron page stays “preparing” while MCP initialize is blocked by a controlled gate; once released it runs without clicking reload and creates only one instance. Adapter/pool/protocol unit tests cover failure, concurrent waits, and owner invalidation. Entry point stays `--managed-only`.

```text
current successful UI tool result → window-level receiver → page-owner admission → create guest immediately
history card / manual panel open ───────────────────┘        (does not wait for a display anchor)
                           ├─ visible: normal display
                           └─ not visible: sized, non-interactive background surface + target guest active
task delete / explicit reload / source or runtime invalidation / window close → revoke credential and activity → release guest and lease
```

- All MCP pages use the same host rules: no plugin code changes, no new plugin protocol, no per-plugin-name distinctions. The page owner starts immediately after admission, even if the requester has already switched away and bound no anchor.
- First creation must not depend on tool cards or SessionPane mounting. After the Agent projects the current successful tool result, it sends the UI description and original input to the owning local host via `v4/plugin-ui/tool-result`; no conversation subscription is required. The host validates the schema, the current runtime source, and the local scope; only trusted desktop attachments may subscribe; the window receiver reuses the same logical key and admission Promise. A card and the receiver racing can create only one page. History hydration, failures, cancellations, and MCP `isError` produce no notification; history is not scanned and session projections are not kept alive. A background result only updates the page's tool data — it binds no anchor, steals no focus, and does not change the current sidebar; returning to the session reuses the same guest. Web/mobile/remote receive no creation side effects and keep plain tool records. Page subscription and deletion cleanup are owned by the existing owner.
- A created MCP guest stays executable for its whole valid lifetime: handshake completion, an idle session, or a stopped turn change nothing. The workspace/session lease and resource feed stay with the page; the session's execution projection is not a switch for page operation.
- An inline anchor with a display size stays in its original scroll tree. Without a displayable anchor (including forceMount-hidden tabs) the page migrates to a non-zero-size, non-interactive background surface; restoring display is the same guest, with no editor rebuild.
- While the page is hidden, the owner document is hidden, or the window is minimized, the host keeps the existing reversible capturer activity for that guest. Main validates by sender, sandboxId, and initId; old requests cannot control a new instance. Activity requests arriving early during loading are held until `did-stop-loading` before enabling; the DOM-ready event can still fire mid-load, so the first request must not be swallowed. Do not set window-wide `backgroundThrottling:false` and do not wake normal pages outside this lifecycle.
- MCP pages refuse automatic `suspend()`; switching pages, five minutes off-screen, and capacity pressure must not lose the plugin's in-memory state. Explicit `suspend(true)` follows the existing path: credential revocation, call cancellation, teardown, guest close, and lease release. Late events must not recreate a deleted page.
- Performance boundary: create only pages actually requested; admission caps at thirty retained tasks and sixty-four live pages. With no reclaimable page, refuse new creation — existing MCP pages are never evicted. Main keeps the existing target-guest probe at intervals of at least 200 ms, with no new busy/idle inference, timed reclamation, or restore snapshots; that interval is not a plugin frame-rate cap. General background execution and edit-state retention cost resources: no promise of zero background CPU or of releasing the memory these pages hold.
- Gen UI keeps the five-minute off-screen and capacity reclaim; normal Browser and Web/mobile/remote unsupported fallbacks are unchanged. Historical tool rows are not preloaded, and unsaved state is not promised to survive app exit, crash, or explicit reload.

## Regression contract

Verified in real Electron with the production page owner, the Agent, and a controlled MCP page without a private execution protocol:

| Scenario                                | Must assert                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Switch away before a tool result        | Created by a real Agent result with no tool card or conversation subscription; work completes in background, guest reused on return |
| No anchor / hidden tab cold start       | Multi-frame initialization after handshake with the session idle; page size non-zero               |
| Session idle / stopped turn             | Internal rAF work still completes, without a new model turn or host tool call                      |
| Window minimized                        | Background work completes; guest identity and edit state unchanged after restore                   |
| Off-screen deadline / capacity pressure | Existing MCP guests and in-memory state retained; new creation refused when nothing is reclaimable |
| Native isolation                        | Bypass guests that never requested activity are not woken; wrong owner / old initId rejected       |
| Hide and restore                        | Background surface receives no mouse; inline scroll does not drift; normal display after restore   |
| Delete / runtime invalidation           | Activity, guest, and lease released; late events do not resurrect                                  |
| Web / remote                            | No local sandbox created; no extra subscriptions                                                   |

Entry points: `node packages/desktop/scripts/mcp-apps-host-e2e.mjs --background-only`; existing lifecycle and fallbacks use `--managed-only`. Real-plugin verification uses the unmodified PhotoCraft 0.2.2:
`ZCODE_PHOTOCRAFT_SERVER=/path/to/photocraft/dist/server.mjs node packages/desktop/scripts/mcp-apps-host-e2e.mjs --photocraft-background-only`.
Verified on macOS Electron: host minimized before first plugin creation, background initialization and editing, cross-deadline retention, and the restore screenshot `photocraft-restored.png`. The test shell's blank background is not evidence of plugin success — combine actual command results and the restore screenshot; the fixture does not cover the store install path.
