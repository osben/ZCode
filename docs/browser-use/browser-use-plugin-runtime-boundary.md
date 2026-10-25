# Browser Official Plugin Runtime Boundary

## Background

`browser-use@zcode-plugins-official` is an official ZCode plugin. Its manifest still declares only `skills`; the plugin schema is not extended.

The goal is for the enabled/disabled state of the browser-use plugin to control the model-visible browser guidance/bridge, while making clear the relation among the stateless `node_repl` MCP frontend, the browser client and the plugin's physical asset carrier:

The browser-use package is the physical release carrier of these runtime assets; `enabled === false` turns off only the skill/bridge and does not hand the host node_repl identity over to a third-party plugin.

- With `browser-use@zcode-plugins-official` enabled: a session uses Browser Use through the `js` tool of the host stateless `node_repl`.
- With the plugin disabled or uninstalled: the host `node_repl` identity may still be kept by the runtime, but the browser-use skill does not enter the skill roots, and there is no Browser bridge/runtime feature.

## Design

Arbitrary plugins may not self-declare a high-privilege runtime capability through a manifest. ZCode core recognizes only the official plugin id:

```text
browser-use@zcode-plugins-official
```

After plugin resolution, bootstrap reads `PluginLoadOutcome.plugins` and writes the following into `AgentRuntimeConfig.runtimeFeatures` only when that official plugin has `enabled === true`:

```ts
{
  browserUse: true,
  browserDocumentationRoot: "<browser-use plugin>/docs"
}
```

`node_repl` is registered by the host built-in MCP configuration and is no longer implicitly enabled by `browserControlPort`; the Browser bridge requires both `runtimeFeatures.browserUse` and the host-injected `browserControlPort`. The MCP frontend keeps no conversation or JavaScript kernel state; browser continuity is still maintained by the existing session-scoped BrowserControl/tab owner. So the desktop browser view / CDP / protocol bridge can stay in core and remain dormant.

## Parts that stay in core

- The `interaction/browserExecute` protocol and the shared browser-use command/result schema.
- The browser view, CDP, IPC and tab display logic of Desktop main / host / renderer.
- The single-call execution engine inside the `NodeReplSession` one-shot worker, permissions, timeout and image result formatting.
- The `browser-client` object graph implementation.

These are either cross-process infrastructure or a high-privilege execution surface, and are not dynamically declared by an ordinary plugin manifest.

## REPL release dependency boundary

`@zcode/core/repl` is the standalone public entry for `NodeReplSession` and its types, reusing the existing execution engine directly; the core dependency of the MCP server may only enter `core/repl` and must not pull in the Agent, tool registry, Subagent or workflow compiler through the `@zcode/core` umbrella entry. The core umbrella entry keeps its existing exports for compatibility. The standalone `browser-client.mjs` keeps providing the browser object graph through `@zcode/core/browser-client`.

The Electron Node mode of the app, plain Node CLI and the SEA built-in Node share a light plugin-host branch of the CLI entry:

```text
main → environment cleanup / SEA tool preparation → plugin-host authentication → MCP server → one-shot Worker
                              └ ordinary CLI command → Provider preparation → run / Agent Runtime
```

`__zcode-plugin-host` must branch off before the generic `run.ts` and Provider initialization modules are imported. The REPL child process does not evaluate the Agent Runtime, tool registry or workflow modules; these modules continue to be used by the parent Agent that owns the conversation. It reuses the credential check, argv passthrough and exit owner of the original plugin-host: an authentication failure is rejected before any import, on success the MCP keeps living on stdio, and an initialization failure is still settled by the existing watchdog. Plugin arguments do not trigger Provider initialization. A regression test must actively throw when business entries are evaluated, and prove that the plugin-host of the ordinary and compressed CLI still loads plugins normally. The startup layer reads environment handling, identity constants and SEA tool descriptions through `@zcode/shared/runtime-env`, `@zcode/shared/mcp`, `@zcode/shared/runtime-tool-runtime` and the existing `@zcode/contracts/plugins`, avoiding unrelated schema initialization of the umbrella entries. All entries point to the original files, and the broker credential capture is still the sole state held by the same module, with no copy of the validation or environment implementation.

The MCP server reads the JS tool schema through `@zcode/contracts/tools/node-repl`, the MCP result metadata constants through `@zcode/contracts/mcp`; the browser bridge reads the existing broker protocol through `@zcode/shared/node-repl-browser-broker`. Evaluating the contracts/shared umbrella entries for these few definitions is forbidden, so that no MCP process or one-shot Worker initializes unrelated business schemas. These public sub-entries point directly to the original files, keeping the single source of truth for validation, tool descriptions and return format.

This boundary does not change MCP tools, the one-shot Worker, module directory isolation, timeout/cancel, the browser broker, result format, permissions, or the desktop continuous / mobile replayable delivery contract. Acceptance reuses the real bundle's MCP handshake and Worker isolation tests and checks that the build dependency graph contains none of the business modules above.

## Host and plugin responsibilities

After MCP `2026-07-28` ZCode still uses the host `node_repl` tool identity; the official browser-use plugin carries the frontend bundle and the browser-client/docs/skills assets. The protocol bridge and the desktop CDP execution chain stay on the host; with the plugin disabled there is no Browser Use skill/bridge, and no separate `browser_use` tool is created.

## Acceptance

- With the official browser-use plugin enabled by default, a desktop session sees `mcp__node_repl__js` and the `control-browser` skill; `mcp__browser_use__*` does not appear, and neither do the deleted `js_reset` / `js_add_node_module_dir`.
- After explicitly disabling `browser-use@zcode-plugins-official`, a new session no longer provides the `control-browser` skill or `agent.browsers`; the host may keep the single `js` node_repl tool identity for configuration compatibility, but the model-facing text remains limited to the two official capabilities Browser Use and Computer Use and must not be turned into a generic JavaScript tool.
- Even if the host still injects `browserControlPort`, the Browser bridge is not injected without the browser-use runtime feature; the node_repl identity is not taken over by third-party configuration as a result.
- Pure CLI without an explicit `--browser-use=headless` has no browser host and does not inject `agent.browsers`.
- Pure CLI with headless explicitly enabled: the CLI adapter injects a real managed `cdp` BrowserControlPort, and the backend is discoverable only after the Chromium handshake completes. This path keeps using the official plugin's skill/client and the host node_repl MCP and must not be bypassed into `agent-browser` or another model tool.
- ZCode app-server does not consume the CLI managed headless argument; Desktop/Web Remote keep using the BrowserControlPort injected by the shared host, and no browser runtime is started separately for mobile or protocol sessions.
