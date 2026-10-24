# Todo156: Start independent Provider follow-up fixes and final page decisions

> Status: F01-F09 implemented on authorization and self-reviewed (2026-09-17); required verification still
> has baseline failures; the user, knowing this, explicitly asked to commit and push. Implementation,
> evidence and uncovered items are in section 14.
> Source: review after [Todo154](todo-154-start-plan-independent-provider.md), Air feedback and later
> item-by-item discussion. This Todo supersedes the initial implementation scope of
> [Todo155](todo-155-start-plan-selection-dependency-cleanup.md) (which keeps the investigation history;
> conflicts resolve to this Todo). Review baseline `f2b40bda8c`.

## 1. Final scope and state ownership

This round fixes Start's leftover dependence on the old connection mode, tidies the always-present
Provider's status display, fixes the team connection dropdown and adds plan names to session model hints;
later review added the submit recommendation for the question-creating side session (F08, section 12) and
shared recommendation balance, on-demand refresh and 60-second validity (F09, section 13). Existing
components, data owners and execution protocol semantics are kept; the contract for passing the side
session's first model is completed before implementation.

| Fact                       | Authoritative source                                         | Display / consumer                                                |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Model for the next submit  | effective Provider, model, options of the current input/form | input quota; submit-time same-model recommendation                |
| Executed model and errors  | session execution facts                                      | session balance and business error reminders                      |
| Historical model switch    | recorded fromProvider/fromModel, toProvider/toModel          | switch divider hint (never reads the current draft or connection) |
| Start identity/entitlement | current logged-in account, Account Source                    | Provider availability, Registry, settings page                    |
| Paid-connection selection  | existing saved selection and the in-flight submit selection  | personal/team dropdown, full team identity match                  |
| Plan balance               | existing UsageEntitlement service                            | by plan and quota bucket (no second balance state)                |

`current` still means "matches the account access context"; Start and one paid Provider may both be true;
it is not the input selection and is not used to guess the dropdown's selected item. Desktop continuous,
phone replayable and the original submit owner are kept.

## 2. F01: input-box Start quota drops the old connection gate

`resolveV4ContextPlanConnection` in `V4ComposerToolbar.tsx` still required a global selection of kind
start-plan once Start was chosen in the input (personal/team/none all returned none), so the ring could
disappear for a new zero-usage session and the hover lacked Start balance (the ring also carries context
usage, so it is not the Start state indicator).

- [x] Remove that extra connection condition; show balance per the input's effective Provider and model.
- [x] Keep original account entitlement, model, config validation and quota-refresh entries.
- [x] Personal/team quota keeps depending on the correct paid scope; other Providers' semantics unchanged.

## 3. F02: legacy team completion failure no longer blocks Start

Chain `settingService.prepareLegacyAccountConnections` -> `node.ts` readAccountProviderSettings ->
`accountProviderConnectionResolver.ts`: a legacy team missing organizationId with failed completion produced
`unresolvedFamilies`, marking the same brand's Providers including Start unknown and skipping queries.

- [x] Drop that restriction for Start (it keeps querying entitlement independently by the logged-in account).
- [x] Missing team info still restricts paid access that needs it (no guessed organization/project).
- [x] No migration, extra recovery or complex race barrier. Old tests asserting Start unknown with the whole brand are corrected. The defect has source and test evidence but is not the proven cause of the earlier Air plan-expiry symptom.

## 4. F03: claim, success feedback and "View plan"

The active claim entry/dialog is carried by Marketing Touch; the old `manualClaimPlanModelGuideStore` and
Toolbar consumer (waiting for global Start, auto-picking a model, showing "Start ready") has no production requester.

```text
original active entry -> original verification and claim -> success feedback
   -> refresh Provider entitlement and balance
   -> user clicks "View plan" -> the always-present Start detail
User actively picks a Start model, or accepts the existing same-model recommendation at submit -> Start is actually used
```

- [x] Keep the original claim entry, actions, success dialog and campaign eligibility; claiming changes neither the input model nor the global paid connection.
- [x] The button that jumps to settings is uniformly "View plan" (real content/button come from remote config, so the actual delivery and navigation action were checked, not only local copy).
- [x] Start is always present and opens detail on click; while the entitlement refresh is unfinished the detail shows the existing loading feedback (no dedicated wait-for-entry flow).
- [x] Claim API success and refresh success are handled separately; a refresh failure cannot reverse the claim result.
- [x] Remove the old auto-model-select guide and its dedicated leftovers; no "use now" auto model selection and no extra input-box hint layer.
- [x] The claim entry stays independent of the plans the user owns and follows original campaign eligibility.

