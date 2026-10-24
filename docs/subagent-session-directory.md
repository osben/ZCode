# Subagent Session Directory

## Goal

A parent Session's subagent state is one read-only projection that drives the composer's live entry,
the top-right summary, the subagent directory and stale-tab cleanup. The directory shows only
Agent/Task calls in the currently effective conversation branch that can be reliably tied to a
persisted `subagent_child` session. It creates no placeholder session and adds no database table.

Workflow activity does not enter this projection; existing Workflow data structures and interactions are unchanged.

## Authority and query

```text
child runtime ── persist subagent_child session ── SubagentSpawned/status/stopped
                                                   │
                                                   ▼
CLI ProductProjection V4 snapshot.subagents
├─ revision
├─ childSessionIds[] (current branch manifest)
├─ running[] (complete, not paged)
└─ endedTotal
       │
       ├─ desktop-continuous ────────────────┐
       └─ web-remote-replayable snapshot/gap ├─ UI is a pure consumer
                                             └─ UI uses session/subagents only to query ended paged details
```

1. V4 `snapshot.subagents` is the single running-state authority of the current branch. The composer
   count, status summary, running items and child-tab invalidation cleanup all consume it directly; no
   separate `session/subagents` query rebuilds running state.
2. The UI consumes `session/subagents` only for keyset paging of ended details. It takes no part in
   counting running members or the tab manifest; the old running/manifest fields in the response are
   only protocol compatibility and CLI cold-recovery verification and are no longer renderer authority.
3. Before `SubagentSpawned` becomes externally visible, the child session must already be persisted and
   readable as `taskType=subagent_child`. run, background start and resume use the same order; the
   projection must not announce a child that does not exist yet, and there is no self-healing through
   renderer delays, polling or session switching.
4. One CLI projection commit atomically updates `childSessionIds`, `running`, `endedTotal` and the
   matching Agent row; the UI does no second stitching between events and queries. `revision` increases
   only with that projection commit, and a late or duplicate delta must not roll back state.
5. The active branch uses the append-only transcript's `keptMessageIDs + branchCutAfterMessageID`
   semantics; compact compresses only the provider context and does not delete directory members.
6. A child on an old branch removed by edit/retry leaves the projection at once; fork inherits copies of
   reliable ended `childSessionId` references in the transcript but does not inherit the original
   Session's running state.
7. Association prefers the `childSessionId` in tool output/metadata. When a foreground completion result
   has only a stable `agentId`, build the official `sess_subagent_{agentId}` identity per the Agent
   runtime rule and verify again that the session really exists with `taskType=subagent_child`. A running
   foreground uses the parent event log's `parentToolCallId -> childSessionId` relation and must still
   hit an active-branch tool call; never guess by title, time or list position.
8. A child that has run is normally already persisted after a model request, tool or cancel failure; if
   the failure happens before the first persistence, or history cannot reliably prove the child
   association, no stub is shown.
9. `running` includes foreground, background, blocked and waiting; success, failed, cancelled and lost
   all belong to `ended`, and each item keeps its concrete state.
10. Cold recovery first rebuilds rows from the persisted transcript and then validates members against
    the verified `taskType=subagent_child` fact in the session store; ambiguous, unpersisted or
    branch-cut references in old history cannot enter `snapshot.subagents`. The running recovery state is
    completed by the runtime overlay and not guessed from history titles or times.
11. The ended query response carries an independent query `revision`, uses a stable keyset cursor, 20
    per page, newest first. `snapshot.subagents.childSessionIds` is the current branch's tab invalidation
    list, not a second copy of display data.

## UI contract

```text
mini capsule
├─ subagent-only -> counts only running subagents; no ended; shows "{count} running"
└─ Bash/Subagent mixed -> counts running items of both kinds; shows "{count} running"

expanded status panel
└─ Agents (unified collapsible group, title tail shows "{count} running")
   ├─ Running -> existing running items, child detail opens directly; controllable background items keep Stop
   └─ Ended · N -> opens or reuses the Subagent directory tab

Subagent directory (desktop / ordinary Web)
├─ Running (not paged)
└─ Ended · N
   ├─ newest first
   └─ show 20 more
```

- "{count} running" counts the members of `snapshot.subagents.running`, expressing the number of
  subagents still running; it must not be shown as "{count} background", because the set contains
  foreground, background, blocked and waiting together. (UI copy: zh-CN "{count} 运行" / "{count} 后台",
  "智能体", "正在运行", "已结束 · N".)
- Whenever the mini capsule count includes a running subagent it must use "{count} running"; only a pure
  background terminal count keeps "{count} background".
- Only when there is ended with no other summary content such as Git/plan/goal/running may the mini
  disappear; no separate resident capsule is added for the directory.
- In the expanded panel "Ended" must be inside the "Agents" collapsible content and must not be a
  top-level section parallel to "Agents"; with no running but the panel present for other summary
  content, an "Agents" group containing only "Ended" can still show.
- The expanded panel's running items use V4 `snapshot.subagents.running` as the child identity and
  display fact, but Stop control authority still comes from the parent snapshot's `backgroundWorks`. The
  two are associated only by exactly the same `childSessionId`; Stop shows on a hit with
  `status=running`, `kind=subagent`, a `workId` and `cancellable !== false`, and keeps sending
  `cancelBackgroundWork(workId)`. Stop must stop the detail click from bubbling; a foreground child
  with no reliable background-work association shows no forged per-item Stop and must not be guessed by
  title or time.
- A directory item shows the Agent description, final summary or error, relative time and status icon;
  the directory is read-only and adds no stop/cancel control.
- On live completion the V4 projection moves the item out of running and updates `endedTotal`; the
  directory then merges the item at the top by an ended-only query while keeping the loaded pages and
  scroll position.
- The directory tab's stable identity is `subagent-directory:{workspaceKey}:{rootSessionId}:{parentSessionId}`;
  a child tab is `subagent-session:{workspaceKey}:{rootSessionId}:{childSessionId}`.
- Clicking a directory item reuses the unified child detail open request. Repeated clicks within the
  same root reuse; the original Session and a fork root differ, so each can hold a tab pointing to the
  same historical child.
- When edit/retry invalidates a child, the corresponding detail tab closes automatically and does not
  enter "recently closed"; if that tab is active, return to an open directory first, otherwise to the
  previous visible tab. compact does not close tabs.
- The directory tab and child tabs live only in renderer memory and are not restored across refresh.

## Multi-client boundary

- Desktop and ordinary Web provide the directory and paging.
- Mobile `/remote` provides no directory; Agent/Task and Running rows can still open the child detail in
  the existing right drawer.
- Desktop keeps `desktop-continuous` and mobile keeps `web-remote-replayable`; both consume the same V4
  `snapshot.subagents`, and mobile reconnect still recovers via the existing snapshot/gap. The ended-only
  query reaches the same CLI/runtime through the current trusted host attachment and adds no state in the
  relay, desktop main or Host.
- A remote workspace carries `workspaceIdentity` and `remoteSessionId` throughout; the identity key is
  always `workspaceIdentity?.trim() || workspacePath`.

## Accessibility, theme and i18n

- The directory section and items use semantic headings, buttons and visible focus; state cannot be
  expressed by color alone.
- Use the surface/text/border/semantic tokens of `DESIGN.md`, compatible with Zai Light/Dark.
- Copy goes through the zh-CN/en-US locales; titles and summaries may wrap or truncate long text and
  must not depend on Chinese length.
