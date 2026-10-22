# 2026-10-22 App QA + stabilization plan (round 2)

Follows `docs/plans/2026-10-21-app-qa-orchestration-plan.md` (round 1, closed with fix pack 1). Findings ledger stays `docs/plans/2026-10-21-qa-findings.md`.

## Inputs from round 1

- Fix pack 1 PR open against `integration` (24 commits, reviewer pass done, live re-verification done).
- Open issues: ISSUE-010 (queue runs after Stop, product decision), ISSUE-012b (startup sweep for already-orphaned reservation rows, design decision), ISSUE-017 (affected-test runner isolation flake), reviewer item "discard on `deleteSession` rejected `proto.sessionNotFound`", `writeRecord` still mirrors `updated_at` into `cli_updated_at` (primary writers fixed; mirror removal needs the syncer summary path audited first).
- Spec audit leftovers: `first-submission-instant-ux` (`preparedActivation` unused in UI, no IUX E2E), `ui-tests-translation-ledger` missing assertion, `plugin-discovery-process-cache` Host ordering, E2E scenarios written but never run (FSL, IUX, incognito 13/17/31, PRT-023).
- Perf: opening a 1052-message session blocks 570 ms (whole conversation loaded in one snapshot); turn-navigator jump 178 ms.

## Phase A — Land pack 1 and sync (first)

1. Watch PR CI; fix anything CI-only (CI runs the root suite; CLI tests were run locally).
2. When `integration` moves, merge it into the working branch, rerun gates, re-smoke the touched flows.

## Phase B — Decisions needed from the user (ask once, batch)

| Item                         | Options                                                                       | Default if no answer             |
| ---------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| ISSUE-010 Stop vs queue      | keep queue running / pause queue on Stop with "Resume queue" / drop queue     | keep (document in spec)          |
| ISSUE-012b orphan sweep      | storage-prep worker sweep before any Host (safe: no live drafts) / leave rows | implement in storage-prep worker |
| `writeRecord` cli\_\* mirror | remove (applyCliFacts sole writer) after auditing summary mirror path / keep  | audit first, then remove         |

## Phase C — Fix pack 2 candidates (ranked)

1. Reviewer item: discard reservation on `deleteSession` rejected with `proto.sessionNotFound` (S, services).
2. ISSUE-012b sweep in the storage-prep worker (M, services/desktop) if approved.
3. `writeRecord` mirror removal after audit (M, services) if approved.
4. `first-submission-instant-ux`: consume `preparedActivation` in the UI to skip the frozen `sendText` (M, ui) + run IUX01–09 E2E.
5. `ui-tests-translation-ledger`: add the missing `not.toContain(fallback)` assertion and remove the fallback label (S, ui).
6. `plugin-discovery-process-cache`: Host ordering (first `subscribe` before `workspace/readPresentation`) (M, services).
7. Session open cost: window the initial snapshot (first N turns + lazy older) or defer heavy renderers until first paint; target < 200 ms worst block on the 1052-message session (L, ui/services; measure first).
8. ISSUE-017: affected-test runner isolation (S, scripts).
9. Composer: `firstSubmissionDelivering` / `attachmentsNotReady` still raise deduped notices; decide whether they are transient (S, ui).

## Progress (2026-10-22 01:35)

- Phase C 1 done (09385ad8). Phase C 5 resolved as by-design with a pinned test (cc95aa71). Phase C 6 implemented but parked on `claude/plugin-discovery-host-ordering` (7c0495f0): the gate only helps if the Host sends the subscribe before the renderer requests readPresentation, which is not yet measured; needs a renderer-side ordering decision. New: ISSUE-019 restored draft with a deleted project → null scope (158cc676).
- Phase D real-scale pass done on a copy of the real index (see findings ledger): no block over 173 ms in sidebar, tables or search; ISSUE-020 search scope recorded as a product decision.

## Phase D — Remaining manual matrix

- Multi-window: second window on the same workspace, sidebar sync, unread CAS across windows.
- Quit confirmation with a running session; relaunch and resume.
- Update flow (Check for updates dialog states) on the dev build with a mocked feed if available.
- Remote connection flow (New remote connection…) up to the SSH prompt; cancel path.
- Deep links (`workspace/open`, `task/new`) on a packaged build or Linux/Windows argv path.
- Real-data scale: open the shared index with 1949 tasks in grouped view; measure sidebar long tasks, search latency.
- Mobile remote control pairing page after sign-in (needs the user's account).

## Phase E — Run the written-but-unrun E2E

- `pnpm test:e2e` subsets: first-submission (FSL/IUX), incognito 13/17/31, resource telemetry PRT-023. Record which pass on Node 26 (spec `desktop-e2e-node26-compatibility`).

## Re-plan trigger

When Phase C items 1–6 are merged or explicitly deferred and Phase D is exercised, write round 3 (perf windowing, remaining spec gaps, upstream sync of 3.16.x if it lands).
