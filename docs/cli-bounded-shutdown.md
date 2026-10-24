# ZCode CLI bounded shutdown spec

> Status: accepted.

The lifecycle of the protocol-mode CLI is defined by the
[Agent Server spec](../apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md#协议进程生命周期):
its deadline starts at the first EOF/signal/fatal error and covers startup and
in-flight requests; it does not wait for `run()` to return before the watchdog
starts. The existing rules for one-shot commands and the plugin host are unchanged.

## Change summary

| Field        | Decision                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change       | Fix one-shot CLIs being kept alive forever after the model finished, by inherited pipes, a dangling Browser close, or other adapter handles                                                          |
| Entry points | `zcode --prompt`, `--target`, and TUI exit; Desktop/remote hosts reuse the same session cleanup invariants                                                                                           |
| State owner  | The execution adapter owns command process groups and stdio; the managed CDP adapter owns Chromium; the session facade orchestrates teardown; the CLI entry owns only the final exit boundary        |
| Success      | Normal cleanup first; if any external close never settles, the ZCode CLI still ends within a fixed bound and does not wait for orphan processes to die naturally                                     |
| Out of scope | Cross-platform Node guarantees to kill arbitrary third-party processes that already `setsid`/daemonized out of the original process group; changing desktop continuous / mobile replayable semantics |

## Clarified boundaries

- A pipe-only fix is not enough: shutdown must cover execution, browser, MCP, and
  the CLI entry; pipe cleanup is not global teardown.
- `process.exit()` is not the primary fix: do all known bounded cleanup first; the
  watchdog force-exits only when `run()` has returned and the event loop is still
  alive.
- `run()` returning does not always mean the process should exit: after
  `__zcode-plugin-host`'s MCP `server.connect()` completes, `main()` returns while
  the stdio service must keep running. The watchdog belongs to the one-shot CLI
  only; the plugin host's lifetime is owned by MCP stdio/the parent process.
- Killing arbitrary daemons is not guaranteed: after a POSIX new session or Windows
  reparent, the parent PID or original PGID no longer addresses the process. Kill
  same-group descendants best-effort; when ownership is lost, destroy the local end
  of the pipe and guarantee CLI exit. OS-level absolute containment is a separate
  capability.

## Boundary decisions

| Boundary                 | Decision                                                                                                                                                                                              | Forbidden                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| root shell `exit`        | Only means the direct child process ended, not that execution pipes/descendants finished                                                                                                              | Removing a background execution from active ownership while its pipe has not EOF'd                                           |
| foreground pipe drain    | Wait at most a bounded drain; then clean the process group and destroy the local read stream                                                                                                          | Blocking the prompt with an unbounded `await closePromise`                                                                   |
| background session close | Even after the group leader exited, keep sending TERM/KILL to the original process group; finally destroy the pipe                                                                                    | Skipping cancel because `exited === true`                                                                                    |
| runtime admission        | The first teardown beat closes background notification/model wake admission                                                                                                                           | A cancelled execution's terminal event opening new model turns while stores are closing                                      |
| resource teardown        | Browser session, Execution, MCP, and Node REPL broker each tolerate errors and carry a deadline; one failure must not skip the others                                                                 | Serially `await`ing one never-settling close and stalling forever                                                            |
| managed Chromium         | context, browser, and late launch all use bounded close; the CLI adapter still does best-effort reclaim                                                                                               | A dangling `context.close()` or `browser.close()` blocking execution cleanup                                                 |
| CLI entry                | After the one-shot `run()` returns, set an unref watchdog; it does not fire when the event loop drains naturally, otherwise force-exits with the existing exit code                                   | `process.exit()` before model responses/stdio output finish                                                                  |
| plugin-host entry        | After `__zcode-plugin-host` successfully starts the MCP server, stdio/the parent process own liveness and shutdown; no one-shot watchdog is registered; init failure still force-exits within a bound | Treating the MCP server's valid stdio handle as a leak, or letting a failed plugin's leftover handles keep the process alive |

## Domain scope and high-risk cross-products

Main domains: architecture/process boundary, background Bash lifecycle, managed
Browser lifecycle, and CLI release.

| Cross-product                                           | Risk                                                                                                        | Resolution                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| background Bash × root exited × inherited stdout/stderr | `close` waits on grandchild EOF and the CLI stays alive forever                                             | accepted: keep ownership, kill the group, destroy the streams                     |
| detached descendant × lost PGID                         | Third-party service stays alive and the original pipe never EOFs                                            | accepted: local release + CLI watchdog; process reclaim is best-effort only       |
| BrowserContext close × WS/SSE pages                     | A Playwright close may never resolve                                                                        | accepted: per-operation deadline, continue execution/MCP cleanup                  |
| normal prompt × unknown active handle                   | All known teardown finished but the event loop is not empty                                                 | accepted: entry watchdog                                                          |
| plugin-host × MCP stdio active handle                   | After `server.connect()` returns, the stdio handle is the service's liveness condition, not a one-shot leak | accepted: skip the CLI exit watchdog; exit naturally when the parent closes stdin |
| desktop/mobile/remote delivery × cleanup                | Mistaking host cleanup for conversation replay rules                                                        | pruned: protocol, snapshot, queue, clientMode, and deliveryKind unchanged         |

## State sequence

```text
model terminal
  -> runtime.beginShutdown()          # block new notification/model wake
  -> [browser session | execution | MCP | REPL broker] bounded cleanup
       | timeout/error on one stage
       +---------------------------------> other stages still run
  -> session store close
  -> CLI-owned browser runtime bounded close
  -> run() returns exitCode
  -> process role
       | one-shot CLI  -> unref exit watchdog
       |                  | event loop empty -> natural exit
       |                  + handles remain   -> process.exit(existing exitCode)
       + plugin-host   -> MCP stdio owns lifetime -> parent closes stdin / signal exits
```

## Candidate combinations

| Case       | Setup / action                                                             | Assertions                                                                                            | Status                                                       |
| ---------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| CLI-SD-001 | foreground wrapper exits, grandchild inherits the pipe                     | Bounded drain, then the grandchild process group is cleaned; streams destroyed; result settles        | accepted; real process integration                           |
| CLI-SD-002 | background wrapper exits, grandchild inherits the pipe, then session close | Task still running before close; cancelled/killed after; CLI not kept alive by the pipe               | accepted; real process integration                           |
| CLI-SD-003 | grandchild creates a new session/process group and keeps the pipe          | The local pipe end is destroyed and the close is bounded; no claim to kill escaped processes          | accepted; real process integration + finally cleanup fixture |
| CLI-SD-004 | BrowserContext `close()` never settles                                     | Browser close is still attempted; execution/MCP cleanup still runs                                    | accepted; adapter/session focused test                       |
| CLI-SD-005 | `browser.close()` or app `close()` never settles                           | prompt/TUI cleanup returns; the entry watchdog force-exits with the original exit code                | accepted; CLI focused test                                   |
| CLI-SD-006 | All closes normal, event loop drains naturally                             | The watchdog is unref'd and does not delay normal exit                                                | accepted; CLI focused test                                   |
| CLI-SD-007 | Windows process tree                                                       | `taskkill /T /F` best-effort; pipe fallback and watchdog are the same                                 | accepted pairwise; taskkill not verifiable on macOS today    |
| CLI-SD-008 | mobile replayable / remote identity permutations                           | Cleanup reads or changes no delivery/workspace state                                                  | pruned; host-side invariant                                  |
| CLI-SD-009 | plugin-host `main()` returns after MCP connect, parent keeps stdin open    | The host stays alive past the one-shot watchdog deadline; exits normally when the parent closes stdin | accepted; real CLI child process integration + SEA smoke     |
| CLI-SD-010 | plugin-host init holds stdin then throws                                   | The failure exit code is kept and the watchdog force-exits within a bound                             | accepted; real CLI child process integration                 |

## Coverage / E2E handoff

- conversation background catalog: `BG40`, focused adapter/runtime coverage, no new
  GUI E2E.
- Browser Use matrix: `BCP-212` / `HCDP-013`, covering dangling close and subsequent
  cleanup.
- The CLI layer relies on real child-process integration and Node focused tests; the
  plugin host must cover "staying alive past the watchdog deadline with stdin open,
  exiting when stdin closes"; GUI E2E cannot be stronger evidence than process
  PID/pipe-handle evidence.
- Linux/Windows process-tree runs await CI; macOS locally verifies POSIX PGID,
  detached escape, and the final bounded exit.