## 5. F04: pass account access parameters to balance queries

These callers supply `preferredProviderId` but omit `accountAccess`; `useUsageEntitlement` does not fill it
and `BigModelUsageQuotaProvider` does not derive it from the ID alone, so Start can return `not_configured`
with provider=null, quota=null.

| Call site                                               | Fix                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `useV4SessionQuotaBanner.ts`                            | add the access description from the actual executing Provider; keep the server-error branch |
| `usePlanIdentitySnapshot.ts`                            | check Start/paid queries, add the parameter, keep the plan-identity statistics purpose      |
| `MarketingTouchProvider.tsx` post-claim balance refresh | add the access description for that Start query, still via the existing service             |

- [x] Fix the calls without asking the user to reconnect or copying credentials into UI.
- [x] Cover cold cache, existing cache and refresh so other entries filling the cache do not mask the missing parameter.
- [x] Session feedback is not bound to the draft model not yet submitted; no new quota owner.

## 6. F05: Start always present and right-side status tidy-up

### 6.1 Final product decision

**The Start Provider is always present** (the earlier "hide the Provider without a plan" idea was withdrawn).
Existing brand display rules, the unified Start name and the real IDs are kept. 2026-09-17 addition: both
trial plans share the Z icon provided by the user; personal/team plans keep their brand icons. Presence does
not mean executable models. The original screenshot mixed "Coding Plan / not connected / config unavailable"
for no-plan, query failure and missing config; this round fixes the state classification and reuses existing
page components (no page redesign).

| Case                                     | Final display and action                                                    | Nature                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Not logged in                            | Start-specific login note + login entry                                     | adjust note and wiring, reuse login flow; never "connect Start"       |
| First query, nothing yet                 | original "querying + spinner"                                               | reused, no skeleton                                                   |
| Explicitly no valid plan                 | no trial plan available; keep original intro and applicable campaign entry  | necessary Start empty-state adjustment                                |
| Valid plan                               | original plan card, quota card, upgrade, model management                   | reused; connect/disconnect and paid-connection dropdown removed       |
| Pending                                  | original green pending time                                                 | reused, no promise of executability                                   |
| Effective time reached, quota not synced | original "refresh entitlement" button                                       | reused                                                                |
| Quota exhausted                          | original card 0%, empty bar, 0 / total; keep plan info and model management | reused, no exhaustion warning added                                   |
| First query failed                       | original failed state with retry wired                                      | fix classification/action; no no-plan or not-connected                |
| Background refresh failed                | existing cache/error handling                                               | no new failure bar over old content; cache-retention rule not widened |
| Explicit login/credential invalid        | original re-login action                                                    | necessary classification fix; ordinary network failure only retries   |
| Provider config truly missing            | only then show config unavailable                                           | fix wrong judgment; no-plan or balance failure must not trigger it    |

- [x] Linked check of `providerFamilyConnectionVisibility.ts`, `Detail.tsx`, `StatusCards.tsx` and the original claim/intro entries so changing copy alone does not hide actions.
- [x] With a plan keep plan name, expiry, per-plan quota cards, per-model quota buckets, upgrade and model-management layout; multiple plans group exactly by plan_id; one exhausted bucket does not affect others or clear the page.
- [x] Show the empty state only when the interface explicitly proves no valid plan (a bare `no_plan` does not infer claim history or "expired"); with no dynamic model list no models are faked; Provider presence and Registry-executable models are judged independently.

### 6.2 Explicitly not added

No dedicated "quota exhausted" warning bar or red style; no first-load skeleton (reuse query text and spinner); no persistent "refresh failed" bar over old content (active-operation failures reuse existing error feedback); no Start small-dot loading state and no change of existing gray meaning or left-side color system (normal dot: disabled gray / executable green / other unavailable orange / existing group loading feedback); no change to "any refresh error keeps old data" (the hook keeps snapshots only for some silent refresh errors; ordinary failure or an unavailable snapshot may clear/replace, verified against the original contract).

### 6.3 Quota times are not leftovers

