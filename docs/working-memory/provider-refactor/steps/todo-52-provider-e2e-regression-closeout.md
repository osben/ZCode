# Todo 52: Provider E2E Regression Consolidated Closeout

> Current status (2026-09-09): this verification Todo is closed; remaining items are owned solely by
> [Todo102](todo-102-verification-debt-closeout.md) and are not scheduled independently. The statuses and failures
> below are historical records; closing does not mean the original failures passed.

> Status: Completed
>
> Date: 2026-08-31
>
> Evidence source: [`../research/e2e-regression-analysis-2026-08-31.md`](../research/e2e-regression-analysis-2026-08-31.md)

## 1. Goal

The 37 Desktop E2E cases broken by Provider Refactor are not 37 independent product problems; this Todo handles
their test-infrastructure drift, outdated product behavior and a few boundaries pending decision together rather than
patching case by case. This round once deleted part of the still-current Family behavior coverage on the assumption
that Providers would be flattened; later decisions made clear that the Z.ai / BigModel Family, structured Connection
Selection and in-Family connection switching stay, so the final boundary is:

```text
Current Family / Connection Selection behavior -> restore coverage by the current structured selection
Old mode / selectedKey unreleased compat behavior -> keep deleting, no compat restored
Account, model, request and recovery behavior -> repair by independent Provider identity
```

Restoring Family cases adds no compat layer and does not translate old `mode/selectedKey` into a transitional
structure; all cases use the current `providerFamilyConnectionSelections`, the formal account mock and the current
Resolver.

## 2. Common root causes

| Root cause                                                         | Affected                                  | Direction                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Account scenarios disguised as Personal API-key Providers          | CTP, QR, CPUW, Restart, Transition, Turbo | Prepare only account API, Credential and product facts; the formal Resolver generates formal Account Providers |
| Tests still write old Family mode/selectedKey                      | Migration                                 | Delete the old format compat, do not restore                                     |
| Current Family connection selection lacks coverage                 | CTP, Restart, Transition, Off-Peak        | Restore formal behavior proof with structured `providerFamilyConnectionSelections` |
| CW/OTB/I08 wait for a deleted Workspace Registry push log          | CW, OTB, I08                              | Cold start is proven by real requests; Personal hot update waits a uniform 2s    |
| Bot harness returns an empty Model Selection View                  | 4 Bot E2E                                 | Share a minimal non-empty Selection fixture                                      |
| Subagent E2E still reads/writes the old double map                 | I20 and neighboring Settings E2E          | Delete the compat reader, use the current structured selection                   |
| Upgrade WebView helper uses the visible page origin as the mock control plane | CPUW-01/03                     | Use an explicit mock control URL and observe the formal account refresh result   |

## 3. Formal E2E input chain

```text
E2E scenario input: Built-in Config (real file); Personal Provider Overlay (user config only);
  Account API / Credential Mock (account and plan facts); Persisted Model Selection (cold-start cases only)
  -> formal Resolver / Registry -> Model Selection View -> UI action / formal Model request
  -> request, recovery, card and product state assertions
```

E2E must not construct Effective Provider, Registry Snapshots, Account Personal API keys or test-only executable
state directly.

## 4. Shared test infrastructure

- **Personal Provider fixture.** Reuse and narrow `seedPersonalProviderConfig(...)`, `seedReplayProvider(...)` and
  `createAndConfigurePersonalProvider(...)`: create Personal Providers, write Personal Overlay for normal Built-in
  Providers, save API key / Endpoint / Schema / Personal model members, order and rules, reusing the existing Personal
  Config Repository/codec (no copied file format). Formal repair cases no longer fake Account Providers with them;
  historical manual-review pending cases are not formal coverage this round and will migrate when their product
  behavior is promoted or Family flattened, never a reason to restore old compat.
- **Account scenario fixture.** No overarching `seedAccountScenario(...)` is built: the existing Coding Plan mock is
  already the account upstream scenario orchestrator, supplied by `coding-plan-mock-env.ts`, `wdio.conf.ts` and the
  test Credential Store (not by injecting Account Config). It controls account, plan, quota, activity and reset
  opportunity mocks, writes the formal test Credential Store, provides Start Plan allowed models, Individual/Team
  entitlement and org/project info, and the formal Account Resolver generates the Account Providers. It writes no
  Family Selection, no Account Provider into Personal Config and does not control the Registry.
