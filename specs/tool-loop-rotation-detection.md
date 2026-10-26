# Tool-loop detection: polling exemption and short-rotation detection

Status: agreed first step; no model review, no turn stop, no new config keys. Both detections
reuse the existing model-anomaly reminder/event pipeline (`ModelAnomalyWarning` +
`systemReminderAttachmentEntry("model_anomaly", …)`, shared `maxBudgetWarningsPerTurn` budget).

## Problem

The existing exact-repeat guard (`repeated_tool_call`) only fires when the _same_ tool call
(name + input) repeats consecutively. Two common loop shapes escape it:

1. **False positives from legitimate polling.** A model that correctly waits on a background task
   (`TaskOutput` returning `not_ready`, a `GetWorkflowRun` poll, `tail build.log` watch loops)
   can trip the exact-repeat streak even though it is making progress.
2. **False negatives from short rotations.** A model cycling `Read A → Read B → Read A → Read B …`
   (or a 3-tool rotation) never repeats consecutively, so no warning fires while the turn burns
   model steps without progress.

## Polling exemption

A tool call is **exempt** from loop detection (both the exact-repeat streak and the rotation
window) when any of the following holds:

1. Tool name is `TaskOutput` or `GetWorkflowRun`.
2. The call is a `TaskOutput` whose result output carries `retrieval_status` `not_ready` or
   `timeout`.
3. A **successful** call with `durationMs >= 30_000` (`POLLING_MIN_DURATION_MS`). This covers
   intentional waits such as `sleep 60 && …`. A failed slow call is not exempt: re-running the same
   45 s failing `pnpm test` with no edits in between must still trip the exact-repeat warning.
4. The call is a **successful** Bash command whose command string consists solely of
   log-tail segments, optionally chained with `;` or `&&`:
   - POSIX: `tail [-n N|-N] <literal .log path>` (the count flag is optional).
   - Windows: `Get-Content -Tail N <literal .log path>`.

A tail path is _literal_ when, after stripping one pair of surrounding quotes, it contains no
whitespace (unquoted form), no shell metacharacters (`$ ` ` ` `| < > ( ) & ; '` `"`), and ends in
`.log` (case-insensitive). Failed tails, pipes, redirects, command substitutions, and reads of
non-`.log` source files are **not** polling.

Explicitly rejected alternatives (do not add): a bare `sleep` rule (the duration rule already
covers waits) and a "30 s gap between call starts" rule (it would disable detection for slow
models).

### Transparency semantics

- Exempt calls **neither advance nor reset** the exact-repeat streak or the rotation window; the
  surrounding sequence keeps its state across them.
- Calls without a result (e.g. cancelled) count as normal calls — except the name-based rule,
  which does not need a result.
- `AskUserQuestion` answers do **not** reset the window; an answer is an ordinary call with its
  own signature.

## Short-rotation detection

State on `RegularTurnLoopState`: `toolLoopHistory?` holding the last `3 × threshold` (**9** by
default) non-exempt call signatures (`toolName + stableJson(input)`, the same key as the exact-repeat guard) with each
call's model-step index, plus a fire-once latch.

Detection runs after each tool batch settles, on the non-exempt calls in model order:

- Periods checked: `p ∈ {2, 3}`.
- Threshold: `N = repeatedToolCallWarningThreshold` (default 3); disabled when `N <= 0`.
- Fire when the last `p * N` signatures are one cycle of `p` **pairwise-distinct** signatures
  repeated `N` times.
- The matched run must span **>= 2 model steps** (distinct step indices between its first and
  last entries). A single batched response `[A, B, A, B, A, B]` does not fire.
- Fire **once** per matched cycle; re-arm only after the cycle breaks (a later call that does not
  fit the ongoing pattern).
- Shares the turn's `anomalyWarningsInjected` budget with the other model-anomaly warnings.

Reset points (identical to the exact-repeat streak): turn state creation, drained runtime
commands (`turn-loop.ts`), and inline guide drain (`turn-guide-drain.ts`).

## Output contract

- Event: `ModelAnomalyWarning` with `category: "tool_call_rotation"`, `severity: "warning"`,
  `observedCount = cycles`, `threshold = N`, `toolCallId`/`toolName` of the call completing the
  cycle, `warningInjected` (false when the budget is exhausted; the event is still emitted).
- Reminder (when injected): `You have been cycling between X, Y[, Z] (period p) N times without
progress…` — tool names only, never inputs.
- Log: `logger.info` with event `model_anomaly.tool_rotation` carrying period, tool names, cycles.

## Acceptance scenarios

1. `Read A / Read B` ×3 cycles → rotation warning at call 6.
2. `A → B → C` ×3 cycles → rotation warning at call 9.
3. `Edit` ping-pong (two Edit inputs alternating) → warns.
4. `Read f → Edit f (new input each time) …` → no warning (signatures differ per cycle).
5. `build fail → Edit fix1 → build → Edit fix2 → build` → no rotation warning.
6. `TaskOutput not_ready` ×5 → no warning (name-exempt).
7. `Read A, TaskOutput, Read A, TaskOutput, Read A` → existing `repeated_tool_call` warning still
   fires (exempt calls are transparent to the streak).
8. One batched model step returning `[A, B, A, B, A, B]` → no rotation warning.
9. Guide input drained mid-cycle → window resets.
10. Successful `tail -n 50 build.log` ×4 → no warning; the _same tail failing_ ×3 → the existing
    `repeated_tool_call` warning fires.
11. Warning budget exhausted → rotation event still emitted with `warningInjected: false`.
