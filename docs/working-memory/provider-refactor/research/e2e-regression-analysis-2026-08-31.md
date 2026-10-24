# Provider Refactor E2E Regression Analysis (2026-08-31)

## 1. Conclusion Summary

On the MacBook Pro standard repository directory, branch commit `21c38683e1`, all 37 cases from the issue list reproduced stably: no flaky tests; no Electron, WebDriver, build, or machine environment failures; 37 surface failures consolidate into 7 categories of shared root cause.

Current evidence does not prove that all 37 product behaviors regressed: the vast majority of cases are blocked by outdated E2E fixtures, deleted old persistence fields, or incorrect Account Config injection methods before reaching their actual business behavior. These tests cannot simply be deleted: except 3 cases explicitly verifying "unreleased old format migration," the remaining business goals still have value and need migration to the current Provider/Account/Registry contracts before re-running to determine whether real product bugs remain.

Current production facts chain:

```text
ZCode Built-in Provider Config
              |
              v
Account Overlay
├─ access.entitled
├─ Current account Provider availability
└─ Start Plan dynamic model members (if any)
              |
              v
Personal Overlay
├─ User API Key / custom Provider
├─ User model members
└─ Personal Model Config Rules
              |
              v
Effective Provider / Model Config
              |
              v
Process-owned Provider Registry
              |
              v
Model Selection / Active Model
```

The old chain still used by failing tests — `legacy family mode / selectedKey` + writing Account Provider as Personal API-Key Provider to disk + waiting for `workspace_update_provider_registry.completed` — no longer exists, causing cascades like "page has no Coding Plan," "actual fallback to DeepSeek," "Registry revision not applied."

## 2. Reproduction Baseline and Artifacts

Baseline: Samantha workspace independent worktree; MacBook Pro standard repo `/Users/dev/Desktop/projects/Z.AI/z-code`; both at commit `21c38683e1 test(ui): remove stale built-in model label assertion`. Runs used existing bootstrap/build results with `ZCODE_E2E_SKIP_BUILD=1` and `ZCODE_E2E_SKIP_AGENT_BUILD=1`, no system configuration modifications.

| Run | Scope                                                       | Result                                      | Artifact                          |
| --- | ----------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| A   | 4 Bot target Cases + 1 same-spec control Case               | 1 pass / 4 fail                             | `desktop-e2e-20260831-093430-761` |
| B   | Coding Plan, Quota Reset, Upgrade Webview                   | 1 pass / 19 fail; all 15 from the list fail | `desktop-e2e-20260831-093509-202` |
| C   | I20, CW, OTB, I08                                           | 0 pass / 4 fail                             | `desktop-e2e-20260831-095111-677` |
| D   | Restart, Selected-key migration, Settings transition, Turbo | 1 pass / 15 fail; all 14 from the list fail | `desktop-e2e-20260831-095400-329` |

Artifact root: `/Users/dev/Desktop/projects/Z.AI/z-code/packages/desktop/.e2e-artifacts/`. All four reports show `0 flaky`, `0 infra failure`.

## 3. Seven Categories of Shared Root Causes

### R1. Bot Synthetic Harness Does Not Provide Target Host's Preferred Selection

Bot submissions fix the target Host's model at the Submission boundary: without explicit selection it reads `ModelSelectionView.preferredSelection` and refuses to create tasks if unparseable (`packages/services/src/bots/botsService.ts`). Both Bot E2E Harnesses still return empty Views:

```ts
getView: async () => ({ revision: 0, providers: [] });
```

(`packages/desktop/test/e2e/bots/helpers/bots-service-harness.ts`, `packages/desktop/test/e2e/bots/feishu-streaming-card-lifecycle.test.ts`.) Message processing therefore throws "Bot cannot resolve Submission model from target Host" before creating a Task or subscription; terminal events, AskUserQuestion cards, and streaming card lifecycles never occur. Test Harness is outdated — not four independent Bot product regressions. Fix: inject a minimal but real `ModelSelectionView` (Provider, Model, preferred selection) into the Harness and re-verify the original Bot behavior; do not restore old fallbacks or bypass formal Model Selection.

### R2. Coding Plan E2E Still Uses Old family mode / selectedKey as Authority

