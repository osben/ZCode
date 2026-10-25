# Todo 64 Implementation Report: Provider E2E Real-Run Repair

> Status: done
>
> Start date: 2026-09-02

## 1. Baseline

- Start SHA: `64d48f6eee`; independent local worktree; MacBook Pro run directory `/private/tmp/zcode-todo64-run.SWhC6y`.
- Initial evidence: of 55 Cases with local environment conditions, 43 passed and 12 failed; Remote SSH (1) blocked by environment.
- Final evidence: the affected list has 52 Cases, 51 pass; Remote SSH 1 skipped for environment. The count difference comes from test splits, merges and removed old Cases.

Plan and ruling boundaries: `todo-64-provider-e2e-real-run-repair-closeout.md`.

## 2. Per-Case record

| Case               | Earliest failure point                                                                                                      | Root cause class    | Fix                                                                                         | Group result                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| MP-UI-01           | test mistook the name-edit button for detail identity                                                                       | test                | assert the selected Provider navigation identity                                            | Settings UI 7 pass, 1 env skip |
| MP-UI-06           | old assertion treated placeholder as value                                                                                  | test                | empty Overlay asserts empty value; explicit `{}` asserts canonical value                    | Settings UI                    |
| I08                | Helper read `maxOutputTokens.default`; GUI saves formal `.max`                                                              | helper              | fix Personal Rule readiness Helper                                                          | spec pass                      |
| Repo Wiki settings | Case carried an out-of-scope no-Provider assertion                                                                          | test                | delete the E2E assertion; empty Ready View stays unit-covered                               | Repo Wiki spec pass            |
| Repo Wiki produces | new model selection kept identity only, lost reasoning                                                                      | production          | call `completeNewModelSelection()` for a complete Selection                                 | Repo Wiki spec pass            |
| OTB08-OTB10        | old expectation double-deducted the assistant already covered by the usage anchor                                           | fixture/test        | cap corrected to 41,671; replay Fixture and docs synced                                     | Preflight spec pass            |
| I20                | shared Helper asserted removed `budget_tokens`; cold start did not persist the initial complete Selection as a stable event | helper/production   | drop the old assertion; persist the initial complete Selection right after Session creation | I20 spec pass                  |
| I26                | Seed lacked complete reasoning/readiness prerequisites                                                                      | fixture/helper      | complete Selection seed and wait for Registry readiness                                     | Restart Recovery 4/4           |
| I27 / I28          | old expectation relied on removed Account-first; Configured Default route lacked replay                                     | fixture/test        | assert fallback to valid Configured Default; add DeepSeek replay                            | Restart Recovery 4/4           |
| I31                | re-selecting the current native option does not guarantee an event; consumer-less transition state                          | test/residual state | settings round-trip hold; delete residual state and fake reconciliation                     | Settings Transition 3/3        |
| QR-E2E-09          | initial failure not reproducible; passes isolated and in whole spec                                                         | isolation           | no production semantic change                                                               | Coding Plan/Quota 18/18        |

The only newly found production bug: cold-start Session did not persist the initial complete Selection (fixed with a failing unit test). No remaining failure needs a product ruling.

## 3. Phase reviews

- A (shared infra): Helpers use current fields and complete Selections; no E2E-only Registry, legacy Account API seed or fixed-model-name inference. Config propagation uses bounded state waits; Template creation keeps the ruled 2-second polling tail.
- B (Selection Cases): Repo Wiki, I26-I28, I31 follow the current Selection design; no Account-first branch in the Renderer; a valid Configured Default is still resolved solely by Host `preferredSelection`.
- C (undiagnosed): MP-UI-01/I08, OTB08-10 and QR-E2E-09 each got reproducible evidence or an isolation conclusion.

## 4. Final review

- Provider/Selection abstraction: Active Model freeze and Host `preferredSelection` as sole fallback kept; no Account-first or model-ID special cases.
- Removed legacy: the forced `budget_tokens` assertion, consumer-less transition state and old-field Helper.
- Tests: Core `runtime-persistence.test.ts` 65/65; Bootstrap `transcript-hydration.test.ts` 61/61; Desktop E2E typecheck pass; Desktop E2E affected list 51 pass; root `typecheck` pass; `lint` pass (35 existing warnings, no errors); full Unit 1533 files pass, 1 skipped, 13089 tests pass, 25 skipped; case-local Fixtures for Output Token Preflight, Restart Recovery, I08, I20 pass formal checks (Settings UI is outside the conversation fixture checker scope); changed-file format and `git diff --check` pass.
- Blocked by existing baselines, not hidden: Conversation coverage audit (existing Hooks lifecycle fixture ledger order and stale generated docs, no overlap with changed files); repo-wide `fmt:check` (vendor/electron docs with invalid HTML and binary `gb2312.js`).
- Remote SSH: 1 Case skipped for missing target credentials; rerun needs a real SSH E2E environment; not counted as product pass. It remains an environment coverage gap. No open Provider product-semantics items.

## 5. Run recipe

```bash
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
export ZCODE_E2E_SKIP_BUILD=1
pnpm --filter @zcode/desktop test:e2e:serial -- --spec <spec>
```

Per-spec artifacts (`.e2e-artifacts/desktop-e2e-<timestamp>/summary.md`, relative to the MacBook Pro run directory) existed for: I20, Restart Recovery, Settings UI, Repo Wiki, Output Token Preflight, Settings Transition, Coding Plan/Quota, I08, Bot Automation, Feishu Interactions, Feishu Streaming, Upgrade WebView, Context Cold Resume, Output Token Budget, Turbo Recovery, Turbo Switch. Full history: `git show 45f808f7:docs/working-memory/provider-refactor/steps/todo-64-provider-e2e-real-run-repair-closeout-implementation-report.md`.
