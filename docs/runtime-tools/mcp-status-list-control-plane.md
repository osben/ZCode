# MCP status batch query control plane

## Background

The MCP settings page needs to show the status of each server in the current config. The old design ran a
real connection check per server on first load of the settings page, so a UI refresh could trigger many
control-plane requests and mixed "config state display" with "active health check".

## Goals

- The first load of the settings page uses one batch status query, avoiding automatic checks proportional to the server count.
- The batch status query goes through a separate `mcp-status` lane control-plane CLI process, process-isolated from plugin management commands (`plugins/*`); the two share the same internal cwd (`.zcode/plugin-workspace` under the data directory, i.e. `getDataBaseDir()/.zcode/plugin-workspace`, equal to `~/.zcode/plugin-workspace` by default; under an E2E isolated HOME or custom data dir it is not under `~`) but not the stdio connection.
- Keep the single-server active check, triggered only by a manual check or a check after enabling.
- MCP state is not pushed down into desktop main, relay or the mobile remote chain.

## Protocol semantics

- `mcp/list`: returns a snapshot of the status of the currently configured MCP servers. The request goes to the separate `mcp-status` lane control-plane CLI process; that process holds its own `McpPort`, refreshes the connection state of trusted configs with the same MCP adapter as the runtime, and then returns the local snapshot of `status()`. Project MCP before it is trusted still returns only `untrusted` and is not connected.
- Process lifecycle: the mcp-status lane process is started lazily on the first `mcp/list`, at most one per host (the process key is the fixed internal cwd). It really connects to trusted MCP servers through a process-level connection pool and does not disconnect when done, so besides the ~45 MB process itself it carries MCP child processes; to avoid this staying resident the manager enables `idleTimeoutMs` (default 5 minutes) for this lane: with no request in flight on the connection for 5 minutes the whole process tree is reclaimed (`terminationKind=expected`, `terminationReason=idle-timeout`), and the next `mcp/list` transparently restarts it (measured cold start about 1 s). The chat / plugin lanes do not enable idle reclamation.
- Process observability: spawn/ready/exit/error events are reported host -> main -> ARMS through `processLifecycleReporter`, with a `lane` payload (`mcp-status`) distinguishing it from the plugin lane process that shares the same cwd and command.
- Why a separate process: the CLI's ZCode Protocol transport serializes requests on one stdio connection strictly (FIFO, only `session/stop` can jump the queue). A connect-mode `mcp/list` really connects all MCP servers, and any server whose handshake never completes consumes the full 30s timeout; previously it shared the plugin management process with commands such as `plugins/uninstall`, so an uninstall was queued behind a 30s probe and the UI gave no feedback within the 5-minute request timeout (reproduced online 2026-09-03: `uninstallPlugin` waited 37s until the user force-quit, and `mcp/list` hit 60.5s = two 30s timeouts back to back). With the separate lane, a slow probe never blocks plugin management, and process reclamation after a probe timeout no longer takes down in-flight installs/uninstalls.
- `mcp/list` may carry an explicit `mcpServers` input. The desktop settings page has already had desktop main resolve `~/.zcode/cli/config.json` and the `.agents/mcp.json` fallback and, on real session create/resume, pass enabled MCP as `params.mcpServers`; the status query must reuse the same UI-resolved MCP, so the control-plane agent calling `createConfig()` itself and failing to read the `.agents` fallback does not mark actually usable servers red.
- `mcp/probe`: kept as the single-server active-check semantics. Used only on an explicit user check or a check after enabling; its result may differ from `mcp/list`.

The UI therefore must not interpret a `mcp/list` result as a successful real health check; a green connected only means the snapshot source reports connected.

## Data flow

