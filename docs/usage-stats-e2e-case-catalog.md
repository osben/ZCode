# Usage Stats E2E Case Catalog

## Goal

This catalog defines the Desktop E2E contract for behavior added or changed on the
`fix/usage-remaining-refresh` branch. Scope: App Usage, personal/team Coding Plan, access refresh,
Context/Footer/Provider Settings cross-entry sync, and error recovery that the real renderer, host
and CLI chain can observe stably.

Only scenarios with an independent setup, action and assertion count as coverage. Pure mapping, date
math and chart data cleaning stay primarily with focused tests; the E2E coverage report only finds
execution gaps and does not replace behavior assertions.

## State dimensions and suggested pruning

| Dimension             | Values                                                      | Suggested decision                                                                          | Reason                                                                    |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Data domain           | App Usage / Coding Plan quota / activity / credit / health  | all included                                                                                | the branch changes UI, service and CLI aggregation together               |
| Plan source           | Z.AI personal / BigModel personal / BigModel Team           | BigModel personal and Team fully covered; Z.AI a representative sample for source isolation | avoids a brand Cartesian product over the shared mapper                   |
| Entry                 | Usage / Context / Footer / Provider Settings                | all included                                                                                | the shared access freshness and snapshot are the branch's core contract   |
| Result                | success / empty / business error / network error / recovery | all high-value paths included                                                               | hits error classification, cache cleanup, force refresh                   |
| range                 | today / 7d / 30d / all                                      | at least one per semantic; not multiplied by every source                                   | range changes request and display but is orthogonal to brand              |
| client                | desktop-continuous / web-remote-replayable                  | Desktop complete; mobile keeps only the shared-host invariant                               | Usage does not enter task replayable state                                |
| viewport/theme/locale | desktop / narrow; light / dark; zh / en                     | one representative sample per axis, no full combination                                     | display compatibility needs evidence but is orthogonal to the data source |
| timing                | fast / in-flight / freshness / retry                        | all included                                                                                | concurrency and refresh policy are high-risk paths of the branch          |

The user confirmed D1-D4; the pruning above has been the accepted planning boundary since 2026-08-17.
The historical `proposed` status in the tables below is uniformly raised to `accepted`; only a case that
is implemented and passes independent assertions may be further marked `covered`.

## App Usage

| Case                     | Setup                                                                                       | Action                                   | Assertions                                                                                                                  | Status       |
| ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------ |
| US-AU-01 empty           | no usage facts in the isolated HOME                                                         | open Settings > Usage > App Usage        | the all-time summary, Token Activity, trend and model distribution show a definite empty state, with no remote plan request | formal-green |
| US-AU-02 mixed history   | seed multiple sessions: new-format usage, old character fallback, cross-day and multi-model | open App Usage                           | all-time Token, sessions, active days, longest session and streak are correct; old data is neither lost nor duplicated      | formal-green |
| US-AU-03 range isolation | seed data older than 30 days                                                                | switch 7d / 30d                          | the all-time summary and 52-week activity are unchanged; trend and model distribution show only the current range           | formal-green |
| US-AU-04 activity modes  | seed sparse dates, cross-month, zero-value weeks                                            | switch daily/weekly/cumulative and hover | Sunday start, 52 weeks, month labels, column highlight, two-line tooltip and cumulative monotonicity are correct            | formal-green |
| US-AU-05 chart extremes  | seed 7+ models, unknown models and extreme tokens                                           | view the trend and model pie             | empty dates are zero-filled, first/last axes are not clipped, Top models and the "Other models" aggregation are correct     | formal-green |

## Coding Plan data and source

| Case                                | Setup                                                                             | Action                           | Assertions                                                                                                                                                                                                                                                                                                                                      | Status                 |
| ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| US-CP-01 personal credit            | BigModel personal plan, quota + credit activity/detail/performance succeed        | open personal Coding Plan        | remaining percentage, KPI, stacked model bars, tool usage and health all come from the matching interfaces; Peak tokens body text does not append a date and the hover info icon shows the peak date; Token Activity hover shows real remote Token and `mcpCalls` tool counts and does not show a missing round count as `0 rounds of messages` | covered                |
| US-CP-02 team scope                 | Team pricing has organization/project, all usage interfaces succeed               | open the Team tab                | requests carry organization/project, and the UI does not mix in the personal source                                                                                                                                                                                                                                                             | covered                |
| US-CP-03 source switching           | seed personal and two team sources together                                       | switch tabs in turn              | each tab's quota/model/tool is independent; personal requests carry no team header                                                                                                                                                                                                                                                              | covered                |
| US-CP-04 range switching            | three ranges return different markers                                             | switch today/7d/30d              | request dates match the UI range; the old range is only a local transition and does not enter the new scope's shared cache                                                                                                                                                                                                                      | covered                |
| US-CP-05 legacy fallback            | credit interface unavailable, legacy monitor succeeds                             | open Coding Plan                 | show the legacy trend, hide the new-only credit KPI, and do not fall back to App Usage                                                                                                                                                                                                                                                          | focused-test           |
| US-CP-06 optional failures          | quota succeeds, activity/detail/performance fail respectively                     | open the page per scenario       | only the corresponding optional area is cleared, the rest is kept                                                                                                                                                                                                                                                                               | covered-representative |
| US-CP-07 fatal failures             | quota network failure, HTTP 200 business failure, token invalid (three scenarios) | open the page and retry          | the whole page errors; a business error is not disguised as an empty state or a generic credential error; data shows after recovery                                                                                                                                                                                                             | covered-representative |
| US-CP-08 team availability recovery | Team quota fails first with a network/business error, then succeeds               | reopen / force refresh           | a failure does not write the 24h success cache; after recovery provider/tab sync is available                                                                                                                                                                                                                                                   | proposed               |
| US-CP-09 reset presentation         | 5h, week, MCP limit with/without reset time                                       | view Usage and the Provider Card | all quotas in Usage stats show month-day + time; the Provider Card keeps its existing compact format; missing values are hidden; the three-color order is correct                                                                                                                                                                               | covered-representative |

