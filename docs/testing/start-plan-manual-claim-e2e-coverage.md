# Start Plan Manual Claim Regression Scope

> Superseded in part (2026-09-10): the old Banner/preview flow below is a historical coverage record and no longer the current Sidebar contract. Current semantics and the MTC acceptance matrix are in `docs/marketing-touch-client.md`. See [Migration note](#migration-note-2026-09-10).

Current rule (Todo93, 2026-09-08): after SPMC-08 refresh the UI only shows a hint; the on-disk connection stays Start. Clicking a concrete suggestion saves conditionally. When the setting is not writable the hint reports failure and succeeds only after permission is restored and the user clicks "重试" (retry); there is no automatic switch on a repeated refresh. Pro run `desktop-e2e-20260908-100921-925` passed 4/4 (the first-round SPMC-02 race between background balance update and button click was fixed by reordering the fixture, product unchanged). Full evidence and untested boundaries are in Todo93.

2026-09-06 (Todo 85): fixed-staging (`16d999f6a4`) product behavior is restored using the current Provider identity and settings service. Historical pass records do not prove the current code; current results are recorded in the [restoration audit table](../working-memory/provider-refactor/plan/staging-conflict-restoration-audit.md).

## Formal Electron E2E

File: `packages/desktop/test/e2e/start-plan-manual-claim-experience.test.ts`. Run on a MacBook Pro in an isolated test HOME.

| Case                       | Verified behavior                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPMC-01                    | Banner close confirmation can be cancelled; confirmed close sends no claim request                                                                                                                                                                                                                                                |
| SPMC-09                    | Claim failure shows "知道了" (got it); the current campaign does not reappear repeatedly; later campaigns keep polling                                                                                                                                                                                                            |
| SPMC-02 / 07 / 11 / BSM-20 | Verification params are submitted with the unique claim; claim result and copy-share; polling continues while the dialog is open; "模型设置" (model settings) only navigates and does not switch connection; manual Start view and entitlement refresh; Subagent candidates match the current connection; Start quantity shortcut |
| SPMC-08                    | Banner returns when the next slot opens; claim again and model-settings navigation; an unknown Provider navigation reports an explicit error but the page stays usable and later valid navigation recovers; none changes connection preference                                                                                    |

The tests replace only the verification and clipboard external capabilities and use local billing/subscription mocks; the real Renderer -> Host service and settings write chain still runs. Behavior failures are not hidden by editing CSS classes or loosening request matching; per-class and button-size checks without a product contract are not kept. Family's old mode/selectedKey assertions became structured connection selection; the old Provider Store is not re-imported.

Extensions inside the accepted claim scenario:

- Todo 88 / R10 (2026-09-07), dynamic member management: use a lowercase `glm-5.3-flash` that is returned by balance but absent from the static list; change the context window through the real dialog, save and reopen; drag `glm-5-turbo` after it. The on-disk Personal config records only that model's override and order and does not copy Account model members; account member IDs stay read-only. Real risk-control/billing requests are not verified.
- Todo 88 / R06 (2026-09-07), end of SPMC-08: confirm the persisted connection is Start, then make the local billing mock return no entitlement and trigger the real account-state update by refreshing in the model-settings page. The auto-switch notification must appear, the disk connection becomes a still-usable personal plan, and the settings page connection shows the personal plan. Do not change settings directly or call the auto-recovery function; unknown/network failure not mis-switching is covered by targeted unit tests.
- AS07 (2026-09-08): in the same scenario first make the isolated HOME's settings directory unwritable, wait for the real auto-switch failure log, confirm the connection is still Start and no success notification appeared; restore permission and click refresh again, and the same invalidation fact still auto-switches. Permissions are restored in `finally`; the real user directory is untouched. The POSIX permission-fault step runs only on non-Windows; Windows keeps the normal invalidation path; platform-independent failure de-dup and refresh errors are covered by unit tests. No timed retrier is added.

## Targeted unit tests

- Todo 89 / W89-01-04: in the dynamic-model step first confirm no Personal Provider record exists, then add and delete a personal model directly through the add dialog (not by sorting first to create a precondition). During dynamic member edit, change another model through the isolated config repo and confirm a View refresh does not clear input and a stale save keeps the error and draft. After cancel and reopen, save normally; add a model after sorting and check that the old order is kept and inherited members do not enter personal `modelIds`. Extends the existing scenario; no real model request.
- Preview/claim/balance `server_time` is converted from seconds to milliseconds; effective time is compared per its own endpoint source, never replaced by local `generatedAt`.
- `effective_at=0` takes effect immediately; a future time shows pending; if balance refresh fails the claim success is kept using the claim's known time.
- Login / becoming visible again / timed refresh; a late preview does not overwrite a newer request; de-dup of a failed current campaign does not swallow the next campaign.
- Two consecutive claims: after closing the first result, the first claim's late entitlement refresh must not overwrite the second result's time or release its claim state early; closing the dialog does not undo a completed claim.
- Copy success/failure only affects share feedback and does not hide the claim result and the model-settings entry.
- pending, unknown, no-model and unselected are distinct account states; tests must not force-select Start via "立即体验" before querying entitlement.

## Explicitly not restored

The fixed-staging "Start using" branch is off by default. The primary action is "模型设置" and failure is "知道了". No automatic Start connection write, no Composer auto model-select dispatch, no screenshot share menu. Real model requests, the real verification service and the system clipboard are outside what this local-mock E2E proves.

## Todo103 retained and reconnected scope

These current contracts are reconnected per the Provider refactor and the final Todo93 ruling. The source run records at the end prove only their own historical versions and do not mean the whole merge candidate passed; candidate evidence is in the Todo103 ledger. The old auto-activation and guide helper are not the current claim main path.

### Banner preview polling contract

The manual-claim Banner must not read preview only once at Renderer mount, because campaigns can reopen hourly. `ManualClaimPlanBanner` keeps reusing `ICodingPlanSubscriptionService.getManualClaimPlanPreviews()`; no second campaign interface and no polling state in desktop main, relay or Agent runtime.

```text
mount / login state change / visible again
  -> request preview immediately
      |-- plans -> select by priority -> show or update Banner
      |-- [] --------------------------> hide Banner, keep polling
      `-- error -----------------------> keep last successful snapshot

visible Renderer
  -> production: poll every 10 minutes
  -> development / test: poll every 30 seconds

document hidden
  -> stop timer
document visible again
  -> request immediately, then restart the environment-specific interval

claim request active
  -> polling paused; stale in-flight preview must not overwrite claim refresh
claim response settled
  -> preview single-flight refreshes immediately and polling resumes; the result dialog, balance or provider refresh must not keep holding the polling lifecycle
```

- Polling is serial: a timer tick during a slow request is skipped, never stacked.
- A continuous failure cycle logs one warning; only after a later success may a new failure warn again.
- After the user confirms closing the Banner, existing Renderer-local dismiss semantics hold: stop showing and polling for the current mounted lifecycle. Preview has no hourly batch ID, so do not infer a new batch from `planId` and force a re-show.
- Claim failure differs from active close: after the user closes the failure dialog the current Banner is hidden but polling continues. Without a batch ID, failure enters a "wait for gap" state: a non-empty preview is not shown again, the first empty result lifts the suppression, and a campaign appearing afterwards may show.
- Visibility follows the Page Visibility API: pause when a desktop window is minimized or a Web tab is hidden; plain app blur does not pause. This polling remains read-only exposure logic in the shared desktop/web Renderer and does not change desktop continuous or mobile replayable task recovery.
- Environment detection reads both the Vite build mode and compile-time `ZCODE_ENV`: only a production build with `ZCODE_ENV=production` uses 10 minutes; Vite development or `ZCODE_ENV=test` uses 30 seconds. Desktop E2E uses the production bundle but hits the 30-second period because of `ZCODE_ENV=test`.

### E2E login and verification fixture contract

Formal claim cases must have the WDIO startup credential seed keep a fake `zcodejwttoken`. Ordinary E2E deletes it so a fake JWT never reaches real plan endpoints; but this spec's Coding Plan endpoint is pinned to a shard-owned local mock and `claimManualPlan` reads the JWT before sending HTTP. Do not rely on the one-shot legacy `auth_token` migration: after `reloadSession` rebuilds Electron the migration source may already be consumed, so the service layer returns 401, proving neither that the failure fixture was hit nor that the success claim header was submitted.

```text
WDIO startup credential seed
  -> preserve fake zcodejwttoken for start-plan-manual-claim-experience
  -> Electron reload restores authenticated ZCode session
  -> deterministic verification success
  -> claimManualPlan reads JWT
  -> POST local /api/v1/zcode-plan/billing/claim
       |-- failure case: mock business code -> failure dialog
       `-- success case: code 0 -> success dialog + one verification header
```

- The verification stand-in must cover the official version's current SDK callback contract (details are maintained with the official version's verification spec).
- On SPMC-02 failure, output both the mock request ledger and the verification stage, to distinguish "claim not sent", business failure and success-copy drift.
- The spec's BigModel startup connection uses the structured `providerFamilyConnectionSelections.bigmodel` selection (for example `{ kind: "individual-coding-plan" }`); the old mode/selectedKey is not re-seeded. Compare that selection before and after opening model settings so history migration is not mistaken for a claim-navigation write.

