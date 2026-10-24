# Start Plan admission-busy retry within the first user turn

## Problem

Start Plan (`account:zai-start-plan`) rejects requests with provider business codes
3008/3009/3010 ("model concurrency limit exceeded", HTTP 429) when the account is at its
admission limit. The adapter classifies these as non-retryable for `main_turn`; core owns a
dedicated short admission retry (`getStartPlanBusyAdmissionRetryDelayMs`, delays 1s/2s).

That retry is gated on more than `turnNumber` (the session's count of completed user turns):
a plain `turnNumber <= 0 → no retry` rule failed the first user turn on the first busy
rejection — including mid-turn, after several model steps, visible output and tool calls had
already happened.

## Product rule

- The very first model request of a brand-new session (no completed user turn and no prior
  model request in the current turn) is **not** retried. The busy error surfaces at once so the
  initial-busy upgrade banner shows immediately.
- Every later model request is retried on Start Plan admission busy: requests in any later
  user turn (`turnNumber > 0`), and later model steps of the first user turn
  (`modelStepCount > 0`).
- Retries still use the existing schedule (1s, then 2s; 2 retries max). When the busy rejection
  persists, the turn fails with `StartPlanBusyAutoRetryExhaustedError`
  (`START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE`, provider code preserved).

`modelStepCount` counts model requests already issued in the current turn loop: completed
rounds plus discarded/replaced ones (stream recovery, off-peak takeover, admission retry). The
rule is "a model request already happened in this turn", not "a round succeeded".

## Owner and interface

- Owner: core runtime, `apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts`
  `getStartPlanBusyAdmissionRetryDelayMs`. The gate is evaluated before the retry branch in
  `turn-model-step.ts` increments `modelStepCount`, so the first request still sees 0.
- No protocol, UI or adapter change.

## Acceptance

1. First turn, first model request busy → 1 model call, no `StreamRecoveryRetryStarted`, turn
   fails with the raw busy error (existing test).
2. First turn, step 1 completes a tool call, step 2 busy once then succeeds → one
   `StreamRecoveryRetryStarted` (`retryNumber: 1, maxRetries: 2`), a
   `start_plan_admission_retry_discarded` assistant row, and the turn completes.
3. First turn, step 1 completes a tool call, busy persists → two retries, then `TurnError`
   with `START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE` and the original provider code.
4. Later turns keep retrying as before (existing test).

## Not covered

- `streamRecoveryRetryCount` is shared with generic stream recovery for the whole turn and is
  used as the admission-delay index. A turn that already consumed 2+ stream recoveries gets no
  admission retry. This limitation already existed for later turns and is left as is.