1. After the UI MCP settings page loads local config, it requests `zcodeAgentService.listMcpServerStatuses(...)`, passing the list of enabled ZCode Agent MCP under the current workspace.
2. The service sends `mcp/list` via `getMcpStatusClient()` using the `mcpStatusProcessManager` client (`lane: "mcp-status"`, separate from plugin management's `pluginProcessManager`). A new agent accepts `mcpServers`; an old strict agent that rejects this optional field makes the service drop the field and retry once.
3. Inside the control-plane CLI process the plugin config is read per the request workspace; if the request carries `mcpServers`, the local ZCode Agent MCP status follows that explicit input, otherwise it falls back to the `mcp.servers` the agent reads with its own `createConfig()`.
4. The CLI handler calls the in-process `mcpPort.connectConfiguredServers(...)` for trusted configs to refresh local records; project untrusted MCP is removed from the connection input. The explicit `mcpServers` and session create/resume use the same protocol-to-runtime conversion helper, keeping timeout/env/header fields consistent.
5. The CLI handler wraps the existing `listMcpServerStatuses(...)` to return a status snapshot; `status()` itself only reads local records and does not connect again.
6. The UI store merges status per current local ZCode Agent MCP row; the plugin-managed read-only list stays driven by plugin management data, so same-named servers do not cross state.

## UI merge rules

- Merging applies only to local MCP rows with `source === "zcodeagentmcp"`.
- Merging uses the current row's `name` but must not override plugin-managed read-only rows by name.
- The `mcpServers` the settings page sends to `mcp/list` come from the current UI store's enabled ZCode Agent MCP and must be sent together with the current workspaceIdentity/workspacePath input; another workspace's cache must not be reused.
- A request must carry an epoch or equivalent version guard; a late batch result must not overwrite the `changed` produced by user edits during the request, nor a newer manual check result.
- Display-only state the UI writes purely for interaction feedback (such as showing `connecting` right after enabling or `unknown` after disabling) must not invalidate the current batch request; only operations that change what the agent reads (config, enable/disable, workspace identity) may advance the epoch.
- The settings page allows only one `mcp/list` in flight at a time; if a refresh is triggered while in flight, it is merged into just one next round after completion, so clicking toggles repeatedly does not queue the whole batch of MCP connections for ten-odd seconds.
- When mapping runtime status to UI status, `failed` maps to `error`; `connected`, `connecting`, `disconnected` keep displayable semantics; `disabled` and `untrusted` show as non-success config states with a safe explanation.
- A status snapshot may carry a stable `failureKind` and `serverRequestId`. `error` keeps the raw detail and the UI does not use it directly as the user-facing main text.
- A trusted official HTTP MCP reads only the response header `X-Request-Id`; diagnostics of connect, initialize and `tools/list` may enter the settings page, and the request id of `tools/call` goes only into the corresponding tool result. stdio, DNS and timeout without an HTTP response do not fabricate an id.
- ZCode envelope `3001`, `1000`, JSON-RPC `error.code=1006/3101`, HTTP 429/5xx and other JSON-RPC errors map respectively to `server_not_found`, `server_unavailable`, `not_authenticated`, `coding_plan_required`, `rate_limited`, `server_internal_error`, `protocol_error`; when no finer split is possible `connection_failed` is used.

## Verification

2026-09-06 merge recovery: the plugin UI had been restored earlier but the service layer's separate lane was
missed. This round reconnects the manager, request-zero event and idle reclamation per the original
control-plane boundary, without restoring the old Provider Store. The child-process isolation suite 4/4 and
the full `zcodeAgentService` unit tests 45/45 pass; this is not a substitute for real settings-page
interaction acceptance.

- The first open of the MCP settings page triggers a single `mcp/list` and no per-server automatic checks in the UI layer.
- `mcp/list` refreshes the live status of trusted MCP inside the `mcp-status` lane CLI process; a correct but unreachable config shows failed/error, and a connectable one shows connected and the tool count.
- While `mcp/list` is in flight (for example one MCP server's 30s handshake timeout), `plugins/uninstall` and `plugins/list` must return immediately and not be queued behind it (services unit test `plugins/uninstall 不会排在挂起的 mcp/list 后面`).
- A server that exists only in the `.agents/mcp.json` fallback and is shown on the settings page also enters `mcp/list` with `mcpServers` and gets a snapshot back, no longer showing the false red `MCP server status was not returned by agent`.
- An active check is triggered only on a manual check or enabling a single server.
- Same-named local/plugin MCP do not cross state.
- The failure summary switches between Chinese and English and uses ordinary secondary text color; the raw English error shows only via a Popover after clicking the info button, and the server Request ID appears as a compact suffix of the detail text and is no longer shown separately. A successful refresh clears old diagnostics.
- A late batch result does not overwrite user edits or a newer manual check result.
- Repeated toggle clicks or React dev's repeated effect triggers produce no overlapping `mcp/list` queue; at most one round with the latest input is rerun after the current request completes.
- Desktop verified through CDP: Settings -> MCP Servers has no repeated refresh loop, no console errors, and status renders normally.
