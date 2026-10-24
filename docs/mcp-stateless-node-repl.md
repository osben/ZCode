# MCP 2026-07-28 stateless Node REPL spec

> Status: in progress. Date: 2026-08-06.
> Protocol basis: MCP `2026-07-28`, SEP-2567 Sessionless MCP.
> Product boundary: Browser Use keeps using `mcp__node_repl__js`; no new model-visible `browser_use` server, context handle, or replacement tool semantics.

## 1. Goals

This changes only `node_repl`'s runtime lifecycle and MCP wire era:

1. The built-in `node_repl` is pinned to MCP `2026-07-28`; sessions with the same `workspaceKey = workspaceIdentity?.trim() || workspacePath` share one MCP frontend.
2. Every `js` call uses a fresh one-shot worker and `NodeReplSession`; the worker is disposed after the call. `globalThis`, timers, dynamic-import module caches, response meta, or Browser wrappers must never survive across calls.
3. Browser Use and Computer Use share the single model entry `mcp__node_repl__js` (Browser Use only when this spec was written; CUA joined the same host in 2026-08). Pages, tabs, permissions, and backend generation stay with the existing BrowserControl/session registry; the model re-bootstraps each call and recovers pages by stable tab id; the CUA counterpart is the shared host's `CuaControlPort` and frame registry.
4. Code-only runtime compatibility is kept, preserving existing tool identity and replay contracts. `js_reset` and `js_add_node_module_dir` were removed on 2026-09-18 together with the moduleDirs capability (see "The two removed tools" below); the replay contract is carried by UI name mapping.
5. Ordinary third-party MCP keeps dual-era `auto`; known legacy servers and SSE keep legacy.

"Stateless" means the execution kernel only — it does not remove all compatibility config or close browser pages:

```text
session A ─┐
           ├─ lease ─> workspace-scoped node_repl MCP frontend (2026-07-28)
session B ─┘                         |
                                      +─ js(A) -> one-shot worker A -> dispose
                                      +─ js(B) -> one-shot worker B -> dispose
                                      `─ small session-keyed module-dir config

Browser/page authority
sessionId -> BrowserControlPort.requireSession -> workspace/remote/clientMode
          -> Browser backend/tab registry (existing owner; not MCP frontend state)
```

## 2. Model-visible tool contract

The model sees one host tool:

- `mcp__node_repl__js`

The `node_repl` server instructions and that tool description declare "Browser Use and Computer Use only" ("Browser Use only" when written; both texts were re-scoped to the two official capabilities once CUA landed). It must not be turned into a general JavaScript, file, shell, package-inspection, or data-processing tool, nor may the model be pointed to a dedicated `browser_use` tool.

Model guidance keeps the pre-upgrade `control-browser` skill and Browser API docs as its content baseline. Except for the statements below that directly conflict with kernel lifecycle, navigation, locating, popup recovery, screenshots, safety, tab lifecycle, and error-recovery rules must be preserved:

- `persistent kernel/binding/module cache` becomes fresh per `js` call;
- `globalThis.browser/globalThis.tab` reuse across cells becomes: after each bootstrap, re-acquire the browser per the user's current selection, then recover the tab with full tab facts and its stable id;
- `js_reset` and `js_add_node_module_dir` are deleted; guidance must not mention them or imply a persistent kernel waiting to be rebuilt or a model-configurable module search root.

Never compress or rewrite other guidance to explain statelessness. Per-call bootstrap examples only load `scripts/browser-client.mjs` and run `setupBrowserRuntime`; the generic template must not hardcode `agent.browsers.getDefault()`, which would override the user's chosen IAB, extension, or CDP backend.

### `js`

- The `tools/list` model schema keeps requiring `code + title` with `additionalProperties: false`.
- The `code` field description must fit both core's compatibility REPL and the fresh-kernel MCP: no "persistent Node REPL session" claims to Browser Use models and no fabricated cross-call state.
- The runtime parser keeps accepting historical code-only input; the UI uses the existing localized fallback for old data.
- `timeout_ms` keeps the 60-second default, 120-second cap, and existing timeout copy.
- Each call creates a one-shot worker; inside it, a `NodeReplSession` is created, the Browser bridge injected, the code executed, the result returned, and the worker destroyed.
- Model code may import only `node:*` builtins and absolute `file://` URLs based on the official skill root; bare package names do not resolve (`resolveSpecifier` and moduleDirs were removed with the tools).
- `js` calls within one session serialize; different sessions may run concurrently.

### The two removed tools (2026-09-18)

`js_reset` and `js_add_node_module_dir` were fully removed from `tools/list`, handlers, and the execution chain; `node_repl` keeps only `js`. Calling them returns `Tool not found`. Both had zero observed usage (310 local sessions, 17,134 real `js` calls).

