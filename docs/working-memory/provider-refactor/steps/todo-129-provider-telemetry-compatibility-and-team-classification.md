# Todo129: Provider telemetry compatibility and Team plan classification

> Status: local implementation, targeted verification and review are done. Real Electron, phone and SSH
> acceptance is still pending for the final batch. Reports, real identities and historical data are
> unchanged.

Decisions confirmed by the user:

- For this round, "has a Coding Plan" covers both Individual and Team. The homepage off-peak entry
  stops blocking Team-only users. Everything else is limited to telemetry adaptation; Provider core and
  persistence are untouched.
- Restore old statistics IDs on the telemetry side wherever the old code and current facts determine
  the mapping. Do not keep an avoidable reporting break just because the new identity is nicer. Where
  a mapping cannot be recovered reliably, keep the real ID, record the difference and the reason, do
  not fabricate organization or project identity, and do not claim full compatibility.
- Reports, SQL, warehouse and already-reported data are not changed.

Related: [Todo128 start contract and off-peak eligibility refresh](./todo-128-provider-start-contract-and-offpeak-eligibility.md)
fixes stale status reads, refresh and out-of-order overwrites. This Todo fixes "even the latest status
misses Team". Neither replaces the other. Details and cases: [Todo129 implementation boundary](./todo-129-impact-and-cases.md).

## 1. Background and confirmed problems

A colleague reported that the Provider refactor may break reports: new Provider IDs enter old event
dimensions, and after the Team split some funnels and success-event classifications miss Team. The
historical baseline is the first parent of merge `279907140b`, not intermediate refactor commits.

### 1.1 Confirmed problems (before the fix)

| Item                  | Fact                                                                                                                                                    | Impact                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Core event dimension  | `send_btn` uses `custom:<encoded providerId>:<model>`; completion/step normal path uses `<providerId>/<model>`; `model_provider` uses the actual new ID | Filtering on old IDs misses new data; grouping splits old/new. Events are still sent.             |
| Team entry plan state | `resolveCodingPlanEntryPlanStateFromProviderSettings()` looked for Individual, then Start, and missed both Team Providers                               | Team-only returned `no_plan`; Team plus Start could return `start_plan`                           |
| BigModel Team family  | `resolveCodingPlanProviderFamily()` had no Team branch                                                                                                  | `unknown` and empty channel; correct is `bigmodel` / `MaaS`. Z.ai Team was already correct.       |
| Success event label   | `resolveProviderTelemetryLabel()` had no BigModel Team / Start                                                                                          | `add_model_success` carried the raw ID (Start was already missed in the old version; Team is new) |
| Homepage off-peak     | `OffPeakNewTaskEntry` used the same plan-state helper as click admission                                                                                | With `codingPlanActive` unset and the view loaded, Team-only was wrongly blocked from navigating  |

Limits of the evidence: the WebView bootstrap carried the wrong funnel context and the website protocol
uses it for four purchase events, but the real website purchase reports were not captured. The
`entry_plan_status` source and the core events' `plan_status / plan_product_id` source
(`usePlanIdentitySnapshot`, which already queries Team) are separate; the latter was not refactored.
hostname depends on address availability; completion/step without a request-start fact may fall back
to the seed, so not every event comes from an actual request. No probe was sent to the real
`/event/report`.

## 2. Boundaries and non-goals

1. Both Team Providers are recognized. For "has a Coding Plan", Individual and Team are one class.
   Start stays independent; not every account Provider or Off-Peak is a Coding Plan.
2. The fact gate stays `access.type === "zhipu-account" && entitled === true`. Disabling a model or
   Provider is not unsubscribing. No change to Account entitlement computation, credential state or
   plan queries.
3. The homepage off-peak mis-block is fixed, but gray config, entry dismissal, form eligibility,
   current connection, credentials, quota and submit validation stay. Explicit `codingPlanActive=false`
   still blocks; the gray rollout is not bypassed for Team.
4. BigModel gets family/channel and success label; both families behave symmetrically and each event
   keeps its existing naming.
5. ID compatibility acts only on existing telemetry output. It never flows back to Registry,
   ModelSelection, actual CLI request facts, auth identity, config files, databases, history or
   migrations.
6. No new events, no duplicate old+new events, no new report fields; token, latency, success-rate
   formulas, triggers and dedup are unchanged. Not an ARMS-wide rework.
