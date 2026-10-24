# Subagent Session Side Tabs

## Goal

The subagent detail entry in a parent session's Agent tool block uses the workspace's shared right
panel, not a workbench split. Once a child session target exists, clicking the Agent summary row or
pressing Enter/Space directly creates or activates a right tab; the user no longer expands the tool
detail and clicks a secondary button. Each `childSessionId` maps to one full read-only session tab,
so the workbench limit of 4 panes does not apply and ordinary session split is unchanged.

Scope: the child detail entry on desktop, ordinary Web and mobile `/remote`. Desktop and ordinary Web
use right tabs; mobile `/remote` reuses the existing right drawer. The subagent directory and its
paging exist only on desktop and ordinary Web. This feature does not change owner, lease, snapshot,
queue or replayable recovery semantics.

## State model

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
├─ workspace shared tabs: Git / Browser / Code Viewer / Terminal / ...
├─ root session A
│  ├─ child A1 -> Explore project structure
│  └─ child A2 -> Analyze dependencies and config
└─ root session B
   └─ child B1 -> Explore source code features

Switching the parent task:
  tab bar = workspace shared tabs + the current parent session's child tabs
  other parents' child tabs stay mounted and subscribed, but hidden and unfocusable
  switching back restores that group's order and last active item
```

1. The UI distinguishes `rootSessionId` (tab grouping), `parentSessionId` (direct lineage) and
   `childSessionId` (detail subscription target). For a first-level child, root equals parent. A
   subagent tab's stable identity is `workspaceKey + rootSessionId + childSessionId`; repeated
   clicks only activate it.
2. A selection side chat is a real session. A subagent derived inside it has the real lineage
   `parentSessionId = side chat session`, but the tab's visibility belongs to the main task:
   `rootSessionId = side chat tab.parentSessionId`. The side chat pane passes the host callback
   through and hands that root to `SessionPane`, so the opened child tab is visible under the main
   task and not under the side chat. The side chat's own tab sync cleans only tabs whose
   `parentSessionId` is that side chat and does not collect the main task's direct child tabs
   (precedent: side chat plan detail, `b8d9e87d`).
3. Titles come from the entry's task `title`: the Agent summary row passes its visible title and the
   Running panel passes the `session/subagents` projection title. Reopening the same child syncs the
   latest non-empty title; only an empty title falls back to the localized "Subagent" label, never
   concatenating `subagentType` or a number.
4. Subagent tabs live only in renderer memory and are not restored across refresh. Workspace shared
   tabs keep the existing workspace-level in-memory semantics, not session-level.
5. Close, close others and close all act only on the currently visible set; other parents' hidden
   child tabs are unaffected. Recently-closed records are isolated per parent session.
6. All unclosed child tabs keep their `SessionDataLayer` lease. An inline preview and the right
   detail of the same child share the data layer's reference count and create no duplicate transport
   subscription.

## Summary row interaction

```text
Agent / Task summary row activation (never expands)
├─ childSessionId + open callback available
│  ├─ ordinary desktop / ordinary Web -> create or activate the right read-only tab
│  └─ mobile /remote -> create or activate the read-only tab in the existing right drawer
└─ child not yet projected or failed before start
   └─ static single-line summary; not clickable, no temporary tab
```

- In direct-open mode the whole summary row is one action entry, reuses the existing focus ring, and
  supports mouse, Enter and Space.
- Direct-open mode exposes no `aria-expanded`, shows no expand arrow and mounts no inline detail.
  Re-activating an existing tab only expands the side panel and focuses that tab; it never switches
  the panel back to closed.
- While the child is not yet projected the panel does not open automatically; when the target later
  arrives the row only becomes clickable, and only a later explicit activation opens the panel.
- No duplicate "open on the right" button remains beside the inline Prompt title.
- Agent and its Claude Code compatible alias Task follow the same rule; Workflow activity is out of scope.

## Read-only conversation detail and the file-rewind exception

The right detail reuses the full `SessionPane` / conversation projection, showing the full timeline,
status, tool cards, file summaries and read-only diffs. The detail's conversation capability stays
read-only: composer, manual user retry, edit, fork, stop and permission/elicitation responses are
forbidden. Single-turn workspace-only file rewind is the one explicit write exception. The read-only
status of a provider automatic retry is not a manual retry action and may show at the bottom of the
current running turn.

```text
child turnHeader.actions.canRewindFiles
├─ false -> rewind button disabled; no query/command
└─ true  -> fileRewindPreview(childSessionId, turn target)
            ├─ unsafe/ignored -> no file written
            └─ safe -> applyFileRewind(childSessionId, turn target)
                       -> restore the real workspace
                       -> child RewindTriggered(scope=workspace)
                       -> session_entry persists the rewind state
                       -> child file summary shows rewound
