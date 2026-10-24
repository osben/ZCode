# CUA: SDK + `node_repl` Migration Spec

## Status

Completed.

## Target

CUA is no longer injected into the model as 30 independent MCP tools. The model calls only the unified `node_repl` MCP, bootstraps the CUA SDK inside each JS Worker, and executes the existing CUA contract through a private bridge.

## Model and SDK contract

The model-visible tool surface is fixed to node_repl's three tools: `js`, `js_add_node_module_dir`, `js_reset` (later reduced to `js` only; see `docs/cua-permission-broker/zcode-cua-permission-broker.md`). The CUA plugin manifest declares no MCP server.

SDK entry:

```js
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const computerUseRoot =
  process.env.ZCODE_CUA_PLUGIN_ROOT ??
  process.env.ZCODE_PLUGIN_ROOT ??
  process.env.CLAUDE_PLUGIN_ROOT;
const { setupComputerUseRuntime } = await import(
  pathToFileURL(join(computerUseRoot, "scripts", "computer-use-client.mjs")).href,
);

await setupComputerUseRuntime({ globals: globalThis });
const app = await agent.computerUse.getApp("Notes");
await app.getAXState();
```

- `agent.computerUse` exposes a bound-object API (`getApp` / `getState` / `listApps` / `requestAccess` / `stop`, plus camelCase methods on Target such as `getAXState` / `click` / `setValue` / `elements`). The former snake_case tools collapse into the escape hatch `agent.computerUse.computer.<tool>`, whose method names are frozen by the SDK's fixed union `COMPUTER_METHOD_NAMES` (14 today; the source of truth is `TOOL_NAMES` in zcode-cua `src/tools/manifest.ts`; 16 including `open_application` were removed on the producer side, and launch/activate folded into the transparent launch of `get_app_state`). Parameter schemas are verbatim identical to the producer's `.strict()` zod; the internal runtime's MCP envelope is no longer exposed to the Worker.
- The private bridge uses `{ method, input, context }` and adapts internally to the current staging `ComputerUseRuntime.execute({ toolName, arguments, ... })`, so BrokerClient, Helper, frame freshness and action-state semantics remain implemented once by the staging runtime. The SDK cannot access the broker socket, token or native modules.
- Every `mcp__node_repl__js` call creates a fresh Worker, so bootstrap is a precondition of one cell, not a session initialization: every cell using CUA must re-import and run `setupComputerUseRuntime({ globals: globalThis })` and then call `agent.computerUse.<method>()` in the same cell. Putting bootstrap in an earlier call and actions in a later call, or relying on a previous Worker's `agent`, `runtime` or import binding, is forbidden. The model-visible skill, on-demand docs and `js` tool description must use the same bootstrap template; a contract test locks this rule.
- Browser Use and Computer Use can coexist in one Worker; both share `agent.documentation.get` and route their own doc names without overwriting each other's loader. What is shared is the `node_repl` channel, not the plugin runtime directory: CUA's `ZCODE_CUA_PLUGIN_ROOT` takes priority for native closures such as `sharp` and the CUA docs, while the Browser Use root serves only the browser bridge and host server. Screenshot, zoom and screenshot-bearing state reads do not depend on Browser Use's `node_modules`.

### Structured results and Worker output

- The CUA SDK does not expose the producer's legacy MCP `content` envelope to the Worker and creates no `content[0].text`, `text` or `message` mirrors with identical content. A single JSON-object text result (for example the window table of `list_windows`) is normalized into top-level SDK fields; ordinary successful actions return only stable receipt fields. Only non-JSON read results keep a single `text` field.
- The Host structured-result sink carries only two kinds of information: (1) official CUA images and the adjacent `image_ref`, plus the `_meta` needed to issue them; (2) sideband that should not enter model text (app-display `_meta`, action-state, ...), in which case `content` must be empty.
- Error results may keep the producer's error `content`. A successful plain-text action/metadata result must not pass through the structured sink again, or it would join the cell-end `nodeRepl.write(...)` into two output segments. `toMcpRunResult` keeps treating the structured image as the authoritative source, so a mistaken `console.log(JSON.stringify(result))` cannot break official CUA's `image`/`image_ref` adjacency.
- Observation methods (`getAXState` / `getScreenshot` / `getAXStateAndScreenshot` / `getState` / `listApps`) display their results themselves, so the skill explicitly forbids passing their return values to `nodeRepl.write(...)` or `nodeRepl.emitImage(...)`: a second raster in one result violates the one-raster rule, the whole frame is removed, and no image is obtained. Pass `{ emit: false }` to get values without display. `getApp` only binds and does not display.
- The broker-credential injection eligibility of the CUA bridge and the official CUA frame authority are two independent sets. `node_repl` can obtain the former to access the shared-host CUA runtime, but only a CUA MCP descriptor carrying real plugin authority can obtain the latter; generic node_repl/Browser Use results must not enter the exact-raster verification path because of it. For CUA SDK results inside the shared node_repl, the Host enables that protection dynamically only when the same result has the producer-issued `zcode.cua/official-frame-integrity-v1`, a legal adjacent `image_ref` and a raster; Browser Use results in the same server keep the ordinary media path.

## Runtime boundaries

```text
node_repl MCP / shared host
  └─ CuaRuntimePool (isolated by workspaceKey + sessionId + remoteSessionId)
       └─ AccessibilitySession + KillSwitch + InputHoldRegistry
            └─ BrokerClient → signed Computer Use Helper
```

