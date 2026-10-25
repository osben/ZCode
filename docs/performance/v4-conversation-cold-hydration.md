# V4 Conversation Cold Hydration Performance

Full history (per-sample timing tables): `git show b8876e8b:docs/performance/v4-conversation-cold-hydration.md`

## Feature Summary

| Field                 | Value                                                                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                | Cold hydration on the first `v4/conversation/subscribe` of a long session changes from a per-event full-projection transaction to bounded batch replay, removing repeated clones, all-row action scans and snapshot serialization that grew with history length |
| User-visible surfaces | Opening a persisted long session; the wait before the first conversation snapshot arrives                                                                                                                                                                       |
| Existing docs         | `docs/v4-refactor/02-projection.md`, `docs/v4-refactor/05-transport-and-backpressure.md`, `docs/v4-refactor/07-persistence.md`                                                                                                                                  |
| Existing code owners  | CLI `V4Gateway`, `ConversationTopicPublisher`, `ProductProjection`                                                                                                                                                                                              |
| Out of scope          | Renderer rendering optimization, wire schema changes, SQLite migration, persisted projection checkpoints, an independent mobile runtime, changing the desktop/mobile delivery profile                                                                           |

The goal is long-history cold open, not ordinary streaming throughput. The O(N^2) growth is an implementation
bug fix, not a reason to add a timeout or lower history fidelity. The work stays scoped: no persistence/schema
migration.

## Boundary Decisions

| Boundary           | Decision                                                                                                       | Includes                                                                              | Excludes / prunes                                                                            | Source                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Cold/hot semantics | Keep `reduce(transcript) ≡ reduce(events)`                                                                     | The transcript is still synthesized into canonical events and fed to the same reducer | A second projector going directly `message/part -> row`                                      | `docs/v4-refactor/07-persistence.md`                |
| Atomicity          | Adopt once, only after the candidate fully succeeds                                                            | On reducer error the old projection/log/subscription reservation is fully kept        | Half-replaying in place on the authoritative publisher                                       | current publisher contract                          |
| payload gate       | The normal batch path must prove it cannot cross 16 MiB; if it cannot, fall back to strict per-event admission | terminal reserve, oversized historical event skip, later terminal still reduced       | Raising the limit, truncating the snapshot, silently accepting an untransmittable projection | `docs/v4-refactor/05-transport-and-backpressure.md` |
| delivery profile   | Optimize only the CLI's shared cold materialization                                                            | desktop continuous and mobile replayable get the same terminal projection             | Spreading replayable gap/snapshot rules to desktop continuous                                | conversation protocol                               |
| persistence        | No DB schema change                                                                                            | Reuse existing message/part/session_entry reads                                       | projection checkpoint, row ordinal migration, store-backed lazy range                        | user-authorized scoped implementation               |
| Perf gate          | Performance thresholds are regression gates, not product contracts                                             | Representative 2000-turn tool-heavy fixture and a focused synthetic benchmark         | Wall-clock-dependent strict cross-machine E2E pass/fail                                      | catalog PERF scope                                  |

## Domain Scope

| Domain                        | Include?      | Why it can change behavior                                                                           | Primary sources                      |
| ----------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Conversation/session behavior | yes           | cold/live projection, row actions and command targets must be equivalent                             | conversation declaration, PV4-09     |
| Persistence/index/snapshot    | yes           | The transcript is the authority for completed bodies; cold subscribe must read and synthesize events | `docs/v4-refactor/07-persistence.md` |
| Rendering/performance         | yes           | Before the first frame CLI CPU is saturated and the renderer has not received the body               | 2000-turn runtime measurement        |
| Mobile remote/replayable      | boundary only | Shares one CLI projection, but delivery recovery semantics must stay isolated                        | trusted delivery invariants          |
| UI/render implementation      | no            | The time is spent before the initial frame is produced                                               | runtime trace                        |

## Concept Map

