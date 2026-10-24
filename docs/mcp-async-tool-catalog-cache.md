# MCP async initialization and tool catalog cache

## Status

- Stage: planning
- Scope: agent runtime, MCP adapter, tool registry / executor, bootstrap process-level dependencies
- Goal: a process-scoped tool catalog cache so that a new session with a cache hit can issue its first model request before live MCP initialization completes
- Non-goals: no live MCP server/client LRU; no reduction in the number of MCP servers each active session actually starts

This design therefore addresses MCP initialization blocking the first model request, not the persistent growth of live MCP processes and memory caused by unreleased sessions/runtimes. If that remains, debug it separately via session ownership / close lifecycle — the tool catalog cache is not a resource-reclamation mechanism.

## Background

ZCode already schedules MCP initialization early at session/runtime creation, but before the first provider request it still runs:

```text
startMcpStartup()
  -> connectConfiguredServers()
  -> initializeMcp() await startup
  -> registerMcpTools(live tools)
  -> provider request
```

So today's "async" only parallelizes MCP initialization with context, skills, memory preparation; the first model request is still blocked by the slowest server's `initialize + tools/list`.

The optimization focus is not sharing a live MCP runtime; it is separating two facts:

```text
provider-visible tool catalog
  can come from a process-scoped, short-lived, sanitized schema cache

live tool execution
  must wait for the current session's live client, and re-confirm tools, schema, and permission metadata
```

This design uses that dual-channel semantics.

## Design trade-offs

| Capability                      | Semantics                                                                                                                    | ZCode plan                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| process-scoped tool catalog LRU | 32 entries, 30-minute TTL; read only while startup is pending                                                                | adopted in Phase 1/2                                     |
| transport identity              | stdio command/args/env/cwd/environment/client capability; HTTP skipped because auth identity is unstable                     | adopted, plus workspace identity boundaries              |
| payload sanitization            | strip connection instructions and tool annotations before publish                                                            | adopted; cache plays no role in permissions              |
| concurrent publish              | entry-local generation; an older fetch cannot overwrite a newer snapshot                                                     | adopted                                                  |
| cold miss                       | tool listing waits for the live client; MCP is never silently hidden for speed                                               | aggregate complete-hit adopted                           |
| live execution                  | wait for the current client before the call, then re-resolve tool/visibility/annotations from live inventory before approval | adopted, adapted to ZCode's schema-validation order      |
| lifecycle                       | per-server startup future, startup cancellation, manager shutdown, stdio cleanup                                             | keep existing session ownership, add regressions         |
| status / auth / elicitation     | per-server startup update, auth state, ready wait, elicitation routing                                                       | not taken over by the catalog                            |
| connector-specific cache        | long-term cache use after failure, background reconnect, hard refresh — semantics differ from ordinary MCP                   | not generalized to ordinary MCP                          |
| required server                 | marking some servers required and blocking until ready                                                                       | no matching ZCode product semantics; not introduced here |
| resources / templates           | keep querying the live client; no ordinary tool-catalog cache                                                                | out of scope                                             |
| `tools/list_changed`            | the ordinary catalog cache has no full dynamic invalidation yet                                                              | Phase 3 may mark dirty on notification                   |

The core trade-off: build only the "startup advertisement fast path" — no connector-style long-term stale fallback, and the cache never grows into a second MCP runtime.

## Confirmed boundaries

1. Every session keeps its own `NodeMcpAdapter` and its own MCP servers/clients.
2. No live server LRU, idle eviction, or cross-session client sharing.
3. The cache stores only the tool catalog — never clients, transports, OAuth sessions, or process handles.
4. A cache hit does not mean the server is connected; the settings page still reflects only live control-plane status.
5. The cache only shortens the wait for provider tool declarations; session create/resume, conversation projection, desktop continuous, and mobile replayable semantics are unchanged.
6. A tool call must switch to the live descriptor before input validation and permission decisions.

## Impact brief

### Feature summary

| Item      | Content                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Goal      | on a warm catalog hit, the first provider request does not wait for this session's live MCP startup                  |
| Value     | new/resumed sessions get a faster first response while real MCP calls still use this session's live servers          |
| Boundary  | the catalog handles capability advertisement only; the live adapter owns connection, permission facts, and execution |
| Not doing | live MCP LRU, cross-session client/process sharing, HTTP/SSE catalog cache, long-term stale fallback                 |

### UI surface matrix

| Surface                     | UI change | Behavioral impact                                                                | Evidence/regression                |
| --------------------------- | --------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| Conversation first sampling | no        | on complete-hit, the provider request goes out early                             | core/bootstrap deterministic tests |
| MCP settings page           | no        | keeps showing control-plane live status; cache hit is not "connected"            | `MO01-MO03` + status unit tests    |
| MCP tool call / approval    | no        | waits for and resolves the live descriptor before permission                     | `Y01/Y02` + tool executor tests    |
| Subagent                    | no        | keeps borrowing the parent live snapshot; never inherits the advertisement cache | borrowed port tests                |
| Desktop / mobile remote     | no        | shares agent facts; continuous / replayable delivery unchanged                   | invariant regression               |

### Shared vs. divergent behavior

- Shared: all session runtimes use the same catalog lookup, sanitization, generation, and live preflight rules.
- Divergent: a warm complete-hit may sample first; cold/partial/unsupported misses keep waiting for live startup.
- Divergent: the control plane may seed the catalog only after an explicit successful live connect; status-only queries never seed.
- Divergent: a subagent consumes only the parent's live connected snapshot, never cached advertisements.
- Unchanged: desktop continuous and mobile replayable only deliver messages; they own no catalog or MCP runtime.

