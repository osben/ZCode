# Provider Refactor E2E Regression Analysis (2026-08-31)

## 1. Conclusion Summary

On the MacBook Pro standard repository directory, current branch commit `21c38683e1`, all 37 cases from the issue list have been stably reproduced:

- No flaky tests;
- No Electron, WebDriver, build, or machine environment failures;
- 37 surface failures can be consolidated into 7 categories of shared root cause;
- Current evidence does not prove that all 37 product behaviors have regressed. The vast majority of cases are blocked by outdated E2E fixtures, deleted old persistence fields, or incorrect Account Config injection methods before reaching their actual business behavior;
- These tests cannot be simply deleted. Except for 3 cases explicitly verifying "unreleased old format migration," the remaining business goals still have value and need to be migrated to the current Provider/Account/Registry contracts before re-running to determine whether real product bugs still exist.

The current production facts chain is:

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

The old chain still repeatedly used by failing tests is:

```text
legacy family mode / selectedKey
              +
Writing Account Provider as Personal API-Key Provider to disk
              +
Waiting for workspace_update_provider_registry.completed
              |
              v
Old test considers Provider available
```

This old chain no longer exists, which causes numerous cascade failures like "page has no Coding Plan," "actual fallback to DeepSeek," "Registry revision not applied."

## 2. Reproduction Baseline and Artifacts

### 2.1 Baseline

- Samantha workspace: independent worktree
- MacBook Pro standard repo: `/Users/dev/Desktop/projects/Z.AI/z-code`
- Both commits: `21c38683e1 test(ui): remove stale built-in model label assertion`
- MacBook Pro uses existing standard bootstrap/build results; `ZCODE_E2E_SKIP_BUILD=1` and `ZCODE_E2E_SKIP_AGENT_BUILD=1` are set during execution, with no system configuration modifications.

### 2.2 Four Rounds of Native Desktop E2E

| Run | Scope                                                       | Result                                      | Artifact                          |
| --- | ----------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| A   | 4 Bot target Cases + 1 same-spec control Case               | 1 pass / 4 fail                             | `desktop-e2e-20260831-093430-761` |
| B   | Coding Plan, Quota Reset, Upgrade Webview                   | 1 pass / 19 fail; all 15 from the list fail | `desktop-e2e-20260831-093509-202` |
| C   | I20, CW, OTB, I08                                           | 0 pass / 4 fail                             | `desktop-e2e-20260831-095111-677` |
| D   | Restart, Selected-key migration, Settings transition, Turbo | 1 pass / 15 fail; all 14 from the list fail | `desktop-e2e-20260831-095400-329` |

Artifact root directory:

```text
/Users/dev/Desktop/projects/Z.AI/z-code/packages/desktop/.e2e-artifacts/
```

All four reports show `0 flaky`, `0 infra failure`.

## 3. Seven Categories of Shared Root Causes

### R1. Bot Synthetic Harness Does Not Provide Target Host's Preferred Selection

Current Bot submissions must fix the target Host's model at the Submission boundary: when not explicitly selected, it reads `ModelSelectionView.preferredSelection`, and refuses to create tasks if it cannot be parsed. The production boundary is at `packages/services/src/bots/botsService.ts`.

But both Bot E2E Harnesses still return empty Views:

```ts
getView: async () => ({ revision: 0, providers: [] });
```

Locations:

- `packages/desktop/test/e2e/bots/helpers/bots-service-harness.ts`
- `packages/desktop/test/e2e/bots/feishu-streaming-card-lifecycle.test.ts`

Therefore message processing throws "Bot cannot resolve Submission model from target Host" before creating a Task or establishing a subscription. Subsequent terminal events, AskUserQuestion cards, and streaming card lifecycles naturally do not exist.

Judgment: Test Harness is outdated, not four independent Bot product regressions.

