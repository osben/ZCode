# Feature Boundary Planner ZCode Domain Map

## Background

`feature-boundary-planner` was generalized from a conversation-specific skill into a general ZCode feature-boundary clarification entry. The main flow keeps formal-proof, the case catalog and user pruning, but its core is clarifying the feature boundary first. When a user raises "switch model", "mobile mode", "queue", "rendering performance", "persisted data update", "monitoring telemetry" or "data tracking", the skill must first list the product states that may cross and then guide the user to prune step by step, not just apply the default conversation dimensions.

## Goals

- Add a ZCode capability-domain and crossing-axis reference inside the skill, so natural-language requests can be located to related docs, code and state owners.
- Make matrix enumeration cover real product crossings: desktop, Web, mobile remote control, remote workspace, model/provider, queue, persistence, telemetry, rendering performance, permission/tool/MCP, theme/locale.
- Keep `SKILL.md` lean; put the detailed domain map in `references/`, loaded on demand.
- Keep user pruning: the skill may propose candidate semantics and impact only, and never silently decides product behavior for the user.

## Primary fact sources

| Capability domain | Representative docs | Representative code entries |
| --- | --- | --- |
| Architecture and message flow | `docs/architecture/zcode-code-architecture-overview.md`, `docs/architecture/message-flow.md` | `packages/shared`, `packages/services`, `packages/desktop`, `packages/ui`, `apps/zcode-cli` |
| Conversation state space | `docs/zcode-protocol.md`, `docs/conversation-product-state-space.md`, `docs/testing/conversation-session-*.md` | `packages/formal-proof`, `packages/ui/src/v4/conversationProjectionStore.ts`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` |
| Model and Provider | `docs/working-memory/provider-refactor/design/` | `packages/provider`, `packages/provider-node`, `packages/services/src/provider-runtime`, `packages/ui/src/settings` |
| Mobile remote control and replayable | `docs/web-remote-control/*.md`, `docs/zcode-protocol.md` | `packages/shared/src/zcode-protocol-v4/`, `packages/ui/src/v4/agentConversationTransport.ts`, `packages/desktop/src/main/webRemoteControlManager.ts` |
| Queue / command | `docs/ui/chat-message-queue.md`, `docs/zcode-protocol.md` | `packages/shared/src/zcode-protocol-v4/command.ts`, `packages/ui/src/v4/SessionPane.tsx`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts` |
| Persistence / identity | `docs/task/task-sqlite-index.md`, `docs/task/task-snapshot-on-demand.md`, `docs/remote-workspace-session-unified-settings.md` | `packages/services/src/session/taskIndexRepo.ts`, `packages/ui/src/store/tabWorkspaceIdentity.ts`, `packages/shared/src/workspaceSessionRestore.ts` |
| Rendering performance | `docs/chat/message-render-performance.md`, `docs/performance/streaming-tool-input-backpressure.md`, `docs/performance/renderer-production-logging.md` | `packages/ui/src/v4/ConversationTimeline.tsx`, `packages/ui/src/v4/ConversationRowView.tsx`, `packages/ui/src/v4/conversationProjectionStore.ts` |
| Monitoring / telemetry / usage | `docs/monitoring/performance-telemetry-catalog.md`, `docs/monitoring/business-monitoring.md`, `docs/usage-stats-app-coding-plan-split.md` | `packages/ui/src/lib/appTelemetry.ts`, `packages/ui/src/lib/uiPerfArmsTelemetry.ts`, `packages/services/src/telemetry`, `packages/services/src/usage-stats` |
| Permission / tool / MCP | `docs/permission-project-approval.md`, `docs/mcp-platform-boundary.md`, `docs/agent-tool-call-renderer.md` | `packages/shared/src/zcode-protocol-v4/`, `packages/shared/src/mcp.ts`, `packages/ui/src/v4/V4InteractionDialogs.tsx`, `packages/ui/src/ToolCallBlocks*` |
| Theme / locale / mobile shell | `docs/ui/zai-themes.md`, `docs/ui/default-theme.md`, `docs/web-remote-control/mobile-theme-control.md` | `packages/ui/src/i18n`, `packages/ui/src/useTheme.ts`, `packages/ui/src/WebRemoteControlMobileShell.tsx`, `packages/shared/src/protocol.ts` |

## Skill behavior requirements

1. Given a ZCode feature or bug-prone interaction, first map the request to 1-4 capability domains, read the corresponding source docs, then the code.
2. For each domain record the state owner: UI local state, Zustand store, host service, desktop main, relay, agent runtime, SQLite / session file, remote host or backend API.
3. Dimension extraction must include client type and delivery semantics: desktop `desktop-continuous` and mobile `web-remote-replayable` cannot stand in for each other.
4. Workspace-level state must distinguish `workspaceIdentity`, `workspacePath` and `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
5. Enumerate candidate crossing combinations first, then prune with guards, invariants, equivalence classes and representative cases; every pruned combination states its invariant.
6. An `undefined` case becomes a small-batch question to the user, with candidate answers and impact.
7. An accepted case states setup, action, assertion and evidence layer, with at least one non-UI evidence layer.

## High-risk crossing axes

| Axis | Why it must be explicit |
| --- | --- |
| Model switch x task switch / create / send / fork / edit / queue | The model fact source spans toolbar, workspace default, task config, task meta, draft session, provider registry and runtime `defaultModelRef`. |
| Model/provider x remote workspace | The local app-global provider registry and the remote runtime execution source differ; reconnect and runtime restart expose stale state. |
| Mobile remote x queue / permission / elicitation / stop | Mobile relies on the replayable mirror, snapshot watermark, owner command and host command queue; it cannot be inferred from the desktop local queue. |
| Replayable snapshot x persisted data | `ZCodeTaskSnapshot.runtime` is a response-state runtime supplement and is not written back to session JSON; the task index owns list metadata only. |
| Queue x stop / compact / goal / edit / fork | The queue is future user intent and must not be silently rewritten by compact, edit or fork; the autoDrain semantics after stop must be explicit. |
| Rendering performance x streaming tool input / background task / replay | Large tool input, Markdown, Mermaid, background tasks and replayable gaps amplify store writes, parsing and React render cost. |
| Telemetry x message stream / tool step / privacy / volume | High-frequency step/chunk events amplify ARMS or log volume; user content, credentials, hashes and raw payloads must not enter channels they should not. |
| Theme / locale x desktop / mobile / persisted settings | Desktop and mobile remote theme preferences are not coupled locally; locale may affect commands, menus, toasts, screenshot assertions and test copy. |
| Workspace identity x cache / task list / skill/plugin/MCP load | Remote workspaces cannot be isolated by path alone; caches, queues, config, task lists and remote history all use the identity fallback rule. |
| Tool/MCP/permission x mobile remote | MCP platform capability goes through `IPlatformService` and shared-host attachment; permission options pass through the agent response and are not guessed by the UI. |

## Acceptance

- `SKILL.md` of `feature-boundary-planner` points to the new domain-map reference and requires clarifying the feature boundary first, then capability-domain mapping.
- The reference file covers the capability domains, fact sources, state owners and high-risk crossing axes above.
- The case planning template accommodates domain scope, state owners, high-risk crossings and evidence layers.
- Run skill validation, `pnpm typecheck` and `pnpm lint`.