### State owners

| State                                           | Owner                                                               | Lifecycle                   |
| ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| sanitized tool catalog LRU                      | the `McpToolCatalogPort` implementation injected by agent/bootstrap | agent process               |
| live MCP client/process/status                  | each session's `McpPort` / `NodeMcpAdapter`                         | session                     |
| startup Promise / AbortController / coordinator | the `AgentRuntime` session runtime                                  | session                     |
| cached/live MCP `ToolEntry` set                 | the session `ToolRegistry`                                          | session                     |
| control-plane MCP status                        | control-plane adapter                                               | agent process control plane |

`AgentRuntime` owns only startup coordination; `SessionFacade.closeSessionResources()` keeps owning the actual `McpPort.close()` scheduling and process cleanup. The two owners must not merge into one async finally, or shutdown ordering becomes implicit again.

## Recommended first-version product semantics

The following are recommended defaults for v1; change this document first if they must change before implementation.

| Condition                                                                             | First provider tools                                 | Tool call                                                                       | Later model steps                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| all cacheable servers hit a fresh catalog, live startup pending                       | use the cached catalog immediately                   | wait on the same startup promise; validate and approve with the live descriptor | use the live catalog after startup success                         |
| a legal empty catalog exists in cache                                                 | use the empty MCP tool set immediately               | no callable MCP tool exists                                                     | use the live catalog after startup success                         |
| any enabled server cold-misses, is expired, or its transport does not support caching | wait for live startup                                | use the live descriptor                                                         | use the live catalog                                               |
| warm hit, then live startup succeeds                                                  | the in-flight request keeps cached contracts         | executes after live revalidation                                                | atomically swap to live contracts                                  |
| warm hit, then ordinary MCP startup fails                                             | the in-flight request may still contain cached tools | returns structured unavailable/startup failure                                  | no longer advertised; an execution-only tombstone serves old calls |
| warm hit, then startup cancelled by session shutdown                                  | the current waiter gets cancellation                 | not executed                                                                    | session closes                                                     |
| a cached tool was deleted or hidden by the live server                                | the model may produce an old tool call               | rejected as unavailable before permission                                       | the live catalog no longer contains the tool                       |
| cached schema differs from live schema                                                | the model may produce old-schema arguments           | re-validate with the live schema; errors return as recoverable tool results     | the live catalog replaces the old schema                           |

On a true cold miss, keep waiting for MCP. v1 does not adopt the more aggressive "silently omit MCP tools in round one, add them in round two", to avoid the model misjudging capability absence when the user explicitly asked for MCP.

## Overall architecture

```text
ZCode Protocol / Agent process
│
├─ McpToolCatalogPort                        process scoped
│    ├─ stdio identity A -> sanitized tools
│    ├─ stdio identity B -> sanitized tools
│    └─ LRU capacity=32, TTL=30m
│
├─ control-plane NodeMcpAdapter              live, settings mcp/list
│    └─ a successful tools/list may publish the catalog
│
├─ Session A NodeMcpAdapter                  live, session scoped
│    ├─ startup shared Promise
│    └─ a successful tools/list may publish the catalog
│
└─ Session B NodeMcpAdapter                  live, session scoped
     ├─ startup shared Promise
     └─ on a catalog hit, the provider does not wait for startup
```

The catalog port's in-memory implementation may live in the adapter layer, but not inside `NodeMcpAdapter`, and it must not extend the existing live `McpPort`. Bootstrap injects the lifecycle explicitly:

```text
bootstrap creates one McpToolCatalogPort
  -> inject the agent protocol control plane
  -> inject every createZCodeApp / session runtime

each session still creates its own NodeMcpAdapter
  -> existing connectConfiguredServers()
  -> existing listTools() / callTool() / close()
```

Module-level implicit singletons are forbidden. Tests, multiple agent instances in one process, and future runtime environments must be able to get independent caches through dependency injection.

## Initialization sequences

### Warm catalog hit

```text
session/runtime create
  -> catalogPort.context(scope) for each enabled server
       ├─ synchronously read the complete cached catalog
       └─ allocate a fetch generation ticket per cacheable server
  -> immediately call the existing mcpPort.connectConfiguredServers()
       └─ save the same Promise as the session shared startup
  -> register advertisement-only cached ToolEntry
  -> the provider request uses cached contracts

background startup completes
  -> connected server publishIfNewest()
  -> replace cached ToolEntry with live ToolEntry
  -> cached ToolEntry absent from live inventory becomes a provider-invisible tombstone
  -> invalidate the provider tool contract cache
```

### Cold catalog miss

```text
session/runtime create
  -> catalogPort lookup yields incomplete coverage
  -> immediately call the existing mcpPort.connectConfiguredServers()
       └─ save the same Promise as the session shared startup
  -> first-round sampling awaits live startup
  -> register live ToolEntry
  -> provider request
```

### New and resumed sessions

- New sessions and cold-resumed sessions follow the same lookup rules; "old session" alone is not a cache hit.
- A still-alive session whose runtime and live adapter survive keeps using its own live state and never re-enters the catalog fast path.
- Resuming a closed session creates a new live adapter; if a matching catalog still exists in the same agent process, warm sampling is allowed, but tool calls still wait on the new adapter.
- The catalog is never written into rollouts, task snapshots, or replayable events; after an agent process restart the ordinary catalog is a cold miss — also preventing the schema cache from being mistaken for persisted session permissions.

### Cached tool call

