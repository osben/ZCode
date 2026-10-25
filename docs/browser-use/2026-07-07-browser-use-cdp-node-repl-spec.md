# Browser-Use CDP + node_repl master spec (redo)

> Status: implemented (node_repl, protocol and interaction surface landed; the browser base was replaced by the `<webview>` + CDP-on-guest pivot instead of WebContentsView).
> Current fact entries: `2026-07-13-node-repl-mcp-runtime-spec.md` and `browser-use-plugin-runtime-boundary.md`. This document is the master spec of the redo phase; historical statements about `WebContentsView` yield to the current fact documents.
> Branch: `feat/browser-use-cdp` (new from staging). Replaces the "single MCP tool + renderer webview + executeJavaScript" approach of branch `feat/in-app-browser-use` (archived as reference / rollback point).
> Component specs (written before each task): `2026-07-07-node-repl-engine-spec.md`, `-node-repl-tools-spec.md`, `-browser-control-protocol-spec.md`, `-browser-cdp-view-spec.md`, `-browser-client-lib-spec.md`.

## 1. Target shape

1. **Tool surface = node_repl (Code-Act)**: the model does not call discrete tools; it writes JS in one **persistent Node REPL**. The REPL injects the `agent.browsers.*` object graph, and variables persist across calls. Tools are `js` / `js_reset` / `js_add_node_module_dir` (currently exposed as `mcp__node_repl__js*` through the node_repl MCP).
2. **Browser base = renderer `<webview>` guest + main-process CDP attach.** The early target was a main-process `WebContentsView`; the current implementation pivoted to `<webview>` guests, and main only manages guest webContents and CDP.
3. **Control = CDP** (`webContents.debugger`): real input `Input.dispatchMouseEvent` / `dispatchKeyEvent`, `Page.captureScreenshot`, page-script snapshot and state reads.

Non-goals (not in P0): real browser (extension backend), concurrent multi-tab, full cua/dom_cua/playwright escape hatch (skeleton throws), visible UI (headless first).

## 2. Design rationale

- **node_repl is a runtime core primitive, not part of the browser-use plugin.** The plugin only ships the `browser-client.mjs` library and the SKILL tells the model to use the existing REPL to `import setupBrowserRuntime` and inject `agent.browsers`. So a **generic persistent REPL tool** comes first, with the **browser-client library layer** on top; node_repl works without a browser.
- **The old renderer `capturePage` triggered a V8 `Empty MaybeLocal (ToLocalChecked)` native FATAL** (crash reproduced). CDP `Page.captureScreenshot` runs on the main side and avoids it at the root.
- **Current Electron base**: the renderer `<webview>` handles display and lifecycle; main attaches to the guest via `webContents.fromId(webContentsId)` and runs CDP through `WebContents.debugger.sendCommand`.

## 3. Layered architecture (4 process boundaries)

```
AGENT (zcode-cli child process, stdio NDJSON ZCode Protocol)
  node_repl: one persistent vm.Context per session (sandbox === globalThis, kept across calls)
             + nodeRepl.write sink + dynamic import() + require
  browser-client library: setupBrowserRuntime({globals,execute}) -> agent.browsers.*
                     each async method -> builds BrowserCommand -> BrowserControlPort.execute(cmd)
  BrowserControlPort = ProtocolBrowserControlBroker
                     -> context.requestClient("interaction/browserExecute", {command})
        | stdio JSON-RPC reverse request (server -> client request)
HOST (utilityProcess, business services)
  zcodeAgentService.client.onRequest: case "interaction/browserExecute"
        validate -> BrowserControlMainBridge.execute() -> respondResult/respondError
        (pure RPC relay: no emitSessionEvent, no UI; unlike permission requests)
        | parentPort (MessagePortMain, correlated by requestId)
MAIN (Electron main process)
  desktopHostProcess child.on("message"): case BrowserExecuteRequest
  BrowserGuestManager: manages renderer <webview> guest webContents by sessionId/tabId
  browserCommandExecutor: dispatches by command.method
  CDP: guest.webContents.debugger attach/sendCommand
        navigate->loadURL / screenshot->Page.captureScreenshot / snapshot->page-script snapshot
        click/type/press/scroll/hover/drag->Input.* / page-script locating helpers
        | renderer reports webContentsId on dom-ready
RENDERER (UI)
  side-pane browser tab renders <webview>; unmounting the tab releases the guest
```

**Responsibility discipline**: the agent expresses intent only and never touches the base; the host is a pure RPC relay; main alone owns guest attach and CDP; the renderer only displays the `<webview>` and reports the guest id.

## 4. Core path (P0 headless)

The model runs in the REPL: `nodeRepl.write(await agent.browsers.documentation())`, `const tab = await agent.browsers.open("https://example.com")`, `const shot = await tab.screenshot()`, `await nodeRepl.emitImage({ base64: shot.image.base64, mimeType: shot.image.mimeType })`. Path: `js` tool -> NodeReplSession.run -> `agent.browsers.open` -> BrowserCommand{navigate} -> BrowserControlPort -> requestClient -> host router -> parentPort -> main BrowserGuestManager (loadURL) -> reply; screenshot takes the same trip to guest CDP `Page.captureScreenshot`.

## 5. Single-source contract

`BrowserCommand` (discriminated union) is the single truth in three places: the agent browser-client builds it, protocol params carry it, the main executor consumes it. It is migrated from `browserCommandSchema` of the old branch `shared/src/browser-use/commands.ts` (P0 core subset: navigate/snapshot/click/type/screenshot/getState). Bidirectional round-trip unit tests plus keep-in-sync comments prevent drift.

## 6. Tasks and verification

T0-T6 are P0, T7-T11 are P1; each task writes its component spec first and lands as its own Conventional Commit.

- **T1/T2**: `pnpm --filter @zcode/core test` + `@zcode/contracts`; pure REPL semantics (globalThis persistence / reset clears / top-level await / dynamic import / write collection / AbortSignal) unit tests green.
- **P0 end to end**: desktop starts (feature switch on) -> the model writes the JS above in an agent session -> assert the browser really navigates and a non-empty PNG base64 returns; main log shows CDP attach + `Page.captureScreenshot`.
- **Wrap-up**: `pnpm typecheck` (including separate tsc for desktop renderer/main/preload) + `pnpm lint`.

## 7. Risks

The vm is not a security sandbox (same privileges as bash; relies on the permission gate and try/catch structured errors so the process never crashes); latency across 4 processes (coarse-grained commands, snapshot with refs for batch decisions); CDP attach vs DevTools conflict; `<webview>` guest handshake timing (execute waits for attach, times out as `backend_unavailable`); contract drift (single zod + round-trip tests); plain CLI / remote control without main (missing port/bridge reports a structured "browser unavailable" and does not crash the REPL).