- **`seedPersistedModelSelection(...)`.** Only for cold-start / restart-recovery cases; atomically saves
  `{ providerId, modelId, options: { reasoningLevel } }`. The separate `seedLastSelectedModel()` /
  `seedLastSelectedThoughtLevel()` are retired to avoid torn selections.
- **`waitForSelectableModel(...)`.** Waits through the formal Selection View for `providerId/modelId` to be
  selectable; it neither queries nor injects Registry intermediate state, and Settings cards do not stand in for
  executable facts.
- **`waitForProviderConfigPolling()`.** A running Agent consuming a Personal Config change has a time lag:
  `const PROVIDER_CONFIG_POLLING_SETTLE_MS = 2_000;` (production polls about 1s; if CI proves 2s occasionally
  insufficient raise it to 3s in this one place only). Used only for Personal Config hot updates, not for cold start,
  explicit Account refresh or flows with a formal completion signal; the wait itself is never the pass condition (real
  request, model selection or product assertion proves).
- **Bot minimal Selection fixture.** Bot service harness and standalone streaming-card harness share one minimal,
  non-empty, valid Model Selection View; it only lets Bot enter formal model execution, introduces no full Account
  environment and does not change card/terminal assertions.

## 5. Delete the unreleased Subagent compat

On August 25 `builtInModelOverrides` and `builtInThoughtLevelOverrides` were merged into
`builtInModelSelectionOverrides` while a legacy `agents-state.json` reader stayed. That format never shipped, so this
round carries no compat migration: `readAgentStateFile()` reads only `builtInModelSelectionOverrides`;
`normalizeBuiltInSelectionOverrides()` drops the legacy model/thought parameters (shrinking to the current structure
parser if needed); the legacy reader unit test is deleted; I20, Settings Subagent E2E and `wdio.conf.ts` fixtures
write and assert only the current structure; `rg` shows the old double map is zero in production code, unit tests and
E2E. I20 itself stays: it proves that after Settings saves a selection, the cold-start child request uses the
complete Provider/Model/Reasoning Selection.

## 6. Case disposition

### 6.1 Keep deleting: 3 old-format compat cases

These verify only the unreleased old `mode/selectedKey` storage migration, not current Family product behavior; the
old format compat is not restored to restore Family.

| Original # | Case       | Reason                                          |
| ---------: | ---------- | ----------------------------------------------- |
|         27 | I32/MP-M01 | Old mode/selectedKey migration                  |
|         28 | I33/MP-M02 | Team Plan selectedKey identity migration        |
|         29 | I34/MP-M03 | selectedKey repair with missing organization    |

The whole file `conversation-session-model-provider-selected-key-migration.test.ts` can be deleted. Family settings
switching, current connection recovery and fallback remain formal product behavior and use the current structured
selection to restore the original case or build equivalent coverage.

### 6.2 Explicit repair: 24 cases

| Original # | Case group                         | Handling                                                                                                                                                   |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-4        | Bot                                | Use the shared minimal Selection fixture, keep the original card, terminal, AskUserQuestion assertions                                                    |
| 5-17       | CTP/QR                             | Use the formal Account Scenario; restore Family connection menu, personal/team switching and OAuth recovery; keep activity, quota, Context, reset opportunity and Composer reminder assertions |
| 20         | I20 Subagent                       | Delete old double-map compat, use structured selection, keep the cold-start child request                                                                  |
| 21         | CW01-CW04                          | Delete the old Registry log parser; after startup prove by limits, Compact and cold-recovery requests                                                      |
| 22         | OTB                                | Delete revision log comparison; after Personal hot update wait a uniform 2s, keep budget/request assertions                                                |
| 23         | I08                                | Delete the old revision barrier; after the model appears wait 2s and assert the first Provider identity                                                    |
| 24         | I26/MP-R02                         | Use the formal Account Provider and atomic persisted selection, keep non-first-model recovery                                                              |
| 25-26      | I27/MP-R03, I28/MP-R04             | Restore current connection fallback semantics with structured Family selection                                                                             |
| 30-32      | I29/MP-S01, I30/MP-S02, I31/MP-S03 | Restore connection switching, draft retention and Plan reconciliation with structured Family selection                                                     |
| 33-37      | Turbo                              | Use the formal Account Provider and atomic selection, keep two-state reasoning, switching, late response and request assertions                            |

Model IDs may appear in tests as real Built-in Config fixture facts; production code must not restore branching on
specific model IDs.