```text
provider returns a cached MCP tool call
  -> registry finds the advertisement-only cached ToolEntry
  -> resolveForExecution(signal)
       ├─ await the current session's shared startup Promise
       ├─ look up serverName + toolName in the current live adapter
       ├─ missing / invisible / current provider name changed -> structured unavailable
       └─ present -> build the live ToolEntry
  -> validate with the live input schema
  -> run PreToolUse / permission policy
  -> decide readOnly/destructive/risk from live annotations
  -> live callTool()
```

`resolveForExecution` must happen before initial input validation, the PreToolUse hook, and permission. Waiting for startup only inside the cached handler is unsafe: the executor already makes permission decisions from `ToolEntry.metadata` before the handler runs.

## Port and runtime interfaces

The existing `McpPort` is unchanged. It keeps expressing only the current session's live connection and execution capability:

```text
McpPort
  connectConfiguredServers / connectServer / disconnectServer
  status / listTools / callTool / close
```

A new, independently injectable `McpToolCatalogPort` expresses the cross-session read-only schema cache. The runtime synchronously obtains the lookup context and generation ticket before calling the existing `connectConfiguredServers()`:

```ts
type McpToolCatalogWorkspaceScope =
  | {
      kind: "local";
      workspaceIdentity?: string;
      workspacePath: string;
    }
  | {
      kind: "remote";
      workspaceIdentity?: string;
      workspacePath: string;
      remoteSessionId?: string;
    };

interface McpToolCatalogScope {
  workspace: McpToolCatalogWorkspaceScope;
  serverName: string;
  serverConfig: McpServerConfig;
  clientCapabilityFingerprint: string;
}

interface McpToolCatalogFetchTicket {
  generation: number;
}

interface McpToolCatalogContext {
  current():
    | { kind: "hit"; tools: McpCatalogToolDescriptor[] }
    | { kind: "miss"; reason: "absent" | "expired" | "dirty" | "oversize" };

  beginFetch(): McpToolCatalogFetchTicket;

  publishIfNewest(ticket: McpToolCatalogFetchTicket, tools: McpToolDescriptor[]): void;

  invalidate(): void;
}

interface McpToolCatalogPort {
  context(scope: McpToolCatalogScope): McpToolCatalogContext | undefined;
}
```

`context()` returns `undefined` for HTTP/SSE unsupported in v1, which makes aggregate coverage `incomplete`. Cache-identity normalization, sensitive-field digests, TTL, LRU, and generation are encapsulated in the port implementation; core runtime never assembles keys.

`McpCatalogToolDescriptor` should exclude at the type level fields that cannot be trusted cross-session, preventing misuse:

```ts
type McpCatalogToolDescriptor = Pick<
  McpToolDescriptor,
  "serverName" | "toolName" | "name" | "description" | "inputSchema" | "outputSchema"
>;
```

A legal empty array must be a cache hit; it must not share `undefined` with a cache miss.

`startMcpStartup()`'s coordination duties:

```text
1. obtain catalog contexts, read snapshots, allocate fetch tickets for enabled servers
2. unconditionally start the existing mcpPort.connectConfiguredServers() immediately
3. save and reuse one startup Promise
4. complete-hit: register advertisement entries first; cold/incomplete: first round awaits startup
5. startup success: publishIfNewest() per server, including a successful zero-tool catalog
6. reconcile this session's live registry; missing items become provider-invisible tombstones
7. startup failure/cancel: do not publish; stop advertising cached entries, keeping tombstones that old responses can still resolve
```

This split lets the catalog optimization be disabled or replaced alone, and keeps control-plane, subagents, and live adapters from having to understand warm/cold sampling semantics.

### Session startup coordinator

Today's `mcpInitialized` / `mcpToolsRegistered` booleans cannot distinguish "cached entries advertised" from "live entries settled". Implement with one session-scoped coordinator owning the Promise, catalog contexts, and registry names, so multiple turns, compactions, or tool calls never each assemble their own state:

```text
                         complete-hit
IDLE ── start ──> STARTING_CACHED ──────> provider sampling allowed
                    │   │
                    │   ├─ live snapshot settled ──> LIVE_SETTLED
                    │   └─ session close ──────────> CLOSED
                    │
                    └─ tool call ── wait same Promise ── live resolve

                         incomplete
IDLE ── start ──> STARTING_BLOCKED ─────> provider waits same Promise
                         │
                         ├─ live snapshot settled ──> LIVE_SETTLED
                         └─ session close ──────────> CLOSED
```

`LIVE_SETTLED` is per-server: connected servers use live entries; failed/disabled servers stop advertising the cached entries but keep execution-only tombstones. Aggregate throw and session cancellation must also produce terminal outcomes readable by preflight — never just swallow errors and leave a "registered" boolean.

## Tool registry and executor

### Advertisement entry

A cached descriptor can only produce a provider advertisement entry:

- Supplies name, description, input/output schema to `ToolRegistry.toContracts()`.
- Re-filtered by the current session's tool allowlist / denylist.
- Provides no annotations, risk, approval, or session instructions the permission system could trust.
- Carries `resolveForExecution`, resolving to the live `ToolEntry` at the execution boundary.
- Required permission/metadata fields on the existing `ToolEntry` use fixed conservative placeholders (high risk, needs approval), never derived from cache; the executor must assert a deferred entry was resolved first, and placeholders must never enter the real permission flow.

Suggested optional preflight on `ToolEntry`:

```ts
type ToolExecutionEntryResolution =
  | { kind: "ready"; entry: ToolEntry }
  | { kind: "unavailable"; message: string; recoverable: true }
  | { kind: "cancelled"; message: string };

interface ToolEntry {
  resolveForExecution?: (context: {
    input: unknown;
    signal?: AbortSignal;
  }) => Promise<ToolExecutionEntryResolution>;
}
```

