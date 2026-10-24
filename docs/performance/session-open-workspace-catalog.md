# Session Open: CUA Spawn Decoupling and Directory Read Re-evaluation

## Baseline and scope

2026-09-10, based on staging `279907140bd7`: only the early return of the CUA safe-reservation tuple is
re-applied. The directory read is not moved later and the old Provider implementation is not restored.
The old change and the CCR01/CCR02 config-race reproductions are fully kept in stash `38d1e293`; those
tests target the removed `readWorkspaceState`/config-cache contract, are not ported in this round, and
the new staging is not claimed to pass the old reproductions.

On the new staging, `workspace/readPresentation` returns only mode/slash commands and no longer creates
a temporary App. Model candidates come from the Host ModelSelectionView, and the Composer draft intent
and session execution config keep their original owners. The old conclusion "moving the directory later
saves about 700ms of a temporary App" therefore no longer applies. The remaining slash discovery, Host
client preparation and protocol queuing must not be attributed to directory computation, and this round
does not change UI timing for that.

## Sequence and invariants

```text
CUA: start + original startup tracker
       ├─ Windows waitForTransport -> original transport_ready/deadline
       ├─ safe reservedTransport exists and no unavailable marker -> return the tuple immediately
       └─ no reservation -> original bounded wait, timeout check and fail-closed
```

- The UI's directory read, Composer initialization and submit timing stay as in staging.
- CUA keeps the warm health, admission marker, failure backoff and background startup tracker. Early
  return does not mean the Helper is available; a complete startup failure still restricts only later
  spawns and does not reclaim existing Agents.
- No new timer, scheduling layer, protocol, state owner, persistence or cross-module interface.
- Desktop continuous and mobile replayable delivery, gap and owner boundaries are unchanged. The
  transport admission of a remote Host and of Windows is not replaced by the local macOS reservation
  fast path.

## Verification method

1. Tests first: CUA fake-timer test proves an existing reservation needs no 1s advance; also cover a
   delayed reservation, Windows transport_ready, warm health failure and the original admission /
   failure lifecycle.
2. After a full `pnpm bootstrap`, a production build; WDIO starts an isolated Electron, and after App
   ready and default workspace directory ready clicks a real session. The main metric is the real
   pointer click to the first conversation row in the viewport; protocol stages are recorded separately.
3. Two real sessions, 5 runs each, reporting all samples and medians and interval/cumulative values; the
   independent stage medians are not summed as a total median.

## Results (historical, single serial runs)

- Pure staging: a6 (Agent already started) 657/669/986/1857/796ms, median 796ms; 6951 (Agent started
  after the click) 2919/2211/2704/2452/2705ms, median 2704ms.
- After optimization: a6 721/766/862/628/819ms; 6951 1483/1390/2361/1272/1476ms. All 10 runs reached
  the target session's visible row; the snapshot row count stayed at 295 / 25 before and after.
- Two serial groups, each alternating session order; not a randomized interleaved A/B and not a
  stability SLA. The two UI entry files and the CLI bundle hash are identical before/after; the only
  production code change is the services CUA env fast path. A first isolated package lacked the new
  Provider config path and hit a startup error; failed smoke/control1 are not counted, control2 is a
  warm-up pre-check and round1-5 are the formal samples.

Median comparison (ms):

| Metric | staging | after CUA optimization | delta (after - before) |
| --- | ---: | ---: | ---: |
| a6 click → first visible row (Agent reused) | 796 | 766 | -30 |
| 6951 click → first visible row (Agent spawned) | 2704 | 1476 | -1228 |
| 6951 command resolved → spawn preflight (Host sub-stage) | 1051 | 60 | -991 |
| 6951 Host prepare | 1775 | 770 | -1005 |
| 6951 CLI request → ACK | 566 | 541 | -25 |
| 6951 session restore (request → ACK sub-stage) | 343 | 330 | -13 |
| 6951 ACK → visible row (residual, incl. instrumentation gaps) | 225 | 115 | -110 |

Each row takes its own median and rows have parent-child relations, so they cannot be summed.
End-to-end drops about 45%; what is clearly attributable is removing the fixed Host wait of about 1s,
and the other roughly 0.2s difference must not be fully credited to CUA. a6 already had an Agent, so its
30ms difference is not a confirmed gain. In the slow 6951 sample of 2361ms preflight was only 60ms and
Host prepare 1429ms, so the long wait happened after preflight and does not show that the fast path
failed.

Interval / cumulative of the run whose first visible row sits at each group's median (baseline 6951
round3, optimized 6951 round5), in ms; cumulative is the arithmetic accumulation of measured stages with
unmeasured time listed separately, and the visible row uses an independent DOM end point:

| Stage | staging interval | staging cumulative | optimized interval | optimized cumulative |
| --- | ---: | ---: | ---: | ---: |
| click → acquire | 55 | 55 | 52 | 52 |
| Renderer prepare | 0 | 55 | 0 | 52 |
| Host prepare | 1775 | 1830 | 770 | 822 |
| CLI request → ACK | 644 | 2474 | 526 | 1348 |
| initial frame transport + snapshot apply | 5 | 2479 | 2 | 1350 |
| React render | 92 | 2571 | 56 | 1406 |
| paint → interactive | 134 | 2705 | 35 | 1441 |
| unallocated instrumentation gap (to the independent click → interactive) | 11 | 2716 | 41 | 1482 |

The independent DOM visible end points are 2704 / 1476ms.

### Remaining room for moving the read later

a6's workspace presentation is pre-warmed and had no directory request in the click window. 6951 still
reads the directory before resume, but the residual `CLI request → ACK` minus restore median is only
223 → 211ms, which also includes request queuing and other subscribe handling and is not pure directory
time, so moving the read later cannot be promised to save it all. The Host's whole
`readWorkspacePresentation` time includes Agent startup, so the roughly 1s of Host preparation must not
be double counted as directory cost. For now the staging directory read order is kept, and moving it
later is re-evaluated only with independent evidence that the gain is worth it.

## Validation and limits

- The new zero-time-advance unit test fails on the original code and passes after optimization; 144
  unit tests pass for CUA env, producer resolver, Helper Host, Windows Host and service dispose.
- `pnpm typecheck`, Desktop `typecheck:e2e`, `pnpm architecture:check --changed` and the format check
  of changed TS pass. `pnpm lint` has 0 errors / 43 warnings on unchanged files; `git diff --check`
  passes.
- `check-workspace-freshness` errors because the branch is 1 commit behind the old experiment
  `origin/feat/session_opt`; this round used the fetched `origin/staging` / HEAD `279907140bd7` as the
  baseline per the user and did not mix in the old experimental commit.
- This WDIO is a real local session-open benchmark, not a complete E2E of CUA permissions / actual tool
  calls. Windows hardware, mobile remote control and actual CUA calls were not rerun; zero risk on all
  platforms end to end is not claimed.
- The fast path applies only to an already safely reserved transport; before the first start has
  published a reservation, warm health and Windows transport_ready can still hit the original bounded
  waits. No new polling, cache or wider admission was added.
- Nothing was committed or pushed automatically in this round; the old stash is kept.
