# Tool History Order Repair

2026-09-10, based on `origin/staging`'s `fa70e896834a88e17290739c54995437b03aceee`. Implementation scope: existing ToolPart writes carry a declaration index, provider history hydration selects the latest record per invocation, then restores the declaration order.

## Root Cause

`model.ts` accepts and deduplicates tool declarations, and live history submits calls and results in declaration order. Read-only tools can execute before the stream ends; SQLite's `part.sequence` is determined by the first write. The old hydration directly used the SQLite order, causing the model history for resume, edit/rewind, and fork to differ from live.

```text
Model declaration     Bash(0) ---------> Read(1)
Execution timing      Wait for finish         Pre-execute
First write           Write Bash later        Write Read first
live                  calls [Bash, Read] -> results [Bash, Read]
Old hydrate           calls [Read, Bash] -> results [Read, Bash]
Fixed hydrate         calls [Bash, Read] -> results [Bash, Read]
```

Real SQLite + controlled ModelFactory reproduced the inverted order before the fix: normal completions, tool errors, cold recovery requests after recoverable stream loss all differ from live; pure hydration ordering, error/interruption, and fork tests also failed first.

## Data and Behavior Contracts

- ToolPart adds an optional `declarationIndex?: number` at the top level, meaning the client-executed invocation order accepted by the runtime within the same assistant, starting from 0; repeated declarations and providerExecuted do not take up an index.
- The streaming path continues to use the deduplicated `acceptedToolCalls`; normal/recovery paths continue to use `coreToolCalls`. The index is written along with existing pending, running, completed/error states into part.data JSON.
- The sorting logic does not increase storage reads/writes, does not move write points, and does not add queues, awaits, partID registration, timeouts, or catch. `onStreamToolCall` still returns synchronously; pre-execution failures are still handled by the original catch's stream-end execution.
- Post-pre-execution-failure fallback and synthetic recovery continue the existing new-part behavior, retaining the same `callID` and `declarationIndex`; failing attempts' partIDs are not registered, passed, or reused.
- Model hydration selects the last newly created part within each assistant by `callID`, based on the original persistent order, not comparing update times or preferring successful states. When the latest part is pending/running, it uses the interrupted result; identical callIDs across different messages are not merged.
- The index is enumerated by the runtime; when all selected parts have indices, sorting is applied even with gaps; when all or partially missing, the original relative order of the selected parts is retained. calls/results share the same selection and sorting results.
- Does not change SQL sequences, original message.parts, UI transcripts, tool scheduling/permissions/cancellation/results. Does not change V4 protocol, desktop continuous, and mobile replayable boundaries.
- Fork continues to use existing part copying and ID remapping; numeric indices have no cross-message ID references, no new fork logic needed.
- Old versions can ignore this JSON field. Old versions rewriting the same part may lose the field; new versions are compatible with old record rules.

## Verification

