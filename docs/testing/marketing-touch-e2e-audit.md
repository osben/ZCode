# Marketing Touch Branch E2E Completeness Audit

Date: 2026-09-12. Status: audit, not a feature-complete or 95% coverage acceptance. Full history: `git show b8876e8b:docs/testing/marketing-touch-e2e-audit.md`

## Feature Summary

| Field        | Content                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Intent       | Check all changes of the current branch against staging; list missing E2E, invalid assertions and the order of additions |
| Work branch  | `test/marketing-touch-e2e-coverage`, created from current local changes, not pushed                           |
| Audited commit | `d0028042fee3f2026a08f37365165a5255aa33ab`, including the local resource-cleanup commit                     |
| Remote baseline | `origin/staging` fetched in this round: `7a01923f5824760937e09a8df85a85372bcdeb63`                         |
| Diff start   | merge-base `87d6a7b2fc32d088452334c4309f33b0f8b039b1`; three-dot diff 116 files, +11406/-4250                  |
| Capability   | Marketing delivery, media and ZIP, rich text, navigate/copy/claim, reporting, adjacent entitlement refresh    |
| Layers       | presentation / validation / commit-effect / recovery / cache                                                  |
| Mode         | impact-only; only an audit record is added, no business code, test assertion or automatic promotion changes   |
| Main entry   | `MarketingTouchProvider` -> Controller/Poller -> Banner/Dialogs; Marketing/CloudContent services              |
| Out of scope | Server implementation, real claim or payment, authoring features of the external-resource workspace, task creation/automatic model switch |

Conclusion: additions and adjustments are needed. **118/122 (96.72%) in the historical docs is focused Vitest coverage of the old baseline**, not E2E coverage of the current branch, and must not be used for this acceptance. Existing cases have main paths that really pass, but also old APIs, invalid assertions, cross-case pollution and unexecuted error paths.

## UI Surface Matrix

| Scenario                | UI entry           | Shared implementation               | Display owner                  | Data source            | Gate                          | Commit action                      | Authority / persistence                    | Mode boundary                       | Must isolate                       |
| ----------------------- | ------------------ | ----------------------------------- | ------------------------------ | ---------------------- | ----------------------------- | ---------------------------------- | ------------------------------------------ | ----------------------------------- | ---------------------------------- |
| Banner                  | WorkspaceSidebar   | MarketingBanner/VisualBody          | Controller                     | GET banner             | Resource prepare, ready, pending | claim/open_url/navigate/copy/close | Server delivery and action; host resource cache | Desktop/Web shared; Web ZIP fallback | Settings page, task model selection |
| Standalone popup        | Shell auto display | MarketingDialogs/CloudContentDialog | Controller waitingPopup/dialog | GET popup              | Page visible, no other modal  | Buttons and three close entries    | Server delivery; current window state      | Owner not rebuilt with the workspace | Security-check layer, upgrade page, existing dialogs |
| Result popup            | Banner action succeeds | Same Dialog                     | Controller waitingResult       | success_popup of the same delivery | Result first, resource prepare | New action confirm; close does not repeat cancel | claim is the success authority | Refresh failure must not reverse success | Other standalone Popups |
| Claim failure           | Banner/Popup claim | MarketingFailureDialog/Alert        | Controller error               | data.message           | Non-success or uncertain result | Got it/Esc/overlay clearError     | No automatic retry, no extra report        | Shared component; narrow screen is not a real phone | Original Popup must be restored |
| Settings / plugin market | navigate          | Original settings / market pages    | Navigation correlation + original page owner | args and existing catalog | Confirm after the target actually takes over | Navigation only, no connection save / plugin install | Original settings / plugin services | workspaceIdentity; no separate runtime | task/model/connection facts |
| Upgrade purchase        | navigate upgrade   | Original upgrade Provider/webview   | Navigation correlation + purchase container | Current upgradeTarget | dom-ready; failure/cancel recovery | Open success confirm, not payment success | Original purchase flow            | Desktop supported; Web explicit failure | Automatic order/payment |

