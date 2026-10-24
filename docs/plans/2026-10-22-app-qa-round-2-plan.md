# 2026-10-22 App QA + stabilization plan (round 2)

Full history: `git show b8876e8b:docs/plans/2026-10-22-app-qa-round-2-plan.md`

Follows `docs/plans/2026-10-21-app-qa-orchestration-plan.md` (round 1, closed with fix pack 1). The findings
ledger stays `docs/plans/2026-10-21-qa-findings.md`. Round 2 closed with fix pack 2 on PR #276; round 3 is
`2026-10-22-app-qa-round-3-plan.md`.

## Inputs from round 1

- Fix pack 1 PR open against `integration` (24 commits, reviewer pass and live re-verification done).
- Open issues: ISSUE-010 (queue runs after Stop, product decision), ISSUE-012b (startup sweep for already-orphaned reservation rows, design decision), ISSUE-017 (affected-test runner isolation), reviewer item "discard on `deleteSession` rejected `proto.sessionNotFound`", and `writeRecord` still mirroring `updated_at` into `cli_updated_at` (primary writers fixed; mirror removal needs the syncer summary path audited first).
- Spec audit leftovers: `first-submission-instant-ux` (`preparedActivation` unused in UI, no IUX E2E), `ui-tests-translation-ledger` missing assertion, `plugin-discovery-process-cache` Host ordering, E2E scenarios written but never run (FSL, IUX, incognito 13/17/31, PRT-023).
- Perf: opening a 1052-message session blocked 570 ms (whole conversation loaded in one snapshot); turn-navigator jump 178 ms.

## Phase A - Land pack 1 and sync (first)

1. Watch PR CI; fix anything CI-only (CI runs the root suite; CLI tests were run locally).
2. When `integration` moves, merge it into the working branch, rerun gates, re-smoke the touched flows.

## Phase B - Decisions needed from the user (ask once, batch)

| Item                         | Options                                                                       | Default if no answer             |
| ---------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| ISSUE-010 Stop vs queue      | keep queue running / pause queue on Stop with "Resume queue" / drop queue     | keep (document in spec)          |
| ISSUE-012b orphan sweep      | storage-prep worker sweep before any Host (safe: no live drafts) / leave rows | implement in storage-prep worker |
| `writeRecord` cli\_\* mirror | remove (applyCliFacts sole writer) after auditing summary mirror path / keep  | audit first, then remove         |

(Decided in round 3; see `2026-10-22-app-qa-round-3-plan.md`.)

## Phase C - Fix pack 2 candidates and outcome

1. Discard reservation on `deleteSession` rejected with `proto.sessionNotFound` (S, services): done, 09385ad8.
2. ISSUE-012b sweep in the storage-prep worker (M, services/desktop), if approved.
3. `writeRecord` mirror removal after audit (M, services), if approved.
4. `first-submission-instant-ux`: consume `preparedActivation` in the UI to skip the frozen `sendText` (M, ui) and run IUX01-09 E2E: shipped in fix pack 2 (50809fe3). The CLI returns `preparedActivation` on the `createSession` ACK and the renderer skips the frozen `sendText` for an already-admitted reserved submission.
5. `ui-tests-translation-ledger`: add the missing `not.toContain(fallback)` assertion and remove the fallback label (S, ui): resolved as by-design with a pinned test (cc95aa71).
6. `plugin-discovery-process-cache` Host ordering (first `subscribe` before `workspace/readPresentation`) (M, services): implemented but parked on `claude/plugin-discovery-host-ordering` (7c0495f0). The gate only helps if the Host sends the subscribe before the renderer requests readPresentation, which is not measured; needs a renderer-side ordering decision.
7. Session open cost (L, ui/services): the subscribe snapshot is already a 60-row tail; the 570 ms block was `loadAllOlder()` committing ~1480 older rows in one `setState` for the turn-navigator directory, plus an uncached share-mode `buildConversationTurnRenderUnits` in `SessionPane`, plus O(all assistant chars) preview normalisation. Shipped option A (renderer-only: chunked per-page commit with `loadingOlder` held, share build gated on `shareActive`, bounded preview slice; 6e2da170): session open 570 -> 188 ms worst block. Option B (protocol-level turn directory) deferred as a second source of navigator truth.
8. ISSUE-017 affected-test runner isolation (S, scripts): done (74f5978b).
9. Composer: `firstSubmissionDelivering` / `attachmentsNotReady` still raise deduped notices; decide whether they are transient (S, ui): open.

Fix pack 2 holds five commits at close: 50809fe3 preparedActivation, 74f5978b affected runner, 6e2da170 chunked
hydration, a810494d + 4f9c41ad incognito marker. New issues found: ISSUE-019 (fixed 158cc676), ISSUE-022
incognito marker (fixed), ISSUE-023 trajectory viewer freeze (fixed, spec first; open follow-up: the model-io
file repeats the full restored context per record, 5 x ~1.16 MB; a delta contract between Host and viewer
would bound the payload across records).

Grouped sidebar design note: it renders persisted tasks-index facts plus the activity sidecar only; live
sessions-index overlay fields (incognito, worktree) reach only the flat list. Durable markers are therefore
required, which the placeholder fix and the broadcast provide.

Push note: git opens the SSH connection before the ~6 min pre-push verify, GitHub closes it idle and git
dies of SIGPIPE (exit 141) with no output. Push over HTTPS keeps the hook and avoids the idle connection.

## Phase D - Remaining manual matrix and results

Real-scale pass on a copy of the real index (1949 tasks): no block over 173 ms in sidebar, tables or search
(ISSUE-020 search scope recorded as a product decision).

- Split view: "Open in split view" from a task's context menu opens a second session pane (2 pane roots); no errors.
- Help menu: all nine entries present. "Check for updates" on an unpackaged build returns `dev-skipped` silently (no toast, no log line); exercising the flow needs `--zcode-auto-update-dev` or a packaged build.
- Multi-window and quit confirmation are app-menu actions (no in-app control), not drivable over CDP: manual pass.
- Remote connection: entry is Settings -> Remote devices -> "New connection" (not the Projects header). The dialog opens with Host, Port 22, Username and Password fields and closes cleanly on Cancel; no errors logged.
- Not yet done: deep links (`workspace/open`, `task/new`) on a packaged build or Linux/Windows argv path; mobile remote control pairing page after sign-in (needs the user's account).

## Phase E - Run the written-but-unrun E2E

`pnpm test:e2e` subsets: first-submission (FSL/IUX), incognito 13/17/31, resource telemetry PRT-023. Record
which pass on Node 26 (spec `desktop-e2e-node26-compatibility`). Results are in the findings ledger.

## Re-plan trigger

When Phase C items 1-6 are merged or explicitly deferred and Phase D is exercised, write round 3 (perf
windowing, remaining spec gaps, upstream sync of 3.16.x if it lands).
