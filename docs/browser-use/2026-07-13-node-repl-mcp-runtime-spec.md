# Browser Use Node REPL MCP Runtime Spec

> Status: historical spec; superseded since 2026-08-06 by `docs/mcp-stateless-node-repl.md`.
> Date: 2026-07-13.

> Migration note: the tool identity, Browser Use-only routing, the `code + title` model schema and the
> code-only runtime compatibility remain valid. The persistent kernel, the session-scoped MCP process and
> the standalone `browser_use` handle are abandoned. The current implementation is a workspace-shared MCP
> `2026-07-28` `node_repl` frontend that uses a one-shot kernel per `js` call.

## 1. Goal and source of truth

The browser-use plugin declares no MCP server. It ships a skill, docs and `scripts/browser-client.mjs`.
The skill requires execution through the host-provided Node REPL MCP:

```text
mcp__node_repl__js
mcp__node_repl__js_reset
mcp__node_repl__js_add_node_module_dir
```

Target shape: `node_repl` is an independent stdio MCP server, and `js` starts a persistent Node kernel.
The browser client initializes `agent.browsers` in the kernel and reaches the browser backend through a
product-trusted bridge.

Before this spec, `js/js_reset/js_add_node_module_dir` were Agent core built-in tools and the REPL ran
inside the Agent process. The object graph and most cell semantics were in place, but tool identity,
process lifecycle, MCP status/tool discovery and stdio fault isolation did not match the target. The
model-visible boundary is therefore a real MCP server, with the existing BrowserControl product chain
unchanged:

```text
model
  -> mcp__node_repl__js
  -> host-reserved server: node_repl (stdio child; not declared by browser manifest)
  -> persistent NodeReplSession
  -> import browser-use plugin scripts/browser-client.mjs
  -> authenticated local pipe
  -> current Agent session BrowserControlPort
  -> existing ZCode Protocol interaction/browserExecute
  -> shared host -> desktop main/IAB
```

## 2. Tool contract

### 2.0 Browser Use model routing boundary

`node_repl` is the trusted execution mechanism for Browser Use. It is not a general JavaScript, file
processing, shell, package inspection or data processing tool for the model to choose freely. The
model-visible MCP server instructions and the `js` tool description must state at the start:

- use `node_repl` only when the Browser Use skill requires controlling the browser;
- do not choose `node_repl` for non-browser tasks just because JavaScript could do them;
- `js_reset` and `js_add_node_module_dir` serve only the same Browser Use workflow.

This is a model routing contract. It does not change the persistent kernel's execution ability and does
not reject historical calls in the execution layer; otherwise old providers, history replay and browser
client initialization code would break on a contract upgrade.

Cause of the 2026-07-28 defect: host MCP described only the persistent JavaScript kernel, not the Browser
Use boundary, so the model treated it as a general code executor and picked the high-privilege
`mcp__node_repl__js` for unrelated tasks. Browser Use is the only legitimate `node_repl` scenario, so the
single scenario and the reverse prohibition are written into both the server instructions and all three
tool descriptions, and locked by `tools/list` automation.

The model routing and Browser Use guidance contract ships with Browser Use plugin `0.3.0`. The versions in
the plugin `package.json`, `.zcode-plugin/plugin.json`, `OFFICIAL_PLUGIN_DEFINITIONS`, SEA
`officialSeaPlugins` and `NODE_REPL_SERVER_VERSION` must be identical. Bootstrap automation checks the
first three, SEA build automation checks package/manifest/SEA lists, and MCP server automation checks
serverInfo against the package. Overlapping sources close the loop mechanically; drift where plugin
content is bumped but the official seed, SEA asset path or MCP runtime keeps an old version is forbidden.

### 2.1 `js`

The model-side input contract reuses `JsInputJsonSchema` from `@zcode/contracts`; the MCP server must not
keep a second hand-written JSON Schema that can drift:

