# Bash Background Parity

Background output viewing adds an independent on-demand query and right-side details and does not restore foreground progress push; the full contract and BGV01–BGV06 acceptance live in [Background Bash output details](background-bash-output-details.md).

This document records the current implementation boundaries of `local_bash` background behavior and output transport: file opening, output limits, and root-process settlement. Tool schema, timeout, and owner-scope policies not listed here keep their existing contracts.

## Behavior

- Foreground Bash default wait budget is `120000ms`, default max `600000ms`. Bootstrap supports `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` and injects the same timeout policy into prompt, schema, handler, and tool-executor cleanup watchdog. Both env vars parse with decimal `parseInt` semantics; a valid max takes `max(configuredMax, default)`, and only a missing or invalid max falls back to `max(600000, default)`.
- When foreground Bash reaches timeout and the command is backgroundable, the running child is not killed but handed over as a background task.
- A command whose first raw token is `sleep` does not enter timeout auto-background and follows the plain foreground timeout path: `sleep 1` / `sleep 1; echo` are not eligible, while `echo x; sleep 1` / `FOO=1 sleep 1` are.
- Timeout auto-background is a Bash-specific execution path. It reuses existing background task events, task notification enqueue, runtime wake, and the runtime command queue; it exposes no generic foreground promotion method on `ExecutionPort` and does not change generic `ExecutionPort.start()`.
- The timeout auto-background Bash tool result returns: `status: "backgrounded"`, `backgroundTaskId`, output file path.
- Timeout auto-background does not set `assistantAutoBackgrounded`; the model sees the normal background task copy, not the assistant blocking-budget copy.
- Plain Bash opens the canonical output asynchronously once before spawn; stdout/stderr inherit the same fd. After spawn the parent fd closes and the child writes the file directly. Foreground, explicit background, timeout-promoted, and subagent Bash share this path; no Node collector, WriteStream, per-chunk decoder, or output data listener is created. Generic argv/Hook keeps dual pipes, split results, and the original collector contract; the collector uses only the generic inline budget. Bash requests never send the collector-specific `killProcessOnPersistedLimit`; the file watchdog always applies in foreground and background.
- File flags follow the host platform: macOS/Linux use `O_WRONLY | O_CREAT | O_APPEND | (O_NOFOLLOW ?? 0)` — no `O_TRUNC`, no early truncation or deletion of an existing regular file; Windows uses `"w"`, including Git Bash and CMD, with no append/no-follow. New POSIX files are created `0600`. Foreground/background handover transfers ownership only: no file reopen, no output migration.
- The file exists from start; Bash's `persistOutput` is the post-settlement retention policy. An open failure settles as `spawn_error` and publishes no background task; a cancel during preparation closes the fd and deletes only the file created this run. A read failure returns an explicit diagnostic, never disguised as empty output; a cleanup failure does not block settlement.
- Foreground waits ~2 seconds, then reads at most the last 4096 bytes every 1 second, reusing progress events; a background submit stops foreground polling, and Read/TaskOutput reads the file on demand. Final stdout reads the first 30000 bytes by default, honoring `BASH_MAX_OUTPUT_LENGTH`, max 150000 bytes; the file stores raw bytes and reads use bounded decoding.
- Root shell `exit` triggers the bounded read and single settlement immediately — no waiting for pipe EOF, stable file size, or descendants — and normal settlement does not proactively kill descendants. Descendants may keep writing the file but never reactivate the task, send a late completion notification, or keep the size watchdog running. Callers needing complete output must let the root shell wait on its workers.
- Both foreground and background `stat` the canonical output every 5000ms; a strict `size > 5368709120` requests terminating the process tree. This is a 5 GiB soft threshold with no hard write truncation: overage inside a check interval and commands naturally finishing before the first check are accepted, with no terminal-state re-judgment. Background submit restarts the watchdog; terminal state clears it; a check failure never fakes an over-limit. The over-limit result is cancelled/interrupted, exit 137, `error.type=output_limit`, with the message `Command killed: output file exceeded 5GB`. Cancel, hard timeout, and over-limit reuse the platform process-tree termination; async kill-tree completion is tracked by the adapter; after the terminal state, no late progress is pushed and no duplicate termination is issued.
- Close guarantee: a Stop result may still settle first; adapter `close()` must keep registered kill-tree operations alive until the POSIX 1500ms SIGKILL escalation and that round's PPID snapshot/signal dispatch complete, or the Windows taskkill finishes. Waiting on the Promise alone is not enough: with direct writes there is no pipe to keep the loop alive, and unref'd timers can exit with the parent Node early. Shutdown reuses existing cleanup handles; no resident polling is added; no drain/descendant-kill is restored after a normal root exit. Regression uses an isolated Node (no IPC/extra keep-alive) covering close-after-cancel, direct close, background Stop, hard timeout, and over-limit.
- Foreground small output is best-effort deleted after read-back; plain large output keeps the full canonical output and returns a bounded head summary plus the full file path — the 64 MiB artifact truncation is gone. Bash ignores `maxArtifactBytes`; the generic argv/Hook budget is unchanged. The raw size at read time is recorded. After a foreground over-limit termination, the summary is read back and the over-limit file best-effort deleted; background files are kept. Normal empty output with `persistOutput="always"` still keeps a zero-byte artifact.
- When terminal stdout is empty, the exit is non-zero, and it is not exit 137, run `statfs` on the output file's directory; with less than 10 MiB free or fewer than 1000 inodes, return the existing lost-output diagnostic.
- Explicit `run_in_background: true` commits to background immediately after the process starts successfully, reusing the same completion/notification chain. Even if the call carries a short `timeout`, that value is only the pre-commit foreground deadline: commit clears the deadline and unbinds the parent turn abort, so the background process is not killed at the original timeout.
- Explicit and timeout-promoted Bash share one adapter lifecycle state machine and the single-task `5GiB` canonical-output soft threshold; completion, deadline, abort, and output-limit races can produce only one foreground result or one background task.
- For main/session-scope background tasks, only `cancelBackgroundTask`, adapter/session `close()`, and the timed output-limit watchdog may terminate the process tree. After the root shell exits, the task's terminal state holds no descendants.
- `subagent_child` scope keeps the same background behavior plus two owner lifecycle constraints: background Bash runs at most `3600000ms` by default (overridable by internal subagent runtime config), and cancelling the owner subagent cleans up its still-running background Bash. Normal owner completion does not stop committed tasks just for completing. Detached here means detached from the foreground deadline and parent turn abort only — not from adapter/session or owner-subagent process ownership.
- A finished background Bash settles directly by the execution adapter's completion promise; the tool executor enters the runtime command queue via the existing background notification enqueue to wake the main agent.
- A plain background tool result contains only the canonical output path, with no appended `Stdout:` / `Stderr:` paths.
- `local_bash` task notification uses provider-visible XML without a system notification prefix, `<task-type>`, split path, result, or error fields — only `task-id`, optional `tool-use-id`, `output-file`, `status`, and `summary`.

