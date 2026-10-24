# Explore Tool Grouping Stage Status

## Release state

The feature is on by default as a user setting. The Settings toggle "分组探索工具" (group exploration tools) persists as the app-level `toolGroupingExploreEnabled`; when missing, `ENABLE_EXPLORE_TOOL_CALL_GROUPING=true` is the fallback. When off, Read/Search and read-only Shell keep their original standalone tool rows; tool classification, lifecycle, protocol and session persistence are unchanged.

## Summary

| Field | Value |
| --- | --- |
| Behavior | The Explore parent group derives status from "visible stage boundary + current work segment state", not from aggregated child tool status |
| Surfaces | Desktop `desktop-continuous`, plain Web, mobile `/remote` (shared v4 conversation renderer) |
| State owner | The V4 projection owns raw rows and the turn header; the renderer only derives the Explore parent display state |
| Out of scope | Child tool status, Execute state, protocol, runtime, snapshot, replay and persistence are unchanged |

## Rationale

A single read-only tool keeps its original tool row; the Explore parent group is created when the second consecutive read-only tool arrives. Once the parent exists, if all current children are complete and the next read-only tool has not appeared, the old implementation briefly flipped from "exploring" to "completed" and back. Explore represents one exploration stage of the model; the parent must not read the model gap between child tools as stage end.

```text
Read completed
     |
     +-- work segment still running + no visible boundary --> Explore in_progress
     |
     `-- visible non-Explore boundary / segment terminal ----> Explore completed
```

## Boundary decisions

| Boundary | Decision | Includes | Excludes |
| --- | --- | --- | --- |
| Group threshold | At least two consecutive Explore-compatible rows create a parent; a single item keeps its original tool row | Consecutive Read/Search/read-only Shell | A shell parent with one child |
| Running | Explore is at the tail of the current visible work chunk, and that chunk is still the tail of a running segment | The model gap when all children are completed | No child needs to be running |
| Completed | Any visible non-Explore row appears after Explore, or the segment is terminal | Execute, Write/Edit, Agent/Todo, assistant text, visible reasoning | Hidden non-first reasoning is not a boundary |
| Child lifecycle | Each child keeps showing its own pending/running/success/error/cancelled | Failure detail, approval, output | Child status no longer decides Explore parent running |
| Stopped fallback | A parent may show stopped when terminal Explore children include cancelled | No running segment | No new standalone turn-stop protocol field |
| Execute symmetry | Execute derives its parent status from the same visible stage boundary | running tail, visible boundary, segment terminal | Tool classification and summary stay independent |

## State and event flow

```text
visible assistant work rows
          |
          v
collect consecutive Explore rows
          |
          +-- next visible row is non-Explore ------> completed
          |
          +-- group is chunk tail, but a later flow
          |   item/text ends the visual stage ------> completed
          |
          +-- group is true segment tail
          |   && segment state is running ----------> in_progress
          |
          `-- segment terminal ---------------------> completed/stopped
```

The caller must tell the row builder explicitly whether the current chunk is "the true tail of a still-running segment". Passing only `segment.workStatus.state === running` is not enough, because an assistant history chunk may be followed by assistant text, following rows or other flow items.

## Accepted cases

| ID | Setup | Action | Assertions | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| ETS01 | Two consecutive completed Reads at the true tail of a running segment | build work items | Explore created when the second arrives; parent stays in_progress | UI unit | covered-unit |
| ETS02 | Execute/Write/other visible tool after Explore | build work items | The preceding Explore is completed | UI unit | covered-unit |
| ETS03 | Assistant text or visible reasoning after Explore | build flow/chunk | Explore completed | UI unit | covered-unit |
| ETS04 | Only hidden non-first reasoning between Explore children, segment still running | turn reasoning off | Explore still aggregates and stays in_progress | UI unit | covered-unit |
| ETS05 | A child is still running but a non-Explore boundary already follows | build work items | Explore parent completed; the child itself stays running | UI unit | covered-unit |
| ETS06 | Explore at the tail of a terminal segment | cold/live render | Parent completed; stopped when a child is cancelled | UI unit | covered-unit |
| ETS07 | Execute children running/completed | same-change regression | Execute uses the same stage boundary; classification and detail stay independent | UI unit | covered-unit |
| ETS08 | desktop/replayable get the same rows and segment terminal fact | renderer build | Same Explore parent status; delivery/recovery unchanged | shared invariant | partial |
| ETS09 | A running Shell row whose command has not arrived follows Explore | stream-complete command | The unclassified stage is fully transparent; readonly merges into the existing Explore; Explore ends only after execute appears | UI unit | covered-unit |

## Completed duration

After Explore and Execute parents settle, the summary appends the stage duration, for example `Explore · 3 searches, 1 file · 4s`, `Execute · 2 commands · 12s`. Both share the same derivation function and display rules.

| Rule | Decision |
| --- | --- |
| Source | Only projected rows: `max(child.endedAt) − min(child.createdAt)`; the renderer reads no local clock |
| Visible | Parent is completed/stopped and every child row has `endedAt` |
| Hidden | Parent in_progress, or any child lacks `endedAt` (old snapshot, terminal state not projected): hide the whole duration, never estimate |
| Format | Reuse `formatConversationWorkDuration`, same unit and locale spacing as turn-level work duration |
| Owner | The V4 projection (CLI) owns row timestamps; `buildExploreGroup` / `buildExecuteGroup` derive `durationMs`; the renderer only displays |
| Out of scope | Thought token count: existing rows carry no per-reasoning-block token fact, so no estimate |

| ID | Setup | Assertions | Evidence | Status |
| --- | --- | --- | --- | --- |
| ETS10 | Two completed children both have createdAt/endedAt | Parent node `durationMs` is the full span | UI unit | covered-unit |
| ETS11 | Parent in_progress, or any child lacks endedAt | `durationMs` not derived | UI unit | covered-unit |
| ETS12 | Render a completed Explore with `durationMs` | Summary shows formatted duration; running shows none | UI unit | covered-unit |
| ETS13 | Completed Execute group with child timestamps | Parent node derives and renders the same-format duration | UI unit | covered-unit |

## Pruning decisions

| ID | Pruned combinations | Guard/invariant | Representative coverage |
| --- | --- | --- | --- |
| ETS-P01 | Shell/Read/Search tool-name permutations | Existing `isExploreToolCall` classifies | Read + readonly Bash |
| ETS-P02 | theme/locale/OS/workspace type | State derivation has no copy, theme or platform branch | focused UI unit |
| ETS-P03 | continuous/replayable network permutations | Uses projected rows/turn facts, no transport change | shared renderer + existing STIP03 |
| ETS-P04 | Execute tool type and state permutations | Execute reuses the stage boundary function; classification/summary verified independently | Execute representative unit |

## E2E handoff

- The first version uses deterministic row/chunk builder focused tests.
- Formal E2E can use a controlled stream: complete Read and Grep consecutively to build Explore, delay a third read-only tool and assert Explore is not shown completed during the gap; then send a non-Explore Bash and assert Explore settles.
- Real mobile gap/snapshot stays proven by the existing replayable case, not replaced by a desktop fixture.