```

- Rewind strictly follows the ordinary session's single-turn, workspace-only, all-or-nothing
  semantics. It does not rewind the whole child session, trim or rewrite child/parent chat history,
  and offers no reapply.
- The gate reads only the target child's own projection/action; the parent task may still be running.
  External or parent-task modifications to the same file are still judged unsafe by the preview hash
  check; no cross-session parent busy guard is added.
- Apply only updates the child turn's rewind state and the real workspace files; it does not rewrite
  the parent Agent row, the Subagent directory, the parent task aggregate or the parent session timeline.
- A child cold resume establishes a new raw event epoch with `SessionResumed`; the gateway only resets
  the raw cursor while the external transport sequence stays monotonic, so a following
  `RewindTriggered` is not mistaken for a duplicate by the old child high-water mark.
- `readOnly` cannot be turned off wholesale. The UI uses an explicit workspace file rewind capability
  exception to avoid opening composer, edit/retry/fork/stop or blocking interaction responses.

The parent conversation no longer mounts a lightweight child output preview. Foreground and background
subagents with a `childSessionId` can both be opened through the summary row. When the child's
current projection has `control.lastError`, the read-only detail shows a compact error notice
directly; the notice adds no timeline row, protocol field or persistence contract.

The child detail also shows two kinds of child-owned model facts:

```text
running provider retry -> snapshot.control.apiRetry -> bottom of the current turn x/total
actual model of a fresh child -> ModelSelected(previousModelRef=null, modelRef=X)
                     -> model_change(undefined -> X) -> "Using X" without a switch arrow
```

- Provider retry lives only in the current CLI/runtime memory; it disappears on valid model progress
  or a turn terminal state and is not restored on cold start.
- The first actual model persists through the child transcript's `model_change` and is still visible
  after cold-start hydration.
- The public projection recognizes only the explicit `∅→X` model boundary and neither stores nor
  judges any Subagent-specific origin.
- Main and child reuse `SessionPane -> ConversationTimeline`; no second state component for child.
- Neither fact enters the parent Agent summary card, changes the child read-only gate or adds a parent mirror.

The child detail keeps passing the open callback through and explicitly inherits `rootSessionId`.
The current runtime forbids a subagent spawning a subagent, so only the recursive UI identity and
reducer contract remain; nested runtime capability is not restored.

## Realtime event boundary

Root cause that this design fixes: the child runtime writes raw child events to the child event
store, but the original event sink converted only some tool activity into parent mirror events. The
UI hydrated from the store on first subscribing to `conversation/<childSessionId>`, but later raw
events never reached the child publisher, so content stayed at the snapshot from open time.

```text
child runtime append
├─ raw child event -> child event store
├─ raw child sink -> route by event.sessionId -> publisher(child)
└─ selected mirror -> publisher(parent)