7. The old `zcodeTaskNetworkDebugStatusFromPayload` parser is not part of this Todo (its top-level
   identity adaptation is an old projection-chain problem; V4 core telemetry has its own conversion).
8. Todo128's start/Registry notification/eligibility refresh/concurrency stays independent. No
   Composer change, no new generic plan service, no second entitlement cache.

## 3. Layer 1: statistics ID compatibility

### 3.1 Placement

A small pure mapping function is reused at the **boundary where each event builds its fields**. Input is
the real Provider identity plus the facts that event already has; output is the verified statistics ID.
The mapping does not query accounts or read mutable globals, and the global `/event/report` transport
is not turned into a string replacer.

```text
real ModelSelection / CLI request fact
                 |
     event field construction boundary
                 |
     adjudicated statistics ID mapping (pure function)
                 |
     keep the event's existing model_name encoding
                 |
             /event/report

the mapped result never flows back to Registry, model selection, requests, persistence or auth
```

The mapping applies to the Provider identity part only: take structured provider/model first, then
encode per event. No regex replacement of `account:` / `builtin:` over the whole `model_name`; never
touch `/`, `:` or `%` inside model IDs; never guess Provider from hostname, display name or another
selected account.

### 3.2 Mapping (verified against old staging `790884b1ce`)

| Current real ID                                          | Old statistics ID                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `zai-api` / `bigmodel-api` related history identities    | `builtin:zai` / `builtin:bigmodel`                                                                 |
| `account:zai-individual-coding-plan`                     | `builtin:zai-coding-plan`                                                                          |
| `account:bigmodel-individual-coding-plan`                | `builtin:bigmodel-coding-plan`                                                                     |
| `account:zai-start-plan` / `account:bigmodel-start-plan` | `builtin:*-start-plan`                                                                             |
| Both `account:*-team-coding-plan`                        | shared old Coding Plan bucket (old model options / connection resolution share it with Individual) |
| Both `account:*-offpeak-idle-plan`                       | shared old value `offpeak-idle-plan`                                                               |
| Custom Provider / unknown ID / already-old ID            | kept as is (never attribute to official by name or address)                                        |

Ten exact ID mappings are implemented. UUID instances created from templates are not forced into old
built-in buckets (template ID is not instance ID). Restoring old values may re-merge buckets the new
version split; that is the intended transition. Team mapping uses only facts the event already has; no
sensitive identity query, protocol or persistence is added. Proof of compatibility is paired
old/new event construction, not a helper returning one old ID.

### 3.3 Each event keeps its own field semantics

| Event                                                | model_provider       | model_name                                                                       | provider_name / other                                                     |
| ---------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `send_btn`                                           | statistics ID        | `custom:<encoded statistics ID>:<model>`                                         | UI address hostname at send time; absent address is not invented          |
| `message_completion` / `agent_step`                  | statistics ID        | normal request `<statistics ID>/<model>`; existing fallback without request fact | from the actual request; the mapped ID is never used to query Registry    |
| `context_compaction`                                 | same                 | existing Provider prefix rule                                                    | no new provider_name                                                      |
| `automation_create_result` / `automation_run_now_ck` | same                 | plain model ID                                                                   | existing rules: standard-personal, no template, hostname only for API-key |
| `off_peak_task_create_result`                        | per off-peak mapping | plain model ID                                                                   | provider_name from the result object                                      |
| `app_login_success`                                  | n/a                  | n/a                                                                              | OAuth `login_provider` unchanged (`z.ai` / `bigmodel`)                    |

ID adaptation must not change correlation or counts: send stays the submitted selection snapshot;
step/completion follow the actual request fact; a model change across requests is not overwritten by the
first/current UI selection. Multi-workspace, foreground/background and reconnect collection rules are
unchanged.

## 4. Layer 2: plan classification, funnel and homepage admission

### 4.1 Plan classification

`resolveCodingPlanEntryPlanStateFromProviderSettings()` includes both Team IDs. Do not use the broad
isCodingPlan helper that includes Start.

```text
ProviderSettingsView not ready -> unknown (unchanged)
  -> filter zhipu-account with entitled=true
  -> any Individual or Team? -> coding_plan
  -> else Start?             -> start_plan
  -> else                    -> no_plan
```

