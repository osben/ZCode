# Marketing Touch E2E Completion Implementation Spec

Full history: `git show b8876e8b:docs/testing/marketing-touch-e2e-implementation.md`

Formal replay maintenance (2026-10-15): the isolated fixture starts from an account that already
finished career onboarding; the global touch waits only for the app shell and does not require a
fixed project to be active. MTA-05 clicks the main action by its stable test id; Start Plan
navigation changes the button copy to the localized View plan, so the fixture's Run action is no
longer hardcoded; the target must select the standalone Start Plan node. The marketing upgrade
fixture keeps a queryable personal project and a short-lived token before the claim while the
subscription list stays empty; otherwise the global plan-entry check treats unknown credentials as
not ready and none of the four upgrade paths can start. The prerequisite state of other claim
fixtures keeps the original contract.

Status: on 2026-09-12 the user authorized continued implementation; unfinished items must not be
replaced by audit completion.

### Task-completion triggered refresh (2026-09-18)

MTC-TASK-COMPLETE corresponds to the [client
contract](../marketing-touch-client.md#任务完成后刷新2026-09-18). Candidate spec:
`packages/desktop/test/e2e/ui-shell/manual-review/pending/marketing-touch-task-completion.test.ts`.
The case starts a task through the real composer; a case-local synthetic delayed-text fixture
returns success; while running, the existing online entry resets the poll timer; then it asserts a
new marketing HTTP request within 15 seconds, excluding a false positive from the 30-second poll.
Not promoted; it does not prove real server delivery or real phones.

Unit coverage: no trigger for historical/repeated completion, no trigger for failed/interrupted,
completion of a re-run, merging completions in the same batch, reconnect baseline, RPC readiness,
remote workspaceIdentity/endpoint passing, and release of references on unmount. Desktop/Web
Providers both verify that the completion-refresh entry reuses the poller's in-flight coalescing;
hidden behavior follows the poller regression.

Verification: 39 unit tests passed; macOS App E2E 1/1 passed (runner exit 0). The first run was
blocked by the isolated account's first-use guide; the candidate case now closes it with the public
Esc. typecheck, desktop typecheck:e2e, architecture and format checks passed; lint 55 warnings / 0
errors. Desktop/Web Provider merging and remote identity are unit-test evidence; mobile
remote-control end to end and Windows/Linux are unverified.

### Banner hover message regression (2026-09-15)

Extends the existing MTC-BUNDLE: a real mouse enters/leaves the App Banner and the isolated iframe
observes the host postMessage hover true/false; the assertions for pointer-events:none, original
cache and confirm/cancel once each stay. macOS Electron 1/1 passed (6.7 s). 14 UI unit tests passed,
covering ready, pending, touch, blur, hidden and dynamic reduced-motion. The external resource
workspace's 11 unit tests and three-package browser regression passed (including the actual CSS
transform of the bouncing card). The App E2E uses an isolated ZIP fixture to verify the protocol,
not an online delivery ZIP; Windows/Linux/real phones and real server replacement are unverified. No
new business action and no wider remote-control boundary.

### Promotion decision (2026-09-12)

The full pre-push unit run found that the original delivery screenshot paths did not satisfy the E2E
runtime path gate. All four screenshots are now written to the runner-provided
`ZCODE_E2E_ARTIFACT_DIR`, failing explicitly when it is missing, never to the system temp dir, with
business assertions unchanged; the original path gate stays as a regression test.

The user lowered the threshold to 90% (excluding Lottie) and explicitly asked for promotion.
Evidence of the same round: 60 passed and Renderer 90.07%; that number does not represent coverage
of all runtime domains. The three marketing-touch specs moved to the formal directory
`packages/desktop/test/e2e/ui-shell/`, keeping the isolated HTTP fixture and all assertions. The
formal path does not depend on the MANUAL_REVIEW switch; verified on local Electron, no Docker, no
push. Remaining uncovered platforms and boundaries of the historical matrix stay open and are not
marked covered by promotion.

The standard promote tool dry run rejects the ui-shell path (conversation-session only), so the
specs were moved within their original domain with helper relative paths fixed, not forced into
conversation-session and without an unrelated DeepSeek replay fixture.

