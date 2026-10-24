# Workspace / App entry draft state

## Feature Summary

| Field                 | Value                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Change                | App cold launch and workspace-level open entries no longer auto-select the last session; they only enter an empty draft              |
| User-visible surfaces | Desktop launch restore, opening a local/remote workspace, sidebar workspace row, system workspace focus                              |
| Existing docs         | `docs/conversation-session-case-catalog.md` TSL, `docs/v4-refactor/06-ui.md`                                                         |
| State owners          | Tab/workspace activation: tab store. Draft and `activeTaskId`: workspace Zustand bucket. Pane/group: renderer-local UI state         |
| Out of scope          | Explicit history-session click, notification/task deep link, session content restore, CLI projection, mobile replayable gap/snapshot |

## Clarification Log

| Round | Question                                                                                                           | User answer                                                                                             | Boundary fixed                                                                                                                                                        | Follow-up needed |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1     | Should opening a workspace or launching the app open a session by default?                                         | No, only the draft state                                                                                | Workspace/app-level entries keep `activeTaskId=null`                                                                                                                  | no               |
| 2     | While switching to a remote workspace after a successful connection, may the right side go blank before the draft? | No; still activate the remote workspace, but the right side goes straight to a new conversation         | Remote tab activation and the target workspace's `startDraft` belong to one commit stage; a list refresh must not sit between them                                    | no               |
| 3     | Activating a disconnected remote workspace from the sidebar: what does the right side show while connecting?       | Keep the current right-side content; switch to the remote new conversation once the connection is ready | Never activate a disconnected tab lacking `remoteSessionId`; commit tab + draft atomically after connection, identity and services are ready                          | no               |
| 4     | Opening a disconnected workspace from the remote history entry: only update the tab on success?                    | No; as with sidebar reconnect, enter the target workspace's new conversation once ready                 | The history entry passes the shared workspace-activation callback; order is fixed: complete tab -> activate exact identity -> `startDraft` -> pinned/timeline refresh | no               |

## Boundary Decisions

### Unavailable default local project (2026-09-15)

When the local project directory selected by launch restore does not exist, is not a directory or is
inaccessible, the app enters the project-less draft of "Tasks" and does not make the unavailable
project the active workspace. The unavailable project entry and its history tasks are kept; no
project is deleted and no formal session is created. The draft uses the app-owned cwd returned by
`fileService.ensureConversationWorkspace()`, owned by `projectId=null`, `activeTaskId=null`.

The restore selection is still computed once by `restorePersistedRemoteWorkspaceSessions` and
submitted to TabStore:

```text
Main checks the default local directory -> unavailableWorkspacePath
Host resolves the project-less cwd -> Renderer computes restore list and active index
  -> first frame activates the project-less workspace -> existing primary draft / composer
  -> active-first, then append the unavailable entry, keeping the user's current selection
```

Both the new `lastActiveWorkspace` and the legacy list restore are covered; list order does not
affect the fallback selection. If the project-less directory fails to resolve, the existing
error/read-only restore ability is kept and the unavailable directory is never passed off as a
sendable draft. Valid local directories and explicit history-task navigation keep existing
semantics; a remote workspace with the same path does not use the local unavailable marker. Only
desktop launch navigation changes: no Host/CLI state ownership, persistence schema, mobile
shared-host attachment or `web-remote-replayable` recovery boundary changes.

Verification: unit tests of the restore function cover new/legacy, order, active-first completion
and the user's newer selection; a Desktop E2E full restart asserts the project-less draft accepts
input, the unavailable directory still does not exist, and input still works after refresh.

| Boundary               | Decision                                                                                                                                | Includes                                                       | Excludes / prunes                                                                                | Source                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| App cold launch        | Restore workspace tabs, but not a visible session owner                                                                                 | Local, SSH/WSL/Docker tabs                                     | History sessions are not deleted                                                                 | user                  |
| Workspace-level entry  | Every explicit open/activate of a workspace enters the draft                                                                            | Folder picker, workspace row, system focus                     | Explicit session/task navigation                                                                 | user                  |
| Renderer reload        | Keep the current session's pane restore                                                                                                 | Same-renderer refresh, streaming continuation                  | App process cold launch                                                                          | existing M3 contract  |
| First execution        | Only the first send or a command needing a session creates/binds one                                                                    | Draft promotion                                                | Hidden creation of a formal session at launch/open                                               | conversation protocol |
| Multi-client           | Workspace entry semantics are the same; delivery profile unchanged                                                                      | desktop continuous, web remote replayable                      | relay/main holding session state                                                                 | architecture          |
| Remote connection done | Before ready, keep the current right side; after ready, activate the remote tab and immediately switch that workspace's draft ownership | SSH/WSL/Docker/Server first connect and disconnected-tab reuse | Activating a `remote-waiting` tab early; calling `startDraft` only after pinned/timeline refresh | user                  |

