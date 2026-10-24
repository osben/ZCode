# Current ZCode Agent and App integration

Updated: 2026-09-04

The ZCode App starts only the ZCode Agent (`zcode app-server --stdio` from `apps/zcode-cli`). The
retired multi-agent process manager, third-party runtime installer, proxy traffic and UI agent switch
are not part of the current product path.

## Process and service boundaries

```text
Renderer / Web UI
  -> hooks / IServiceAccessor
  -> IZCodeAgentService (V4 command/topic)
     IZCodeSessionService (remaining lifecycle/workspace config facade)
     IZCodeTaskService (list organization state, compatibility queries, remote wrapper)
  -> window-scoped Local Host Process
  -> ZCodeAgentProcessManager
  -> workspaceKey-scoped zcode app-server --stdio
```

- The UI does not manage child processes, parse stdio frames, or call concrete service implementations directly.
- Each BrowserWindow has one Local Host; several local workspaces of the window share that process through the workspaceKey service scope, with no extra Local Host per workspace.
- A remote workspace additionally creates or reuses a window/target-scoped Remote Host. The Remote Host is a different process from the window's Local Host and connects to the SSH/WSL/Docker/Server environment; broadcast is still provided by the desktop local service.
- Agent processes are isolated by `workspaceKey = workspaceIdentity?.trim() || workspacePath`, and concurrent starts are single-flight.
- Mobile `/remote` attaches to the desktop window's existing local/remote host and CLI; no mobile-side Agent runtime is created.
- main/relay handle only windows, pairing, authentication, heartbeat and frame/app payload forwarding, and store no conversation state.

## State ownership

| State                                                                                              | Authority                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| transcript, turn/row, phase, actions, queue, interaction, goal, background work, session config    | CLI V4 projection/runtime                                                                                                  |
| Provider Config, Registry and credentials                                                          | The current Environment; Host/Worker build from that Environment's Config/Credential Source, no cross-Environment Registry |
| pin/archive/group/unread, list-search compatibility metadata                                       | host tasks-index                                                                                                           |
| draft, scroll, focus, panel, optimistic pending overlay                                            | renderer/web local                                                                                                         |

`zcodeSessionStore` still holds the workspace shell, task-list cache, unread/optimistic organization
state and some compatibility service projections, but no longer owns the V4 conversation transcript or
bound session config. The UI conversation read path is `ConversationProjectionStore` /
`SessionDataLayer`; the list-liveness read path is sessions-index.

## Protocol

stdio uses LF-delimited NDJSON; schema lives in `packages/shared/src/zcode-protocol-v4/`. The Host's
`zcodeProtocolClient` and `zcodeStdioTransport` handle requests, notifications and runtime generation;
high-frequency raw frame/chunk logs must use the service logger's `debug`.

Main path:

- Read: `conversation/<sessionId>`, `sessions-index/<workspaceId>`, `workspace-config/<workspaceId>` topics.
- Write: V4 command envelope + command ACK/query.
- Recovery: desktop continuous and mobile replayable use independent subscription ownership and delivery kinds, converging to the same snapshot.
- Old `session/*` schema may only maintain the remaining compatibility facade and must not take new conversation features.

See [ZCode Protocol](./zcode-protocol.md).

## Provider readiness and startup

Provider readiness gates only write paths that change a session/workspace or the execution model. The
Service checks that the current Environment Registry has at least one runnable Provider/Model and the
needed access material; it checks structure of this Environment only, no network probing. When unmet,
the write path returns the stable `provider_not_ready`, creates no draft session, and the draft UI
shows the existing missing-model-config entry.

Read-only control surfaces do not depend on a model: `sessions-index`, existing
`conversation/<sessionId>` and their resync/unsubscribe may start and reuse the workspace CLI on
demand, so the task list and history stay readable with no model or after a failed credential
migration. After a read-only start, a later `createSession` / command must pass the readiness gate
again; an active client is not a bypass. This adds no protocol field and does not change desktop
continuous, mobile replayable, connection ownership or workspace identity boundaries.

`provider_not_ready` is the normal waiting state of a new user who has not finished configuration,
not a sessions-index subscription fault. When the Registry becomes ready, the Agent Service reuses the
Worker already started by the read-only subscription, or starts it once per workspaceKey if not yet
started; the Worker rebuilds the Registry from the current Environment's Config Source. Topic
subscription does not wait for model config and never requires an App restart.

