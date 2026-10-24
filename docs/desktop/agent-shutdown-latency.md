# Agent shutdown latency

## Background

Desktop app exit enters `before-quit`; the main process waits for each workspace window's Local Host and any
still-living Remote Host to finish resource cleanup. Each Host in turn waits for the ZCode CLI process trees it
manages per workspaceKey to exit, so `zcode-cli` / `app-server` / MCP child processes do not linger on
Windows, macOS or Linux.

The 2026-06-12 runtime log showed ordinary closing took about 2.4s to 2.7s from `waiting for host process
cleanup` to `host process cleanup completed`. Static code confirmed the main cause: `terminateProcessTreeAndWait()`
always waits `DEFAULT_FORCE_AFTER_MS + DEFAULT_WAIT_AFTER_FORCE_MS`, and does not return immediately even if the
agent process already exited.

## Goals

- On normal closing, let the stdio agent receive EOF first so it finishes the protocol entry's shutdown and the
  sqlite/session store tail on its own.
- When the process has exited, stop waiting immediately instead of always consuming the 2.25s fallback window.
- When the agent is unresponsive, still force-reclaim by process tree so no runtime/MCP child lingers.
- While the Agent runs normally, the stdio request / response / notification / stderr hot path must not query
  the system process table; process cleanup may only affect exit duration, never message throughput, order or
  UI real-time behavior.
- Keep the desktop `desktop-continuous` main-link semantics; this only affects host resource cleanup after app
  exit and does not change the mobile Web remote `web-remote-replayable` stream/snapshot/queue boundaries.

## Windows ordinary exit versus update install budget

Windows ordinary exit is a high-frequency interaction; update install is low-frequency and must strictly hand
over by releasing resource locks of bundled files. The two no longer share one wait budget:

```text
ordinary exit / restart            update install
  -> Cron and Host dispose in parallel   -> Cron and Host dispose in parallel
  -> force-end Host after 4s             -> force-end Host after 7.5s
  -> total barrier waits at most 4.5s    -> total barrier waits at most 9s
  -> exit App                            -> scan and clean bundled-resource references
                                         -> quitAndInstall
```

- Windows ordinary exit includes window close, tray quit and ordinary app restart; it does not run the update
  install's bundled-resource lock scan.
- The Cron Scheduler's 1.5-second settle must run in parallel with Host cleanup and join the same exit Promise;
  it must not wait for Cron before starting the Host timer, otherwise stage budgets add serially to about
  6 s / 10.5 s. As soon as Cron enters the disposing state it must stop dispatching new tasks to a Host that is
  exiting.
- The short ordinary-exit budget applies only to Local Host. Closing an SSH/WSL/Docker/Bot Remote Host also
  includes up to 1 s of service dispose and up to 6 s of remote connection dispose, so Main must keep the
  strict 7.5s/9s budget to avoid force-killing before the Host's existing closing upper bound; this is a
  fallback bound, and a remote Host that exits early is not waited on until timeout.
- `auto-update quitAndInstall` must explicitly select the `update-install` policy, keeping the strict 7.5s/9s
  barrier.
- If an update request arrives after an ordinary exit already started, it must not be refused for being unable
  to extend the existing 4s timer: the exit type is upgraded to `update-install`, cleanup not yet scheduled uses
  the strict budget, and after the existing short barrier completes it continues the Windows resource scan and
  fail-open starts the installer. The product accepts that a runtime may linger in this extreme race; update
  reachability takes priority.
- macOS/Linux are not shortened, to avoid spreading this Windows performance fix to platforms without runtime
  evidence.
- The ordinary-exit 4s force-kill point stays later than the Host's internal 3.5 s bounded service/process-tree
  cleanup; it must not drop before that internal boundary, otherwise the Host could be killed before the
  `taskkill` fallback runs and recreate orphan runtimes.

## Implementation constraints