No plan-level inference is added: level stays empty when the helper cannot obtain it; levels taken
directly from the Usage snapshot are kept. The authoritative query, freezing time and content of
`entry_plan_list` are unchanged.

### 4.2 family/channel and success label

- `resolveCodingPlanProviderFamily()`: BigModel Team returns `bigmodel` / channel `MaaS`; Z.ai Team stays
  `zai` / `Z_AI`.
- `resolveProviderTelemetryLabel()`: BigModel Individual / Team / Start return `bigmodel`; Z.ai values
  stay `z.ai`; unknown IDs keep the raw value.
- `provider_family=zai`, success label `z.ai` and hostname `api.z.ai` are not conflated.
- `coding_plan_upgrade_ck` and the WebView bootstrap come from the same funnelContext (same funnel ID,
  status/family/channel); funnel ID is not regenerated; website product/period/amount fields unchanged.
- The four website purchase events are verified only for the app injection contract.

### 4.3 Homepage off-peak entry

`OffPeakNewTaskEntry` consumes the corrected fact; no component-level `providerId.includes("team")`
fallback.

```text
both Team entitled=true + gray allowed
  -> corrected classification coding_plan
  -> click homepage off-peak template -> normal navigation to create page
  -> form/Host keep current-connection, credential, eligibility, quota checks
  -> create and run only if all pass
```

"Team included" does not grant entitlement to arbitrary team accounts, and holding Team of another
family does not replace the current connection.

## 5. Impact surface (paths relative to `packages/ui/src/`)

| Priority       | Scenario / entry                                      | Shared implementation / authority                                                                              | Change boundary                                            |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| must-inspect   | Composer send, completion, step, compaction           | `v4/telemetry/conversationPromptTelemetry.ts`, `conversationTelemetrySupervisor.ts`, `lib/messageTelemetry.ts` | statistics ID in field construction only                   |
| must-inspect   | Settings, sidebar, Composer, off-peak upgrade entries | `lib/codingPlanFunnelTelemetry.ts`                                                                             | Team classification, family/channel                        |
| must-inspect   | Website purchase panel                                | `settings/model-provider-section/codingPlanEmbeddedWebview.ts` (frozen funnelContext)                          | verify injected values; no new WebView state owner         |
| must-inspect   | Homepage off-peak template                            | `v4/OffPeakNewTaskEntry.tsx`; gray config + settings view                                                      | fix Team mis-block; submit rules unchanged                 |
| must-inspect   | Provider subscription success feedback                | `lib/appTelemetry.ts`, `settings/model-provider-section/oauthActions.ts`                                       | success label normalization                                |
| should-inspect | Automation / off-peak create and run-now              | `lib/automationTelemetry.ts`, `lib/offPeakTelemetry.ts`, `settings/AutomationsSection.tsx`                     | provider fields only, plain model names                    |
| invariant-only | Login, core-event plan snapshot                       | `root/useRootOAuthEffects.ts`, `hooks/usePlanIdentitySnapshot.ts`                                              | unchanged                                                  |
| invariant-only | Actual requests, Service report, cross-end sync       | CLI fact producer, `services/src/telemetry/telemetryCore.ts`                                                   | requests use real IDs; no extra IO / global string replace |
| excluded       | Old network-status projection                         | shared parser, old Service/UI projection                                                                       | separate problem                                           |

## 6. Acceptance scenarios

Dimensions: family (Z.ai/BigModel), plan (Individual/Team/Start/none), entry (homepage/settings/other
funnel/event construction), identity (old/new/custom/unknown), fact source (send seed/real request),
end (desktop local/remote workspace/phone). Pure field mapping uses parameterized unit tests; no full
OS x theme x plan x event matrix.