```text
HTTP GET(seq) -> schema -> resource authorization/download/verification -> Controller current candidate
                                           +-> Banner -> action snapshot / double-click guard
                                           +-> waitingPopup -> modal gate -> Dialog
action -> security check / host capability -> explicit result -> confirm or error prompt
close -> current instance settles -> cancel (except closing a result popup)
account/language/uninstall -> old generation invalidated -> late responses must not restore UI or report with new credentials
next round with the same ID -> server still decides whether to show; no local history blacklist
```

## Shared And Divergent Behavior

| Concern     | Shared                              | Intentional difference                                  | Audit requirement                                |
| ----------- | ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| UI          | VisualBody, safe text rendering, Button | Banner 96px, ignores button theme; Dialog supports theme | Hero success does not stand in for video Banner/style acceptance |
| Data source | Marketing GET DTO                   | success_popup is fixed to the action snapshot           | Claim balance refresh must not overwrite result data |
| Defaults    | locale/theme supplied by App        | Banner empty format is legal, Popup is not              | Mixed legal/illegal deliveries parsed independently |
| Validation  | Host authorization, digest, safe unzip | Web bundle does not access Desktop loopback          | Faulty resources and cross-platform fallback must be triggered for real |
| Side effects | Single-action pending, confirm/cancel | copy stays; navigate closes; result close does not report cancel | Assert each action by its real success criterion |
| Recovery    | generation / lease release          | Network failure keeps short-term content, empty response takes it down | Happy-path pass-through does not count as coverage |

## Feature Relationships

| Level          | Source -> target                                                     | Semantics / condition                   | Reason and evidence                                            |
| -------------- | -------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| must-inspect   | Root/Sidebar -> MarketingTouchProvider                               | One owner per window                    | Root, WorkspaceSidebar diff of this branch                     |
| must-inspect   | Provider -> Controller/Poller -> Service                             | identity, query, report                 | Current implementation has generations and event refresh; verify sequence, serialization, late responses |
| must-inspect   | Service -> AssetRegistry -> BundleCache -> iframe                    | authorization, download, lease, handshake | Success ZIP has E2E; errors are mostly unit tests            |
| must-inspect   | navigate -> SettingsPage/ModelProviderSection/PluginStorePage/Upgrade | Target confirmation, not dispatch, is success | The model-location E2E currently fails                   |
| should-inspect | claim -> entitlement/account refresh                                 | Best effort, but the refresh must really run | Provider still accesses the nonexistent modelProviderService |
| invariant-only | shared-host/remote/task runtime                                      | Reuse service entry, add no Agent       | remoteServiceAccess and services/node registration diff; no cross-client run evidence |
| evidence-only  | Unit / old coverage docs / resource fixtures                         | Explain paths, do not replace E2E       | Old 96.72% uses a different basis                              |

## State Owners And Commit Sinks

| State             | Display owner              | Authority                     | Commit point                       | Persistence / cache             | Evidence                                 |
| ----------------- | -------------------------- | ----------------------------- | ---------------------------------- | ------------------------------- | ---------------------------------------- |
| Delivery eligibility | Controller current candidate | Server                     | GET /marketing/touch               | No history dedup set            | marketingTouchController.ts              |
| seq               | No UI owner                | Service process module counter | Allocated before the actual GET   | Not persisted                   | marketingTouchService.ts                 |
| Current action    | Controller.pending/phase   | claim or host capability result | Provider.execute                 | Fixed candidate/scope           | MarketingTouchProvider.tsx               |
| Report            | Current operation scope    | Server action                 | Service.report                     | No automatic retry              | Controller + marketingTouchService.ts    |
| Resource          | iframe ready state         | Publish authorization and hash | readPublishedMedia/prepare/release | host-instance cache + lease    | cloudContentService/contentBundleCache   |
| Navigation        | marketingNavigation correlation | Completion signal of the original target page | finishMarketingNavigation | Original settings state, no new model config | marketingNavigation/Settings/PluginStore |