`js_reset`: after the fresh-kernel change it had no executable semantics — the next `js` is already a new kernel, and its only residual behavior (a barrier in the same session's serial queue) is always empty because model tool_use is inherently serial and different sessions use different sessionKeys. Its tool definition cost ~117 tokens per round, and because it always succeeded, weaker models never switched strategy (ticket ZCT-2100503886992535552: 155 consecutive calls, 48.37M input tokens over 19 minutes until a 429). A failure result is the signal a model needs to change strategy.

`js_add_node_module_dir`: it pushed a host duty onto the model. The model cannot know which `node_modules` to pass; the only thing that could tell it is the skill docs, and any path the docs know, the host can inject itself. Both official SDK bootstraps use only `node:*` builtins plus absolute `file://` URLs from the skill root, never bare package resolution. Also removed with them: `NodeReplExecuteInput.moduleDirs`, the worker passing chain, `NodeReplSession`'s `moduleDirs`/`addModuleDir`/`getModuleDirs`, and `resolveSpecifier` (both branches were guarded by `moduleDirs.length > 0` and never fired on the always-empty production path, so removal changes no existing behavior). If an official skill ever ships third-party packages, the host injects them at runtime creation — never re-open a model-facing config tool.

The removal touched only executable paths. Historical transcript rendering still depends on the name mappings in `packages/shared/src/tool-identity.ts` and `packages/ui/src/lib/nodeReplToolDisplay.ts`, which must be kept: they only read the toolName recorded in history, unrelated to the current `tools/list`; deleting them would degrade old sessions' call blocks to the unknown fallback renderer.

## 3. Browser Use and request identity

MCP `2026-07-28` `_meta` is a request envelope/context, not an independent authorization credential. The built-in chain validates in order:

```text
tools/call _meta["com.zcode/request-context"]
  -> node_repl reads only the host namespace, never session fields inside model parameters
  -> the child uses a process-private broker socket + 256-bit token
  -> the broker validates the token (no longer rejects subagents by runtimeScope)
  -> BrowserControlPort.list/execute
  -> requireSession(sessionId; child sessions map to the parent via forChildSession registration)
  -> restore workspaceIdentity / remoteSessionId / clientMode
  -> the current session's backend/tab/permission policy
```

So "trust only `_meta.session_id`" is wrong; the trusted boundary is the private stdio child, the private broker token, the host-written namespaced request context, and the session registry together. Page continuity needs no extra opaque handle: `BrowserControlPort` already manages tabs/pages per session, and the fresh kernel only rebuilds the temporary `agent/browser/tab` wrappers.

Subagents may use Browser Use: after the parent runtime registers via `BrowserControlPort.forChildSession` (`tabOwner: "parent"`), the child session's requests are issued with the current conversation as tab owner; the subagent sees all of the conversation's tabs, its opened tabs expand in the panel, and its tabs are not closed at the end (`docs/browser-use/2026-07-16-subagent-browser-unavailable-spec.md`). Unregistered child sessions, forged top-level `_meta.session_id`, workspace paths, or browser ids cannot bypass the session registry.

## 4. Sharing, reclaim, and logging

- `node_repl` config is fixed to `protocolVersion="2026-07-28"`, `isolation="workspace"`.
- The pool key stays `server config fingerprint + workspaceKey`; third-party servers default to session isolation.
- Each session holds a lease; after the last lease releases, the frontend closes per the existing grace period.
- `mcp.server.connected` records `mcpConnectionId`, `workspaceKey`, `mcpIsolation=workspace`, `mcpProtocolEra=modern`, `mcpProtocolVersion=2026-07-28`, and the stdio PID.
- `mcp.pool.lease.acquired/released` records each sessionId under the same `mcpConnectionId`; shared-connection logs never fake a unique owner.
- After a frontend crash, the next call reconnects per existing adapter logic. With a stateless kernel, reconnecting never restores JavaScript; Browser tabs/pages remain decided by the Agent/host's existing owners.

## 5. Multi-client boundaries

```text
desktop / desktop-continuous ──┐
                               ├─ existing shared host -> Agent -> node_repl lease
mobile / web-remote-replayable ┘

relay/main: auth + attachment + frame transport only
Agent: MCP pool + request routing
BrowserControl/desktop guest manager: tab/page authority
```

- Mobile `/remote` only attaches to the desktop window's existing host/Agent; it never starts its own Agent, MCP, or browser runtime.
- This change adds no task event, snapshot, queue, owner, or replay state.
- Desktop continuous never assembles replayable recovery messages; mobile replayable never bypasses gap/snapshot boundaries.
- Remote workspace identity keeps flowing as `workspaceIdentity + remoteSessionId`, never degrading to `workspacePath`.

## 6. Acceptance

- Tool identity is only `mcp__node_repl__js`; `js_reset` and `js_add_node_module_dir` are absent from `tools/list` and return `Tool not found`; no built-in `mcp__browser_use__*` or `mcp__computer-use__*` model tools exist.
- Two consecutive `js` calls: the second sees none of the first's globals, timers, import-module singleton changes, or response meta; the same Browser tab's DOM/page state stays continuous.
- In desktop IAB full-chain and multi-tab replay, every `js` re-bootstraps; the next call uses the dynamic stable tab id from the previous real tool result to run `tabs.get`. Each tool terminal state asserts completed and the result marker first; when V4 projection lags, the model's received `tool_result.is_error` is authoritative; failures like `ReferenceError` must surface at the tool boundary, never degrade into later UI or provider matcher timeouts.
- Two sessions in one workspace keep exactly one stable `zcode-node-repl-mcp` frontend/PID; A/B globals, module dirs, tool results, permissions, and tabs stay isolated.
- `tools/list` still requires title; direct runtime calls accept code-only.
- The `control-browser` skill and Browser API docs keep all pre-upgrade non-state guidance; only persistent/fresh, cross-cell binding, and reset semantics are replaced. The generic bootstrap never selects a default backend.
- The model-visible `js.code` schema carries no persistent wording conflicting with the fresh kernel.
- The model-visible descriptions, handlers, schemas, and moduleDirs execution chain of `js_reset` and `js_add_node_module_dir` are fully removed; UI name mappings stay for historical replay rendering.
- Main and subagent Browser Use both work; the subagent shares tabs with the current conversation, tabs survive its end, and the original tab/page continues after returning to main.
- Modern/legacy third-party MCP negotiation regressions, focused tests, desktop pending E2E, `pnpm typecheck`, and `pnpm lint` pass.
