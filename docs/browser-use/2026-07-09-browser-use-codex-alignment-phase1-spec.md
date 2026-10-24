# Browser Use Phase 1 Spec

> Status: historical phase spec. The runtime on/off boundary follows `browser-use-plugin-runtime-boundary.md` and the Node REPL carrier follows `2026-07-13-node-repl-mcp-runtime-spec.md`. The Phase 1 scope is kept below, but examples follow the current `globalThis.browser + list -> match -> get` guidance so they are not mistaken for current instructions.

## Background

Phase 1 treated browser use as a capability controlled as a whole by the official `browser` plugin. The current implementation decouples the host `node_repl` registration from the `agent.browsers` bridge: disabling the plugin only turns off the skill/browser runtime feature, and while the package is discovered the host REPL stays. Phase 1 goal: without changing the plugin manifest schema, converge API self-description, REPL metadata, Browser facade semantics and the backend/tab object model into one SDK shape.

## Scope

1. **Documentation as manifest**: the official `browser` plugin provides `docs/api.json`, `docs/documents.json` and companion markdown. core no longer keeps large hard-coded API docs and generates `agent.browsers.documentation()` from the enabled official plugin assets.
2. **REPL metadata**: `js` input accepts `timeout_ms` and `title`; the REPL exposes `nodeRepl.requestMeta` and `nodeRepl.setResponseMeta(meta)`, and `responseMeta` is returned in the tool output.
3. **Direct-return facade wrapper**: the lower layer still uses `BrowserCommandResult` and `BrowserCommand`; the outer SDK returns the payload directly on success and throws `BrowserCommandError` on failure; `tab.raw.*` keeps the raw result channel.
4. **Explicit backend and tabs model**: `agent.browsers.get("iab")`, `getDefault()`, `getForUrl(url)` return `Browser`; `Browser.tabs` provides `list()`, `selected()`, `get(id)`, `new()`. Phase 1 supports only `iab`, with no Chrome backend.

## Non-goals

- No change to the `.zcode-plugin/plugin.json` schema.
- No Chrome / external browser support.
- No change to the core `BrowserCommandResult` structure of the desktop browser command protocol.
- No UI consumption of `responseMeta` in Phase 1; only the metadata path.

## Design

### Plugin documentation assets

The official browser-use plugin adds `docs/api.json` (backends, objects, methods, return and error semantics), `docs/documents.json` (markdown documents to concatenate for documentation) and `docs/*.md` (workflow, safety rules, screenshot/image return notes). When resolving the official `browser-use@zcode-plugins-official` plugin, bootstrap passes `rootPath/docs` to core as an internal runtime feature. The field belongs to ZCode internal runtime config, not the plugin schema.

### REPL metadata

`js` input: `code: string`; `timeout_ms?: number` (call timeout; the executor also accepts the old `timeout`); `title?: string` (short title of this call, into `nodeRepl.requestMeta.title`).

REPL globals: `nodeRepl.requestMeta` contains `toolCallId`, `traceId`, `turnId`, `sessionId`, `workingDirectory`, `workspaceRoot`, `title`; `nodeRepl.setResponseMeta(meta)` shallow-merges a JSON-like object and the tool outputs it as `responseMeta`; `nodeRepl.cwd/homeDir/tmpDir` complete the common environment metadata.

### SDK semantics

`Tab` methods return directly:

- Action methods `goto/navigate/back/forward/reload/click/type/press/scroll/hover/select/check/drag/close/handleDialog` return `void` on success.
- Observation methods: `snapshot()` returns `BrowserSnapshot`, `getState()` returns `BrowserPageState`, `screenshot()` returns `Uint8Array`, `evaluate()` returns `unknown`, `elementInfo()` returns an element or `undefined`, `getDialog()` returns a dialog or `null`.
- Failure throws `BrowserCommandError` carrying `code`, `command`, `result`.

`tab.raw.*` keeps the old `BrowserCommandResult` return for troubleshooting and low-level integration.

### Backend / Tabs model

```ts
globalThis.browser = await agent.browsers.getDefault();
globalThis.controlledTabs = await browser.tabs.list();
controlledTabs;
```

After inspecting the full list, the model binds the target by a verified stable id in the next cell:

```ts
const matching = controlledTabs.filter((info) => info.url === "https://example.com/");
if (matching.length !== 1) throw new Error("Expected exactly one matching tab");
globalThis.tab = await browser.tabs.get(matching[0].id);
await tab.playwright.domSnapshot();
```

Compatibility entries: `agent.browsers.open(url?)` stays as a convenience; `agent.browsers.current()` stays as the current visible tab entry; `agent.browsers.tab(tabId)` stays as the bound-tab entry; `agent.browsers.list()` now lists backends, and tabs are listed with `browser.tabs.list()` or `agent.browsers.listTabs()`.

## Verification

- Unit tests: the runtime feature carries `browserDocumentationRoot`; documentation is generated from the plugin docs manifest and falls back to a minimal built-in one when missing; facade direct return / throw / raw result; the `Browser.tabs` basic model; `nodeRepl.requestMeta`, `setResponseMeta` and the `timeout_ms` schema.
- `pnpm typecheck` and `pnpm lint` must run.