- `code: string`, required.
- `timeout_ms?: integer >= 1`, default 60000ms, maximum 120000ms. The default covers the whole cell
  execution including browser operations and all async waits. When the model expects the whole cell to
  exceed 30000ms it must pass `timeout_ms` explicitly, at least the expected total plus 15000ms overhead;
  if that exceeds 120000ms it must split the work into several calls.
- `title: string`, 1..120 characters, required; describes the goal of the operation in the current user
  language and must not use implementation terms such as `js`, `JavaScript` or `node_repl`.
- `additionalProperties: false`.

The model contract and the runtime compatibility contract are separate. The `tools/list` schema requires
`code + title`, so every new call has a user-visible title. MCP server execution parsing keeps accepting
old calls without `title`, so history, old providers and replay do not break. The UI uses a localized
fallback only for such old data and never guesses a title for a new call.

Cause of the 2026-07-14 title defect: after node_repl moved from core built-in to host MCP, the
hand-written server schema marked `title` optional with `required` only `code`, overriding the core
contract "required for the model, compatible at runtime". The model sent title-less browser-use calls and
the UI could only show the fixed `Operation completed`. The hand-written model schema is removed, and
automation asserts that `tools/list.required` contains both `code` and `title`.

Cause of the 2026-07-14 timeout defect: the model sent a message in one browser cell and then waited a
fixed 30000ms, while the old MCP default timeout was also 30000ms, so the cell aborted before click, input
and result-read overhead. The default is 60000ms, and the execution layer, server instructions and tool
description reuse one constant so model text and real timeout cannot drift. The explicit `timeout_ms` cap
of 120000ms is unchanged.

The model-side `timeout_ms` field description and the `js` tool description must carry the 30000ms
decision threshold, the 15000ms reserve rule and the 120000ms split boundary; a bare "Optional per-call
timeout" would not tell the model when it must override the default.

Output uses MCP `CallToolResult`:

- text output goes to `content: [{type:"text", text}]`.
- `nodeRepl.emitImage(...)` appends one MCP image content block per call.
- `nodeRepl.setResponseMeta(...)` and browser response meta are shallow-merged into top-level `_meta`.
- JS exceptions return `isError: true` with readable text and never crash the MCP server.

The kernel persists across `js` calls. After timeout/cancel the old context is discarded and a late
continuation must not write into a new cell.

### 2.2 `js_reset`

- Input is an empty object; extra fields are forbidden.
- Rebuilds the kernel and clears cell bindings and old browser/tab bindings.
- Added module search roots are kept.
- annotations: `readOnlyHint:true`, `destructiveHint:false`, `openWorldHint:false`.

### 2.3 `js_add_node_module_dir`

- Input is `{path: string}`; only an absolute `node_modules` directory is accepted.
- Returns `true` when added and `false` when already present.
- The search root lives for the MCP server lifetime, including after `js_reset`.
- annotations are the same as `js_reset`.

## 3. Host and plugin naming boundary

- Bootstrap injects `node_repl` as a host-reserved stdio MCP server. The browser-use plugin manifest
  declares no MCP: the MCP server belongs to the host, the skill and assets belong to the plugin. The
  browser-use package is only the physical asset carrier of the current server bundle.
- The settings page shows host `node_repl` as a read-only MCP associated with the browser-use plugin and
  links `mcp/list` status through the real runtime name `node_repl`. The association is projected from the
  official plugin definition into the protocol field `hostMcpServerNames`. It expresses product ownership
  and observability only; it is not written back to the plugin manifest and the runtime name does not
  become `plugin:browser:node_repl`.
- After the browser-use plugin is disabled, the settings page keeps the association, because the generic
  `node_repl` host lifecycle does not follow the skill switch. The row text must say it is provided by the
  ZCode host for the browser-use plugin and must not report "plugin not enabled".
