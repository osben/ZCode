# v4 multi-pane cross-workspace workbench (split phase 2)

Status: **all entries retired (2026-10-16)**. The two entries, dragging a Task-list item to the
conversation edge to create a split and the sidebar item "Open in split", were removed together with
the Side Pane full view (`docs/ui/side-pane-full-view.md`); the pane chrome "split right / split down"
buttons have been hidden since 2026-07-13. Existing split layouts and workbench groups are still
rendered, focused and closed as described here, with no migration. Dragging a Task-list item onto a
project to move the task is unaffected.

## Goals

Upgrade M5(5)'s "same-workspace 1+1 left-right split" to an "N-pane workbench":

- The layout goes from the single-value `splitPane` to a **binary split tree** (VS Code editor groups
  model): any pane can split right/down, and nesting gives a 2x2 grid. The leaf limit is
  `MAX_WORKBENCH_PANES = 4` (matching the 06-ui performance baseline "4 panes streaming at once without
  dropped frames"; also a soft cap on CLI child processes in the host).
- A pane binding becomes `(workspaceScope, sessionId)`: a pane carries its own workspace ownership,
  **no longer restricted to the same workspace**; local and remote (SSH/WSL/Docker) workspaces combine freely.
- The connection layer adds `workspaceConnectionRegistry`: it reuses `transport + SessionDataLayer`
  by `endpointKey + workspaceKey` with reference counting (isomorphic to `sessionsIndexRegistry`, plus a 30 s keep-warm).
- The primary pane (`workspace-main`) stays shell-driven (bound to `activeTaskId`, follows workspace
  tab switches); the other panes are owned by `paneLayoutStore` and **stay resident across tabs**;
  tabStore and its ~46 `activeTabId` consumers need zero change.

## Connection topology

```text
window renderer                          host / remote host                CLI process
  pane(A/s1) ─┐
  pane(A/s2) ─┼─ workspaceConnectionRegistry
  pane(B/s3) ─┘   Map<endpointKey+workspaceKey,
  pane(R/s4) ─┐       { transport, SessionDataLayer, refCount, keepWarm }>
              │        │
              │        ├─ local scope ──→ base services.zcodeAgentService ──→ base local host
              │        │                   └─ processesByWorkspaceKey ┬─→ agent(A)  conversation/s1,s2
              │        │                      (one CLI per workspace) └─→ agent(B)  conversation/s3
              │        └─ remote scope ──→ sessionsById[remoteSessionId].services ──→ remote host ──→ agent(R)  conversation/s4
              └─ remote connection absent → disconnected proxy (rejects) → pane enters error/waiting-for-connection, no separate runtime
```

Points:

- The conversation topic contains only the sessionId (`conversationTopic`); workspace isolation relies
  on the host bucketing by workspaceKey into separate CLI processes plus downstream frames filtered by
  the workspaceKey emitter, so the protocol surface supports concurrently subscribing to N workspaces
  in one window with **zero schema change**.
- Multiple panes with the same workspaceKey + endpointKey share one transport + one SessionDataLayer
  (multiple panes of the same session converge to a single subscription through the layer refCount,
  triggering no CLI `(connectionId, topic)` resubscribe replacement).
- A remote pane's services reuse `remoteWorkspaceSessionStore.sessionsById` (the existing multi-connection
  Map). When the remote connection drops, `useWorkspaceServices` gives a disconnected proxy (all RPCs
  reject), the subscription failure lands in the projection store's error state, and the pane shows a
  reconnect/waiting placeholder. **Never** start a separate SSH/runtime for a pane (remote-control protection constraint).

## Layout layer: binary split tree (paneLayoutStore v2)

```text
LayoutNode = Leaf { paneId }
           | Split { id, direction: "row"|"column", ratio, first, second }

ratio = share of first, clamp [0.25, 0.75] (phase-1 splitRatio semantics, one per Split node)

single pane:      leaf(main)
left-right split: split(row){ leaf(main), leaf(pane-1) }
2x2 grid:         split(row){ split(col){ leaf(main), leaf(pane-2) },
                              split(col){ leaf(pane-1), leaf(pane-3) } }
```

- State: `{ root: LayoutNode, panes: Record<paneId, PaneBinding>, focusedPaneId }`. The primary pane
  (`workspace-main`) is a reserved leaf, **not in `panes`**, and its binding follows shell props (activeTaskId).
- `PaneBinding = { workspaceScope, sessionId | null, restoredUnvalidated? }`;
  `workspaceScope = { workspacePath, workspaceIdentity?, remoteSessionId? }`.