Air log `2026-09-17.log` (Beijing 2026-09-17 01:12:06): entitlement period=daily; two buckets
expires_at=1789660799 (Sep 17 23:59:59); plan ends_at=1790006399 (Sep 21 23:59:59), proving both times are real.

```text
balance.expires_at -> limit.nextResetTime -> this quota bucket's time
plan.ends_at       -> expireTime          -> the whole plan's expiry date
```

- [x] Keep the original time display; each bucket uses only its own expires_at (no fallback to plan expiry); no field means no fabricated time; no promise that quota is restored at that time (the last period may expire with the plan).

## 7. F06: team connection dropdown reflects the paid selection exactly

Cause: `feeca80bd4` kept an entry for old Start users ("a single paid candidate is still actively selectable")
and judged selection via `selectedOption.item.provider.accountState.current`; team entries inherit the
personal Provider object structure and were misread; an empty value's hint was written as SelectValue child
instead of a placeholder, leaving only the arrow.

- [x] Pass the settings page's existing paid selection (saved + in-flight submit selection) directly; no new state.
- [x] Reuse the existing full matching: personal by brand and type; team by brand, organization, project and plan identity.
- [x] Delete the guess of the selected item from the entry's `provider.current`.
- [x] If nothing matches do not pick the first option; pass the "select a plan" placeholder properly.
- [x] A single option that is selected keeps the hidden behavior; a single unselected one keeps an operable dropdown.
- [x] Team temporarily unavailable is not the user cancelling the selection and must not clear the selection on availability change alone; detail shows the reason.
- [x] Switching to Start in the input does not change the global paid-connection dropdown.

