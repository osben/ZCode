# Windows MCP Job Object containment (prototype)

## Purpose

On Windows, create a separate Job Object for ZCode's local stdio MCP root process and prefer terminating
that Job when the MCP closes. This covers descendants the root creates during containment and reduces
console processes left behind after the Agent/MCP exits.

## Scope

- Covers only the local stdio MCP started by the Agent-side `ProcessTreeStdioClientTransport`.
- macOS/Linux keep the existing process-group cleanup logic unchanged.
- When Job Object creation or adding the PID fails, keep using the existing `taskkill /T /F` fallback path.
- This prototype attaches after the Node SDK has created the root, so it cannot guarantee covering
  descendants created before the attach; to guarantee complete coverage of all descendants, a native
  `CREATE_SUSPENDED → AssignProcessToJobObject → ResumeProcess` launcher is still needed later.

## Lifecycle contract

```text
MCP start
  ├─ non-Windows: existing process group path
  └─ Windows: SDK spawn root → try attach Job Object → on failure keep taskkill

MCP close
  ├─ Windows Job exists: TerminateJobObject + CloseHandle
  └─ afterwards still run the SDK pipe/transport cleanup; a Job failure does not block the fallback
```

## Safety boundary

- Each MCP transport owns its own Job; no global Job, to avoid killing other workspaces or MCPs by mistake.
- Attach uses only the transport's own root PID, never matching by process name or the global process table.
- Any Windows API failure degrades to the existing reclaim logic and does not change non-Windows behavior.
- The prototype does not claim to remove the spawn/attach race; before productization Windows real-machine
  tests must be added to verify that descendants the root creates after attach terminate with the Job.