`call-runner` runs preflight exactly once after registry lookup, before canonicalize / normalize / validation; `ready.entry` becomes the sole entry afterwards. `unavailable` yields a stable, recoverable MCP tool result; `cancelled` yields the existing cancellation result; neither enters hooks, permission, or handler, and both must publish the corresponding tool error event — a UI row must never be stuck forever in input streaming.

Preflight awaits the same session shared startup Promise while racing the tool caller signal and the session shutdown signal. The shared startup stays under the existing MCP connect / initialize / auth timeout configuration; if some transport currently has no bounded startup timeout, enabling it in Phase 2 requires adding the timeout first — a cached tool call must never wait unboundedly. A startup terminal failure maps to `unavailable`; a caller abort maps to the existing `ToolCancelled` plus a terminal tool event.

This startup wait does not count against the live tool handler's execution timeout — same semantics as a permission wait: only after preflight has the live entry, live schema validation, and permission does the existing handler's `executeWithTimeout` start. Log `mcp.tool.live_preflight.waitMs` separately to distinguish slow initialization from slow execution.

### Registry reconcile

Today's `registerMcpTools()` only overwrites same-named entries and never removes tools gone from the live inventory. The async catalog must explicitly manage the MCP tool names registered in this session:

```text
cached names = {A, B, C}
live names   = {A, C, D}

reconcile:
  replace A/C with live entries
  replace B with a provider-invisible unavailable tombstone
  register D
  invalidate the provider tool cache
```

An already-issued provider request owns its tool contract array and is not rewritten by later reconciles. So B cannot be unregistered immediately: when the old response arrives, registry lookup would produce an unrecoverable `ToolNotFound` before live preflight is ever reached.

v1 adds an advertisement flag on registry entries ("participates in `toContracts()`"). Tombstones leave later provider contracts but registry lookup still resolves old responses, stably returning recoverable unavailable. Because session MCP config does not hot-switch today, tombstones can live until session close; if a runtime refresh is introduced later, reclaim safely via provider contract generation/ref-count — never guess that old responses are done by unregistering immediately.

## Tool catalog cache

### Scope

v1 caches ordinary stdio MCP only.

HTTP/SSE is not cached yet because there is no stable, normalized resolved auth principal identity. Sharing by URL, headers, or server name alone could mix tool catalogs across different accounts, OAuth tokens, or permission scopes.

### Default capacity and TTL

- LRU capacity: 32 server catalog identities
- Per-entry sanitized JSON cap: 2 MiB
- Process cache total sanitized JSON budget: 16 MiB, evicted by weighted LRU
- TTL: 30 minutes
- Lifetime: in-process only, never on disk
- Snapshot: `tools + publishedAt`
- Entry: `nextFetchGeneration + lastAcceptedGeneration`

Beyond the entry-count cap, ZCode adds a byte budget so a few abnormally large schemas cannot create a new memory problem. A successfully fetched catalog exceeding the per-entry cap is marked `oversize`, clears that identity's old snapshot, and later runs take the cold path — never keep advertising an old value because "the new one does not fit".

Parameters stay internal injectable options for fake clocks and capacity tests; no user-facing config. A lookup hit may bump LRU recency, but the TTL counts from the last successful publish — repeated reads never extend it unboundedly.

### Identity

The identity must express "should this connection get the same tool schema". Minimum ingredients:

```text
local workspaceKey = workspaceIdentity?.trim() || workspacePath
remote workspaceKey = workspaceIdentity.trim() (required)
+ remoteSessionId (required for remote scope)
+ serverName
+ normalized stdio command
+ ordered args
+ explicit cwd / effective fallback cwd
+ effective environment digest
+ client capability fingerprint
+ tool catalog schema version
```

Requirements:

- `workspacePath` is for execution cwd only; isolation uses `workspaceKey`.
- Same path with different remote identity must miss.
- Local allows `workspaceIdentity` to default to the path; SSH/WSL/Docker without the required `workspaceIdentity` / `remoteSessionId` return unsupported/cold miss in v1 — never degrade to sharing by remote path alone.
- Env values only enter a process-salted cryptographic digest held by the cache instance, never a serializable raw key; they must never appear in logs, errors, or telemetry.
- The port computes a normalized fingerprint only from `serverConfig`; no raw config is kept in cache entries.
- Key logging may only output an opaque fingerprint and hit/miss reason.
- Client-capability or catalog payload schema changes must make old entries miss.
- Cwd resolution, base env, network env, and server env merging must reuse the live adapter's pure functions — never write a second "approximate key"; Windows env names normalize case-insensitively, paths use current-platform semantics.
- Session-specific browser broker, temp sockets, and temp tokens that reach the effective config must join the fingerprint; hence the built-in `node_repl` may not hit across sessions in v1 — an expected, safety-first result.

### Payload sanitization

Allowed in cache:

- server/tool stable identity
- model-visible name
- description
- input schema
- output schema

Forbidden to cache or to trust from cache:

- `annotations`
- readOnly / destructive / idempotent / openWorld inference
- permission / approval / risk level
- session-specific initialize instructions
- OAuth/auth availability
- runtime scope, sandbox, cwd execution state
- plugin/session provenance
- clients, transports, process handles

### Generation

Every live fetch obtains an entry-local generation ticket before actually connecting:

```text
ticket.generation <= lastAcceptedGeneration
  -> discard the publish

ticket.generation > lastAcceptedGeneration
  -> sanitize
  -> save snapshot
  -> update lastAcceptedGeneration
```