Correct handling: Inject a minimal but real `ModelSelectionView` (with Provider, Model, and preferred selection) into the Harness, and continue verifying the original Bot behavior; do not restore old fallbacks or bypass formal Model Selection.

### R2. Coding Plan E2E Still Uses Old family mode / selectedKey as Authority

The scene preparation of `coding-plan-team-usage.test.ts` still writes:

```ts
modelProviderFamilyModes;
modelProviderFamilySelectedKeys;
```

The current production fields are only:

```ts
providerFamilyConnectionSelections;
```

Its structured union definition is in `packages/shared/src/provider-family-connection-selection.ts`. The old fields and their migration were explicitly deleted in commit `8c55290f1f refactor(provider): finish model abstraction cleanup`; the reason is that they had not been released and no longer bear compatibility migration.

Strict App Settings parsing discards old fields. Tests subsequently assert Team Plan identity using old fields, causing:

- No personal/Team Coding Plan in connection options;
- No Coding Plan tab on Usage page;
- Context usage trigger and quota reminder not appearing;
- "selectedKey overwritten" after OAuth recovery;
- I29/I30 actually wrote new structured selections, but tests still assert old `mode=oauth`, causing false failures.

Judgment: This is a cascade failure caused by the same old settings fixture.

Correct handling: Scene inputs and assertions should only use `providerFamilyConnectionSelections`; Team Plan directly asserts complete `productId/organizationId/projectId`, no longer generating or checking string selectedKeys.

### R3. E2E Treats Account Provider as Personal API-Key Provider

The current Account Provider responsibility boundary is:

```text
Built-in: declares Provider static identity, API, model members
Account Overlay: declares access.entitled, account dynamic members/access facts
Personal Overlay: does not own Account access, cannot fake entitlement with enabled
```

The Resolver only considers a Provider executable when `access.type !== zhipu-account` or `access.entitled === true`.

Failing tests still use old injection methods:

- `coding-plan-team-usage.test.ts` writes Personal `apiKey`, `enabled`, Endpoint, and models for `account:bigmodel-individual-coding-plan`;
- Restart/Turbo helpers use `seedReplayProvider()` to write Personal Providers for `account:*`, without establishing Account Overlay entitlement;
- Upgrade Webview tests read Personal Config through `readModelProvider()`, expecting `apiKey` and `enabled` in Account Providers.

Two outcomes result:

1. Account Provider is not executable due to `entitled !== true`, and Selection legally falls back to DeepSeek;
2. Tests read the Personal Source and naturally cannot see dynamic Keys or entitlement from the Account/credential chain.

Judgment: This is a test fixture/error observation point after crossing the configuration layering boundary, not fixable by relaxing production Schema.

Correct handling:

- Account Cases provide `entitled=true` and corresponding model members at the Account Source/account API mock boundary;
- OAuth/credential keys continue to be provided by Credential fixtures;
- Personal Config only retains truly allowed Personal Model Overlays;
- When testing Provider availability, read Effective Settings/Selection Views or formal request results, do not read Personal files to guess Account status.

### R4. I20 Already Writes New agents-state Structure, But E2E Still Reads Old Fields

The Subagent Service can currently read the old:

```text
builtInModelOverrides
builtInThoughtLevelOverrides
```

as compatible input, but unifies writes during save:

```text
builtInModelSelectionOverrides[agentName] = {
  providerId,
  modelId,
  options: { reasoningLevel }
}
```

I20 still polls the original JSON's `builtInThoughtLevelOverrides.Explore` after selecting `high`, reporting "nothing written." This does not prove save failure; it only proves the saved file no longer maintains the old dual map structure.

Judgment: Observation assertion is outdated. This Case has not yet reached the core assertion of cold-start child requests.

Correct handling: E2E should read and assert `builtInModelSelectionOverrides`; if old file input compatibility needs verification, set up a one-time importer/reader unit test separately, not letting normal E2E continue requiring writes back to old formats.

### R5. CW / OTB / I08 Wait for a Deleted workspace Registry Push Log