publisher(child) -> SessionDataLayer -> inline preview + all open child tabs
publisher(parent) -> parent timeline/index/legacy delivery
```

The implementation must satisfy:

- A raw child event entering the bootstrap sink only ingests `publisher(child)` and returns at once;
  it must not bump the parent `updatedAt`, enter parent legacy delivery or pollute the parent timeline.
- Existing selected mirror events keep going to the parent chain with the parent session id.
- A running child with a live publisher must not cold resume extra on subscribe/rows hydration; the
  historical session is restored only when neither a live publisher nor a session record exists.
- A completed historical child can still be reopened through the parent session entry and hydrated
  after a renderer refresh.
- File summaries use the artifact reader shared by the child event log and the parent runtime; a
  read-only child tab does not use the parent runtime to run rewind.
- After a child completes and releases its live runtime, the `runtime/workspace_checkpoint` session
  entry must rebuild the child checkpoint event on cold resume; preview/apply keep hitting the child
  runtime, and a lightweight summary must not be restored while returning empty safe/unsafe lists.
- High-frequency deltas do not write production `info`; only `debug` logs publisher registration,
  subscription and cold-resume decisions.

## Interfaces and compatibility

- The UI `SubagentSessionSidePaneTab` and `OpenSubagentSideTabRequest` carry `rootSessionId`,
  `parentSessionId`, `childSessionId`, `subagentType` and the user-visible `title`; the workspace
  scope is injected by the App shell. `subagentType` is only for the type label and search hint and
  takes no part in title generation.
- Workspace identity and cache keys use `workspaceIdentity?.trim() || workspacePath`; path execution
  still uses `workspacePath`, and a remote workspace keeps `remoteSessionId`.
- The detail adds no Agent/error wire field; the directory uses an independent read-only
  `session/subagents` query, see [subagent-session-directory.md](./subagent-session-directory.md).
  Business state is not pushed down to main/relay.
- Desktop continuous and the existing ordinary Web delivery profile are unchanged; `/remote` enables
  only the child detail drawer, not the directory.
- When restoring an old workbench group, the historical read-only subagent binding is removed;
  ordinary session groups are not migrated.

## Acceptance

- One parent task can open at least 6 child tabs, workbench pane count does not grow, and repeated
  clicks do not create duplicate tabs.
- Tabs opened from the Agent summary row and from the Running panel each use their own authoritative
  title verbatim; never type-plus-number titles such as `Explore 1` or `general-purpose 2`.
- With a child target, click, Enter and Space on the Agent/Task summary row directly open or
  activate the detail without expanding inline Prompt/output; with no child target or a failure
  before start it stays a static single-line summary.
- A running child keeps appending text/reasoning/tool/status after opening, and non-active and
  hidden parent groups are not interrupted.
- When a running child hits a provider retry, the detail shows a unified `x/total` status at the
  bottom of the current turn and clears it on valid progress; the input area stays absent.
- After this change a newly created child's first turn shows the actual resolved model and it is
  restored after a full cold start; old children are not backfilled and the Main first turn gets no new marker.
- Switching the parent task only switches the visible child tab group; workspace shared tabs do not
  follow session switches.
- A child raw event does not change the parent topic sequence/active time; the parent mirror state still updates normally.
- Local/remote workspace identity is isolated; desktop and ordinary Web use right tabs and mobile
  `/remote` uses the existing drawer.
- Opening a right read-only tab from a derived subagent summary row inside a selection side chat
  keeps `parentSessionId` as that side chat session and `rootSessionId` as the main task; the tab is
  visible under the main task and hidden after switching to the side chat; the side chat's sync only
  cleans its own tabs and creates no runtime/session.
- When a child is complete and its file summary is rewindable, desktop, ordinary Web and mobile
  `/remote` can all complete a safe preview/apply; afterwards the workspace files are restored, the
  child summary shows rewound, and the parent task and chat history are unchanged.

## Cold recovery, list isolation and user-input admission (3.12.2)

### Project directory resolution for remote child sessions

A child session does not enter the main task index, so its childSessionId cannot be used to look up
main-task project ownership to decide whether it may be subscribed. The Host uses the same Agent's
read-only `session/list(sessionIds)` to query the persisted type and parent-child relation; after
confirming the auxiliary session type from the table below it follows the parent chain to the main
task, and the existing project service validates project, Host and directory. When a child has no
separately stored workspace identity, the CLI exact-ID query returns only when the child cwd is the
same and the persisted parent chain proves it belongs to the requested workspace; an explicit
different identity is still rejected. The ordinary list keeps excluding children, and the query does
not write back identity or activate a runtime. Each session must match the current attachment's
workspace identity and cwd; a missing, cyclic or cross-workspace parent relation is rejected. An
ordinary remote main task must still have a project; children are not recognized by ID prefix or old
index rows, no child task row is created, and the directory scope is not widened.

| Persisted type | Project resolution | Main list | User input |
| --- | --- | --- | --- |
| `interactive`, `fork`, `workflow_parent` | the task's own project | visible | existing admission |
| `subagent_child`, `workflow_child` | the owning main task's project after validating the parent chain | hidden | read-only |
| `selection_side_chat` | the owning main task's project after validating the parent chain | hidden | chat allowed, keeps the auxiliary conversation's own command limits |
| `nested_workflow_child` | handled as a persisted workflow child session; no new creation entry | hidden | read-only |

2026-10-19 regression: the original fix recognized only `subagent_child`, so workflow and auxiliary
conversations still looked up projects by the child ID. Project inheritance and read-only admission
are judged by type separately and must not be replaced by `parentID` or one shared read-only switch.
A mixed parent chain is validated layer by layer, and even if the old child index has a project the
CLI parent chain cannot be skipped. An ordinary fork may own its project, so inheritance must stop at
a fork. When saving the Recent config before an auxiliary conversation continues, the UI queries the
project with the owning main session recorded in the sidebar while the send target stays the child;
it must not query a project with a child that is not in the main index, nor rewrite an ordinary
session's or fork's Recent to the parent project.

```text
desktop continuous / mobile replayable → same Host → Agent persisted session type
  ├─ main task → original project directory validation
  └─ child session → validate persisted parent-chain identity → owning main task's project directory validation
