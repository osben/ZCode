# Goal Manual Review Case Coverage

Goal e2e covers some combinations with hard assertions; the remaining state combinations are manual-review cases that run automatically to an observable state and record UI, queue, network, and runtime evidence as artifacts for human acceptance — not new strong-assertion e2e.

Scope (non-error paths only):

- Set goal on completed without goal: UI target, network request, runtime, persistence clues.
- Update goal on completed with goal: replacement keeps only the current goal.
- `/goal` while running with/without goal: enqueue only, no immediate request; goal updates on consumption.
- Goal continuation stopped: completed/interrupted semantics, no paused, queue retained and not auto-consumed by default.
- Goal verification phase: no separate validating disabled state in UI; capture compact/fork/edit control states.
- Queue mixing multiple goals, plain text, `/compact`: order, goal kind, edit, delete, reorder, "guided now" consumption.
- Manual/auto compact with queued goals: success, stop, and not-triggered-on-failure current state; failure paths stay non-asserting.
- Fork/edit/session-switch combinations: controls disabled while goal running and restored after; goal semantics after editing an old query; goal/queue/model do not leak across session switches.

Explicitly not covered (error paths): 429, 503, SSE interruption, sidecar failure, network loss, full disk.

Implementation:

- Extends `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-goal-run-cases.test.ts`.
- Keeps `ZCODE_E2E_MANUAL_REVIEW=1` and capture mode, producing per-step screenshot, chat root, queue, messages, tool blocks, network summary.
- Unstable or failure-injection scenarios use "observe but do not fail": wait a short window, then record any unobserved state into the artifact and continue.
- The manual review summary's request digest shows whether recent model requests contain `/goal`, goal markers, and compact sentinels, to check the protocol layer does not pass `/goal` through as a plain user message.

Acceptance: after running the spec, inspect `manual-review/goal-run-cases/<case>/summary.md` — `chat.targetObjective` / `chat.targetStatus` match the case; `queue` kinds and order match; `network.recentModelRequests` match protocol expectations; `messages` hide goal continuation/system reminders; `details` control states, store snapshots, and compact markers match the product definition.
