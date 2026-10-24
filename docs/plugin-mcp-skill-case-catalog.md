# Plugin MCP skill case catalog

Goal: expand the product semantics of desktop “plugin-provided MCP skills” from install to disable as e2e cases for product, QA, and dev review. v1 covers only the three basic happy-path states (not installed / installed-enabled / installed-disabled); later catalog increments handle multi-step import flows, per-skill disabling, cross-workspace inheritance, and post-uninstall cleanup separately.

## Naming and fixed markers

- Tool namespace (runtime): after the agent loads a plugin MCP server, `apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts` rewrites `plugin:<plugin-name>:<server>` to the anthropic-compatible `mcp__plugin_<plugin-name>_<server>__<tool>` — the tool name actually sent to the model. Cases in this catalog fix:
  - plugin: `e2e-plugin-mcp-ping` (fixture path `packages/desktop/test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping/`)
  - server: `ping`
  - plugin-internal namespace: `plugin:e2e-plugin-mcp-ping:ping` (debug logs / `getEnabledMcpServers` only)
  - actual model tools-array name: `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`
  - plugin id (in `installed_plugins.json`): `e2e-plugin-mcp-ping@e2e-fixture`
- e2e marker prefix: `E2E_PLUGIN_MCP_PING_<STATE>_<runId>`
- State A: `not-installed`; state B: `installed-enabled`; state C: `installed-disabled`

## Enumeration boundary

| Dimension | Equivalence classes |
| --- | --- |
| Install state | `not-installed`, `installed-enabled`, `installed-disabled` |
| Trigger surface | `installed_plugins.json` present/absent; `config.json#plugins.enabledPlugins[id]` true/false/missing |
| MCP server start | `lazy` (spawn only on listTools); `eager` (spawn on plugin enable) |
| Conversation tool exposure | namespaced tool name present/absent in `tools[]` |
| Soft evidence | `chat-tool-call-block-<toolName>` block present/absent in chat |
| Fixture reuse | `fixtures/upstream/plugin-mcp-skill/conversation-session-plugin-mcp-skill-{baselines,installed-enabled}.json` |

## Review states

| State | Meaning |
| --- | --- |
| accepted | Product expectation clear; test can be generated |
| undefined | Product expectation undefined; pending |
| bug-candidate | Implementation conflicts with the case; not necessarily a protocol issue |

## Case list

| ID | Precondition | User/system event | Rule hit | Expected | Review |
| --- | --- | --- | --- | --- | --- |
| P01 | `installed_plugins.json` lacks the plugin | User sends plain text in chat | `not-installed` baseline | Request `tools[]` lacks `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`; no corresponding tool-call block in chat | accepted |
| P02 | `installed_plugins.json` has the plugin, `enabledPlugins[id] = true` | User sends a “call the tool” prompt | `installed-enabled` strong evidence | Request `tools[]` contains `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`; chat shows that tool's tool-call block | accepted |
| P03 | `installed_plugins.json` has the plugin, `enabledPlugins[id] = false` | User sends plain text | `installed-disabled` | Request `tools[]` lacks `mcp__plugin_e2e-plugin-mcp-ping_ping__ping`; no corresponding tool-call block | accepted |

## v1 verified constraints

Verified 2026-07-05 on local macOS (Apple M4 Pro) with a real Electron desktop run — all three specs pass. Durable gotchas learned getting v1 green:

1. `installed_plugins.json` must land in `<E2E_HOME>/.zcode/cli/plugins/`, not `cli/` (bootstrap's `pluginStorageRoot = cli/plugins`; `listInstalledPluginRecords(pluginStorageRoot)` reads `<pluginStorageRoot>/installed_plugins.json`).
2. Installed plugins have `defaultEnabled = false`; `config.plugins.enabledPlugins[id] = true` must be explicit — a deleted field counts as default false.
3. The tool name injected into the model is `mcp__plugin_<plugin-name>_<server>__<tool>`, not `plugin:<plugin-name>:<server>` (plugin-internal namespace only). Replay fixtures and chat assertions both use the former.

## Fixture contract

### Written by wdio.conf.ts before e2e startup

- `<E2E_HOME>/.zcode/cli/plugins/installed_plugins.json`:
  - State A: `resetE2EHome()` has cleared the E2E home; no plugin install record is written.
  - States B/C: rendered from `fixtures/plugin-mcp-skill/installed-plugins.{enabled,disabled}.template.json` (placeholder `__INSTALL_PATH__` replaced with an absolute path), name=`e2e-plugin-mcp-ping`, marketplace=`e2e-fixture`, scope=`user`.
- `<E2E_HOME>/.zcode/cli/config.json` (patched after `seedUpstreamE2EModelConfig`):
  - State B: `plugins.enabledPlugins["e2e-plugin-mcp-ping@e2e-fixture"] = true` (explicit true required — installed plugins are `defaultEnabled = false` in `NodePluginAdapter.resolveCandidates`).
  - State C: `plugins.enabledPlugins["e2e-plugin-mcp-ping@e2e-fixture"] = false`.

### deepseek replay fixtures

- `fixtures/upstream/plugin-mcp-skill/conversation-session-plugin-mcp-skill-baselines.json`: shared by A and C, matches `E2E_PLUGIN_MCP_PING_{NOT_INSTALLED,DISABLED}`, replies plain text `deepseek-e2e-ok`.
- `fixtures/upstream/plugin-mcp-skill/conversation-session-plugin-mcp-skill-installed-enabled.json`: state B only, matches `E2E_PLUGIN_MCP_PING_INSTALLED_ENABLED`, first replies `toolUse.name="mcp__plugin_e2e-plugin-mcp-ping_ping__ping"`, then plain text `deepseek-e2e-ok` in the tool-result turn.

## Reused helpers

- `prepareConversationE2E()` / `startNewTask()` / `sendPrompt()` / `waitForUserMessageContaining()` / `waitForUpstreamRequestContaining()` / `waitForAssistantMessageContaining()` / `waitForChatState()` — `helpers/conversation-session.ts`
- `ensureToolCrossProductFullAccessMode()` / `respondToToolCrossProductBlockers()` — `helpers/conversation-session-tool-cross-product.ts` (state B only, so Full access / permission dialogs do not intercept the tool call)
- `getToolCallBlockByToolName()` — same file
- `helpers/plugin-mcp-skill.ts` adds: `PLUGIN_MCP_TOOL_NAME`, `captureArtifactAdvertisesToolName`, `findUpstreamRequestContaining`

## Not reused / not done yet

- Real MCP server `tools/call` response loop (v1 trusts deepseek replay fakes; the fixture `server.mjs` only guarantees the agent starts and listTools succeeds while enabled).
- Per-skill disabling (individual skills within a plugin).
- End-to-end tests fetching real plugins from a marketplace (out of scope here — only the post-install skill lifecycle).
- Post-uninstall cache/data-dir/skillRoot cleanup and rescan.
- MCP tool inheritance across workspace identity switches.

## Failure triage quick reference

- `installed_plugins.json` ignored by the agent at wdio startup (wrong path) → check `ZCODE_STORAGE_DIR` / `homedir()` at `apps/zcode-cli/packages/adapters/src/exec/index.ts:78` and confirm the agent process actually reads `<E2E_HOME>/.zcode/cli/`.
- `tools[]` namespace not `plugin:<name>:<server>` → grep `toNamespacedServerName` to confirm the implementation.
- deepseek capture artifact missing `requestJson` → fall back to text scanning of `record.requestBody` (weak evidence; only proves the marker reached the request body).
