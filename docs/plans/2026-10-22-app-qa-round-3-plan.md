# 2026-10-22 App QA + stabilization plan (round 3)

Follows `docs/plans/2026-10-22-app-qa-round-2-plan.md` (round 2, closed with fix pack 2 on PR #276). Findings ledger stays `docs/plans/2026-10-21-qa-findings.md`.

## Inputs from round 2

- PR #275 (fix pack 1, 26 commits) green and mergeable; PR #276 (fix pack 2, stacked, 13 commits) mergeable clean, reviewer pass done, should-fix landed. Repository CI runs only for PRs based on `integration`, so #276's evidence is the local gates posted on the PR.
- Fixed and verified live: first-submission retry double-send (identity-checked admission), affected-runner Node 26 flag (ISSUE-017), chunked turn-navigator hydration (open 570 → 150–188 ms), incognito marker durability + broadcast (ISSUE-022), model trajectory viewer freeze (ISSUE-023, 5.8 s → 171 ms).
- Phase D exercised: split view, Help menu, remote-connection dialog cancel path, Check for updates (dev-skipped). Not drivable over CDP: multi-window, quit confirmation, deep links, mobile pairing.
- Pushing: SSH pushes die of SIGPIPE behind the ~6 min pre-push verify; push over HTTPS. The verify refuses a dirty tree and a push whose ref is not HEAD.

## Phase A — Land and sync

1. User merges #275 then #276 (or #276 is rebased onto `integration` after #275 lands). After each merge: `git fetch`, merge `integration` into the working branch, rerun gates, re-smoke first send, incognito, session open, trajectory.
2. Push the three docs/harness commits sitting on the local PR-1 branch (a53c598c, b980d7d6, 1c668f7e) when that branch is checked out, or let #276 carry them.

## Phase B — Decisions needed from the user (unchanged, ask once)

| Item                         | Options                                                                  | Default if no answer             |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| ISSUE-010 Stop vs queue      | keep queue running / pause with "Resume queue" / drop queue              | keep (document in spec)          |
| ISSUE-012b orphan sweep      | storage-prep worker sweep before any Host / leave rows                   | implement in storage-prep worker |
| ISSUE-020 search scope       | search all local workspaces / keep open tabs only                        | keep (upstream-identical)        |
| `writeRecord` cli\_\* mirror | remove after auditing the summary mirror path / keep                     | audit first, then remove         |
| Trajectory delta contract    | Host sends per-record deltas + offsets, viewer reconstructs / keep bound | implement (M, services + ui)     |

## Phase C — Fix pack 3 candidates (ranked)

1. First-submission remaining limitation (spec `first-submission-instant-ux.md` "Remaining limitation"): the bridge's `executeCommand` hook marks a preparation active on any `sendText`; it should flip only for the frozen submission's own command, and `firstSubmissionReconciliation.ts` must query the original id instead of the marker shortcut (M, cli + ui).
2. Trajectory delta contract if approved (M). Otherwise: cap the number of input rows projected per record on the Host with the same marker (S).
3. Navigator cold jumps (~250 ms, React commit of 10–20 cold turns): seed `DEFAULT_ROW_HEIGHT_ESTIMATE_PX` from the median measured height so `scrollToIndex` lands once; measure before/after (S, ui).
4. Grouped sidebar switch to grouped view 173 ms on 1949 tasks: profile the first grouped render (S–M, ui).
5. Convergence broadcast cost: `task_meta_changed` is a global membership refetch; evaluate an incremental reason for single-row marker writes (S, ui/services).
6. ISSUE-012b sweep and `writeRecord` mirror removal if approved (M each, services).
7. Parked branch `claude/plugin-discovery-host-ordering`: measure the renderer's subscribe vs readPresentation order on the dev build, then land or drop (S).
8. Update flow on the dev build with `--zcode-auto-update-dev` and a dev version override: dialog states, download, relaunch prompt (S, manual via CDP).

## Phase D — E2E and fixtures

- IUX01–09 need a provider replay fixture; record one from the dev build (capture mode) so first-submission E2E runs on this Mac.
- Add a ≥ 1000-row recorded conversation fixture and a long-task gate for session open and trajectory open (`docs/performance/profiling-plan.md` proposal).
- Extend the trajectory E2E with a > 40-row card (collapsed default, show next, search reveal).

## Phase E — Manual pass (user or packaged build)

- Multi-window on the same workspace, unread CAS across windows; quit confirmation with a running session and resume; deep links `workspace/open` and `task/new`; mobile pairing after sign-in.

## Cleanup before closing the goal

- Delete the QA sessions created in the shared CLI db (pong, incognito-ok\*, instant-ok, pack2-ok, pack2-final-ok, git branch, fork, outside-ok-5) from the dev build's own list; restore or discard the dev index copy; stop the dev app; release keep-awake.

## Re-plan trigger

When Phase C 1–3 are merged or deferred and the user's Phase B decisions are in, write round 4.

## Progress (2026-10-22 04:40)

- Phase C 3 tried and discarded: seeding unmeasured row heights with a latched median of measured heights (gated to following state) changed nothing live: cold jumps 10 → 20 → 1 measured 253 / 72 / 256 ms via HMR and 293 / 69 / 268 ms after a restart, against 254 / 62 / 246 ms before. The cost is the React commit of 10–20 never-rendered turns plus the measurement re-render, not the estimate correction. Next attempt needs a React Profiler trace of one jump (count commits, find the heaviest subtree) before any change.
- Phase C 1: renderer half landed (3ef1fa16, reconciliation asks the ledger about the record's own id first). Bridge half in progress with the submission id carried on the frozen `sendText` (a retried frozen input is a new sendText with a fresh id, so the activation's command id cannot key the marker).
- ISSUE-023 review follow-ups in progress (reveal window, mixed-message search/preview, `{content}` unwrap before cut, show-next label, two surviving mutations, spec alignment, E2E scenario).
- Phase C 1 bridge half landed (4f01049b): the frozen first `sendText` carries `firstSubmissionId`; the bridge completes a reserved preparation only on it. Open boundary found on the way: an id-less activation (older renderer, or a record that lost its command id) still counts any admitted `session_input` row as admission, so a foreign row can complete the preparation on such a retry; closing it needs the ledger row to carry the submission id (follow-up, protocol + CLI).
- ISSUE-023 review follow-ups landed (0c99821a); E2E TRJ11 written, run pending with the dev app stopped.
- ISSUE-024 found: the E2E baseline on the fork is broken for every spec that expects the seeded legacy workspace to become a project (the Host path seeds no projects since 46c33e9d). Decision for the user (Phase B): keep the fork rule and make the harness create the default project through the app's own flow (default, in progress), or pass settings on the Host path so legacy `lastWorkspaceSession` entries migrate into projects as upstream does (affects pre-3.12 upgraders).
