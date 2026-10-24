# Todo154 Investigation: Current Limitations Of Independent Start Plans

> Investigation date: 2026-09-16; code baseline `c9f959050b8b17e0815f1680d674f09355649da0` (workspaces later fast-forwarded to staging `2772217134` — re-check line numbers and entry points before implementation). Pre-implementation investigation only; final implementations and Pro verifications see [Todo154](../steps/todo-154-start-plan-independent-provider.md); target designs based on [Design V2](../design-v2/design.md). This document records code facts, material differences, and evidence restrictions only — it does not define implementation candidates as architectures.
> Full history: `git show 45f808f7:docs/working-memory/provider-refactor/research/todo154-start-plan-independence-impact.md`

## 1. Actual Code For Requirements

| Fact                                                                                                             | Code Entries                                                                                                                          | Impact On This Requirement                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Fixed Start Provider IDs exist for both companies; static Access is `zhipu-account/start-plan`                   | `packages/shared/src/model-provider-types.ts`, `model-provider-family.ts`                                                             | Objects already exist; adding independent display/usage entries ≠ adding logged-in accounts                |
| Services load OAuth profile/tokens by brand                                                                      | `loadAccountIdentity` and auth injection in `packages/services/src/node.ts`                                                           | Start keeps current logins; no evidence a second OAuth is needed                                           |
| Start balance queries and personal plans are independent; balances determine entitlements and dynamic models     | `packages/services/src/model-provider/codingPlanProviderAvailability.ts`                                                              | Canceling manual connections cannot cancel pending, empty-model, and no-entitlement judgments              |
| `current` is computed from current brands and `selection.kind` together                                          | `packages/services/src/model-provider/accountProviderConnectionResolver.ts`                                                           | Even with entitlements, an unselected Start is not a current execution connection                          |
| Registries join providerExecutable via `current !== false`                                                       | `packages/provider/src/resolver.ts`                                                                                                   | UI separately displaying Start cannot make real executions pass                                            |
| All built-in account plans group as account-plan; valid selections need exactly one current + mapped providerIds | `packages/provider-node/src/model-selection-facade.ts`, `packages/provider/src/effective-model-selection.ts`                          | Start and Team both current would break model selections; common selection strategies must be consolidated |
| Request-period identities need current selections and matching access modes                                      | `resolveCurrentAccountAccess`                                                                                                         | Only opening Registries still gets rejected before authentication                                          |
| Start credentials come from login `tokenSet.zcodeJwtToken`                                                       | `packages/services/src/model-provider/accountProviderRequestAuthService.ts`                                                           | No token copies needed in Provider Configs or UIs                                                          |
| Family sub-items fold to side keys by Start IDs; details located by current plans                                | `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts`                                                       | Independent Starts need navigation identities and detail parsing adjusted together                         |
| Clicking Start generates kind `start-plan` and saves family selections                                           | `resolveConnectionSelectionForNavItem` / `persistProviderFamilyModeForNavItem` in `packages/ui/src/settings/ModelProviderSection.tsx` | Page browsing currently has execution-connection side effects                                              |
| Disconnect handlers call OAuth logouts                                                                           | `handleCodingPlanDisconnect` in the same file                                                                                         | Start de-connection needs the actions deleted, not just copy replaced                                      |
| Login initialization still selects Start; restart paths protect old Start selections                             | `packages/ui/src/root/oauthProviderFamilySelectionRefresh.ts`, `packages/ui/src/lib/modelProviderFamilyConnectionSelection.ts`        | Initializations and old-record handling must be planned together                                           |
| Root-layer loss observers find only the first current; Toasts store one notice                                   | `accountConnectionRefreshObserver.ts`, `useAccountConnectionLossNotification.ts`                                                      | Parallel statuses may miss or overwrite notifications; reuse decisions must include these consumers        |

## 2. Verified Call Chains And State Owners