## Per-case Audit of Current Cases

Both marketing specs are in `packages/desktop/test/e2e/ui-shell/manual-review/pending/`. delivery has 16 `it`, entitlement has 1. Several case IDs in one title do not mean several independent tests.

| Scope                | Existing setup/action/assertion                                                               | Missing or to adjust                                                                                                                       | Priority |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Initial Popup        | MTC-01: default standalone Popup -> content close button -> cancel exactly once               | Top-right X, Esc, overlay each verified; currently only the X style is checked, the X click report is not verified                         | P0       |
| Banner claim         | MTC-03: real HTTP/PNG/ZIP, security-check success, pending claim -> loading -> success/confirm | Fast double click, security-check cancel/error, not logged in, submit timeout, explicit failure/uncertain; a disabled-style assertion cannot replace a double-click submit count | P0 |
| Post-claim refresh   | success Popup visible                                                                         | Must assert the real account/entitlement refresh is called and updates the projection; inject a refresh failure and confirm it does not reverse the claim | P0 |
| Same-ID redelivery   | After success and after close wait the normal 30s; close counts; standalone Popup redelivery  | An ongoing same-ID display does not stack; an old GET/slow resource completing must not revive closed content                              | P0       |
| Polling              | 30s normal wait, online speed-up                                                              | hidden recovery, slow-request concurrent coalescing, failure backoff, empty array takedown, ten-minute expiry, identity/language rebuild; test 30s cannot stand in for production 600s | P0/P1 |
| seq / request headers | Service unit tests cover first/concurrent/failure/anonymous                                  | The fixture records only pathname, losing query/headers; add a redacted method/seq/header-presence ledger verifying 0-start, growth on failure, POST not taking a seq | P0 |
| Report reliability   | success, content close, repeated copy confirm/cancel                                          | Anonymous, report 500/disconnect does not block UI and no retry, account switch does not borrow a new token, result X/Esc/overlay do not repeat cancel | P0 |
| Copy                 | MTA-01 raw text/newlines/HTML literals, repeated copy, no SVG, retained; MTA-06 permission failure | The failure test is polluted by earlier ones; copy pending double click, 10s uncertain result, late old-account result, no wrong filling of inputs/task creation | P1 |
| Settings navigation  | MTA-02 appearance; MTA-03 all 14 sections                                                     | Default/last section, reuse of an existing target, no new settings tab; the no-side-effect check must read the current real connection structure | P0/P1 |
| Provider location    | MTA-05 specified provider and missing provider                                                | Uses the old builtin:bigmodel, mismatching the current navigation contract; the connection snapshot reads deleted fields so undefined-vs-undefined may false-pass; add current family/account/custom, loading, and nonexistent paths | P0 |
| Plugin market        | Home, first catalog item detail, nonexistent errors without reporting                         | Catalog needs case-local fixed content; verify the campaign confirm on each of two successes; no config/install/task change; same path with a different workspaceIdentity must not falsely confirm | P1 |
| Upgrade page         | MTA-07 webview visible, confirm once, close adds nothing                                      | No confirm before ready; load failure / early close / timeout restores the original Popup; Web unsupported; keep the ordinary upgrade entry regression | P0/P1 |
| ZIP Banner           | MTC-BUNDLE ready, data/theme, 96px/94px, pointer-events, copy/close, download count unchanged | Depends on earlier ZIP download and entering settings; each should prepare itself. Add cold cache / same-SHA warm cache / different SHA / lease release; an unchanged download count alone does not prove no repeated unpack | P0 |
| ZIP/Hero security    | Normal ZIP / flip / replay                                                                    | Bad hash, unauthorized/redirect, missing entry, malicious path / size over limit, ready/error/timeout/forged message; network/fallback/lease must run through the real host chain | P0/P1 |
| Failure dialog       | MTC-FAIL service translation and blank fallback, no visible title/X, Info, theme/358px, Got it does not report | Restore the original Popup after a Popup claim failure; Esc/overlay do not retry; missing code, numeric/string code, plain-text malicious HTML; long-text scroll / focus return | P0/P1 |
| Rich text            | MTC-RICH HTML title / Markdown description / button; MTC-HTML class/style and outline priority | Markdown links/tables/code, safe HTML/URL/style, inline title/button without nested interactives; an unknown retained class does not mean arbitrary Tailwind works | P1 |
| Media                | MP4 Banner ready/play/loop/muted/96px                                                         | Hero video controls, hidden/reduced-motion pause, decode-failure fallback, dark image; Lottie is a public-component branch but the Marketing DTO does not deliver it, so list it as an unreachable boundary | P1 |
| Visual / accessibility | CSS radius / hit-test, saveScreenshot; light/dark partial class changes and 358px container | Native window compositing-layer radius screenshot plus manual review; real viewport, Tab/Enter/Escape/focus, real locale switch; a local width is not a phone/Web acceptance | P1 |
| Entitlement and connection | entitlement is one long case: direct HTTP seed claim, then verify balance/Start/Individual/Subagent | 5 old-API type errors; independent seed/reset; not evidence of the post-Banner refresh; use the current structured selection; split into fault-localizable scenarios | P0 |
| Retired logic        | Old preview entry absent, no /billing/preview request                                         | The original formal spec was deleted and the new pending is excluded by default; do not silently lose the formal regression in CI. After manual confirmation promote via the promotion flow | P0 |
| Registration and exit | services/node, RemoteServiceAccess, cache dispose changes                                    | App exit / Host dispose cleans resources; remote/Web support and fallback; no history interception across windows; one window's run cannot prove cross-client | P1 |
| Build / fixture      | bundle/tsup/wdio/mock generator, lockfile also changed                                        | List as build/contract tests, not counted in business E2E code rate; generated ZIP/HTML fixtures are not external formal resource-package acceptance | P1 |

