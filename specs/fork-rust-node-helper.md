# Node helper for the Rust agent (JS-only features in Rust mode)

Status: approved 2026-11-13 (decisions D1–D3 below). Phase 2 in progress: F1+F2 merged (#447), F3 merged (#459, #473, #477), F4 designed 2026-11-16 (see "F4 node_repl and browser"). Revised with PR1: `helper/initialize` shape, notification relay without a wrapper, the memory rule, the plugin reload follow-up.

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
- **`provider/updateAccountConfig`**: was planned for workflow execution. Not needed under D1 as revised on 2026-11-17 (Rust runs the actors itself, see `specs/fork-rust-workflow-engine.md`).

### Helper → Rust

- **Relayed agent→Host requests.** Rust forwards these to the Host on its own connection and returns the Host's answer.
  - Allowlist: `interaction/browserList` and `interaction/browserExecute`.
  - Rust does not read their payloads, beyond requiring that the `sessionId` names a session it owns.
- **`helper/sampleModel`** `{sessionId, request, source}`. Rust runs it through the session's model and records usage. Used by `mcp/uiSampling`.
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

| Family                                                                                                                                                                                                                                                                  | Delegated to the helper                                                                                                                                                                                                   | Rust-side work (beyond forwarding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Host                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **F1 Plugin management**: list, overview, describe, install, uninstall, update, setEnabled, configure, resetConfig, validate, restoreBuiltin, marketplace/\*, resolveSuggestedReference, cancelOperation, readUserOptions, listUiSurfaces, sessionless referenceCatalog | everything                                                                                                                                                                                                                | report `pluginExtensionSummary` while a helper command is configured (`pluginDiscoveryUi` is a subscribe-time flag for in-session discovery events and stays off); relay `plugins/operationProgress`. **Plugin reload**: a Rust agent loads the plugin set once per process (`Ext::start`). A Rust agent started after a change sees it; an already running one keeps its set until it restarts. Re-reading the set at session creation, as Node does per app, is a follow-up (it touches skill roots, agents, hooks and the MCP server set) | env var                                                           |
| **F2 Saved workflows and run history**: `workflows/*`, the seven `workflowRun*`                                                                                                                                                                                         | everything, as direct journal and file reads. The helper never cold-resumes a session (rule 2)                                                                                                                            | `v4/conversation/workflowRuns` stops answering an empty list and forwards. A cold subscribe fills the `workflowRuns` snapshot key from `workflowRuns` (journal history only; Rust has no live runs until F5, which is specified in `specs/fork-rust-workflow-engine.md`)                                                                                                                                                                                                                                                                     | none                                                              |
| **F3 Office tools and panels**: Office MCP servers, their skills, the 16 `mcp/ui*`, `plugins/mentionItems`, `referenceCatalog` with a `sessionId`                                                                                                                       | The MCP connections of the `__zcode-plugin-host` servers (per-session state, with the panel and the model on the same instance); the `mcp/ui*` protocol code against a thin session facade                                | `select.rs`: the PluginHost dependency becomes "served by the helper" instead of skipped, so skills load; helper tools in the turn (`tools/list`, `tools/call`, cancel); `helper/sampleModel`; `helper/appTools/replace` plus the claim/resolve mailbox in the session registry; `pluginUi.*` live deltas; session-ownership check before forwarding `mcp/ui*`                                                                                                                                                                               | none                                                              |
| **F4 node_repl and browser**                                                                                                                                                                                                                                            | The node_repl MCP connection (Node's adapter sets `request-context` and protocol `2026-07-28`, so neither Rust blocker applies); the browser broker socket and its `openScope`/`turnEnded`/`closeSession`/`cancelRequest` | `select.rs` NodeRepl dependency served by the helper (browser-use and computer-use skills load); always-ask high-risk permission from the tool's `risk`; keep the `node_repl_images` display (today dropped at `projection/mod.rs:773-777`); relay `interaction/browser*`; `helper/turn/ended`; end-of-turn screenshot (D2)                                                                                                                                                                                                                  | none                                                              |
| **F5 Workflow execution**: `CreateWorkflow` and the other nine gated tools, `startSavedWorkflow`, `resumeWorkflowRun`, `amendWorkflowRunSettings`, `cancelBackgroundWork` for runs                                                                                      | see D1 (revised 2026-11-17: `specs/fork-rust-workflow-engine.md`)                                                                                                                                                         | see D1 (revised 2026-11-17: `specs/fork-rust-workflow-engine.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | see D1 (revised 2026-11-17: `specs/fork-rust-workflow-engine.md`) |
| **F6 Computer use**                                                                                                                                                                                                                                                     | node_repl gets `ZCODE_CUA_PERMISSION_BROKER_SOCKET` from the helper's env (Rust passes it from its own env to the helper only, never to other children)                                                                   | relay `computer-use/operation-event`, built by the helper from its tool events                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none                                                              |

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

All MCP servers of such a plugin are helper-hosted, because Node resolves a mention tool over all servers of the plugin and a panel may call any of them. OfficialAuth plugins stay skipped: a plugin-host plugin with any official-auth server is skipped as `OfficialAuth`, whatever the order of its servers. The node_repl plugins are F4.

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

A connect that Rust gives up on is closed in the helper too:

- Rust sends `helper/mcp/close` and drops the pipe whenever its connect does not succeed: an error answer, its timeout, or the caller dropping it.
- A close without a non-empty string `connection` is refused and logged, like a malformed session close; it never closes a guessed connection.
- A close that reaches the helper while that connection is still connecting makes the connect release its lease and answer an error once it finishes. Otherwise a late connect would keep a lease and an MCP child that nothing closes, and the helper would never be idle.

`workspace` is `{workspacePath, workspaceIdentity?}`, keyed `workspaceIdentity?.trim() || workspacePath`. A Rust process may serve several workspaces, so the helper is never bound to one:

- The Host's shared local task runtime is one agent process for every local workspace, run in the data root (`<home>/.zcode`, `SHARED_TASK_RUNTIME_KEY` in `zcodeAgentProcessManager.ts`).
- The helper resolves plugins once per workspace key (`workspaceIdentity?.trim() || workspacePath`) and directory (a session in an execution worktree resolves in its worktree), and forgets a failed resolution so the next call retries. The cache keeps one entry per worktree for the helper's lifetime; it is not evicted yet.
- A pipe keeps the workspace its connect named, for its server config and its lease's working directory. Rust's pipes name their sessions' workspaces (below); the connection's own pipe names its manager group's, for listing.
- A session keeps the workspace its open named: its server configs, its lease's working directory, and its model tool calls on that lease. A panel tool call sends no workspace fields, as Node's does (`session-facade.ts:528-536`); it runs on the session's lease.

The helper protocol version is 2 from F3 on: a Rust build and a helper of different versions refuse each other at `initialize`.

The helper answers Rust's MCP messages as a small MCP server facade over Node's port:

- `initialize` answers the protocol version Rust asked for and the `tools` capability with `listChanged: true`. The real server's `tools/list_changed` is forwarded to every pipe connection of that server.
- Every notification of the helper's MCP pool also takes Node's route (`routeMcpServerNotification`, as Node's server does in `handleMcpNotification`): a server log goes to the helper's log, and `resources/updated` or `resources/list_changed` for a panel's subscription becomes that session's `pluginUi.resourceUpdated` or `pluginUi.resourceListChanged` delta. Resource notifications are not sent to the pipes.
- `tools/list` lists only model-visible tools (Node's `resolveMcpToolVisibility` includes `"model"`), with `name`, `description`, `inputSchema`, `annotations`, and `_meta["zcode/alwaysLoad"]` when the descriptor is `alwaysLoad`. A `cursor` is accepted; there is no `nextCursor`.
- `tools/call`: Rust adds `_meta["zcode/helperContext"] = {sessionId, turnId?, runtimeScope}` for helper-hosted servers only. The helper calls Node's `callTool` on **that session's lease** (see session open), with the trace, `runtimeScope`, `turnId` and workspace fields Node's own MCP tool entry sends. So a session-isolated server runs one instance per session, shared by the model and the panel, as in Node.
- `notifications/cancelled` aborts the call. `ping` answers `{}`. Notifications are never answered. Any other request answers `-32601`.
- Rust's `tools/list` lease is the pipe's own: for a session-isolated server that is one extra instance per Rust process, used for listing only.

**Session open and close.** Before the first forwarded session call, and before the first helper tool call of a session, in each helper generation, Rust sends and awaits:

```
helper/session/open {sessionId, openId, rootSessionId?, workspace, executionDirectory?, pluginIds: [...], servers: [...]}
```

- `workspace` is the session's own, as its row holds it: `workspacePath` is the row's `directory` (a draft's too), and `workspaceIdentity` is its non-empty `workspace_id`. Rust's local rows have none.
  - Never the agent's cwd: the desktop E2E runs the agent in `<home>/.zcode` while its sessions live in `<home>/ZCodeProject`.
  - A session whose row Rust cannot read is not opened; the call fails as `nodeHelperUnavailable`.
- `executionDirectory` is the session's execution worktree path. When present it must be a non-empty string, or the open is invalid params; it is never replaced by the workspace. It is sent when the session has one and its directory exists (Rust checks a local workspace only, as for the session's own cwd). As in Node, the session runs in the worktree while its key stays the parent workspace's:
  - Node's app takes the worktree as its working directory unless it is missing (`create-app.ts:200-208`). Plugin and MCP config resolution (`:220-230`), the MCP lease and its stdio children (`:607-630`, adapter spawn cwd `adapters/src/mcp/index.ts:2016`) use it.
  - The session's workspace key is the protocol workspace's, not the worktree (`create-app.ts:477-479`, `core/src/runtime/types.ts:302-307`). Node's MCP tool entry sends `workspacePath` = the working directory and `workspaceKey` = that key (`core/src/mcp/index.ts:259-267`); its session connect does the same (`core/src/runtime/methods/mcp.ts:89-97`).
  - So the helper resolves the session's plugins and connects its lease in `executionDirectory`, and sends it as the tool call's `workspacePath`. `workspace` stays the key everywhere else.
- `openId` names this open; it is unique per Rust process. The close of an open names its `openId`, so a close never ends a later open of the same session.
- `pluginIds` are the plugins Rust admitted for the session: its workspace's set when a layer is loaded for that workspace (per-workspace admission, below), else the process set. The helper freezes the session's reference catalog from its plugin resolution; an entry is enabled only when Rust admitted it, so the picker and Rust agree on one plugin set.
- `servers` are the helper-hosted server names. The helper acquires a session lease from its MCP pool (`sessionId` isolation) and connects them before answering. A failed server is logged and left out; the session still opens.
- `rootSessionId` is the top-level session of a subagent session: Rust sends it for every subagent session. Rust follows the session's parents while they are subagent sessions; the first other session is the root (a fork session is a top-level session for the agents it spawns), and a parent it cannot read is taken as the root. An interactive or fork session is its own root and sends none. Node does the same: a subagent run's trace carries `rootSessionId ?? parent` (`core/src/subagent/runner.ts:1022,1074`).
  - The stored `trace_id` is not used: Node writes the run's trace id there, not the root session.
  - Each step reads the session's view: an open session answers from its actor, a closed one is loaded from the store. That happens once per helper open.
  - It goes into the session trace, so Node's adapter sends it to the server as `root_session_id` in `_meta["com.zcode/request-context"]`, next to `session_id` and `turn_id`.
  - The Office server keeps one viewer per `root_session_id ?? session_id` (`office-runtime/src/adapters/server.ts` `sessionOf`). Without the root, a subagent's documents would land in a viewer of their own.
- The helper session has no Node session lifecycle: the helper sets a lifecycle that is always ready, because Rust owns the session and opened it before forwarding.
- `helper/session/close {sessionId, openId}` (notification) is sent when Rust closes a session it opened in this generation. The helper does Node's close steps: abort the session's panel tool calls, clear its app tools, unsubscribe its resources, close its lease.
  - A session that Rust closes while its open is still in flight is closed once the open succeeds, with that open's `openId`.
  - An open that Rust gives up on is closed with its `openId`: its timeout or the caller dropping it. The helper may still finish it, and nothing in Rust would own it. An error answer needs no close, because the helper keeps nothing of a failed open.
  - Concurrent calls of one session share one open. When that open fails, its call removes the pending entry and fails; a call that was waiting on it starts again from the registered entry and opens the session itself, which then stays registered and open. It must not open on the removed entry: that open would look closed in flight, be closed in the helper, and the call would be forwarded into a closed session.
  - The close also forgets the session's panels, so a later crash sends no `pluginUi.instanceClosed` for them.
- The helper runs the opens and closes of one session one at a time, in arrival order:
  - A close ends the session only when its `openId` is the open one; a stale close is ignored.
  - An open of a session that is already open replaces it: the old one gets the close steps, then the new open runs with its own params. Node's `openSession` used to answer `{}` and keep the old params.
  - An open that fails after its lease is acquired closes that lease before it answers the error.
  - A close without a string `sessionId` or a positive integer `openId` is refused. It is a notification, so the helper logs the refusal and keeps serving; a handler error must not close the connection.
  - An open still in its lane when the helper is disposed gets the close steps once it finishes, and answers an error.

```
Rust (NodeHelper, Running slot)              helper (ForkRustHelperMcpHost, one lane per sessionId)
ensure_session: OnceCell<openId> ──open(s,1)──► lane: [open 1] lease, connect, sessions[s]=1
  timeout or drop before the answer ──close(s,1)──► lane: [close 1] ends s if sessions[s]=1
session_closed (cell initialized) ──close(s,1)──► lane: [close 1]
reopen: new cell ──open(s,2)──────────────────► lane: [open 2] replaces s, if still open
late close(s,1) after open(s,2) ──────────────► lane: [close 1] ignored, sessions[s]=2
```

Admission resolves the session's workspace catalog, not only the process's (per-workspace plugins and MCP in Rust's shared local task runtime, `specs/fork-rust-workspace-plugins-mcp.md`). The helper client keeps one process catalog — the plugins Rust loaded for its own workspace (`cli/src/assemble/mod.rs` `helper_catalog`) — as the fallback, and a session-keyed resolver installed next to it resolves a workspace catalog: the kernel's `plugins_for_session` (`SessionWorkspaces` → the ext `WorkspaceLayer`'s loaded slot, the same resolution as the session's MCP group, `workspace_layer.rs` `plugins_of_session`), converted by the same `helper_catalog`. A session whose workspace has a loaded layer is opened, admitted (`helper_session_admit.rs`) and app-tool-authorized (`helper_answers.rs`) against that set; sessions without one — the TUI and `-p`, or a session whose workspace has no loaded layer (not opened in this process, or `Invalid`) — keep the process catalog. `helper/session/open`'s `pluginIds` and `servers` follow the same resolution, so the open, the forwarding check and the app-tool authorization name one set. The open-time resolution goes through the STORE ROW's workspace (`session_workspace`, by root path through a second resolver with a per-workspace converted-catalog cache): a store-resumable session has no in-memory workspace record until the kernel opens it, and the helper session lives for a whole generation, so its open params must not depend on that record existing; a loaded-but-empty set is a real answer (denies everything), never a fallback to the process catalog. The resolver holds the kernel weakly: the kernel already reaches the helper through the routed MCP transport, and a strong edge back would keep both alive for the process's life.

**The pipe workspace is enforced.** Each pipe stores the workspace key of its `helper/mcp/connect` (`workspaceIdentity?.trim() || workspacePath`), and a `tools/call` whose session resolves to another key never crosses it. The refusal stands at both ends: Rust's pipe writer answers the call on the pipe (`-32603`, like a failed session open) before it is sent, and the helper refuses it in `callModelTool` with the shape of its session-not-open refusal (`-32602`, `Session is in another workspace than the MCP connection: <sessionId>`; the wording was pinned nowhere, so it reuses the neighboring refusal's).

Pipes connect in their sessions' workspaces, never in the process cwd (the trap above). A Rust MCP connection — one per server per manager group, and the process group serves sessions of many workspaces — keeps:

- its **own pipe**, connected at `connect` in the manager group's workspace (`helper_workspace`): it carries the sessionless traffic (`initialize`, `tools/list`, `ping`, cancels of unknown calls) and the calls of sessions whose key is the group's. The listing lease resolving there is the group's own config view, which is what the group's tool list must show.
- **one pipe per further workspace key**, connected on the first `tools/call` of a session of that workspace, with that session's STORE-ROW workspace (`session_workspace` — the same authoritative resolution the session open uses, so the pipe's key is byte-identical to the session's; a row may carry an identity, or its path may be spelled differently than the group's root). Its messages and synthesized answers reach the same connection event stream, so Rust's MCP client correlates them as one connection; its close answers only its own in-flight calls and never ends the connection (the next call reconnects it).

  The connect runs as its own task, never on the client's send path: the key's first messages park in a per-key mailbox on the connection's route and `send` returns at once (Rust's MCP client awaits `send` before it watches a call's cancel, so the first call of a key must not hold its cancel behind a connect that may take the whole CONNECT timeout). One connect at a time per key. The mailbox lives exactly while the key's connect-and-flush task runs: while it holds messages, the key's later calls and the cancels of its parked calls park behind them — a cancel never overtakes its call, nothing overtakes what is already parked — and once the connect lands, the task drains the mailbox through the pipe in arrival order and the entry goes under the same lock that finds it empty, so a message racing the drain's end still parks instead of being dropped; after that, the key's traffic takes the published pipe directly. A connect that fails answers the parked calls on the connection with its error and enters the 30 s cooldown, inside which a later call of that key is refused at once instead of paying another connect; a key's parked backlog is capped (64) and the overflow is refused inline — a parked call is answered by id through the 1024-entry recent map, so an unbounded backlog would evict the ids it owes; a pipe that closes answers only the calls that traveled it — the ones still parked belong to their task, so a failed or abandoned connect's never-used pipe answers nothing before the task names what actually failed; and a route that died meanwhile (its own pipe closed, the connection closed) closes its late pipe and answers nothing — the terminal `Closed` already fails every in-flight call.

So pipes of different workspace keys never share. The session-row keys resolve once per helper process and are cached there, oldest evicted at 1024 entries like the route's other recent maps (a row never changes workspace, so an evicted entry is only re-resolved, never wrong; a desktop-continuous agent serves sessions without end, and the cache must not grow for the process's life). A session whose workspace cannot be resolved gets no pipe: its call is refused before it is sent, with the session open's own `nodeHelperUnavailable` text ("the session's workspace is unknown") — fail-closed as the Node reference is, where an app is only ever constructed with a session's workspace and an unknown one gets no MCP pool.

**Session-scoped forwarded methods.** Same params and result as Host ↔ Node:

- the 16 `mcp/ui*` methods and `mcp/readResource`;
- `plugins/mentionItems`;
- `plugins/referenceCatalog` and `plugins/referenceCatalogWithCategory` with a `sessionId` (the session's frozen catalog; drafts stay sessionless as in F1).

Rust forwards one only when the session is one of its own (open or resumable in this process), and, for a method that names a `serverName`, when that server is helper-hosted; `plugins/mentionItems` names a plugin, which must be helper-hosted. Otherwise Rust answers `proto.forkRustAgent.mcpUiServerNotHelperHosted`.

The ownership check does not compare workspace paths:

- The agent's cwd is not its sessions' workspace. The Host may spawn it in a fixed directory (`ZCODE_AGENT_SERVER_CWD`, the spawn fallback cwd). The desktop E2E runs it in `<home>/.zcode`, while its sessions live in `<home>/ZCodeProject`. A comparison with the helper catalog's workspace (the agent's cwd) refused Rust's own mention and MCP App calls.
- The Host routes a session's calls to the agent that owns it (owner/lease), so another workspace's session does not reach this check.

**Helper → Rust requests (F3).** Each carries a `requestKey` (the request id). When the helper abandons one (the panel call was aborted, the session closed), it sends the notification `helper/cancelRequest {requestKey}` and does not wait for the answer; Rust drops its work for that key (a pending prompt is withdrawn, a sampling request is cancelled).

- `helper/authorizeAppTool {sessionId, serverName, toolName, input, tool: {description?, inputSchema, annotations?}}`
  - `input` must be an object, and `tool` must be an object with an object `inputSchema`; otherwise the request is invalid params. The helper always sends both: Node's `input: args ?? {}` and the descriptor from its `listTools`. A defaulted descriptor would have no schema, so validation would accept any input.
  - Node's `authorizeAppTool` for `mcp/uiCallTool` and `plugins/mentionItems`. App-only tools are not in Rust's tool list, so the helper sends the descriptor and Rust builds a transient MCP tool from it, as Node's `createMcpToolEntry` fallback does.
  - Rust runs the admission part of its tool pipeline on it, named `mcp__<server>__<tool>`: schema validation, `validate_input`, PreToolUse hooks, the rules and the gate, with a session-scoped prompt when it asks. It does not run the tool or PostToolUse hooks.
  - The answer is `{input}` (the approved, possibly hook-updated input), or an error whose `data.type` is Node's `CoreErrorType` (`permission_denied`, `invalid_input`). Node's order and texts (`tool/executor/impl.ts` `authorizeAppTool`):
    - an invalid input is `invalid_input`, before any hook;
    - a PreToolUse hook that stops the turn or denies the call is `permission_denied` with `hooks.stopReason ?? "Tool denied by host hook"`. Node sets `stopReason` only with `continue: false` or `decision: "block"` (`hooks/output.ts`); a `permissionDecision: "deny"` reason alone is not the answer;
    - then a hook-updated input that fails validation is `invalid_input`, which callers report as a failed call, not a denied one;
    - then the rules and the gate: `permission_denied`. A tool the session hides answers the text a model call gets, `Error: No such tool available: <name>`.
  - "Always allow" lands in Rust's rules, so later model calls of that tool are allowed too.
  - The prompt is session-level: a turn that ends while it waits neither cancels it nor hides it. The kernel resolves a turn's own asks before `TurnFinished` (`cancel_turn_asks`, each with `InteractionResolved`), so the projection keeps every ask still pending then (before, it cleared them all; `plugin-extension-mention` lost a mention prompt asked during a turn).
    - Node's turn end drops a pending entry whose `toolCallId` is a foreground tool row that the turn closes (`closeOpenToolRows`). In Rust those entries are the turn's own asks, already resolved by the kernel.
    - An App prompt's `toolCallId` is the request key, which has no tool row in either runtime, so Node keeps it too.
    - The projection never drops an ask that the kernel still waits on.
  - When Rust gives up on the panel's `mcp/uiCallTool` (its timeout), it sends `mcp/uiCancelCall` to the helper; see "Helper hang". Node's handler aborts the call, the helper's client sends `helper/cancelRequest`, and the prompt is withdrawn. Otherwise an approval given after the timeout would still run the tool with no caller waiting.
- `helper/sampleModel {sessionId, request, source: {pluginId, serverName, appIdentity}}`
  - `mcp/uiSampling`, Node's `sampleModel`. The helper has validated `request` against `mcpAppsSamplingParamsSchema`; Rust reads the part Node forwards to the model (`messages`, `systemPrompt`, `maxTokens`) and ignores `includeContext`, `modelPreferences`, `metadata` and `source`, as Node does.
  - Rust opens the session, then runs one side request (source `mcp_app_sampling`) on the session's current model selection as it is: no small-model slot and no reasoning level. The output cap is `min(maxTokens, the model's max output)`, and the provider patch gets the same cap. `systemPrompt` is the system block; image blocks are base64 images.
  - Headers: `x-zcode-session-type: other` (Node's `modelRequestSessionType: "other"`) and `x-zcode-query-source: mcp_app_sampling`. Overload retries follow the user-facing rule (Rust's `foreground`); the Node source list for this was not found, so this is inferred from "a panel waits for it".
  - A model known to take no images refuses an image block with Node's "Selected model does not support image input", before any call and with no usage row. Unknown capabilities leave the block to the model adapter.
  - The answer is `{role: "assistant", model, content: {type: "text", text}, stopReason}`. `stopReason` is Node's mapping of the AI SDK finish reason: `endTurn` (end turn, stop sequence, pause), `maxTokens` (max tokens, context window), `content-filter` (refusal). A tool call, a tool-use or unknown reason, or none is Node's "Sampling did not produce a supported completion".
  - The call runs in the request's task, never in the session actor, and writes no message or event. A call that reached the model writes one `model_usage` row anchored to no turn: `cancelled` when the request was cancelled whatever else happened (Node's order), else `error` or `completed`. A draft session is stored by that row.
  - Rust adds no timeout: the helper's 60 s timeout, a `helper/cancelRequest` or the helper's exit cancels it through the request key. An ACP session's model refuses with Rust's external-agent refusal, as Node's `assertNotExternalAgentModel`.
  - Not ported: Node's `ensureSessionPersisted("MCP App sampling")` title seed. It only titles a session that never had a prompt, and a panel exists only after a turn's tool result.
- `helper/appTools/replace {sessionId, tools: [{name, modelName, serverName, pluginId, toolName, title?, description?, inputSchema, readOnlyHint?, destructiveHint?, idempotentHint?}]}` → `{registered: [names]}`
  - Node's `replaceMcpAppProvidedTools` is synchronous and returns the applied names at once, so the helper answers the panel with its own prediction (Node's registry, deduplicated) and sends the request without waiting. A name Rust skipped is only logged in the helper (`fork_rust_helper.app_tools.skipped`).
  - Rust replaces that session's app-provided tools (`app__…` names) in an overlay of its tool registry keyed by the exact session id. A name that clashes with an existing tool is skipped, as in Node. They are visible from the session's next tool round.
  - A model call of one sends `helper/appTools/call {sessionId, turnId, toolCallId, name, input}` (request) and gets `{content, isError}`. A cancelled call sends the notification `helper/appTools/cancel {sessionId, toolCallId}`.
  - The claim/resolve mailbox stays in the helper (Node's `appToolsProtocol.ts`). The UI answers it through the forwarded `mcp/uiClaimAppToolCall` and `mcp/uiResolveAppToolCall`.
  - Ported in F3b(b) (see "F3b(b) app-provided tools"): Rust answers `helper/appTools/replace`, keeps the overlay, and calls the app tools. The session-only "always allow" they need is F3b(a).
- `helper/session/delta {sessionId, delta}` (notification)
  - One of `pluginUi.resourceUpdated`, `pluginUi.resourceListChanged`, `pluginUi.instanceClosed`, `pluginUi.appToolCall`, shaped by Node's projection mapping (`product-projection.ts`).
  - Rust appends it to that session's live stream only, in the session's frame order: not persisted, not in the snapshot, like Node's sequence-0 events. Other ops, and sessions Rust has no live projection for, are dropped.

**Elicitation.** Servers Rust runs itself answer `elicitation/create` through the F3b(c) prompt below. A helper-hosted server's elicitation is relayed to the same prompt by `helper/elicitation` (F3b(c) PR 2, built; see "Elicitation from helper-hosted servers" below). It is declined when no tool call of that server is in flight.

**Helper connection.** Pipe messages, `helper/session/*`, `helper/ping` and the responses to the helper's own requests bypass the helper connection's serial request queue, so a tool call or its cancel never waits behind a plugin install. The timeout rule's ping is sent while a request is overdue; queued behind that request, it would time out and drop a live helper.

**Lifecycle changes (F3).**

- **Open resources.** An open helper MCP connection or an open helper session keeps the helper alive; idle reclaim needs neither.
- **Per-method timeouts.** Each forwarded method uses the Host's timeout for it: 300 s for `plugins/*` and `workflows/*`, 65 s for `mcp/uiSampling`, 180 s for everything else (the Host's default). Model tool calls are timed by Rust's MCP client (the server's `timeoutMs`, else `MCP_TOOL_TIMEOUT`), which cancels with `notifications/cancelled`. A slow tool call never drops the helper.
- **Timeout rule.** A timed-out forwarded call keeps the process when it was heard from since the call started, or when it answers `helper/ping` within 5 s. Only a process that fails both is dropped.
- **Pipe order.** A pipe's tool call waits for its session's open, and only its own session's traffic waits with it. Each session has a lane on the pipe: its calls, and the cancels of those calls (matched by `requestId`), go out in order, so a cancel never overtakes its call. Another session's traffic and sessionless messages (`initialize`, `tools/list`, `ping`, answers to the server's requests) pass a pending open, which may take the open's full timeout.
- **Crash.**
  - Rust's MCP connections over the helper close. A helper-hosted server then reconnects with the backoff of a remote server (a new helper generation starts on the reconnect), instead of failing for good as a stdio server does; once the breaker keeps the helper down, it fails after the usual reconnect limit.
  - For every panel instance Rust saw opened (`mcp/uiOpenInstance` answers) in that generation and not closed, Rust sends `pluginUi.instanceClosed` on the session stream.
  - A panel counts as closed only on a `mcp/uiCloseInstance` answer of `{closed: true}`. Node answers `{closed: false}` for a busy panel under `onlyIfIdle` and keeps it open (`mcp-ui/protocol.ts` `closeMcpUiInstance`); a crash still closes that panel.
  - An open whose answer arrives after its generation is gone fails as `proto.forkRustAgent.nodeHelperUnavailable`, so no panel stays open on a helper that no longer exists.
  - App tools registered by that generation are removed. Helper sessions reopen lazily in the next generation.
- **Lazy start.** `McpManager` registers helper-hosted servers as pending at `Ext::start` and connects them on the first tool snapshot of any session (a turn), or when an MCP status listing asks for them. The plugin lane runs neither, so it never starts the helper for them.

**Memory.** With the Office plugins enabled (the default), a Rust process that ran a turn keeps a helper and the Office servers for as long as its connections are open. This is the same set of servers a Node agent runs for its sessions, plus the helper (324 MB idle, see "Memory").

### F3b, elicitation and F5: verified Node semantics (design, 2026-11-16)

Status: design only, no code. Facts checked against the Node source (`apps/zcode-cli/packages`), not the helper.

**Session-only "always allow".** Required by F3b and F5.

- Node sets `askOptions.allowAlways: "session"` on app-provided tools (`core/src/mcp/app-tools.ts:102`) and on `CreateWorkflow`, `FillWorkflowHole` and `AmendWorkflow` (`core/src/tool/handlers/`). `SaveWorkflow` sets `false`. The `mcp/uiCallTool` and mention-item authorizations are not session-scoped: they keep the project rule (`app_tool_tests.rs` `an_always_allow_answer_stops_later_prompts_for_the_tool`).
- Wire (`bootstrap/src/permission-options.ts`): optionId `allowSession`, internal kind `allow_session`, closed-set kind `allowAlways`, label "Always allow in this session", description "Do not ask again for this tool in this session". Response `{decision: "allow", reason: "Approved for this session"}`. The broker (`bootstrap/src/zcode-protocol/interaction-broker.ts:231`) adds `sessionPermissionUpdates: [{behavior: "allow", rules: [{toolName}]}]`. Nothing is persisted: no `permissionUpdates`, no project rule.
- Scope: `PermissionService.sessionRules` (`core/src/permission/service.ts:96`) is per instance, and one instance is one agent app, so one session. It matches the whole tool name, after deny rules and before the ask (`service.ts:439`). It is lost on restart, cold resume and `/new`, and subagents have their own instance.
- Rust today: `commands.rs` `permission_answer` maps only `allowOnce` and `allowAlways`; `projection/state.rs:303` hard-codes the project label; `session/turn_interact.rs` `resolve` commits `Fact::PermissionRulesAdded` for any `remember`. No session-scoped grant exists.
- Proposed owner: the session actor (`crates/session`). It keeps `session_allow: Vec<tool name>`. `resolve` with the session answer adds to it and commits nothing. `ask` checks it first and resolves Allow without a prompt. The state dies with the actor, which gives Node's lifetime. The gate needs no new state, and `local_rules_committed` is not called.

**App-provided tool registry (F3b).** The helper already sends `helper/appTools/replace` (`fork-rust-helper/session-record.ts:163`) and serves `helper/appTools/call` and `helper/appTools/cancel` (`mcp-host.ts:465`). Rust has only the authorize side (`runtime/src/app_tool.rs`). Missing: a per-session overlay of `app__` tools appended to the turn's tool snapshot, replaced by each `replace`, and a Tool whose execution sends `helper/appTools/call` as a request. Cancel is the `helper/appTools/cancel` notification. Tools registered by a helper generation are dropped when it crashes.

**Elicitation from helper-hosted servers.** Node's MCP adapter (`adapters/src/mcp/index.ts:1152`) passes the session from `activeCallTraces`, which is set during `callTool` from the request's `trace.sessionId` and `trace.turnId`. Without a trace it declines, because the session cannot be determined (`contracts/src/interfaces/mcp.port.ts:465`). The helper's `runtime.ts:104` always declines, and the pipe path never sets a trace, so the trace has to be rebuilt from the `_meta["zcode/helperContext"]` of the in-flight `tools/call` on the pipe. Rust has no MCP elicitation interaction: only AskUserQuestion and ExitPlanMode exist (`projection/elicitation.rs`). A helper relay alone is not enough. Needed: a kernel `InteractionRequest` variant for MCP elicitation, its projection to a `userInput` pending interaction with the requested schema, the answer mapping, and the helper request `helper/elicitation` that carries the request key.

**Built (F3b(c) PR 2, `helper/elicitation`).** The variant, projection and answer mapping are PR 1's, reused as they are.

- Helper (`bootstrap/src/fork-rust-helper/elicitation-relay.ts`). The helper registers each pipe `tools/call` while it is in flight, with its session and turn from `zcode/helperContext` and its tool use id from `zcode/toolUseId`. A question of the server attaches to the newest such call of that server. It sends `helper/elicitation {requestKey, sessionId, turnId?, toolUseId, serverName, message, requestedSchema}` and answers the server with Rust's `{action, content?}`. It declines at once, without asking, when no pipe call of the server is in flight, when the call has no tool use id, or for a mode other than form. When the call ends, the open question is abandoned (`helper/cancelRequest`), and the server gets `cancel`.
- Rust (`protocol-zcode/src/fork/helper_elicitation.rs`, `helper_answers.rs`). The request opens the session, and its question is asked through the session's tool context (`kernel-api` `mcp_elicitation`, runtime `elicit_mcp`), which withdraws on the request's cancel. The answer is `ext`'s `helper_elicitation_answer`, the PR 1 answer function with the helper's abandon as its withdrawal. A failed or refused question is an error, which the helper answers with a decline.
- Divergences from Node. (1) Node attaches a question to the session of `activeCallTraces`, which it keeps per server name and sets for any `callTool` of the adapter. The helper attaches only to pipe calls (the helper's own calls, such as the MCP UI's, do not register), so a question during one of those is declined, where Node would ask. (2) Node's dialog stays open after its call times out (its handler has no abort signal). Here the call's end closes it, as PR 1 does for Rust-run servers. (3) A question whose call has no `zcode/toolUseId` is declined, because Rust's prompt is anchored on the call's tool row and has no row to attach to.
- Tests: `apps/zcode-cli/packages/bootstrap/tests/fork-rust-helper/elicitation-relay.test.ts` (the helper relay), `protocol-zcode/src/fork/node_helper_requests_tests.rs` (`a_helper_elicitation_*`), `protocol-zcode/src/fork/helper_elicitation_tests.rs` (parse), `ext/src/mcp/rpc_tests.rs` (`helper_relay`). The desktop E2E is not run here.

**F3b(a) session-only allow: decided shape (2026-11-16, PR 1 of the stack).**

- `Tool::allow_session()` (default false) says the tool offers "Always allow in this session". Only tools that set it (app-provided `app__` tools, later the workflow tools) get the option. `once` and `independent` asks never offer it, as with the project option.
- `InteractionRequest::Permission` gains `session_allow: bool` (serde default, omitted when false). It is set by the pipeline from the tool, never by the gate.
- The v4 projection adds option `optionId: "allowSession"`, `kind: "allowAlways"`, label "Always allow in this session", in the project option's slot. The project option `allowAlways` is not offered on such an ask.
- The answer `allowSession` (Rust `PermissionAnswer::AllowSession`, wire `decision: "allow_session"`) is accepted only when offered; otherwise it is a deny, like any option the ask did not offer.
- Owner: the session actor. It keeps a set of tool names granted for the session. Resolving `AllowSession` adds the tool name and resolves the waiter as `Allow { remember: [] }`, so the pipeline is unchanged. It commits nothing: no `PermissionRulesAdded` fact, no LocalSettings row, no `local_rules_committed`.
- A later permission ask in the same session whose tool is in that set is answered `Allow` at once, with no pending interaction and no prompt event. The set lives in the actor: it dies with it, which gives Node's lifetime (restart, cold resume, `/new`).
- Another session has its own actor and set, so it still asks.
- Tests: `runtime/src/session_allow_tests.rs` (red first): the grant is session-scoped, it does not reach a second session, it writes no project rule, and a not-offered `allowSession` is refused.

**F3b(b) app-provided tools (decided 2026-11-16, PR 2 of the stack; built on F3b(a)).**

- Owner: the Node helper's `NodeHelper` (`protocol-zcode/src/fork/node_helper_app_tools.rs`) owns the overlay: `sessionId → (generation, [AppToolSpec])`. Only a live generation's set is visible, and a process exit drops that generation's sets (`app_tools_lost`). The kernel holds the overlay's reader only, as `AppToolHost` (`kernel-api/src/app_tool.rs`), so no second copy of the set exists.
- `helper/appTools/replace {sessionId, tools}` (helper to Rust) answers `{registered: [names]}` at once. It carries no `requestKey`: nothing waits on it and nothing can cancel it. It replaces the whole set of the session; a duplicate `modelName` keeps the first (Node's `replaceMcpAppProvidedTools`), and an entry Rust cannot take (no `modelName`, `serverName` or `toolName`) is left out of `registered`, with one warn per replace that names how many were dropped (`helper.app_tools.dropped`). The helper sends the replaces of one session one at a time (`fork-rust-helper/ordered-queue.ts`), so they reach Rust in the order made: Rust serves each request in its own task and cannot order two in flight itself. A name that a built-in or MCP tool already has is not a `replace` error: the registry skips it at snapshot and find time (see Registry), so the model never sees two tools of one name.
- Registry: `ExtRegistry::snapshot(session)` appends the session's overlay tools after its MCP tools, and `find_for(session, name)` looks them up after the base and MCP tools. A name collision keeps the existing tool, as Node's `replaceMcpAppProvidedTools` does: an app tool is not listed when lookup resolves its name to a listed tool (`answers_to`, so a legacy name such as `Task` for `Agent` counts), and each accepted app tool takes its name for the rest of the list, so a host that lists one name twice shows it once. They are not in the session-less `tools()` or `find()`. An app tool is not deferred (`always_load`), as Node's entries are direct. A name the API would refuse (longer than 128 UTF-16 units, the F67 rule) is left out with a one-time warn, as the MCP listing does.
- Tool `AppTool` (`ext/src/mcp/app_provided.rs`): name is the `modelName` (`app__<server>__<tool>`); description is Node's (`title` when it differs from the tool name, then `description`, then "(Tool provided by the <server> app page; available only while the app is open.)", joined by blank lines); input schema normalized to an object; read-only, destructive and idempotent from the hints; `allow_session()` is true, so the ask offers "Always allow in this session"; cancel message "App tool <modelName> was cancelled".
- Routing: neither `helper/appTools/call` nor `helper/appTools/cancel` is advertised in the helper's `helper/initialize` `methods`, and neither is in `FORWARDED_METHODS`, so `forward()` never carries them (its advertisement gate would refuse both). The call takes a link of the process that owns the session's set (`running_link`), and it never starts a helper: a set whose process is gone fails the call at once. The cancel takes the running process's peer (`running_peer`), never starts a helper and never opens a session, and it is a notification, because the helper serves `helper/appTools/cancel` only as one. Its send is bounded by `Timing::cancel`, the same bound as an abandoned call's cancel (in production both are 5 s; a test that stalls the writer to exercise that bound is not built yet).
- Call: `helper/appTools/call {sessionId, turnId, toolCallId, name, input}`, a session-scoped request (the helper opens the session first, through `send_on`). Its `{content, structuredContent?, isError?, _meta?}` result maps through the MCP result mapping (`error_text`, `transform`, `truncate`), as Node's `normalizeMcpToolResultForModel` and `formatMcpToolResult` do, with the configured MCP output budget (`max_output_tokens`) for the answer and for an error text alike. A call the helper never answers is timed out, and its process is kept only when it answers `helper/ping`; the kept process then gets `helper/appTools/cancel` for that call (`abandoned_cancel`). When the call's cancel fires, the call returns cancelled at once and the cancel is sent detached, so a wedged helper never holds the turn. A host failure names the tool: `App tool "<tool>" of "<server>": <error>`.
- Result budget (as built): an app tool declares `result_budget_truncate_bytes` 50 000 (`Limit::Truncate`), Node's `resultBudget` with strategy `truncate` and `maxModelBytes` 50 000 (`core/src/mcp/app-tools.ts`). The pipeline applies it to every result, error results included, since `budget::apply` runs on each `Ok` tool output. An oversized result is head-cut to 50 000 bytes with Node's suffix `[Tool output truncated by resultBudget: originalBytes=N, maxModelBytes=50000, strategy=truncate]` (no `artifactPath`), and no artifact is written, as Node's `serializeToolResult` does. Other tools keep `Limit::Bytes` (artifact, head-cut only when persisting fails) and `Limit::Chars`.
- Failures: a helper that does not answer, or a call of a name the helper no longer has, is a tool error for that call only. A helper that is gone means the tools are gone from the next snapshot. A malformed entry of a `replace` (no `modelName`, `serverName` or `toolName`) is left out of `registered`, and the rest of the set is applied: the helper has applied the whole set already and reads `registered` as the subset Rust serves. A `replace` of a process that is gone keeps no set, and a late `replace` of an older process never overwrites a newer process's set for the session.
- Tests (red first): `ext/src/mcp/app_provided_tests.rs` (naming, schema, hints, session allow, result mapping, the name guard, the single-tool lookup, the configured output budget, the error text naming the tool, a cancel that never returns not holding the turn, the result budget), `ext/src/lib_tests.rs` (an app tool never shadows an MCP tool of the same name), `protocol-zcode/src/fork/node_helper_app_tools_tests.rs` (replace answers, dedupe, live-generation filter, process exit clears the set, a stale replace keeps nothing, a malformed entry left out; a call reaches the helper through `NodeHelper` as a request, a cancel as a notification that opens no session and starts no helper, a call after its helper crashed starts none, a call the helper never answers is cancelled in the helper). The routing and cancel tests run against the fake helper process of `node_helper_tests.rs`, which records notifications apart from requests.

**F3b(c) MCP elicitation on Rust-run servers: decided shape (PR 1 of 2, 2026-11-17).** Scope: servers whose MCP client is Rust's (`crates/ext/src/mcp`). Helper-hosted servers are PR 2 (`helper/elicitation`, built; see "Elicitation from helper-hosted servers" above).

- Owners.
  - The MCP client connection (`ext/src/mcp/rpc.rs`, `Client`) owns the registry of in-flight tool calls on that connection and answers `elicitation/create`. The registry is per connection, so it dies with the connection.
  - The session actor owns the pending interaction and its waiter, as for AskUserQuestion. The MCP client never holds session state beyond the entry of a call that is in flight.
  - protocol-zcode owns the projection to a pending `userInput` and the mapping of the App's answer to the MCP result (`projection/elicitation.rs`).
- Capability. `initialize` advertises `capabilities.elicitation = {"form": {}}` next to `roots`. Only form mode is supported. Node advertises it only when its elicitation port exists, which is always on desktop; Rust advertises it always, and a request that cannot be answered is declined (see below).
- Wire, server to Rust: `elicitation/create {mode?, message, requestedSchema}`.
  - A mode that is absent, `"form"`, `"openai/form"` or `"openaiForm"` is supported (Node's `isSupportedElicitationMode`). Any other mode, such as `"url"`, is answered `{action: "decline"}` without asking.
  - The answer is `{action: "accept", content}`, `{action: "decline"}` or `{action: "cancel"}`.
- Registry entry. `McpTool::call` registers the call around its `tools/call` request, through a guard. The entry holds the tool use id, the call's `interactions` handle (the session's, so the session is the one asked), and a cancel token that is a child of the call's `ToolUseContext.cancel`. Dropping the guard removes the entry and cancels the token. With several calls in flight on one server, an elicitation attaches to the most recently registered call. A guard removes only its own entry, so a finished call never removes a newer one (Node's `activeCallTraces` deletes by server name).
- Kernel. `InteractionRequest::McpElicitation {tool_use, server, message, requested_schema, origin}` (`kind: "mcp_elicitation"`), and `Answer::McpElicitation(McpElicitationAnswer)` with `Accept { content }` (wire `decision: "accept"`), `Decline` (`"decline"`) and `Cancel` (`"cancel"`). `Answer::nobody` for this request is `Decline`, so `-p` declines.
- Pending interaction, Rust to App (projection, Node's `createPendingInteractionFromPermissionEvent` MCP branch):
  - `{interactionId, kind: "userInput", anchorRowId, createdAt, payload: {kind: "userInput", prompt: message, freeText: true, toolCallId, toolName: "McpElicitation", input: {serverName, message, requestedSchema}, schema: {interaction: "mcp_elicitation", serverName, requestedSchema}, questions}}`. The anchor is the call's tool row.
  - `questions` are Node's `mcpElicitationQuestions`: a field per supported property (string, number, integer, boolean, or enum of strings). Boolean has Yes/No options with values `"true"`/`"false"`. Number, integer, string and an enum without values use the free-text sentinel `__zcode_free_text__`. A schema without fields gives one question "Answer" with the message as text.
- Answer, App to Rust: `resolveInteraction {action, content}`.
  - `decline` and `cancel` pass through as `Decline` and `Cancel`.
  - `accept` (or no action with content) maps the answers to MCP content by the requested schema, as Node's `mcpElicitationContentFromAnswers`: keyed `answers[question]`, else `answer_<index>`, else `answer` for the first field. Boolean is true for `"true"` or `yes`. Number and integer parse, and an unparseable value is left out. The sentinel is left out. A field with no answer is left out.
  - No action with content or free text accepts: free text counts as the `answer` key, so it fills the first field (Node's `content.answer` path). No action, no content and no free text is `Decline`.
- Event order.
  1. `tools/call` is sent. The server may send `elicitation/create` before its response.
  2. The reader does not block on the question. It hands the request to a task, so the `tools/call` response and other traffic keep flowing.
  3. The task checks the mode. With no registry entry it answers `decline` at once. Otherwise it calls `interactions.ask` (the session actor registers the pending interaction and emits the projection).
  4. The answer maps to the MCP result, and the task replies to the server.
  5. If the call ends first, the task calls `cancel_ask(tool_use)` (the dialog closes and a late answer is refused) and replies `cancel`.
- Cancel and timeout. The call's end is the end of the elicitation: a tool call cancelled by the user or by the turn, or timed out by the server's `timeoutMs`, cancels a pending elicitation of that call. Divergence: Node's handler has no abort signal and keeps the dialog open after its call times out. Rust closes it, because a dialog whose call is gone can only be answered into nothing.
- Lifetime. A connection that closes fails the call's `tools/call` with `Closed`, which drops the guard, so the same rule cancels the elicitation. A reconnect is a new connection with an empty registry.
- Failures. An ask that fails (session gone, interaction failed) or answers with another kind is `decline`.
- Tests (red first): `ext/src/mcp/rpc_tests.rs` (capability in `initialize`; no call means decline; a call's elicitation is asked and each answer kind reaches the server; a mode other than form declines without asking; cancelling or ending the call withdraws the ask and replies `cancel`; a failed ask declines). `protocol-zcode/src/projection/elicitation_tests.rs` (the pending interaction shape for a string, a boolean, an enum and a schema without fields; the answer mapping by type; decline, cancel, and accept without content). Both sides are unit tests; the desktop E2E for MCP elicitation is not run here (see the PR).
- **PR 2, `helper/elicitation`: built** (see "Elicitation from helper-hosted servers"). The pipe `tools/call` entry is the helper's registry, and the question reuses PR 1's `McpElicitation` interaction, answers and withdrawal unchanged. Tests: `protocol-zcode/src/fork/node_helper_requests_tests.rs` (`a_helper_elicitation_*`, the reply, the abandon, a missing key), `protocol-zcode/src/fork/helper_elicitation_tests.rs` (parse; no tool use means no call), `ext/src/mcp/rpc_tests.rs` (`helper_relay`: accept, decline and cancel, a failed ask, a mode other than form, an abandoned request), `apps/zcode-cli/packages/bootstrap/tests/fork-rust-helper/elicitation-relay.test.ts` (11 cases: no call, attribution to the newest call, accept without content, the answer kinds, a failed ask, a call without tool use, a mode other than form, the withdrawal when the call ends, a question after the end, another server's call).

**F5 workflow execution.** Needs the session-only allow above. Owner decision (2026-11-17, D1): Rust ports the workflow engine and runs each actor as its own Rust child session, so rule 2 holds and the helper never runs an actor. The design, the storage rules (Node-format `dwf_*` rows) and the PR plan are in `specs/fork-rust-workflow-engine.md`.

**F7 MCP Apps on Rust-run servers.** Needs the lease and sampling ledger in Rust, as described in "MCP Apps on Rust-hosted servers" below. It is the largest family and is not started.

### F4 node_repl and browser (design, built in three PRs)

Status: decided 2026-11-16 (the user accepted the recommendations below). Built in three PRs, each branched from `origin/fork`:

- **F4a**: node_repl hosting: the helper computes the server config, Rust routes the server through the helper, the tool timeout and its cancel, and the helper shutdown order.
- **F4b**: the browser broker and its scope state machine, in the helper; Rust relays `interaction/browserList` and `interaction/browserExecute`, and the end-of-turn screenshot (D2).
- **F4c** (= F6): the `ZCODE_CUA_PERMISSION_BROKER_SOCKET` env pass-through to node_repl only, and the `computer-use/operation-event` relay allowlist. Unit tests only.

#### Decisions

- **F4-D1 (config source).** The helper computes node_repl's config from its own `resolveZCodePlugins` result, with Node's injection rule: `resolveBuiltInNodeReplMcpServers` (`bootstrap/src/app/built-in-node-repl.ts`) runs on that outcome, so node_repl is injected when browser-use or CUA is enabled and `node-repl-host` is present. The config is keyed `node_repl` in the helper's per-workspace `mcpServers`, next to the `plugin:<plugin>:<server>` keys. Rust never builds it.
- **F4-D2 (scope owner).** The helper runs the Node broker state machine (`openScope` sent lazily on the first execute per browser connection, `controlScopeId`, revoke only on an explicit rejection, `turnEnded`, `closeSession`, `cancelRequest`) ported from `zcode-protocol/browser-control-broker.ts`. Rust relays the resulting `interaction/browserExecute` and `interaction/browserList` requests to Main on its own connection. Rust checks only that `sessionId` names a session it owns, as the relay rule in this spec says.
- **F4-D3 (F6 builder deferred).** F4c ships the env pass-through and the relay allowlist. The helper does not build `computer-use/operation-event`: no emitter exists in Node or in the `packages/zcode-cua` stub, so the event shape is not defined yet. That builder is a follow-up that needs a product decision.
- **F4-D4 (E2E).** The browser-pane specs need Main and a macOS desktop. They run on macOS only, and the box runs what it can run. Nothing opens an Electron window on the user's Mac from an agent run.
- **F4-D5 (broker scope: full port, 2026-11-16).** F4b ports Node's browser control broker (`zcode-protocol/browser-control-broker.ts`) in full into the helper, including child-session parents (`childSessionParents`, `forChildSession`) and tab-owner routing (`parentTabOwnerChildren`). Reason: the goal is Node parity, and subagents of Rust sessions use the browser. A top-level-only subset would refuse browser calls from subagents that Node serves. Red tests use Node's broker tests as the oracle where they can be ported.
- **F4-D6 (computer-use socket, 2026-11-16).** `ZCODE_CUA_PERMISSION_BROKER_SOCKET` reaches node_repl's config only, and no other helper-hosted server. The value is the in-process capture first, then the helper's env (the CLI entry strips the variable from process.env before the helper runs). With it, node_repl gets Node's trusted markers (`ZCODE_CUA_NODE_REPL_HOST`, `ZCODE_PLUGIN_ID`, plugin authority, refresh marker), because node_repl's plugin-host child restores the socket only when they are present. Only a stdio node_repl is touched, as in Node. Known gap, not fixed in F4c: Rust's other child processes (MCP stdio, tools) still inherit the variable from the Rust process env, as they did before this change. Clearing it for them is a separate change.
- **F4-D7 (child-session registration, 2026-11-16).** Rust is the only sender of child-session facts. It sends `helper/browser/childSession` when a subagent session is opened in the helper, and `helper/browser/childSessionEnd` when it ends. The helper never reads a parent from the store, so Node's `forChildSession` bookkeeping is driven by these two messages only. Rust always uses `tabOwner: "parent"` for subagents, which is what Node's core subagent runner passes (`core/src/runtime/methods/subagent.ts`). A registration whose request times out, or whose open caller is dropped, is ended too (the helper may have accepted it). A session closed while its open is in flight ends its registration when the open succeeds. A browser relay is answered only for a session this agent opened in the helper or runs live: the store row is shared with other agents and the Node main agent, so it does not prove ownership. A failed turn reaches the helper with reason `failed`, not `completed`.

#### Owners

| Thing                                                             | Owner                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| node_repl server config (`node_repl` key)                         | Helper (`PluginOutcomes`, from `resolveBuiltInNodeReplMcpServers`)            |
| node_repl MCP connection, its lease and child process             | Helper (session lease from `helper/session/open` `servers`)                   |
| Broker socket (`ZCODE_NODE_REPL_BROWSER_BROKER_SOCKET` and token) | Helper, one broker per helper generation                                      |
| Browser scope state (`controlScopeId`, open, revoke)              | Helper                                                                        |
| Tool call, permission prompt, model turn, rows, deltas, images    | Rust (unchanged rule 2)                                                       |
| `interaction/browserList` and `interaction/browserExecute`        | Main (through Rust relay)                                                     |
| End-of-turn browser screenshot (D2)                               | Rust turn completion, one relayed `interaction/browserExecute`                |
| `ZCODE_CUA_PERMISSION_BROKER_SOCKET`                              | Host sets it; Rust passes it to the helper, which passes it to node_repl only |

#### Event order

```
UI/Host        Rust (owner)                       Helper                         node_repl / Main
  │ v4 command ─► turn starts; model asks for mcp__node_repl__js
  │              ◄── permission prompt (always ask: high risk from the tool entry)
  │ ── allow ───► pipe tools/call (timeout 600 s, cancel = notifications/cancelled)
  │                                            ─ MCP tools/call ───────────────────► node_repl
  │                                            ◄─ broker socket: list/execute ───── node_repl
  │                                            ─ openScope if not open (scope state)
  │ ◄── interaction/browserExecute (relayed) ◄─ request {sessionId}
  │ ── result (Main) ─────────────────────────► broker answer ──────────────────────► node_repl
  │              ◄─ MCP result {content, display} ◄─────────────────────────────────── node_repl
  │ ◄── tool row + node_repl_images display (Rust projection)
  │              turn ends: D2 screenshot relayed, then helper/turn/ended ─► broker turnEnded
  │              session closes: helper/session/close ─► broker closeSession, lease, MCP child
  │ Rust closes helper stdin ─► helper runs the close steps of every open session, closes the
  │                              pool and exits; Rust kills the process group after the grace period
```

Ordering guarantees (kept from F3): `helper/turn/ended` goes only after the turn's last tool call settled or was cancelled; `helper/session/close` goes only after `turn/ended`.

#### Built in F4a (what the code does now)

- Helper: `withNodeReplServer` (fork-rust-helper/node-repl.ts) adds `node_repl` to the resolved outcome. The session open's `servers` names it through the admitted catalog.
- Rust: `select.rs` serves browser-use and computer-use with a helper (they load, with their skills), and attaches one `node_repl` server (transport NodeHelper, timeout 600000 ms) to the first admitted of them. The node-repl-host plugin itself stays skipped. Known gap: when browser-use and computer-use are both disabled, node_repl is not attached, as in Node; when the host plugin is missing, Node's helper returns no config and the open logs an unknown server, so the tool errors on its call.
- Cancel: the existing F3 pipe path (`notifications/cancelled`) carries a node_repl cancel. No separate test yet.
- Shutdown: when Rust drops the helper generation, it first releases the helper's stdin (the protocol writer task is aborted, so the write half closes; the reader's peer clone would otherwise hold it open until the helper exits). The helper then sees EOF and closes its sessions (`mcpHost.dispose`: pipes, then session leases) and `pool.close()`. Rust waits 3 s (`HELPER_STOP_GRACE`) for the process to exit, then `Shutdown::Immediate` if it did, or `Shutdown::Graceful` (TERM, then KILL) if not. The stdin release is unit-tested in protocol-zcode (`retiring_a_helper_closes_its_stdin_so_it_can_exit_on_eof`); the grace-then-TERM choice is only checked by the stop-mode tests in the cli crate, and the whole path is checked in the box only by reading the code.

#### F4b browser broker (design, 2026-11-16)

Owners: helper (broker socket, scope state machine, child registrations); Rust (relays the broker's Host requests after an owned-session check, and sends child-session facts); Main (the browser).

Port: the helper reuses Node's `createProtocolBrowserControlBroker` (`zcode-protocol/browser-control-broker.ts`) unchanged, with its `requestClient` routed through the helper's request link to Rust, which relays to Main. The Node broker tests (`bootstrap/tests/browser-control-broker.test.ts`) are the oracle for the port.

Messages (Rust ↔ helper), strict zod on the helper side:

| Message                                                 | Kind                  | Params                                                  | Answer / refusal                                                                   |
| ------------------------------------------------------- | --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `helper/browser/childSession`                           | request               | `{childSessionId, parentSessionId, tabOwner: "parent"}` | `{}`; `-32602` when the child is already registered to another parent or tab owner |
| `helper/browser/childSessionEnd`                        | notification          | `{childSessionId}`                                      | none; unknown id logged and ignored                                                |
| `helper/turn/ended`                                     | notification          | `{sessionId, turnId, reason}`                           | none; drives the broker `turnEnded`                                                |
| `interaction/browserList`, `interaction/browserExecute` | helper → Rust request | Node's broker params                                    | the Host's answer; Rust refuses an unowned `sessionId`                             |

Idempotency:

- A duplicate `childSession` with the same id, parent and tab owner is a no-op answer `{}`.
- A `childSession` with the same id and another parent or tab owner is refused.
- A `childSessionEnd` for an unknown id is logged and ignored.
- A parent that closes before its child keeps the child's registration. The child's later `childSessionEnd` still releases it. Until then the child's browser calls fail, because its parent record is gone.

Order: Rust sends `childSessionEnd` before it closes the child session. For each session, the helper runs the broker `closeSession` (scope release) before its MCP lease closes.

Built in F4b: `fork-rust-helper/browser-control.ts` (Node's broker reused unchanged, child registrations under strict zod); `server.ts` dispatches the child messages and `helper/turn/ended`; `mcp-host.ts` injects node_repl's broker socket and token at open, and releases the session's scope before its lease closes; Rust relays `interaction/browserList` and `interaction/browserExecute` for owned sessions (`browser_request`), strips `requestKey`, and sends `childSession` (a request, before the open; a refused one fails the open) and `childSessionEnd` (a notification, in the same task before the close, and after a failed open). Red tests are the seven cases of `f4b-browser-control.test.ts`, a subset of Node's `browser-control-broker.test.ts` (not all 30+ cases yet). D2, the end-of-turn screenshot, is built in its own PR (below).

Acceptance: the Node broker test cases port as red tests; box E2E `conversation-session-node-repl-stateless-browser-multisession` passes on Rust.

#### D2 end-of-turn screenshot (design, 2026-11-16, approved A + A1 + C2)

Port of Node's `appendBrowserTurnScreenshot` (`core/src/runtime/methods/browser-turn-screenshot.ts`), decision D2 above. Node reference facts, checked in the code:

- Order: the screenshot runs in Node's turn loop after the model loop completed and before `TurnComplete` (`turn.ts` ~1019). `browserControlPort.turnEnded` runs later, in the turn's `finally` (`turn.ts` ~1262). So the screenshot settles before `turnEnded`.
- Candidate: the only production writer is the `zcode/browserTurnScreenshot` key of a node_repl tool result's `_meta` (`browser-bridge.ts`, `recordBrowserTurnToolResult`). `recordBrowserTurnPageActivity` has no production caller (tests only), so it is not ported.
- Timeout and abort: Node's capture passes `turnAbortSignal` to `port.execute`, and the broker sends `cancelRequest` to Main when it aborts (`browser-control-broker.ts` ~220-260). Rust matches this: the capture's cancel token is the turn's abort token (`Running::abort`), and a cancel drops the helper request. Node has no timeout. Rust adds one safety net: the helper request is bounded by the helper's default request timeout (`Timing::default_request`, 180 s), so a stuck Main cannot hold the turn end. Known differences: (a) Rust's cancel drops the helper request but does not send `cancelRequest` to Main; (b) the Rust actor is single-threaded, so an interrupt that arrives during the capture waits for the capture (or the 180 s bound) instead of cancelling it. Both are closed by "D2 follow-up: cancel and interrupt" below.
- Part: a tool part with `state.input.source = "browser_turn_end"` and `metadata.display` of kind `node_repl_images`, image at most 200 KiB base64 and at most 2048 px (`HOST_NODE_REPL_IMAGE_MAX_DIMENSION`). The part is excluded from model blocks (`isBrowserTurnScreenshotPart`).

Decisions:

- **D2-A (hook point).** The screenshot settles inside the session crate's `finish_turn` (`session/src/turn.rs`, the new module `session/src/browser_turn.rs`): after the model loop's result is known and before the `KernelEvent::TurnFinished` append. Only an outcome of `Success` (Node: the loop completed) with a prompt is captured. Rejected: the protocol sink `Live::event` (`protocol-zcode/src/live.rs`). It runs after `TurnFinished` is logged, so it cannot persist anything, and `helper/turn/ended` (sent there) would come before the capture. Order: capture, persist, log the row event, log `TurnFinished`, and then `helper/turn/ended` from `Live::event`, as Node. A capture failure, a write failure or a missing port logs and skips the row; the turn's outcome never changes.
- **D2-A1 (persisted shape).** One fork entry per captured screenshot, `Fact::Entry { kind: "fork_browser_turn_screenshot", id: <tool use id>, data: { anchor: <the turn's prompt message id>, toolUseId, display } }`. The store writes it as `session_entry` type `rust-cli/fork_browser_turn_screenshot` (`node-store/src/facts.rs`). Compatibility: Node reads `session_entry` by type and never selects an unknown type, so Node ignores it; an older fork build reads only the kinds it knows, so it ignores this one too. The entry is not a `Message`, so it never enters model history. The cold projection reads it with `store.entries(session, kind)` at actor open, as `peer_restore` does. Rejected: a model-invisible `Message`, because every model request would have to filter it, and Node's `isBrowserTurnScreenshotPart` filter is not a Rust precedent. The shared `tasks-index.sqlite` has no `session_entry`, so it is not affected.
- **D2-C2 (candidate channel, single owner).** Written only by `ext/src/mcp/tool.rs`, when a helper-hosted `tools/call` answer carries `_meta["zcode/browserTurnScreenshot"]` with a string `browserId` and an integer `browserGeneration` (Node's guard in `recordBrowserTurnToolResult`). The registry is in `kernel-api` (`browser_turn.rs`), a process-level map like Node's module-level `Map`. It is keyed by (session, run): the tool context carries the run id, not the turn id, and a main-loop turn's run is the `Running::run` that `finish_turn` reads. It is consumed exactly once, by `finish_turn`, right after the model task settles and before the outcome is decided, whatever the outcome. A session's Live drop removes its candidates (`forget_session`). A later call in the same turn replaces the candidate, as Node does.
- **D2-H (helper side).** The helper forwards `_meta` already (`f3-protocol.ts` `toWireResult`); the Rust tools/call path dropped it until D2. New helper request `helper/browser/turnScreenshot`, params `{sessionId, turnId, browserId, browserGeneration}` (strict zod). The helper runs Node's `list` then `screenshot` on the session's broker port (its child registration's port, else the top-level port), and answers `{image?: {base64, mimeType}}`. Broker failures and refused captures are logged and answered with `{}`, as Node swallows them. Rust sends it with `NodeHelper::turn_screenshot` (only for a session this generation holds open), and the scope state stays in the helper (F4-D2).
- **D2-P (display).** The protocol server's port (`protocol-zcode/src/fork/browser_turn_screenshot.rs`) re-encodes the image with `rust-cli-image` (`prepare`, budget 200 KiB base64, 2048 px) only when it is over the limit, like Node's `imageProcessorPort.prepareForModel`; an image that still does not fit is dropped. The row carries the display on the row display channel (`row.display`), live and cold, as Node's `toProtocolToolCallDisplay` allows. The output display path that drops `node_repl_images` (`projection/mod.rs`) is unchanged for other tools.
- **D2-Bind (port owner).** `Live::new` binds the session's port (`kernel_api::browser_turn::bind`) and `Live::drop` unbinds it and forgets its candidates. The session crate reads the port through the kernel-api registry; no `SessionDeps` change. Known race: a Live dropped after a newer Live bound the same session would unbind it; the reopen path has not been seen to do that.

Owners:

| Thing                                                         | Owner                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Candidate `{browserId, browserGeneration}` per (session, run) | `kernel-api` registry; writer `ext` MCP tool result; consumer `finish_turn` |
| Capture (list, screenshot) and scope state                    | Helper (`helper/browser/turnScreenshot` on the broker port)                 |
| Downscale and the entry, persisted once per capture           | Rust session (`finish_turn`)                                                |
| Row (live `KernelEvent`, cold entry read)                     | Rust projection (`protocol-zcode`)                                          |
| `helper/turn/ended`                                           | Rust `Live::event`, after `TurnFinished` (unchanged)                        |

Event order:

```
Model loop   finish_turn (session)          Helper                 Main         Projection / Host
  │ tool result _meta candidate ─► registry[(session,turn)]
  │ loop Completed ─► take candidate (always, once)
  │               ── helper/browser/turnScreenshot ─► list, screenshot ─ interaction/browserExecute ─► (scope in helper)
  │               ◄── {image} or {} (failure: no row, turn unchanged)
  │               downscale if over limit
  │               commit Fact::Entry fork_browser_turn_screenshot (one batch; failure: logged, no row)
  │               log KernelEvent::BrowserTurnScreenshot ────────────────────────────────────► live row (row.display)
  │               log KernelEvent::TurnFinished ─► Live::event ─► helper/turn/ended ─► broker turnEnded
```

Acceptance (red first):

1. The candidate is recorded only from a helper-hosted `tools/call` answer whose `_meta` has the key; the registry consumes it exactly once; an error, an abort, a superseded turn, or a session close leaves no candidate (Node's `browser-turn-screenshot.test.ts` cases: record from the MCP child marker, skip without a candidate, consume clears it).
2. A turn with a candidate and a Success outcome appends one `fork_browser_turn_screenshot` entry and one `BrowserTurnScreenshot` event before `TurnFinished`, in that order.
3. A failed or absent capture appends nothing, logs, and the turn outcome is unchanged. An aborted turn runs no capture and consumes its candidate.
4. The entry is not in the next model request's messages (explicit test).
5. The live row and the cold reopen both show the row with `display.kind == "node_repl_images"` on the row display channel, placed after the turn's assistant output.
6. Helper: `helper/browser/turnScreenshot` lists, then screenshots the active tab, and answers `{}` on any broker failure.

Tests as built:

- Binding race (kernel-api `browser_turn_tests.rs`): `dropping_an_older_binding_keeps_the_newer_one`. Binds are generation tokens; `unbind` removes only its own generation.
- Full-turn (session `browser_turn_tests.rs`, own session id per test): success (one capture, one entry, row before `TurnFinished`, one candidate consumed); the next model request carries no trace of the screenshot; abort (interrupt) consumes the candidate, no capture, no entry; failed turn (`InvalidRequest`), same; superseded (interrupt, then a newer input), the first turn captures nothing and the second captures with its own candidate, two candidates consumed.
- Projection (`browser_screenshot_tests.rs`): live row keeps the display; cold row placed after its turn's output; a cut turn's row is dropped.
- Node-store (`lib_mode_tests.rs`): the entry is a `rust-cli/` session_entry and writes no message.
- Helper (`f4-d2-turn-screenshot.test.ts`): list then screenshot; no active tab; refused screenshot; Host failure; child routed by tab owner.

E2E: the spec `conversation-session-node-repl-stateless-browser-multisession` checks, after its last session check, that a `node-repl-browser-turn-screenshot` row exists. Node's debug run (temporary logging, removed) shows the path up to the capture: the candidate is recorded (`_meta["zcode/browserTurnScreenshot"]` on both js results), `list` returns the active tab, and `screenshot` returns `backend_unavailable`. The cause is the platform gate: `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinatorWiring.ts:37-38` enables the transparent-window bootstrap only on darwin and win32, and `browserGuestManager.ts:2012-2013` maps the surface failure to `backend_unavailable`. So the row is darwin-only. The assertion is gated with `if (process.platform !== "darwin") this.skip();` as `acp-agent-delegation` does. Box results: Node `1 skipped (11.6s)`, Rust `1 skipped (23.7s)`, shard exit 0 in both. Because `this.skip()` marks the whole `it` skipped, the Linux run reports skipped, not passed. The row is not verified on Linux; it needs a macOS run.

#### D2 follow-up: cancel and interrupt (2026-11-16)

Closes the two open points above (a) and (b). Node facts, checked in code: `appendBrowserTurnScreenshot` passes `state.turnAbortSignal` to both `port.execute` calls (`core/src/runtime/methods/browser-turn-screenshot.ts`), and the broker's `execute` sends `cancelRequest` to Main when the signal aborts (`zcode-protocol/browser-control-broker.ts`, `cancelBackendRequest`). An interrupt aborts the turn signal, so the capture is cancelled and the turn still ends with its own outcome (the model loop had completed, so `Success`). Node has no interrupt wait.

- **Cancel (C1).** Rust sends the notification `helper/browser/turnScreenshotCancel {sessionId, turnId}` when the capture's cancel token fires, and drops the request. The helper keeps one abort controller per (session, turn) for the in-flight capture; the notification aborts it, and the abort reaches both broker calls, so the broker sends `cancelRequest` to Main. A capture that already answered has no controller left; the notification is then a no-op. Strict zod on the params.
- **Interrupt (C2).** The session actor is single-threaded, so `finish_turn` no longer blocks request handling while the capture runs. The capture is awaited in a select with the actor's request channel. An `Interrupt` or `Shutdown` arriving meanwhile is handled at once: it cancels the capture token and answers `Accepted`. A `Close` (the session close path, `Request::Close`) and the close's `EndMeta` read are served at once too; the close cancels the capture as an abort of the turn would, so the close does not wait for the capture. Every other request is kept in arrival order and handled after `finish_turn` returns, so no request overtakes another. The turn still finishes with its outcome; no row is stored.
- **Shutdown is final.** After a `Shutdown` no turn starts. A request that would start one (`Submit`, `SubmitWith`, `SubmitContent`, `Compact`, `Bash`, `Rewind`, `RewindTurnFiles`, `ResumeGoal`, the `child_live::starts_turn` set) is refused with `rejected("the session is shutting down")`, whether it arrives before or after the capture; `start_next` already refuses to start queued work. A submit deferred behind the capture is therefore refused, not started.
- **Race (C1 vs answer).** `settle_capture` races the answer against the cancel with the answer first (biased): a ready answer is kept even when the cancel is ready in the same tick. Any other end while the turn is cancelled (an error, the timeout, or the cancel itself) still sends `helper/browser/turnScreenshotCancel`, because a timed-out capture may still be in flight in the helper. A cancel is sent only when the turn was cancelled.
- **Logs.** A capture rejected with an `AbortError` (the broker's rejection for an aborted call) because its turn was cancelled logs at debug with `fork_rust_helper.browser.turn_screenshot_cancelled`. Any other rejection, including one that lands after the abort, stays a warning `turn_screenshot_failed`.

Owners: the capture token is the turn's abort token (unchanged); the helper's controller map is the single owner of the in-flight capture in the helper.

Module split (same follow-up, no behaviour change): `protocol-zcode/src/fork/node_helper.rs` (was 961 lines, limit 800) keeps the handle, state, forwarding and the UI helpers; `node_helper_launch.rs` holds the process type, the launcher trait and the start; `node_helper_link.rs` holds the writer release, the traffic count and the relay; `node_helper_stop.rs` holds the reclaim, crash, timeout and link-loss paths. Children use `use super::*;`, and only the methods and fields that cross a module boundary are `pub(super)`. The re-export `node_helper::{NodeHelperLauncher, NodeHelperProcess}` is unchanged.

Red tests (written before the change): `helper`: `a_cancelled_turn_screenshot_is_cancelled_in_the_helper` (protocol-zcode `node_helper_sessions_tests.rs`); helper TS `f4-d2-turn-screenshot.test.ts` "cancelling the capture aborts its broker calls, so Main gets cancelRequest"; session `browser_turn_tests.rs` `an_interrupt_during_the_capture_returns_promptly_and_cancels_the_capture`.

#### Shutdown order (F4a)

1. Rust closes the helper's stdin.
2. The helper runs the close steps of each open session (broker scope closeSession, panels, lease), then `pool.close()`, which ends the node_repl child.
3. The helper exits. If it has not exited after the Rust guard's existing grace period, Rust kills the process group.

#### Tool timeout and cancel (F4a)

- node_repl's server timeout is 600 000 ms (Node's `timeoutMs`), carried on the Rust `McpServer` options. Rust's MCP client times the call and cancels with `notifications/cancelled`, which the helper maps to MCP cancel on the node_repl connection.
- The pipe timeout rule keeps the helper alive while a long call is in progress (F3, "Timeout rule").

#### Permission (F4a)

- node_repl tools are always-ask, because their risk is high. The risk is Node's classification (`core/src/mcp/index.ts:135-147`). How the helper's `tools/list` carries it to Rust is decided in the F4a red test, not here. Rust then asks the session prompt before each call, as it does for any ask.

#### Acceptance

1. With browser-use or CUA enabled, the model sees `mcp__node_repl__js`. With neither enabled, it does not. With no helper, node-repl plugins are skipped as today.
2. A `js` call asks for approval. Deny returns a tool error to the model. Allow runs it, and the text and image result render (`node_repl_images` display kept).
3. Stop during a call cancels it on the node_repl connection.
4. A browser-use task opens a page in the desktop browser through `interaction/browserExecute`. Turn end releases the scope with `turnEnded`. Session close releases it with `closeSession`.
5. Helper crash mid-call: the tool row shows an error, and the next call respawns the helper.
6. Helper stdin close: sessions close before the helper exits, and the node_repl child is gone.
7. Node mode: nothing changes, and no helper is spawned.

#### Tests

- Helper (TypeScript, Vitest, `scripts/fork-test-files.json`): `PluginOutcomes` adds `node_repl` only when browser-use or CUA is enabled and host is present; the helper's broker scope state machine: open once per connection, revoke on explicit rejection only, closeSession and turnEnded release.
- Rust (`ext`): `select` serves node-repl plugins with `node_helper` set and skips them without it; the server carries `timeout_ms = 600000` and transport `NodeHelper`.
- Rust (`protocol-zcode`): the relay allowlist forwards `interaction/browserList` and `interaction/browserExecute` only for owned sessions; the D2 screenshot is relayed once per turn.
- Desktop E2E in the box: the node-repl spec, if it runs on Linux; the browser-use specs run on macOS only and are not run by the agent.

### Why the helper, not Rust, is the MCP client for Node-hosted servers

Rust already speaks stdio MCP, so it could spawn node_repl and the Office servers itself. Doing so would hit five Rust blockers:

- the `request-context` `_meta`;
- MCP `2026-07-28` with `legacy: "reject"`;
- `isolation: "workspace"`;
- the CUA socket env restriction;
- a broker socket for browser.

On top of those, Rust would have to port the `mcp/ui*` lease protocol. With the helper as the MCP client, Node's own adapter and `mcp-ui` code run unchanged, and the panel and the model share one server instance. Rust keeps what it must own: the turn, permissions, the model and the stream. Rust's MCP client stays in use for ordinary plugin MCP servers.

### MCP Apps on Rust-hosted servers (F7, after F5)

A panel of an MCP server Rust runs itself (a user's `mcp.json` server, a plugin server without the plugin host) is refused today with `proto.forkRustAgent.mcpUiServerNotHelperHosted`. Full parity needs it. Node's rule: "the ownership truth is the session's MCP server table (plugin servers and ordinary MCP servers in one table); any configured server can render an MCP App" (`zcode-protocol/mcp-ui/sessionAccess.ts`).

What Node does, read from the code:

- **One connection per server per session.** The panel's calls (`callMcpToolForUi`, `readMcpResourceForUi`, `subscribeMcpResourceForUi`, the resource lists) go through the session's own `mcpPort`, on the same `record.client` the model's tool calls use (`adapters/src/mcp/index.ts` `callTool` with `appConnection`).
- **The lease is tied to that connection.** `McpUiInstances` (`instances.ts`) is the only owner of the panel tokens. It binds each lease to `appConnectionSnapshot(server)`: a hash of the platform, the exec path, the workspace, the server name and its canonical config, plus the connection generation. Each guarded panel call validates the lease before and after the call. A reconnect bumps the generation, fires `onAppConnectionInvalidated`, and the panel's later calls fail with "MCP App connection changed".
- **Sampling and app tools are per lease, not per connection.**
  - `McpUiSamplingCalls` (`samplingCalls.ts`) owns the operation ledger and the caps: 4 per session, 8 per agent, 4096 operations per lease. It calls the runtime's `sampleModel`.
  - The app-tool mailbox (`appToolsProtocol.ts`) owns claim and resolve.
- **Resource updates come back on that connection.** `notifications/resources/updated` for a subscribed URI becomes `pluginUi.resourceUpdated`.

Option 1: Rust ports the lease, the mailbox and the sampling ledger for its own MCP connections.

```
owners: Rust MCP client (connection, generation) · Rust McpUi registry (leases, sampling ledger, mailbox) · kernel (sample_model, app tools, permission)
panel ─mcp/uiOpenInstance─► Rust registry: lease bound to (identity, generation) of Rust's connection
panel ─mcp/uiCallTool─────► validate lease ─► authorize (kernel pipeline) ─► Rust client tools/call ─► validate lease ─► result
model ─tools/call─────────► same Rust client, same server process
server ─resources/updated─► Rust client ─► registry ─► pluginUi.resourceUpdated on the session stream
Rust reconnect ───────────► generation+1 ─► registry revokes the server's leases (cancel first, then close)
```

Option 2: the helper becomes the MCP client of UI-declaring plugin servers.

```
owners: helper (connection, leases, ledger, mailbox) · Rust (model tool calls via helper/mcp/* pipes, kernel)
Rust ─connect─► server: is it UI-declaring? Only known after connecting (ui:// resources, tool `_meta.ui`)
    ├─ (2a) hand the whole server to the helper: Rust closes its client, the helper reconnects, model calls go through the pipes
    └─ (2b) keep Rust's client for the model and add the helper's: two clients, two stdio processes
```

Verdict: Option 1, as the lean was. The Node code refutes Option 2 on four points:

- **(2b) splits state.** A stateful server holds different state in each process; `appConnections.test.ts` checks that a panel call goes to the connection whose identity and generation the lease holds. Subscriptions would arrive on the helper's connection while the model's calls go to Rust's. OAuth tokens and trust prompts would happen twice.
- **(2a) needs a connect before it can classify the server, then a second connect.** It moves the trust, OAuth, config and `timeoutMs` handling of the user's own servers from Rust's client into Node's. That duplicates the client Rust already owns, and the helper has no view of Rust's reconnects.
- **The lease generation must follow the connection that serves the model.** Only the owner of that connection can bump it at the right moment (Node does it inside `nextConnectionGeneration`).
- **Most of the F3 helper code is reusable as the reference, not as a runtime.** The protocol logic is small (`instances.ts` 151 lines, `samplingCalls.ts` 99, `appToolsProtocol.ts` 166), and `sample_model` and the app tools (F3b) are already kernel features in Rust.

Plugin-host servers stay helper-hosted (the reasons above). Each server then has exactly one client: the helper for `__zcode-plugin-host` servers, Rust for every other server. The `mcp/ui*` router picks the owner by server, so one panel protocol has two implementations of the lease. A shared conformance test (the same request sequence against both owners) keeps them equal.

### Decisions (approved 2026-11-13)

- **D1. Workflow execution (F5) is not a thin delegation.** Revised 2026-11-17: Rust ports the engine and runs the actors as its own child sessions; see `specs/fork-rust-workflow-engine.md`. The text below is the 2026-11-13 record. F5 status (W3, branch `feat/rust-workflow-reducer`): the reducer, delta and cold replay are ported in `node-store` and checked against Node's goldens; the gate stays off, so nothing user-visible changes (`specs/fork-rust-workflow-engine.md` section 9.4). F5 status (W5b part 1, branch `feat/rust-workflow-engine-resume`): engine resume with world rows, the amend import cache and its builder, and `import-cache-closed` are ported in the `workflow` crate and checked against Node's goldens; the gate stays off (`specs/fork-rust-workflow-engine.md` section 9.5). F5 status (W6b part 3, branch `feat/rust-workflow-model-failure-w6b-3`): the model failure policy is ported once, as the kernel-api table that the governor and the workflow driver both read, so the stop set is one table (`specs/fork-rust-workflow-engine.md` section 9.13); the gate stays off.
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
  - **Decided: (A)** on 2026-11-13: F5 is the last family, after F1–F4. **Revised 2026-11-17:** the workflow runs themselves are no longer delegated to the Node helper. Rust ports the engine and runs the actors as its own child sessions (`specs/fork-rust-workflow-engine.md`). Until F5 lands, F5 stays refused, while saved workflows and run history ship with F1+F2.
- **D2. End-of-turn browser screenshot.** In Node this is turn-loop logic (`core/src/runtime/methods/browser-turn-screenshot.ts`). The proposal is to port it into Rust's turn end as one relayed `interaction/browserExecute`, rather than having the helper drive a turn it does not own. **Decided: port it into Rust's turn completion.**
- **D3. Computer use (F6)** can only be unit-tested. `packages/zcode-cua` is a fail-closed stub, so neither runtime can run CUA E2E in the box. F6 ships with F4 (env pass-through plus notification relay), covered by unit tests only. **Decided:** each F6 PR states that E2E is impossible on both runtimes, because the stub always refuses.

#### F7 PR plan (2026-11-18)

Base `fork`. Four PRs, in this order. Each PR keeps the refusal of every method it does not yet own (`mcpUiServerNotHelperHosted` for a Rust-run server), so no PR changes behaviour for a server until its methods are ported.

- **PR 1 (`feat/rust-mcp-apps-f7-1`): lease, generation, routing, conformance.** Owner: Rust.
  - Parts:
    - `ext/src/mcp/app_connection.rs` (new): per-server connection identity (sha256 over platform, exec path, workspace root, server name, configuration) and `app_generation`, bumped whenever a server's published client changes (connect, reconnect, stop). Invalidation callbacks fire after the lock is released. `app_request` sends one request on the server's current client and checks the generation before and after.
    - `kernel-api/src/mcp_app.rs` (new): the session-scoped `McpAppHost` port (owner of a server, snapshot, invalidation subscription, guarded request, tool visibility, wait for connection). Implemented by `Ext`'s registry, set on the Context by the entry point.
    - `protocol-zcode/src/fork/mcp_ui_lease.rs` (new): the lease registry (Node `instances.ts`): open, validate (scope, runtime, generation, identity; a source mismatch closes the lease), close, `retain` pins, `close_session`. A generation bump revokes the server's leases: cancel in-flight calls first, then close, then `pluginUi.instanceClosed`.
    - `protocol-zcode/src/fork/mcp_ui_rust.rs` (new): the Rust owner of `mcp/uiOpenInstance`, `mcp/uiValidateInstance`, `mcp/uiCloseInstance`, `mcp/uiCallTool`, `mcp/uiCancelCall`, `mcp/uiReadResource`, `mcp/uiListResources`, `mcp/uiListResourceTemplates` and `mcp/readResource` (ui:// reads). Visibility, duplicate `callId`, 8 MiB and mime rules as Node `handlers.ts`.
    - Routing in `fork/methods.rs`: for these methods, a server whose transport is `NodeHelper` goes to the helper as today; a server of the session's table that is not helper-hosted goes to `mcp_ui_rust`; a server not in the table keeps the current refusal. The sampling, subscription and app-tool methods stay refused for Rust-run servers until PR 2–4.
    - Conformance: one fixture of request sequences (open, call, cancel, validate, close, reconnect, stale lease, duplicate callId, visibility refusal, mime refusal, oversized read) with the expected outcome of each step. The Rust test runs it against `mcp_ui_lease`; the Node counterpart runs it against `McpUiInstances` in `instances.test.ts`. Both must match.
  - Owners and tests: Rust owner of the lease, generation and routing. Rust unit tests in `mcp_ui_lease_tests.rs`, `mcp_ui_rust_tests.rs`, `app_connection_tests.rs` (ext), and the conformance test. Red run recorded before the implementation.
  - Acceptance: a panel of a user's `mcp.json` server opens, calls an app-visible tool and reads a `ui://` resource. After a reconnect the panel's next call fails with "MCP App connection changed" and the panel gets `pluginUi.instanceClosed`. A plugin-host server still goes to the helper. Sampling and subscription calls on the Rust-run server stay refused with `mcpUiServerNotHelperHosted`.
- **PR 2: sampling ledger.** Owner: Rust (`mcp/uiSampling`, `mcp/uiCancelSampling`). Port `samplingCalls.ts`: caps of 4 operations per session, 8 per agent, 4096 per lease; timeout 65 s; duplicate `operationId` is refused; a cancel that arrives before the sample is kept as a terminal state. The model call goes through the kernel `sample_model` (F3b). Tests: the ledger unit tests ported from `samplingCalls.test.ts`, plus the conformance fixture extended with sampling steps.
- **PR 3: app-tool mailbox.** Owner: Rust (`mcp/uiRegisterAppTools`, `mcp/uiUnregisterAppTools`, `mcp/uiClaimAppToolCall`, `mcp/uiResolveAppToolCall`, `helper/appTools/call` for Rust-run servers). Port `appToolsProtocol.ts` and `appTools.ts` onto the kernel `AppToolHost` (F3b). Tests: claim and resolve per lease, mailbox cleared on close, plus the conformance fixture.
- **PR 4: resource subscriptions and `pluginUi.resourceUpdated`.** Owner: Rust (`mcp/uiSubscribeResource`, `mcp/uiUnsubscribeResource`; `notifications/resources/updated` and `resources/list_changed` from the Rust client become `pluginUi.resourceUpdated` and `pluginUi.resourceListChanged`). Subscriber key = session, scope and generation. A lease close or generation bump drops its subscriptions. Tests: subscribe, update relay, unsubscribe on close, reconnect drops the subscription.

#### As built (F7 PR 1)

- **Built.** The lease registry (`protocol-zcode/src/fork/mcp_ui_lease.rs`, Node `instances.ts`), the connection identity and generation of each server (`ext/src/mcp/manager/app_connection.rs`), the session-scoped port `McpAppHost` (`kernel-api/src/mcp_app.rs`, implemented by `Ext`'s registry, set on the Context in `cli/src/frontends/app_server.rs`), and the Rust owner of the nine PR 1 methods (`protocol-zcode/src/fork/mcp_ui_rust.rs`). `fork/methods.rs` routes a Rust-run server of the session's table to the owner. A helper-hosted or unknown server keeps its path, and sampling, subscriptions and app tools still answer `mcpUiServerNotHelperHosted` for Rust-run servers.
- **Revocation.** A change of a server's published client bumps its `app_generation` and runs its connection listeners after the lock. The owner revokes the server's leases in that session (in-flight calls cancelled first, then the lease removed, then `pluginUi.instanceClosed` on the session stream). Closing a session or a lease does the same.
- **Tests (red then green).** The red run came first: the 12 registry tests, written against stubs that panic with `not implemented`, all failed. After the implementation: `cargo test -p rust-cli-protocol-zcode -p rust-cli-ext -p rust-cli-runtime --locked` passed (839 + 298 + 155 + the rest). The conformance fixture `protocol-zcode/tests/fixtures/mcp_ui_lease_conformance.json` runs against the Rust registry in `mcp_ui_lease_conformance_tests.rs`. `mcp_ui_rust_tests.rs` covers the pure rules of the owner: mime allowlist, base64 size, the 8 MiB bound, tool visibility refusals, the workspace key and the call-id scope. `cargo fmt --check`, and `cargo clippy --workspace --all-targets --locked -- -D warnings` passed. Added after the first review: the Node conformance run (`apps/zcode-cli/packages/bootstrap/tests/fork-rust-helper/mcp-ui-lease-conformance.test.ts`, vitest, same fixture); the route test (`mcp_ui_route_tests.rs`: open, call, reconnect, revoke notice, refusals, through `Server::dispatch`); the ext tests of `app_request`, the listener subscription and the generation bump on reconnect (`manager/app_connection_tests.rs`); the identity canonicalisation test.
- **Divergences from Node.**
  - The identity hashes the OS, the workspace path, the server name, the transport in canonical JSON (keys sorted at every depth, so map insertion order cannot change it), and the Debug form of the scope, options, machine and OAuth fields (none of them holds a hash-based map). The executable path is not hashed (clippy forbids `current_exe` here); it is fixed for the process.
  - `wait_connection` waits for every connection of the session's group, not only the named server (`wait_ready`).
  - `onActivity` (the in-flight activity events of a panel's calls) is not ported. It goes with the app-tool mailbox (PR 3).
  - `mcp/uiCancelCall` and `mcp/uiCloseInstance` do not change Node's semantics; `mcp/uiCloseInstance` validates against the lease's own connection, as Node does.
- **Not done in PR 1.**
  - The desktop E2E (`plugins/extensions/plugin-extension-entries`) runs in the box, not on this Mac.

#### As built (F7 PR 2)

- **Built.** The sampling ledger (`protocol-zcode/src/fork/mcp_ui_sampling.rs`, Node `samplingCalls.ts`): `admit` (the synchronous admission: scope live, operation id new, lease capacity, session and agent caps), `cancel` (records a terminal state; cancels the operation when it is in flight), `forget` (drops a lease's ledger), and `Admission::run` (cancel, 60 s deadline and the model call; the first decides, and a late result is dropped). Also `check_request`, the limits of `mcpAppsSamplingParamsSchema`. The owner (`fork/mcp_ui_rust.rs`) answers `mcp/uiSampling` and `mcp/uiCancelSampling` for Rust-run servers: the request is checked, the lease validated, the operation admitted, the pin retained, the session opened (`Server::live`) and the call run through the kernel `sample_model` (F3b). The lease is validated again after the call. `finish_closed` drops the ledger of every lease that ends.
- **Revocation.** The operation's cancel is a child of its lease's cancel, so a close, a revoke (connection generation bump) or a session close cancels the lease's in-flight operations through the token tree, before the lease's close notice. The sweep in `admit` and `cancel` also drops ledgers whose lease has ended.
- **Tests (red then green).** Red runs came first:
  - the ledger tests (`mcp_ui_sampling_tests.rs`, six ported from `samplingCalls.test.ts` plus eight request-limit tests) against stubs: 14 failed (`not implemented`);
  - the route tests `a_panel_samples_on_the_session_model_and_an_operation_id_is_single_use` and `a_reconnect_cancels_the_panels_sampling_in_flight` (`mcp/uiSampling` was not routed: `Method not found`, and the held call never started, so the bounded wait timed out);
  - the Rust conformance run (`unknown op sample`), and the Node conformance run (`unknown op sample`).
  - Green after the implementation: the 14 ledger and limit tests, the 4 route tests (the refusal test now names `mcp/uiRegisterAppTools` and `mcp/uiSubscribeResource`, which stay refused), the Rust conformance run, the Node conformance run against `McpUiSamplingCalls`, and Node's `samplingCalls.test.ts` (six tests, run with an explicit config because the bootstrap vitest include does not cover `src`).
  - The fixture gained the sampling steps after the lease steps: admission outcomes (started, duplicate, busy per lease, session cap of 4, agent cap of 8), cancel before admission, a terminal id, a finished run (`done`), `collect` for each sampling's final outcome, and a reconnect that cancels every in-flight operation (`cancelled`) and revokes the leases. The revoked aliases are sorted in both runners, so the output does not depend on the token order.
- **Review round (ocr on bab0622e6, five LOW findings).** Fixed: the cancelled-call wait is bounded (5 s, route test); the `closeSession` aliases are sorted in the Rust runner; `operationId` counts UTF-16 units (zod `.max(128)`, `utf16_len`); `maxTokens` must be a safe integer (`max_tokens`, also in `helper_sampling::parse`); the kernel reply is checked as `mcpAppsSamplingResultSchema` checks it. Each behaviour change had a red test first.
- **Divergences from Node.**
  - **Deadline 60 s, not 65 s.** Node's ledger deadline is `MCP_APPS_SAMPLING_TIMEOUT_MS` (60 s); 65 s is `MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS`, the helper's forwarding timeout, which a Rust-run server does not have. The ledger keeps 60 s, as Node's unit test asserts.
  - The limits are checked in Rust with Rust's messages (zod's issue texts are not reproduced). Text length is counted in UTF-16 units as zod does. The budget's metadata is serialised with serde_json: its bytes can differ from `JSON.stringify` by escape sequences near the 8 MiB boundary.
  - `annotations`, `modelPreferences` and `_meta` values are not validated beyond their keys (zod checks their types). The top-level `mcp/uiSampling` params are not checked for unknown keys (zod is `.strict()`).
  - The kernel's reply is checked as `mcpAppsSamplingResultSchema` checks it: a non-empty model and stop reason, and text of at most 8 MiB in UTF-16 units. A reply that fails answers the internal error `Sampling result is invalid`, as Node's parse failure does.
  - The operation id is the pin's call id (Node's `retain(token, operationId)`), so an idle close waits for it as Node does.
- **Not done in PR 2.** App tools (`mcp/uiRegisterAppTools`, `mcp/uiUnregisterAppTools`, `mcp/uiClaimAppToolCall`, `mcp/uiResolveAppToolCall`) and resource subscriptions stay refused with the Rust-run refusal (PR 3 and PR 4).
- **Observed, not changed (PR 1 code).** `RustMcpUi::validate` closes a lease on a source mismatch through `Instances::validate`, which cancels and removes it without `finish_closed`. So that path sends no `pluginUi.instanceClosed` and keeps the panel's connection subscription until the next close. Check this against Node's `validate` (which also closes without a notice) before PR 3.

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
    - On a kept process, a timed-out call is cancelled in the helper with its own cancel method, fire and forget, with the Host's 5 s cancel deadline:
      - a plugin operation that carries an `operationId` (trimmed, non-empty, as `getPluginOperationId`): `plugins/cancelOperation {operationId}`;
      - `mcp/uiCallTool` (F3): `mcp/uiCancelCall`;
      - `mcp/uiSampling` (F3): `mcp/uiCancelSampling`.

      Both `mcp/ui` cancels carry only the call's `instance`, `workspace`, `sessionId`, `pluginId` and `serverName`, plus its `callId` or `operationId`, because the schemas are strict.
      The Host's own timeout for these calls is the same 180 s or 65 s (`DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS`), so Rust gives up no earlier than the Host would. Otherwise the abandoned operation would keep running and stay registered under its id. The Host cancels an operation when the user cancels it or the UI abandons it (a workspace or attachment switch, a superseded suggested prompt), but not on its own request timeout. Operation ids are unique per Host request, so the cancel names only the abandoned call.

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
  - It reads `dwf_*` and artifacts only. Under D1 (2026-11-17) Rust writes `dwf_*` and the actors' session rows; the helper keeps reading them (`specs/fork-rust-workflow-engine.md` section 5.1).
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

One PR per family, in this order: F1+F2 (helper skeleton plus the sessionless families), then F3, then F3b (session-scoped "always allow" and app-provided tools), then F4+F6, then F5 (after F1–F4 are merged; PR plan in `specs/fork-rust-workflow-engine.md` section 9), then F7 (MCP Apps on Rust-hosted servers, Option 1 of "MCP Apps on Rust-hosted servers"). Each PR updates the "Out of scope" section of `specs/fork-rust-agent-parity.md` and its matrix rows.
