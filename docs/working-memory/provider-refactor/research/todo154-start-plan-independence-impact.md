# Todo154 Investigation: Current Limitations Of Independent Start Plans

> Investigation date: 2026-09-16.
> Investigation code baseline: `c9f959050b8b17e0815f1680d674f09355649da0`.
> Subsequent workspaces already fast-forwarded to staging `2772217134`; this investigation and 17 unit test evidences still belong to original baselines, line numbers and entry points must be re-checked before implementation. Upstream Todo153 already occupied, this item continues from Todo153 as Todo154.
> This document retains pre-implementation investigations, not representing current code states; 2026-09-16 authorized for implementation, final implementations and Pro verifications see Todo154 §8.
> Conclusion destinations: [Todo154](../steps/todo-154-start-plan-independent-provider.md); target designs based on [Design V2](../design-v2/design.md).
> This document only records code facts, existing material differences, and evidence restrictions, not defining implementation candidates as architectures.

## 1. Actual Code For Requirements

| Fact                                                                                                                     | Code Entries                                                                                                                          | Impact On This Requirement                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Both companies have fixed Start Provider IDs, static Access as `zhipu-account/start-plan`                                | `packages/shared/src/model-provider-types.ts`, `model-provider-family.ts`                                                             | Existing objects already present, users adding independent display/usage entries, not equivalent to adding logged-in accounts |
| Services loading OAuth profile/tokens by brand                                                                           | `loadAccountIdentity` and auth injection in `packages/services/src/node.ts`                                                           | Start continuing to use current logins; no evidence this requirement needs adding second OAuth                                |
| Start balance queries and personal plans independent; balances determine entitlements and dynamic model sets             | `packages/services/src/model-provider/codingPlanProviderAvailability.ts`                                                              | Canceling manual connections cannot cancel pending, empty models, and no-entitlement judgments                                |
| `current` calculated together from current brands and `selection.kind`                                                   | `packages/services/src/model-provider/accountProviderConnectionResolver.ts`                                                           | Even with entitlements, unselected Start is not current execution connections                                                 |
| Registries participating in providerExecutable via `current !== false`                                                   | `packages/provider/src/resolver.ts`                                                                                                   | UI separately displaying Start cannot make real executions pass                                                               |
| All built-in account plans grouped as account-plan; valid selections require exactly one current and mapping providerIds | `packages/provider-node/src/model-selection-facade.ts`, `packages/provider/src/effective-model-selection.ts`                          | Directly making Start and Team both current would break model selections; must consolidate common selection strategies        |
| Request-period identities requiring current selections and access modes matching                                         | `resolveCurrentAccountAccess`                                                                                                         | Only opening Registries still rejected before authentication                                                                  |
| Start credentials read from login `tokenSet.zcodeJwtToken`                                                               | `packages/services/src/model-provider/accountProviderRequestAuthService.ts`                                                           | No need adding token copies in Provider Configs or UIs                                                                        |
| Family sub-items folded to side keys using Start IDs, details located by current plans                                   | `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts`                                                       | Independent Starts needing navigation identities and detail parsing adjustments together                                      |
| Clicking Start generates kind `start-plan` and saves family selections                                                   | `resolveConnectionSelectionForNavItem` / `persistProviderFamilyModeForNavItem` in `packages/ui/src/settings/ModelProviderSection.tsx` | Page browsing currently has execution connection side effects                                                                 |
| Disconnect handlers calling OAuth logouts                                                                                | Same file `handleCodingPlanDisconnect`                                                                                                | Start de-connection needs deleting corresponding actions, not merely replacing copy                                           |
| Login initialization still selecting Start, restart paths protecting old Start selections                                | `packages/ui/src/root/oauthProviderFamilySelectionRefresh.ts`, `packages/ui/src/lib/modelProviderFamilyConnectionSelection.ts`        | Initializations and old record processing must be planned together                                                            |
| Root-layer loss observers only finding first current, Toasts storing only one notice                                     | `accountConnectionRefreshObserver.ts`, `useAccountConnectionLossNotification.ts`                                                      | Parallel statuses might miss notifications or overwrite each other; whether reusing current needs including these consumers   |

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