## Must-Preserve Invariants

| Invariant                                          | Scope           | Proof required                    | Current situation                        |
| -------------------------------------------------- | --------------- | --------------------------------- | ---------------------------------------- |
| Server decides display; same ID may be redelivered | Banner/Popup    | Same-ID redelivery, action, report | Main path measured as passing           |
| Confirm only on explicit success; writes not auto-retried | All actions | ledger + fault/timeout + UI     | Normal path exists; abnormal cross-process gap |
| Navigation does not switch connection/model, install plugins or create tasks | Settings/Market | Current real persisted fields and command ledger | Risk that old-field assertions are invalid; cannot claim proof |
| Resources verified first; late results do not restore old UI | Media/ZIP | Controllable slow/bad resources + Host/DOM | Mostly unit tests; E2E incomplete |
| Desktop continuous and mobile replayable do not spread | remote/task   | Representative shared-host / identity routing regression | Multi-client not run; no fake pass |
| Case isolation; a failure does not pollute the next case | All E2E   | Single and combined runs agree    | Consecutive pollution observed this round |

## Codegraph Evidence

No codegraph tool was available; no indexed impact scan was run. `git diff`, exact symbol/caller search and source reading were used; this is not a full call-graph proof.

| Seed                       | Substitute query | Confirmed path                                       | Depth | Limit                                    |
| -------------------------- | ---------------- | ---------------------------------------------------- | ----- | ---------------------------------------- |
| MarketingTouchProvider     | diff + rg + source | Root/Sidebar -> Provider -> Controller/service     | 2     | Not all runtime environments enumerated  |
| prepareMarketingHero       | rg + source      | Provider -> resources -> CloudContentService -> cache | 3    | Not all security branches traversed by E2E faults |
| requestMarketingNavigation | diff + source    | Provider -> settings/market/upgrade -> finish        | 2     | Current provider migration blocks some targets |
| disposeServiceResources    | diff             | Host service release -> CloudContent.dispose         | 2     | Exit behavior needs verification         |