## Not supported

- Manually converting a currently foreground Bash to background.
- The provider-visible `background_tasks` control request.
- Any real reachable path for `backgroundedByUser`.
- A UI/UX hint after 2 seconds that the user can manually background.
- A global `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` capability switch across Bash/Agent/schema.

## Multi-client boundaries

Progress contract: each update derives, from the same 4 KiB tail window, a short preview of the last 5 lines and a long preview of the last 100 lines; when the whole file fits in the tail window, count lines directly, otherwise estimate total lines by total-bytes/read-bytes ratio, never letting the estimate regress.

```text
direct file -> bounded tail -> ExecutionEvent.outputPreview -> ToolCallProgress
  -> V4 ToolCallRow.outputPreview -> Execute renderer
       +-> collapsed: command summary and status only
       +-> expanded: last 100 lines
  -> result/error/background/turn end: clear preview
```

- `outputPreview` is an optional bounded latest-output state with `text`, `fullText`, `totalLines`, `totalBytes`, `linesEstimated`, carried along ExecutionPort, session event, the legacy tool.updated schema, and the V4 row. V4 updates only existing running Bash rows; late progress creates no row and revives no terminal row. The parent session does not materialize mirrored subagent tools; the child conversation updates normally. Old snapshots missing the field stay readable.
- Display contract: the shared Execute renderer collapsed shows only the command summary and status; live preview and final output render only inside expanded details, which show body text only — no truncation notice and no full-file entry. Preview body keeps the last 100 lines, the viewport shows at most 5 lines, and the terminal state clears progress. The CLI's 5/100-line preview and line/byte-count events are unchanged. TUI is out of scope.
- The replayable-only `progress` recovery field is not reused; delivery uses the existing row delta/snapshot. Desktop continuous adds no recovery queue; mobile replayable does not bypass gap/snapshot.
- Acceptance supplement: real >64 MiB output verifies full retention, head summary, tail sentinel; preview covers empty output, no trailing newline, CRLF, over 100 lines, partial tail window, monotone estimates, and late terminal state. V4 covers both profiles, terminal cleanup, and subagent isolation; Desktop BG14 uses segmented output and a release barrier to verify collapsed-no-output, expanded live preview, no counters, and terminal cleanup.
- The execution capability lives in the zcode-cli runtime/tool/execution adapter; the shared protocol adds the optional bounded outputPreview and a `bash_output` result display; Desktop reuses the shared Execute renderer with semantic colors and narrow-screen wrapping, adding no client-specific transport. Desktop continuous and mobile replayable task-command/snapshot boundaries are unchanged; background completion still flows through the runtime command queue with no concurrent `executeTurn` entry.