Explicitly deferred (user's final decision, left to later dedicated governance): team entries are built by
copying personal plan data (three branches may inherit provider, entitlement, subscription and quota
fields). This round does not rebuild team entries explicitly, extract a unified team constructor or replace
inherited fields; it only cuts the dropdown's selection check off from that object. The mid-way idea of
"also govern it in passing" is not in this round.

## 8. F07: plan labels in session model hints

```text
GLM-5.3(个人套餐)   GLM-5.3(体验套餐)   GLM-5.3(团队套餐)
模型已切换 GLM-5.3(团队套餐) → GLM-5.3(体验套餐)
```

- [x] Label both sides separately so same-named models still show the quota source; other models use the same format.
- [x] Covers the session switch divider, the first "now using" hint and the matching switch toast.
- [x] Type comes from the record/hint's own real Provider ID; BigModel, Z.ai and i18n supported.
- [x] History renders directly by the new rule without migration; current account, connection, draft or catalog changes never mislabel history.
- [x] Custom Providers keep their original naming; input button, model menu and Subagent labels are not widened.

## 9. Common boundaries and doc alignment

No migration of sessions, tasks, automations, Subagent, Bot or model selection; legacy `kind: start-plan`
stays readable. No merge of the two brands' Provider IDs and no Todo101 coexistence. Unentitled/unavailable
Start never silently consumes paid quota; claiming and browsing change neither model nor global paid
connection. The same-model recommendation keeps thinking-compat validation and original submit/accepted
write-back; task triggers, background execution, run-now and Bot add no recommendation. No new identity-read
race barrier, auto-resend, second accepted queue, connection or quota state.

- [x] Before implementing, the formal Start spec and related feature graph were aligned with these decisions (removing "Start is a connection option / auto fall back to personal on invalidation"); withdrawn candidates not introduced.
- [x] Old guide code deleted only after checking real references and only for the dedicated deprecated flow; valid legacy-format compatibility reads kept.

## 10. Regression cases

| ID    | Scenario                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SF-01 | Two brands x global personal/team/none/legacy Start: input-selected Start provides its quota                                                                                                                                                                                                                       |
| SF-02 | New zero-context and existing-context sessions: ring, hover and refresh correct; after switching to paid, correct scope                                                                                                                                                                                            |
| SF-03 | Legacy team organization completion fails: Start still queries independently; team access keeps its restriction                                                                                                                                                                                                    |
| SF-04 | Session balance, identity snapshot, post-claim balance: cold cache / existing cache / refresh pass correct access description                                                                                                                                                                                      |
| SF-05 | Start present; not logged in, querying, no plan, valid, pending, failed, login invalid show correct state and action                                                                                                                                                                                               |
| SF-06 | Zero quota keeps the original card; multiple plans and buckets do not mix; bucket time vs plan expiry separate, no fabrication                                                                                                                                                                                     |
| SF-07 | After claiming, model/paid selection unchanged; "View plan" opens the Start detail; refresh failure does not reverse the claim                                                                                                                                                                                     |
| SF-08 | Team selected and personal not enabled: dropdown shows team; team temporarily unavailable not cleared by current; full team identity matched                                                                                                                                                                       |
| SF-09 | Old Start user without a paid selection: "select a plan"; the single personal candidate selectable; never auto-picks the first                                                                                                                                                                                     |
| SF-10 | Two brands x three plan types, same/different model names, missing catalog, history replay: divider / first-use / toast suffix correct                                                                                                                                                                             |
| SF-11 | Custom Provider labels unchanged; zh/en, light/dark, desktop and phone narrow without truncation or overflow; no new left-side status system                                                                                                                                                                       |
| SF-12 | Original exact Start resolution, request auth, same-model recommendation, claim, store owners and continuous/replayable boundaries not regressed                                                                                                                                                                   |
| SF-13 | `/side <question>` first submit: when compatible with quota the recommendation may show; confirm affects only the child, "not now" keeps its original selection, closing neither creates nor sends and keeps the draft; empty `/side` does not prompt; both delivery modes keep original idempotency and admission |
| SF-14 | Recommendation, settings page and input hover share the same-account same-Start balance; after the settings page refreshes to zero the recommendation must not keep the old positive quota; other accounts/Providers' results are not mixed                                                                        |
| SF-15 | Recommendation balance within 60 s judged by the real quota; over 60 s or unknown refreshes in the background, this time continues with the original selection without waiting, and the next submit uses the new result                                                                                            |
| SF-16 | Same brand A -> B: B's balance is read via the account/Provider refresh mechanism; brief reuse is allowed but an old sample older than the validity stops being used; query failure follows existing backoff and never blocks submit                                                                               |
| SF-17 | Session switch, unmount/remount and next-day entry never make an old balance fresh again; repeated access reuses the 60 s throttle and in-flight merge; no extra polling without operations                                                                                                                        |
| SF-18 | Bucket validity checked at submit time: a fresh snapshot with an expired bucket does not recommend; server time counts the time elapsed since sampling; original bucket/plan time display rules kept                                                                                                               |
| SF-19 | Claim / entitlement change triggers the original refresh chain and syncs the recommendation basis; an existing zero quota updated to positive restores the recommendation without auto-switching; covers every recommendation entry and the same-Host phone path                                                   |

Old tests asserting "Start quota requires a globally selected Start" and "Start must be unknown when legacy
team completion fails" were corrected; tests proving the right expectations came before implementation.
Gates: workspace freshness, git status, typecheck, lint, `architecture:check --changed`, affected tests;
per the user, E2E via **Pro admin SSH** under e2e-case-lifecycle; light/dark and narrow-window checks do not
replace a physical phone or full Web shared-host E2E, and uncovered items are listed.

## 11. Pre-implementation pause (history)

Investigation had 5 existing test files / 118 passing with old-semantics assertions; eight source-probe
combinations showed only legacy start-plan connections return Start quota context and an `accountAccess`-less
query returns an empty `not_configured` snapshot. Before the pause only the label draft was uncommitted
(`modelTriggerDisplay.ts`, `ConversationRowView.tsx`, `SessionPane.tsx`,
`packages/ui/test/v4ConversationRowViewTimelineMarker.test.ts`, the label rules in `docs/zai-start-plan-provider.md`);
it had failed 7 tests first, then 2 files / 28 passed. The user later confirmed adding F08 and confirmed
F09 (shared recommendation balance, on-demand refresh, 60 s validity); brief reuse on account change is
allowed but not forever, with no new complex identity race barrier.

The conditional multi-instance quota ownership / list key suspicion was rechecked against the baseline:
`StartPlanBalanceCard.tsx`, `StartPlanContextBalance.tsx` and `bigmodelUsageQuotaProvider.ts` are identical
to the pre-change `2772217134` and to local `origin/staging` at recheck. A constructed-input probe does not
prove the production interface allows that combination, so it is not a definite defect introduced here and
the F05-decided grouping/display rules are not changed. History: `13bb702b38` once withdrew key hardening
under the entitlement_id uniqueness contract and `853b93b2c2` restored that topic to an earlier version;
historical notes do not replace verifying the current interface contract.

## 12. F08: recommendation for the question-creating side session

Confirmed 2026-09-17. `SessionPane` returned early for `/side <question>` and called
`createSelectionSideSession({ firstInput: { text } })`; the CLI created the child and started the first
input directly, bypassing the normal-send recommendation. Plain side-session follow-ups already use the
shared send path.

```text
user submits /side <question> -> resolve the model the child actually inherits -> shared same-model recommendation
  confirm switch -> create the child with the confirmed Start selection and submit the first message
  not now        -> create with the child's original selection and submit
  close          -> keep the input draft, create nothing, send nothing
parent session model, runtime state and queue keep their original semantics
```

- [x] Shared recommendation at the first-submit boundary of text-bearing side sessions, keeping same-model, thinking-compat, quota and "don't ask again" rules.
- [x] Decide by the child's actual inherited and resolved model, not the parent's input draft.
- [x] The confirmed selection must reach the child's first execution and the original save boundary (no dialog while still executing the old paid model); the parent model and global paid connection are not modified.
- [x] The command accepted only `firstInput.text`; the explicit first-message model-passing contract (spec/protocol) was completed first, with App, Host and CLI types and runtime schemas checked.
- [x] Original admission, ACK, dedupe and failure handling kept; no extra accepted queue, no send-then-switch, no auto-resend.
- [x] Empty `/side` only opens the side session (no recommendation); plain follow-ups not re-wired; the exclusions for background, retry and Bot unchanged.
- [x] SF-13 confirm / not now / close, incompatible thinking, unknown/zero quota, don't ask again, child/parent isolation covered; Pro admin SSH verified the end path, continuous/replayable recovery boundaries checked separately.

## 13. F09: shared recommendation balance, on-demand refresh and validity

Confirmed 2026-09-17. "Recommendation dialog" = the "Not now / Switch plan / Don't ask again" dialog shown
before submit/save when a paid same model has trial-plan quota. This section handles both the recommendation
using stale balance for a long time and a same-brand account change still using the old recommendation balance.

Before: `useStartPlanRecommendation` only enabled refreshOnMount; the initial branch of
`useUsageEntitlement` used unlimited validity for the shared cache; the recommendation and the settings page
had different request parameters/cache keys (a settings refresh did not update the recommendation basis);
bucket-validity checks used the snapshot collection time, not elapsed time. Hook probes reproduced: next-day
still recommending, remount not querying, settings balance zero but still recommending, old positive quota
after a same-brand account change.

### 13.1 Shared balance fact

- [x] Unified Start query parameters and cache identity: recommendation, settings page and input quota hover reading the same Start of the same account on the same Host share the original entitlement service's result and update notifications.
- [x] A fresh balance after a settings/hover refresh updates the recommendation basis (no mutually non-updating equivalent caches).
- [x] Reuse the existing account/Provider entitlement fingerprint and invalidation events, keeping the boundaries between accounts, brands, Providers and Hosts; no new balance owner, no credentials copied into UI.
- [x] Only the balance fact is shared; each entry still decides by its own effective model selection, Registry, thinking compat and Host recommendation preference. Unified parameters must not bypass the original query eligibility or model execution validation.

### 13.2 On-demand refresh

- [x] Check whether a refresh is needed on entering a recommendation-capable page and on the original recommendation operations (sending, saving a task). Ordinary access reuses the existing `USAGE_ENTITLEMENT_ACCESS_REFRESH_MS` 60 s throttle, in-flight merge and failure backoff.
- [x] Account change, claim or entitlement change reuse the settings page's Provider entitlement fingerprint and refresh mechanism, reading in the background and publishing to consumers, with the original trigger semantics (no new synchronous send gate).
- [x] During the transition after an account change brief reuse of existing content is allowed and replaced when the new result arrives; with query failure or no new result an expired snapshot must not remain the recommendation basis.
- [x] No polling without operations: "60 s" is the normal on-demand refresh window and recommendation validity, not a fixed 60-second request interval. No account-switch race barrier, auto-resend or second accepted queue.

### 13.3 Recommendation rule at submit

| Balance fact at submit                                                        | Behavior                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| latest successful sample <= 60 s, same-model bucket valid with positive quota | recommend normally when the original candidate/thinking/preference conditions hold                                                           |
| latest successful sample <= 60 s, balance zero                                | no recommendation, continue with the original selection                                                                                      |
| sample older than 60 s, or not yet queried                                    | refresh in the background per existing throttle/backoff; this time continues with the original selection without waiting for the quota query |
| query failed                                                                  | skip the recommendation, normal submit unaffected; retry per original backoff                                                                |
| snapshot <= 60 s but its quota bucket has expired                             | that bucket is not a basis; other valid same-model buckets are judged by the original rule                                                   |

- [x] Validity is by the latest real successful sample; reading cache, remounting and cross-entry echo do not reset its age; a failed refresh does not extend an old positive quota's validity.
- [x] Bucket validity is judged at the actual submit time; with a server reference time the time elapsed since collection is counted (not fixed at snapshot.serverTime / generatedAt); the original handling of server vs local clock difference is kept.
- [x] The validity limit applies to recommendation decisions, not to turning every plan-page display cache into a 60 s clear, and adds no exhausted/refresh-failed style.
- [x] The first submit after a long idle may not show the recommendation: it goes with the original model, and after the background gets the new balance later submits are judged normally; no post-hoc dialog and no auto switch to Start.

```text
account/Provider change, claim done -> original entitlement refresh -> publish new Start balance
enter page / user submit            -> original on-demand check (60 s throttle, merge, backoff)
                                          -> shared balance -> settings page / hover / recommendation consumers
this submit -> snapshot within 60 s and bucket valid?
   yes -> original same-model, thinking, positive-quota and preference checks -> original dialog / submit path
   no  -> background refresh on demand; this time the original model is submitted, no waiting, no re-send
```

- [x] SF-14..19 covered, especially "old positive quota turned zero" and "old zero quota replenished to positive", and same-brand account change, remount, cross-day, refresh failure and recovery.
- [x] All shared recommendation entries checked: Session, Automation, Subagent, manual Wiki and F08's side first message; each keeps its original submit/save owner; same-Host phone identity source and sync boundary verified.
- [x] The formal Start spec's recommendation rules were updated to this section before implementation, with regression tests.

Multi-instance quota grouping / list key (item 4 of the previous review) is not handled by the user's
decision and keeps baseline behavior; it is not a side refactor of F09.

## 14. Implementation and self-review (2026-09-17)

### 14.1 Delivered behavior

- F01/F02: input-box Start quota by the effective Provider; legacy team organization completion failure restricts only paid plans, not Start; paid scope and execution auth kept.
- F03/F04: old auto-model-guide removed; the real marketing button labeled "View plan" per navigation action; claim success refreshes Provider and shared balance separately without altering the claim result, model or connection; session balance, plan-identity statistics and claim refresh pass explicit account access.
- F05/F06: Start always present reusing status cards; no-plan, network failure and explicit login invalid are distinguished with retry/login wired, no more false "not connected" or "config missing"; no generic order button for no plan; the paid dropdown reads the saved/in-flight selection and matches full team identity instead of the copied personal Provider.current.
- F07: first-model hint, switch divider and toast label personal/trial/team plans by their own real Provider ID, both brands and zh/en; no history migration.
- F08: the side first-message recommendation bases the inherited model on the parent runtime's effective model; the confirmed selection reaches the child via one `createSelectionSideSession.firstInput.modelSelection`; "not now" keeps the inheritance; close neither creates nor sends and keeps the draft; the parent input draft is not rewritten.
- F09: settings page, hover, recommendation and claim refresh share the original service's Start query parameters and account fingerprint; ordinary access reuses the 60 s throttle, in-flight merge and error backoff; the recommendation uses only a real sample within 60 s and counts the elapsed time for bucket expiry; shared query failures are synced to the recommendation entry; no polling without operations; no new balance owner.

### 14.2 Regression and end evidence (groups overlap; not independent totals)

- Root affected regression `pnpm exec vitest run --changed HEAD`: 622 files, 7041 pass, 7 skipped (`/tmp/start156-unit-changed.log`; `test:unit:affected` was skipped because HEAD equals upstream and is not counted as evidence). Final page/shared-balance targeted 4 files / 223 and marketing 2 files / 12; Session desktop/phone submit entries 68 (6 new side-session confirm / not-now / close groups, parent-effective model, draft isolation).
- Root typecheck, lint (54 existing warnings) and `architecture:check --changed` (0 violations) pass. CLI typecheck 28 tasks pass; side native 8; selection child, continuous/replayable, dedupe targeted 3 files / 26 (187 filtered out).
- Pro desktop E2E (`macbook-pro-admin`, isolated dir `/Users/dev/zcode-start156-pro-e2e`): final run `desktop-e2e-20260917051754556-p53534-7ee59f80ae96b31e` passed, covering team dropdown, Start ring/labels, Subagent/Automation recommendation, chat close / not-now / confirm, side first-message real request Provider/thinking, main-draft isolation, and don't-ask-again persistence across restart. Supplementary Pro run `desktop-e2e-20260917052049566-p56236-413567dc76597ef7`: `marketing-touch-entitlement.test.ts` and `repo-wiki-model-plan-selection.test.ts` pass (refresh after claim does not overwrite the connection, old Start selection kept, the single paid candidate selectable, Wiki not-now / confirm persistence).
- Pro browser page states: 64 groups (two brands x 8 states x desktop/390px, zh/en, light/dark) pass; after fixing pending fixture fields and the generic order button for empty plan, 16 empty/pending groups re-pass; screenshots copied to `/tmp/start156-pro-evidence/browser/` and viewed.

SF-01..19 are covered by component / Hook / service / CLI and end evidence combined, not every combination
as full-product E2E. Phone evidence is the shared SessionPane compactForRemoteControl regression, the CLI
replayable boundary and a 390px browser check; **a physical phone Safari or a full Web shared-host joint
E2E was not run**, nor Windows/Linux Electron, real accounts or live paid APIs. E2E external services use
isolated fixtures while UI, Host/Worker, protocol request construction and persistence are real; new cases
remain pending (not self-promoted, no CI admission claimed).

### 14.3 Self-review fixes and retained boundaries

- A query failure did not notify other balance consumers (so the recommendation could keep the old positive quota); the failure fact is now published at the original shared error/backoff owner with a "settings refresh failure makes the recommendation skip" regression.
- Explicit login invalidation became a structured `accountLoginRequired` display fact (login/retry behavior no longer decided by i18n key).
- The empty plan reused the generic order button; removed for Start while keeping the intro and campaign eligibility; valid/pending upgrade and the zero-quota card unchanged.
- E2E fixes: reading visible text during layout, and an exit-animating old dialog mistaken for a second recommendation; the pending visual fixture got proper effectiveTime / entitlementId and visible-state assertions.
- Shared recommendation entries (Session, Automation, Subagent, manual Wiki) checked; the recommendation was not moved into background execution, Bot or run-now; the side session has no separate accepted queue or send-then-switch. The old guide's dedicated exports were deleted after a reference check; the generic guide capability of the model menu and other consumers stay.
- No migration, no auto fallback to paid, no new account race barrier; copied team entry structure and multi-instance quota ownership / list key stay as decided.

### 14.4 Baseline gates that did not pass

- `pnpm --dir apps/zcode-cli lint` fails: telemetry / adapters / contracts / debug files exceed the existing 400-line limit (log `/tmp/start156-cli-lint.log`; e.g. `telemetry/src/model-api-recorder.ts` is identical to HEAD). Root lint passed; the CLI-wide failure is not attributed as passed.
- Extended `v4-native-boundary.test.ts` found 3 pre-existing V4 -> legacy protocol imports (`commands/handlers/goal-compact.ts`, `commands/handlers/session-flow.ts`, `commands/prompt-turn.ts`), byte-identical to HEAD (log `/tmp/start156-cli-tests.log`); this round's side-session handler adds no such dependency.
- The feature graph parses but the original graph has 4 dangling edges and plan-entitlements' old codeSeed points to the nonexistent `modelProviderFamilyConnectionSelection.ts`; only the confirmed plan invariants were synced, graph governance not widened. The Codegraph service was unavailable (impact scanning used real references and regression evidence; no graph-index verification claimed).

On finishing, per the root AGENTS gate-failure rule the workspace was kept and not auto-committed; the user,
knowing the limits above, explicitly asked to push, so the commit proceeded with the normal push hooks. Known
failures and unverified items stay; the commit does not mean all gates passed.