### Feature relationships

| Rank           | From                    | Semantic edge          | To                                     | Why inspect it                                                    | Evidence                                                        |
| -------------- | ----------------------- | ---------------------- | -------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| must-inspect   | Manual claim Banner     | claims through         | Coding Plan Subscription Service       | Source of claim business facts and error codes                    | `ManualClaimPlanBanner.tsx`, `codingPlanSubscriptionService.ts` |
| excluded       | retained Start using    | no production entry    | Setting Service                        | Claim writes no connection; historical trace only                 | current ManualClaimPlanBanner                                   |
| excluded       | one-shot guide          | no claim trigger       | Composer                               | Claim triggers no auto model selection; no source fallback        | current claim DOM tests                                         |
| should-inspect | result sharing          | uses                   | Platform screenshot + Clipboard        | Failure only gives feedback and never reverses the claim          | `ManualClaimPlanResultDialog.tsx`                               |
| conditional    | Start Plan selection    | uses provider registry | local/remote workspace runtime         | Registry/remote sync semantics are not changed                    | `manual-model-switch-resolution-chain.md`                       |
| invariant-only | claim UI                | must not change        | desktop continuous / mobile replayable | No task stream, snapshot or replay change                         | no realtime/protocol files in the current diff                  |
| evidence-only  | focused component tests | covers                 | pure logic and rendered branches       | Unit tests are evidence, not a substitute for cross-component E2E | `packages/ui/test/manualClaimPlan*.test.ts`                     |

