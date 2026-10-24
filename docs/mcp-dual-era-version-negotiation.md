# MCP dual-era client version negotiation spec

> Status: implemented. Date: 2026-08-04.
> Protocol basis: MCP `2026-07-28` Versioning and Compatibility; stdio/Streamable HTTP Backward Compatibility.

## 1. Goals

The ZCode MCP client supports two server eras:

- modern: MCP `2026-07-28` and later, using per-request `_meta` and `server/discover`, sending no `initialize` / `initialized`;
- legacy: MCP `2025-11-25` and earlier, using the `initialize` / `initialized` handshake.

Ordinary MCP servers default to client-side era detection; the built-in `node_repl` is pinned to modern `2026-07-28`, keeping per-call execution stateless and workspace-scoped process sharing.

## 2. Config semantics

```ts
protocolVersion?: "legacy" | "auto" | "2026-07-28";
```

| Config                                       | Client behavior                                                                | Use case                              |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| unset, `stdio` / `http`                      | equivalent to `auto`                                                           | ordinary third-party MCP, both eras   |
| `auto`                                       | probe modern first; fall back to `initialize` only on definite legacy evidence | explicit dual-era                     |
| `legacy`                                     | no modern probe; go straight to the old handshake                              | known old servers; avoids stdio sibling |
| `2026-07-28`                                 | pin modern; fail if unsupported, no fallback                                   | built-in stateless `node_repl`        |
| unset or any non-modern config, `sse` transport | go straight to legacy; the old HTTP+SSE transport cannot carry MCP `2026-07-28` per-request era | explicitly chosen deprecated SSE endpoints |

Built-in server pinned configs:

- `node_repl`: `protocolVersion="2026-07-28"`, `isolation="workspace"`; each `js` use runs a one-shot worker/kernel;
- no separate built-in `browser_use` server is registered.

Version negotiation decides only the wire era, never process sharing. Ordinary third-party MCP keeps default session isolation even when negotiated modern; only the built-in `node_repl` explicitly chooses workspace isolation.

The config entry must accept and round-trip all three `protocolVersion` enum values across stdio/http/sse; omitting it injects no default. Illegal enum values or unknown fields still record per-server diagnostics and skip only that server, without affecting other servers or plugin config.

## 3. Connection sequence

```text
ordinary stdio/http server (protocolVersion unset or auto)
        |
        v
server/discover + preferred modern version
        |
        +-- DiscoverResult ----------------------> modern
        |                                           |
        |                                           `-- every request carries modern _meta
        |
        +-- recognized modern error -------------> modern
        |    e.g. UnsupportedProtocolVersion         |
        |                                           `-- correct per supported version; no initialize
        |
        `-- legacy evidence ----------------------> legacy
             stdio: non-modern error / reasonable timeout  |
             HTTP: 4xx with non-modern error body          `-- initialize -> initialized

built-in node_repl
        |
        v
pin 2026-07-28 -> server/discover
        |
        +-- supports 2026-07-28 -> modern / stateless
        `-- unsupported or unconfirmable -> connection fails; legacy fallback forbidden
```

The stdio `auto`/pin probe runs in a disposable sibling process owned by the MCP TypeScript SDK. ZCode must bound the probe: at most 5 seconds and at most half the server's total connection budget; the remainder serves the legacy server's real session-child startup and `initialize`. The overall connection timeout stays with the existing `timeoutMs`.

An HTTP probe timeout means a network failure and must not classify the server as legacy; the SDK should return a connection failure. Fallback is allowed only on a spec-conforming legacy HTTP response.

## 4. State and cache boundaries

- The negotiated result is exposed as `McpServerStatus.protocolEra` = `modern` / `legacy`, for diagnostics and control-plane display only — never a substitute fact for tool-catalog readiness.
- Every successful connection's `mcp.server.connected` production log event must record:
  - `mcpClientName` / `mcpClientVersion`: the MCP client identity sent to the server;
  - `mcpVersionNegotiationMode`: the effective policy actually used — `auto` / `legacy` / `2026-07-28`;
  - `mcpProtocolEra` / `mcpProtocolVersion`: the actual negotiated result after the SDK handshake;
  - `mcpConnectionId` / `mcpIsolation` / `workspaceKey`: the stable connection id in the pool, isolation scope, and workspace identity; session-isolation connections must also record `sessionId`;
  - `mcpTransportPid`: the direct child PID of the final stdio session transport; HTTP/SSE records no such field.
- Configured policy is not the negotiation result; troubleshooting must trust `mcpProtocolVersion`.
- Connection ownership and session leases are logged separately. `mcp.pool.lease.acquired` / `mcp.pool.lease.released` use the same `mcpConnectionId` and record `sessionId`, `workspaceKey`, `mcpIsolation`, and `refCount`. A workspace-isolation shared connection must not fake a unique `sessionId` on `mcp.server.connected`; express multi-session sharing through lease events.
- `mcp.pool.connection.created` and `mcp.server.closed` must carry the same `mcpConnectionId`, so logs can trace creation, reuse, and reclaim along `sessionId -> lease -> connection -> stdio PID`.
- A client connection's era is fixed after connect completes; reconnects renegotiate.
- Probe negotiation failures (`SdkError(EraNegotiationFailed)` / `UnsupportedProtocolVersionError`) map to `McpServerStatus.failureKind` = `protocol_negotiation_failed` (the adapter matches structured error types, not message text); the settings UI shows the "switch protocol version to 兼容旧版" guidance instead of a misleading "network unreachable". The protocol version can be set manually in the MCP server edit form (`protocolVersion` dropdown, hidden for sse) or in JSON config.
- ZCode adds no cross-session era persistence. The SDK/transport may cache the current connection's result but must never reuse one server's result for a different server config, workspace identity, or remote runtime.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` carry only existing session/tool events; version negotiation never enters relay, snapshot, queue, or owner state.