Promotion verification: on the formal path with MANUAL_REVIEW unset, local Electron ran **60/60
passed, runner exit 0**: anonymous 2, delivery 57, entitlement 1. Related unit tests 31/31;
typecheck, desktop typecheck:e2e, lint (45 existing warnings / 0 errors), architecture (0
violations) passed. The three specs were only renamed with helper references adjusted, all
assertions kept; the default `test/e2e/**/*.test.ts` includes the formal path. Product code
unchanged; 90.07% is evidence from the earlier coverage round and coverage was not re-collected. No
Docker, no push. Note: the original Goal backend still carries the old 95% target and the unfinished
target may not be replaced; that panel state must not be treated as synced with this user change.

### Latest scope decision: exclude Lottie (2026-09-12)

The user explicitly asked «忽略 lottie» (ignore Lottie). This 95% acceptance does not cover
Lottie-specific implementation, deletes no product code and adds no marketing Lottie protocol; the
earlier scope blocker awaiting Lottie extension authorization is lifted. The full historical
denominator and the 93.71% upper bound below remain only as old-basis records and are no longer the
current acceptance upper bound.

The excluded range is the two functions `CloudLottie` / `LottieResource` of
`CloudDialogMediaHero.tsx` plus `cloudLottieRuntime.ts`, currently 84 executable diff lines. The
shared image/video, common environment and Hero dispatch logic of the same file stay in; shared code
cannot be excluded by file. Exclusions must be listed separately and the original coverage report is
not rewritten; later audit tooling must apply the same scope mechanically, and a manual
recomputation is not a complete coverage gate.

Recomputed from the same-round run: the unified source inventory leaves **1252 lines (1336 - 84)**;
mapped Renderer diff lines leave **816 (900 - 84)** with hits still **735, i.e. 90.07%**. This
Renderer basis still needs at least 41 more hits to reach 95%; it is not a cross-domain overall
coverage. Normalized overall trustworthy hits, remaining accepted cases and the full gates are still
to be done; still no promotion beyond the above and no push.

### Unified denominator and diagnostic tooling

- Unified source inventory: fixed TypeScript ESNext/JSX-preserve transpilation (no tree-shaking),
  Istanbul instrumentation, then compiled source map back to the original file's statement start
  lines. All runtime domains share this inventory and count only lines in the Git diff; imports,
  pure types and blanks are not counted, enums are transpiled to runtime code and kept. Parse
  failures or generated statements without original mapping must be listed as unknown, never
  silently shrinking the denominator. This stage only builds canonicalExecutableLines; it does not
  project Node raw counters into trustworthy hits and does not change the historical Renderer
  900-line basis. Final overall coverage still awaits hit trustworthiness and full scope
  verification.
- Measured inventory (fixed merge-base to `a27a0446ae`, product code same as current): **41 files,
  1336 executable diff lines**, 0 parse failures and 0 unmappedStatements. Lottie Hero 48 + runtime
  36 = 84 lines; the only production use of CloudContentDialog is MarketingDialogs and the marketing
  visual body has no Lottie entry. Under the full inventory, even with all other lines covered the
  upper bound is `(1336 - 84) / 1336 = 93.71%` (old basis; the user later excluded Lottie, see
  above). Without authorization, the protocol is not widened and the denominator is not trimmed; the
  user was asked again whether to authorize adding the Lottie protocol and a real entry.
- Read-only audit command `node scripts/marketing-touch-coverage-audit.mjs <base> <head> <run-dir>`:
  fixes the Git diff, reads Istanbul maps of Renderer/Host/Main/CLI separately, supports `.json.gz`,
  records the audited source SHA. Missing files/domains are unknown; Node physical line mapping and
  missing function records are flagged as anomalies; UI/Services in unexpected domains are flagged.
  It outputs per-domain metrics only, **never a cross-domain total or a pass verdict**; the source
  SHA is for traceability and does not yet prove the report build matches the source. Raw V8
  conversion counters can count ungenerated source lines as 1 (example: `contentBundleCache.ts` in
  the Main report), so the tool cross-checks against the build source map of each domain: before
  reading the current out map it must match the SHA of this round's build-source-evidence; missing,
  changed or non-fresh-stable evidence is marked unverified, never confirming an old report with
  current artifacts. The report keeps the original counts and lists
  positiveLinesWithoutGeneratedMapping separately; these are suspicious counts, not a new
  denominator, and produce no overall percentage (overall coverage stays null). trace-mapping is
  pinned to the existing lockfile version 0.3.31; only a root dependency declaration was added.