- **`workspaceScope` semantics = the primary workspace the session belongs to, and is the connection
  routing key**; it is not "all paths the session can reach" (see cross-workspace session compatibility below).
- The workspaceKey convention is uniformly `workspaceIdentity?.trim() || workspacePath` (Workspace Identity constraint).
- Transition functions are all pure and return the original reference on no-op: `splitPaneAt` (no-op
  when the leaf count is at the limit), `closePane` (primary cannot be closed; the parent Split
  collapses into the sibling node), `bindPaneSession`, `setSplitNodeRatio`, `focusPane`,
  `confirmRestoredPaneSession`.
- Focus layer unchanged: `focusedPaneId` is a single value; when the focused pane is not in the tree it
  degrades to primary. Global shortcuts (Esc stop, add-to-chat) route to the focused pane (06-ui split rule 4).
- Phase 1's rule "do not render when the split belongs to another workspace" is **removed**: a pane
  carries its own workspace and always renders, resident across tabs.

### Persistence v2 and migration

- Key `zcode-v4-pane-layout:v2`: the whole tree + `panes` bindings (scope + sessionId) + `focusedPaneId`.
  `restoredUnvalidated` is not persisted and is added on restore for a non-empty sessionId.
- v1 (`zcode-v4-pane-layout:v1`, single-value splitPane) is read compatibly: v1 stored only
  `workspaceKey`, and only when it is a trusted local path (`/...` or `X:\...`) is it migrated to
  `split(row){ main, split }` (scope.workspacePath = workspaceKey); otherwise it is dropped back to a
  single pane. Corrupt data is dropped wholesale back to the initial layout (phase-1 sanitize
  philosophy, no partial rescue).

## Connection layer: workspaceConnectionRegistry

- A module-level registry (isomorphic to `sessionsIndexRegistry`): key = `endpointKey(remoteSessionId ?? "__base__") + workspaceKey`.
- `acquireWorkspaceConnection(scope, agentService)` → `{ layer, transport, release }`; the first
  reference creates `createAgentConversationTransport + SessionDataLayer`, and once refCount reaches
  zero it waits a **30 s keep-warm** before dispose (guards against pane close/open and layout-drag jitter).
- The entry remembers the `agentService` reference that created it: when the same key is acquired again
  and the service reference changed (remote disconnect→reconnect swaps in new services), the old entry
  is invalidated and removed from the registry at once (existing leases hold until release) and a new
  entry is rebuilt with the new service; reconnect recovery needs no manual refresh.
- Services resolution belongs to the React layer (`useWorkspaceServices(path, remoteSessionId, identity)`
  inside `V4PaneConversationProvider`): a disconnected remote target gets a disconnected proxy and a
  subscription failure becomes a pane error state + retry button; it **does not fall back to base
  services** (so a remote task is never queried by the local host).

## Per-pane Provider

- `V4PaneConversationProvider({ scope, isShellWorkspace, children })`: wraps per pane.
  - `isShellWorkspace = pane scope's workspaceKey === the shell's current workspace`: when true, use the
    context services directly (byte-for-byte identical to phase 1, and the web wide-screen remote shell
    also takes this path); otherwise resolve by scope through `useWorkspaceServices` (a cross-workspace
    pane can only be created from the desktop entry).
  - An inner `ServiceProvider services={paneServices}`: hooks in the pane subtree (attachment upload,
    sessions-index guard, etc.) use the pane's own accessor.
  - The context shape is unchanged (`{ layer, sendCommand, attachmentPut }`); `SessionPane` is unaware.
- Mobile `/remote`'s `V4ChatPane` (single pane, no split) keeps the original `V4ConversationProvider`
  (built directly per workspace); the remote replayable chain is untouched.

## Restore guard (generalized per pane)

```text
Restore sequence (each restoredUnvalidated pane independently):

localStorage ─→ paneLayoutStore (v2 restore, add restoredUnvalidated)
                    │
V4PaneWorkbench ────┼─→ pane renders (renders first, not blocked)
                    └─→ PaneRestoredGuard(pane scope)
                          acquireSessionsIndex({ workspaceKey, endpointKey: remoteSessionId })
                          wait for the first real snapshot (workspaceId !== null)
                            ├─ session present → confirmRestoredPaneSession(paneId)
                            ├─ session deleted → closePane(paneId)
                            └─ subscription failed / remote endpoint absent → no verdict, pane stays
                               in error/waiting-for-connection state (the pane's own retry handles it, no wrongful close)
```