### Must-preserve invariants

| Invariant                                       | Proof needed                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| preview only exposes, never activates the plan  | preview and claim are distinguishable in the request ledger; claim count is 0 in the close flow                                        |
| claim success is an irreversible fact           | the success Dialog and actions stay even if the entitlement or provider refresh fails                                                  |
| claim does not trigger the guide                | after model settings the requestId does not increase and the persisted connection is unchanged                                         |
| never pick the first candidate for the user     | the result only navigates; candidates/selection come from the unified View                                                             |
| UI works across theme, language, narrow screens | DOM/visual evidence for Zai Light/Zai Dark, zh/en copy, 480px Dialog viewport constraint                                               |
| Hero resource isolation                         | iframe is `allow-scripts` only; init message validates source/instanceId; resource-ready E2E                                           |
| model-settings guide only navigates             | clicking the in-description entry closes the result dialog and targets `modelProvider`; the settings connection selection is unchanged |
| no spread into remote-control recovery          | no change to `clientMode`, `deliveryKind`, snapshot, queue, owner/lease                                                                |

### Codegraph evidence and drift

No codegraph query entry was available, so depth-2 verification used exact symbol caller search:

| Seed                                                | Direct caller / key path                        | Depth | Interpretation                           |
| --------------------------------------------------- | ----------------------------------------------- | ----- | ---------------------------------------- |
| `ManualClaimPlanBanner`                             | `WorkspaceSidebar`                              | 1     | Only claim entry                         |
| `requestManualClaimPlanModelGuide`                  | not called by the current ManualClaimPlanBanner | 1     | dormant helper, not on the claim chain   |
| `resolveManualClaimPlanModelSelection`              | dormant guide consumer still in Composer        | 1     | Not reconnected to claim by the merge    |
| `shouldDismissContextQuotaResetOpportunityReminder` | `ChatContextUsage`                              | 1     | Adjacent Tooltip outside-click semantics |

