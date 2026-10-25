# `#` Cross-Workspace Session Mention

## Feature Summary

| Field                 | Value                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | The composer `#` panel aggregates all opened or restored workspaces under the current session-storage authority and limits visible candidates to 20 per workspace |
| Change layer          | `option-source + presentation`                                                                                                                                    |
| User-visible surfaces | The `#` sessions panel of `MentionPlugin`                                                                                                                         |
| Existing docs         | `docs/ui/mention-panel-layout.md`, `docs/session-context-tool.md`                                                                                                 |
| Existing code owners  | `sessionsMentionProvider`, `useWorkspaceSessionsIndexItems`, Tab Store, remote workspace service resolver                                                         |
| Out of scope          | `@` session candidate scope, rewriting the canonical mention, moving sessions across Hosts, Agent/protocol changes, stream/queue/snapshot/replayable semantics    |

## Product boundary

The user asked that `#` can select sessions in all workspaces. "All workspaces" means the workspaces that are
opened or startup-restored in the current window's task area and share the same session-storage authority as
the current composer:

- `@` also reuses the session provider in the current code but is not the entry of this feature; it keeps
  querying only the current workspace.
- `#` shows at most 20 candidates per workspace. With an empty query it takes the 20 most recently updated of
  that workspace; with a query it first matches across the full history, then takes the first 20 matches per
  `workspaceKey`, so older sessions stay searchable.
- The cap constrains only the renderer candidate result; the sessions-index subscription, snapshot and
  persistence protocol are unchanged.

- A local composer can select sessions of all local workspaces under the current window-scoped Local Host.
  Multiple local Agent processes share one SQLite session DB, so `ReadSessionContext` can read a selected
  session by id.
- A remote composer can select sessions of multiple workspaces under the same `remoteSessionId` / Agent
  service authority.
- A local and a remote Host, or two different remote Hosts, do not share a session DB. Sessions of another
  authority are not shown, to avoid references that can be selected but make `ReadSessionContext` return
  `not_found`.
- A disconnected remote workspace does not fall back to the local service; it re-enters the candidates only
  after the remote attachment is restored.
- Closed workspaces that are not restored in the current window are not candidates; no global persistent
  workspace catalog is added.

```text
Composer trigger
        |
        +-- @ ----------------------------> current workspace sessions-index (original behavior)
        |
        +-- #
             |
             v
current composer workspace
        |
        v
resolve conversation storage authority
        |
        +-- Local Host / base service
        |      └-- sessions-index of all local workspaces in the current window
        |
        +-- Remote Host / remoteSessionId
               └-- sessions-index of all workspaces under the same remote authority

other Host / unconnected remote
        └-- pruned: not shown, no fallback to the base service

aggregated result
  -> dedupe scope by workspaceKey = workspaceIdentity?.trim() || workspacePath
  -> dedupe by session id
  -> current workspace first
  -> rest by most recent update
  -> match the query over the full set
  -> keep at most 20 per workspaceKey
  -> still insert [#Title](#sess_id)
```

## Shared implementation and differing behavior

- `@` and `#` keep sharing one `useSessionsMentionProvider`; the trigger passes the workspace scope policy
  explicitly: `@` uses `current-workspace`, `#` uses `same-authority-workspaces`. The provider must not widen
  unconditionally.
- `useWorkspaceSessionsIndexItems` keeps reusing subscriptions by `endpointKey + workspaceKey` reference
  count; when the panel closes it releases this consumer's reference without affecting the sidebar's existing
  subscription.
- Candidate rows keep showing the last workspace name in `description`; no new layout, color or font size.
- Current workspace candidates sort before other workspaces; inside each group the order stays by most recent
  activity.
- The `#` cap of 20 is counted per `workspaceKey` after query matching; a global `slice(0, 20)` of the merged
  result is wrong because the current workspace would crowd out the others. `@` does not apply the cap and
  keeps the existing current-workspace behavior.
- The canonical mention, history parsing and `ReadSessionContext` tool input keep only the session id; no
  workspace field is added.

## State Owners

