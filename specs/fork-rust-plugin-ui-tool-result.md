# zcode-rs: the `v4/plugin-ui/tool-result` notification

## Background

An MCP App panel (plugin UI) opens from the result of a tool call. The desktop host gets that result from the agent's
notification `v4/plugin-ui/tool-result` and creates the panel's page from it, even when no conversation card is mounted
and no conversation topic is subscribed (`docs/plugin-ui-background-execution.md`, "页面声明与回收";
`apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md:2856-2862`).

zcode-rs never sent it. The cause is one step earlier: a Rust MCP tool returned `display: null`
(`packages/rust-cli/crates/ext/src/mcp/tool.rs`, both the success and the `isError` branch), so no Rust tool row ever
carried `display.kind == "mcp_tool"` or its `ui` block. Node's emitter reads exactly that row. This spec ports the
display and then the notification.

## Node reference

- Display. `createMcpToolDisplay` and `createMcpToolDisplayUi`
  (`apps/zcode-cli/packages/core/src/tool/executor/result-display.ts:60-134`). The `ui` descriptor comes from the tool's
  `tools/list` `_meta`, normalised once by `normalizeMcpToolUiMeta` (`packages/shared/src/mcp-apps/toolMeta.ts:44-72`,
  called from `apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts:21`). The plugin id comes from the session's
  plugin catalog (`core/src/runtime/methods/mcp.ts:516-524`, `core/src/mcp/index.ts:118`) and falls back to the server
  name (`result-display.ts:94-97`).
- Emit. `V4Gateway.ingestNormalizedEvent` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1193-1213`):
  after the projection committed a live `ToolCallResult`, it finds the row by `toolCallId` in the session snapshot
  window. If the row is `toolCall`, status `success` and `display.kind == "mcp_tool"`, it parses
  `{sessionId, toolCallId, serverName: display.serverName, ui: display.ui, input?: row.input}` with
  `pluginUiToolResultNotificationSchema` (`packages/shared/src/mcp-apps/schemas.ts:84-93`, strict; `ui.isError` is
  refused; `input` only when it is a plain object) and sends it (`v4-bridge.ts:2458`, method
  `V4_NOTIFICATIONS.pluginUiToolResult` = `v4/plugin-ui/tool-result`, `zcode-protocol-v4/transport.ts:457`).
  History hydration writes the publisher directly and never reaches this code.
- Order. The notification is sent inside event ingest. The conversation frame that carries the row update is sent later,
  by a `setTimeout` flush (`v4-gateway.ts:3988-3996`). So on the wire the notification comes before the frame of the same
  event.
- Consumer. `packages/services/src/zcode-agent/zcodeAgentService.ts:2959-2975` (local runtime only, adds the workspace),
  and the E2E fixture `packages/desktop/scripts/mcp-apps-host-fixture/managed-environment.ts:95-110`.

## Product rules

1. A Rust MCP tool result carries Node's `mcp_tool` display: `{kind, serverName, toolName, description?, ui?}`.
   `serverName` and `toolName` are trimmed and cut to 256 UTF-16 units (a cut that would split a surrogate pair drops the
   half pair); an empty one means no display. `description` is the tool's listed description, trimmed and cut to 4096.
2. `ui` exists only when the tool's listed `_meta` normalises to a descriptor (rule 3) and the plugin id is not empty
   after the same bounding (256). Its fields, in Node's order: `pluginId`, `resourceUri`, `preferredDisplayMode?`,
   `prefersBorder?`, `csp?`, `structuredContent?`, `widgetMeta?`, `content?`, `truncated?` + `truncatedBytes?`,
   `isError?` (only `true`), `surface?`, `showInline?` (only `true`). `visibility` is never part of `ui`.
   - `structuredContent`, `widgetMeta` and `content` are the JSON text (insertion-ordered keys) of the result's
     `structuredContent`, `_meta` and `content` (the last only when an array). Missing or null: omitted. Over 64 KiB, 16 KiB
     and 32 KiB (UTF-8 bytes): the whole field is omitted and its byte length is added to `truncatedBytes`, with
     `truncated: true`.
   - `isError: true` when the raw result has `isError === true`.
3. Descriptor normalisation is `normalizeMcpToolUiMeta`: `resourceUri` from `_meta.ui.resourceUri`, then
   `_meta["ui/resourceUri"]`, then `_meta["openai/outputTemplate"]`; it must be a string that starts with `ui://` after
   trimming and is at most 2048 units, else there is no descriptor. `preferredDisplayMode` from
   `_meta["openai/ui"].preferredModelDisplayMode` (`inline`, `fullscreen`, `pip`). `csp` from `_meta.ui.csp` and
   `_meta["openai/widgetCSP"]` (camelCase, and snake*case for the legacy one), each domain list normalised by
   `normalizeCspOrigin` (https and wss any host, http and ws only `127.0.0.1`, no credentials, query, fragment or path),
   duplicates removed; a present list counts even when empty. `prefersBorder` from `ui.prefersBorder` or
   `openai/widgetPrefersBorder`. `surface` trimmed, at most 128 units, `^[A-Za-z0-9]A-Za-z0-9*.-]\*$`.