```text
OAuth profile/token + SettingService
                ↓
Account Connection Resolver → Account Source statuses/Overlays
                ↓
ProviderConfigResolver → Settings Views / Registries
                ↓
Node ModelSelectionFacade → Effective Selections
                ↓
ModelFactory → Account Request Auth → Start JWT requests
```

- `createNodeModelSelectionFacade` is shared by services' providerRuntime and CLI protocol entrypoints.
- Account Sources re-check accounts/settings before publishing and reject late results on changes; `resetPrevious` isolates old accounts' last-known-good.
- Each execution Environment uses its own Registry; Host/Worker account fact synchronization must not become whole-Registry synchronization.
- Settings page browsing owners are UIs; paid-connection persistence owners are SettingServices; model intents keep each entry's original owners.
- `connectionKey` currently contains the selection; if Start no longer depends on paid connections, evaluate removing this identity dependency.

## 3. Differences From Old Materials

- [Todo101](../steps/todo-101-concurrent-account-providers-draft.md) (parallel specific Account Providers, explicitly deferred): only independent Start is requested; multi-Team/dynamic-instance/drawer schemes are not restored.
- [Todo93](../steps/todo-93-account-plan-loss-manual-switch.md): failures only prompt once and the user clicks to switch — no implicit switch targets; independent Start buttons' side effects need re-convergence.
- `docs/testing/model-provider-restart-connection-e2e-cases.md` I27/MP-R03: matrices write Start→Team, but the actual tests inject Recent and assert Configured Defaults — matrix/code drift; it cannot prove normal Sessions long-residing old Starts, and no full migration is demanded from it.
- `docs/testing/start-plan-manual-claim-e2e-coverage.md` still retains early automatic-switching history; acceptance is updated per final targets during implementation, history not rewritten as new facts.
- Feature graph `plan-entitlements`: `resolveLatestModelProviderFamilyConnectionSelection` seeds do not exist in current files; old Start automatic-rollback descriptions retained — drift recorded, converged when phases stabilize; graph not rewritten in this read-only investigation.

## 4. Write-Back Chains And Non-Migration Judgment

| Entry              | Current Code Facts                                                                                                                               | Evidence                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Plain Sessions     | `applySubmissionExecutionState` calls `setSessionModelSelection` and `persistRuntimeModelSelection` when plain submissions truly begin executing | `apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts:40`, `turn.ts:284`                                           |
| Compositions       | `useDraftConfigControl` derives effectiveSelection; `captureAcceptedModelSelection` writes back in accepted callbacks                            | `packages/ui/src/v4/composer/useDraftConfigControl.ts:172`, `:242`, `SessionPane.tsx:1493`                                   |
| Automations        | First dispatches resolve long selections via target Hosts and write results into runs; stored `automation.model_selections` are not updated      | `packages/desktop/src/host/automationModelSelection.ts:5`, `host/index.ts:869`, `automationRepo.ts`'s `fixRunModelSelection` |
| Bots               | Draft first-launch parsing creates sessions; after binding, reading Session selections and submitting goes through Session write-back paths      | `packages/services/src/bots/botsService.ts:4878`, `:4994`                                                                    |
| Wikis              | New generations parse once and save `modelConfig.modelSelection`; failure pages supplement fixed existing generation identities                  | `packages/services/src/repo-wiki/repoWikiModelClient.ts:98`, `repoWikiService.ts:369`                                        |
| Explicit Subagents | Profile selections cloned and parsed per execution, profiles unmodified; inheritances use parent models                                          | `apps/zcode-cli/packages/core/src/runtime/helpers/subagent-selection.ts:15`, `runtime/methods/subagent.ts:100`               |

Read-only effective-selection functions do not write original inputs — that alone cannot deduce that submission chains do not write back. The earlier deduction of full Session/draft migrations, connection-snapshot upgrades, and per-storage semantic versions from this was insufficient investigation and was withdrawn after the user pointed out the write-back facts.

