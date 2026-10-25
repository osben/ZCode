# Bash direct file output: E2E regression and change coverage

## Scope and measurement contract

Target commit: `9c99f9623c`. Production TypeScript changes between the parent and that commit are measured. Behavior follows what `docs/bash-background-parity.md` already confirms; tests do not change product semantics. Desktop uses `desktop-continuous`; the mobile `web-remote-replayable` recovery semantics are not mixed in.

```text
user prompt / Stop / output-path click
  -> Desktop V4 -> Host -> CLI handler -> execution adapter
                                      |-> same fd writes stdout/stderr
                                      |-> tail read for progress / head read for summary
                                      `-> 5 s size check / active stop kills the tree
  <- Desktop V4 <- projection <- tool result / background notification
```

Impact is limited to: Bash handler, execution adapter, tool result/progress projection, Execute renderer, TaskOutput/TaskStop. Adjacent Hook cases verify that the shared pipe collector did not regress. No new product state or feature-graph node is added.

| Entry                            | Authoritative state     | Required result                                               |
| -------------------------------- | ----------------------- | ------------------------------------------------------------- |
| Foreground Bash / subagent Bash  | CLI execution           | Raw file, summary, running progress, result after stop        |
| Explicit/timeout background Bash | CLI background registry | File keeps growing, TaskOutput, single notification           |
| Output-file link                 | Desktop code viewer     | Opens the real output path, runs no extra Bash                |
| Hook                             | Generic execution pipe  | stdin and stdout/stderr still delivered through the collector |

Measurement uses the four-domain report with `ZCODE_E2E_COVERAGE=1`; every report must be `complete=true`. Domains are counted separately (percentages are not merged); case pass rate and code hit rate are listed separately. The changed-line basis is **Istanbul statement start lines ∩ added/modified diff lines**; types, import/export, comments, blank lines and deleted lines are excluded. Multiple runs in one domain are unioned by source position, never by statement ID. CLI dist JS is first compared byte-for-byte (minus `sourceMappingURL`) with a fresh build from the same tsconfig, and the source map then maps back to original TypeScript. Code outside the collected source range is listed separately, not guessed as zero or covered.

## Accepted supplementary scenarios

All come from the existing Bash spec and confirmed behavior. Each scenario checks real file/process facts and the provider-visible result; UI scenarios also check the DOM. They use case-local replay fixtures and file barriers. New specs were verified in `manual-review/pending` first; after the 2026-09-08 user review the Bash output spec and the two Terminal specs were promoted (promotion is not adding them to a Docker preset).

| ID    | Setup / Action                                                                                                                                                                                     | Assertions                                                                                                                                                                                                                                                  | Status   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| BDO01 | Script at a Chinese path with spaces; stdout/stderr without newline; small output and empty output / non-zero exit                                                                                 | Both streams merged, encoding intact, exit code not lost, small output file cleaned up                                                                                                                                                                      | accepted |
| BDO02 | Normal foreground output over 64 MiB                                                                                                                                                               | Full file kept, 30000-byte head summary, complete tail; foreground shows body only, no hint or file entry                                                                                                                                                   | accepted |
| BDO03 | Two independent sessions' foreground Bash each produce multi-line output over 4 KiB; finish one, then advance the other                                                                            | Expanded preview bounded, the other task keeps updating, collapsed shows no output, no preview left in terminal state                                                                                                                                       | accepted |
| BDO04 | Background Bash with segmented output; TaskOutput twice while running, then query after natural exit                                                                                               | While running: head read, repeatable same prefix; terminal: tail read; file not truncated                                                                                                                                                                   | accepted |
| BDO05 | Foreground/background each really write exactly 5 GiB, cross a check cycle, then write 1 byte                                                                                                      | Equal to threshold stays running; strictly greater makes the watchdog terminate; the real producer exits, result keeps the output-limit diagnostic; background notifies once; the structured 137 assignment is verified separately by execution-layer tests | accepted |
| BDO06 | Ordinary Bash deletes its own output file while running then exits; output path is a directory at preparation                                                                                      | Read failure has a clear diagnostic; open failure visible; next Bash runs normally                                                                                                                                                                          | accepted |
| BDO07 | One foreground Bash writes three newline-free chunks to stdout/stderr through a file barrier; expanded state updates for the first two, collapsed while the third is produced, then expanded again | Each chunk updates the file and the expanded preview first; the producer is still alive, the tool still `in_progress`, no final `tool_result`; the process exits only on the last release; result contains all three chunks and progress disappears         | accepted |

### BDO07 live refresh sequence

"Real time" means second-level updates while the command runs. The child writes the output fd directly; the CLI waits about 2 s, then subscribes to the shared 1 s poller, tail-reads 4 KiB (bounded) each time, and pushes through the existing progress/projection to Desktop. Per-byte push is not promised and the child's own user-space buffering is not bypassed. The test producer writes the fd directly and does not rely on newline flush.

```text
producer writes chunk 1 -> ready -> file + expanded preview updated, still running -> release 1
producer writes chunk 2 -> ready -> expanded state auto-refreshes, still running    -> collapse -> release 2
producer writes chunk 3 -> ready -> file updated, collapsed shows no body           -> expand again, sees new content -> release 3
producer exits          -> final tool_result contains three chunks -> terminal progress cleared
```

- Each release is written only after the matching assertion succeeds; if refresh fails the process does not exit on its own, so the test must not rely on final result backfill.
- The first chunk explicitly expands the card; the second stays expanded without clicking to verify auto-refresh; then collapse, the third chunk still lands in the file, the collapsed card must show no output, and re-expanding must show the new content. Foreground live refresh is accepted in expanded state.
- E2E wait budgets: 8 s for the first preview, 5 s for the next two (CI scheduling slack, not a product SLA). Latency from write to first file observation and first visible preview is recorded in the run artifact `bash-realtime-refresh.json`. The third chunk's preview latency includes the deliberate collapse and re-expand time and is not pure polling latency.
- UI is asserted by visible text; state and final result are checked via the tool block and the provider-visible `tool_result`. No progress events are injected and TaskOutput is not used to trigger refresh.

Execution notes:

- The large-file cases run sequentially; the test deletes the output files it owns and never fills the system disk. If free space is insufficient, record an environment block; an unexecuted 5 GiB scenario is never counted as passed.
- BDO uses the ordinary 128000-token E2E context window. Do not apply the pending default 240/80 compact fault injection, which would insert an auto-compaction (pruned from this group) between Bash/TaskOutput.
- The open-failure check inspects the model-visible system error diagnostic; it does not assume a start failure has a process exit code or a non-zero `is_error` mapping. Terminal Stop preconditions and terminal-state checks target the real Bash card: the current UI creates no parent group for a single Bash; parent-group counting for two consecutive commands is verified by the first case in the same spec.
- BDO02 waits for the body to be visible after expanding the long summary, confirming no truncation hint or file entry; the full file is verified via the provider result and file reading. BDO03 explicitly expands the card and waits for the preview text, and does the same after switching back to the session. The concurrent-progress case does not imply cross-session restoration of card expansion state.
- Mounted/visible does not mean the expand animation and scroll layout are stable; an empty WebDriver text in that window must not be read as missing product content.

## Regression list and boundaries

- Scope was narrowed by the user on 2026-09-08 to Bash behavior directly tied to `9c99f9623c`. An earlier 26-spec expansion selected by Bash keywords was too broad, was aborted, and is not the acceptance set or repair scope.
- Acceptance set: Bash foreground/background/subagent/stop scenarios in the background spec, Bash cancel in V4 background-work, Terminal output and terminal-state representatives, and the new BDO01-BDO06 cases. Generic Memory, Native Search, permission registration, fork, compact, CUA and subagent-config suites are not run.
- Uncovered lines of the generic pipe collector are verified only by one existing Hook lifecycle representative of the shared execution entry; the whole Hook suite is not expanded. Branches unreachable from the Bash product entry are listed separately.
- Windows-only taskkill/flags, duplicate unsubscribe not reachable from the normal product entry, delayed-callback races, and system ENOSPC/inode exhaustion cannot be claimed covered by macOS Desktop E2E numbers. Cross-platform real runs / low-level deterministic tests are kept as evidence and remaining uncovered lines are reported with reasons. Old-protocol compatibility validation is not forced from the V4 UI.

## Verification results (macOS / Node 24.14.0 / Electron)

The 2026-09-08 runs used the then "collapsed-state preview" display contract. Since 2026-09-09 output shows only when expanded (see below); the old "collapsed preview" results are not acceptance evidence for the new contract.

| Acceptance set                                             | Cases | Result  | Artifact run ID                   |
| ---------------------------------------------------------- | ----- | ------- | --------------------------------- |
| Existing `conversation-session-background.test.ts`         | 25    | 25 pass | `bash-coverage-baseline-20260908` |
| New BDO01-BDO06 (foreground and background limit one each) | 7     | 7 pass  | `bash-output-final-20260908`      |
| Terminal expanded result, single Bash Stop                 | 2     | 2 pass  | same                              |
| V4 Bash background-panel cancel                            | 1     | 1 pass  | same                              |

Both acceptance runs exited normally and all four domains had `coverage/summary.json` `complete=true`. 35 cases pass, 7 of them new; an outdated assertion in the existing Terminal Stop case that still waited for a single-tool parent group was corrected. Production source was not modified. The new BDO spec and the verified Terminal spec moved to the formal directory with user authorization, keeping case-local fixtures.

Promotion re-verification: isolated replay `bash-formal-isolated-r4-20260908` and default replay `bash-formal-default-20260908` both 9/9, exit 0, no missing provider fixture, each covering one real 5 GiB foreground and background boundary, no retries. The first three failing isolated rounds (`bash-formal-isolated-20260908`, `-r2-`, `-r3-`) are diagnostic only: they exposed a race reading visible text right after expanding, and a test querying the collapsed short preview while the long preview was shown. Tests now establish the expand/collapse precondition explicitly and wait for the actual text, with no production rendering change and no loosened line, byte or content assertions.

### Production changed-line coverage (commit `9c99f9623c`)

| Domain                                                            | Baseline        | Final               |
| ----------------------------------------------------------------- | --------------- | ------------------- |
| CLI (incl. shared execution branches and old-protocol validation) | 204/268, 76.12% | **212/268, 79.10%** |
| Renderer                                                          | 13/14, 92.86%   | **14/14, 100%**     |
| Host                                                              | 3/7, 42.86%     | 3/7, 42.86%         |
| Main                                                              | 3/7, 42.86%     | 3/7, 42.86%         |

Core files: `bash-file-output.ts` 80/83, `bash-output-preview.ts` 14/14, `bash-progress-poller.ts` 23/23; together **117/120, 97.50%**. These are changed-line hit rates under the stated basis, **not repository, branch or cross-platform coverage**. Edits to type fields, object properties and JSX attributes may have no new statement start line; their semantics are verified by product assertions. Host/Main misses are four old-protocol result-validation lines.

Machine-readable stats and the recompute script are in the final artifact:

- `packages/desktop/.e2e-artifacts/bash-output-final-20260908/coverage/bash-change-coverage.json`
- `packages/desktop/.e2e-artifacts/bash-output-final-20260908/coverage/analyze-bash-change-coverage.mjs`

### Changed lines not hit by passing Bash E2E

Adapter files are under `apps/zcode-cli/packages/adapters/src/exec/`; line numbers refer to the target commit.

| File                                          | Unhit lines                                                | Reason / evidence boundary                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash-file-output.ts`                         | 60, 194, 197                                               | Owned-file deletion on cancel-after-prepare / spawn failure; disk-capacity/inode exhaustion diagnostics. The host filesystem is not exhausted to raise coverage |
| `node-execution-adapter-lifecycle.ts`         | 40, 62                                                     | Standalone `start()` API; the ordinary Bash product entry uses foreground execution and the commit-background path                                              |
| `node-execution-adapter-process.ts`           | 127-130, 132, 134, 136-137                                 | Windows taskkill; macOS E2E cannot claim it                                                                                                                     |
| same                                          | 184, 188-193, 209-210, 213-215, 217, 229, 231-233, 235-236 | Retained generic pipe, stdin, drain paths that ordinary Bash now bypasses                                                                                       |
| `node-execution-adapter-run.ts`               | 192, 314                                                   | Cancel window after open completes, spawn error; supplemented by execution-layer deterministic tests                                                            |
| same                                          | 278-280, 284-287, 298, 300, 306, 312                       | Generic pipe progress / drain / collector close                                                                                                                 |
| `output-collector.ts`                         | 81-83, 88, 133, 141, 171                                   | Retained generic collector branches; ordinary Bash no longer creates a collector                                                                                |
| `packages/shared/src/zcode-protocol/index.ts` | 141, 144-146                                               | Old-protocol result validation; the V4 Desktop entry does not trigger it. Unhit in CLI/Host/Main                                                                |

