# Background Bash output details

## Contract

A background Bash entry can open a right-side `bash-output` tab; the same workspace scope, root session, actual session, and workId reuse the tab. Tabs live in memory only and are not restored to a new runtime. The entry inside a subagent reads the child session's own Bash; no background task directory is copied to the root session.

```text
Bash -> canonical output file
                 ^
visible selected tab -> scoped service -> V4 readonly query -> runtime -> execution port
                 |
                 +-> current status + bounded tail (8192 raw bytes)
```

- Opening or reactivating queries immediately, then once per second, at most one request in flight. Hiding, switching workspace, or closing stops querying and discards late results; closing does not cancel the task.
- Scrolling up freezes the current view while still fetching the latest tail window and status; at most two bounded texts are held — the frozen window and the latest window. Scrolling manually back to the bottom (existing 8px tolerance) or clicking the floating down arrow queries immediately, resumes following, and hides the arrow.
- After the terminal state is confirmed, read the tail once more, then stop polling and keep the tab. No jumping while the user pauses reading.
- Empty file and read failure are strictly distinct; a failure keeps the last successful content, stops polling, and offers retry.

Display:

- A plain-text output area with a Bash-style background; a light status hint only while running. No command header, elapsed time, stop button, line count, or byte count; stopping keeps the original background entry's control.
- The top status bar shows only the running state and the full-file link, justified with space-between: status left, link right (reusing Code Viewer), both in the same subdued text color. No hint about the tail window omitting older content; identical in Chinese and English. The link stays right after the task ends or the bar wraps on narrow screens; the path uses the tab's frozen workspace. The 8 KiB tail read and full-file retention contracts are unchanged.
- While following is paused, a circular down-arrow button floats at the bottom center of the output window, reusing the conversation "回到底部" (back to bottom) size, outline style, and theme tokens. The button takes no space in the status bar or body layout, sits outside the mask, is icon-only, and its accessible name and title use the existing "回到底部" translation.
- Clicking it runs the existing resume: query the latest window immediately and resume following; no second scroll/query state machine.
- The body scroll area reuses the shared `ScrollFadeViewport` 24px top/bottom fade (extracted from existing feedback components), fading only the end that still has hidden content. The CSS mask is fixed to the viewport edge; text fades as it scrolls out, and the mask does not scroll with the body. No fade without overflow; at top/bottom, the first/last line stays visible; in between, both ends fade. Scrolling or resizing updates the mask without changing the pause/resume/query/terminal contracts. The mask never covers the status bar, file link, or floating button and respects shared UI themes and mobile layouts.
- Both foreground and background restore the component's simple scroll-position check; accidental resume on resize remains a known issue — boundaries in [Foreground output viewport and following](bash-background-parity.md#foreground-output-viewport-and-following-2026-09-10). Hidden details do not query.

```text
top: running                              full-file link
output viewport -> scroll up -> paused -> floating down arrow
                                          | click / scroll to bottom
                                          v
                            existing resume -> latest output -> follow bottom
```

## Read-only boundary

- New `v4/conversation/backgroundBashOutput`; the request carries only sessionId/workId. The service layer injects the trusted connection and routes by workspaceIdentity/remoteSessionId. The execution layer fixes the tail read at 8192 bytes, reuses Bash decoding, and accepts no user-provided file path or read limit. The runtime's delegated execution record validates the Bash type, owning session, and background identity.
- A success response contains only kind, workId, status, output, truncated, outputPath; it does not re-transfer command text, start/end time, exit code, or file size — none of which the details display. Execution records keep only the Bash type marker, no command text for queries.
- Errors distinguish unavailable/unsupported/read_failed. Record status before reading, so a terminal response never carries a pre-exit tail window.
- Required app facade methods call through directly; the optional execution capability and old protocol boundaries still return unsupported.
- Desktop Host success-poll RPC logs go through the existing debug logger and are not persisted in normal runs; failures keep the existing warn path; other RPC log levels are unchanged. No new log protocol or config.

- Output encoding is resolved once by the execution adapter's `run()` after the cancel check; the task record keeps only that resolved value for foreground/background switching and terminal-state details. Windows `chcp` is never re-executed at record creation or query time. Records hold no collector or full output buffer; direct file writes and bounded reads are unchanged.

- Observation reuses the existing-only runtime: it starts/resumes no session, changes no notification consumption state, and makes no model requests. After a terminal state disappears from the active list, the existing execution/runtime record stays queryable; if a record is unavailable, that is reported explicitly.
- Body text never enters snapshot, event log, or persistence. Existing TaskOutput, foreground progress, platform flags, the 5 GiB/5-second watchdog, explicit Stop/close kill-tree, and natural-exit contracts are unchanged.

- Desktop continuous and mobile replayable stay decided by attachment; queries create no topic/replay events. The shared Side Pane uses the existing overlay on mobile. TUI unchanged; the generic file service is not extended.

<a id="验收"></a>