The Worker of each `js` call is short-lived; the CUA session, frame registry, action-state and kill switch are held by the shared host runtime. `js_reset` resets only the JS Worker and does not destroy the CUA runtime.

All workspace identity uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`. Remote `/remote` can only attach to an existing desktop shared host; it cannot create an independent Helper, independent Agent runtime or relay-side CUA state. Desktop stays `desktop-continuous`, mobile stays `web-remote-replayable`.

## Authorization and errors

The outer `mcp__node_repl__js` does one high-risk approval; the inner layer reuses Helper/TCC, kill switch, frame freshness, possibly-sent and input-hold cleanup. `request_access` can still trigger the system permission flow, with no new per-action model-level approval.

Stale frame, Helper unavailable, permission denied, `possibly_sent` and lost attachment all fail closed and return structured results. A subagent request directly returns CUA unavailable.

## Observation boundary after an action

- Action tools by default return only the action result and do not call `get_app_state` inside the action. After an element write the shared runtime still marks the old state as needing refresh and rejects reuse of the old `state_id` until refreshed, so turning off implicit observation does not loosen stale-state safety.
- Every model-generated `node_repl` cell containing one or more UI actions must make exactly one explicit observation at the end (`app.getAXState()`), which displays the result itself; do not wrap it in `nodeRepl.write(state.text)` (see the output contract above). Action and observation sit in the same outer tool call to avoid a separate `mcp__node_repl__js`. One cell may batch closely related actions but observes once at the end.
- Default action results carry no `state_sync_status`; only an explicit `return_state="compact"|"full"` attaches a post-state and its `state_sync_status`. The ordinary workflow keeps `return_state="none"` and lets the cell-end explicit `get_app_state` capture once, avoiding a `capture_app` inside each SDK action and a separate node_repl tool call after operating.
- The Windows operation indicator and macOS PiP keep consuming the shared-host sideband events; for `mcp__node_repl__js` the sideband carries only the fixed `operationAction` resolved from the SDK call name, never JS source, arguments or credentials. Calling only Browser Use `agent.browsers.*` does not trigger the CUA indicator.

> Superseded (2026-09-14): the `operationAction` convention depended on extracting action names from model source and broke entirely after `e2d7a9f2e9` reshaped the SDK surface, disabling the Windows indicator. The sideband now carries only the boolean fact `computerUse` (anchored on the bootstrap statement `setupComputerUseRuntime`). See `2026-09-14-windows-cua-indicator-repair-spec.md`. The conclusions "carries no source/arguments/credentials" and "Browser Use does not trigger the indicator" are unchanged.

### 2026-08-25 log-driven hardening of the observation contract

The `structuredContent` of `get_app_state` is the only structured fact source of the Worker SDK and must pass through:

```text
Helper capture_app
  -> CuaRuntime / observation mapper
  -> broker JSON response
  -> node_repl bridge
  -> computer-use-client.mjs
```

- The full, `delta` and `no_change` observation modes must all return the same AppState fields (at least `state_id`, `elements`, `app`, `window`, `text`). Incremental mode may compress AX tree text into a change summary but must not omit the structured actionable-element list. Because every `js` is a fresh Worker, the SDK cannot rely on the previous Worker's memory to restore a missing `state_id` or elements.
- If the SDK receives a `get_app_state` response without a complete AppState, it must throw the stable `STRUCTURED_STATE_UNAVAILABLE` contract error (`ComputerUseError.code`) and stop further actions; the model must never get `undefined` and then guess or hard-code an old `state_id`. Observation results are emitted automatically by the SDK (`{ emit: false }` turns it off); the model no longer feeds AX text back by hand.
- Observations that do not display their result must self-report: the bound observation of `getApp`, `getScreenshot` (no tree text) and `elements()` (structured array only) all pass `tree_shown_to_model: false`. Otherwise the producer's index-shift ledger records a tree the model never saw as seen, degrading verification to current-tree-versus-current-tree; these paths also clear the SDK-side `treeSeen` so the next `getAXState` forces a full tree and the model never gets a diff against an undisplayed tree.
- The Worker view keeps only the SDK fields the model needs and removes legacy `content`, duplicate `message`, `_meta`, image base64 and internal frame authorization, so `console.log(JSON.stringify(result))` does not dump sensitive/large envelopes twice. The skill must make "explicit observation at the end of an action cell, writing out the AX text" the fixed template and forbid outputting action-result JSON as cell output.

## Migration and history

- Delete the independent CUA MCP server, old tool projection, aliases and new execution paths.
- New calls use the generic node_repl renderer; screenshot/structured results keep the node_repl image path.
- Historical transcripts keep read-only parsing of old `mcp__computer-use__*`; re-registering or executing them is forbidden.

## Acceptance

1. A new session's tool list contains no `mcp__computer-use__*`; the first turn contains only the node_repl tool description.
2. The 14 surviving CUA contracts keep their schema, state validation and external oracle coverage through SDK calls; removed tool names must not appear in any model-visible docs (pinned by a contract test).
3. Repeated Worker calls in the same shared host create no independent CUA MCP process and do not grow runtime memory linearly.
4. Browser Use, desktop continuous, mobile replayable, subagent isolation and old transcript replay all pass regression.