## Foreground output viewport and following (2026-09-10)

- Expanded output takes its natural height, showing at most 5 lines (including wrapped); beyond that it scrolls. Running and terminal states share the same container and line height; short output is not given fixed height.
- Foreground and background output scroll areas reuse the shared `ScrollFadeViewport` (extracted from the existing feedback scroll component) with 24px top/bottom fades. The CSS mask is fixed to the scroll viewport edge and fades text crossing it; it does not scroll with the body. Only the end with hidden content fades: short output has no mask, top position fades only the bottom, bottom position fades only the top, middle fades both. The mask applies to the body only — never covering the command or background top status/floating actions — and adds no polling or change to the existing following state.
- First preview keeps the ~2-second subscription delay and the shared 1-second tick; the UI updates on every new bounded preview, with no frontend timer, no output accumulation cache, and no model requests. No content change is promised when there are no new bytes.
- Default is stick-to-bottom: content replacement, tail-window eviction, wrapped-line count changes, and programmatic scrolling never cancel following. After the user scrolls up off the bottom, the current bounded text and reading position freeze; scrolling back to the bottom applies the latest text and resumes following, with no "back to latest" button.
- At the end, at most 5 lines still show; the following state shows the final summary, the paused state keeps the text being read, and scrolling back to the bottom shows the final summary. Collapse/expand reuses the details-unmount semantics; re-expanding starts from the latest content. Foreground adds no "Full output" path, truncation notice, or other extra areas.
- The UI-local following state is owned by the single output component; CLI files, shared polling, V4 row updates, background queries, Stop/notification, and the desktop continuous / mobile replayable delivery boundaries are unchanged. Shared UI uses the existing theme tokens, i18n, and narrow-screen wrapping with no client-specific path.
- Scroll handling stays a simple in-component check: on output update, stick to bottom only while following and record the real position; in `scroll`, leaving the bottom upward pauses, reaching the bottom (8px tolerance) resumes. No input-intent expiry, layout guard timer, or shared scroll hook. Known boundary: a window resize where the browser clamps to the bottom can still falsely resume; that case is not covered.