- After user/plugin MCP merging, host `node_repl` overrides a same-named entry; third-party/inline
  plugins still use the forced `plugin:<plugin>:<server>` namespace and cannot impersonate
  `mcp__node_repl__*`.
- The browser-use plugin ships `scripts/browser-client.mjs`. The skill reads the plugin root from the
  host-injected `ZCODE_PLUGIN_ROOT` (fallback `CLAUDE_PLUGIN_ROOT`), builds a cross-platform absolute file
  URL with `node:path.join` and `node:url.pathToFileURL`, and imports it dynamically. A `<plugin root>`
  placeholder and guessing the plugin root from the Skill base directory are forbidden. This avoids both
  model path reasoning and core pre-injecting `agent.browsers` into every REPL context.
- The `serverInfo.version` returned by MCP initialize equals the current browser-use package version and
  is compared mechanically with `package.json` by automation. It is the version of the shipped server
  implementation, not a separate version line.
- Disabling the browser-use plugin removes only the skill/browser bootstrap, not the generic `node_repl`
  MCP server.
- When the MCP server is disabled or fails to connect, the same-named core built-in `js` is not exposed
  as a fallback, so the model never sees two state owners.

## 4. Browser bridge and security boundary

The MCP child holds no desktop/main/service implementation. At bootstrap the current Agent session creates
a local IPC broker for Node REPL:

- Unix uses a session-specific Unix domain socket; Windows uses a session-specific named pipe.
- The endpoint uses a random UUID plus a separate random token; every request validates the token.
- The wire is one JSON request/response per line; only `list` and `execute` are allowed.
- The broker validates commands against a runtime schema, then calls the injected `BrowserControlPort`.
- MCP tool `_meta` explicitly carries `sessionId`, `turnId` and trace; the child never derives identity
  from cwd/path.
- On socket disconnect or MCP call cancel the BrowserControlPort request is aborted and the existing
  `cancelRequest` chain still notifies the desktop backend.
- After the kernel generation changes, the old browser bridge reports stale immediately; an old async
  continuation must not borrow a new call's session/turn/signal.
- The browser broker is injected only when the browser-use plugin is enabled and BrowserControlPort is
  available. A pure CLI generic REPL can still run JS; browser client discovery returns an explicit
  unavailable.

`node_repl` MCP has shell-level local code execution ability; the permission system treats it as a
high-risk MCP tool. Browser command action confirmation is not pushed down to relay/main, and the MCP
child cannot bypass the existing URL, download, file-selection and backend capability policy.

The MCP kernel uses a restricted `process` facade and intercepts `require/import("node:process")`, so a
cell cannot touch stdin/stdout/stderr, exit/kill/chdir, which would break MCP stdio or kill the child. The
facade is not a full sandbox: dynamically imported third-party modules still run in the host Node realm,
so `js` stays approved at high/system execution level.

## 5. Multi-client and workspace boundary