## Acceptance

| ID    | Scenario                                                | Assertions                                                                                                                         |
| ----- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| BGV01 | Explicit background, two-segment barrier output         | Both segments seen before exit; repeated clicks reuse the tab; no new model queries; no success-poll logs persisted in normal runs |
| BGV02 | Timeout-to-background, over 8 KiB, multi-line output    | New tail visible, old head evicted, full file not truncated                                                                        |
| BGV03 | Scroll up, hide/activate, task completes                | Pause does not jump, returning to latest resumes; hidden means no queries; terminal state preserved, refresh stops                 |
| BGV04 | Multi-session/workspace, child session and remote scope | Requests always hit the frozen scope, no cross-output; foreign tasks/paths rejected                                                |
| BGV05 | Missing file, slow response, close, runtime exit        | Explicit errors keep last content; no overlapping/late updates; no runtime started                                                 |
| BGV06 | Observe details after Stop on the original entry        | Details have no Stop; the original entry cancel keeps terminal output and the process exits                                        |

Unit tests cover schema, runtime authorization, adapter real-file tail reads and encoding, tab isolation, and hook ordering. Desktop E2E uses case-local provider/file fixtures and barriers; BGV01–BGV06 were promoted to formal cases after a user-confirmed live demo (2026-09-10), replaying 7/7 on both common + case-local and default fixtures. Full history: git show 45f808f7:docs/background-bash-output-details.md.

### Sub-session execution ownership

A running subagent shares the ancestor execution port; the background execution record stays owned by that adapter and does not migrate when the child session finishes. After the child publisher is released, a normal session subscription can cold-resume an independent bootstrap record holding a new adapter — so an existing record is not necessarily the task owner. Output queries walk existing records from the requesting session along the persisted parentID, calling the existing readBackgroundBashOutput(workId, original sessionId) on each: continue to ancestors only on unavailable; output, read_failed, and unsupported return directly; no matching task returns unavailable. The query itself must not cold-resume.

- The execution record freezes the trace.sessionId at start; a query must match workId, the original sessionId, and the background Bash type together.
- No new owner index, task migration, or runtime retention; details stay fully read-only, extending neither command admission nor child-session stop capability.
- BGV04 keeps the output tab from the runtime entry, closes the child session details, waits for publisher release, expands the parent session's execution history, cold-resumes the child session through the Agent summary, and reactivates the existing output tab. Cold resume adds no historical background task directory.
- That case uses the real 120s grace / 60s cleanup cadence; WDIO wraps timeouts before the test body, so this spec alone configures a 360s outer budget — the in-case `this.timeout` is not enough — and product timers are not modified.

```text
child query -> live child adapter -> unavailable -> existing ancestor adapter -> output
                       every level validates task ownership by the original child sessionId
```

- The cold-resume owner regression is covered by adapter/runtime/bootstrap unit tests and gateway lifecycle tests; a real Node adapter probe returns output/running for the original workId before and after a new child adapter joins. `background-bash-cold-resume.json` (same artifact directory) records child/parent sessions, the original workId, request counts, and two new output segments; the case also asserts the producer stays alive until exit, queries add no model requests, and the final output is kept.

<a id="本轮验证2026-09-09"></a>

## Verification state and open boundaries

- Query convergence (2026-09-10): targeted unit tests for the trimmed response, Bash type validation, scope, hook, log levels, and optional capability pass; Desktop BGV01–BGV06 pass 7/7, with an added BGV01 assertion that successful polls during live refresh write no logs (0 background-output success-poll entries in a full Desktop log with 334 other RPC records). CLI cases re-run on Node 24.14.0 pass.
- Cross-platform real queries pass: macOS/Linux Node 24.14.0 (2/2 each), Windows Git Bash/CMD × explicit/timeout background on Node 24.14.0 and 25.9.0 (4/4 each) — tail eviction, Chinese/CRLF/no-trailing-newline content, terminal state, file deletion. Windows uses an isolated Node 24.14.0 in the test directory without switching the default Node 25.
- Encoding-reuse fix: regression cases reproduce duplicate parsing and pre-cancel probing; after the fix, real `chcp` counts are one call each for foreground, explicit/timeout background, and start, zero for pre-start cancel, and repeated detail queries never probe (macOS 5/5; Windows 10/10 per Node version; Git Bash/CMD).
- Staging integration preconditions: after the provider refactor's new draft-recovery build mode, BGV/BDO cases must set Full access explicitly after each new draft — setting it once in a suite-level `before` leaves the second case stuck at permission approval, which is not an output-refresh failure. This pins the existing lifecycle test precondition only and changes no product permission policy.
- Not covered: Desktop remote-workspace/mobile remote-control full UI E2E, Windows/Linux Desktop UI, Docker admission. Windows/Linux verification covers the real execution/query chain, not the full Desktop UI. Scope and continuous/replayable are verified by service unit tests. No codegraph existed; impact was checked against the actual call chain and feature graph.
