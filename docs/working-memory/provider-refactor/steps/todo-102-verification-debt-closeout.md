# Todo 102: Provider / Selection Legacy Verification and Failure Uniform Closure

> Status: Pending execution (2026-09-09 update). This is the sole entry point for all residual untested items, existing
> failures and pending manual escalations of the Provider / Selection round; other approved development Todos are
> closed and no longer hang separate verification items. Existing passing evidence is kept; untested, failed and
> manually escalated items are accounted separately.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-102-verification-debt-closeout.md`

## 1. Sole Execution Entry and Scope

- Independent verification scheduling for Todo52, 57, 64, 78 is closed; residual verification of other implemented
  Todos is advanced only in this table. Closing means handed off, not that original failures now pass. Old documents keep
  historical results; on contradiction this table and later appended evidence prevail.
- Takes over residual verification of this round's Provider/Selection work from Todo34/40/58/60/62/68-79/83-100. It does
  not re-execute passing scenarios or take over the full product test backlog.
- Todo95C, 97 (Wiki migration), 98 (formatting) and the approved keyboard-isolation minor fixes are completed and
  accepted; real multi-platform, pending escalation and later verification are recorded only here.
- Todo11/22/45/80/86, Todo101 and independent CLI account assembly are out of scope; abandoned Todo15/19 are not resumed.
- Web publishing stays with the user; W99-E05 keeps the user's explicit deferral. No same-version pages, no substituting
  desktop results.
- 95C's Personal config compatibility decision is clear; old Selection best-effort mapping requirements remain valid.

## 2. Todo Table

| ID      | Source / item                                                    | Exact status                                                                                                                                                                                                     | Next step and closure evidence                                                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V102-01 | Todo78: Off-peak home page layout, quota pre-gate                | `off-peak-automations-home-layout`, `off-peak-limit-pre-gate` old runs never reached business assertions; no later passing records                                                                               | Reuse existing account entitlement/mock; confirm prerequisites then run; never modify production entitlement gates to pass tests. Save actual results of both specs                                                                           |
| V102-02 | Todo57/64/78/89: Real SSH Provider environment verification      | Old real remote cases have skip/credential-block records; not inferable as passing from earlier successful sends                                                                                                 | Verify current specs, target machines, artifact versions, isolated data; cover registered sync/reconnection/workspace isolation contracts; separate deployment failures from product failures                                                 |
| V102-03 | Todo99 W99-E05: Mobile shared-host + SSH same Session            | User explicitly deferred; same-version Web test pages not ready                                                                                                                                                  | Continue W99-E05 after the user provides the environment; no new mobile Host/Agent; continuous/replayable boundaries unchanged                                                                                                                |
| V102-04 | Todo89/90/92/93/94/95C/97/98: Multi-platform and visual evidence | Pro representative cases passed; mobile, Windows and Chinese/English/dark/light representative combinations not all tested. Todo98's 1200px / 390px screenshots prove only Electron layouts, not real mobile Web | Deduplicate against existing case/matrix; keep specific uncovered items; supplement only representative combinations (no full matrix or blanket re-run). Real mobile shared-host / SSH belongs to V102-03                                     |
| V102-05 | Todo85-99: Pending cases and fixture admission                   | Some passed on Air/Pro but are not manually escalated or in formal CI. Todo98's SC90-01 / F98-03 passed, but the fixture checker does not support the settings spec domain, so this is not tool-verified         | List pending specs and artifacts; after manual confirmation run promotion dry-runs, fixture validation and formal replays; verify settings validation tool support first; document Docker admission separately; no automatic batch escalation |
| V102-06 | Todo88/99: Remote Cron denylist                                  | 2026-09-09 targeted re-runs failed: expected Bash + four Cron, actual only Bash; design docs still require remote default-disabling Cron                                                                         | Verify current product contract and history; then test first and fix partially, or record an explicit withdrawal decision. Do not delete assertions to fake passing; no remote scheduling refactor                                            |
| V102-07 | Todo88 AS03: CLI SEA/TUI dependency closure                      | 2026-09-09 targeted re-runs failed: extracted runtime directory missing `@zcode/shared/src/index.ts`                                                                                                             | Verify build outputs and package exports; fix closure in the existing build process; run loading tests against the extracted runtime directory. Unrelated to deferred CLI account architecture                                                |
| V102-08 | Todo69: Complete old App rollback and real vendor scope          | Only stage storage compatibility proven; complete old App rollback not done; mock request evidence does not prove all real vendors                                                                               | Keep the evidence gaps; add no publishing gates; confirm exact environments/scope before any real rollback or account call. Never touch real user configs or probe account risk controls                                                      |

## 3. Existing Evidence, Not Re-listed as Failures

- Todo114 (upstream original Todo105), 2026-09-10: Account reason sync and personal-plan missing-Key retry passed 280
  targeted tests and four-component-browser interactions; complete Electron and real mobile shared-host/SSH not yet
  executed. Later supplement: settings page retry and same-snapshot available-plan sync under business fixtures
  expressing "logged in + missing Key / no personal plan"; branch fixture limits are in
  `docs/coding-plan/connection-status-semantics.md` §8. Component results must not be passed off as complete App passing.
- Todo78 settings polish, QR reminders, Subagent settings and plan tags have later passing evidence.
- Off-peak `off-peak-create-manage` passed 2/2 on Air after Todo85 (`desktop-e2e-20260907063653634-p19967-a275f6886f7e448a`);
  this is not V102-01's two specs and does not prove cross-account ticket switching (not in contract).
- Todo84's highest-level proactive selection was completed by Todo88 R11; AS02 damaged selection is accepted as
  inheritance.
- Todo96's explicit Subagent blocking was completed by Todo99 Worker-local public parsing and DI assembly; old Host RPC
  schemes are not discussed again.
- Todo99 implementation commit `b4ffe44db0`; Pro re-run `desktop-e2e-20260909112629814-p20925-4b9a692d8243878d`, Worker
  spec 3/3 passed ([Todo99 ledger](../research/todo99-implementation-review.md)); not a substitute for V102-03.
- Todo95C `2c1addd3d8`: closed levels uniform, historical selection mapping done; Pro `desktop-e2e-20260909-121842-573` 3/3.
- Todo97 `9cd1ae31dd`: Wiki one-dispatch migration done; 146 unit tests and Pro `desktop-e2e-20260909-122856-891` 1/1.
- Todo98 `a5fb82ec4a`: 65 Map AST / 505 group evaluation comparisons passed; 422 related tests and Pro
  `desktop-e2e-20260909-125010-082` 2/2. Early keyboard-space sorting trigger and version conflicts were reproduced and
  fixed; remaining scope belongs to V102-04 / V102-05.

## 4. Execution Rules

```text
Old Todos' historical evidence -> deduplicated registration here -> verify current code, cases, prerequisites
  -> passed / not run / environment-blocked / product-failed / pending manual review
  -> supplement evidence or explicitly defer; write back to this table