- `createNodeModelSelectionFacade` simultaneously used by services' providerRuntime and CLI protocol entrypoints.
- Account Sources re-checking accounts/settings before publishing, rejecting late results on changes; `resetPrevious` isolating old accounts' LKGs.
- Each execution Environment using its own Registry; Host/Worker account fact synchronizations cannot change to whole-Registry synchronizations.
- Settings page browsing owners are UIs; paid connection persistences owners are SettingServices; model original intentions keeping each entry's original owners.
- `connectionKey` currently containing selections; if Start no longer depends on paid connections, should evaluate removing this identity dependency.

## 3. Differences From Old Materials

| Materials                                                                | Current Descriptions/States                                                                                                                    | This-Round Processing                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Todo101](../steps/todo-101-concurrent-account-providers-draft.md)       | Drafts of multiple specific Account Providers existing in parallel, explicitly deferred                                                        | Users only requesting independent Start this round; not restoring multi-Team/dynamic instances/drawer schemes               |
| [Todo93](../steps/todo-93-account-plan-loss-manual-switch.md)            | Failures only prompting once, users clicking to switch                                                                                         | Retaining no implicit switch targets; independent Start buttons' side effects need re-convergence                           |
| `docs/testing/model-provider-restart-connection-e2e-cases.md` I27/MP-R03 | Matrices writing Start→Team; actual tests injecting Recent then asserting Configured Defaults                                                  | Matrices and code drifts; cannot prove normal Sessions long-residing old Starts, cannot demanding full migrations from this |
| `docs/testing/start-plan-manual-claim-e2e-coverage.md`                   | Still retaining early automatic switching histories and subsequent decisions                                                                   | Updated acceptance per final targets during implementations, currently not rewriting histories as new facts                 |
| feature graph's plan-entitlements                                        | `resolveLatestModelProviderFamilyConnectionSelection` seeds not existing in current files; retaining old Start automatic rollback descriptions | Recording drifts, converging when phases stabilize, not rewriting graphs this round                                         |

## 4. Correction On Write-Back Chains And Non-Migration Judgments

| Entries            | Current Code Facts                                                                                                                                                                               | Evidence                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain Sessions     | `applySubmissionExecutionState` calling `setSessionModelSelection` and `persistRuntimeModelSelection` when plain submissions truly begin executing; execution scopes' temporary model exclusions | `apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts:40`, `turn.ts:284`                                                                         |
| Compositions       | `useDraftConfigControl` deriving effectiveSelection; `captureAcceptedModelSelection` writing back in accepted callbacks, retaining original scopes/user re-selection protections                 | `packages/ui/src/v4/composer/useDraftConfigControl.ts:172`, `:242`, `SessionPane.tsx:1493`                                                                 |
| Automations        | First dispatches resolving long selections through target Hosts, writing results into runs; long automation.model_selections not updated by these resolutions                                    | `packages/desktop/src/host/automationModelSelection.ts:5`, `host/index.ts:869`, `packages/services/src/session/automationRepo.ts`'s `fixRunModelSelection` |
| Bots               | Draft first-launch parsing creating sessions; after binding reading Session selections submitting, going through Session write-back paths                                                        | `packages/services/src/bots/botsService.ts:4878`, `:4994`                                                                                                  |
| Wikis              | New generations parsed once, RepoWikiDraftSummarys saving `modelConfig.modelSelection`; failure pages supplementing fixed existing generation identities                                         | `packages/services/src/repo-wiki/repoWikiModelClient.ts:98`, `repoWikiService.ts:369`                                                                      |
| Explicit Subagents | Profile selections cloned and parsed for this execution, not modifying profiles; inheritances using parent models                                                                                | `apps/zcode-cli/packages/core/src/runtime/helpers/subagent-selection.ts:15`, `runtime/methods/subagent.ts:100`                                             |

Read-only effective-selection functions not writing original inputs, cannot deduce entire submission chains not writing back. Previously deducing full Session/draft migrations, upgrading connection snapshots, per-storage semantic versions from this was assistant's insufficient investigations, already withdrawn after users pointed out write-back facts.

I27/MP-R03's actual evidence: `packages/desktop/test/e2e/helpers/model-provider-restart.ts:133` injecting selections into localStorage Recent; `conversation-session-model-provider-restart-recovery.test.ts:134` asserting recovering to DeepSeek Configured Defaults. Not injecting Session's runtime/model_selections, not proving actual users' existing residual proportions.

