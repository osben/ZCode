# Project removal releases the workspace runtime

## Background

Windows treats a process's current working directory and open file handles as directory usage. If,
after the user removes a project in the ZCode sidebar and quits, that project's Agent, terminal, file
watcher or remote runtime is still alive, the project directory may be impossible to delete or
rename.

A second Windows risk is files with reserved device names. `nul`, `con`, `aux`, `com1`, `lpt1`, etc.
are not ordinary file names under Win32 path resolution; if such a file exists in a project, later
deleting or renaming the project directory in Explorer or plain PowerShell can fail with "MS-DOS
function is not valid".

## Problem

"Remove project" is a workspace lifecycle action, not just a UI entry removal. The old behavior only
closed the tab and invalidated the task cache:

```text
click sidebar project remove
  -> closeTab(tab.id)
  -> invalidateTaskQueryCacheByScopes(...)
```

The project disappeared from the sidebar, but the workspace's prewarmed Agent or runtime in the host
was not guaranteed to be released. `useWorkspaceShellLifecycle` only reclaims unused prewarmed state
on a best-effort basis when the App workspace component unmounts and cannot cover the direct
sidebar removal. The old flow also did not warn about a running chat/runtime under that workspace,
so a conversation still `creating`, `restoring` or `streaming` could be removed unnoticed.

## Target behavior

Removing a project from the sidebar first checks for running chat/runtime, then releases the
workspace runtime:

```text
click sidebar project remove
  -> read the current workspace task runtime state
  -> if a creating/restoring/streaming task or draft runtime exists
       -> confirm: removing stops the project's running conversations/Agents
       -> user cancels: do not remove
       -> user confirms: continue
  -> closeTab(tab.id)
  -> zcodeTaskService.releaseWorkspacePreparation({ workspacePath, workspaceIdentity?, provider })
       -> zcodeAgentService.disposeWorkspace(...)
       -> zcodeAgentProcessManager.disposeWorkspace(...)
       -> Windows taskkill /T /F cleans the Agent child process tree
  -> invalidateTaskQueryCacheByScopes(...)
  -> async lightweight scan for Windows reserved device-name files and warn of the risk
```

Constraints:

- The running chat/runtime check reads only ZCode's current workspace UI/runtime state, does not scan the disk, and may block removal synchronously.
- With a running chat/runtime, removal continues only after user confirmation.
- Runtime release is best-effort and does not block the UI removal.
- `workspaceIdentity` must be passed so a remote workspace is not confused with a local one at the same path.
- A release failure is only logged; the removed project is never shown again.
- Task history is not archived or deleted; removal drops only the entry and the runtime hold.
- The reserved-device-name check is not a diagnosis of the user's system delete failures and does not promise the project can be deleted; it is a lightweight risk hint for common project files ZCode/Agent may touch.
- The check runs asynchronously and does not block removing the project from the sidebar.
- It skips high-cost, low-relevance directories by default: `.git`, `node_modules`, `dist`, `build`, `.next`, `out`, `coverage`, `.cache`, `.turbo`, `.vite`, etc.
- It is bounded: it may stop after finding the first few risky paths; a scan failure is only logged.
- The `desktop-continuous` and mobile `web-remote-replayable` realtime boundaries are unchanged; the fix only calls the existing workspace-scoped release API and adds no replay/snapshot behavior.

## Windows reserved device-name rule

The risk check runs per path segment:

```text
file name segment
  -> strip trailing spaces and dots
  -> take the basename before the extension
  -> uppercase
  -> match reserved device names
```

First version covers:

```text
CON
PRN
AUX
NUL
COM1 ~ COM9
LPT1 ~ LPT9
```

Example risky files:

```text
nul
NUL
nul.txt
con.md
aux.log
COM1.json
LPT1.tmp
```

## Acceptance

- Removing a local workspace calls `releaseWorkspacePreparation({ workspacePath, provider })`.
- Removing a remote workspace calls `releaseWorkspacePreparation({ workspacePath, workspaceIdentity, provider })`.
- If release fails, the project is still removed from the sidebar and the error is logged via the UI logger.
- With a running task/draft runtime in the workspace, clicking remove shows a confirmation first.
- If the user cancels the running-chat confirmation, the tab is not closed, the runtime is not released and the task cache is not invalidated.
- If the user confirms, the tab is closed, the runtime released and the task cache invalidated.
- After removal, asynchronously discovering Windows reserved device-name files such as `nul` / `con.md` / `COM1.json` shows a risk toast.
- The reserved-device-name scan skips high-cost directories by default and its failure does not affect the removal flow.