`showInline`from`ui.showInline`or`openai/widgetShowCodexWidgetInline`.
4. The plugin id is the owning plugin's id (`name@marketplace`) for a server a plugin declares, else the server name.
5. The row carries the display (the projection already copies a `mcp_tool` output display to `row.display` and to the
   output). An MCP `isError` result keeps Rust's error row, with the display built the same way (`ui.isError: true`).
6. After a live `ToolDone` is applied to the projection, the protocol server sends `v4/plugin-ui/tool-result` with
   `{sessionId, toolCallId, serverName, ui, input?}` when the row is `toolCall`, status `success`, `display.kind ==
"mcp_tool"`, `display.ui` is present without `isError`, and `serverName` is not empty. `input` is the row's input
   only when it is a JSON object.
7. It is never sent for: a failed, cancelled or denied call, an `isError` result, a tool without `ui`, a cold open or
   rebuild (`HistoryRewritten`), an event at or below the session's `skip_through`.
8. Order. One notification per qualifying event, sent before the conversation frames of that same write (Node: ingest
   before the flush timer). Two results in one batch are sent in event order.

## State owner

- Display data: `ext` (`mcp/display.rs`, built in `McpTool::call` from the tool's listing and the raw result).
- Plugin id of a server: `McpManager` (`plugin_ids`, filled by `note_plugin_ids` where the plugin layer installs its
  servers, both in `Ext::start` and in the workspace layer).
- The notification: `Live` in `protocol-zcode` (the one writer of the session's outgoing facts), queued in the same
  place as the telemetry facts and written by `Live::write`.

## Interface

- `rust-cli-ext`: `McpManager::note_plugin_ids`, `Plugins::mcp_plugin_ids`, internal `mcp::display`.
- `protocol-zcode`: `pub const PLUGIN_UI_TOOL_RESULT: &str = "v4/plugin-ui/tool-result"` and a pure
  `fork::plugin_ui_result::of_row(session, row) -> Option<Value>`.
- Wire: Node's notification, params as in rule 6.

## Acceptance cases

1. A `ui://` tool call that succeeds: the row has `display.ui`, exactly one notification follows, before the row's
   frame, with the row's input.
2. The same tool with `isError: true`: no notification.
3. A tool without `_meta.ui`: a display without `ui`, no notification.
4. Failed, cancelled and denied calls: no notification.
5. `HistoryRewritten` rebuild and a replayed sequence number: no notification.
6. Each of the three `resourceUri` sources, the `openai/*` aliases, an invalid `resourceUri` (no descriptor), a field over
   its byte limit (dropped, `truncatedBytes` sums), `visibility` absent from `ui`, the server-name fallback and the
   plugin id.

Desktop E2E: no WDIO spec wraps this case. Run
`node packages/desktop/scripts/mcp-apps-host-e2e.mjs --background-only` (case `PLM-UI-BACKGROUND-ADMISSION`,
`docs/plugin-management-lifecycle-case-catalog.md:191`; assertions in
`packages/desktop/scripts/mcp-apps-host-fixture/background-main.ts`). The in-chat card path (`row.display.ui`) is covered
by `packages/desktop/test/e2e/plugins/extensions/plugin-extension-entries.test.ts`.

## Known differences

- `display.unavailable` (the official-MCP quota code) is not built: Rust has no official-MCP flag on a server.
- A cold reopen of a session shows no `display` for an MCP row: Rust stores only the result text, Node persists the
  display in the part metadata. The notification is live only, as in Node, so no background page opens from history in
  either runtime.
- An MCP `isError` result is an error row in Rust and a success row in Node. This predates the port and is unchanged;
  neither runtime sends the notification for it.
- The plugin id map is filled when plugins load and only grows within a process. Two marketplaces that ship a plugin of
  the same name share the server name `plugin:<name>:<server>`, and the later load wins.
- Subagent child sessions: only a session's own `Live` sends the notification, as for the telemetry facts.