## Graph Drift Candidates

| Item                            | Current evidence                          | Stale relationship                      | Follow-up                                          |
| ------------------------------- | ----------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| start-plan-manual-claim surface | Old Banner/ResultDialog deleted           | Graph still references old files and guide paths | Replace with the Marketing surface; do not restore automatic model selection |
| cloud-content-preview           | App preview entry removed                 | Graph still references preview component / old mock files | Delete the retired-entry relationship |
| Test evidence nodes             | New specs are in pending                  | Old formal E2E / old Banner unit-test references | Update to current evidence and note pending |
| Marketing capability relations  | Current Settings/Market/Upgrade confirm chain | Does not fully describe new targets and failure recovery | Add relations; do not equate UI selection with a persisted connection |

Graph Delta (proposed only; the feature graph is not changed here): add/correct Marketing Banner, standalone Popup, result/failure Dialog, resource lease, navigation target confirmation and report edges; remove retired preview / automatic guide edges. Basis: current diff/source and the navigate/copy_text boundary the user fixed.

## 95% Measurement and Implementation Order

1. Freeze the denominator as the added/modified **executable business source lines** from merge-base to the audited HEAD, including UI, shared schema, services, client registration. Deleted files get a separate regression and do not count in the new-line denominator. Tests, docs, translation data, pure types/declarations, build scripts and external resource packages are reported separately.
2. Collect only real App E2E Renderer/Host/Main/CLI data; do not mix Vitest. List functions/branches per domain; do not merge statement IDs of different instrumentation directly.
3. Missing instrumentation / source map / process data is marked unknown, neither covered nor silently removed from the denominator. Unreachable Marketing-entry code such as public Lottie is listed explicitly; do not pass tests that inject internal business functions just to reach 95%.
4. First fix old APIs and case-local fixture/reset, then add P0 and run for real; register behavior coverage and execution coverage together only when each case's setup/action/assertion holds. A covered line passed through by a failing test is not a passed acceptance.
5. Add P1 backward from uncovered lines/functions/branches. Suggested thresholds: diff lines >= 95%, diff functions >= 95%, diff branches >= 95%; confirm the denominator and unreachable boundaries first; list unmet items separately and never report only the best metric.
6. Run repeatedly, independent and combined; review screenshots, then promote per the skill, then connect to formal CI. Do not delete security branches, restore old product semantics or loosen business assertions to pass.

Implementation must update the case catalog / coverage matrix first, then write failing tests, then change the implementation; this round implemented nothing. Known type errors belong to the current candidate branch and are not skipped as "existing errors unrelated to this feature".

## Unresolved Questions

| Question                         | Options                                              | Scope difference                                         | Decider   |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | --------- |
| Implement directly after audit?  | Review the list first / approve P0/P1 completion and necessary product fixes | The latter changes tests and product, while this round only audits | User |
| Final 95% threshold              | Lines/functions/branches all met, or name a specific metric | Fix before implementation; do not shrink the denominator afterwards | User/team |
| Cross-client real machines       | CI Windows/Linux + Web/phone chain, or list explicitly as pending acceptance | A macOS narrow layout cannot stand in | Team |

## Planning Handoff

impact-only; no product spec/test change or automatic promotion in this round. Follow-up plan: first protocol/isolation/API blockers, then P0 behaviors and reports, then P1 and platform verification, finally manual acceptance/promotion.

## Run Evidence of This Round

### Static gates and locatable problems

| Check                                        | Result this round                                     |
| -------------------------------------------- | ----------------------------------------------------- |
| workspace freshness                          | Passed; the new test branch has no upstream           |
| `pnpm typecheck`                             | Failed, 9 errors (table below)                        |
| `pnpm --filter @zcode/desktop typecheck:e2e` | Failed, 5 old-API errors in the entitlement E2E       |
| `pnpm lint`                                  | 0 errors / 45 warnings; code not changed to remove existing warnings |
| `pnpm architecture:check --changed`          | 0 violations                                          |