After LRU eviction, an in-flight fetch holding an old entry context may complete, but must not implicitly reinsert the evicted identity into the LRU. A new lookup creates a new entry governed by a new generation independently.

### Aggregate coverage

v1 uses complete-coverage semantics:

- `complete-hit` only when every enabled, cacheable server has a fresh entry.
- Any server miss, expiry, or unsupported transport makes the whole result `incomplete`; the first round waits for live startup.
- Disabled/untrusted servers need no cache entry and contribute no provider tools.

No progressive "some servers first, the rest later" tool sets, so the first-round model never sees incomplete capability.

## Failure, cancellation, and refresh

### Startup failure

- A failed result must not overwrite an existing successful catalog.
- After the failed session's startup turns terminal, cached tools must no longer be exposed to later model steps.
- An already-issued model request calling a cached tool gets unavailable/startup failure via live preflight.
- The registry does not immediately unregister advertised cached names; it switches them to provider-invisible tombstones that serve already-issued provider requests.
- A new session may again use the in-TTL catalog during its startup-pending window; if it also fails, it likewise stops exposing after terminal.

"Keep using the cache long-term after startup failure with background reconnect" is connector-specific semantics — not generalized to ordinary MCP in v1.

### Cancellation

```text
turn/tool waiter abort
  -> cancels only the current waiter
  -> does not cancel the session shared startup

AgentRuntime.beginShutdown()
  -> synchronously moves the startup coordinator to CLOSED
  -> abort the session-owned startup controller
  -> the completion handler checks CLOSED + generation; no publish / reconcile

SessionFacade.closeSessionResources()
  -> still owns calling mcpPort.close()
  -> runs the existing adapter / stdio process-tree cleanup
  -> does not publish cancelled fetches
```

Today's `callTool()` directly awaits `record.connecting` without being bound to this tool call's `AbortSignal`. The implementation needs a per-waiter abort race, but one waiter stopping must never cancel the session-held startup. `AgentRuntime.beginShutdown()` is the coordinator's synchronous close point, blocking late async completion write-backs; it does not take over adapter close ownership. Actual MCP process cleanup stays with `SessionFacade.closeSessionResources()`'s existing concurrent close chain, avoiding double or missed closes between runtime and facade.

To preserve the existing `McpPort` contract, the session-owned controller may first cancel the coordinator-exposed shared startup wrapper; the underlying raw connect promise is interrupted/cleaned by the concurrently following `mcpPort.close()`. Whether the raw promise later resolves or rejects, completion must check CLOSED first and never re-publish or mutate the registry.

### Config refresh

Session MCP config is still startup-time config; this design adds no runtime hot-switch.

If a refresh is added later:

- Publish only after a new generation succeeds.
- Already-issued model steps keep their own contracts.
- In-flight live tool calls are not interrupted by the new catalog.

### `tools/list_changed`

Phase 2 may defer full dynamic refresh behind a feature flag; Phase 3 closes the notification loop:

- Cache reads do not refresh `publishedAt`.
- Once the adapter recognizes `tools/list_changed`, it marks the entry dirty / invalidates it; the notification payload is never treated as a new catalog directly.
- If the adapter does not consume the notification yet, the risk note must state reliance on TTL + live revalidation — never claim the catalog is forever in sync with the server.

## Control plane and settings page

The process-scoped control-plane protocol handler may inject the same `McpToolCatalogPort`, so a successful settings-triggered `connect + tools/list` can pre-seed the schema for new sessions in Phase 3; live adapters themselves hold no cache.

Boundaries kept:

- `mcp/list` status still comes from the control-plane adapter's live status.
- A catalog hit is never projected as `connected` and never changes tool-count/status UI.
- Status-only requests neither connect nor publish a catalog.
- A connect replace publishes only when live tools were successfully obtained.
- OAuth pending, workspace epoch, config readiness, and sensitive-information isolation keep following `docs/mcp-oauth-client-auth.md`.

## Subagents

Today a subagent borrows the parent `McpPort` and consumes the parent's exact startup snapshot; the child owns no connection lifecycle.

v1 keeps that contract:

- The parent's main model may sample early with the cached catalog.
- When the model actually starts the `Agent` tool and the child needs MCP, the subagent bridge keeps waiting for the parent's live startup.
- The child receives only the exact, scope-filtered snapshot of currently live connected servers.
- The child may not use the parent's advertisement-only cached snapshot and may not publish/close the parent's catalog or connections.

If "children that don't use MCP also wait for parent startup" needs optimizing later, design scoped/profile-based server trimming separately — never treat cached metadata as child execution permission in this feature.

## Desktop, web, mobile, and remote boundaries

```text
desktop-continuous ─┐
                    ├─ shared Host / Agent session -> session MCP adapter
mobile replayable ──┘
```

- The cache exists only in the actual agent process.
- Mobile `/remote` keeps attaching to the desktop's existing Host/Agent; no independent MCP runtime or cache authority.
- Relay, desktop main, and renderer hold no tool-catalog business state.
- Desktop continuous and mobile replayable only affect how events reach the UI; provider tool-catalog and live-execution facts are unchanged.
- Remote workspace identity must be part of the cache key; never share by remote `workspacePath` alone.
- The current `ZCodeWorkspaceRef` has only `workspaceIdentity` / `workspaceKey` / `workspacePath` — no `remoteSessionId`. Phase 2 only uses the unified remote identity parser to decide "this is a remote workspace", never inferring or assembling a session id from the identity string; once deemed remote, the catalog context returns unsupported and the first round stays on the cold live path.
- Phase 3, to enable remote catalogs, must first thread the real `remoteSessionId` from the existing host/workspace session resolver into internal workspace/session context and the catalog scope, and key it together with `workspaceIdentity`. With either field missing, stay disabled — never share by path, and never sink that state into main/relay.