## 5. Failure and safety rules

1. Never treat every JSON-RPC error as legacy. Recognized modern errors like `UnsupportedProtocolVersionError` prove the server is modern; the client can only correct the version or fail.
2. stdio legacy detection must not key on a single error code; old servers may return `-32601`, `-32602`, close the probe child, or not respond within a reasonable time.
3. `protocolVersion="2026-07-28"` is a strict pin with no silent downgrade for the sake of "working"; this keeps the shared `node_repl` from falling back to legacy persistent session/kernel semantics.
4. `protocolVersion="legacy"` must stay byte-compatible with the old handshake, adding no modern headers or `_meta`.
5. Browser Use broker token, session registry, and workspace identity checks are unaffected by negotiation results; modern `_meta` provides only host routing context and can never become an authorization fact without the private child/broker and `requireSession`.

## 6. Acceptance cases

| ID    | Config/server                       | Expected                                                                                                        |
| ----- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MVN01 | plain stdio, version unset, modern  | defaults to `auto`, negotiates `modern`, no legacy initialize                                                     |
| MVN02 | plain stdio, version unset, legacy  | sibling probe detects legacy; the real child completes initialize; tools usable                                   |
| MVN03 | plain Streamable HTTP, version unset| defaults to `auto`; recognized modern errors do not downgrade, legacy responses do                                |
| MVN04 | any transport, explicit `legacy`    | no probe, keeps the old initialize behavior                                                                       |
| MVN05 | built-in `node_repl`                | pinned `2026-07-28`, `protocolEra=modern`, connection fails if unsupported; workspace may share the connection    |
| MVN06 | explicit legacy / `sse`             | fixed legacy, no disposable modern probe                                                                          |
| MVN07 | auto stdio server not answering     | probe ends within its bound; after fallback/total-connect timeout no sibling or derived process remains            |
| MVN08 | any server connected                | `mcp.server.connected` includes client identity, negotiation policy, actual era, and exact protocol version       |
| MVN09 | session/workspace isolation links   | connection, lease, and close logs correlate via `mcpConnectionId`; stdio logs the PID; shared links correlate sessions via multiple lease logs |

Focused adapter/process tests prove negotiation and cleanup; the Browser Use bundle smoke test keeps proving a real modern stdio server. The change does not alter conversation UI/product state and adds no conversation E2E state combinations.

An additional desktop real-process E2E, `packages/desktop/test/e2e/settings/mcp-dual-era-version-negotiation.test.ts`, starts modern/legacy stdio fixtures from a real CLI config in an isolated HOME and reads `mcp.server.connected` JSONL from the worker-specific `ZCODE_LOG_DIR`. That E2E must lock:

- the modern fixture actually negotiates `2026-07-28` with no legacy `initialize`;
- the legacy fixture completes `initialize` in the real session child after the disposable probe;
- a separate fixture explicitly configured `legacy` stays preserved with `legacy` logging policy and old-handshake-only wire, no `server/discover`;
- the logged policy, era, and exact protocol version match the fixture's wire records;
- after the probe child exits, each active consumer keeps only its own real session process; when Desktop has both settings and draft/session consumers, the E2E detects leftover probes by the surviving PIDs missing `tools/list` on the wire, no longer wrongly requiring the fixture's global live process count to be 1.

The case sends no provider requests; its realism comes from the full product chain Electron -> Local Host -> ZCode Agent -> MCP client -> stdio server.