Graph drift: the existing feature graph declares only `capability.plan-entitlements`, `service.plan-entitlements` and the usage surface; the source once added manual-claim and guide relations. Todo103 keeps only the actual claim/refresh/navigation boundary and does not record the withdrawn guide commit edge as current fact.

## Boundary decisions

| Boundary               | Decision                | Includes                                                                                    | Excludes / prunes                                               | Source                                                  |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Claim main path        | accepted                | preview, confirm, verification, claim, success, parallel refresh, model-settings navigation | real inventory and real verification                            | feature spec                                            |
| Claim failure          | accepted                | representative stable business code + generic/verification focused tests                    | one E2E per business code                                       | Same failure Dialog/mapper, no extra chain difference   |
| Sharing                | accepted                | entry visible, direct copy text, success and failure feedback                               | real system clipboard permission matrix                         | Clipboard boundary covered by focused component tests   |
| Model selection        | excluded from claim     | model-settings navigation leaves the persisted connection unchanged, no guide               | first-item fallback / auto select / real model request          | manual selection has its own coverage                   |
| Theme/language         | accepted representative | Zai Light zh + Zai Dark en                                                                  | all theme x language x viewport permutations                    | Theme and locale are orthogonal presentation axes       |
| remote/mobile          | pruned                  | shared React pure-function/component unit tests                                             | separate remote Agent, replayable snapshot                      | Claim owns no task realtime state                       |
| Context reminder       | accepted focused        | trigger/reminder/outside targets                                                            | Cartesian product with claim                                    | Adjacent independent UI state, no shared business owner |
| Banner preview polling | accepted                | first fetch, 10m/30s period, visibility resume, serial and stale-result isolation           | new interface, hourly batch inference, cross-window coordinator | Renderer reads preview only, no new business owner      |

## Accepted cases