All topic retry reasons use a bounded enum; a previous round's log reason is never concatenated into
the next. Persistent non-readiness faults may keep auto-recovery, but production `warn` for the same
error is at most once per minute; after a successful subscription, that topic's backoff and rate-limit
state is cleared so a later new fault still leaves its first diagnostic log.

When the Registry later becomes ready, the Service enables model execution for registered workspaces
once per workspaceKey. If config later becomes invalid, the current Environment Registry is updated
but already-running processes are not killed. A remote workspace's read-only subscription still starts
the target CLI over the existing desktop shared-host attachment; mobile `/remote` must not start an
Agent/runtime because of it.

Draft models are not "all decided by the Agent default": a V4 draft reads the workspace catalog and
the global last selection under that workspace, and sets the initial CLI session values by prewarmed
`createSession.config` / CAS. An existing session always uses the snapshot config.

## Unavailable workspace at startup

Desktop startup uses only the last active local workspace to decide whether the UI enters read-only
restore. When the path is missing, not a directory or inaccessible:

- The original workspace tab, tasks-index and history sessions are still restored.
- It is marked `unavailable-local-directory` for the renderer lifetime, not written back to settings, and not polled at runtime.
- Read-only browsing, search, copy, switching/closing workspaces and settings are allowed.
- Entries that change a session/workspace are blocked: send, retry, fork, compact, list mutations, attachments, file tree, Git, terminal.
- The local desktop restore chain always ensures the app-managed conversation backing workspace exists and uses it as the local Host's Agent spawn fallback; any restored local workspace (including inactive historical ones) degrades to that directory only when its own cwd is unavailable, while the protocol workspacePath/identity keeps the original values.

Remote workspaces and non-active local workspaces do not take part in the startup UI availability
decision. For non-active historical workspaces, the Agent spawn preflight dynamically checks the real
cwd when tasks-index builds its background subscription; a missing directory must not cause Helper
`ENOENT` or endless restarts. An active path that recovers at runtime stays read-only until the next
startup re-evaluates it.

## Remote resources and packaging

Default remote deployment and desktop packaging keep only the ZCode Agent and necessary tools/runtime
(e.g. Node, node-pty, ripgrep and per-platform search runtimes). The historical
`resourcePackages.selectedPackageIds` is read for compatibility only and cannot trim required
resources. Build scripts, signing and the Windows resource-lock check must not bring leftover retired
third-party runtimes on the local machine back into artifacts.

- `@zcode/desktop` `prepare:glm` remains only as a manual fallback to download the old native Agent; default local packaging prepares `zcode.cjs` through `prepare:agent-bundle`. `prepare:native-search` downloads `bfs`, `ugrep`, `ripgrep` prebuilt archives per target platform; the old `prepare:rg` is no longer an independent entry.
- The local runtime self-check of `pnpm dev:desktop` only fills in the current platform's native-search toolset and required platform helpers: `bfs`, `ugrep`, `ripgrep` on macOS/Linux; `ugrep`, `ripgrep` on Windows x64/arm64. It no longer checks or downloads `glm/zcode-agent`. The dev Agent is built by `dev-desktop-env.mjs` calling `build-desktop-agent-cli.mjs` after `pre-dev`, and the runtime prefers the workspace `dist/zcode.cjs`.
- Desktop installers carry `resources/glm/zcode.cjs`, `resources/tools/ugrep` and `resources/tools/ripgrep`; macOS/Linux also carry `resources/tools/bfs`.

The Agent runtime version source of truth is `packages/shared/src/zcode-agent-runtime.ts`. Local
development, desktop build, remote manifest and download logic should all read it and not infer from
the old provider runtime manifest.

## Current entry points

- `packages/services/src/zcode-agent/zcodeAgentService.ts`
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- `packages/services/src/zcode-agent/zcodeProtocolClient.ts`
- `packages/services/src/zcode-agent/zcodeStdioTransport.ts`
- `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`
- `packages/ui/src/v4/V4ConversationContext.tsx`
- `packages/ui/src/v4/SessionPane.tsx`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`