- `istanbul-lib-instrument`'s TypeScript/JSX parser on raw source excludes import/interface/type but
  does not generate statements for runtime `enum`, so its result cannot be the unified
  executable-line denominator for all domains. That option is not wired into the statistics.
- Build source evidence: with `ZCODE_E2E_SOURCE_EVIDENCE=1`, WDIO computes the source SHA of
  packages/\*/src before and after a fresh desktop build and records JS/CSS/HTML/map hashes of the
  actual staged App into `build-source-evidence.json`. Same sources twice with artifacts present
  means fresh-stable; changed, SKIP_BUILD or packaged App do not confirm the current source. It
  covers only desktop Renderer/Host/Main, not a CLI built or reused later. All IO is async and
  writes no source or credentials.

```text
source fingerprint A -> fresh build -> stage App -> source fingerprint B + staged artifact fingerprint
A=B and artifacts present -> fresh-stable -> audit compares each file with HEAD SHA
reused/packaged/changed -> unverified -> must not confirm an old report
```

- Coverage reports: Node collector finalize can fail with ENOSPC in the runner's onComplete (runner
  exit 1), which cannot be recorded as full-chain green. Recovery calls the original collector's
  finalize on the same round's raw data; do not rerun or rewrite case results and do not merge
  counters across runs. Passing cases, recovered collection and reaching code coverage are three
  different conclusions.
- Webview replay must be built with this round's mock addresses: the origins of the invite and
  upgrade pages are Vite build-time config. Reusing `out` across runs keeps requesting old mock
  addresses, and such timeouts are not product failures; these scenarios do not use
  `ZCODE_E2E_SKIP_BUILD=1`.

Merged execution of the three pending specs with `ZCODE_E2E_SOURCE_EVIDENCE=1` verifies same-round
results and source fingerprints; historical batch-by-batch passes are not equivalent to a same-round
full pass.

## 60-case Same-round Recheck (2026-09-12)

Local macOS Electron, anonymous 2, delivery 57, entitlement 1: **60/60 passed in the same round**,
with coverage and source evidence enabled and a fresh-stable build fingerprint. A start that forgot
the coverage switch was aborted and does not count. The runner failed (exit 1) generating the CLI
HTML report in onComplete (ENOSPC) and was recovered by the original collector finalize on the third
attempt (exit 0); Main/Host/CLI complete all true, missingRawProcessCount and baselineFailureCount
both 0. The original runner failure is kept as fact; counters were not merged across runs.

Post-recovery audit: Renderer diff lines **735/900 = 81.67%**, functions 184/222, branches 634/885.
Renderer/Host/Main source identity matches, CLI identity still unverified; Node physical line
mapping is not unified executable-coverage evidence and overallCoverage stays null. 95% not reached;
accepted scenarios and the cross-domain basis remain, so beyond the promotion above nothing further
is declared and nothing is pushed.

## Feature Summary / Impact Brief

Reuses the UI Surface Matrix, shared/divergent behavior, relationship levels, state owners, commit
sinks, invariants and codegraph limits of the [audit](marketing-touch-e2e-audit.md). Mode moved from
impact-only to planning / implementation-handoff; scope is the marketing business of this branch
relative to staging, necessary provider migration fixes, tests and coverage tooling, without
extending remote actions. The code-graph tool is unavailable; the paths confirmed by the audit were
rechecked against current source.

## Clarification Log / Boundary Decisions

| Decision                         | Status               | Scope                                                                                                                                                                                 |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix existing failures, add P0/P1 | accepted             | The user asked the Goal to continue to completion, including necessary product defects, not only assertion edits                                                                      |
| Coverage                         | accepted             | The user lowered it to 90%, excluding Lottie; current Renderer 90.07%, not posing as a cross-domain overall result; functions/branches listed separately, no unit-test padding        |
| Action capability                | accepted             | Keep close/open_url/claim/navigate/copy_text; no task creation, no model switch, no automatic install/payment                                                                         |
| Old API migration                | bug-candidate -> fix | Use providerSettingsService.refresh and the current providerId/connection structure; do not restore the retired service                                                               |
| Test lifecycle                   | accepted             | Case-local scenarios and cleanup; promote after the goal is reached and everything passes (user authorized); verify on local Electron only, no Docker, no push                        |
| Third party / platform           | pruned combinations  | Official-version security checks use deterministic callback stand-ins; real purchases / production eligibility are not executed. A macOS run cannot replace Windows/Linux/real phones |

