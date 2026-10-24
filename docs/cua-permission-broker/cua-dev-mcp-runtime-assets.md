# CUA Dev node_repl SDK Runtime Asset Closed Loop

CUA has no independent MCP launcher. Desktop Dev only seeds the CUA SDK, Skills and on-demand docs and reuses the shared `node_repl` MCP (one tool, `js`) shared by Browser Use and Computer Use. The native Helper, frame registry, kill switch, input hold and `possibly_sent` are still maintained by the shared-host `CuaControlPort`; the mobile side can only attach to an existing host.

```text
pnpm dev:desktop
  |
  +-- stage Browser node_repl runtime (the only MCP server)
  +-- stage zcode-cua SDK/docs/skill (no mcpServers entry)
  `-- build Agent bundle and filesystem seed
          |
          v
      node_repl MCP (3 model tools)
          |
          `-- Worker bootstrap -> agent.computerUse -> local bridge
                              -> CuaControlPort -> BrokerClient -> Helper
```

Without a broker/permissions the SDK returns an explicit unavailable; no independent MCP/Helper is started on the relay, mobile side or per session. Desktop uses `desktop-continuous`, mobile uses `web-remote-replayable`.

## Asset and state boundaries

| Fact                         | Authoritative owner          | Artifact/verification                                                                  |
| ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| CUA SDK                      | `@zcode/zcode-cua-plugin`    | `scripts/computer-use-client.mjs` + `scripts/check-sdk.mjs`                            |
| CUA documentation and Skills | producer plugin              | `docs/computer-use.md`, `skills/computer-use/SKILL.md`                                 |
| node_repl MCP                | `@zcode/browser-use-plugin`  | `dist/mcp/server.js` + `scripts/computer-use-client.mjs` (shared host runtime)         |
| CUA runtime/session/frame    | shared-host `CuaControlPort` | `createComputerUseRuntime()`; isolated by `workspaceKey`/`remoteSessionId`/`sessionId` |
| native capability            | CUA Helper + TCC             | broker token, frame freshness, kill switch, input cleanup                              |

## Constraints

- Model tool projections for new sessions include only `mcp__node_repl__js`. Old `mcp__computer-use__*` configurations and the deleted `js_reset` / `js_add_node_module_dir` are discarded during bootstrap; historical transcripts are read-only replay only.
- Each Worker re-bootstraps the SDK on every call but does not destroy the shared-host CUA runtime or frame state.
- node_repl bridge requests carry `workspaceIdentity`, `workspacePath`, `workspaceKey`, `sessionId`, `remoteSessionId`, `turnId`, `traceId`, `clientMode`, `deliveryKind`; subagents fail closed at the bridge entry.
- Broker credentials are injected only into the trusted shared node_repl; the plugin host no longer accepts old CUA argv socket entries.

## Acceptance cases

| Case                   | Verification                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| SDK 30-method contract | Producer manifest/schema and SDK method union correspond one to one                                     |
| Worker rebuild         | Multiple `node_repl js` calls can re-bootstrap; CUA runtime/session state persists                      |
| Image results          | The SDK sends CUA image blocks through the generic `nodeRepl.emitImage`; base64 is not turned into text |
| No broker/permissions  | Returns unavailable/permission error; no independent MCP/Helper started                                 |
| Remote boundaries      | Desktop continuous and web remote replayable share attachment; CUA state is not put into relay/snapshot |
| History records        | Old `mcp__computer-use__*` are viewable but cannot be re-executed or re-injected                        |

## Related implementations

- `apps/zcode-cli/packages/browser-use-plugin/src/cua-bridge.ts`
- `apps/zcode-cli/packages/browser-use-plugin/src/mcp/cua-broker.ts`
- `apps/zcode-cli/packages/browser-use-plugin/src/mcp/server.ts`
- `apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs`
- `apps/zcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts`
- `docs/cua/2026-08-24-cua-node-repl-sdk-migration-spec.md`