This design does not modify `getTaskSnapshot`, dynamic task events, owner lease, queue, or replay-gap recovery.

## Logging and metrics

Service-layer logs use `createServiceLogger(scope)`; agent/bootstrap keeps the existing logger. Never log env, headers, OAuth secrets, tokens, or full tool schemas.

Suggested events:

| Event                           | Level | Key fields                                             |
| ------------------------------- | ----- | ------------------------------------------------------ |
| `mcp.catalog.lookup`            | debug | fingerprint, hit/miss/expired/unsupported, serverCount |
| `mcp.catalog.published`         | debug | fingerprint, toolCount, generation                     |
| `mcp.catalog.publish_discarded` | debug | fingerprint, generation, lastAcceptedGeneration        |
| `mcp.startup.sampling_ready`    | info  | source=cache/live, waitMs, serverCount, toolCount      |
| `mcp.tool.live_preflight`       | debug | serverName, toolName, waitMs, outcome                  |
| `mcp.startup.failed`            | warn  | existing failure summary, no sensitive config          |

Suggested aggregate metrics:

- catalog complete-hit / incomplete / expired / unsupported ratios
- pre-provider MCP wait on warm hits
- pre-provider MCP wait on cold misses
- cached tool calls' wait for live startup
- live preflight unavailable / schema drift counts
- LRU entry count and eviction count

High-frequency tool-call detail stays debug; production lifecycle keeps only one sampling-ready per session plus exceptions.

## Phased implementation

### Phase 1: cache write-only

Goal: no provider-wait semantics change yet; validate identity, sanitization, and publish generation first.

Main changes:

- Add the `McpToolCatalogPort` contract and the adapter-layer in-memory implementation.
- Bootstrap creates the process-scoped port and injects it into every session runtime.
- Session runtimes publish after a successful `tools/list`; `NodeMcpAdapter` untouched.
- Add cache hit/miss/publish metrics; the runtime does not read the cache yet.
- Control-plane seeding stays off, avoiding coupling status and cache authority in the first stage.

Acceptance:

- No change to existing MCP runtime, permissions, settings page, or E2E behavior.
- Two concurrent sessions finishing out of order: the older generation never overwrites the newer snapshot.
- No sensitive config in logs.

### Phase 2: async provider catalog

Goal: for local workspaces, let a complete-hit's first provider request skip waiting for live MCP, with execution and lifecycle safety as the enablement gate.

Main changes:

- The runtime reads the catalog context before calling the existing `McpPort.connectConfiguredServers()` and saves the one shared startup Promise.
- The runtime registers cached advertisement entries.
- After startup completion, reconcile live entries; missing/failed items become provider-invisible tombstones.
- The executor gains a live `resolveForExecution` before permission.
- Tool waiters support independent AbortSignals without cancelling the shared startup.
- `AgentRuntime.beginShutdown()` synchronously closes the coordinator and aborts the session startup; the facade keeps `mcpPort.close()`.
- Local workspaces may read the cache; SSH/WSL/Docker-style remote workspaces return unsupported/cold miss until `remoteSessionId` is threaded end-to-end into the runtime.
- Subagents keep waiting for the parent's live startup, borrowing only the live connected snapshot; never read the advertisement cache.

Acceptance:

- A warm session's provider request arrives before the MCP barrier releases.
- A tool call keeps waiting before the barrier and, after release, calls this session's live process.
- Cached tool deletion, schema change, and destructive-annotation change are all adjudicated by live preflight.
- Reconcile after contracts were issued: stale tool calls still reach tombstone preflight, never `ToolNotFound`.
- Shutdown racing startup completion: no publish, no reconcile; existing process-tree cleanup still runs.
- Remote workspaces degrade safely to the cold live path; subagents stay live-only. Both are Phase 2 enablement gates, not deferred to the default-on stage.

### Phase 3: boundary completion and default-on

Goal: control-plane seeding, notifications, observability, and — once identity threading completes — optionally remote catalogs.

Main changes:

- Settings-page successful live connects seed the catalog.
- `tools/list_changed` dirty/invalidations.
- Optional: thread the real `remoteSessionId` into the runtime catalog scope, then enable SSH/WSL/Docker caching with representative no-cross-identity tests; until threading completes, keep Phase 2's remote-unsupported behavior.
- Confirm default-on from metrics; keep an internal cache mode for emergency rollback.

## Estimated code impact