```

The parent-child relation is held only by the CLI session store and project ownership only by the
Host project library; the query adds no cache, queue or runtime, and cold recovery and running
subscription use the same path. Regression covers remote running/completed child, resubscribe, both
clientModes, old child index, a main task without a project, and rejection of missing, cyclic and
cross-workspace parent chains.

### Cold-recovery type and main-list isolation

Root cause: after 3.12.1 reclaimed a detached child publisher, opening the detail went through cold
recovery; bootstrap omitted the persisted taskType when creating the record, defaulting to
interactive, so sessions-index broadcast the child as a main task.

The single identity source is the taskType in the Agent session store. Cold recovery must pass it
before registering the record and publishing events; runtime and protocol records agree. The main
list projects only interactive, fork and workflow_parent and must not use the presence of parentID as
visibility. The transcript cache is still reclaimed by the original terminal grace / parent session
release rules.

```text
child completes → publisher reclaimed → subscribe → read persisted taskType → register subagent_child record
                                                               ├─ hydrate read-only transcript
                                                               ├─ invisible in the main list
                                                               └─ user input admission rejected
desktop desktop-continuous ─ direct stream ─┐
mobile web-remote-replayable ─ snapshot/gap ┴─ same Host / Agent identity and command admission
```

User-initiated input commands (sendText, retry/edit, goal continuation) are rejected before
session_input / input_history is written for `subagent_child`, `workflow_child` and
`nested_workflow_child`. An activated child returns reasonCode `guard.subagentReadOnly`; a running
child without its own record keeps the existing `proto.sessionNotFound` rejection, and the runtime is
never activated just to accept input. Normal child dispatch by the Agent tool is driven by the parent
runtime and does not pass through user protocol input admission; the workspace-only file rewind
boundary is kept.

History pollution repair is done by the Host task index syncer after the workspace's first
authoritative sessions-index baseline arrives: for tasks present locally but missing in the baseline,
it calls the read-only `session/list(sessionIds)` in batches, and after confirming from Agent
persisted metadata that the type is one of the hidden auxiliary types in the table, it only marks the
corresponding task index invisible and cleans group/order references. It does not delete Agent
session, message or part. The query creates no runtime, reads no transcript and changes no ownership.
A remote identity must carry `workspaceIdentity` / `remoteSessionId` throughout, and asynchronous
results apply only to a still-valid subscription generation. When an old Agent does not support the
explicit query, a session is missing or the query fails, the index is kept and retried at the next
workspace baseline. Never delete based on baseline absence or parentID alone. The ordinary
`session/list` still returns only main-list types; an explicit `sessionIds` query returns the
persisted identity (including hidden types) matching the workspace, at most 64 per batch (there is
no `includeArchived` any more, see `specs/build-pipeline-entrypoints.md`).

A full snapshot sync also must not write a hidden type as a main task; for an already-open
polluted read-only subagent tab, backend admission still rejects input. The repair adds no accepted
queue, timer or owner and does not change the continuous/replayable boundary.

Acceptance: SAT27 covers warm / grace reclaim / parent release / detail reopen after cold start and
list isolation; SAT28 covers rejected user input with no input persisted, and normal main task, fork
and Agent dispatch; SAT29 covers history-index pollution convergence, workspace identity isolation,
retention on remote failure and retention of the original transcript. Both clientModes are verified
at the protocol layer; Electron E2E goes through real Agent dispatch, CLI restart and clicking the
detail, asserting the read-only child body is visible and no child appears in the left list.