```text
file -> shared 1s poll -> V4 row -> latest text
                                   | following -> display latest -> scroll bottom
user scroll up --------------------+ paused -> frozen text
user scroll to bottom -------------+ following
terminal --------------------------+ same 5-line limit; preserve paused text
viewport scroll/resize ------------> shared fade mask (no change to following state)
```

Acceptance reuses BDO07: real segmented file output records write/DOM-update times, covering short-output auto-height, multi-line max 5 lines, per-segment update while following, freeze after user scroll, resume on scroll-to-bottom without a resume button, no rendering while collapsed, and the same line cap for running/terminal. Component unit tests cover programmatic scroll from a shorter tail window not falsely pausing, terminal-state pause, and isolation across tool instances; BGV background details regress as an invariant. Verified on macOS / Node 24.14.0 (top/bottom fade verified with a real window: CSS mask effective, overflow/edge/middle directions correct, update and pause/resume unchanged). Windows/Linux Desktop and real mobile remote UI were not run.

## Shared foreground progress polling (2026-09-08)

- Within one Node process, Bash calls sharing the same `progressIntervalMs` share one progress interval; the product default is 1000ms everywhere, so foreground Bash of the main session and same-process subagents has a single poller. Different processes manage their own. Internal tests/adapters with custom cadences group by cadence; the shortest cadence never polls all tasks.
- Each Bash keeps the ~2-second subscription delay; after registering, it reads on the shared poller's next tick. The first task still gets its first preview in ~3 seconds; later tasks join the existing tick without restarting other tasks' timers.
- Each subscription independently maintains in-read state and line estimates and reads at most 4 KiB per tick, concurrently. A slow read blocks no other subscription and never stacks onto its own; a read or callback failure never kills the shared poller.
- Terminal state, Stop/cancel, or going to background removes the subscription and cancels the pending delay; repeated stops are idempotent; late read results publish no progress; cleaning an old subscription never affects a re-registered one. The last unsubscribe clears the interval and registry.
- The shared poller keeps subscription state only and never caches output bodies; the timer is unref'd. The size watchdog keeps its per-task 5-second cadence, never merged with progress scheduling. File flags, raw-byte direct writes, head summary, retention policy, protocol, and UI are unchanged.

```text
foreground delay -> subscribe -> shared interval (same process/cadence)
                                  +-> file A tail -> preview A
                                  +-> file B tail -> preview B
exit / background / cancel -> unsubscribe
last unsubscribe -> clear interval and registry entry
```

Acceptance: fake timers verify one interval for many subscriptions, joining without resetting ticks, one task exiting not affecting others, full exit releasing the timer, repeated cancel/resubscribe, slow-read/failure isolation, late-result discard, and custom-cadence isolation; real-file tests verify concurrent BashFileOutput registration and reads and background handover with an independent watchdog. Windows/Linux real-machine tests and performance comparison were not re-run for the shared scheduler; the earlier cross-platform direct-write verification remains the evidence for file flags/output implementation.

## Desktop Bash summary body (2026-09-10)

- Reason: the terminal V4 row reuses the model summary body, and BashOutput's stdoutTruncated/stderrTruncated and canonical file path had no dedicated display projection; model envelope or protocol head/tail truncation cannot replace the Bash facts.
- A strictly validated `bash_output` branch is added through the existing `ToolResult.display -> ToolOutput.display`: `output` is the bounded head body (default 30,000 bytes; combined display at most 150,000 bytes), `truncated` is the real truncation flag, and `outputPath` is the optional full output file path. Only a normal terminal-state Bash with partial output or a retained file produces the branch; background starts and image results keep their existing display; no provider envelope parsing and no length-based truncation guessing.
- Foreground expanded shows the output body only, with no "Full output" file entry, truncation notice, or counters. Old rows without display keep the original body. `truncated` and `outputPath` stay in the existing protocol; the CLI's summary/full-file policy and the background details file entry are unchanged.
- The running state keeps up to 100 lines of bounded body with the viewport showing at most 5 lines; collapsed shows no body; background and terminal states clear the running preview.
- No change to provider-visible content, execution/retention policy, or TUI; the optional display flows through the existing continuous/replayable row delta and snapshot, adding no recovery queue and bypassing no recovery boundary.

