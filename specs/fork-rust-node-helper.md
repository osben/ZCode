# Node helper for the Rust agent (JS-only features in Rust mode)

Status: approved 2026-11-13 (decisions D1–D3 below). Phase 2 in progress: F1+F2 merged (#447), F3 in progress. Revised with PR1: `helper/initialize` shape, notification relay without a wrapper, the memory rule, the plugin reload follow-up.

Related: `specs/fork-agent-runtime-selection.md` (runtime choice, Host gate), `specs/fork-rust-agent-parity.md` ("Out of scope", which this spec shrinks).

## Problem

With `ZCODE_FORK_AGENT_RUNTIME=rust` the desktop conversation agent is `zcode-rs`. Some features exist only as JavaScript inside the Node agent. Today `zcode-rs` answers them with `-32601` or `proto.unsupportedCommand`, or skips the plugins that need them (`ext/src/plugins/select.rs` `NodeDependency`). These features are:

- JS plugin runtimes and plugin UI (`plugins/*`, `mcp/ui*`).
- Dynamic workflows (`workflows/*`, `v4/conversation/workflowRun*`, `startSavedWorkflow`, `resumeWorkflowRun`, `amendWorkflowRunSettings`).
- The Office runtime.
- The node-repl host.
- Browser and computer-use interactions.

The user's decision (2026-11-13) is that in Rust mode these features work by delegating **only** them to a small Node helper process, instead of being refused.

## Findings that shape the design

There are two shapes of feature, not one.

1. **Sessionless.** The handler only reads or writes shared storage (files, the shared `db.sqlite`, the plugin store). It needs no live session.
   - `plugins/*` management.
   - `workflows/*` CRUD.
   - The `workflowRun*` journal reads.

   The helper can serve these by itself.

2. **In-turn.** The feature is a tool call inside a turn that Rust owns, or a panel bound to a live session's MCP connection. Examples: node_repl, the Office MCP servers and panels, browser, computer use, and workflow execution.
   - The helper can host the JS part, but the turn, the permission prompt, the model, the projection and the stream to the UI are Rust's.
   - Each of these features needs Rust-side work in addition to delegation. This spec lists that work per family.

Per-family evidence (file:line) is in the notes folder (`rust-node-helper-findings.md`). The key facts are below.

- **Plugin management.** The Host already sends it to a separate sessionless "plugin lane" process (`zcodeAgentService.ts:1493`, `:4333`). In Rust mode that process is `zcode-rs` too, so Settings → Plugins fails today.
  - Mutations take a cross-process file lock (`bootstrap/src/plugins.ts:99-117`).
  - `plugins/cancelOperation` aborts an in-process `AbortController` map (`zcode-protocol/server.ts:1072-1090`). It must reach the process that started the operation.
- **Saved workflows** are `.dwf.ts` files (`<cwd>/.zcode/workflows`, `~/.zcode/workflows`).
  - Runs live in `db.sqlite` tables `dwf_run`, `dwf_actor`, `dwf_node` and `dwf_event` (upstream migration `0019_dwf_journal`).
  - Node serves the seven `workflowRun*` reads by cold-resuming a session app (`v4-gateway.ts:2274`) and reading the journal.
- **Workflow execution.** Runs start from the model tool `CreateWorkflow` (always ask) or from the `startSavedWorkflow` command.
  - Each run's engine spawns a sandboxed Node child.
  - Each actor is a full Node `AgentRuntime` with its own session row (`session_task_link` `dwf/<runId>/…`).
  - Progress is appended to the **parent** session as `DynamicWorkflowRunProgress` events. The projection reduces them into the `workflowRuns` snapshot key and the `workflowRun.updated`/`removed` deltas.
  - The run needs the parent's model factory, permission mode, active turn input id and abort.
- **node_repl** is a stdio MCP server (tool `js`, shown as `mcp__node_repl__js`). Node injects it when browser-use or computer-use is enabled (`bootstrap/src/app/built-in-node-repl.ts`).
  - It runs as `execPath <bundle> __zcode-plugin-host <server.js>` with `ELECTRON_RUN_AS_NODE=1`.
  - It is stateless per call.
  - It trusts `_meta["com.zcode/request-context"]` for `session_id`/`turn_id`.
  - It is pinned to MCP `2026-07-28` with `legacy: "reject"`. Rust's MCP client speaks `2025-06-18`.
- **Browser.** The `js` worker talks to a broker socket hosted **inside the Node agent** (`NodeReplBrowserBroker`). The broker sends the agent→Host requests `interaction/browserList` and `interaction/browserExecute`. Main owns the browser.
  - The Node turn loop drives `openScope`, `turnEnded`, `closeSession` and `cancelRequest`, plus an end-of-turn screenshot.
- **Computer use.** The Host puts `ZCODE_CUA_PERMISSION_BROKER_SOCKET` in the agent env. The agent passes it only to node_repl.
  - The only protocol message is the notification `computer-use/operation-event`.
  - `packages/zcode-cua` is a fail-closed stub in this repo.
- **Office.** Each of the documents, spreadsheets and presentations plugins has:
  - skills (Python via Bash);
  - a stdio MCP server (`dist/server.mjs`, run through `__zcode-plugin-host`), whose state is per session;
  - a panel (`ui://<plugin>/panel.html`).

  The panels use the 16 `mcp/ui*` methods. These are bound to the session's MCP connection by a lease (`mcp-ui/protocol.ts:217-301`).
  - `uiSampling` calls the session's model.
  - `uiRegisterAppTools` adds tools to the live turn, which the UI answers via claim/resolve.
  - Events go out as `pluginUi.*` v4 deltas in the conversation stream.

- **Rust today.**
  - It skips every plugin with a Node dependency, and their skills with them. That loses `docx`, `xlsx`, `pptx`, `control-browser` and `computer-use`.
  - It loads plugins once per process.
  - It reports neither `pluginDiscoveryUi` nor `pluginExtensionSummary`.

## Product rules

1. **Rust mode only.** With Node effective, nothing in this spec runs. With `zcode-rs` started outside the desktop (CLI, no helper command in env), the families stay refused exactly as today.
2. **Rust stays the single owner of conversations.** The helper never creates, opens, resumes or writes a conversation that Rust owns.
   - It never runs `ensureHostRecordForJournalRead` or a session app for a Rust session.
   - Anything that changes a conversation goes through Rust: rows, turns, events, deltas, permission prompts, model calls, usage.
3. **The helper serves only the allowlisted families below.** Rust forwards a method to the helper only if it is in the allowlist (a static table in Rust). Everything else keeps today's answer.
4. **No new Host or Main ownership.**
   - Main stays as is.
   - The Host keeps one agent client per lane. The Host-side change is limited to two things: passing the helper command in the agent env, and reporting capabilities that are now served.
   - Mobile web-remote reaches the same Host clients, so it gets the families with no extra agent.
5. **No new `setting.json` keys.** The helper command arrives as an env var written by the Host.
6. **Failure is explicit.** A helper that cannot start or that dies fails the affected call with the stable code `proto.forkRustAgent.nodeHelperUnavailable`. Calls are never silently dropped. Rust keeps serving everything else.
7. **The memory budget is part of the contract.**
   - The helper starts lazily on the first allowlisted call.
   - It exits after an idle period with no in-flight call and no open in-turn resource. An open resource is a live MCP child, a panel instance or a running workflow.
   - Its idle RSS is measured and recorded in this spec (see "Memory" below). The helper is a subcommand of the same bundle, so its RSS is that of a Node process with the plugin and workflow modules loaded, not of a small script. A separate, smaller bundle was measured and saves nothing (it pulls in the same dependency graph). The budget is therefore enforced by the lifecycle: no helper until the first forwarded call, and none after 5 idle minutes.

## Who spawns the helper

| Option                                                                                        | Covers                                                                                                                                                                                            | Cost                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Host: give the plugin lane a Node resolver, or route by method in a composite Host client | Plugin-lane methods only. `mcp/ui*`, `listUiSurfaces`, `mentionItems`, `referenceCatalog`, `workflowRun*` and `workflows/*` with a workspace go through the chat client, so they still reach Rust | The plugin lane becomes a full Node `app-server` (~350 MB). In-turn traffic from Rust cannot reach a Host-owned helper without a new Rust→Host→helper channel, which would make the Host a broker of turn traffic. Agent→Host requests from the helper have no session routing on the Host side |
| **(b) Rust agent (chosen)**: each `zcode-rs` process spawns its own helper child              | All families through one mechanism. Rust forwards allowlisted methods from its `unsupported` fallback and relays helper→Host messages on its own connection                                       | One helper per Rust process that uses a family. With per-workspace chat lanes, that is one helper per active workspace plus one for the plugin lane, all lazy and idle-reclaimed                                                                                                                |

With option (b) the Host keeps exactly one agent client per lane, unchanged. Session routing of relayed requests works because they arrive on the Rust client, which already knows the session → workspace mapping.

### Helper command

- `fork-agent-runtime/command.ts` already resolves the Node bundle as `storagePreparationEntry`. In Rust mode it also sets `ZCODE_FORK_NODE_HELPER_COMMAND` in the agent env, as JSON `{command, args, env}`:
  - `command`: `process.execPath`;
  - `args`: `[<bundle>, "__zcode-rust-helper", "--stdio"]`;
  - `env`: `{ELECTRON_RUN_AS_NODE: "1"}`.
- Rust passes it through unchanged and never builds the command itself.
- `__zcode-rust-helper` is a new fork subcommand of the same bundle. Like `__zcode-plugin-host`, it is checked in `cli/src/main.ts` **before** the full `run.ts` import, so it loads only the helper's modules.
- The helper never runs storage preparation or migrations. Storage is prepared by the Host Worker before Rust starts.

## Owners

| Thing                                                                                                                      | Owner                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Session, turn, queue, projection, rows, deltas, permission prompts, model calls, usage                                     | Rust agent                                                                                                        |
| Helper process lifecycle (spawn, idle reclaim, kill on exit)                                                               | Rust agent (`helper` module in `protocol-zcode`, one per server)                                                  |
| Allowlist of forwarded methods and relayed helper→Host messages                                                            | Rust agent (static table)                                                                                         |
| Plugin store, plugin config and secrets mutations; saved workflow files; `dwf_*` journal reads                             | Helper, through the existing Node code (`bootstrap/src/plugins.ts`, `saved-workflows*.ts`, journal repositories)  |
| Node-hosted MCP children (node_repl, `__zcode-plugin-host` servers) and their per-session state; the browser broker socket | Helper                                                                                                            |
| `plugins/cancelOperation` abort map                                                                                        | Helper, always the same instance as the operation (rule: management methods of one Rust process share one helper) |
| Agent client per lane, env, capability report                                                                              | Host (unchanged except the env var and capability flags)                                                          |
| Browser surface                                                                                                            | Main (unchanged)                                                                                                  |

## Protocol (Rust ↔ helper)

The protocol is JSON-RPC 2.0 over the helper's stdio, with the same framing as Host ↔ agent. Rust is the client and the helper is the server, but both sides can send requests.

### Rust → helper

- **`helper/initialize`** `{protocolVersion: 1}`
  - The helper answers `{protocolVersion, methods}`: the forwarded methods it serves. Rust forwards a method only if it is in Rust's static allowlist **and** in `methods`.
  - The helper is process-wide and never bound to one workspace: every forwarded call carries its own `workspace`, as on the Host's plugin lane. The helper resolves the storage root, the plugin store and the session database from the same env and config as a Node agent would (`createConfig`, `getSessionDbPath`, `getPluginStorageRoot`), so both runtimes address the same files.
  - The helper answers `{protocolVersion, families}`.
  - On a version mismatch the helper is treated as unavailable.
- **Forwarded methods.** These are sent verbatim, with the same params and result as the Host ↔ Node protocol:
  - `plugins/*`
  - `workflows/*`
  - the seven `v4/conversation/workflowRun*`
  - `mcp/ui*`, but only after Rust has checked that the session is one of its own (see Office)
- **`helper/session/open`** `{sessionId, rootSessionId, cwd, workspaceIdentity, permissionMode}` and **`helper/session/close`** `{sessionId}`
  - Sent when Rust opens or closes a session that uses an in-turn family.
  - On `close` the helper ends that session's broker scope, MCP state and panel leases.
- **`helper/tools/list`** `{sessionId}` returns `[{name, description, inputSchema, risk, scope, alwaysAsk, server}]`.
  - These are the tools of the helper-hosted MCP servers that are enabled for that session.
  - The risk fields are Node's classification (`core/src/mcp/index.ts:135-147`).
- **`helper/tools/call`** `{sessionId, rootSessionId, turnId, toolCallId, name, input}` returns `{content, isError, display?}`.
  - Cancellation uses the standard JSON-RPC cancel of the request id. The helper maps it to MCP `notifications/cancelled`.
- **`helper/turn/ended`** `{sessionId, turnId, reason}` (notification). It drives the broker's `turnEnded`.
- **`provider/updateAccountConfig`**: only with workflow execution. See Decision D1.

### Helper → Rust

- **Relayed agent→Host requests.** Rust forwards these to the Host on its own connection and returns the Host's answer.
  - Allowlist: `interaction/browserList` and `interaction/browserExecute`.
  - Rust does not read their payloads, beyond requiring that the `sessionId` names a session it owns.
- **`helper/sampleModel`** `{sessionId, request}`. Rust runs it through the session's model and records usage. Used by `mcp/uiSampling`.
- **`helper/appTools/replace`** `{sessionId, instanceId, tools}`. Rust replaces the app-provided tools of that session's registry, as Node's `replaceMcpAppProvidedTools` does.
- **Relayed notifications.** The helper sends them under their Host method names. Rust forwards an allowlisted name to the Host or into the stream, and drops any other:
  - `plugins/operationProgress`: forwarded to the Host verbatim.
  - `pluginUi.*`: Rust ingests them as live-only deltas on that session's v4 stream.
  - `computer-use/operation-event`: forwarded to the Host verbatim.

### Diagram

Owners and event order for an in-turn helper tool, and for a panel.

```
UI/Host           Rust agent (owner)                 Node helper                  MCP child / Main
  │  v4 command ───► turn starts; model asks
  │                  for mcp__node_repl__js
  │ ◄── permission prompt (Rust, risk from tools/list)
  │ ── allow ──────► helper/tools/call {sessionId,turnId,toolCallId} ─►
  │                                                    MCP tools/call + request-context _meta ─► node_repl
  │                                                    ◄─ broker socket: agent.browsers.* ──────── node_repl
  │ ◄── interaction/browserExecute (relayed) ◄──────── request {sessionId}
  │ ── result (Main drove the browser) ─────────────► ─────────────────────────► broker ─► node_repl
  │                  ◄─ result {content, display} ───── ◄─ MCP result ───────────────────── node_repl
  │ ◄── tool row + node_repl_images display (Rust projection)
  │                  turn ends ─► helper/turn/ended ─► broker turnEnded
  │                  session closes ─► helper/session/close ─► scope/MCP/panel cleanup

Panel: UI ─► Host chat client ─► Rust (checks the session is its own) ─► helper mcp/uiOpenInstance
       helper ─► pluginUi.* ─► Rust live delta ─► UI
       helper ─► helper/sampleModel ─► Rust model (usage on the session) ─► result ─► helper
```

Two orderings are guaranteed.

- Rust sends `helper/turn/ended` only after the turn's last `helper/tools/call` has settled or been cancelled.
- It sends `helper/session/close` only after `turn/ended`.

The helper treats a call for an unknown or closed session as an error. It never re-opens that session.

## Families

The table lists, for each family, what is delegated to the helper, the Rust-side work needed, and the Host-side work needed.

| Family                                                                                                                                                                                                                                                                  | Delegated to the helper                                                                                                                                                                                                   | Rust-side work (beyond forwarding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Host    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **F1 Plugin management**: list, overview, describe, install, uninstall, update, setEnabled, configure, resetConfig, validate, restoreBuiltin, marketplace/\*, resolveSuggestedReference, cancelOperation, readUserOptions, listUiSurfaces, sessionless referenceCatalog | everything                                                                                                                                                                                                                | report `pluginExtensionSummary` while a helper command is configured (`pluginDiscoveryUi` is a subscribe-time flag for in-session discovery events and stays off); relay `plugins/operationProgress`. **Plugin reload**: a Rust agent loads the plugin set once per process (`Ext::start`). A Rust agent started after a change sees it; an already running one keeps its set until it restarts. Re-reading the set at session creation, as Node does per app, is a follow-up (it touches skill roots, agents, hooks and the MCP server set) | env var |
| **F2 Saved workflows and run history**: `workflows/*`, the seven `workflowRun*`                                                                                                                                                                                         | everything, as direct journal and file reads. The helper never cold-resumes a session (rule 2)                                                                                                                            | `v4/conversation/workflowRuns` stops answering an empty list and forwards. A cold subscribe fills the `workflowRuns` snapshot key from `workflowRuns` (journal history only; Rust has no live runs until F5)                                                                                                                                                                                                                                                                                                                                 | none    |
| **F3 Office tools and panels**: Office MCP servers, their skills, the 16 `mcp/ui*`, `plugins/mentionItems`, `referenceCatalog` with a `sessionId`                                                                                                                       | The MCP connections of the `__zcode-plugin-host` servers (per-session state, with the panel and the model on the same instance); the `mcp/ui*` protocol code against a thin session facade                                | `select.rs`: the PluginHost dependency becomes "served by the helper" instead of skipped, so skills load; helper tools in the turn (`tools/list`, `tools/call`, cancel); `helper/sampleModel`; `helper/appTools/replace` plus the claim/resolve mailbox in the session registry; `pluginUi.*` live deltas; session-ownership check before forwarding `mcp/ui*`                                                                                                                                                                               | none    |
| **F4 node_repl and browser**                                                                                                                                                                                                                                            | The node_repl MCP connection (Node's adapter sets `request-context` and protocol `2026-07-28`, so neither Rust blocker applies); the browser broker socket and its `openScope`/`turnEnded`/`closeSession`/`cancelRequest` | `select.rs` NodeRepl dependency served by the helper (browser-use and computer-use skills load); always-ask high-risk permission from the tool's `risk`; keep the `node_repl_images` display (today dropped at `projection/mod.rs:773-777`); relay `interaction/browser*`; `helper/turn/ended`; end-of-turn screenshot (D2)                                                                                                                                                                                                                  | none    |
| **F5 Workflow execution**: `CreateWorkflow` and the other nine gated tools, `startSavedWorkflow`, `resumeWorkflowRun`, `amendWorkflowRunSettings`, `cancelBackgroundWork` for runs                                                                                      | see D1                                                                                                                                                                                                                    | see D1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | see D1  |
| **F6 Computer use**                                                                                                                                                                                                                                                     | node_repl gets `ZCODE_CUA_PERMISSION_BROKER_SOCKET` from the helper's env (Rust passes it from its own env to the helper only, never to other children)                                                                   | relay `computer-use/operation-event`, built by the helper from its tool events                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none    |

### F1+F2 forwarded methods

- Plugins: `plugins/list`, `plugins/overview`, `plugins/describe`, `plugins/install`, `plugins/uninstall`, `plugins/update`, `plugins/setEnabled`, `plugins/configure`, `plugins/resetConfig`, `plugins/validate`, `plugins/restoreBuiltin`, `plugins/marketplace/add`, `plugins/marketplace/remove`, `plugins/marketplace/update`, `plugins/resolveSuggestedReference`, `plugins/cancelOperation`, `plugins/readUserOptions`, `plugins/listUiSurfaces`, `plugins/referenceCatalog`, `plugins/referenceCatalogWithCategory`.
- Saved workflows: `workflows/list`, `workflows/get`, `workflows/updateMeta`, `workflows/delete`, `workflows/runs`, `workflows/move`, `workflows/save`, `workflows/forRun`.
- Run history: `v4/conversation/workflowRuns`, `workflowRunEvents`, `workflowRunArtifacts`, `workflowRunArtifactData`, `workflowRunArtifactRead`, `workflowRunWorkspace`, `workflowRunNodeResult`.
  - Answered from the journal and the artifact store directly, with the gateway's limits. The helper never builds the run service (its constructor reconciles orphan runs, a journal write) and never cold-resumes a session.
  - Chunked `workflowRunArtifactRead` reads share one load per artifact version through a cache with the gateway's byte budget and TTL, least recently read evicted first (an entry counts as read when its load settles). A load in flight is not dropped by the TTL, so concurrent readers of a slow store share it, but it is dropped after four TTLs, so a store read that never settles cannot pin its key.
- Not forwarded in F1+F2: `plugins/mentionItems` (F3, needs the session), `skills/referenceCatalog` (Rust answers it), `lsp/*` (out of scope).
- Like Node's server, the helper invalidates its plugin caches after each plugin mutation, and `plugins/cancelOperation` aborts the operation with that `operationId` in the same helper.
- `plugins/referenceCatalog` and `plugins/referenceCatalogWithCategory` are served for drafts (no `sessionId`, workspace authority). With a `sessionId`, Node answers from that session's frozen catalog and must not fall back to workspace authority. The session belongs to the Rust agent. In F1+F2 the helper refused that branch (`sessionUnavailable`, `data.reasonCode = proto.forkRustAgent.sessionPluginCatalogUnavailable`); since F3 Rust opens the session in the helper first and the helper answers from the frozen catalog (see F3).
- The saved-workflow methods open the session database only when they read the dwf journal: `workflows/runs`, `workflows/save` and `workflows/forRun`. The other five only touch workflow files and answer without a database, as in Node.
- Without a helper command, `v4/conversation/workflowRuns` keeps answering `{runs: []}` and every other method stays `-32601`.

### F3 Office tools and panels

Status: in progress (PR after #447). This section replaces the F3 row's sketch where they differ.

**Helper-hosted plugins.** With a helper command configured (`PluginSources.node_helper`), the MCP servers of these admitted plugins are helper-hosted:

- official plugins whose MCP stdio args contain `__zcode-plugin-host`: today documents, spreadsheets, presentations and pdf. Without a helper they stay skipped (`NodeDependency::PluginHost`);
- any plugin whose manifest declares an MCP App entry point: a non-empty `ui.surfaces`, or a `slots["composer.mention"]` entry with a `target.tool`. Without a helper these load as today, with servers Rust runs itself and no panel or mention items.

All MCP servers of such a plugin are helper-hosted, because Node resolves a mention tool over all servers of the plugin and a panel may call any of them. OfficialAuth plugins stay skipped. The node_repl plugins are F4.

Why plugin-level MCP Apps go through the helper too: the panel and the model must reach the same server instance, and only Node's adapter and `mcp-ui` code speak the panel protocol. The two MCP App E2E fixtures (`e2e-mcp-viewer`, `e2e-mcp-mention`) are inline plugins of this kind.

**Not ported yet: MCP Apps on servers Rust runs itself** (a user or project MCP server whose tools carry `_meta.ui`). Forwarded session methods that name such a server are refused with `proto.forkRustAgent.mcpUiServerNotHelperHosted` (`-32602`, `data.reasonCode`).

**One source of server configuration.** Rust marks a helper-hosted server with `McpTransportConfig::NodeHelper` and sends only its name (`plugin:<plugin>:<server>`, the same in both runtimes). The helper takes the server's config from its own Node plugin resolution of the workspace (`resolveZCodePlugins`, resolved once per helper process). So the model's connection and a panel's connection are the same pool entry, and Rust never re-encodes Node's config.

**Model tools: Rust stays the MCP client, the helper is the pipe.** Rust's `McpManager` owns a helper-hosted server like any other: naming (`mcp__plugin_<plugin>_<server>__<tool>`), deferral and ToolSearch, WaitForMcpServers, the per-server tool timeout, cancel via `notifications/cancelled`, result conversion. Only the transport differs. The connection is a channel to the helper:

| Message (Rust ↔ helper)                              | Meaning                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `helper/mcp/connect {connection, server, workspace}` | Request. The helper connects the server through Node's MCP pool (a lease of its own) and answers `{}` once connected, or an error |
| `helper/mcp/send {connection, message}`              | Notification, Rust → helper: one MCP JSON-RPC message from Rust's client                                                          |
| `helper/mcp/message {connection, message}`           | Notification, helper → Rust: one MCP JSON-RPC message to Rust's client                                                            |
| `helper/mcp/closed {connection, reason}`             | Notification, helper → Rust: the real server's connection closed                                                                  |
| `helper/mcp/close {connection}`                      | Notification, Rust → helper: Rust closed the connection                                                                           |

`workspace` is `{workspacePath, workspaceIdentity?}`. A helper serves one workspace (its Rust process's); a second workspace is refused. The helper protocol version is 2 from F3 on: a Rust build and a helper of different versions refuse each other at `initialize`.

The helper answers Rust's MCP messages as a small MCP server facade over Node's port:

- `initialize` answers the protocol version Rust asked for and the `tools` capability with `listChanged: true`. The real server's `tools/list_changed` is forwarded to every pipe connection of that server.
- `tools/list` lists only model-visible tools (Node's `resolveMcpToolVisibility` includes `"model"`), with `name`, `description`, `inputSchema`, `annotations`, and `_meta["zcode/alwaysLoad"]` when the descriptor is `alwaysLoad`. A `cursor` is accepted; there is no `nextCursor`.
- `tools/call`: Rust adds `_meta["zcode/helperContext"] = {sessionId, turnId?, runtimeScope}` for helper-hosted servers only. The helper calls Node's `callTool` on **that session's lease** (see session open), with the trace, `runtimeScope`, `turnId` and workspace fields Node's own MCP tool entry sends. So a session-isolated server runs one instance per session, shared by the model and the panel, as in Node.
- `notifications/cancelled` aborts the call. `ping` answers `{}`. Notifications are never answered. Any other request answers `-32601`.
- Rust's `tools/list` lease is the pipe's own: for a session-isolated server that is one extra instance per Rust process, used for listing only.

**Session open and close.** Before the first forwarded session call, and before the first helper tool call of a session, in each helper generation, Rust sends and awaits:

```
helper/session/open {sessionId, rootSessionId?, workspace, pluginIds: [...], servers: [...]}
```

- `pluginIds` are the plugins Rust admitted in this process. The helper freezes the session's reference catalog from its plugin resolution; an entry is enabled only when Rust admitted it, so the picker and Rust agree on one plugin set.
- `servers` are the helper-hosted server names. The helper acquires a session lease from its MCP pool (`sessionId` isolation) and connects them before answering. A failed server is logged and left out; the session still opens.
- `rootSessionId` is the root of a subagent session when Rust knows it (a foreground subagent chain); otherwise absent. It goes into the session trace, so Node's adapter sends it to the server as `root_session_id` in `_meta["com.zcode/request-context"]`, next to `session_id` and `turn_id`.
- The helper session has no Node session lifecycle: the helper sets a lifecycle that is always ready, because Rust owns the session and opened it before forwarding.
- `helper/session/close {sessionId}` (notification) is sent when Rust closes a session it opened in this generation. The helper does Node's close steps: abort the session's panel tool calls, clear its app tools, unsubscribe its resources, close its lease.

**Session-scoped forwarded methods.** Same params and result as Host ↔ Node:

- the 16 `mcp/ui*` methods and `mcp/readResource`;
- `plugins/mentionItems`;
- `plugins/referenceCatalog` and `plugins/referenceCatalogWithCategory` with a `sessionId` (the session's frozen catalog; drafts stay sessionless as in F1).

Rust forwards one only when the session is one of its own (open or resumable in this process), and, for a method that names a `serverName`, when that server is helper-hosted; `plugins/mentionItems` names a plugin, which must be helper-hosted. Otherwise Rust answers `proto.forkRustAgent.mcpUiServerNotHelperHosted`.

**Helper → Rust requests (F3).** Each carries a `requestKey` (the request id). When the helper abandons one (the panel call was aborted, the session closed), it sends the notification `helper/cancelRequest {requestKey}` and does not wait for the answer; Rust drops its work for that key (a pending prompt is withdrawn, a sampling request is cancelled).

- `helper/authorizeAppTool {sessionId, serverName, toolName, input, tool: {description?, inputSchema, annotations?}}`
  - Node's `authorizeAppTool` for `mcp/uiCallTool` and `plugins/mentionItems`. App-only tools are not in Rust's tool list, so the helper sends the descriptor and Rust builds a transient MCP tool from it, as Node's `createMcpToolEntry` fallback does.
  - Rust runs the admission part of its tool pipeline on it, named `mcp__<server>__<tool>`: schema validation, `validate_input`, PreToolUse hooks, the rules and the gate, with a session-scoped prompt when it asks. It does not run the tool or PostToolUse hooks.
  - The answer is `{input}` (the approved, possibly hook-updated input), or an error whose `data.type` is Node's `CoreErrorType` (`permission_denied`, `invalid_input`).
  - "Always allow" lands in Rust's rules, so later model calls of that tool are allowed too.
- `helper/sampleModel {sessionId, request}`
  - `mcp/uiSampling`: Rust runs one side request on the session's current model selection (source `mcpSampling`) and records the call's usage on the session as a `model_usage` row.
  - The answer is Node's `sampleModel` result shape.
- `helper/appTools/replace {sessionId, tools: [{name, modelName, serverName, pluginId, toolName, title?, description?, inputSchema, readOnlyHint?, destructiveHint?, idempotentHint?}]}` → `{registered: [names]}`
  - Node's `replaceMcpAppProvidedTools` is synchronous and returns the applied names at once, so the helper answers the panel with its own prediction (Node's registry, deduplicated) and sends the request without waiting. A name Rust skipped is only logged in the helper (`fork_rust_helper.app_tools.skipped`).
  - Rust replaces that session's app-provided tools (`app__…` names) in an overlay of its tool registry keyed by the exact session id. A name that clashes with an existing tool is skipped, as in Node. They are visible from the session's next tool round.
  - A model call of one sends `helper/appTools/call {sessionId, turnId, toolCallId, name, input}` (request) and gets `{content, isError}`. A cancelled call sends `helper/appTools/cancel {sessionId, toolCallId}`.
  - The claim/resolve mailbox stays in the helper (Node's `appToolsProtocol.ts`). The UI answers it through the forwarded `mcp/uiClaimAppToolCall` and `mcp/uiResolveAppToolCall`.
- `helper/session/delta {sessionId, delta}` (notification)
  - One of `pluginUi.resourceUpdated`, `pluginUi.resourceListChanged`, `pluginUi.instanceClosed`, `pluginUi.appToolCall`, shaped by Node's projection mapping (`product-projection.ts`).
  - Rust appends it to that session's live stream only, in the session's frame order: not persisted, not in the snapshot, like Node's sequence-0 events. Other ops, and sessions Rust has no live projection for, are dropped.

**Elicitation.** A helper-hosted server's elicitation request is declined by the helper. Not ported yet: relaying it to Rust's elicitation prompt.

**Helper connection.** Pipe messages, `helper/session/*` and the responses to the helper's own requests bypass the helper connection's serial request queue, so a tool call or its cancel never waits behind a plugin install.

**Lifecycle changes (F3).**

- **Open resources.** An open helper MCP connection or an open helper session keeps the helper alive; idle reclaim needs neither.
- **Per-method timeouts.** Each forwarded method uses the Host's timeout for it: 300 s for `plugins/*` and `workflows/*`, 65 s for `mcp/uiSampling`, 180 s for everything else (the Host's default). Model tool calls are timed by Rust's MCP client (the server's `timeoutMs`, else `MCP_TOOL_TIMEOUT`), which cancels with `notifications/cancelled`. A slow tool call never drops the helper.
- **Timeout rule.** A timed-out forwarded call keeps the process when it was heard from since the call started, or when it answers `helper/ping` within 5 s. Only a process that fails both is dropped.
- **Crash.**
  - Rust's MCP connections over the helper close. A helper-hosted server then reconnects with the backoff of a remote server (a new helper generation starts on the reconnect), instead of failing for good as a stdio server does; once the breaker keeps the helper down, it fails after the usual reconnect limit.
  - For every panel instance Rust saw opened (`mcp/uiOpenInstance` answers) in that generation and not closed, Rust sends `pluginUi.instanceClosed` on the session stream.
  - App tools registered by that generation are removed. Helper sessions reopen lazily in the next generation.
- **Lazy start.** `McpManager` registers helper-hosted servers as pending at `Ext::start` and connects them on the first tool snapshot of any session (a turn), or when an MCP status listing asks for them. The plugin lane runs neither, so it never starts the helper for them.

**Memory.** With the Office plugins enabled (the default), a Rust process that ran a turn keeps a helper and the Office servers for as long as its connections are open. This is the same set of servers a Node agent runs for its sessions, plus the helper (324 MB idle, see "Memory").

### Why the helper, not Rust, is the MCP client for Node-hosted servers

Rust already speaks stdio MCP, so it could spawn node_repl and the Office servers itself. Doing so would hit five Rust blockers:

- the `request-context` `_meta`;
- MCP `2026-07-28` with `legacy: "reject"`;
- `isolation: "workspace"`;
- the CUA socket env restriction;
- a broker socket for browser.

On top of those, Rust would have to port the `mcp/ui*` lease protocol. With the helper as the MCP client, Node's own adapter and `mcp-ui` code run unchanged, and the panel and the model share one server instance. Rust keeps what it must own: the turn, permissions, the model and the stream. Rust's MCP client stays in use for ordinary plugin MCP servers.

### Decisions (approved 2026-11-13)

- **D1. Workflow execution (F5) is not a thin delegation.**
  - Each actor is a full Node `AgentRuntime`, with its own session row, model calls, tools and permission prompts.
  - Each run appends progress to the parent conversation, and it starts or extends a turn of the parent (`workflowLaunch`, `workflowSettingsAmend` origins).
  - Delegating it means the helper hosts the Node runtime for actor sessions. Those sessions are separate from Rust's, but they are Node-owned conversations, which breaks "one runtime per app process" for actors only. The helper would also need the provider configuration and the credential cipher relay, and its memory would approach the full agent while a run is active.
  - Rust has to:
    - expose the ten tools through `helper/tools/*` with the parent context;
    - write launch and amend turns;
    - fold relayed run progress into `workflowRuns` and its deltas;
    - route actor permission prompts.
  - Options:
    - **(A)** Do F5 as the last family with that scope, as its own spec section after F1–F4 land.
    - **(B)** Keep F5 refused in Rust mode (`updateDynamicWorkflowPolicy` stays `enabled: false`), and ship only F2's history reads.
  - **Decided: (A).** Everything goes through the Node helper, workflow runs included. F5 is the last PR, after F1–F4 are merged; until then F5 stays refused, while saved workflows and run history ship with F1+F2.
- **D2. End-of-turn browser screenshot.** In Node this is turn-loop logic (`core/src/runtime/methods/browser-turn-screenshot.ts`). The proposal is to port it into Rust's turn end as one relayed `interaction/browserExecute`, rather than having the helper drive a turn it does not own. **Decided: port it into Rust's turn completion.**
- **D3. Computer use (F6)** can only be unit-tested. `packages/zcode-cua` is a fail-closed stub, so neither runtime can run CUA E2E in the box. F6 ships with F4 (env pass-through plus notification relay), covered by unit tests only. **Decided:** each F6 PR states that E2E is impossible on both runtimes, because the stub always refuses.

## Lifecycle and failure modes

- **Spawn.**
  - The first allowlisted call starts the helper and sends `helper/initialize`. Concurrent first calls share one start.
  - `plugins/cancelOperation` with no helper running or starting is answered `{operationId, cancelled: false}` without starting one: no operation can be in flight. During a start it waits for the helper and is forwarded, since the operation it names may be the call that triggered the start.
  - With a helper configured but unavailable, a forwarded method fails with `proto.forkRustAgent.nodeHelperUnavailable`; `v4/conversation/workflowRuns` too, rather than an empty list that would hide the failure. `{runs: []}` stays the answer only when no helper is configured.
  - No helper command in env: the families answer as today (refused).
- **Idle reclaim.** After 5 minutes with no in-flight call, no open session that has helper resources, no panel instance and no live MCP child, Rust ends the helper.
  - F1+F2 (shipped): Rust kills the helper's process group, which takes the helper's children with it. On Windows the helper gets its own Job (`Containment::OwnJob`), which closes when the guard drops. The process-level Job that MCP servers use would keep each dropped helper alive until the Rust process exits, so a launch that falls back to it is refused as a failed launch. The trade-off: on a Windows machine where the helper cannot get its own Job, the forwarded families answer `nodeHelperUnavailable` (with the start cooldown and one `warn`) instead of working while leaking a helper per reclaim until the Rust process exits. Dropping the guard stops the tree in a task (TERM, then KILL after the grace period), so the stop is confirmed and the helper's ledger record is removed instead of one record per generation waiting for the next sweep. If that task cannot run (the Rust process is shutting down), dropping the tree still kills its group. The guard is always dropped after the state lock is released. No call is in flight at that point, and the helper holds no state that needs a flush: the session store is SQLite with WAL.
  - A call dropped by its caller stops counting as in flight, so it never keeps an idle helper alive.
  - F4 (planned): close stdin first and give the helper a grace period, so live MCP children and panels shut down in order.
  - F3: an open helper MCP connection or helper session also keeps the helper (see F3).
- **Rust exit.** The helper sees stdin EOF and exits, killing its MCP children. Rust also kills the helper's process tree on drop, as the Host does for agents. The helper starts through the Rust process ledger (`rust_cli_proc::ledger`, group isolation, as MCP stdio servers do), so a Rust process that dies without cleanup has the helper reaped by the next one.
- **Helper crash.**
  - In-flight forwarded calls fail with `proto.forkRustAgent.nodeHelperUnavailable`.
  - An in-flight tool call returns a tool error to the model, and the turn continues.
  - Open panels receive `pluginUi.instanceClosed`.
  - The next call respawns the helper. After 3 crashes in 60 s it stays down until the Rust process restarts, and every call fails fast with the same code.
- **Helper hang.** Each forwarded method uses the Host's timeout for that method. Tool calls use the server's tool timeout (node_repl 600 s).
  - F1+F2 (shipped): every forwarded call has 300 s, the Host's plugin-management timeout, and `helper/initialize` has 30 s (all calls wait on a start). On timeout Rust fails the call as unavailable.
    - The process is kept if other calls are in flight on it and it has been heard from since the timed-out call started: an answer, any notification (relayed or not, such as `plugins/operationProgress`), or a request. It is alive, and only this call is slow (a long install). A hung call on a live process is then left to its cancel and to the idle reclaim.
    - On a kept process, a timed-out call that carries an `operationId` (trimmed, non-empty, as `getPluginOperationId`) is cancelled in the helper with `plugins/cancelOperation`, fire and forget, with the Host's 5 s cancel deadline. Otherwise the abandoned operation would keep running and stay registered under its id. The Host cancels an operation when the user cancels it or the UI abandons it (a workspace or attachment switch, a superseded suggested prompt), but not on its own request timeout. Operation ids are unique per Host request, so the cancel names only the abandoned call.
    - Otherwise the process is hung, and Rust drops it. That is not counted as a crash, and the next call starts a new helper. The other calls in flight on it fail as unavailable. Without this rule, a hung helper would never be dropped while overlapping calls keep arriving.
  - F3: per-method timeouts and the `helper/ping` liveness check (see F3, "Lifecycle changes"). Tool calls are timed and cancelled by Rust's MCP client.
  - F4 (planned): the node_repl tool timeout (600 s) and its cancel.
- **Version mismatch** in `helper/initialize`: the helper is treated as unavailable for the life of the Rust process, with a single `warn`. A launch or initialize failure is not a crash. For 30 s after it, calls fail fast with the same code and start nothing (the run list is polled on every subscribe, so a broken bundle must not cost a Node process per call); the first call after that tries again. One `warn` covers a run of failures; a launch failure names the program file and the OS error. A start runs on its own task, so a caller that gives up mid-start does not strand the launched process. A start that panics or is aborted, and a helper that advertises no methods, count as failed starts with the same cooldown.
- **Logging.**
  - Rust `info`: `helper.spawned`, `helper.exited`, `helper.reclaimed`. The exit code is not logged: the process ledger's handle does not report it.
  - Rust `warn`: `helper.crashed`, `helper.unavailable`.
  - No params, paths or secrets are logged.
  - The helper logs to stderr, which Rust forwards at `debug`.

## Shared storage

- The helper opens the same `db.sqlite` and plugin store that the Host Worker prepared.
  - It runs no storage preparation. Opening the session store runs Node's idempotent migration check, which is a no-op on the database the Host Worker already prepared.
  - It writes only:
    - plugin store and config files, under Node's cross-process plugin lock;
    - saved workflow files.
  - It reads `dwf_*` and artifacts only. With D1 (A) it would also write `dwf_*` and the actors' session rows.
- **Cross-runtime rule.** Plugin state and saved workflows written by the helper are read by a Node agent unchanged, and the reverse holds too: it is the same code on the same files.

## Acceptance scenarios

1. **Settings → Plugins.** In Rust mode it lists, enables, disables, installs and uninstalls plugins. A Rust agent started after an enable sees the plugin's skills; in a running Rust agent, new tasks see it only after the agent restarts (follow-up, see F1). Cancel during install aborts it.
2. **Saved workflows panel** in Rust mode lists, renames, moves and deletes saved workflows. A task's run history created earlier by the Node agent shows its runs, events, artifacts and node results.
3. **Office.**
   - Asking the model to open a `.docx` calls `open_document`.
   - The documents panel opens on the same session state, and `capture_view` round-trips through the app tool mailbox.
   - Sampling from the panel is billed to the session.
4. **node_repl.** A `js` call asks for approval, runs, returns text and images, and the image card renders. Stop during a call cancels it.
5. **Browser.** A browser-use task opens a page in the desktop browser through `interaction/browserExecute`. Turn end and session close release the scope.
6. **Helper unavailable.** With the helper command pointing to a missing file:
   - every family answers `proto.forkRustAgent.nodeHelperUnavailable`;
   - plain chat in Rust mode is unaffected.
7. **Helper crash during a tool call.** The tool row shows an error, the next call respawns the helper, and three quick crashes keep it down.
8. **Idle reclaim.** With no use for 5 minutes the helper process is gone. The next call starts it again.
9. **Node mode.** Nothing changes, and no helper is spawned.

## Tests

- **Rust unit tests** (`protocol-zcode` `helper`):
  - allowlist forwarding;
  - unknown methods stay `-32601`;
  - relay allowlist and the session-ownership check;
  - lazy start shared by concurrent calls;
  - crash → error code, respawn and the 3-in-60 s breaker;
  - idle reclaim timer;
  - the turn-ended-after-last-call ordering;
  - `select.rs` with a helper (Node-dependent plugins are routed, not skipped) and without one (skipped as today).
- **Fork Vitest** (`scripts/fork-test-files.json`):
  - the helper subcommand answers `helper/initialize`, F1 and F2 methods against a temp storage root;
  - it never opens a session app for `workflowRun*`;
  - the Host command sets `ZCODE_FORK_NODE_HELPER_COMMAND` in Rust mode only.
- **Desktop E2E in the box**, on both runtimes:
  - existing plugin-management and saved-workflow specs (F1, F2);
  - F3: `plugins/extensions/plugin-extension-entries` (a panel opens and calls an MCP App tool) and `plugins/extensions/plugin-extension-mention` (mention items with the approval prompt: deny, then always allow). There is no Office panel E2E spec; the Office servers are covered by the fork Vitest of the helper facade and by these two specs, which use the same path;
  - node-repl and browser-use specs (F4).

  The exact spec names are listed per PR from `packages/desktop/test/e2e`. A spec that fails on both runtimes is not a parity gap.
  - F1+F2 PR:
    - `plugins/installation/plugin-management-personal-lifecycle`;
    - `plugins/installation/plugin-management-builtin-inline`;
    - `plugins/installation/plugin-concurrent-install`;
    - `automations/workflows/automations-workflows-hub`.
  - In the workflows hub spec, the "saved workflows hub" and "global workflows hub" groups are F2. The "direct launch" group starts and observes runs, which is F5; on Rust it stays failing until F5.

- **Memory.** Idle RSS of the helper after F1 calls, measured on the packaged bundle and recorded here.
  - 2026-11-13, macOS arm64, the F1+F2 bundle (`cli/dist/zcode.cjs`) run by the packaged app's Electron binary with `ELECTRON_RUN_AS_NODE=1` (Node 24, as the Host starts it), empty storage root:
    - spawn to `helper/initialize` answer: about 0.6 s;
    - RSS after `helper/initialize`: 266 MB;
    - RSS after `plugins/list`, `plugins/overview`, `workflows/list` and `v4/conversation/workflowRuns`, and still 10 s later: 324 MB.
  - The same bundle under system Node 26: 357 MB and 394 MB.
  - This memory is held only while a forwarded method is in use: the helper starts on the first forwarded call and exits after 5 idle minutes.
  - **Known cost (parent decision 2026-11-13).** The 324 MB idle figure is over the 150 MB budget. This is accepted as a known cost and does not block. Cheaper options are a later task. A plain system Node binary is not one of them: it measured larger (394 MB) than the Electron binary run as Node.

## Delivery

One PR per family, in this order: F1+F2 (helper skeleton plus the sessionless families), then F3, then F4+F6, then F5 (after F1–F4 are merged). Each PR updates the "Out of scope" section of `specs/fork-rust-agent-parity.md` and its matrix rows.