## Domain Scope / Concept Map / State Owners

The marketing Controller is the sole owner of display, pending and the action snapshot; the
Marketing Service owns the process sequence and credential validation; the server owns delivery and
claim facts; the original providerSettingsService owns provider refresh; BundleCache owns resources
and leases; the original settings/market/purchase components own the fact that the target took over.
The test fixture owns only isolated service responses and the request ledger and never changes
Controller state directly.

## Dimensions / High-Risk Cross-Products

| Dimension  | Equivalence classes                         | Risky combination                                         |
| ---------- | ------------------------------------------- | --------------------------------------------------------- |
| Slot       | Banner / Popup / success_popup              | close X reporting; result X x new standalone popup        |
| Action     | close / copy / navigate / claim / open_url  | in flight x double click / account change / late response |
| Network    | normal / empty / failure / timeout / slow   | poll x action settling; report x credential change        |
| Media      | image / video / bundle                      | ready/error/timeout x fallback/no fallback                |
| Navigation | settings/marketplace/upgrade                | target loading/missing/active x no side effects           |
| UI         | light/dark, zh/en, narrow/desktop, keyboard | font style / clipping / focus x text length               |

```text
case reset -> isolated HTTP scenario -> real App GET / resource / RPC
                                  -> user action -> UI and ledger / persisted-settings assertions
case finally -> take down the scenario / release held responses -> close residual modals -> back to workspace

claim success -> parallel entitlement snapshot + providerSettingsService.refresh
                  -> any refresh failure is only recorded, never reverses success, never switches the user connection
```

## Accepted Cases

All are accepted scenarios of the existing contract; implementation status lives in the verification
records and these rows do not claim coverage.

| ID     | Setup                                                                   | Action                                         | Assertions                                                                                               | Evidence                         |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| MTE-01 | Any earlier failure / residual modal                                    | reset the scenario and run independently       | Same as combined run; no old delivery / ledger pollution                                                 | App/HTTP                         |
| MTE-02 | Current provider family/account/custom with a valid connection snapshot | navigate to a given provider                   | Target selected; connection/model/task unchanged; missing target fails explicitly                        | App/persisted config             |
| MTE-03 | claim succeeds; refresh normal / rejected                               | click claim                                    | Current provider refresh really called, failure still succeeds; connection unchanged                     | App/RPC/service regression       |
| MTE-04 | Standalone / result Popup                                               | X/Esc/overlay/content close                    | Standalone cancel once; result not reported again; focus usable                                          | App/ledger                       |
| MTE-05 | anonymous/logged in, security check normal/cancel/fail                  | click claim repeatedly                         | One claim, cancel recovers, no automatic retry                                                           | App/HTTP                         |
| MTE-06 | Same-ID delivery, slow GET/resource, pending action                     | late old result after close/success            | Old content does not revive; new delivery can show and report again                                      | App/HTTP                         |
| MTE-07 | normal/failure/hidden, identity/locale change                           | poll and event refresh                         | 30s/600s environment policy; serialization, recovery, backoff, empty takedown                            | App/timer boundary               |
| MTE-08 | Service process first, failure, concurrent requests                     | GET/POST, switch account/language              | seq starts at 0, increments without duplicates; POST not counted; required / anonymous headers           | App/redacted HTTP ledger         |
| MTE-09 | report 500 / disconnect / account change                                | close / success                                | UI not blocked, no retry, an old event is not reported with a new credential                             | App/HTTP                         |
| MTE-10 | ZIP cold/warm cache, different hash, invalid package/source             | show / take down / redeliver                   | Verified unpack reuse, lease release, bad resource not shown                                             | App/Host/file evidence           |
| MTE-11 | bundle ready/error/not ready/forged source or instance                  | receive messages / switch theme / hide / close | Show only after a trusted handshake; fallback or hide; action boundary                                   | App/real iframe                  |
| MTE-12 | Server translation, empty/illegal message, claim inside a Popup         | fail and close the prompt                      | Plain text, no msg, original Popup restored; no retry/report                                             | App/HTTP                         |
| MTE-13 | Copy normal / permission failure / timeout / late                       | repeated click, close                          | Exact text, feedback and report after success, failure recovery, no task creation                        | App/clipboard                    |
| MTE-14 | Settings default / each section, market home/detail/missing             | navigate                                       | Confirm after the target takes over, reuse existing target, no install, no false confirm across identity | App/config                       |
| MTE-15 | Upgrade page real fixture ready/fail/hang                               | open, close early / time out                   | No confirm before ready; failure recovers; original upgrade entry unchanged                              | App/real webview                 |
| MTE-16 | HTML/Markdown/plaintext + class/style/theme                             | show and click                                 | Safe style, no nested interactives, links handled per platform, theme and narrow screen usable           | App/DOM/screenshot               |
| MTE-17 | image dark / video, decode failure / reduced motion                     | show / hide / recover                          | Theme resource chosen, pause and resume, fallback, Banner 96px                                           | App/media                        |
| MTE-18 | New / old entitlement / current structured connection                   | refresh and explicit user connection switch    | Entitlement presentation linked with Subagent candidates, not overwritten by marketing navigation        | App/HTTP/settings                |
| MTE-19 | provider view error                                                     | show the Root error prompt and retry           | No crash from a missing icon import; retry goes through the original service                             | App/component regression         |
| MTE-20 | App lifecycle / Web support boundary                                    | dispose / exit / Web bundle                    | Resources released; Web fallback, no bypass of shared-host; no spread of task semantics                  | Host/cross-client representative |