```text
BashOutput (bounded head + truncation + file path)
  -> ToolResult.display.bash_output -> V4 output.display -> Desktop
       +-> head text
       +-> no additional notice or file link in foreground details
```

Acceptance: unit tests cover both file/no-file and truncation metadata producing no extra UI, and terminal/history body compatibility; protocol and dual-profile projection unchanged. BG14 uses a barrier: progress has no counters, and after release the output exceeds 30,000 bytes, verifying that only the head body shows while the provider still receives the full file path and the file tail is complete. The model still receives the original persisted-output short summary; Desktop uses its own default 30,000-byte head.

## CLI completion (2026-09-08)

- The normal foreground 64 MiB artifact truncation is removed; the CLI events/projection for the 5/100-line preview and the estimated total lines are complete; Desktop rendering and BG14 verification are retained; the TUI is unchanged; TaskOutput read direction and process lifecycle are unchanged.
- A real 65 MiB + 8 bytes output verified full length, 30,000-byte head summary, and tail sentinel; macOS/Linux Node 24 and Windows Git Bash/CMD (Node 24 and 25) all pass.
- Real 5 GiB writes were not repeated and performance was not re-measured; the 5-second soft threshold and boundaries are locked by regression tests.

## Acceptance and performance

- Flag tests cover darwin/linux/win32: pre-seeded files prove POSIX append and Windows truncation and that POSIX symlinks are not followed; foreground/background commits open the file exactly once. The old Windows append failure is kept as a negative control, reproducible with `apps/zcode-cli/packages/adapters/tests/fixtures/bash-windows-flags-probe.cjs`.
- Segmented barriers prove readability before exit; coverage includes no trailing newline, Chinese and spaces in paths, stdout/stderr, binary, and concurrent descendants. Lifecycle covers foreground/explicit/timeout promotion/subagent, parent abort/Stop, and single notification; for root-exits-first cases the test cleans up descendants, and terminal-state file stability is no longer asserted.
- Controllable clocks and file sizes verify watchdog cadence, at/over threshold, terminal-state races, and read/cleanup failures.
- Real adapters verified on Windows Node 24.14.0 + Git Bash/CMD with Node 25 as control; macOS/Linux use their append flags. Cross-platform direct-write results (macOS arm64 / Linux arm64 / Windows x64, 8–16 tests per platform) and Desktop formal replays (9 runs, 8 scenarios: auto/explicit background, live persistence, single completion notification, Stop, background unbinding parent abort, foreground Bash/subagent loading, hard timeout, nested background Bash child cleanup) pass. `pnpm typecheck`, `pnpm lint`, and the conversation coverage audit pass.
- Real tests never filled 5 GiB or the disk: thresholds and races use controllable sizes/clocks, and the lost-output diagnostic uses fault injection. Not covered: Windows arm64, every Git/MSYS version, real mobile remote-control reconnect. The App–Agent schema and desktop continuous / mobile replayable routing were not changed.

Performance benchmark: `apps/zcode-cli/packages/adapters/tests/fixtures/bash-output-benchmark.cjs`; each sample launches an isolated parent Node with warm-up and GC, 256 MiB output per task, concurrency 1/4, at least three runs each, old/new alternating (old = collector implementation at `65ed641886`). Direct writes cut the parent Node's output-processing peak RSS delta by ~99.3%–99.8% (from 78–377 MiB to 0.3–1 MiB across hosts and concurrencies) and clearly reduce CPU. This is not a 99% total-Agent memory claim, excludes child processes and OS file cache, and does not promise better total execution time — the macOS 4-concurrency median wall time rose ~30% in the pre-truncation-removal comparison. Raw samples: `.tmp/bash-direct-file-validation/{windows,macos}-memory-results.json`.

Full history: git show f26734ad:docs/bash-background-parity.md