```text
persisted message / part / session_entry
                |
                v
loadPersistedConversationMaterialization
                |
                v
synthesize + merge canonical SessionEvent[]
                |
                v
ConversationTopicPublisher.rehydrate
                |
                +-- candidate ProductProjection (not externally visible)
                |      |
                |      +-- batch reduce through the same normalizer/reducer
                |      +-- materialize row actions once at the end
                |      +-- measure the bounded wire tail in fixed event windows
                |
                +-- success: one atomic adopt + snapshot recovery boundary
                `-- failure/uncertain size: discard or strict fallback
                                |
                                v
              desktop-continuous / web-remote-replayable subscribe
```

| Concept                | Why it matters                                                                                                                                        | Source                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| candidate publisher    | The outer layer already isolates the old authoritative state, so per-event clone is a duplicate transaction                                           | `conversation-topic-publisher.ts` |
| action materialization | It used to scan all rows on every event, and the assistant branch had nested `find/some`                                                              | `product-projection.ts`           |
| immutable delta apply  | During replay every append/upsert copied the growing row array                                                                                        | shared `apply.ts`                 |
| wire tail              | The initial snapshot sends only the last 60 rows; the CLI keeps the full history for range/targets                                                    | protocol limits / projection docs |
| recovery boundary      | Batch defers action derivation; after rehydrate an old intermediate base must snapshot, while new events after the current watermark can still resume | publisher retention contract      |

## State Owners

| State / fact                      | Authority                               | Mirrors / caches                       | Evidence                                              |
| --------------------------------- | --------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| persisted conversation facts      | CLI session store                       | runtime message history                | DB counts, cold resume log                            |
| canonical conversation projection | CLI `ProductProjection`                 | publisher snapshot/log, renderer store | strict-vs-batch golden                                |
| subscription ownership/profile    | CLI publisher + host trusted connection | renderer/mobile store                  | existing publisher/gateway tests                      |
| payload limit                     | shared V4 limits + CLI admission        | wire assembler                         | logical byte measurement and oversized fallback tests |

## Dimensions, candidates and pruning

| Dimension          | Values / equivalence classes                             | Include?            | Reason                                                                                              |
| ------------------ | -------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| persistence source | durable transcript, existing healthy live publisher      | yes                 | Only a durable transcript needs batch cold replay; a healthy live publisher is skipped by the guard |
| history size       | small, 2000 turns tool-heavy, growth ratio               | yes                 | Verifies semantics and the complexity trend together                                                |
| projection payload | safely bounded, uncertain/over limit                     | yes                 | Decides fast path vs strict fallback                                                                |
| replay outcome     | success, ordinary reducer error, payload-too-large event | yes                 | Atomicity and fail-closed                                                                           |
| delivery profile   | continuous, replayable                                   | representative only | Same terminal projection; profile only affects filtering/recovery, no full permutation              |
| workspace kind     | local, SSH/WSL/Docker                                    | pruned              | The hydration algorithm consumes only session facts and runs no path operations                     |
| tool shape         | text/reasoning + mixed terminal/pending/error tools      | yes                 | The tool-heavy fixture is the main reproduction                                                     |

| Candidate ID | State                                                             | Event                         | Expected guard/effect                                                                                    | Status                                              |
| ------------ | ----------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| V4HYD-01     | completed durable transcript, projection safely bounded           | first subscribe               | batch replay, same reducer, one final adopt                                                              | accepted                                            |
| V4HYD-02     | same facts                                                        | strict replay vs batch replay | snapshot, row actions, command target, seq/revision identical                                            | accepted                                            |
| V4HYD-03     | history may cross 16 MiB                                          | first subscribe               | fast proof fails, fall back to strict per-event payload admission (skip bad event + later terminal kept) | accepted                                            |
| V4HYD-04     | candidate reducer throws an ordinary error                        | first subscribe               | throws, old projection/log/subscription reservation unchanged                                            | accepted                                            |
| V4HYD-05     | healthy live publisher                                            | subscribe                     | reuse the live publisher, no cold replay (existing gateway guard)                                        | pruned                                              |
| V4HYD-06     | desktop vs mobile same facts                                      | subscribe/recover             | same terminal state; continuous/replayable delivery kept separately                                      | pruned to representative                            |
| V4HYD-07     | persisted projection checkpoint/lazy rows                         | cold subscribe                | would fully decouple first-screen cost from total history                                                | ignored (later architecture phase, needs migration) |
| V4HYD-08     | client holds a same-epoch intermediate base from before rehydrate | subscribe after rehydrate     | goes through the snapshot recovery boundary; new events after the current seq can still resume           | accepted                                            |

Pruning: V4HYD-P1 client profile x history/tool shape full permutation (canonical projection is shared;
strict-vs-batch golden plus existing profile tests); V4HYD-P2 workspace kind x hydration (no path execution;
bootstrap unit is representative); V4HYD-P3 renderer CPU/render cases (initial frame not yet emitted; the
2000-turn runtime trace shows the root cause is in the CLI projection); V4HYD-P4 raising the subscribe
timeout (a delayed failure reduces neither CPU nor RSS; ignored).

## Accepted Cases

| Case ID  | Setup                                                                                                                                   | Action                                       | Assertions                                                                                                                                              | Evidence layers                                         | E2E status                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| PERF03-A | A persisted session of 2000 turns, 4000 messages and mixed tool states                                                                  | first subscribe from a cold process          | Initial snapshot arrives; the CLI no longer hits the 180 s timeout; tool/user/assistant tail visible; time and RSS kept as artifacts                    | CLI log + process CPU/RSS + protocol ACK/frame + UI/CDP | manual performance run     |
| PERF03-B | synthetic small/mid/large event logs                                                                                                    | strict vs batch replay                       | Final snapshot, message target, row action, seq/revision identical; growth ratio not quadratic                                                          | focused unit/perf test                                  | covered                    |
| PERF03-C | normal history and oversized history                                                                                                    | batch hydrate                                | Normal history uses the fast path; strict fallback when the bound cannot be proven; 16 MiB behavior same as before                                      | publisher unit                                          | covered                    |
| PERF03-D | an existing projection/subscription reservation, candidate throws midway                                                                | rehydrate                                    | Old projection/log/reservation untouched                                                                                                                | publisher unit                                          | covered/extend             |
| PERF03-E | provider compact active tail of 939 messages / 3523 parts, UI active branch of at least 10621 messages, plus 1805 workspace checkpoints | first rehydrate + subscribe after cold merge | Validates provider tail and UI full active branch scale together; full initial snapshot arrives; stage timings and first-frame structure recorded       | opt-in CLI perf spec + production fixture               | fixed; production verified |
| PERF03-H | PERF03-E production fixture                                                                                                             | V4 cold activation -> initial frame          | Normal path fully reads parent messages once; concurrent subscriptions share the same operation materialization; the compact repair path refreshes once | bootstrap/core focused tests + production A/B           | fixed; production verified |

Matrix backfill: `docs/conversation-session-case-catalog.md` gains the PERF03 cold hydration performance case;
`docs/testing/conversation-session-e2e-coverage-matrix.md` registers the focused benchmark plus manual
2000-turn fixture without posing as a formal GUI E2E.

## Implementation Contract

1. The transcript is still synthesized into `SessionEvent[]`; no cold-only row reducer.
2. `rehydrate` first batch-replays on an invisible candidate; at the end it converges all-row actions once.
3. The fast path measures, in fixed event windows, the protocol-fixed 60-row wire tail exactly, accumulates only deltas still in the tail, and reserves the full schema upper bound for deferred actions; rows that slide out of the tail are not accumulated. When the bound cannot be shown, the existing strict path runs from a clean candidate.
4. An ordinary reducer error does not fall back and is not swallowed; the old publisher stays unchanged.
5. Final snapshot, row command targets and sequence/revision of batch and strict must be compared field by field by a golden test.
6. Batch defers action derivation, so a successful rehydrate establishes a snapshot recovery boundary; an old intermediate base does not continue the batch log, while live deltas after the current seq resume normally.
7. No new `info` logs for production per-event detail; if stage timings are logged they are aggregated into one hydration lifecycle event.

## Performance Acceptance

- Record wall time for 500/1000/2000-turn representative samples; the goal is a stable per-turn cost, with the 2000/1000 ratio clearly below 4.
- The same 2000-turn fixture no longer triggers the 180 s `v4/conversation/subscribe` timeout.
- Performance numbers record environment and artifact and are not written as a cross-machine product SLA.
- Chunked yielding or a hydration scheduler may only serve as responsiveness/concurrency protection and cannot replace removing the repeated work.

### PERF03-E ticket-shape reproduction contract (2026-08-11)

This case first only pinned the reproduction; after the fix it continues as an equivalence and performance
observation case. It targets the CLI CPU interval, in ticket `ZCT-2087119663734751232`, from the end of
`hydrate_three_source_merge` to before `v4/conversation/subscribe` returns; renderer auto-history backfill,
file-summary queries and provider requests are not part of the focused case's core timing.

```text
SQLite full active branch (>= 10621 messages)
              |
              +-- runtime/provider history applies latest compact boundary
              |      -> 939 messages / 3523 parts
              |
              +-- UI cold projection retains the full active branch
                     +-- timeline + rows/range history
                     +-- checkpoint_created x 1805
                              |
                              v
                     three-source merge
                              |
                              v
             ConversationTopicPublisher.rehydrate
                              |
                              v
                     initial snapshot frame
