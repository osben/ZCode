# Standalone Web task lists

## Confirmed boundary

The ordinary Web + Server app (`/`, connected to HTTP `/ws`) renders the shared
sidebar through `IWindowControllerService`. `RemoteServiceAccess` creates that
proxy, but `createLocalServices` does not register the channel. Existing tasks,
search, pinned and archived queries consequently cannot reach the server's task
index. The empty home-only mobile service is unrelated and remains unchanged.

## Ownership and interfaces

Reuse the existing Host Controller runtime through a Node-only public services
entry point. Desktop imports that public entry point and retains its existing behavior. The HTTP terminal
connection supplies one Controller runtime for its local task/agent services when
no Controller was provided by the caller. It owns and disposes that runtime with
the socket; `/ws/host` remains the trusted Desktop relay surface.

```text
Web sidebar -> shared query registry -> HTTP /ws Controller attachment
                                        |-> tasks-index: rows, membership, search
                                        |-> existing-only sessions-index: live activity
socket close --------------------------> dispose observers and subscriptions
```

The Controller remains the sole list projection owner. No renderer fallback,
second task store, new Agent or persistent schema is introduced. Identity remains
`workspaceIdentity?.trim() || workspacePath`; paths are transport/execution data.
The existing Controller owns source generations, refresh single-flight, filtering,
sorting, pagination, search snippets and membership. The renderer retains its
query serial and source-generation guards. Host observation remains passive and
existing-only. Browser conversation delivery stays `web-remote-replayable`;
Desktop retains `desktop-continuous`. Mobile relay and disconnected home-only
services do not change.

## Acceptance and regression scenarios

1. Start an isolated standalone server with existing regular, pinned and archived
   tasks. Through the actual WebSocket client, each list returns the matching
   persisted partition, total and pagination; created/updated sorting is retained.
2. Search an existing task's content through the Controller. Forward the complete
   workspace scope and search to the task service and retain snippets.
3. A pre-existing running session contributes activity to its persisted row;
   listing uses existing-only and never starts an Agent. Runtime disappearance
   removes live running proof.
4. Two scopes sharing a path but having different identities remain isolated.
5. Controller changes invalidate the shared renderer list registry. Unmounting
   one consumer retains other consumers' subscriptions; closing the socket
   releases its Controller and sessions observers without affecting another tab.
6. Interaction/E2E: in the standalone Web sidebar, load existing tasks, search,
   inspect pinned, change sorting and observe running -> completed. Repeat across
   a reload and two browser connections. Use deterministic isolated fixtures;
   never change the user's real tasks.
7. Retain existing Desktop Controller source-replacement/stale-refresh tests and
   renderer stale-query/subscription tests; the shared runtime is moved unchanged.

Automated RPC regression and shared runtime tests accompany the fix. Browser
interaction evidence and any execution limits must be reported separately.

## Browser replay

Use Node from `mise.toml`. From the repository root, create a temporary profile
and seed it before launching the ordinary Web + Server stack:

```sh
export ZCODE_DATA_BASE_DIR="$(mktemp -d /tmp/zcode-standalone.XXXXXX)"
pnpm exec tsx packages/web/test/e2e/seedStandaloneTasks.ts
pnpm dev:web
```

In another terminal, point at the Vite URL printed by `dev:web` (5173 by default;
Vite chooses another port when occupied), then run:

```sh
ego-browser nodejs < packages/web/test/e2e/manual-review/pending/standalone-task-list.mjs
```

For another port, prepend `globalThis.STANDALONE_WEB_E2E = { url:
"http://localhost:5174/" };` to the script input. Set `spaceId` in the same object
to resume an existing browser space. Ego's script process does not inherit custom
shell environment variables.

The fixture refuses the real user profile and uses no model credentials. The
browser replay covers actual sidebar lists, both time sorts, full-text search
with snippets, and archived filtering. Running activity and socket ownership are
deterministically covered at the real HTTP/WebSocket RPC boundary by
`packages/server/test/standaloneWebTaskList.test.ts`; this does not claim a live
model run in the browser.