| Location                                                   | Cause and extra verification                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| MarketingTouchProvider.tsx:275, 278                        | IServiceAccessor has no modelProviderService; the post-refresh call on the success path still uses the old API. The current claim case asserts only the success popup, not that the refresh executes |
| Root.tsx:3, 357                                            | The RefreshCw import was removed but the load-failure retry UI still references it. Normal startup does not hit this error branch; add a fault-injection regression |
| ModelProviderSection.tsx:1121                              | The new navigation match reads item.provider.id; current ProviderSettingsFormProvider uses providerId. Do not just change the test selector and mask the custom-provider path defect |
| marketing-touch-entitlement.test.ts:94, 100, 131, 163, 164 | bigmodelCodingPlan/bigmodel enums and modelProviderFamilyModes/SelectedKeys no longer exist                                                     |
| marketing-touch-delivery.test.ts:35-42, 393                | The connection no-side-effect check reads two deleted fields. It should use providerFamilyConnectionSelections and first assert a valid initial selection exists; plain JSON reads bypass TS checks |

These are not fixed in this round; they must be handled when adding tests, not waved through as unrelated errors.

### Actual E2E

All runs used isolated fixtures: no online plan claimed, no payment executed. The first build set `ZCODE_E2E_COVERAGE=1`; later runs reuse the same coverage build.

| Run (2026-09-11)                              | Scope                                        | Result          | Interpretation                                                                                             |
| --------------------------------------------- | -------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| run 1 (`desktop-e2e-20260911-170338-218`)     | delivery + entitlement, all 17 cases         | 9 passed / 8 failed | MTA-05 failed first; the last 6 delivery cases polluted by an old dialog; entitlement reports "model provider settings have no BigModel navigation item: missing" |
| run 2 (`desktop-e2e-20260911-171040-787`)     | Keep needed prerequisites, skip model location, 9 cases | 4 passed / 5 failed | MTA-06 passes alone, proving the first-round failure was pollution; MTA-07 still times out waiting for the event count (35s); the last 4 hit residual overlay |
| run 3 (`desktop-e2e-20260911-171255-869`)     | Keep prerequisites, skip model location and upgrade page, 7 cases | 7/7 passed | ZIP Banner, failure Dialog, Markdown/HTML, MP4 Banner can pass; not the whole suite                         |

After de-duplication across the three runs: 14 of 17 existing tests passed at least once; 3 still fail (model location, upgrade confirmation, entitlement connection). **14/17 is a case execution result, not code coverage.** Isolated passes do not replace whole-suite stability acceptance; no test or product code changed in these runs. Artifacts live under `packages/desktop/.e2e-artifacts/<run>/` (`summary.md`, `test-results.ndjson`, `coverage/`, runtime logs) and are not committed.

Exact scope of the upgrade-page failure: the container display assertion passed but the expected action event count was not reached within 35s. It is not yet proven whether the root cause is webview ready, fixture timing or the product confirm logic; it must not be attributed directly to payment/network servers. Build controllable fixtures for ready/failure/timeout and keep request-correlation logs.

Rerun command:

```sh
ZCODE_E2E_COVERAGE=1 ZCODE_E2E_MANUAL_REVIEW=1 \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec './test/e2e/ui-shell/manual-review/pending/marketing-touch-delivery.test.ts' \
  --spec './test/e2e/ui-shell/manual-review/pending/marketing-touch-entitlement.test.ts'
```

### Coverage completeness

First-round Renderer report complete; Main/Host/CLI reports all complete, missing process = 0. This proves only that the expected processes were collected, not that all source mappings are precise enough.

