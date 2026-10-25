# Usage Stats E2E Coverage Matrix

This matrix tracks the behavior contracts in the [Usage Stats E2E Case Catalog](../usage-stats-e2e-case-catalog.md). `existing-partial` means only that an existing spec hits part of the assertions, not that the case is covered.

## Existing evidence

| Spec                                                       | Proven                                                                                                                                                    | Not proven                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `packages/desktop/test/e2e/coding-plan-team-usage.test.ts` | Team pricing cold start, connection method, personal/Team credit, range, error isolation and recovery, access freshness, entry visibility, viewport/theme | App Usage; mobile `/remote` UI (pruned by D1) |
| UI/services/CLI focused tests                              | mapper, dates, statistics aggregation, hooks state, in-flight/backoff, Coding/Start mutual exclusion, Z.AI source isolation and error branches            | Real Electron navigation is not re-proven     |

## Candidate spec groups

| Spec abbreviation  | Candidate path                                                   | Cases                                                 | Timing                           | Status       |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------- | ------------ |
| `UA`               | `test/e2e/usage-stats/usage-stats-app-usage.test.ts`             | US-AU-01..05                                          | fast-text                        | formal-green |
| `UP`               | existing `coding-plan-team-usage.test.ts` plus focused extension | US-CP-01..07,09; US-RF-01; US-SY-01..03; US-CM-01..02 | fast-text/fault HTTP             | formal-green |
| `UI-focused`       | existing UI hook/component tests                                 | US-RF-02..05, US-SY-04, US-SP-01..04, Z.AI isolation  | deterministic state tests        | green        |
| `remote-invariant` | existing desktop shared-host/attachment tests                    | US-CM-03                                              | deterministic architecture tests | green        |

## Behavior coverage status

| Area                             | Cases              | UI automation                                     | Runtime/service evidence                        | Formal        | Coverage status        |
| -------------------------------- | ------------------ | ------------------------------------------------- | ----------------------------------------------- | ------------- | ---------------------- |
| App Usage                        | US-AU-01..05       | 2 tests / 5 case IDs green                        | focused tests + SQLite fixture                  | formal        | covered                |
| Personal credit usage            | US-CP-01,03..05,09 | CTP-04B/05/07 green                               | services/UI focused tests                       | existing spec | covered                |
| Team usage                       | US-CP-02           | CTP-01..06 green                                  | mock request log + UI                           | existing spec | covered                |
| Failure isolation/recovery       | US-CP-06..08       | CTP-09 optional + CTP-11 fatal failure recovery   | services/UI focused tests                       | existing spec | representative-covered |
| Access refresh/in-flight/backoff | US-RF-01..05       | CTP-09/10/11 refresh, freshness, failure recovery | hooks focused tests cover in-flight/backoff     | mixed         | covered-by-pruning     |
| Cross-surface synchronization    | US-SY-01..04       | CTP-03 sidebar -> Usage, CTP-10 Context access    | hooks focused tests                             | existing spec | representative-covered |
| Coding/Start mutual exclusion    | US-SP-01..04       | no duplicate GUI matrix per D3-style pruning      | hooks focused tests                             | focused       | covered-by-pruning     |
| Compatibility/invariants         | US-CM-01..03       | CTP-08 narrow viewport + dark theme green         | shared-host/attachment 3 files / 20 tests green | mixed         | representative-covered |

## Verified run evidence

| Run ID                                  | Result                                                       | Scope                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `usage-app-coverage-green-20260817`     | 2/2 pass, complete renderer/main/host/CLI coverage artifacts | US-AU-01..05                                                                                          |
| `usage-team-failures-rerun-20260817`    | 9/9 pass                                                     | CTP-01..08, personal/Team credit, range, narrow screen                                                |
| `usage-combined-green-20260817`         | 13/13 pass, all four domains `complete=true`                 | CTP-01..10 + US-AU-01..05                                                                             |
| `usage-team-fatal-recovery-20260817`    | 12/12 pass                                                   | CTP-01..11, including quota fatal-failure recovery                                                    |
| `usage-final-coverage-20260817`         | 14/14 pass, renderer/main/host/CLI all `complete=true`       | Final App Usage + Coding Plan combined coverage                                                       |
| `remote-shared-host-invariant-20260817` | 3 files / 20 tests pass                                      | D1: mobile reuses the Window Host, trusted `web-remote-replayable` attachment and lifecycle isolation |
| `usage-app-formal-20260817`             | 1 formal spec / 2 tests pass                                 | US-AU-01..05 run without the manual-review switch, proving the default formal entry after promotion   |

Final targeted core-file line coverage: `AppUsagePanel` 97.22%, `CodingPlanUsagePanel` 80.89%, `UsageHeatmap` 96.70%, `UsageHeatmapCells` 100%, `UsageStatsErrorNotice` 80%, `useUsageEntitlement` 91.05%, `useUsageStats` 58.53%, `CodingPlanContextUsage` 90.74%. The roughly 20% repo-wide startup coverage of the whole UI Renderer is not reported as this branch's targeted coverage.

## Coverage collection contract

1. Collect the four runtime domains renderer/main/host/CLI with `ZCODE_E2E_COVERAGE=1`; coverage is not reported complete while any relevant domain is `incomplete`.
2. The target is the executable changes of `origin/staging...HEAD`; docs, tests, type declarations and `.gitignore` are excluded from the changed-code denominator.
3. First fill user-observable, high-risk changed lines/functions/branches; purely defensive branches that cannot be reached stably are recorded with a reason, and no brittle GUI operations are created for the number.
4. Report the four domains independently; renderer and host/CLI percentages are never added.
5. Keep per round the artifact run id, case pass/fail, four-domain completeness and the miss list of related changed files.

## User pruning confirmation

Provider settings addition: CTP-12 `packages/desktop/test/e2e/provider-family-responsive.test.ts` covers long-name wide/narrow layout, the Start tooltip, quick switching and settings persistence in the real app. Status: formal, promoted with user confirmation on 2026-09-04; the formal entry passed 1 with evidence `packages/desktop/.e2e-artifacts/desktop-e2e-20260904060754282-p39563-0c1b2374a55285ca/summary.json`. It counts as provider-settings formal coverage, does not extend usage-statistics business coverage and does not represent mobile remote verification.

| Decision                                                                                  | Proposed answer | Status              |
| ----------------------------------------------------------------------------------------- | --------------- | ------------------- |
| D1 Desktop is covered fully; mobile `/remote` verifies only the shared-host invariant     | yes             | answered 2026-08-17 |
| D2 BigModel personal/Team in full; Z.AI only a representative sample for source isolation | yes             | answered 2026-08-17 |
| D3 Extreme date/mapper combinations rely on focused tests and are not copied into GUI E2E | yes             | answered 2026-08-17 |
| D4 One representative sample each for viewport/theme/locale, no full combination          | yes             | answered 2026-08-17 |

The user confirmed D1-D4; the Coding Plan and App Usage cases are both in formal specs. App Usage was promoted on 2026-08-17 after the user confirmed manual review and keeps using the isolated SQLite fixture with no dependence on provider replay.