All three tests treat the following log as a readiness barrier:

```text
zcode_protocol.workspace_update_provider_registry.completed
```

Current production code no longer has this event; only these three E2E tests in the repo search for it. After the Provider refactor, the Registry is a process-owned runtime, and the startup event is:

```text
zcode_protocol.provider_registry.ready
```

Personal Config updates are also handled by formal Runtime/Registry sources, no longer pushing Registry snapshots to each workspace.

Therefore all three tests time out at old log polling, without checking context window, output token budget, or new Provider initial requests.

Judgment: Test synchronization barrier is outdated, does not represent that Registry updates truly were not applied.

Correct handling: Delete the workspace Registry push log parsing helper, and switch to current formal Registry ready/Selection View/final request capture as observable completion conditions. Do not recover the deleted workspace Registry protocol for the sake of E2E.

### R6. I32-I34 Specifically Verify Ruled-Deleted Unreleased Migrations

The titles and implementations of these three Cases require startup-time fixing:

```text
modelProviderFamilyModes + modelProviderFamilySelectedKeys
                         -> new selectedKey
```

But the current design no longer has a "new selectedKey"; the target is structured `providerFamilyConnectionSelections`. The old migration was already deleted under the ruling of "unreleased, no compatible read."

Judgment: The goals of these 3 Cases have become invalid and should not be fixed by modifying production code to pass them again.

Correct handling: Delete these three old migration Cases. If startup recovery coverage is still needed, replace with "structured selection JSON round-trip identity unchanged," do not test old string fixes.

### R7. CPUW-03's Webview Mock Assumption Is Also Outdated

`triggerCodingPlanWebviewPurchaseComplete()` first reads the visible Webview origin, then treats this origin as a local upgrade mock server to call "mark purchase complete." The current actual Webview URL is the formal ZCode Endpoint:

```text
https://zcode.z.ai/coding-plan...
```

It is not a local mock server, so CPUW-03 fails before triggering the bridge. This Case also reads Personal Provider `enabled` after purchase, same as R3.

Judgment: The current failure point is Webview E2E mock wiring and Account status assertion outdated; no proof that the purchase completion bridge or refresh logic has failed.

Correct handling: Mock control plane addresses must come from the WDIO-started upgrade mock, not deduced from the Webview visible origin; Webview pages/navigation can continue using the trusted ZCode Endpoint fixture. Observe refresh results through formal Provider Settings/Account entitlement after purchase.

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

### Phase 1: Fix Test Foundation Facts First, Do Not Touch Production Semantics

1. Bot Harness provides formal `ModelSelectionView`.
2. Establish unified Account E2E fixture: publish `access.entitled` and dynamic models from Account Source/account API mock; do not write Account access to Personal Config anymore.
3. Switch all Coding Plan scenes to `providerFamilyConnectionSelections`.
4. Change Subagent E2E to read `builtInModelSelectionOverrides`.
5. Delete the three old selectedKey migration Cases, or change to structured round-trip.
6. Delete the three E2E dependencies on `workspace_update_provider_registry.completed`, using current formal observation points.
7. Fix Upgrade Webview mock control plane and status observation points.

### Phase 2: Re-run Each Group, Then Rule Product Bugs

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

Re-run priority:

1. Bot 4 cases (minimal changes, fastest feedback);
2. CW / OTB / I08 (only replace readiness barrier first);
3. Restart / Settings Transition / Turbo (share Account fixture);
4. Coding Plan / Quota Reset (share structured selection + Account fixture);
5. Upgrade Webview;
6. I20 full cold-start child request.

## 6. This Round's Non-Actions

- No production code was modified;
- No legacy settings, workspace Registry snapshots, or Personal Account access were restored to make tests pass;
- No failing cases were marked skip/pending;
- No claim that underlying business behavior has passed. The current report only rules "earliest failure point and root cause at present"; original assertions must still be fully re-run after test migration.