| State / fact                | Authority                                          | Mirrors / caches        | Evidence                                           |
| --------------------------- | -------------------------------------------------- | ----------------------- | -------------------------------------------------- |
| Workspace set of the window | window-scoped Tab Store                            | tab persistence restore | workspace tabs in hook test                        |
| remote workspace -> service | `remoteSessionId` + remote workspace session store | identity/path lookup    | mock service call counts per endpoint              |
| Session candidate facts     | sessions-index of each Host                        | shared registry store   | snapshot/delta aggregation result                  |
| session context content     | SQLite session store of the current Agent Host     | no cross-Host mirror    | `ReadSessionContext` docs and store implementation |
| workspace isolation key     | `workspaceIdentity?.trim() \|\| workspacePath`     | scope/registry key      | same path, different identity focused case         |

## Boundary Decisions

- **Workspace set:** workspace tabs opened or restored in the current window (local tabs, connected remote
  tabs); closed, unrestored workspaces are excluded.
- **Host authority:** only the same Agent service/session store (local-local, same remote endpoint); never
  local-remote or different remote endpoints.
- **Ordering:** current workspace first, the rest by recent update; no global relevance re-ranking.
- **Display budget:** `#` shows at most 20 per workspace (empty query: recent 20; with query: first 20 matches),
  never a global 20 and never truncating before search (confirmed by the user 2026-08-05).
- **Canonical:** `[#Title](#sess_id)` unchanged for `#` and `@`; no workspace/endpoint in the mention.
- **Delivery:** desktop continuous and mobile replayable unchanged; no stream/snapshot/queue changes.

## Candidate Combinations and pruning

| Candidate ID | State                                                                | Event                     | Expected effect                                                                           | Status   |
| ------------ | -------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| CWM01        | local draft, window has workspace A/B                                | type `#` in A             | sessions of A and B appear, A first                                                       | accepted |
| CWM02        | remote draft, same remote authority has workspace A/B                | type `#` in A             | sessions of A and B both appear from the remote service                                   | accepted |
| CWM03        | local and remote workspaces coexist                                  | type `#` in local         | only local authority sessions appear, remote does not wrongly go through the base service | accepted |
| CWM04        | two remote authorities coexist                                       | type `#` in remote A      | only authority A sessions appear, B does not enter the invalid candidates                 | accepted |
| CWM05        | remote tab has not restored its service                              | open `#`                  | does not subscribe the local host; re-aggregates after the connection recovers            | accepted |
| CWM06        | panel not enabled                                                    | ordinary composer render  | no extra sessions-index pre-subscription                                                  | accepted |
| CWM07        | local draft, window has workspace A/B                                | type `@` in A             | subscribes only A; B does not enter the `@` session group                                 | accepted |
| CWM08        | workspaces A/B in the same authority each have more than 20 sessions | type empty-query `#` in A | A and B each keep only their recent 20; A must not crowd out B                            | accepted |
| CWM09        | a matching session of workspace B is not in its recent 20            | type `#` in A and search  | match B's full history first, then show at most 20 of B's matches                         | accepted |

Pruned: theme, locale, task phase, model/provider, continuous stream and replayable recovery do not form a
Cartesian product with candidate scope, since they do not change workspace authority. Desktop local + remote
endpoint focused tests are the representatives, and the existing shared components keep covering responsive,
theme and keyboard interaction.

## Acceptance

- With local workspace A, `#` can search and select sessions of local workspace B; `@` still shows only A.
- Current workspace sessions still sort before other workspaces, and the candidate row shows the source
  workspace name.
- With an empty `#` query each workspace shows at most its recent 20; a search still finds history sessions
  outside the recent 20, with each workspace's matches still at most 20. The cap must not be written as a
  global 20.
- The same path with a different `workspaceIdentity` does not mix scopes; both Windows and Unix paths show the
  last workspace name.
- Remote candidates subscribe only through the corresponding remote service; an unconnected or other endpoint
  does not fall back to the base host.
- After selection the original session mention Markdown is still inserted; protocol, Agent runtime, queue,
  stream and snapshot are unchanged.
- No extra sessions-index subscription when the panel is not enabled.

## Test handoff

- focused hook test: `#`-only local A/B aggregation, `@` current-only, remote same-authority aggregation,
  cross-authority pruning, disabled does not subscribe.
- pure function test: current workspace first, other workspaces by recent update, workspace label/keywords.
- pure/provider test: empty query takes the recent 20 per `workspaceKey`; a query matches the full history
  first then takes 20 each; `@` does not apply the cross-workspace cap.
- No provider replay E2E this round: the candidate scope is a low-frequency renderer index composition, and the
  canonical and formal E2E already cover it; the case catalog / coverage matrix records focused coverage and
  does not pose as cross-Host context transfer.
