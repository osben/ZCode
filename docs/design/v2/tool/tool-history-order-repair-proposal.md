# Tool History Order Repair

Existing ToolPart writes carry a declaration index; provider history hydration selects the latest record per
invocation, then restores the declaration order.

## Root cause

`model.ts` accepts and deduplicates tool declarations, and live history submits calls and results in
declaration order. Read-only tools can execute before the stream ends, and SQLite's `part.sequence` is decided
by the first write. The old hydration used the SQLite order directly, so model history for resume,
edit/rewind and fork differed from live.

```text
Model declaration     Bash(0) ---------> Read(1)
Execution timing      Wait for finish         Pre-execute
First write           Write Bash later        Write Read first
live                  calls [Bash, Read] -> results [Bash, Read]
Old hydrate           calls [Read, Bash] -> results [Read, Bash]
Fixed hydrate         calls [Bash, Read] -> results [Bash, Read]
```

## Data and behavior contracts

- ToolPart adds an optional top-level `declarationIndex?: number`: the order, starting from 0, of
  client-executed invocations accepted by the runtime within the same assistant; repeated declarations and
  providerExecuted calls take no index.
- The streaming path keeps using the deduplicated `acceptedToolCalls`; normal/recovery paths keep using
  `coreToolCalls`. The index is written into part.data JSON along with the existing pending, running,
  completed/error states.
- The sorting adds no storage reads/writes, moves no write points, and adds no queues, awaits, partID
  registration, timeouts or catch. `onStreamToolCall` still returns synchronously; pre-execution failures
  still go through the original catch's stream-end execution.
- Fallback after a pre-execution failure and synthetic recovery keep the existing new-part behavior, with the
  same `callID` and `declarationIndex`; failing attempts' partIDs are not registered, passed or reused.
- Model hydration selects, per `callID` within each assistant, the last newly created part by the original
  persisted order, without comparing update times or preferring successful states. When the latest part is
  pending/running it uses the interrupted result; identical callIDs across different messages are not merged.
- The index is enumerated by the runtime. When all selected parts have indices, sorting applies even with
  gaps; when some or all are missing, the original relative order of the selected parts is kept. calls and
  results share the same selection and sort result.
- SQL sequences, original message.parts, UI transcripts, tool scheduling/permissions/cancellation/results, the
  V4 protocol and the desktop continuous / mobile replayable boundaries are unchanged.
- Fork keeps using existing part copying and ID remapping; the numeric index has no cross-message ID
  references, so no new fork logic is needed.
- Old versions can ignore this JSON field; an old version rewriting the same part may lose it; new versions
  follow the old record rules.

Reusing a failing attempt's partID would keep the first insert position, making the same file's
post-completion fallback read be overwritten by an older Read when file state is restored. So newly created
parts keep the existing execution record order and only model hydration selection is fixed:

```text
Original parts: Read A(pending,1) -> Read B(old,2) -> Bash(0) -> Read A(new,1)
                         |
         +---------------+------------------+
         v                                  v
Model hydrate: latest part by same callID    File state: original order of completed parts
Sort Bash(0), A(new,1), B(old,2)             B(old) -> A(new), restoring new
```

## Verification

- core `tests/tool-history-order.test.ts`: valid ordering, legacy/partially missing, multiple attempts for the
  same call, latest success/failure/incomplete states, cross-message isolation, gaps, unchanged original
  arrays, and fork callID remapping.
- core `tests/runtime-streaming-tool-part-identity.test.ts`: fallback success, failure, re-write failure,
  synthetic recovery and late batch starts; original records may have multiple entries but model history has
  one invocation and result.
- bootstrap `tests/tool-fallback-read-state.test.ts`: real SQLite and Read/Edit handlers; a file first read by
  another Read, then modified by a Bash-like tool, finally read by the fallback Read; cold recovery and rewind
  keep model history consistent; Edit succeeds using the latest read snapshot.
- bootstrap `tests/tool-history-order.test.ts`: real SQLite, read written first and write later; the live
  request, the cold request after closing and re-opening the database, and calls/results after rewind are
  fully consistent. Covers normal completions, tool errors, stream-loss synthetic results, slow pending/writes
  and Stop. Slow writes are controlled by deferred, proving later model events keep being consumed; no
  sleep-dependent race assumptions.
- Desktop D19: an earlier turn completes Bash->Read, a follow-up is sent, then the latest question is edited;
  real provider tool_use/tool_result are compared. The case is in manual-review/pending with a synthetic
  fixture, awaiting manual review, and is not counted as formal E2E coverage; Windows/Linux and mobile remote
  control were not run. The runner's default 240-token window triggers extra compaction; this case compares
  uncompressed history and needs the 128000-token window:

```sh
ZCODE_E2E_MANUAL_REVIEW=1 \
ZCODE_E2E_DEEPSEEK_CONTEXT_WINDOW=128000 \
ZCODE_E2E_DEEPSEEK_MAX_OUTPUT_TOKENS=32768 \
E2E_PROVIDER_HTTP_MODE=replay \
E2E_PROVIDER_REPLAY_FIXTURE_PATH="$PWD/packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-tool-history-order.json" \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/conversation-session/manual-review/pending/conversation-session-tool-history-order.test.ts
```

## Scope limits

This fix only restores tool record order when declaration indices are complete; it cannot reverse-predict old
data and cannot guarantee that all cache misses disappear. Multiple parts with the same callID are merged only
in model hydration; database records are not deleted/migrated, and the set of un-persisted invocations at Stop
is unchanged. File read state and UI keep consuming the original parts.

See [Streaming Tool Execution and Recovery](../../../../apps/zcode-cli/docs/design/v2/model/streaming-tool-execution-and-recovery.md)
for fallback and stream-loss recovery contracts.