### 6.3 Fixed: 2 Upgrade WebView cases

CPUW-01/CPUW-03 stay; the user-visible behavior after purchase is: purchase complete -> close WebView + refresh
Account data (refresh the current account Provider; the Z.ai scenario also refreshes Team Plan products; no longer
read or assert the Account Provider's Personal API key / old `enabled` state). Technical fixes: the mock control
plane uses an explicit `ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL`; no Account Provider API key from Personal Config;
no assertion on old `enabled`, Family current selection or private credentials; the refresh request is the formal
result of the WebView completion event; model selection changes are not defined by the purchase dialog test.

## 7. Acceptance

Mechanical: `rg` shows these at zero in production code and related E2E — `modelProviderFamilyModes`;
`modelProviderFamilySelectedKeys` (the old compat dependencies; the current `providerFamilyConnectionSelections` is
formal product state and stays); `builtInModelOverrides`; `builtInThoughtLevelOverrides`;
`seedReplayProvider(account:*)` in formal cases repaired/promoted this round; `workspace_update_provider_registry.completed`;
Account Provider Personal API key fixtures.

Behavior: Account E2E prepares only upstream account facts and the formal Resolver generates Account Providers; the
Bot harness enters real model execution with original lifecycle assertions restored; Subagent persists only a
complete structured selection; Personal hot update shares one 2s settle helper; cold start and Account refresh do not
depend on a fixed sleep; kept cases run their original business assertions (not just fixture-prep success); deleted
cases leave the catalog, coverage matrix, Docker preset and fixture manifest together.

Verification commands: affected-case fixture check; native Desktop E2E and case-local replay as needed;
`pnpm audit:conversation-session-coverage` after deleting/modifying formal cases;
`pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint`, changed-file format check and `git diff
--check`.

## 8. Outcome and evidence

- Todo 53 merged into this Todo; no second Registry polling plan.
- 11 originally failing E2E cases that lost their product object were deleted, plus 1 same-kind pending Off-Peak Team
  Plan case; 24 valid E2E cases use the formal input chain with original business assertions restored; 2 Upgrade E2E
  cases follow "close WebView + formal account data refresh". (Plan step order also listed restoring the Off-Peak Team
  Plan pending case with current structured Family Selection; the result line records it as deleted — see report.)
- E2E helpers do not copy Effective Provider/Registry Snapshots and add no Family Selection compat; the unreleased
  Subagent double-map reader and its test input are zero; Turbo cases distinguish the Composer's next-submission
  intent from the recent selection persisted after an accepted submission; leftover unit contracts for deleted
  fixture/catalog mocks were removed.

> 2026-09-01: Todo 57 re-ran this Todo's retained Provider cases on a MacBook Pro and fixed drift exposed after
> Todo 55/56 (Account Draft Selection, Provider Template Fixture, OpenAI `max_completion_tokens`). The latest
> case-level artifacts and environment blockers are in Todo 57 section 9; the 2026-08-31 results below are kept as
> the first closeout trail.

macOS native Desktop E2E: Bot automation / Feishu lifecycle 5/5; Coding Plan Team / quota reset 15/15
(`desktop-e2e-20260831-171119-096`); Built-in Subagent model selection 1/1 (`desktop-e2e-20260831-173054-696`);
Provider restart recovery 2/2 (`desktop-e2e-20260831-174125-075`); Turbo recovery 3/3
(`desktop-e2e-20260831-175604-388`); Turbo switch 3/3 (`desktop-e2e-20260831-180819-116`); Upgrade WebView refresh
2/2 (`desktop-e2e-20260831-180913-613`); Custom Provider add/send 1/1 (`desktop-e2e-20260831-152917-333`).

Repo checks: `pnpm typecheck` passed; `pnpm lint` passed (pre-existing warnings); `pnpm --filter @zcode/desktop
typecheck:e2e` passed; changed files `oxfmt` passed (repo-wide `pnpm fmt:check` blocked by Electron doc sample HTML
syntax and `gb2312.js` read problems); `pnpm audit:conversation-session-coverage`: generated docs, manifest and
fixtures consistent, still blocked by the independent `conversation-session-hooks-lifecycle` request ledger
order/metadata baseline issue; `pnpm test:unit`: the first rerun found and cleared 8 leftover old fixture/catalog mock
contract residues; final 1492 Test Files, 12745 Tests passed, 1 file and 25 tests skipped per existing config.