Current formats already saving complete Provider IDs for both Start plans. No format-layer evidence requiring new data migrations; users confirming retaining original selections interpreting by new rules. Long configs still possibly saving Starts, pasts depending on paid mappings; under new rules using Start, no-entitlement needs re-selection. This is confirmed product boundaries, not "all configs already automatically corrected" facts.

## 5. New Recommended Submission Entry Investigations

| Entries                            | Current Submission Facts                                                                                             | Recommendation-Related Boundaries                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Conversations                      | SessionPane's `createSubmissionFromComposer`/`dispatchSendText` forming new submissions, writing back after accepted | Buttons, shortcuts, attachments, new queues/guidance submissions needing shared checks; cannot submit first then recommend |
| Scheduled Task forms               | `AutomationEditView.submitAutomation` calling onSubmit after validations, saving and running both reuse it           | Can prompt once before creating/modifying model saving                                                                     |
| Scheduled Task immediate running   | Management stores only calling `runAutomationNow` by automationId, no current selection parameters                   | Users ultimately excluding this entry, not expanding protocols                                                             |
| Wikis                              | RepoWikiPane.generate forming new requests; `regenerateFailedPages` another fixed-generation-identity path           | Manual new generations included, supplementing failure pages and automatic refresh exclusions                              |
| Custom Subagents                   | `SubagentForm.handleSubmit` validating then onSave                                                                   | Creating/modifying explicit model saving connectable; other field modifications not prompting                              |
| Built-in/Plugin Subagents          | Sharing SubagentModelOverrideControl, `handleValueChange` → `persistConfig` saving immediately                       | Model selections equal submissions; only calling thinking intensities, inheritances/defaults, or enable/disable exclusions |
| Bots/background execution/Off-Peak | Each submission and execution semantics already independent owners                                                   | Users excluding recommendations, not changing current execution paths                                                      |

Concrete source code: `packages/ui/src/v4/SessionPane.tsx`, `settings/AutomationEditView.tsx:1769`, `store/automationManagementStore.ts:424`, `repo-wiki/RepoWikiPane.tsx:795`, `settings/SubagentsSection.tsx:588`.

Balance sources already have `UsageEntitlementSnapshot` and `startPlanQuotaBuckets.ts`: matching models to multiple effective buckets, unknowns not treated as 0 or positive balances. Current `useV4SessionQuotaBanner`'s query enabled depend on selected Start, therefore cannot directly treating this hook as paid model recommendation data sources without adjusting read conditions. Registry executability and entitlement=true also not separately proving existing usable balances.

Graph's model-selection nodes describing multiple entries sharing effective selection reads, but without this round's new submission recommendations and persistence preference edges; new edges temporarily serving as graph deltas to be extracted after phases stabilize, not rewriting graphs in this read-only investigation. Global observers currently finding first current facts still hold; final plan selections only observing paid connections, not adopting multiple global notification candidate implementations.

## 6. Verification And Restrictions

2026-09-16 running checks for verifying existing behaviors:

```sh
pnpm exec vitest run packages/desktop/test/automationModelSelection.test.ts packages/provider/test/facades.test.ts
```

Results: 2 files, 17 items passed. Automation tests explicitly verifying effective selections can change Providers, but original configurations' providerIds unchanged; Facade tests verifying parsing results not writing original inputs. These combined with Sessions/Compositions write-backs form cross-entry evidences, cannot substitute each other.

- No callable codegraph, verified through exact searches, imports, and critical caller reading, not claiming exhaustively all dynamic paths or real user data.
- No implementing new behaviors, not executing new-function E2E, real account requests, or online data audits; not modifying real credentials and task data.
- First round environments missing typescript, subsequent mis-starting implementation preparations depended on installations failing at cpu-features/node-pty local compilation stages; thereafter pure unit tests already running, architecture:check --changed once passed. Old "all tools still missing dependencies" expressions already expired, implementing by actual environments executing necessary checks.
- Two test drafts written from misunderstanding user expressions already deleted, no retaining business implementations or test changes, not treating them as delivered cases.
- Non-migration currently supported by both current format facts and users' final rules; not guaranteeing all dependencies on old mappings' long-config execution effects unchanged, not adding automatic correction logic from this.

Current targets and acceptances maintained by [Todo154](../steps/todo-154-start-plan-independent-provider.md), researches not establishing separate pending-implementations.