Contract with the data layer: **a session appears, and only appears, in its primary workspace's
sessions-index**; the guard is complete when it looks up by the pane's primary workspace scope (still
true once cross-workspace sessions land).

## Entries

- Drag, the sidebar item "Open in split" and ordinary session click all enter `workbenchSessionPlacement`:
  a pure resolver decides the current guard, focus existing, split draft, create/extend group or replace
  focused pane, and the executor then commits in the order "pane/group owner updates first, shell active syncs after".
  Drag accepts only an actual split decision and passes the hit side/anchor; right-click defaults to
  right and allows focus existing; ordinary click uses a selection intent. A task item carries the full
  workspacePath/workspaceIdentity/remoteSessionId, and cross-workspace equality uses workspaceKey. The
  entry gate `V4SplitPaneEntryProvider` (desktop shell and not remote-controlled) is unchanged.
- Pane chrome (ruling 2026-07-08): no more horizontal header strip that takes layout height. The split
  entries "split right / split down" (draft, bound to the current pane's workspaceScope) and "close
  pane" (primary has no close) go into a floating action group at the pane's top right, so they do not
  take the first line of conversation content. For a non-primary pane whose workspace differs from the
  shell's current workspace, the workspace name badge goes into the left of the same floating group
  (plus a host marker for remote). The badge is display only; the future cross-workspace session
  "A +2" multi-path badge extends here.
- **Temporarily retired (2026-07-13)**: the conversation-area pane chrome does not show the "split
  right / split down" buttons; the underlying binary layout, split callback interface, close pane,
  workspace badge and the sidebar "Open in split" entry are kept, so restoring chrome entries later
  needs no state or protocol migration.

## Compatibility with "cross-workspace session" (future input, reserved this phase)

A future cross-workspace session = one primary workspace + several auxiliary paths (extra directories
the agent can operate on), primary and auxiliary on the same endpoint, with the relation recorded in
the data layer. Four points are fixed this phase:

1. `PaneBinding.workspaceScope` semantics are fixed as the **primary workspace** (connection routing
   key); auxiliary paths are a session property (delivered through projection/sessions-index) and do
   not enter the layout layer, so `paneLayoutStore` needs zero schema change then.
2. The connection registry routes by primary workspace (a cross-workspace session is still one agent,
   one connection); no API hook for "multi-workspace connection aggregation" is left.
3. workspaceKey equality is used only for ownership/isolation, never to derive "path capability"; the
   UI presentation of auxiliary paths is a pure display increment.
4. The same-endpoint constraint for primary/auxiliary is guaranteed by the creation entry; the pane
   workbench assumes no cross-endpoint aggregation.

Protocol extension path (additive then, existing fields unchanged): `createSession` payload gets
`auxiliaryPaths?`; sessions-index items expose the primary/auxiliary relation.

## Protocol notes (conclusions this phase)

- **Zero schema change.** Implementation gap already filled: the CLI `v4-bridge.createSessionRecord`
  `workspaceId` was upgraded from "always treated as a local workspacePath" to being resolved through the
  remote identity counterpart (the `buildRemoteWorkspaceIdentity` family, never hand-concatenated), a
  prerequisite for the first send of a draft in a remote pane creating the session.
- The `visibility: foreground/background` subscription field is reserved by the protocol and unconsumed
  by the CLI; if 4 panes streaming at once drops frames when measured, add CLI flush tiering by
  visibility (additive).
- conversation subscribe has no `subscriberScope` (the host process-level single connectionId + one
  subscription per topic already converges); add it by reference to sessions-index only if "multiple
  independent subscription consumers of the same session" appear in the future.

## Implementation change list (in landing order)

| #   | Touchpoint                                                                                                           | Change                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/ui/src/v4/paneLayoutStore.ts`                                                                              | Rewrite as v2: binary split tree + `panes: Record<paneId, PaneBinding>` + persistence v2 (`zcode-v4-pane-layout:v2`) and v1 migration; delete the `splitPaneForWorkspace` visibility rule. A new pane id is the largest `pane-<n>` in the tree plus 1 (v1 migration keeps the `split` id) |
| 2   | `packages/ui/test/v4PaneLayoutStore.test.ts`                                                                         | Rewrite unit tests: tree ops / limit / collapse / v1 migration / focus degradation / persistence round trip                                                                                                                                                                               |
| 3   | `packages/ui/src/v4/workspaceConnectionRegistry.ts` (new)                                                            | Ref counting + 30 s keep-warm + agentService generation invalidation; pattern after `sessionsIndexRegistry.ts`                                                                                                                                                                            |
| 4   | `packages/ui/src/v4/V4ConversationContext.tsx`                                                                       | Add `V4PaneConversationProvider` (registry lease + pane-level `ServiceProvider` wrapper + `isShellWorkspace` using context services); keep the original `V4ConversationProvider` for mobile `V4ChatPane`                                                                                  |
| 5   | `packages/ui/src/v4/V4WorkspaceChatArea.tsx`                                                                         | Rewrite as recursive split-tree rendering; generalize `SplitPaneDivider` (direction-aware + per-node CSS variable `--v4-split-<nodeId>`, dragging still rAF direct write with zero render); componentize the per-pane restore guard (`PaneRestoredGuard`)                                 |
| 6   | `packages/ui/src/v4/SessionPane.tsx`                                                                                 | Esc-stop and add-to-chat listeners change from "primary only" to "focused pane" (06-ui split rule 4); add split/close/badge props pass-through                                                                                                                                            |
| 7   | `packages/ui/src/v4/ConversationHeader.tsx`                                                                          | "Split/close split" becomes "split right/split down/close pane" + workspace badge (shown when non-primary and different from the shell's current workspace, plus a host marker for remote); copy goes into both i18n languages                                                            |
| 8   | `packages/ui/src/v4/workbenchSessionPlacement.ts` / `V4WorkspaceChatArea.tsx` / `app-shell/WorkspaceShellLayout.tsx` | Drag, right-click split and ordinary click share the placement resolver/executor; entries supply only intent, side, anchor and the full workspace scope; disabled when the leaf count is at the limit and the target has no existing ownership                                            |
| 9   | subagent child detail                                                                                                | Already migrated to the workspace right tabs and no longer enters the split-pane workbench; ordinary session "Open in split" is unchanged                                                                                                                                                 |
| 10  | `packages/ui/src/v4/index.ts`                                                                                        | Export surface update (new/old transition functions/types swapped)                                                                                                                                                                                                                        |
| 11  | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`                                                  | `createSessionRecord`'s `workspaceId` resolved through the remote identity counterpart (the `buildRemoteWorkspaceIdentity` family), with unit tests, a prerequisite for the first send of a remote-pane draft creating the session                                                        |
| 12  | three historical `conversation-session-v4-split*.test.ts`                                                            | Deleted on 2026-07-13 when the explicit buttons were retired; regression coverage of the Task-list drag entry still needs maintaining                                                                                                                                                     |

Untouched: `tabStore` (and its ~46 `activeTabId` consumers), `splitPaneEntryContext` gate semantics,
mobile `/remote`'s `V4ChatPane` chain, the `zcode-protocol-v4` schema, the host/services layer
(`processesByWorkspaceKey` bucketing is already in place).

Verified key facts (can be relied on during implementation):

- Host-side `conversationFrameEmitters` / `processesByWorkspaceKey` are both bucketed by workspaceKey,
  with no single-value assumption for concurrent subscription to N workspaces in one window;
- `remoteWorkspaceSessionStore` already has the `sessionsById` multi-connection Map and
  `resolveRegisteredWorkspaceServices`, but a disconnected remote target **must** take the
  `useWorkspaceServices` disconnected-proxy path and must not fall back to base services;
- `sessionsIndexRegistry` already isolates by `endpointKey + workspaceKey`, so the per-pane restore guard can reuse it directly;
- Existing e2e contracts: `v4-pane-shell-<paneId>` (`data-pane-id`/`data-focused`), `v4-session-pane-<paneId>`,
  `TID_V4_SPLIT_OPEN/CLOSE/DIVIDER`, sidebar `TID_V4_TASK_OPEN_IN_SPLIT`, the localStorage key (v1→v2
  requires syncing the helper constants).

## Verification baseline

- Unit tests: paneLayoutStore v2 state machine (tree ops / limit / collapse / v1 migration / focus degradation / persistence round trip), workspaceConnectionRegistry (count / keep-warm / service generation / reuse).
- E2E (testid contract): `TID_V4_PANE_SHELL`/`TID_V4_SESSION_PANE` dynamic paneId suffix unchanged; the divider `TID_V4_SPLIT_DIVIDER` carries data-split-id; the main flow (open split → draft first-send binding → drag wider → refresh restore → close) reuses the existing three split e2e.
- Performance baseline (06-ui): 4 panes streaming at once without interaction frame drops.
- Verification still to add: real-machine SSH regression for remote panes (disconnect placeholder / reconnect recovery / remote draft session creation).