## Domain Scope And State Owners

| Domain                        | Include?       | Authority / evidence                                                                |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Conversation/session behavior | yes            | `activeTaskId`, draft DOM, first `createSession` command                            |
| UI shell / persistence        | yes            | Tab activation, pane layout, workbench group, last-session renderer storage         |
| Workspace identity            | yes            | `workspaceKey = workspaceIdentity?.trim() \|\| workspacePath`                       |
| Mobile replayable             | representative | Only proves the entry does not select a session; snapshot/gap/owner/lease unchanged |
| Provider/runtime/queue        | pruned         | Behavior after the first send is unchanged                                          |

```text
app cold launch / open workspace
  -> activate exact workspaceKey
  -> deactivate visible workbench group + reset primary pane (desktop only)
  -> activeTaskId = null
  -> render draft

explicit session/task navigation
  -> activate exact workspaceKey
  -> activeTaskId = target sessionId
  -> optionally restore that session's workbench

draft first send
  -> createSession
  -> bind returned sessionId
  -> subscribe continuous | replayable according to trusted attachment

remote workspace selection / disconnected workspace reconnect
  -> keep current active workspace and conversation while connecting
  -> remote services + workspace identity ready
  -> activate/upsert exact remote workspace tab
  -> startDraft for the same workspaceKey in the same interaction stage
  -> render remote draft without an empty intermediate pane
  -> refresh pinned/timeline task lists as async follow-up
```

## Candidate Combinations And Pruning

| Candidate ID | State                                                                              | Event                                                                                                                             | Expected effect                                                                                                                                                                                                    | Status   | Notes                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| WED-01       | persisted workspace + last session                                                 | app cold launch                                                                                                                   | workspace visible, primary draft, no session selected                                                                                                                                                              | accepted | stale pane/group owner cannot override draft                                                                                 |
| WED-02       | workspace has historical sessions                                                  | workspace-level open/activate                                                                                                     | target workspace draft                                                                                                                                                                                             | accepted | exact identity bucket only                                                                                                   |
| WED-03       | historical session exists                                                          | explicit session click/task deep link                                                                                             | open target session                                                                                                                                                                                                | accepted | not a workspace-only entry                                                                                                   |
| WED-04       | session is running in current renderer                                             | renderer reload                                                                                                                   | restore the selected session and continue projection                                                                                                                                                               | accepted | preserves M3 refresh continuity                                                                                              |
| WED-05       | mobile remote attachment                                                           | workspace-only switch                                                                                                             | draft without changing replayable recovery                                                                                                                                                                         | accepted | shared-host boundary unchanged                                                                                               |
| WED-06       | right side shows a local or other workspace; target remote workspace not connected | select a remote directory, click a disconnected sidebar workspace, or open a disconnected workspace from the remote history entry | keep the current right side while connecting; once services are ready, complete the tab, activate the exact remote workspace and enter that workspace's draft synchronously before the task list refresh completes | accepted | never expose a `remote-waiting` active tab; all three entries reuse the same tab activation and draft-owner commit semantics |
| WED-P01      | provider/model/theme/locale combinations                                           | any WED entry                                                                                                                     | same navigation result                                                                                                                                                                                             | pruned   | these dimensions do not own selection                                                                                        |
| WED-P02      | queue/goal/compact/fork/tool state                                                 | app/workspace entry                                                                                                               | historical session remains in history, not auto-selected                                                                                                                                                           | pruned   | no command is sent to that session                                                                                           |

## Accepted Cases And Matrix Backfill

| Case ID | Setup                                                                                  | Action                                                        | Assertions                                                                                                                                                                       | Evidence                                             | E2E status   |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| TSL08   | persisted last-session/group/pane exists                                               | cold launch or workspace-only open                            | `activeTaskId=null`; one primary draft; no restored session subscription                                                                                                         | UI + renderer store + command trace                  | planned      |
| TSL09   | current renderer shows a running session                                               | reload renderer                                               | same session is rebound; projection continues                                                                                                                                    | UI + subscription/session id                         | planned      |
| TSL10   | draft or another workspace is visible                                                  | click a historical session                                    | target session opens; exact workspace identity selected                                                                                                                          | UI + renderer store                                  | planned      |
| TSL35   | local/other workspace conversation is visible; target remote workspace is disconnected | select a remote directory or click the disconnected workspace | current conversation remains mounted while connecting; after services become ready, exact remote tab and its primary draft become visible before pinned/timeline refresh settles | UI + tab/Zustand ordering + deferred connect/refresh | covered-unit |

E2E uses a launch/navigation fixture without provider requests. TSL08 must assert no `createSession` conversation command before the first send. TSL09 keeps using a controlled stream to prove reload continuation; app cold launch and renderer reload are not merged into one equivalence class.
