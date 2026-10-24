# 09 — Return to the Original Place after Reconnect or Restart

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** [08 — Disconnect experience and in-place reconnect](./08-disconnect-experience-and-in-place-reconnect.md). The placeholder and banner shown before reattachment completes come from 08.

**Behavior to deliver:**

- **After reconnect**: return to the session being viewed before the disconnect. If that session no longer exists, open the project's new-task page.
- **After app restart**: restore the last active project and session.
  - Until the remote project reattaches, show only a "connecting" placeholder.
  - If the reattach ends "not connected" or "failed", stay on this tab and show the banner; do not jump to a local project automatically.
- **Scope**: these changes apply only to desktop continuous recovery; mobile replayable recovery stays unchanged.

It corresponds to the "return to the original place" part and the sequence diagram of the "reconnect and recovery" section of the parent spec.

Scope:

- **Recovery target owner**: reuse the existing tab persistence to record the recovery target; no new owner.
- **Reattach gate**: rules are not relaxed; no remote session content is rendered before reattachment completes.
- **Before starting**: check the [Renderer reattach gate document](../../remote/desktop-remote-session-renderer-reattach.md), then write the sequence diagram, owner and event order into the [navigation spec](../../remote/project-first-remote-navigation-spec.md).

Acceptance criteria (all met):

- The navigation spec contains the sequence diagram, the recovery target owner and the event order, consistent with the reattach gate document.
- After reconnect, return to the original session; when it no longer exists, open the project's new-task page. Needs tab persistence tests and E2E.
- After restart, restore the last active remote project and session; only the placeholder renders before reattachment completes. Needs reattach tests and the E2E cold-start reconnect case.
- When reattach fails, stay on the original tab and show the banner; do not jump to a local project automatically.
- Regress both the desktop continuous recovery and the mobile replayable recovery paths; all existing mobile remote-control tests pass.
- Committed locally after all of these pass: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests, affected E2E.

## Implementation and Verification Record (2026-09-28)

- Navigation recovery keeps reusing TabStore's project/active position and Layout's existing pane-selection persistence. Cold start keeps the original remote focus; background fill-in and Source reattach do not steal focus; when the original session no longer exists it returns to that project's new-task page.
- The recovery query reads the remote authoritative task-index only at the startup recovery or attachment reattach boundary; a new-task ACK earlier than the index write takes no part in deletion judgment. An RPC error keeps the target, and a navigation/attachment generation change cancels the old query. Reconnect carries a recovery-selection intent; ordinary directory selection keeps its original semantics.
- Regressions for tab persistence, same-path identity isolation, pane recovery, query cancellation, mobile disabling and the new-task index race went red then green; the existing Renderer readiness tests verify the remote data layer is not mounted before reattach. Findings of the local dual-axis review were fixed and re-checked.
- `pnpm typecheck`, `pnpm lint` (0 errors, 64 pre-existing warnings), `pnpm architecture:check --changed` (0 violations), E2E type check and the two affected fixture checks pass.
- Real SSH cold-start E2E PASS `r3-server-rdux09-cold-20260928-03`: in-place reconnect, the original B session after a complete Electron/Main/Host restart, original-tab banner and no-remote-content placeholder after auto-reconnect is turned off, new-task fallback for an invalid session ID.
- Mixed-project recovery E2E PASS `r3-server-rdux09-mixed-20260928-01`: original remote focus, active-first fill-in, open set neither lost nor duplicated, siblings reattach independently and the original task resumes sending.
- Mobile real relay + SSH E2E PASS `r3-server-rdux09-mobile-20260928-01`: desktop continuous and mobile replayable recovery together; the test page is built from the current branch source. All used macOS Electron → local isolated Linux Docker SSH target, phone as Chrome viewport; no real phone or cross-machine WAN verification.
- The first SSH round was blocked by an online announcement, so the existing account mock was wired into these two navigation cases; the second round's first send exposed a new-task index timing problem, fixed and verified by the regression tests and later real SSH PASS. The first full unit run concurrent with a build was aborted on memory pressure and is not counted as a pass.
- Final full unit run: `ZCODE_TEST_POOL=forks pnpm test:unit --maxWorkers=2 --reporter=dot`, 2,031 files / 18,683 passing, 2 files / 14 skipped by configuration, 3 files / 25 failing. 22 failures came from an old mock in layout tests missing the newly read selector/resolver interface (24 layout assertions pass once added); the other 3 came from unchanged updater tests (timeout and abnormal call counts afterward) and a 256 MiB slow upload out-of-process test. All failing files plus this change's tests were re-run serially: 7 files / 217 tests all passed, with no updater or upload implementation/test changed. The first full run's exit code is not described as a pass; later only test doubles changed and the full suite was not repeated.
- Required verification, failure re-runs and diff self-check are done; committed locally on the current branch per the implementation agreement, not pushed. E2E stays in manual-review/pending without manual promotion or Docker CI admission.