```

1. Prioritize existing runnable partial failures and missing prerequisites; one environment block does not stop other
   independent verifications.
2. E2E reuse existing catalogs, coverage matrices and `e2e-case-lifecycle`; read related specs before adding tests; do
   not modify unknown product semantics or opportunistically expand sync architecture.
3. Prefer MacBook Pro isolated directories; record source commit/dirty differences, build versions, run IDs, exact
   assertions and artifacts. Protocol-related items confirm matching Host/Worker.
4. New product bugs are reproduced and tested first, then fixed; new product decisions are discussed first. Fixture
   errors and real bugs are recorded separately; "baseline also failed" is not a fix.
5. Code changes run related tests, `pnpm typecheck`, `pnpm lint`; E2E changes add `typecheck:e2e` and fixture checks.
   Existing warnings are listed separately.
6. Record execution, review, commit and exclusion scopes per item; close this Todo only when everything passed or an
   explicit deferral/cancellation decision exists.

## 5. Delivery Note

The 2026-09-09 update only unified task ownership and corrected document statuses: no deleted historical tests, failure
records or cases; no desktop re-runs; nothing escalated; no merges or pushes. Document closure validation: root
typecheck, lint (39 existing warnings, 0 errors) and desktop `typecheck:e2e` passed; 100 local Markdown links valid;
`git diff --check` passed. These prove only the document changes, not the in-table untested items.