### Scenario details and event order (implemented, local Electron, pending-state unless noted)

All diagrams describe event order; none of these runs claims same-round full or overall 95%.

MTE-15, upgrade webview faults: the isolated HTTP fixture controls the page response (network
disconnect, close while hanging, 30-second navigation timeout) without faking webview completion
events. On failure the original marketing Popup is restored, no confirm. After a held response is
released the old result must not report late; an explicit re-click with a really ready page reports
one confirm. finally restores service ready; stop/reset release waits; no purchase/payment. Note:
`CloudContentDialog` unmounts the instance when open=false, and the upgrade failure prompt is
carried by the outer toast of `MarketingDialogs`, so the restored new instance cannot be required to
keep an internal `role=alert`; the recovery assertion re-locates the Popup and checks copy, enabled
button, no upgrade container, and empty events.

```text
marketing navigate -> real upgrade webview -> HTML fail/hold
  -> disconnect/close/timeout -> restore original Popup (events=0)
  -> release old HTML -> user clicks again -> new webview ready -> confirm=1
```

MTE-17 reduced motion, added inside the original MTC-RICH video Banner case: Chromium Emulation sets
prefers-reduced-motion=reduce, the real video pauses with autoplay=false; no-preference resumes
playback; the media node is not replaced and no marketing event is produced. finally clears the
emulation; no system setting change or matchMedia mock; the Electron-encoded MP4 still goes through
service download/prepare. It does not claim Hero bundle dynamic reduced-motion or real phones.

MTE-02 custom provider: a real Custom template creates an empty provider in the settings page; the
real providerId is read from the navigation node; after leaving the model section, marketing
navigate locates that ID, selects the target and confirms the report while the persisted connection
snapshot and the workspace's current model stay unchanged. finally deletes the provider via the
detail «更多» (More) menu and the confirm box; no direct config write, no real API key, no model
request.

MTE-06 resource-stage invalidation: an already shown Popup without Hero stays open while the new
Banner ZIP download hangs in the HTTP fixture; closing the Popup invalidates the old prepare
snapshot; after ZIP release the Banner does not show and nothing extra is reported. The queued next
GET arriving is the sync boundary for the previous round's resource handling; releasing it lets the
server re-deliver the same Banner and it shows. The resource gate only controls fixture response
timing; reset/stop release it; package content/hash unchanged.

```text
Popup shown -> new Banner GET -> ZIP hangs
  -> user closes Popup -> generation invalidated -> ZIP completes -> old prepare result discarded
  -> next GET arrives and hangs (previous round settled) -> no Banner
  -> release new GET -> same Banner prepared -> shown normally
```

MTE-13 copy platform hang: intercept the browser clipboard.writeText Promise while keeping the real
App 10-second capability timeout; while pending, close has no effect and reports no cancel; on
timeout the button recovers and an error shows. The old Promise is fulfilled both with the Popup
still open and after it was closed; neither may report confirm, show copy success or revive the
Popup. The interception acts at the platform boundary only; fulfilling the Promise does not mean a
real clipboard write and clipboard content is not claimed verified.