`coding-plan-team-usage.test.ts` scene preparation still writes `modelProviderFamilyModes` / `modelProviderFamilySelectedKeys`. The current production field is only `providerFamilyConnectionSelections` (structured union in `packages/shared/src/provider-family-connection-selection.ts`); the old fields and their migration were explicitly deleted in `8c55290f1f refactor(provider): finish model abstraction cleanup` — unreleased, no compatibility migration. Strict App Settings parsing discards old fields, and tests assert Team Plan identity via them, causing: no personal/Team Coding Plan in connection options; no Coding Plan tab on Usage page; context usage trigger and quota reminder not appearing; "selectedKey overwritten" after OAuth recovery; I29/I30 actually wrote the new structured selections but tests assert old `mode=oauth`, giving false failures. Same old-settings-fixture cascade. Fix: scene inputs and assertions use only `providerFamilyConnectionSelections`; Team Plan asserts complete `productId/organizationId/projectId`, no string selectedKeys.

### R3. E2E Treats Account Provider as Personal API-Key Provider

Current Account Provider responsibility boundary:

```text
Built-in: declares Provider static identity, API, model members
Account Overlay: declares access.entitled, account dynamic members/access facts
Personal Overlay: does not own Account access, cannot fake entitlement with enabled
```

The Resolver considers a Provider executable only when `access.type !== zhipu-account` or `access.entitled === true`. Failing tests still use old injection: `coding-plan-team-usage.test.ts` writes Personal `apiKey`, `enabled`, Endpoint, and models for `account:bigmodel-individual-coding-plan`; Restart/Turbo helpers use `seedReplayProvider()` writing Personal Providers for `account:*` without Account Overlay entitlement; Upgrade Webview tests read Personal Config via `readModelProvider()` expecting `apiKey`/`enabled` in Account Providers. Results: (1) the Account Provider is not executable due to `entitled !== true` and Selection legally falls back to DeepSeek; (2) tests reading the Personal Source cannot see dynamic Keys or entitlement from the Account/credential chain. This is a fixture/observation-point error after crossing the configuration layering boundary, not fixable by relaxing production Schema. Fix: Account Cases provide `entitled=true` and model members at the Account Source/account API mock boundary; OAuth/credential keys come from Credential fixtures; Personal Config keeps only truly allowed Personal Model Overlays; when testing Provider availability, read Effective Settings/Selection Views or formal request results, not Personal files.

### R4. I20 Already Writes New agents-state Structure, But E2E Still Reads Old Fields

The Subagent Service reads old `builtInModelOverrides` / `builtInThoughtLevelOverrides` as compatible input but unifies writes on save:

```text
builtInModelSelectionOverrides[agentName] = {
  providerId,
  modelId,
  options: { reasoningLevel }
}
```

I20 polls the original JSON's `builtInThoughtLevelOverrides.Explore` after selecting `high` and reports "nothing written" — the saved file no longer maintains the old dual map structure. Observation assertion outdated; the Case has not reached its core cold-start child-request assertion. Fix: E2E reads and asserts `builtInModelSelectionOverrides`; if old-file input compatibility needs verification, use a separate one-time importer/reader unit test.

### R5. CW / OTB / I08 Wait for a Deleted workspace Registry Push Log

All three treat `zcode_protocol.workspace_update_provider_registry.completed` as a readiness barrier; production code no longer emits this event (only these E2E tests search for it). After the Provider refactor the Registry is process-owned; the startup event is `zcode_protocol.provider_registry.ready`, and Personal Config updates are handled by formal Runtime/Registry sources without pushing Registry snapshots to each workspace. The three tests time out at old log polling without ever checking context window, output token budget, or new Provider initial requests — a stale synchronization barrier, not proof that Registry updates were not applied. Fix: delete the workspace Registry push log parsing helper; use current formal Registry ready/Selection View/final request capture as observable completion. Do not recover the deleted workspace Registry protocol for E2E.

### R6. I32-I34 Specifically Verify Ruled-Deleted Unreleased Migrations

