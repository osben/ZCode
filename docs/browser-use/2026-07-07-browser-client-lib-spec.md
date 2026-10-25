# browser-client library and node_repl injection spec (T6, P0 acceptance)

> Status: implemented.
> 2026-07-13 boundary update: the object graph still reuses core, but "inject at session creation" was replaced by the explicit bootstrap of the plugin `scripts/browser-client.mjs` in `2026-07-13-node-repl-mcp-runtime-spec.md`; the injection section below records the historical T6 route only.
> Parent: `2026-07-07-browser-use-cdp-node-repl-spec.md`; depends on T1-T5.
> Scope: implement the `agent.browsers.*` object graph (browser-client library) and inject it into node_repl, bridged to the T3 `BrowserControlPort`. P0 acceptance: agent writes JS -> controls the main WebContentsView -> screenshot returns.

## 1. Locations

- `apps/zcode-cli/packages/core/src/browser-client/index.ts`: `setupBrowserRuntime` + the `agent.browsers` object graph.
- `apps/zcode-cli/packages/core/src/browser-client/facade.ts`: `BrowsersFacade` / `Browser` / `Tab` classes that turn method calls into a `BrowserCommand` -> `execute(cmd)`.
- `packages/core/src/tool/handlers/node-repl.ts`: `getSession` builds injected globals from `context.browserControlPort`.

## 2. Object graph (P0 core subset)

`setupBrowserRuntime({ globals, execute })` sets `globals.agent.browsers = new BrowsersFacade(execute)`, where `execute: (command: BrowserCommand) => Promise<BrowserCommandResult>`.

- `BrowsersFacade`: `open(url?)` returns a `Browser` (navigates first when `url` is given); `default` returns the current one (single tab in P0).
- `Browser`: `navigate(url)` -> `{method:"navigate",url}`; `getState()`; `screenshot()` -> `{method:"screenshot"}` -> `{image:{base64}}`. P0 skeleton methods that throw NotImplemented: `snapshot` (T8), `click`, `type`, and the getters `playwright`, `cua`, `dom_cua` (escape hatch, T10).
- Each method builds a `BrowserCommand`, awaits `execute(cmd)` and returns the `BrowserCommandResult`; `ok:false` does not throw (the model reads the error); only unimplemented methods throw NotImplemented.
- The library is pure TS; all external effects go through the injected `execute`.

## 3. node_repl injection bridge

- When `getSession(context)` builds the session and `context.browserControlPort` exists, it injects globals with `execute = (command) => context.browserControlPort!.execute({ sessionId: context.sessionId, command })`, calls `setupBrowserRuntime({ globals, execute })`, and creates `new NodeReplSession({ injectedGlobals: { agent: globals.agent, setupBrowserRuntime } })`. `agent.browsers` is available out of the box in the REPL; `setupBrowserRuntime` is injected too for advanced use and explicit initialization in bootstrap docs.
- `browserControlPort` absent (plain CLI / remote control): `agent.browsers` is not injected; P0 injects a stub that throws "browser unavailable".
- The port comes from the first call's context; later calls in the same session reuse the existing session (port unchanged, safe).

## 4. P0 acceptance (end to end, real machine)

With `ZCODE_BROWSER_USE=1` (or temporarily unconditional includeNodeRepl + browserControlPort in the desktop wiring) start desktop; in an agent session the model runs:

```js
const b = await agent.browsers.open("https://example.com");
nodeRepl.write(JSON.stringify(await b.getState()));
const shot = await b.screenshot();
nodeRepl.write("shot bytes: " + (shot.image ? shot.image.base64.length : "none"));
```

Assertions: main log shows WebContentsView creation + CDP attach + `Page.captureScreenshot`; the REPL returns non-empty base64; `getState.url === example.com`.

## 5. Switches (P0 minimum)

- The node_repl tool needs `includeNodeRepl:true` (T2 opt-in); the desktop wiring passes true (unconditional in P0, later tied to a settings switch).
- `browserControlPort` is already injected on the desktop path (T3/T4).
- Plain CLI: includeNodeRepl may be on (a plain REPL is useful) while `browserControlPort` is not injected, so `agent.browsers` reports unavailable.

## 6. Verification (T6 unit tests)

- `BrowsersFacade` / `Browser` with a fake execute: `open(url)` sends navigate, `screenshot()` sends screenshot, `getState()` sends getState; command shapes are correct.
- Unimplemented methods (snapshot/click/playwright getter) throw NotImplemented.
- node_repl injection: a context with a fake `browserControlPort` -> `typeof agent.browsers.open` is "function"; `await agent.browsers.open("https://x")` triggers `port.execute` and the REPL gets the preset result.
- A context without a port -> calls on `agent.browsers` report browser unavailable.
