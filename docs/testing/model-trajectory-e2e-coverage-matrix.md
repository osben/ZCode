# Model Call Trajectory E2E Coverage Matrix

This document defines the end-to-end acceptance semantics of the Model Trajectory Viewer. The
coverage threshold is computed over the fixed range
`1f015ca1726a4e1f932c6e87b8b7ce64623317af..f5ce7b4b360eaec0a396b55f1e2ad36586ecd837`, aggregated
over executable TypeScript/TSX changed lines attributable to the call-trajectory capability, with a
target of at least 95%. The attribution set is fixed to `3e00cec9d0`, `bfcef0c9c4`, `1d434a6dda`,
`65156894ac`, `274ebbd8f4`, `f5ce7b4b36`, corresponding to native scrolling, reasoning persistence,
tool metadata projection, trajectory UX, content search and bounded tail reading. Unrelated changes
that entered staging in the same period (provider, media, settings, generic task action tracing)
must not enter the denominator. Pure docs, test code, translation dictionaries and pure CSS are not
in the executable-line denominator, but the matching visuals and copy must be covered by E2E
assertions. Renderer uses Istanbul coverage; Desktop host / CLI use V8 coverage. The default
expansion of `094ac1c5a1` is current behavior after the upper bound; E2E keeps a regression
assertion for it but it is not in this fixed denominator.

## State Dimensions and Pruning

| Dimension    | Accepted states                                                                | Pruning                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Data         | records, `error-text`, record error; complete records and old-format compatible records | The Pane's loading/empty/read-error are existing generic states and are not in the changed-line E2E of this UX refactor; JSONL projection semantics are vendor independent |
| Content type | System, User, Reasoning, Assistant, Tool Call, Tool Result, record error       | No Cartesian product of the six kinds; covered in one composite fixture                                                       |
| Expansion    | default expanded, single-row collapse, all, custom types, overflow body        | The same toggle assertion is not repeated per row                                                                             |
| Search       | no result, one result, many results, previous/next, hit in a collapsed row, hit outside the virtual area | Case and whitespace normalization is covered by unit tests; E2E verifies the product chain                        |
| List         | short list, long virtualized list, dynamic height after expansion              | Not rerun per fixed record count; the long list represents the scale boundary                                                 |
| Viewport     | Desktop standard width, narrow side pane                                       | `/remote` creates no new Agent runtime; shared-host compatibility is covered by components and existing remote regression      |

## Accepted Cases