These three Cases require startup-time fixing of `modelProviderFamilyModes + modelProviderFamilySelectedKeys -> new selectedKey`. The design no longer has a "new selectedKey"; the target is structured `providerFamilyConnectionSelections`, and the old migration was deleted under "unreleased, no compatible read." Their goals are invalid and must not be re-passed by modifying production code. Fix: delete the three old migration Cases; if startup recovery coverage is still needed, replace with "structured selection JSON round-trip identity unchanged."

### R7. CPUW-03's Webview Mock Assumption Is Also Outdated

`triggerCodingPlanWebviewPurchaseComplete()` reads the visible Webview origin and treats it as a local upgrade mock server. The actual Webview URL is the formal ZCode Endpoint (`https://zcode.z.ai/coding-plan...`), not a local mock server, so CPUW-03 fails before triggering the bridge; it also reads Personal Provider `enabled` after purchase (same as R3). The failure point is mock wiring and assertion staleness, not proof of purchase-bridge or refresh failure. Fix: mock control plane addresses come from the WDIO-started upgrade mock, not deduced from the Webview visible origin; Webview pages/navigation can keep the trusted ZCode Endpoint fixture; observe refresh via formal Provider Settings/Account entitlement after purchase.

## 4. 37 Cases Itemized Conclusions

|   # | Case                            | Actual Earliest Failure Point                                              | Root Cause | Judgment and Next Steps                                                               |
| --: | ------------------------------- | -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
|   1 | BOT-E2E-CR-01                   | terminal event is false                                                    | R1         | Re-run terminal delivery after Harness adds preferred selection                       |
|   2 | BOT-E2E-AQ-01                   | AskUserQuestion card does not exist                                        | R1         | Task not yet created; re-run card aggregation after adding Harness                    |
|   3 | BOT-E2E-IL-01                   | completed interaction card does not exist                                  | R1         | Task not yet created; re-run sealing after adding Harness                             |
|   4 | Feishu streaming card lifecycle | callback/stream/typing/terminal cards not combined                         | R1         | Same standalone Harness is empty; re-run after adding model                           |
|   5 | CTP-02                          | Connection option assertion failed                                         | R2 + R3    | Rebuild fixture with structured selection + Account entitlement                       |
|   6 | CTP-04B                         | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached activity/detail/performance assertions                                |
|   7 | CTP-05                          | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached personal/team combination display                                     |
|   8 | CTP-06                          | Old selectedKey not preserved                                              | R2         | Assert structured Team identity; do not restore selectedKey                           |
|   9 | CTP-09                          | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached activity failure isolation                                            |
|  10 | CTP-10                          | Context usage trigger does not exist                                       | R2 + R3    | No available Coding Plan source; verify freshness after rebuild                       |
|  11 | CTP-11                          | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached quota fatal/recovery                                                  |
|  12 | QR-E2E-01                       | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached opportunity/status authority relationship                             |
|  13 | QR-E2E-02                       | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached multi-type opportunity display                                        |
|  14 | QR-E2E-09                       | initial reminder does not exist                                            | R2 + R3    | source not established; verify persistent/hover after rebuild                         |
|  15 | QR-E2E-10                       | urgent reminder does not exist                                             | R2 + R3    | source not established; verify three-minute boundary after rebuild                    |
|  16 | QR-E2E-04                       | Context usage trigger does not exist                                       | R2 + R3    | Has not reached HoverCard/Dialog lifecycle                                            |
|  17 | QR-E2E-03                       | Cannot enter Coding Plan tab                                               | R2 + R3    | Has not reached `used_at` completion condition                                        |
|  18 | CPUW-01                         | Account apiKey missing in Personal reader                                  | R3         | Re-run after changing to formal credential/Account refresh point                      |
|  19 | CPUW-03                         | Local mock marking fails for formal Webview origin                         | R7 + R3    | Fix mock control plane wiring and remove Personal enabled assertion                   |
|  20 | I20                             | Old `builtInThoughtLevelOverrides` no longer appears                       | R4         | Read structured selection; then verify cold-start child request                       |
|  21 | CW01-CW04                       | Cannot find deleted workspace registry log                                 | R5         | Re-run limits/compact after switching to formal readiness/request barrier             |
|  22 | OTB01-OTB03/06-07               | Cannot find deleted workspace registry log                                 | R5         | Re-run request/compact/runtime budget after switching barrier                         |
|  23 | I08                             | Cannot find deleted workspace registry log                                 | R5         | Re-run settings addition, selection, and initial request after barrier                |
|  24 | I26/MP-R02                      | Account model not executable, falls back to DeepSeek                       | R3         | Verify non-first-model recovery after seeding Account Source entitlement              |
|  25 | I27/MP-R03                      | Old model not executable, falls back to target Host preferredSelection     | R3         | Verify Host current effective selection after seeding current Coding Plan entitlement |
|  26 | I28/MP-R04                      | Recent selection unavailable, falls back to target Host preferredSelection | R3         | Verify Host current effective selection after seeding current connection entitlement  |
|  27 | I32/MP-M01                      | Old selectedKey no longer migrated                                         | R6         | Delete; if needed, change to structured api-key selection round-trip                  |
|  28 | I33/MP-M02                      | Old Team selectedKey no longer migrated                                    | R6         | Delete; change to structured Team identity round-trip                                 |
|  29 | I34/MP-M03                      | No longer fixes incomplete old key                                         | R6         | Delete; strict Schema behavior for incomplete identities goes to unit tests           |
|  30 | I29/MP-S01                      | Actually wrote new selection, old `mode=oauth` assertion failed            | R2         | Assert structured selection, then continue verifying DeepSeek draft                   |
|  31 | I30/MP-S02                      | Actually wrote new selection, old `mode=oauth` assertion failed            | R2         | Same as above; not evidence of transition itself failing                              |
|  32 | I31/MP-S03                      | Target Account Plan not executable, still DeepSeek                         | R3         | Re-run reconciliation/highspeed after seeding entitlement                             |
|  33 | I35/MP-T01                      | Individual Plan/Turbo model not in selectable collection                   | R3         | Only Team Account models currently appear; re-run after fixing Account fixture        |
|  34 | I36/MP-T02                      | Individual Plan/Turbo model not in selectable collection                   | R3         | Has not sent first Plan request                                                       |
|  35 | I38/MP-T04                      | Actually selected Team GLM-5.3, not fixture's Individual Turbo             | R3         | Account identity/entitlement inconsistent; has not verified late envelope             |
|  36 | I39/MP-T05                      | Individual Turbo model not in selectable collection                        | R3         | Has not verified atomic switching and last-selected                                   |
|  37 | I42/MP-T06                      | Individual GLM-5.2 not in target selectable collection                     | R3         | Has not verified thought discard                                                      |