I27/MP-R03's actual evidence injects selections into localStorage Recent (`model-provider-restart.ts:133`) and asserts recovery to DeepSeek Configured Defaults (`conversation-session-model-provider-restart-recovery.test.ts:134`); it does not inject Session `runtime/model_selections` and does not prove real users' residual proportions.

Non-migration ruling: current formats already save complete Provider IDs for both Start plans; no format-layer evidence requires new data migrations, and the user confirmed retaining original selections interpreted by new rules. Long configs may still save Starts mapped via paid plans; under new rules they use Start, and no-entitlement requires re-selection. This is a confirmed product boundary, not "all configs already automatically corrected" — it does not guarantee unchanged execution effects for every long config depending on old mappings, and adds no automatic correction logic.

## 5. Recommended Submission Entry Investigations

| Entry                            | Current Submission Facts                                                                                          | Recommendation-Related Boundaries                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Conversations                    | SessionPane's `createSubmissionFromComposer`/`dispatchSendText` form new submissions, writing back after accepted | Buttons, shortcuts, attachments, and new queue/guidance submissions need shared checks; cannot submit first then recommend |
| Scheduled Task forms             | `AutomationEditView.submitAutomation` calls onSubmit after validations; saving and running both reuse it          | Can prompt once before creating/modifying model saving                                                                     |
| Scheduled Task immediate running | Management stores only call `runAutomationNow` by automationId, no current selection parameters                   | User excluded this entry; no protocol expansion                                                                            |
| Wikis                            | RepoWikiPane.generate forms new requests; `regenerateFailedPages` is a fixed-generation-identity path             | Manual new generations included; failure-page supplements and automatic refresh excluded                                   |
| Custom Subagents                 | `SubagentForm.handleSubmit` validates then onSave                                                                 | Creating/modifying explicit model saving connectable; other field modifications do not prompt                              |
| Built-in/Plugin Subagents        | Share SubagentModelOverrideControl; `handleValueChange` → `persistConfig` saves immediately                       | Model selections equal submissions; only thinking-intensity calls, inheritances/defaults, or enable/disable excluded       |
| Bots / background / Off-Peak     | Each submission and execution semantics already have independent owners                                           | User excluded recommendations; current execution paths unchanged                                                           |

Source code: `packages/ui/src/v4/SessionPane.tsx`, `settings/AutomationEditView.tsx:1769`, `store/automationManagementStore.ts:424`, `repo-wiki/RepoWikiPane.tsx:795`, `settings/SubagentsSection.tsx:588`.

Balance sources already provide `UsageEntitlementSnapshot` and `startPlanQuotaBuckets.ts`: models match multiple effective buckets; unknowns are never treated as 0 or positive balances. `useV4SessionQuotaBanner`'s query is enabled depending on the selected Start, so the hook cannot directly serve as a paid-model recommendation data source without adjusting read conditions. Registry executability and entitlement=true do not separately prove usable balances.

The graph's model-selection nodes describe entries sharing effective-selection reads but lack the new submission-recommendation and persistence-preference edges; new edges stay graph deltas until phases stabilize. Global observers finding only the first current still holds; final plan selections observe only paid connections — no multiple-global-notification candidate implementations.

## 6. Verification And Restrictions

Behavior verification (2026-09-16): `pnpm exec vitest run packages/desktop/test/automationModelSelection.test.ts packages/provider/test/facades.test.ts` — 2 files, 17 items passed. Automation tests verify effective selections can change Providers while stored providerIds stay unchanged; Facade tests verify parse results do not write original inputs. Combined with Sessions/Compositions write-backs these form cross-entry evidence and cannot substitute for each other.

- No callable codegraph; verified via exact searches, imports, and critical caller reading — not claiming exhaustive dynamic paths or real user data.
- No new behavior implemented; no new-function E2E, real account requests, or online data audits; real credentials and task data untouched.

Current targets and acceptances are maintained by [Todo154](../steps/todo-154-start-plan-independent-provider.md); this research establishes no separate pending implementations.