| Rank           | Area                                                                              | Expected change                                                              |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| invariant-only | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`                    | existing live port interface unchanged                                       |
| must-inspect   | `apps/zcode-cli/packages/contracts/src/interfaces/`                               | new catalog port, scope, sanitized descriptor types                          |
| must-inspect   | `apps/zcode-cli/packages/adapters/src/mcp-tool-catalog/`                          | in-memory LRU, identity, TTL, generation, sanitization                       |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts`              | process-scoped cache owner                                                   |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`            | catalog port enters the protocol process context                             |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`       | local scope and remote classification; Phase 3 optional session id threading |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` | pass the same port to every workspace session app                            |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`                         | catalog port dependency injection into the session runtime                   |
| must-inspect   | `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`                     | keep actual MCP close ownership and cleanup                                  |
| must-inspect   | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`                       | shutdown synchronously closes coordinator, aborts startup                    |
| must-inspect   | `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts`                         | cached/live startup state and reconcile                                      |
| must-inspect   | `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`                   | warm/cold selection before sampling                                          |
| must-inspect   | `apps/zcode-cli/packages/core/src/mcp/index.ts`                                   | advertisement entry and live entry construction                              |
| must-inspect   | `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`                   | live preflight before permission; waiter abort                               |
| should-inspect | `apps/zcode-cli/packages/core/src/tool/registry.ts`                               | reconcile / provider-invisible tombstone                                     |
| should-inspect | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`                    | parent startup and borrowed snapshot                                         |
| should-inspect | `apps/zcode-cli/packages/core/src/subagent/borrowed-mcp-port.ts`                  | keep live-only, scope-filtered                                               |
| conditional    | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts`                     | control-plane successful results seed the cache                              |
| conditional    | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace.ts`               | Phase 3 threads the real remoteSessionId                                     |
| conditional    | `packages/shared/src/zcode-protocol/index.ts`                                     | strict schema if cross-process interfaces expand                             |
| invariant-only | `packages/ui/src/settings/McpSettingsSection.tsx`                                 | status UI never reads the catalog                                            |
| invariant-only | web remote / relay / desktop main                                                 | no new cache authority or runtime state                                      |

## Test plan

### Adapter unit

1. Miss, fresh hit, legal empty hit, TTL expiry, count/weighted-byte eviction.
2. Any change in server/config/cwd/env digest/workspace identity/client capability produces a miss.
3. Same path with different `workspaceIdentity` / `remoteSessionId` does not share.
4. Windows env-key casing and path resolution use Windows semantics; macOS/Linux are not mis-applied Windows rules.
5. HTTP/SSE returns unsupported, creating no ordinary catalog entry.
6. Annotations, timeout, session instructions, and sensitive fields never enter the payload.
7. Out-of-order generation completion: newest wins.
8. An in-flight entry evicted by LRU is not reinserted after completing.
9. Cache reads may update LRU recency but never extend the `publishedAt`-based TTL.
10. An oversize live catalog clears the old snapshot and takes the cold path, keeping no stale advertisement.

### Core runtime

1. Complete-hit: the provider request does not wait for startup.
2. Cold miss: the first round still waits, preserving current semantics.
3. Cached empty: sent immediately, no MCP tools exposed.
4. Startup success: the next model step uses the live descriptor.
5. Startup failure: later steps stop advertising cached tools; issued requests still get unavailable from tombstones.
6. Cached tool deleted live: unavailable before permission, never a registry `ToolNotFound`.
7. Cached safe / live destructive: live metadata used; correctly rejected by Plan mode or permission policy.
8. Cached schema v1 / live schema v2: validated with v2; the error enters the tool result and the session continues.
9. Allowlist/denylist re-applied to the cached catalog per session.
10. Multiple callers waiting on one startup Promise; no duplicate connects.
11. A caller abort cancels only its own startup waiter, not the session shared startup.
12. Caller abort produces a terminal `ToolCancelled` event; startup failure produces a recoverable unavailable event.
13. Preflight startup wait does not consume the live handler execution timeout and records its own waitMs.
14. `beginShutdown()` before startup completion: synchronously CLOSED; late completions neither publish nor reconcile.

### Bootstrap / integration

1. Session A initializes successfully and fills the catalog.
2. Session B uses its own MCP PID; the provider already received A's cached schema before B's initialize barrier released.
3. Session B's tool call waits for the barrier and then confirms calling B's PID, not A's.
4. Control-plane successful connects may seed later sessions; status-only does not.
5. Session close still cleans its own stdio process tree without affecting the process catalog.
6. Subagents wait for the parent's live startup and receive only the connected, scope-filtered snapshot.
7. Phase 2: local catalog hits; SSH/WSL/Docker always unsupported/cold, never sharing catalogs by path.
8. Phase 3: only after the real `remoteSessionId` is threaded, verify representative remote identities do not cross catalogs.
9. Adapter close, startup failure, and timeout keep running the existing cross-platform process-tree cleanup.
10. Shutdown racing completion: the facade still calls the actual `mcpPort.close()` exactly once; the coordinator never duplicates cleanup ownership.

### Existing regressions

- `mcp-runtime.test.ts`
- `mcp-tool-bridge.test.ts`
- `mcp.test.ts`
- `mcp-process-lifecycle.test.ts`
- `subagent-borrowed-mcp-port.test.ts`
- Plan mode MCP permission `Y01/Y02`
- MCP OAuth/status isolation `MO01-MO03`

v1 relies on adapter/core/bootstrap deterministic tests; no new GUI E2E required. If conversation E2E is added later, first write accepted cases back into `docs/conversation-session-case-catalog.md` and `docs/testing/conversation-session-e2e-coverage-matrix.md`, then enter manual-review/capture.

## State combinations and pruning