- The MCP child is the execution runtime of the current Agent session, not an independent mobile Agent
  runtime or local host.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` keep sharing the existing host
  attachment and BrowserControlPort; no new task event, snapshot, queue or replay state is added.
- `workspaceIdentity` / `remoteSessionId` / `clientMode` are still injected by
  ProtocolBrowserControlBroker from the session record. The MCP pipe passes only
  `sessionId/turnId/trace` and must not build an isolation key from `workspacePath`.
- MCP server lifecycle belongs to the current session's MCP adapter; session close closes the child, the
  pipe broker and the browser session. Connection state is not kept in relay or desktop main.
- macOS and Linux use a Unix socket; Windows uses a named pipe. Paths are built only with `node:path`,
  `node:os` and `node:net`, never with hard-coded POSIX separators.

## 6. Migration and compatibility

- The browser runtime no longer registers core built-in `js/js_reset/js_add_node_module_dir`; the
  underlying `NodeReplSession` stays as the reusable engine of the MCP server.
- The UI node-repl renderer recognizes both the old history tool names and the new MCP fully-qualified
  names; history sessions are not rewritten.
- Permission, result budget, image artifacts and response `_meta` use the existing MCP tool bridge; any
  node-repl-specific budget is keyed by exact MCP tool name, never by parsing UI text.
- A subagent gets the same MCP server only when its allowlist/required MCP servers explicitly include
  `node_repl`; no owner-less runtime that can reach desktop tabs is started.

## 7. Acceptance cases

| Case   | Scenario          | Assertion                                                                                                                                                 |
| ------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NRM-01 | app bootstrap     | MCP status has host `node_repl`; model tool names are `mcp__node_repl__js*`; no bare `js*`                                                                |
| NRM-02 | MCP tools/list    | the three tools have correct names and strict schemas; the `js` model contract requires `code + title` while the runtime still accepts old code-only calls |
| NRM-03 | two `js` calls    | top-level bindings persist; different MCP process/session are isolated                                                                                    |
| NRM-04 | `js_reset`        | binding/browser generation cleared, module roots kept                                                                                                     |
| NRM-05 | add dir           | absolute path true first time, false on repeat, relative path rejected                                                                                    |
| NRM-06 | output            | write/console/result, BigInt/circular error, image blocks and `_meta` projection correct                                                                  |
| NRM-07 | timeout/cancel    | kernel reset; old async continuation and old browser bridge cannot be reused                                                                              |
| NRM-08 | browser bootstrap | host `ZCODE_PLUGIN_ROOT` builds a cross-platform file URL and importing `scripts/browser-client.mjs` makes `agent.browsers` available; no Skill-dir path guessing |
| NRM-09 | browser command   | pipe validates token/schema/context and calls the same-session BrowserControlPort                                                                         |
| NRM-10 | forged pipe       | wrong token, illegal op/command, wrong session all fail closed                                                                                            |
| NRM-11 | plugin disabled   | browser skill/client bridge not injected; host `node_repl` still runs generic JS                                                                          |
| NRM-12 | namespace         | a same-named user/plugin server cannot override host-reserved `node_repl`                                                                                 |
| NRM-13 | desktop/mobile    | clientMode/workspaceIdentity/remoteSessionId still decided by the shared-host session record                                                              |
| NRM-14 | packaging         | filesystem seed, SEA, Desktop, production remote and development remote all contain the server and browser-client; the development hash covers the client script |
| NRM-15 | MCP settings      | the browser-use plugin shows read-only `node_repl`; status and 3 tools come from real `mcp/list`; runtime name has no plugin prefix                       |

## 8. Delivery state and remaining risk

Implemented and covered by automation: host-reserved `node_repl`, real stdio MCP server, explicit
browser-client bootstrap, authenticated local broker, MCP `_meta` passthrough, UI old/new identity,
SEA/Desktop/production remote asset collection. Development remote reuses the same top-level asset
contract and explicitly covers `scripts`. The MCP settings page shows `node_repl` through the official
browser-use plugin host-MCP association metadata without changing the host identity; filesystem seed and
SEA use the same top-level asset allowlist, and the Dev cache must contain `scripts/browser-client.mjs`.
The model input schema reuses `@zcode/contracts`; new calls must carry a readable title and the execution
layer still accepts old code-only calls. Black-box contract checks passed (tools/list, strict schema,
empty code, module dir first/repeat results, illegal path `-32602`), as did a real ZCode MCP stdio child
smoke and a fake-BrowserControlPort MCP -> browser-client -> pipe -> broker integration chain.

Still needs real-machine verification:

- Real navigate + DOM snapshot in ZCode Dev IAB (only broker integration tests exist; no mock result is
  passed off as a real device).
- Windows named pipe, mobile Web remote, SSH/WSL/Docker remote workspace regression.
- Launch-level smoke of the SEA and Electron three-platform installers; only asset collection and bundle
  contract automation exist.
