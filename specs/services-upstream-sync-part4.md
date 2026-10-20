# Services Upstream Sync, Part 4 (3.16.1): deferred leftovers

Parent spec: `specs/services-upstream-sync.md`. Base `aac47556` (v3.15.1), target `0a1fc56d` (v3.16.1). Branch `claude/upstream-sync-services-4` is based on `origin/claude/upstream-sync-ui` (#215), which already carries the services change from G5 (window-controller unread producer, owner-direct `getTaskMeta`).

This part closes the items deferred in 8b and 8c, one file per commit. Where the fork never changed behavior (fork == base), the upstream behavior and test win. Where the fork changed behavior on purpose, the fork test is the spec.

## Decisions carried in (not reopened here)

- `packages/server/src/http.ts`: the fork keeps `/api/connect-remote` and `/ws/remote/:id` (fork remote features and bots `/remote` depend on them, see `specs/bot-remote-command.md`). Every other upstream hunk is taken.
- The fork `zcodeTask*` path is the single writer of task state (AGENTS.md single-owner rule). Upstream `task-facts` and `task-groups` stay unwired.
- The grouped-view surface (`ZCodeGroupedTaskView`) stays fork-owned. It moves to UI-2 together with the sidebar switch.

## 1. `packages/server/src/http.ts` (done)

Owners: the HTTP layer owns routing and auth order. It owns no task state.

Applied upstream hunks: `hostname`/`userInfo` and the `nodePath` namespace import; the containment helper (`isInsideDirectory` with an injectable `pathApi`, absolute `relative` results treated as outside, `isPathDriveQualified` rejected before `resolve`); `Bearer` token acceptance in `hasValidLiteToken`; `resolveHttpServerId` (exported); the richer `serverRemoteInfoOutputSchema` payload (`compatibility`, `migration`, `identity`, `virtualProjects`); optional `workspaceIdentityMapper`, `virtualProjects`, `migrationFailedPathCount` options. The identity mapper is optional and falls back to the plain `LoggingChannelServer`, because server-cli #205 is not in this base.

Fork kept: `/api/connect-remote`, `/ws/remote/:id` and their `createRemoteConnectionStore`, the derived `authRequired`, `resolveHttpListenHost`, and the standalone window controller.

Tests: `serverInfoHttp.test.ts` (upstream payload expectations, plus `keeps the fork web-mode remote routes reachable`: the POST returns 400 for an invalid body, and an unknown `/ws/remote/:id` closes with 4004). `staticRoutePathContainment.test.ts` (upstream, waits for `listeningAddress` instead of reading `address()` synchronously).

## Status and remaining items

Items 2 to 7 are tracked in the sections below and updated per commit.