```

Reproduction data and observation requirements:

1. The ticket's `session.resumed.messageCount=939 / partCount=3523` is the post-compact provider-active tail, not the SQLite total. The same session's later rewind log records `keptMessageCount=10621`, proving the effective branch before compact had at least 10621 messages. The reproduction must pin both magnitudes and must not treat 939 as the full transcript.
2. The fixture uses a real active compaction boundary so provider/runtime `activeSessionMessages()` yields exactly 939 messages / 3523 parts, while the cold projection input keeps the 10621+ full effective branch to restore the UI timeline and `rows/range` history. This is the production layering: `loadPersistedConversationMaterialization()` handles rewind/branch cuts through `selectActiveConversationBranch()` but does not misuse the provider compact tail as the UI projection's history boundary.
3. The 1805 checkpoints are spread over historical user messages without subagent lifecycle; this keeps the ticket's event-store shape and keeps child queries out of the core timing.
4. The opt-in CLI spec runs `mergeColdConversationEvents`, `ConversationTopicPublisher.rehydrate` and the first `subscribe` in turn, outputting full/active message and part counts, merge/rehydrate/subscribe/total, event/row counts, initial frame bytes/hash; absolute wall clock is not asserted across machines.
5. A fresh app-server of the production build is used only as end-to-end evidence; test and fixture tooling stay in test/skill scope and never enter the production startup path.

State-combination pruning: only the local `desktop-continuous` first cold subscribe is covered as the
representative; terminal equivalence for mobile `web-remote-replayable` reuses the existing PERF03-B/PV4
coverage. Full UI history paging, remote workspaces, provider continuation and real artifact file content are
not part of this projection reproduction.

Fix boundaries (all inside the cold hydration accumulator enabled by `tryBatchHydration()`; live `ingest()`,
the strict fallback after payload proof fails, cold merge, EventStore, checkpoint file-summary/rewind
consumption and the post-hydration store-verified subagent seed stay unchanged; initial frame bytes/hash,
event/row counts, final seq and the terminal state of both delivery profiles must be equivalent before and
after):

- Subagent derived state: judged from the reducer's delta. Only subagent row append/update/streaming change/any suffix deletion and changes of `pendingInteractions` and `backgroundWorks` re-run `materializeSubagentProjection()`; other events are still normalized/reduced and advance `snapshot.seq` but no longer scan all conversation rows.
- `TurnComplete` fork capability: the last assistant's fork capability is pinned by searching only after the current product turn's header, reverse-walking the original array and stopping at the first hit; never copy and reverse the whole rows window per turn. If an old history lacks a turn header, search compatibly from the window start. Only the search algorithm is replaced; no mutable index is added and cold/live, rewind, clone and stable-fork semantics are unchanged.
- `TurnComplete` still keeps the fallback closing of foreground tools whose terminal event is missing, without scanning all rows per turn. The projection maintains a derived index `openForegroundToolCallIds`: a tool row enters it while `inputStreaming`, `pendingApproval` or `running` and not background, and leaves on any terminal state or when backgrounded; `row.removed` cleans rewound entries. The index derives only from materialized tool row deltas, the authority stays the snapshot, and the current row is re-validated before closing. clone/adopt, atomic reject, cold batch and strict replay must keep index isolation and final snapshot equivalence; a late upsert causing closed -> open must re-add it.
- Payload proof: no longer unconditionally serializes exactly in a fixed 32-event window. A no-delta event only advances `snapshot.seq`, and the safe growth upper bound of that field is maintained by digit-count changes, without building a wire-tail rowId set or serializing an empty delta; `state.updated` and `row.appended` count conservative growth directly; only `row.upserted` and `row.delta` lazily build the tail rowId set to decide whether the 60-row wire window is affected. `row.removed` may bring an old row into the tail and must re-measure exactly at once; the final event must re-measure exactly after actions converge; other events re-measure exactly only when the conservative upper bound touches the current terminal/non-terminal payload limit, and fall back to strict admission only if, after re-measurement, together with the safe reservation for unconverged actions, transmissibility still cannot be shown. This optimization only reduces proof cost and must not change the 16 MiB fail-closed behavior, the terminal reserve, continuing to the terminal after skipping a single oversized historical event, the initial frame bytes/hash, or the final cold/live snapshot.
- Byte counting: cold-only delta growth is still measured by exact JSON UTF-8 byte count, but without creating a temporary `Uint8Array`: CLI bootstrap may use Node `Buffer.byteLength(json, "utf8")` on the same `JSON.stringify` result. This replacement is limited to the growth count in `tryBatchHydration()`; the shared/browser encoder, live delta, snapshot exact measurement, the 16 MiB limit and the terminal reserve check keep the original implementation. Tests must cover ASCII, Chinese, emoji, quotes/backslashes, control characters and top-level `undefined` value by value, proving old and new results equal; publisher boundary tests keep covering 1 byte either side of the payload limit, strict fallback after a temporary overrun, and the final frame structure.
- Subagent prospective state: the subagent derived state must see the "current snapshot after this event's delta" prospective state without copying the full rows array per materialization. The materializer shared by cold and live walks the current rows directly and builds a local overlay only for the `row.appended`, `row.upserted`, `row.delta`, `row.removed` of this event; `pendingInteractions` and `backgroundWorks` read the last `state.updated` replacement value in the same batch. This only removes array copying and keeps the existing full-table scan, latest-row-wins, ghost-child filtering, waiting/blocked priority, revision and delta order. Strict replay and cold batch must deep-equal per event and in the final snapshot across spawn/message/stop, waiting, blocked, rewind, duplicate child and ghost child combinations.
- Subagent indexed enumeration: after removing prospective array copying the same production fixture still triggered 2180 materializations with a median remaining full-table scan of 255.7 ms, over the 50 ms continue-optimizing threshold. The next step only reuses the existing `subagentRowIdByAgentId` and `rowIndexById`: dedupe current subagent rowIds, restore original timeline order by current row index, and overlay the row newly appended by this event; no second row/child authority index may be added. After `row.removed` is applied, stale agent mappings whose target row no longer exists must be deleted at once against the current snapshot as the authority; ordinary events must not traverse `subagentRowIdByAgentId` for this. Synthetic/real agent aliases are deduped by rowId, and a `row.upserted` converting a non-subagent to a subagent still enters this event's local overlay. Performance tests must prove ordinary conversation rows no longer enter the prospective subagent computation and repeated rewinds do not let the alias count grow with deleted history.

## Measured Results

All numbers are same-machine diagnostic evidence, not cross-machine SLAs. Historical environment: Apple M2
Pro, 10 logical CPU, 16 GiB RAM, Electron 41.0.3, renderer on the Vite dev server, CLI with
`ZCODE_ENV=production`; PERF03-E measurements ran on Apple M4 (macOS 15.3.1) unless noted.

### PERF03-E full-history reproduction (focused spec `compacted-full-history-cold-hydration.perf.test.ts`)

Fixture: 10623 persisted messages / 35811 parts, 939 active messages / 3523 parts, 1805 checkpoints, 77372
merged events, 30500 rows; every run gives a 25016-byte initial frame with hash
`2ff4f3816dc88f2f050f1ec52c1772fa137f35192f3bd5ec6a55c42afdf8c881`. Each metric is the median of 5
independent Vitest processes.

| Step (2026-08-11/12)                                                                                                          | publisher rehydrate | merge -> initial frame |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------: | ---------------------: |
| Before any fix                                                                                                                |             10.79 s |                10.92 s |
| Dirty-check of subagent derived input in cold batch (gain from skipping unrelated repeated subagent full-row materialization) |   767.4 ms (-92.9%) |      889.2 ms (-91.9%) |
| `markStableForkAssistant()` reverse search (Node 25.6.0, same-machine increment)                                              |   777.0 -> 643.8 ms |      902.1 -> 774.0 ms |
| `closeOpenToolRows()` foreground-open index (Node 25.6.0 increment)                                                           |   643.8 -> 354.6 ms |      774.0 -> 479.3 ms |
| Lazy payload proof (Node 24.14.0)                                                                                             |            257.8 ms |               375.0 ms |

Cumulatively roughly -96.7% (30.4x) for rehydrate and -95.6% (22.8x) for merge -> initial frame. After a
forced production rebuild (Node 24.14.0, 5 independent processes) cold merge median was 123.2 ms and
rehydrate median 302.3 ms (first cold process 384.5 ms), so the earlier ~0.95 s no longer represents the
rehydrate hotspot; record focused rehydrate as about 0.26-0.38 s, median 0.30 s.

### Production fixture `sess_perf_large_20260811150224_4929c823` (10622 messages / 35811 parts, active tail 939/3523, 1805 checkpoints)

Fresh `app-server --stdio` process per sample with a warm file cache.

- Before the three projection optimizations: cold subscribe -> initial frame median 17523.7 ms (consistently reproduces the user-perceived ~20 s stall on the real SQLite + production protocol path; resume applied only the 939/3523 active tail while cold merge kept the 1805 checkpoints).
- After them (Node 24.14.0): median 5467.4 ms (-68.8%, about 3.2x); every run kept the 157745-byte snapshot, 29950 total rows, 60-row wire window, 0 running subagents and `toSeq=74164`. The gap to the 479.3 ms focused number still includes Agent runtime activation, real SQLite reads, transcript/event synthesis and protocol process start.

#### 2026-08-14 exact byte length + indexed subagent overlay (Apple M4, Node 24.14.0)

Before vs after on the same fixture, 5 fresh processes each:

| Production boundary                | Before (median) | After (median) | Change                  |
| ---------------------------------- | --------------: | -------------: | ----------------------- |
| process -> provider-registry ready |        442.7 ms |       445.2 ms | +2.5 ms (startup noise) |
| ready -> complete initial frame    |       1922.2 ms |      1455.7 ms | **-466.5 ms (-24.3%)**  |
| process -> complete initial frame  |       2364.9 ms |      1905.1 ms | **-459.8 ms (-19.4%)**  |

All 10 formal samples kept a 157745-byte initial frame, 157547-byte snapshot, 29950 total rows, 60-row wire
window and `seq=74164`; with the per-process random `logEpoch` removed the snapshot SHA-256 was identical
(`5c8290e8489b2951be8cfc2fc03556f806a691200f4f3697ab5a0663b4b1e11d`). Exact `Buffer.byteLength` plus the
no-copy prospective overlay moved `ready -> frame` to 1662.5 ms (-259.7 ms); reusing the existing
subagent/row indexes cut a further 206.8 ms. Temporary production instrumentation for the same 74164-event
replay (includes instrumentation overhead, direction only):

| Implementation                    | subagent materialization (2180 calls) | exact wire-delta byte count (72357 calls) | publisher rehydrate |
| --------------------------------- | ------------------------------------: | ----------------------------------------: | ------------------: |
| Before                            |                              324.1 ms |                                  354.5 ms |           1014.0 ms |
| exact Buffer + no-copy overlay    |                              255.7 ms |                                  226.4 ms |            781.3 ms |
| plus indexed subagent enumeration |                           **68.2 ms** |                              **225.3 ms** |        **589.5 ms** |

The index layer removed scanning of ordinary conversation rows; the remaining ~68 ms is the complete
subagent derived-state computation, and no more cache is added for the old below-50-ms "full-table scan"
threshold. The byte count stays exact and is still a ~225 ms hotspot; it is not turned into an approximate
count in this round and the 16 MiB/terminal reserve/strict fallback are unchanged. On the subagent-free
PERF03-E focused fixture the byte-count slice alone moved rehydrate from a 266.3 ms median to 239.8 ms
(-10.0%), initial frame 25016 bytes / 30500 rows with the same hash; after the rewind stale-alias cleanup patch
it measured 235.8 ms. The cleanup hangs on the existing `row.removed` branch (no alias traversal for ordinary
events); a structural test pins that a 16-event replay cleans exactly once on each of two rewinds and leaves
only aliases still pointing at current snapshot rows after repeated deletion.

<a id="perf03-h-单次冷恢复物化2026-08-12"></a>

### PERF03-H single cold-resume materialization (2026-08-12; rechecked 2026-08-13)

Single-read figures come from a one-off local read-only DB backup diagnostic; the probe is not kept in
production or test code and is not a portable CI gate.

Integration spies pinned the call facts first: with a fake app that does no real runtime read, one V4 cold
subscribe called parent-session `messages()` **4 times**; the real runtime reads once more, so the production
normal path totals **5**. On the read-only backup, 5 single-read samples had a median of **385.1 ms**; by the
same per-read cost 5 full materializations are about 1925.7 ms, of which 4 repeated reads are about
1540.6 ms (an upper-bound explanation, not summed against end-to-end wall clock).

The implementation passes the first read's messages/parts only within the current cold-resume operation;
settings, runtime resume, the V4 transcript, the parent subagent manifest and the late usage seed reuse the
same array. No session cache, TTL, schema or store API is added. If runtime resume patched a `started/retrying`
compact timeline, it refreshes once before handing over to V4; only the interrupted-compact repair path may
refresh into a second read.

Same production fixture, Node 24.14.0, warm file cache, fresh `app-server --stdio` per run, 5 runs:

| Implementation                                         | median subscribe -> initial frame | change                          |
| ------------------------------------------------------ | --------------------------------: | ------------------------------- |
| Before: parent messages fully materialized 5 times     |                     **3991.9 ms** | -                               |
| After: single operation materialization on normal path |                     **2681.6 ms** | **-1310.3 ms (-32.8%, ~1.49x)** |

All 10 runs kept a 158038-byte physical frame, 29950 total rows, 60-row wire window, `toSeq=74164`, 0 running
subagents and empty stderr. The random `logEpoch/subscriptionId` makes the whole-frame SHA-256 differ per
process, so structural equivalence is verified by the stable fields plus a focused cold-resume snapshot
deep-equal test; the random envelope hash is not a regression gate. A final-production-bundle recheck after
warmup gave a median of 2019.0 ms (different cache state from the baseline; smoke only).

On 2026-08-13 a forced production rebuild (15/15 build tasks, 0 cache hits, Node 24.14.0) rechecked the
PERF03-E fixture (10622 messages / 35811 parts / 1805 checkpoints) with 5 fresh processes: using the old runner
order the median was **2649.4 ms** (vs 2681.6 ms post-fix, -1.2%; the old baseline was not rebuilt, so this is
not a new same-round A/B), and in the actual production preflight order (wait for the provider registry ACK
before subscribing):

| Production boundary                |        Median |
| ---------------------------------- | ------------: |
| process -> provider-registry ready |  **450.4 ms** |
| ready -> complete initial frame    | **1785.4 ms** |
| process -> complete initial frame  | **2228.3 ms** |

Both bases kept 29950 total rows, a 60-row wire window, `toSeq=74164`, 0 running subagents and empty stderr.
The newest physical NDJSON notification was 158037 bytes vs 158038 bytes in the historical A/B record; the old
physical frame artifact was not kept, so the one-byte difference cannot be located and only stable structural
equivalence is claimed. A forced production rebuild stage breakdown (median of 5, scheduler noise present;
rows are log/protocol boundaries and must not be summed into one fictional timeline): process -> provider
registry ready 455.7 ms; subscribe -> runtime preferences request 309.6 ms (first full message/part
materialization and settings derivation); app startup 125 ms; `session.resumed` after user-execution
preferences 178 ms (recovers 939 messages / 3523 parts); `session.resumed` -> three-source merge 198 ms;
merge completed -> subscribe ACK **1088.4 ms** (composite: rehydrate, subagent/usage seed, snapshot/ACK
encoding, not pure rehydrate); ACK -> complete initial frame 13.6 ms. The largest visible remaining
production interval is therefore the ~1.09 s composite after merge. Single SQLite `messages()` read median on
the backup: 315.9 ms.

### Persisted 2000-turn fixture

Fixture `sess_perf_large_20260714130421_2dee7a7b`: 2000 turns, 4000 messages, 13339 parts, 4000 tool parts,
60 todos. Baseline artifact: `packages/desktop/.e2e-artifacts/large-task-2000-turns-20260714/`.

| Implementation checkpoint                                                 | `subscribeConversationV4` | Observation                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------: | ------------------------------------------------------------------------------------------------------------------- |
| Original                                                                  |             > 180023.4 ms | 180 s timeout; persisted resume/read only 737 ms, CLI single core saturated, the renderer had not received the body |
| Only the nested action scan removed, payload proof falling back to strict |                67913.4 ms | Shows the main remaining cost is per-event immutable snapshot apply/serialization                                   |
| Exact measurement of the 60-row wire tail per event                       |                12571.5 ms | Full-history snapshot serialization removed, but measurement frequency still too high                               |
| Fixed 32-event window measuring the bounded wire tail                     |                 1817.2 ms | Persistence resume about 624 ms; CDP first screen received the body, 21 virtualized rows in the viewport            |

At least about 99x faster than the 180 s timeout lower bound; the V4 subscribe stage no longer masks the
~0.6-0.7 s persisted-read cost.

### Synthetic tool-heavy scaling

Per turn the synthetic input has 8 events (user, assistant text, tool input, tool scheduled, tool result,
terminal); warm-up first, then 3 runs and the median.

| Turns | Events |   Median | Growth ratio |
| ----: | -----: | -------: | -----------: |
|   500 |   4001 |  37.4 ms |            - |
|  1000 |   8001 |  68.2 ms |        1.82x |
|  2000 |  16001 | 137.6 ms |        2.02x |

Doubling turns/events roughly doubles time; the former quadratic trend is gone. Synthetic numbers measure only
`ConversationTopicPublisher.rehydrate`, hence smaller than end-to-end figures including SQLite, RPC, Electron
scheduling and the renderer first frame.

### 2026-07-24 runtime activation / legacy snapshot decoupling

Another 1,000-turn fixture `sess_perf_large_20260724034221_af2e36b8` (2,000 messages, 6,671 parts, 2,000 tool
parts, 334 reasoning, 200 patch, 60 todos), fresh production `app-server` per measurement, pre-change HEAD
and current source built independently, three runs each after warm file cache:

| Implementation                            | median cold subscribe -> initial frame | frame bytes |
| ----------------------------------------- | -------------------------------------: | ----------: |
| Before: full legacy snapshot x 2          |                              3169.5 ms |     143,690 |
| activation-only + narrow usage projection |                              2701.5 ms |     143,690 |

The median drops 468.0 ms (14.8%) with a byte-identical first frame. This only proves the local gain of
removing the duplicate legacy projection; the remaining ~2.7 s still includes Agent runtime activation,
persisted transcript read/synthesis, V4 projection rehydration and wire encoding and must not be attributed to
a single stage. Responsibility boundaries and functional invariants are in
[`17-cold-resume-runtime-activation.md`](../v4-refactor/17-cold-resume-runtime-activation.md).

## E2E Handoff Notes

- Provider fixture: not needed; `zcode-large-task-fixture` builds the persisted conversation directly.
- File-system fixture: none.
- Timing strategy: a separate manual performance run; the focused benchmark guards only the complexity trend and avoids absolute wall-clock jitter in CI.
- Docker preset: not part of the regular conversation suite.
- Review risks: payload fallback, snapshot recovery boundary, strict-vs-batch equivalence of row actions/command target.