| ID    | Setup                                                                                                   | Action                                                              | Assertions                                                                                                                                                                                                                           | Automation merge                                         |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| TRJ01 | A real main-turn creates the task/session; first read the model-io the CLI actually wrote, then append deterministic records covering the six kinds | Pin `zh-CN` explicitly, then open the call trajectory from the real task context menu | The CLI record contains main-turn response/reasoning; the Host reads the current task file; source, finish reason and the six kinds are projected correctly through stable semantic attributes; representative Chinese copy, token, duration, tool name/id are correct; functional assertions do not depend on English display text | live writer/host-read spec |
| TRJ02 | Inject compatible JSONL: full -> delta, top-level tool metadata, `error-text`, record error             | Open the trajectory and expand the error row                        | After delta restore the added user is visible and the old assistant is not repeated as Input; tool name/id are separate; the error summary takes the value; expanded state uses the destructive style; the record error is visible       | fixture projection spec                                  |
| TRJ03 | Composite content with normal and very tall bodies                                                      | Verify default expansion; click the whole row to collapse/expand, copy, expand/collapse the overflow full text | Default expanded; the whole row collapses and restores; copy only when expanded; the tall-body mask and centered expand pill work; line breaks preserved                                                         | interaction spec                                         |
| TRJ04 | All six kinds present                                                                                   | Expand/collapse all; toggle Reasoning and Tool Result separately in the menu | Bulk state takes effect immediately; the two custom toggles affect only the target kind; the later command overrides old single-row overrides                                                                                       | interaction spec                                         |
| TRJ05 | Generate multi-call data above the virtualization threshold with rows of different heights             | Scroll to the middle, expand a row with a stable key, scroll it out of the mounted window and back | Only records near the window render; dynamic height measurement does not overlap; header sticks; expansion state survives a real unmount/remount                                                                                  | virtual/search spec                                      |
| TRJ06 | Several hits spread over rendered records                                                               | Search, previous/next, close search                                 | Total and index correct; active hit and ordinary hits are styled differently; navigation does not flicker; after closing, highlights clear and the user's expansion state is restored                                                | virtual/search spec                                      |
| TRJ07 | The only hit is in a collapsed body outside the virtual window                                          | Search and navigate to the hit                                      | The target record scrolls into view, the row auto-expands, the hit is highlighted and centered                                                                                                                                      | virtual/search spec                                      |
| TRJ08 | Narrow side pane with full tool name/id                                                                 | Narrow the Desktop renderer                                         | No horizontal scroll; tool name complete; the right edge of the visible action column is within 2px                                                                                                                                  | narrow-layout spec                                       |
| TRJ09 | Create a sparse model-io above 32 MiB, with a complete recent record appended at the tail               | Refresh the call trajectory                                         | The Host reads only the bounded tail, drops the partial line at the start, keeps the recent record, and shows a truncated notice                                                                                                      | bounded-tail spec                                        |
| TRJ10 | TRJ01 setup with the trajectory tab open                                                                | Close the tab, reopen from the `+` launcher                         | The launcher offers the trajectory entry bound to the active task after the tab is closed; reopening remounts the timeline for the same task without the task context menu                                                            | interaction spec                                         |
| TRJ11 | A real task appends a call record with 100 inputs (the first has a 20 KB segment), collapsed by default and mounting only the first page | Expand the first row with the oversized segment, search for the 90th hit, click “显示接下来” (show next) | The first page of 40 rows is collapsed; the oversized segment shows “Truncated at source, N bytes”; on a hit only a window of page plus 20 rows (60 rows) mounts, with the gap “显示接下来 40 of 100”; clicking mounts exactly 40 rows (100 rows total) | Window and labels are covered by `resolveInputRowWindow` and CallCard unit tests |

## Trajectory v2 cases

Spec: `specs/model-trajectory-v2.md`. Automation:
`packages/desktop/test/e2e/conversation-session/conversation-session-model-trajectory-v2-viewer.test.ts`.
v1 cases TRJ01-TRJ11 stay unchanged.

| ID    | Setup                                                                                                                                                                                                                                                              | Action                                                          | Assertions                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TRV01 | Live main turn: thinking stream, a real `Bash` tool_use, final text                                                                                                                                                                                                | Open v2 from the task context menu                              | Live model-io records carry `timing.timeToFirstContentMs`; the v1 entry still exists and both tabs coexist; summary values; ledger shows user, request, assistant and `Bash {command…} → preview`; tool Timing tab shows scheduled and execution times from the live `tool_usage`; request Timing tab shows TTFT |
| TRV02 | Seeded records: two catalogs differing by one tool, cached system blocks, effort and `max_tokens` changes, usage with cache write and reasoning, a compact call, a legacy record without body or timing                                                            | Select request, tool and legacy rows                            | Separator chips show the deltas; Payload shows tool count, KB and breakpoints; Schema shows the call-time definition; legacy values render "—"; compaction marker present; context % shown for a known model and hidden for an unknown one                                                                       |
| TRV03 | TRV02 data                                                                                                                                                                                                                                                         | Drag on the strip, clear, click a span, refresh, Ctrl+wheel     | Ledger filtered to the range (data attributes); clearing restores it; clicking a span selects its row; the range survives refresh; Ctrl+wheel on the strip is default-prevented and zooms the axis                                                                                                               |
| TRV04 | 150 seeded calls                                                                                                                                                                                                                                                   | Scroll; ArrowUp/ArrowDown                                       | Mounted rows stay under the threshold; selection and inspector follow; the selected row scrolls into view                                                                                                                                                                                                        |
| TRV05 | TRV02 data with a selected row                                                                                                                                                                                                                                     | Append a record, refresh                                        | The ledger root never unmounts; state goes ready → refreshing → ready; new rows appear; selection kept                                                                                                                                                                                                           |
| TRV06 | v2 tab open                                                                                                                                                                                                                                                        | Close it; reopen from the `+` launcher and from the header menu | `data-side-pane-open-tab-item="model-trajectory-v2"` reopens v2 for the active task; the header menu entry opens v2                                                                                                                                                                                              |
| TRV07 | Narrow renderer                                                                                                                                                                                                                                                    | Select a row                                                    | Single column; drill-in with Back; no horizontal scroll. The mobile bottom sheet is covered by render tests; `/remote` is pruned as for v1                                                                                                                                                                       |
| TRV08 | Seeded records: a `Skill` call with its result, `mcp__github__get_pull_request` and a second MCP server, a `Write` under `…/memories/projects/x/memory/`, a delta with the `MEMORY.md` index and a recall attachment, `project_memory_recall` and `dream` sidecars | Click each filter chip; select a skill, MCP and context row     | Rows carry `data-trajectory-v2-category` and badges; chips show counts (memory reads/writes, MCP servers) and filter to one category; memory sidecar markers show with sidecars hidden; strip has category colors and a memory lane; summary lists skills, memory counts and MCP servers                         |

