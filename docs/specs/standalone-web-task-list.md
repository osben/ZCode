# Standalone Web task lists

## Confirmed boundary

The ordinary Web + Server app (`/`, connected to HTTP `/ws`) renders the shared sidebar through `IWindowControllerService`. `RemoteServiceAccess` creates that proxy, but `createLocalServices` did not register the channel, so existing tasks, search, pinned and archived queries could not reach the server's task index. The empty home-only mobile service is unrelated and unchanged.

## Ownership and interfaces

The existing Host Controller runtime is reused through a Node-only public services entry point; Desktop imports that entry point and keeps its behavior. The HTTP terminal connection supplies one Controller runtime for its local task/agent services when the caller provided none, owns it and disposes it with the socket. `/ws/host` remains the trusted Desktop relay surface.

```text
Web sidebar -> shared query registry -> HTTP /ws Controller attachment
                                        |-> tasks-index: rows, membership, search
                                        |-> existing-only sessions-index: live activity
socket close --------------------------> dispose observers and subscriptions
```

1. The Controller is the sole list projection owner: it owns source generations, refresh single-flight, filtering, sorting, pagination, search snippets and membership. No renderer fallback, second task store, new Agent or persistent schema.
2. Identity is `workspaceIdentity?.trim() || workspacePath`; paths are transport/execution data.
3. The renderer keeps its query serial and source-generation guards. Host observation stays passive and existing-only.
4. Browser conversation delivery stays `web-remote-replayable`; Desktop keeps `desktop-continuous`. Mobile relay and disconnected home-only services are unchanged.

## Review hardening

HTTP authentication protects the WebSocket upgrade. `hello` / `clientHello` negotiates terminal protocol capabilities, not workspace authorization; the task service already exposes the authenticated server's workspace index before that handshake. Passive Controller metadata reads stay independent of terminal startup.

```text
authenticated /ws socket
  -> browser terminal facade: hello/clientHello, replayable conversation
  -> private Controller facade: unique socket route, passive metadata only
       -> bounded tasks-index reads + independent sessions-index startup
close -> terminal fence -> dispose observers and both facades
       -> pending callbacks/ACKs cannot re-register ownership
```

1. The Controller uses its own server-created Agent connection facade with a unique connection ID, not the raw Agent or the browser's terminal route. The facade is never exposed as an RPC channel; it preserves `existing-only` and owns its subscriptions and frame routing until socket close.
2. Each standalone socket accepts at most 64 distinct source identities over its lifetime and runs at most four source reads concurrently. An oversized request (including one exceeding the remaining lifetime allowance) is rejected before any observer is registered. Duplicate identities use no extra slot. Desktop has no new source limit.
3. A pending Agent subscribe never blocks persisted task rows; activity arrives through later Controller frames.
4. First-read errors reject when no selected source has a trusted snapshot; an existing successful snapshot (including remote replacement history) stays available on a later refresh failure.
5. A disposed runtime rejects new operations and pending event callbacks cannot revive it.
6. The public runtime export has an explicit Node condition and no browser/default target; tests cover browser rejection and Node resolution.

Regression scenarios written before implementation: two sockets receive distinct trusted Agent routes; closing one keeps the other's frames current; an event queued behind a deferred read cannot reattach after close; an unresolved subscribe does not delay persisted rows; failed cold reads reject and recover on retry; excess cumulative scopes perform no source IO; queued reads never exceed four.

## Acceptance and regression scenarios

1. Start an isolated standalone server with existing regular, pinned and archived tasks. Through the actual WebSocket client each list returns the matching persisted partition, total and pagination; created/updated sorting is retained.
2. Searching an existing task's content through the Controller forwards the complete workspace scope and search to the task service and retains snippets.
3. A pre-existing running session contributes activity to its persisted row; listing uses existing-only and never starts an Agent. Runtime disappearance removes live running proof.
4. Two scopes sharing a path but with different identities stay isolated.
5. Controller changes invalidate the shared renderer list registry. Unmounting one consumer keeps other consumers' subscriptions; closing the socket releases its Controller and sessions observers without affecting another tab.
6. Interaction/E2E: in the standalone Web sidebar, load existing tasks, search, inspect pinned, change sorting and observe running -> completed; repeat across a reload and two browser connections. Use deterministic isolated fixtures and never change the user's real tasks.
7. Existing Desktop Controller source-replacement/stale-refresh tests and renderer stale-query/subscription tests are retained; the shared runtime is moved unchanged.

Automated RPC regression and shared runtime tests accompany the fix. Browser interaction evidence and execution limits are reported separately.

## Browser replay

Use Node from `mise.toml`. From the repository root, create a temporary profile and seed it before launching the ordinary Web + Server stack:

```sh
export ZCODE_DATA_BASE_DIR="$(mktemp -d /tmp/zcode-standalone.XXXXXX)"
pnpm exec tsx packages/web/test/e2e/seedStandaloneTasks.ts
pnpm dev:web
```

In another terminal, point at the Vite URL printed by `dev:web` (5173 by default; Vite picks another port when occupied), then run:

```sh
ego-browser nodejs < packages/web/test/e2e/manual-review/pending/standalone-task-list.mjs
```

For another port, prepend `globalThis.STANDALONE_WEB_E2E = { url: "http://localhost:5174/" };` to the script input; set `spaceId` in the same object to resume an existing browser space. Ego's script process does not inherit custom shell environment variables.

The fixture refuses the real user profile and uses no model credentials. The replay covers actual sidebar lists, both time sorts, full-text search with snippets and archived filtering. Running activity and socket ownership are covered deterministically at the real HTTP/WebSocket RPC boundary by `packages/server/test/standaloneWebTaskList.test.ts`; no live model run in the browser is claimed.