- core `tests/tool-history-order.test.ts`: valid ordering, legacy/partially missing, multiple attempts for the same call, latest success/failure/incomplete states, cross-message isolation, gaps, unchanged original arrays, and fork callID remapping.
- core `tests/runtime-streaming-tool-part-identity.test.ts`: fallback success, failure, re-write failure, synthetic recovery, and late batch starts; original records can have multiple entries, but the model history has only one invocation and result.
- bootstrap `tests/tool-fallback-read-state.test.ts`: real SQLite and Read/Edit handlers; the same file first read by another Read, then modified by a Bash-like tool, finally read by the fallback Read; cold recovery and rewind keep the model history consistent; Edit uses the latest read snapshot for successful execution.
- bootstrap `tests/tool-history-order.test.ts`: real SQLite, read written first, write later; actual live requests, close and re-open database cold requests, and calls/results after rewind are completely consistent. Covers normal completions, tool errors, stream-loss synthetic results, slow pending/writes, and Stop. Slow writes are controlled by deferred, proving subsequent model events continue to consume; no race condition speculation relying on sleep.
- Desktop D19: earlier turn completes Bash→Read, sends follow-up questions, then edits the latest question; compares real provider tool_use/tool_result. Test cases located in manual-review/pending, fixture is synthetic, awaiting manual review.
- Passed: 20 new regression tests, 218 existing tests from hydrator/runtime-tool-loop/session-fork, `pnpm typecheck`, `pnpm lint` (43 existing warnings), architecture check, contracts/core type checking, Desktop E2E type checking, and fixture checking.
- macOS Electron D19 replay passed (1/1), real requests hit `d19-tools`, `d19-followup`, `d19-title`, `d19-later`, `d19-edited`, no fixture misses. Report: `packages/desktop/.e2e-artifacts/desktop-e20260910122250619-p1669-f4f6ced2e19e5429/summary.md`. Cases awaiting review are not counted as formal E2E coverage; Windows/Linux, mobile remote control not run.
- The runner's default 240-token window triggers additional compaction. This example compares uncompressed history, requiring the 128000-token window. The first preparation failed due to relative fixture path resolution failure; the second failed due to the default small window triggering unconfigured compaction; the following commands passed after fixing the preparation conditions, without product code adjustments.

```sh
ZCODE_E2E_MANUAL_REVIEW=1 \
ZCODE_E2E_DEEPSEEK_CONTEXT_WINDOW=128000 \
ZCODE_E2E_DEEPSEEK_MAX_OUTPUT_TOKENS=32768 \
E2E_PROVIDER_HTTP_MODE=replay \
E2E_PROVIDER_REPLAY_FIXTURE_PATH="$PWD/packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-tool-history-order.json" \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-tool-history-order.test.ts
```

### 2026-09-11: Select Latest Attempt by Invocation

- Regression first, then code fix: 19 of 25 targeted tests failed before the fix, including real Read/Edit falsely reporting stale after cold resume and rewind; all 25 passed after the fix.
- Executed 10 related test files using the current core, SQLite, and file system adapter source code, 335 tests passed; covering model history, fallback, stream loss, cancellation, fork, file state, and UI transcript hydration.
- macOS Electron D19 synthetic replay 1/1 passed; the runner rebuilt desktop and Agent, continuing to verify consistency of calls/results in live, follow-up questions, and post-edit requests. Report: `packages/desktop/.e2e-artifacts/desktop-e20260911095916848-p74882-7ee773cd74562b10/summary.md`.
- Core build, root typecheck, root lint, architecture check, Desktop E2E type checking, and fixture checking passed. Root lint has existing warnings; core independent lint error locations/rules are consistent with before the fix, including the original long file. Manual strict checking of added/modified tests: remaining errors come only from unchanged `test-runtime-model.ts`, `test-agent-runtime.ts`, and `runtime-output-token-continuation-test-helpers.ts`.
- Windows/Linux and mobile remote control E2E not run; D19 remains an awaiting-review case, not normalized this round.

## Scope Limitations

This fix only restores tool record order with complete declaration indices; it cannot reverse-predict old data, and cannot guarantee all cache misses disappear. Multiple parts with the same callID are only merged in model hydration; database records are not deleted/migrated, and the set of un-persisted invocations at Stop remains unchanged. File read state and UI continue to consume original parts.

See [Streaming Tool Execution and Recovery](../../../../apps/zcode-cli/docs/design/v2/model/streaming-tool-execution-and-recovery.md) for fallback and stream-loss recovery contracts.

Reusing failing attempts' partIDs retains the first insert position, causing the same file's post-completion fallback read to be overwritten by an older Read when restoring file state. Therefore, the existing execution record order of newly created parts is preserved, and only model hydration selection is fixed:

```text
Original parts: Read A(pending,1) -> Read B(old,2) -> Bash(0) -> Read A(new,1)
                         |
         +---------------+------------------+
         v                                  v
Model hydrate: latest part by same callID    File state: original order of completed parts
Sort Bash(0), A(new,1), B(old,2)             B(old) -> A(new), restoring new
```