| First-round diff scope | Lines              | Functions        | Branches         | Usage limit                                                            |
| ---------------------- | ------------------ | ---------------- | ---------------- | ---------------------------------------------------------------------- |
| Mapped Renderer        | 583/896 = 65.07%   | 148/223 = 66.37% | 479/883 = 54.25% | Includes code passed by failing cases; not equal to accepted behavior  |
| Host raw mapping       | 969/1068 = 90.73%  | 37/39 = 94.87%   | 94/175 = 53.71%  | V8 per-line mapping includes blanks/types; cannot be a unified executable-line denominator |
| Main raw mapping       | 1041/1068 = 97.47% | 0/0              | 0/0              | Some service files have whole-file hits without functions/branches; must not fill Host gaps |

For example contentBundleCache.ts has all 318 source lines hit in the Main report but 0 function/branch records; Host has 16 functions and 79 branch records. OR-ing lines across domains gives an inflated full-chain percentage, so that merge is not used. Source mapping and runtime-domain ownership must be verified before a unified executable-line baseline.

The new manualClaimFailureMessage.ts has no production caller and is not in the Renderer instrumented output; with the same TypeScript/JSX Istanbul parser it has 16 executable lines, 1 function, 16 branches, all without E2E execution evidence. It must not be silently dropped from the denominator because it is not bundled. accessor.ts, services/index.ts, cloudContentDialogTypes.ts missing mappings were verified by the parser as 0 executable statements (types / re-exports) and are not conflated with that leftover business function.

The 36 mapped Lottie runtime lines had 0 hits in the first round and the Marketing protocol has no Lottie delivery entry; first decide a public-component regression entry or confirm retirement, rather than calling internal functions from tests. CSS and HTML/JS inside ZIPs are not in the current TS/JS instrumentation metrics and are listed under rendering and independent resource acceptance.

A trustworthy "all-branch E2E >= 95%" conclusion cannot be given now. Prerequisites are not only more tests but also fixing test isolation, old APIs, the unreachable legacy code scope and the cross-domain coverage basis.

### Three-run same-build Renderer merge

The last two runs set `ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1` (same source and instrumentation as the first). Only the Renderer `coverage/coverage-final.json` of the three runs was merged with Istanbul; no Host/Main and no unit-test results.

Method: `git diff --unified=0 <merge-base> d0028042fe -- <file>` gives new-side changed lines, intersected with `getLineCoverage()`; functions are selected by declaration start line, branches by whether branchMap.line (or loc.start.line) is in the diff, keeping each branch exit count. So function/branch numbers use the diff-node basis. A field deleted or JSX/import without its own statement still needs behavior regression even at 0/0.

| Metric      | Executed / mapped diff denominator | Coverage   | Hits still needed to reach 95% on the currently mapped denominator |
| ----------- | ---------------------------------- | ---------- | ------------------------------------------------------------------ |
| Lines       | 653/896                            | **72.88%** | 199 lines                                                          |
| Functions   | 164/223                            | **73.54%** | 48 functions                                                       |
| Branch exits | 546/883                           | **61.83%** | 293 exits                                                          |

These are execution-coverage upper bounds, including code passed through by failing flows; they do not mean the corresponding assertions passed, and they do not cover the unbundled 16-line legacy failure-text function. Adding that file's zero hits gives 653/912, 164/224, 546/899, only lower. The gap numbers are not a count of new cases and promise no fixed number of tests. The per-file breakdown showed the weakest files were `CloudDialogMediaHero.tsx` (12/70 lines), `cloudLottieRuntime.ts` (0/36), `marketingResources.ts` (52/78) and `CloudDialogHero.tsx`/`CloudContentDialog.tsx` branches; the strongest were the Banner, Sidebar and navigation files.

Temporary data and the diff-coverage script lived under `/tmp` and are not committed; the cross-domain per-line sum in that temp JSON fails the basis review above and **must not be used as an acceptance percentage**. Only the `domains.renderer` single-domain result is used here.