The existing `HK-LC-01`, chosen only for the shared pipe, completed its stdin/output and provider-visible Hook context assertions in `bash-output-compat-r5-20260908`, then failed because the UI shows `Hooks` in English while the old test hard-codes `钩子`. It is not counted as passed and is **not merged into the acceptance coverage above**. Counting only the extra hits from that trace, CLI would be 231/268 (86.19%); this number only locates remaining branches and does not replace passing E2E evidence. The unrelated Hook i18n assertion is not modified here.

### Checks and rerun commands

`pnpm typecheck`, `pnpm lint`, Desktop `typecheck:e2e`, fixture check and the conversation coverage audit passed (lint: 43 pre-existing warnings, 0 errors, none in new files). Replay helper unit tests: 14 pass, 1 platform skip; 6 Bash adapter contract test files: 35 pass (flags, cancel races, 137/output_limit, progress scheduling, process cleanup; not counted in E2E coverage). The only fixture-check notice is that response-only `E2E_BDO_QUERY_NOTIFIED` is not an input matcher; the real notification matcher and completion assertions pass.

Run both formal specs from the repository root (10 cases with BDO07; no global preset):

```bash
ZCODE_E2E_COVERAGE=1 \
pnpm --filter @zcode/desktop test:e2e -- \
  --spec ./test/e2e/conversation-session/conversation-session-bash-direct-output.test.ts \
  --spec ./test/e2e/conversation-session/conversation-session-terminal-expanded-details-and-status.test.ts
```