## Coverage Responsibilities

| Layer                 | E2E responsibility                                                   | Supplementary tests                            |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| CLI writer            | TRJ01 verifies reasoningText is actually persisted                   | runner unit verifies extraction and bounded append |
| Service projection    | TRJ01/TRJ02 verify file read, delta, tool/error metadata end to end  | modelTrajectory unit covers bad lines and limit |
| UI rendering          | TRJ01-TRJ04/TRJ08                                                    | pure formatter and expansion-state unit tests  |
| Virtualization/search | TRJ05-TRJ07                                                          | pure search/highlight logic unit tests         |

## 95% Audit Rules

1. Set `ZCODE_E2E_COVERAGE=1` when running the trajectory E2E.
2. After merging Renderer Istanbul and Node V8 reports, select only the relevant executable changed
   lines inside the fixed range introduced by the trajectory commits above; attribute by blame at
   the target revision, and take TS/TSX executable lines from Babel/Istanbul statement start lines.
3. Every case must have setup, action and assertion; merely passing through code does not count as
   semantic coverage.
4. If the aggregate is below 95%, first add cases/assertions with product meaning; coverage must not
   be faked with assertion-less calls.
5. Finally run `typecheck:e2e`, root `typecheck`, `lint` and the fixture check together.

## Execution Evidence

2026-08-24 (historical): formal case `conversation-session-model-trajectory-viewer.test.ts` ran
TRJ01-TRJ08 as one real Desktop/host chain, passed manual review and the formal admission audit;
changed-line hits were 1382 / 1437 (96.17%), CLI new lines (27) counted conservatively. This
predates the bounded-tail reading fix of `f5ce7b4b36`, so it proves only the coverage of the UX
refactor then and is not final proof of the current 95% threshold.

2026-08-27 (current): formal case `conversation-session-model-trajectory-viewer.test.ts`,
TRJ01-TRJ09 in a single formal replay passed after a full rebuild (exit code `0`, first-time pass
rate `100%`). The case-local DeepSeek fixture and the common fixture are combined explicitly; the
case first lets the real CLI main-turn write model-io containing `response.reasoningText`, then
appends deterministic records and enters the Pane through the real task context menu. The same run
collected Renderer Istanbul, Host V8 and CLI V8. Fixed-revision blame and executable-line
intersection audit:

| Coverage source   | Hits / changed executable lines |   Coverage |
| ----------------- | ------------------------------: | ---------: |
| Renderer Istanbul |                       397 / 413 |     96.13% |
| Host V8           |                         37 / 38 |     97.37% |
| CLI V8            |                           6 / 6 |       100% |
| Total             |                   **440 / 457** | **96.28%** |

The CLI report lands in the compiled `runner-debug.js`; the generate/stream `reasoningText` and
`modelIOReasoningText` source lines were all hit in the same V8 report. The 17 uncovered lines are
mainly unreachable unreferenced old components, the copy-failure catch, the no-content fallback, the
unserializable-payload catch, and the scroll correction when a search range is already outside the
viewport; they do not affect the 95% threshold and no assertion-less calls were used to create hits.