- `ZCodeStdioTransport.disposeAndWait()` first closes stdin, triggering the input-close path of
  `app-server --stdio`; if it has not exited within a short window it proceeds to process-tree termination.
- It must save the process-tree snapshot before sending stdin EOF; otherwise after the root exits first,
  detached or system-adopted descendants can no longer be found through PPID.
- The protocol is invalidated first; the stderr reader stays until the stream closes, drains at most another
  250 ms after child exit, then builds the exit tail with the old runtime identity. A stderr-only failure does
  not close a healthy protocol.
- The ordinary EOF grace is 1800 ms, covering the CLI's 1500 ms total exit cap from its first closing event;
  waiting still deducts from the original process-tree total budget and repeated signals do not extend it.
  Coverage keeps its own disk-write grace.
- `send()`, stdout frame dispatch and stderr line dispatch of `ZCodeStdioTransport` do only protocol I/O and
  must not call synchronous or asynchronous process management commands such as `ps`, PowerShell or
  `taskkill`, nor guess from message method/type when to refresh the process tree. The exit snapshot may be
  taken only after `dispose()` / `disposeAndWait()` has begun.
- Process ownership comes from the Host's spawn relation and the Agent's own MCP/process adapter, not protocol
  message activity. A POSIX Agent must keep running in its own process group; Windows keeps the task tree of
  the CLI root PID as the closing boundary. The Agent's normal EOF tail first closes its registered MCP
  process trees; the Host's pre-exit snapshot and the process-group/task-tree signal are the forced fallback.
- The completion boundary of `terminateProcessTreeAndWait()` is "the whole process tree attributed to this
  runtime in the pre-reclaim snapshot has exited", not merely the direct child. If the root exits first,
  discovered descendants must still go through graceful / force reclaim and a liveness re-check; the return
  value must carry leftover PIDs explicitly, and callers must not treat "log a warning and end the bounded wait"
  as cleanup success.