```text
copy -> platform Promise hangs -> pending (close refused)
  -> real 10 s timeout -> error + retryable
  -> [keep Popup / user closes Popup] -> old Promise resolves -> no success report
```

MTE-12 claim failure inside a Popup, three prompt-close entries (知道了 (Got it) / Esc / overlay): HTTP
returns a plain-text server message (with HTML literals such as `<b>今日额度已领完</b>` and newlines); the
original Popup is hidden during the error prompt; closing the prompt restores the same campaign with
the claim request still once and nothing reported; the user then closes the original Popup and
exactly one cancel is reported, claim count not increased. The fixture reuses the existing
action-delivery interface after claim-failure; no new product entry or timer fallback.

```text
original Popup -> user claims -> HTTP fails -> original Popup hidden + error prompt
  -> 知道了 (Got it)/Esc/overlay -> original Popup restored (claim=1, events=0)
  -> user closes original Popup -> cancel=1 (claim still 1)
```

MTE-11 invalid iframe messages (two independent cases): a real ZIP returns a ready with the wrong
instanceId after init, which must stay not-ready and fall back after the original 5-second limit; an
already ready iframe receives null, wrong instance/channel, illegal error/action/resize fields and
an unknown type (seven kinds) and stays ready with no error placeholder and no automatic report; the
user close reports exactly one cancel. A marker in the ZIP confirms the wrong ready was really sent;
invalid messages are posted by WebDriver after switching into the real sandbox iframe (existing
switchFrame usage), not by calling the validator directly. The App component remains the sole owner
of iframe readiness; Controller business state and the action protocol are unchanged.

```text
App init(instance A) -> ZIP ready(instance B) -> ignored -> original ready timeout -> fallback
ready iframe -> illegal message -> ignored -> still ready -> user closes -> cancel once
```

Pruning: no full Cartesian product of theme x language x action x platform; each side effect /
failure boundary is covered independently and pure style axes are verified on representative
combinations. Lottie public-component branches and the old failure-text function without a
production entry get scope verification first; internal functions must not be injected from tests to
reach 95%. If the protocol must change, old behavior be restored, or a test-only business entry be
added, record it and ask for a decision first. The current fixes and the contracts above need no
re-confirmation.

## Matrix Backfill / E2E Handoff

The audit document keeps original results without overwriting history; this file registers the
implementation stage; product semantics remain governed by marketing-touch-client.md/actions.md. New
cases live in ui-shell/manual-review/pending; the existing coding-plan HTTP fixture is extended with
case-local scenarios; security checks use synthetic stand-ins because third parties are
non-deterministic; ZIP/media/webview are real; no online claim. Isolated fixture scenarios do not
reuse absolute counts from an old ledger.

Coverage first fixes the baseline and executable-line mapping; no cross-domain whole-file false-hit
merging; business source that does not enter the bundle must be listed too. Code passed through by a
failing path is not a behavior pass. Test first, then fix; run
typecheck/typecheck:e2e/lint/architecture; commit after completion, no push; promotion still needs
manual confirmation.

## Verification Summary

Case counts of the batches (anonymous 2, delivery 57, entitlement 1 = 60) each passed in individual
runs and again 60/60 in the same round (above). Per-batch run notes, log paths and artifact ids are
in the full-history version. Batches of note: fresh-stable source-evidence smoke (1/1); same-round
48/48 with an ENOSPC runner exit 1 recovered by collector finalize (Renderer diff lines 721/900 =
80.11%, functions 178/222, branches 609/885); MTE-11 2/2; MTE-12 3/3; MTE-13 2/2; MTE-06 1/1; MTE-02
custom provider 1/1; MTE-17 1/1; MTE-15 3/3 after the assertion correction. Static gates for all
batches: typecheck, desktop typecheck:e2e, lint (45 existing warnings / 0 errors), architecture and
diff check passed. Only test, fixture, audit-tool and doc changes were made in these batches; no
product defects needing changes were found. All remain pending-state unless promoted above; nothing
was pushed. Disk cleanup touched only generated reports of this task (compressed old HTML/JSON,
removed derived `coverage/ui-renderer-html` pages of three rounds, regenerable); no source, ZIP
packages or user config deleted.
