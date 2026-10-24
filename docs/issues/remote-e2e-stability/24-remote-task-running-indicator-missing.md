# Remote session is generating but the sidebar task row has no running indicator

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, patch 08, batch `r3-server-20261011143037600-31012b`;
`p0-main` failed after 150.8 s.

The earlier replay used a fixed 1200 ms response that could miss the running state; it now uses an explicit
gate: after B's first segment is emitted, the end frame is held until the sidebar assertion finishes. During
the 30 s wait the task row state stayed `exists=true, inProject=true, active=true, error=false, running=false`,
while the video shows the main area "工作中 31 秒" (working 31 s), the generating indicator and the stop
button. Early completion, a missing row and wrong ownership are therefore excluded.

```text
B first segment → replay gate blocks the end → main area keeps working
  → B sidebar row active, no error → no running icon within 30 s
```

The row uses `deriveTaskLeadingIndicator` to choose the loading icon. The projection from remote TaskActivity
to the project row must be checked; the specific subscription or cache is not yet identified. Business code is
unchanged. The test keeps the final failure but defers this non-routing display difference to the end so the
A/B four-turn history isolation and telemetry checks still run; row ownership, active or error anomalies still
stop immediately.

Patch 09, batch `r3-server-20261011150809016-2aeaba`, ran the four turns and telemetry and finally failed
(209.1 s) only on the missing running icon of two B rows: A/B each had 2 `agent_step` and 2
`message_completion` events, remote ownership and history isolation passed, and B's first and follow-up
observations were both active=true, running=false.

Evidence: run log and failure video of `p0-main`; the four real HTTP replay-gate focused tests pass.