| Case ID | Setup -> Action                                                                               | Must assert                                                                                                                | Layer                                                                                 |
| ------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| T119-01 | Each family has only Team, entitled=true -> read entry plan state                             | `coding_plan`; no fake Individual entitlement needed                                                                       | parameterized unit                                                                    |
| T119-02 | Individual/Team + Start mixed; only Start / none / null view                                  | Coding Plan wins; others start_plan/no_plan/unknown; disabling a model does not negate entitled                            | unit                                                                                  |
| T119-03 | Individual/Team/Start and unknown IDs -> create funnel context                                | family/channel correct; Start independent; unknown stays unknown                                                           | unit                                                                                  |
| T119-04 | BigModel Team/Start success -> real `add_model_success` builder                               | label=bigmodel; Z.ai=z.ai; login event value/count unchanged                                                               | builder/call test                                                                     |
| T119-05 | Team entry creates one funnelContext -> app upgrade and WebView bootstrap                     | same funnel ID, status/family/channel; audience, level/list kept                                                           | builder + WebView injection                                                           |
| T119-06 | Both Team-only, view ready, gray allowed, `codingPlanActive` unset -> click off-peak template | enters create page, no "no Coding Plan" prompt                                                                             | app E2E (real `OffPeakNewTaskEntry` browser case)                                     |
| T119-07 | No plan or `codingPlanActive=false` -> same entry; later submit eligibility fails             | still blocked/prompted; Team does not bypass connection/credential/quota checks                                            | unit + representative E2E                                                             |
| T119-08 | Verified official mapping, already-old ID, custom/unknown ID, special-char model              | provider and model_name identity consistent, encoding correct, unknown unchanged                                           | unit                                                                                  |
| T119-09 | Send seed -> request start -> step/completion; multi-request; early failure without request   | send keeps selection snapshot; runtime events use their request; missing fact keeps existing fallback; no event added/lost | V4 telemetry integration                                                              |
| T119-10 | Automation/off-peak create success+failure, run-now, compaction                               | plain model name / prefix rules kept; failures adapted too; hostname fill conditions unchanged                             | builder/call test                                                                     |
| T119-11 | Test reporter: one representative conversation and one funnel open                            | final `eventExtraDetail` correct, reported once; no probe to production endpoint                                           | transport-intercept integration/E2E                                                   |
| T119-12 | Desktop remote workspace, phone entries, history restore/reconnect                            | no cross-workspace identity pollution, no new phone telemetry requests, no backfill from restored history                  | existing isolation tests + targeted cross-end check (real Electron/phone/SSH pending) |

Execution record (2026-09-11): T119-01 to T119-11 covered by unit and browser tests. V4 Supervisor
compares old/new identity on the same fact sequence field by field after a model switch (only random
`step_id` excluded); duplicate terminal states do not re-report; foreground subtasks use their own
actual identity and token attribution does not mix into the main model. Failing assertions were
reproduced first (15), then extended to 11 files / 229 cases; three old off-peak expectations were
updated to the adjudicated old bucket without weakening event-count or payload assertions. Root
typecheck, lint (0 errors / 42 warnings) and architecture (0 violations) passed. The real website
purchase network events were not requested.

E2E handoff: read `DESIGN.md` (if UI changes) and `e2e-case-lifecycle`; reuse
`off-peak-create-manage.test.ts`, `off-peak-limit-pre-gate.test.ts` and existing telemetry parity / Team
Plan scenarios after checking real coverage; Provider fixtures use explicit family, Team-only,
entitled, gray config with no real credentials; wait on observable ready/route/event conditions, no
fixed sleeps; inject a test sink for transport; new cases are recorded in the case catalog and coverage
matrix with T119 IDs as requirement traceability. Desktop stays continuous, phone stays
replayable/shared-host; no second Agent/Host.

## 7. Completion criteria, risks and rollback

- Mappings determinable from the old version and current facts are restored and verified per event; fixing
  only classification is not completion. Unrecoverable items must be listed with old value, current value,
  missing fact and reason.
- Team-only users get both correct report classification and access to the homepage entry; no-plan and
  explicitly gray-disabled users are still blocked.
- BigModel Team family/channel and both success labels follow the event contract; downstream bootstrap values agree.
- Actual Provider ID, model request identity, selection and persistence are not polluted by the mapping.
- No duplicate reporting, backfill, extra permission or new file/field/table; the old parser is untouched.
- Main risk is wrongly merged or incomplete statistics buckets, not storage migration. hostname is not
  family/Provider ID. The fix only affects newly produced events; whether history is normalized is
  separate consumer-side work.
- Rollback: classification fix and ID mapping are separate commits; the mapping can be reverted alone
  keeping correct Team recognition; no config or DB migration to undo. A rollback changes later dimension
  values, so release notes must state the version boundary.

## 8. Remaining open items

- Real Electron, phone and SSH acceptance, and the actual website purchase network events, are unverified.
- Residual differences that could not be recovered are limited to what the execution ledger records;
  full report compatibility is not claimed.