## Access refresh and cross-entry sync

| Case                             | Setup                                                     | Action                                                                             | Assertions                                                                                                | Status   |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| US-RF-01 freshness               | countable quota server, an existing success snapshot      | within 60 s visit Footer, Context, Usage, Provider Card in turn, then advance time | one request the first time; no repeat inside the window; request again after expiry                       | proposed |
| US-RF-02 in-flight success       | the first same-scope request stays pending                | mount two entries at once, then complete the request                               | the underlying layer requests once and both entries receive the same snapshot                             | proposed |
| US-RF-03 in-flight failure       | the first same-scope request stays pending and then fails | mount two entries at once                                                          | the underlying layer requests once, both entries receive the error and the pending cache is cleared       | proposed |
| US-RF-04 force triggers          | cached `none/unavailable`                                 | trigger manual refresh, token/fingerprint change and purchase success separately   | each bypasses freshness and probes again                                                                  | proposed |
| US-RF-05 retry backoff           | server fails repeatedly and then succeeds                 | visit at 30/60/120/300 s                                                           | the backoff sequence is correct and resets on success; access freshness does not mask the recovery window | proposed |
| US-SY-01 cold footer             | signed in with a provider configured, settings not opened | start the workspace                                                                | Footer probes actively and shows quota, not depending on another entry to warm up                         | proposed |
| US-SY-02 context feedback        | cached, access requests succeed/fail in turn              | hover Context                                                                      | loading → 1 s success check → details; on failure keep the cache and show a warning tooltip               | proposed |
| US-SY-03 context empty recovery  | no cache and the first request fails                      | hover, click retry                                                                 | a notice and a retry button show; on success replaced by the quota bar                                    | proposed |
| US-SY-04 mounted synchronization | Footer, Context and Usage mounted together                | force refresh from any entry                                                       | the other entries show the new same-scope snapshot without remounting                                     | proposed |

## Coding Plan / Start Plan exclusion

| Case                               | Setup                                                     | Action               | Assertions                                                                         |
| ---------------------------------- | --------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| US-SP-01 coding preferred          | Coding Plan has quota and a Start Plan also exists        | open Context/Footer  | query and show only Coding Plan, do not show Start Plan                            |
| US-SP-02 explicit no-plan fallback | Coding Plan is explicitly `no_plan`, Start Plan available | open Context         | querying and showing Start Plan is allowed                                         |
| US-SP-03 no transient fallback     | Coding Plan pending/network/token/unavailable             | open Context         | no transient state degrades to Start Plan                                          |
| US-SP-04 start access              | Start Plan only, countable balance server                 | first/repeated hover | first request; reuse within 60 s; a silent refresh with cache does not flash empty |

## Compatibility and architecture invariants

| Case                      | Setup                                           | Action                                  | Assertions                                                                                             | Status   |
| ------------------------- | ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| US-CM-01 narrow viewport  | narrow renderer viewport + dense data           | operate Usage tabs, charts and tooltips | no key control unreachable; activity scrolls; tooltip does not overflow                                | accepted |
| US-CM-02 theme/locale     | Zai Light/dark and zh/en representative samples | open the four entries in turn           | semantic colors readable, copy not critically truncated, errors do not leak raw provider content       | accepted |
| US-CM-03 remote invariant | shared-host remote workspace, Usage available   | open Usage and refresh                  | use the injected service; no independent runtime is created and no task replayable snapshot is written | accepted |

## Explicitly not enumerated by GUI E2E

- Every null/NaN/negative/out-of-order field combination of the mapper: covered by services focused tests.
- Every date, timezone and natural-week boundary: covered by CLI/query and UI focused tests.
- The full Cartesian product of all brands x range x theme x locale x viewport.
- Defensive branches not stably reachable from the UI and with no user-observable result.