- The cleanup timeout is only the boundary into "terminal observation" and does not prove persistent leftovers.
  All platforms release process ownership by the same terminal rule; a normal exit delivered slightly late
  within the observation budget is still cleanup success, and only snapshot identities still alive at the
  deadline report `cleanup incomplete`:

  ```text
  pre-exit identity snapshot -> graceful / force reclaim -> terminal observation budget
                                            |-- all snapshot identities exited -> success (incl. late exit)
                                            `-- still alive at deadline -> remainingPids + keep ownership
  ```

  On Windows the snapshot, EOF, taskkill and terminal observation share the transport's fixed absolute
  deadline; with no verified `taskkill` target the remaining budget must not be compressed to a fixed 250 ms
  but a pure observation window of at most 750 ms is kept for the original `ChildProcess` / pinned identities
  within the same absolute deadline. The worst case of this pure-observation path combined with the first
  3.25 s cleanup must not exceed the Local Host's 4 s force-exit point; paths with verified signal targets keep
  the existing taskkill absolute deadline. macOS/Linux keep the existing POSIX force + observation bound; there
  is no runtime evidence to expand their wait.

- The process-tree snapshot cannot store bare PIDs: it must also store a re-verifiable process creation
  identity (Linux `/proc` start ticks; Darwin `lstart + command + PGID`; Windows `CreationDate`) and the POSIX
  PGID. Identity must be checked before delayed graceful / force reclaim; a reused PID is treated as "the
  original member has exited", and the tree must not be re-queried from the reused root PID nor a signal sent
  to the new process. The Windows force phase must not start another full process-table query; it reserves a
  fixed window inside the original deadline and uses `Get-CimInstance` to re-check the current `CreationDate`
  of known PIDs from the snapshot. A descendant may get `taskkill /T /F` only when the creation identity is
  confirmed to match; on query failure, timeout or identity mismatch it must fail closed. The managed root is
  the only exception: if it is not in `unverifiedRootOnly`, and the original `ChildProcess` held by the Host
  still has both `exitCode/signalCode` `null`, a signalable handle and a confirmed live PID, graceful `/T` or
  deadline `/T /F` may be applied to the root alone; descendants must not be re-discovered from the root PID
  and unverified descendants must not be added to `/F` targets.
- When the system process table is temporarily unavailable and no root creation identity has been obtained,
  this reclaim round must fail closed: no signal to a bare PID through `ChildProcess.kill()` or `taskkill`, and
  no re-discovery of that PID's process tree in the delayed force phase. The snapshot must be explicitly marked
  `identityVerification: "unavailable"`, keep observing the original `ChildProcess` within the existing exit
  budget, and report cleanup incomplete via `remainingPids` if it has not exited by the deadline; an empty
  identity must not be reported as cleanup success.
- The Agent's "currently reusable protocol client" and the Host's "OS process ownership not yet confirmed
  exited" are two different states. Protocol close may release the workspace's active client binding at once,
  but process ownership is released only after cleanup confirms the root and registered tree members have all
  exited.
- Reclaim of the same managed process by timeout, protocol close, workspace restart and app quit must be
  idempotent; a failed cleanup Promise must not be cached forever. App quit must wait for all owned processes,
  active and retiring, and make one bounded final retry that goes straight into the force phase for process
  trees previously reported as leftover.
- Windows saves the descendant snapshot via the system process table before EOF, keeps `taskkill /PID /T` and
  `/F` as fallback; if the root already exited before protocol close, the cleanup boundary may recover
  descendants through the `ParentProcessId` kept by Win32_Process, but candidate members' `CreationDate` must
  fall inside the root lifetime recorded by the Host and keep pinning member identity by `CreationDate`, so a
  reused root PID cannot claim unrelated processes. Windows 10+ uses asynchronous PowerShell
  `Get-CimInstance Win32_Process` throughout, with multiple workspaces in one round sharing a single in-flight
  query; when CIM is unavailable it explicitly enters unverified fail-closed. POSIX keeps using the independent
  process group owned by the Host at spawn plus discovered descendants as fallback.
- When running `taskkill` for multiple workspace Agents on Windows, asynchronous child processes must be waited
  on in parallel; serial `spawnSync` that blocks the Host event loop is forbidden. The Host's service phase
  timeout must fire on time even if a cleanup command hangs; asynchronous commands still need a per-call
  timeout and must return an explicit cleanup result after graceful/force commands finish.
- The query time counts toward the original force deadline and must not restart after the query ends,
  otherwise process-table query time adds to the exit budget under load. The first successful snapshot is the
  only full process-table query of the round; the force phase must reuse it and may only run bounded targeted
  CIM re-checks of known identities in the snapshot.
- When the PowerShell/CIM command succeeds but yields no parseable identity, is denied, unavailable or times
  out, it returns `identityVerification: "unavailable"`; an empty identity must not mean cleanup completed.
  When the root exits during the same round's query, descendants may be recovered from that round's full
  process table only if the caller already supplied a trusted `ownedProcessExitedAtMs` or the query completion
  can read that time from the managed ChildProcess exit event; the query completion time must not stand in for
  the exit upper bound.
- Closing-path logs must be low-frequency lifecycle logs and must not record raw stdio frames or streaming
  deltas.

## Non-goals

- This round does not change the Dispose message protocol of Main / Host, app-server signal handling, or the
  startup orphan process scan.
- It adds no resident process polling and does not infer process ownership from the runtime message stream. The
  current MCP adapter does not use detached spawn and explicitly reclaims registered stdio MCP process trees in
  the Agent EOF tail; if a future managed process must detach from the Agent process group, its spawn adapter
  must add an explicit ownership/close contract, and runtime process-table scanning must not return.
- It does not change the reuse relation between workspace and active Agent, nor MCP config or session
  connection semantics.
- It does not change the message delivery boundaries of desktop `desktop-continuous` and mobile remote
  `web-remote-replayable`.