| Case ID | Setup                                                                             | Action                                                                                | Assertions                                                                                                                                                                                                | Evidence layers                           | Status                                    |
| ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| SPMC-01 | preview claimable, logged in                                                      | open close confirmation, cancel first, then close anyway                              | cancel keeps Banner; close hides; claim ledger is 0                                                                                                                                                       | Desktop DOM + mock ledger                 | formal E2E, promoted and passing          |
| SPMC-02 | preview, fake JWT, verification success, claim current                            | claim -> check result Dialog -> Model settings                                        | new title; description has no link; model settings and copy-share side by side; direct copy text; settings unchanged; claim header submitted once                                                         | Desktop DOM + mock ledger + settings      | formal E2E, promoted and passing          |
| SPMC-03 | official-version verification timeout escalation                                  | -                                                                                     | official version only; assertions are maintained with the official version's verification spec                                                                                                            | focused runtime unit                      | covered (official version)                |
| SPMC-04 | claim returns failure                                                             | claim, confirm failure Dialog                                                         | no Ticket/share/refresh; stable localized error                                                                                                                                                           | component unit                            | covered                                   |
| SPMC-05 | claim succeeded, candidates include Start                                         | open model settings                                                                   | navigation only: no automatic connection write, no guide request; the source's auto model-select case is not restored                                                                                     | component DOM + Settings E2E              | superseded by current navigation contract |
| SPMC-06 | Context reminder visible                                                          | click trigger, reminder, outside                                                      | first two keep, outside dismisses                                                                                                                                                                         | focused unit/component                    | covered                                   |
| SPMC-07 | an immediately effective old bucket and a due newly scheduled entitlement coexist | open Model Settings -> server marks the new bucket ready -> click refresh entitlement | old plan shows no refresh button; new plan shows an outline pill; click requests balance, the new bucket appears and the button disappears                                                                | Desktop DOM + local HTTP mock ledger      | formal E2E, promoted and passing          |
| SPMC-08 | current slot claimed, preview returns empty                                       | mock opens the next claim slot and wait for the 30 s test polling                     | preview request count increases; no Renderer reload; Banner returns automatically                                                                                                                         | Desktop DOM + local HTTP mock ledger      | formal E2E, promoted and passing          |
| SPMC-09 | preview, fake JWT, verification success, claim returns business failure           | close failure Dialog -> current slot stays empty -> later polling                     | claim with verification header added exactly once; current Banner hidden; polling does not stop; no repeat in the same round; next-round recovery after a gap is covered precisely by the timer unit test | component timer + Desktop DOM mock ledger | formal E2E, promoted and passing          |
| SPMC-10 | claim returns entitlement effective time and server time                          | claim after client clock skew while balance returns a conflicting schedule            | dialog decides only from the same claim's `entitlements[].effective_at` and `server_time`; balance does not override the dialog; a missing field does not fall back to `starts_at`                        | service mapper + component unit + E2E     | covered                                   |
| SPMC-11 | claim succeeded and the result dialog stays open                                  | provider refresh pending, advance one test polling period                             | preview still requests on the 30 s period; neither the result dialog nor the trailing refresh holds the polling lifecycle                                                                                 | component timer + Desktop mock ledger     | covered                                   |

## Pruning decisions

| Decision ID | Pruned combinations                                              | Guard/invariant                                                             | Representative coverage                     |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| SPMC-P01    | 2 themes x 2 locales x desktop/mobile x success/failure          | Business owner and presentation axes are orthogonal                         | SPMC-02 + focused i18n/theme DOM assertions |
| SPMC-P02    | Run Desktop for every claim error code                           | Mapper and failure Dialog are identical; only the description id differs    | mapper table unit + SPMC-04                 |
| SPMC-P03    | Real third-party verification service silent/interactive network | Third-party state is unstable and cannot enter CI                           | deterministic callback unit SPMC-03         |
| SPMC-P04    | Current dialog Start using and real model request                | The current UI only navigates to model settings; no auto switch is restored | claim DOM + existing model-switch suite     |

## Historical verification evidence (not Todo103 candidate acceptance)

### Branch-diff coverage

The audit took the whole production source set of the branch from `ebae2814f5...HEAD`, then used lines added/changed between `ebae2814f5` and the working tree as candidates, counting only lines that Istanbul `getLineCoverage()` treats as executable in the focused Vitest V8 report. Desktop Renderer uses different instrumentation/source-map granularity and its statement ids cannot be merged directly, so it is stored separately as cross-process evidence. Translation data, tests and docs are not in the denominator.

| Production source                          | Covered executable changed lines |
| ------------------------------------------ | -------------------------------: |
| `modelProviderService.ts`                  |                            6 / 6 |
| `contextQuotaResetOpportunityReminder.tsx` |                            5 / 5 |
| `contextUsage.tsx`                         |                            8 / 8 |
| `ManualClaimPlanBanner.tsx`                |                          10 / 10 |
| `ManualClaimPlanResultActions.tsx`         |                            8 / 8 |
| `ManualClaimPlanResultDialog.tsx`          |                            5 / 7 |
| `manualClaimPlanModelGuideStore.ts`        |                            4 / 4 |
| `manualClaimPlanModelSelection.ts`         |                          16 / 16 |
| official-version verification runtime      |                          29 / 30 |
| `SessionPane.tsx`                          |                          17 / 17 |
| `V4ComposerToolbar.tsx`                    |                          10 / 11 |
| **Total**                                  |           **118 / 122 (96.72%)** |