## 5. Recommended Fix Order

Phase 1 — fix test foundation facts, do not touch production semantics:

1. Bot Harness provides formal `ModelSelectionView`.
2. Unified Account E2E fixture: publish `access.entitled` and dynamic models from Account Source/account API mock; stop writing Account access to Personal Config.
3. Switch all Coding Plan scenes to `providerFamilyConnectionSelections`.
4. Subagent E2E reads `builtInModelSelectionOverrides`.
5. Delete the three old selectedKey migration Cases, or change to structured round-trip.
6. Delete the three E2E dependencies on `workspace_update_provider_registry.completed`, using current formal observation points.
7. Fix Upgrade Webview mock control plane and status observation points.

Phase 2 — re-run each group, then rule product bugs:

```text
Base fixture corrections
       |
       v
Did the Case reach the original business assertion?
       |
       +-- No --> Continue fixing test infrastructure
       |
       `-- Yes
            |
            +-- Pass --> Record as test migration
            |
            `-- Fail --> Fix as real product regression, then minimal production code fix
```

Re-run priority: (1) Bot 4 cases (minimal changes, fastest feedback); (2) CW / OTB / I08 (replace readiness barrier first); (3) Restart / Settings Transition / Turbo (share Account fixture); (4) Coding Plan / Quota Reset (share structured selection + Account fixture); (5) Upgrade Webview; (6) I20 full cold-start child request.

## 6. This Round's Non-Actions

- No production code modified;
- No legacy settings, workspace Registry snapshots, or Personal Account access restored to make tests pass;
- No failing cases marked skip/pending;
- No claim that underlying business behavior passed: this report rules only "earliest failure point and root cause at present"; original assertions must be fully re-run after test migration.