For isolated replay, set `E2E_PROVIDER_REPLAY_FIXTURE_PATH` before the same command to
`packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-bash-direct-output.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-terminal-expanded-details-and-status.json`.
V4 background-work evidence takes only the single Bash cancel case; other scenarios in that file are not counted.

The final run reused the same workspace's completed Desktop/CLI build under the same coverage config and ran `wdio run wdio.conf.ts` directly with `ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1`; the first regression and the regression after the test-config fix went through full builds; no other checkout's artifacts were used. Windows/Linux Desktop E2E, mobile replayable and TUI were not run.

Rerun only the new case (keep the wrapper's HOME/artifact isolation; do not add an extra `--` or grep is ignored):

```bash
pnpm --filter @zcode/desktop test:e2e \
  --spec ./test/e2e/conversation-session/conversation-session-bash-direct-output.test.ts \
  --mochaOpts.grep BDO07
```

### BDO07 observed latency (2026-09-08)

Isolated real-Electron replay `bash-realtime-targeted-r2-20260908`: 1/1 pass. First-observation latency of the raw file per chunk was 36/80/84 ms; first visible preview 2994/898/708 ms. These are one-machine observations (including E2E polling overhead), not fsync durability latency or a cross-platform guarantee. At each observation the producer was alive, the tool running, no `tool_result`; after the final release the result was complete and progress cleared; main-model requests totaled two (tool call and result continuation), with no TaskOutput or extra prompt. The default-replay full-group run `bash-realtime-regression-r2-20260908` passed the same spec **8/8**, no missing fixture (BDO07 file latency 85/92/107 ms, preview 3098/866/478 ms). The earlier group run `bash-realtime-regression-20260908` was 7/8 (BDO03 queried only the short preview after switching back while the card was expanded) and does not count; BDO03 now performs the collapse precondition after switching back, and card expansion-state restoration is not part of the concurrent-progress contract. Evidence is in each run's `test-results.ndjson` and `bash-realtime-refresh.json`; the production changed-line coverage above is not recomputed. macOS Desktop only.

## Current display contract: output only in the expanded area (2026-09-09)

The collapsed-state preview had been added by `9c99f9623c`: `ToolLayout.collapsedContent` bypassed the details area, and the final truncation hint and file path were also rendered outside the details. At the user's request that dedicated entry is removed: preview, final body, truncation hint and file link all live in the existing expanded area. Collapsed state shows only the command summary and status; the expanded area keeps updating live. CLI file writing, polling and protocol fields are unchanged.

Spec and assertions were updated first; before the fix the UI tests reproduced both problems (collapsed running preview, terminal-state hint still rendered); after the fix 3 related UI test files pass 16/16. Real Electron isolated replay `bash-expanded-only-20260909`: BDO02, BDO03, BDO07, BG14 pass **4/4**, no retry, exit 0, four-domain coverage `complete=true`; only the common, Bash direct output and background case-local fixtures were loaded.

- BDO02: terminal collapsed state renders no body, hint or path; expanded shows head summary, truncation hint and a working real file link.
- BDO03: two independent sessions keep updating while expanded, no output when collapsed; one task finishing does not affect the other's progress.
- BDO07: first two chunks auto-refresh while expanded; while collapsed, crossing one real progress poll still yields no output node; re-expanding shows the third chunk; collapsing again after the final result still shows no output node. Observation latencies: chunks 1-2 file/preview 159/3374 ms and 78/595 ms; chunk 3 90/1562 ms (includes deliberate collapse and re-expand).
- BG14: collapsed shows no preview, expanded shows multi-line output, foreground loading and terminal cleanup remain normal.

Root `pnpm typecheck`, `pnpm lint`, Desktop `typecheck:e2e`, both fixture checks and the conversation coverage audit passed (lint: 43 pre-existing warnings, 0 errors; fixture check keeps the existing response-only marker notice). Machine-readable evidence is in the run's `test-results.ndjson`, `bash-realtime-refresh.json` and `coverage/summary.json`. The shared UI component keeps the same expand boundary; Desktop continuous and mobile replayable message chains are unchanged. Mobile, Windows/Linux Desktop and TUI E2E were not run.

## Replay dynamic background ID

A case-local fixture can reference `{{latestBashTaskId}}`, the real Bash task ID from the last `Command running in background with ID: ...` in the current provider request, for TaskOutput/TaskStop. It consumes only existing model-visible tool results, never fakes runtime/task registry state; with no ID the token stays unreplaced so a missing precondition surfaces explicitly. The existing `latestAgentId` stays independent.