The 4 uncovered lines are only in share-failure feedback, the verification duplicate error rejection statement and one Composer guide condition line; the matching user behaviors are verified by the component failure test, the verification duplicate rejection test and the mounted V4 Composer assertion, and do not affect the 95% line-coverage gate.

### Executed suites

- Focused unit/component: 10 files, 346 tests all passing, including the selected Start Plan provider runtime and SessionPane first-send failure feedback and close.
- Desktop E2E (coverage mode): `desktop-e2e-20260827-130252-862`, SPMC-01/02, 2 cases, first-pass and final-pass 100%, no flaky, no infra failure.
- Final pending-commit mock/spec rerun: `desktop-e2e-20260827-131853-472`, 2/2.
- Rerun on the formal path after promotion: `desktop-e2e-20260827133422383-p95897-2b91245a0ba1a93d`, 2/2, manual-review switch not set.
- Scheduled-entitlement refresh rerun: `desktop-e2e-20260901090249947-p23514-f2968f04d3e97519`, SPMC-01 and SPMC-02/07, 2/2; verified old bucket kept, refresh button shown/hidden, post-refresh `billing/balance` request and new bucket display.
- Share entry and side-by-side action layout rerun: `desktop-e2e-20260901092627117-p53937-fef63e3aa58c22a3`, 2/2; share entry visible and the share and start buttons are on one row with equal height.
- Claim credential and two-branch fix rerun: `desktop-e2e-20260902-113435-283`, 4/4; SPMC-09 and SPMC-02 each really add one failing/succeeding claim with the verification stand-in token header, ruling out a fake pass from login 401 or verification error.
- E2E coverage artifacts: `packages/desktop/.e2e-artifacts/desktop-e2e-20260827-130252-862/coverage/`; case report: `summary.md` in the same run directory.

## E2E handoff

- Formal spec: `packages/desktop/test/e2e/start-plan-manual-claim-experience.test.ts`
- Mock fixture: extends the Coding Plan shard-owned local server with a manual-claim scenario and request ledger; no real backend.
- Provider fixture: not needed; no model prompt is sent.
- File-system fixture: credential, provider config and settings in the isolated E2E HOME.
- Timing: `fast-text`; verification timeout escalation is verified only in fake-timer unit tests.
- Coverage: set `ZCODE_E2E_COVERAGE=1` when running the spec to save the Renderer Istanbul report; strict branch-diff line coverage uses the focused Vitest V8 report so statement ids of different instrumentation are not mixed.
- Promotion: promoted to the formal path on 2026-08-27 after human confirmation; this auth/config/UI case does not depend on a provider replay fixture and the formal run keeps the deterministic local Coding Plan mock.

## Migration note (2026-09-10)

2026-09-12 update: the user confirmed the marketing E2E promotion; the current formal paths are `ui-shell/marketing-touch-delivery.test.ts`, `ui-shell/marketing-touch-entitlement.test.ts` and `ui-shell/marketing-touch-anonymous.test.ts`. Latest execution evidence: `marketing-touch-e2e-implementation.md`.

Everything above is a historical coverage record of the old Banner/preview flow and is no longer the current Sidebar contract; see `docs/marketing-touch-client.md` for current semantics and the MTC acceptance matrix.

The old `start-plan-manual-claim-experience.test.ts` was split into `ui-shell/manual-review/pending/marketing-touch-delivery.test.ts` and `marketing-touch-entitlement.test.ts`. Retired behaviors removed: local close confirmation, claim-result share-button generation, 30-second preview re-show. Kept: the real Banner/claim/report and the adjacent entitlement refresh, Start/Individual/Subagent selection linkage. The new path stays pending until human confirmation and is not auto-promoted to the formal suite. The old Banner component and its dedicated unit tests are now deleted; the independent Hero test remains.