| Case ID | Status   | Representative combination                       | Expected                                                                 |
| ------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `MCA01` | accepted | warm complete-hit + startup pending              | provider samples immediately; tool call waits for live                   |
| `MCA02` | accepted | cold / expired / partial / unsupported           | first round waits for live; capability completeness kept                 |
| `MCA03` | accepted | legal cached empty                               | sample immediately; no MCP tools exposed                                 |
| `MCA04` | accepted | startup success / partial failure / cancellation | successful items publish + live reconcile; failure/cancel do not publish |
| `MCA05` | accepted | cached present + live missing/hidden             | tombstone returns recoverable unavailable before permission              |
| `MCA06` | accepted | cached schema / annotations differ from live     | live schema validation, live metadata approval                           |
| `MCA07` | accepted | concurrent generation + LRU eviction             | newest wins; an evicted old fetch never revives an entry                 |
| `MCA08` | accepted | control-plane connect / status-only              | Phase 3 seeds only on successful connect; status-only never seeds        |
| `MCA09` | accepted | parent / subagent                                | Phase 2 gate: child borrows only the live connected snapshot             |
| `MCA10` | accepted | local / SSH / WSL / Docker                       | Phase 2 remote cold; Phase 3 may hit only on full identity               |
| `MCA11` | ignored  | HTTP/SSE/OAuth catalog                           | v1 lacks a normalized auth principal identity                            |
| `MCA12` | ignored  | live server LRU / sharing                        | user confirmed not doing it                                              |
| `MCA13` | accepted | shutdown / late startup completion               | after CLOSED no publish/reconcile; the facade still completes close      |

Pruning notes:

- Desktop continuous vs mobile replayable: pruned to invariant + a representative regression set, since both share the agent runtime and this feature does not change delivery facts.
- Provider/model/thought, queue/goal/compact/fork/edit: pruned; MCP startup owner and execution authority unchanged.
- Theme/locale/responsive: pruned; no UI change.
- Individual MCP tools: pruned to four representative classes — safe, destructive, missing, schema-drift.

## Must-preserve invariants

1. Every session's live MCP clients/servers stay independent.
2. A cached tool catalog cannot authorize execution or influence readOnly/destructive/approval decisions.
3. Actual calls go only to the current session's live adapter.
4. A cache hit is never projected as UI connected.
5. Cache keys never leak env, headers, OAuth secrets, or tokens.
6. Local isolation uses `workspaceIdentity?.trim() || workspacePath`; remote requires both `workspaceIdentity` and `remoteSessionId`; `workspacePath` is for execution cwd only.
7. Mobile `/remote` creates no independent Agent, Host, or MCP runtime.
8. Desktop continuous and web remote replayable share no delivery state.
9. Subagents own no parent MCP lifecycle and gain no execution rights from the advertisement cache.
10. Session close, connect failure, and timeout keep running the existing cross-platform stdio process-tree cleanup.
11. Stale tools in already-issued provider contracts still reach recoverable preflight after reconcile — never premature `ToolNotFound`.
12. After the coordinator is CLOSED, no late startup completion may publish a catalog or mutate the registry.

## Risks and rollback

| Risk                                                        | Handling                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| model calls a stale tool                                    | live preflight; recoverable unavailable when absent                                            |
| stale schema generates wrong arguments                      | re-validate with the live schema; errors return to the model                                   |
| stale annotation causes wrong approval                      | annotations never cached; resolve the live entry before permission                             |
| old initialization overwrites new                           | entry generation newest-wins                                                                   |
| remote workspaces cross-share the cache                     | disabled in Phase 2; Phase 3 enables only with full identity + cwd/env                         |
| env/token leaks                                             | store digests only; logs record only opaque fingerprints                                       |
| dynamic descriptions go stale/leak across sessions          | limited to the same workspace identity; ephemeral config in the key; internal bypass available |
| unsafe HTTP sharing                                         | v1 never caches HTTP/SSE                                                                       |
| a few huge schemas inflate cache memory                     | 2 MiB/entry + 16 MiB/process byte guard; oversize clears old values                            |
| long-term advertising after a warm-hit server keeps failing | stops entering contracts after terminal; tombstone serves old responses only                   |
| reconcile turns old responses into ToolNotFound             | missing items keep provider-invisible tombstones until session close                           |
| late completion writes back after shutdown                  | beginShutdown synchronously CLOSED + abort; completion checks state/generation                 |
| regressions from the cache path                             | write-only shadow first, then enable reads; internal mode allows rollback                      |

## First-version default decisions

This plan adopts these defaults; if implementation review overturns any, update this document and the matching case first:

1. Cold/partial misses keep blocking the first provider request.
2. Only aggregate complete-hit may sample early; no progressive partial tool set.
3. In-process cache only: capacity 32, TTL 30 minutes, plus 2 MiB/entry and 16 MiB/process serialized byte guards.
4. HTTP/SSE entirely uncached until auth principal identity is designed separately.
5. No new user-visible startup state in v1 — only logs, metrics, and the existing live settings-page status.

## Planning handoff

| Deliverable               | Status            | Notes                                                                                                |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| Feature spec              | complete          | this document defines warm/cold, execution safety, ownership, remote, and rollback                   |
| Feature graph             | updated           | `capability.mcp-async-tool-catalog` and its cache/live/status/subagent/identity relations registered |
| Case catalog              | planned           | currently core/adapter/bootstrap tests; register `MCA*` first if GUI conversation E2E is needed      |
| Coverage matrix           | planned           | sync with the case catalog before manual-review/capture                                              |
| Fixture / replay / Docker | not-needed for v1 | deterministic fake MCP servers and barriers suffice                                                  |

No product-semantics blocker before implementation. Two items tracked separately, not blocking this plan:

- Not building a live LRU means this feature does not fix process/memory growth from unclosed sessions/runtimes.
- If ordinary MCP today consumes `tools/list_changed` insufficiently, v1 relies on TTL + per-execution live revalidation; notification invalidation lands in Phase 3.

## References

- `docs/mcp-platform-boundary.md`
- `docs/runtime-tools/mcp-status-list-control-plane.md`
- `docs/design/v2/mcp-stdio-process-lifecycle.md`
- `docs/mcp-oauth-client-auth.md`
- `docs/plugin-mcp-session-runtime-merge.md`
