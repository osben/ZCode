# Todo 94: Wiki Drops the Manual Max-Output Setting and Uses the Model Limit

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implementation, review, local checks and Pro formal Electron E2E done; 2026-09-08. Mobile/Windows real-device re-verification stays open. Execution evidence: [94-97 execution record](../research/todo94-97-execution-and-review.md).
>
> User confirmed: fully unify on the model Limit; delete the manual max output, the independent Catalog/Page budgets, the halved body budget and the special retry that raises the budget; keep truncation detection and ordinary failure retry.
>
> 2026-09-09 storage ruling: the user asked to keep published old fields for practical rollback; a normal save keeps the old Wiki / Draft `maxOutputTokens` original value, but the new version neither uses nor generates that preference. See [Todo104 §6.18](./todo-104-pre-release-schema-review.md) (m2, formerly Todo99). This item is pending a fix with no code change yet; the original implementation record below does not mean this addition is done.

## 1. Status quo and problem

`RepoWikiPane.tsx` offered an output budget picker (16,384 / 32,768 / 65,536) on the ungenerated card and the existing-Wiki toolbar; `repoWikiStore.ts` stored `maxOutputTokens` and a touched state; shared Generate / RegenerateFailedPages parameters and `generationOptions` also carried it; `repoWikiService.ts` used the selected budget for Catalog and half for Page (auto-refresh and failed-page completion reused the old generation settings); `repoWikiLimits.ts` additionally had Catalog 16,384 / Page 8,192 defaults and a rescue retry that raised the budget after truncation. `repoWikiProviderRegistryModelConfig.ts` already gets `optionSpecs.maxOutputTokens.max` from the target Host's model config, which is the `type: limit` ceiling, not another numeric field named `limit`. Deleting only the control is therefore not enough: old saved values and background defaults would still limit requests.

## 2. Final ruling

| Item                                                           | Ruling                                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| manual output-budget entry                                     | removed; the ungenerated and regenerate entries are consistent, desktop and Web share behavior                               |
| Wiki's own output-budget state                                 | no longer maintained, submitted or saved; touched state, types, constants, copy and unused helpers removed                   |
| actual request ceiling                                         | the target model's currently effective Limit; unified Model validation and Option Map, no hand-written vendor request fields |
| fixed Catalog / Page budgets and halving                       | deleted; catalog and body both use the model Limit directly, with no Wiki-private output budget                              |
| special retry that raises the budget after truncation          | deleted; no budget raising or extra rescue retry (with the full Limit already used there is no higher budget)                |
| output truncation detection                                    | kept; hitting the cap never stores incomplete output as success content                                                      |
| ordinary failure retry, timeout                                | original semantics kept                                                                                                      |
| tool rounds, source character budget, catalog page-count limit | kept (not model max-output settings)                                                                                         |

The ceiling means "at most this much", not "fill it"; a larger ceiling may lengthen a single response, so unchanged time and cost are not promised.

## 3. Single source of truth and old-data boundary

```text
Wiki's resolved ModelSelection + target Host model config -> this request's model Limit
 -> unified Model validation / Option Map -> vendor request
old Wiki / Draft manual maxOutputTokens -- no longer takes part in new requests
```

- Nothing is written into Personal Provider Config for a Wiki preference; user model config and the model's own ceiling are not changed.
- Old Wiki / Draft stay readable; the historical manual budget is ignored and its presence does not fail the whole load. A normal save no longer writes the field; no bulk rewrite of history files and no new data-version migration.
- First generation, regeneration, failed-page completion and end-of-task auto-refresh are all covered; check whether an old Selection could carry the option so a leftover value cannot become an override again from another path.
- No dynamic model switching or forced remote sync during generation; reuse the existing model freeze, target Host and `workspaceIdentity` boundary.
- Confirm first whether the unified request entry already uses the Limit when options are absent and reuse it; no new model default resolution is added just to delete the Wiki setting.

## 4. Impact and order

UI/draft (RepoWikiPane, repoWikiStore: delete control, state, backfill and submission parameters; clean zh/en copy and dedicated test IDs); shared contract / storage (shared/repo-wiki.ts, repoWikiStorage: new requests and records carry no manual budget, old records read and ignore safely); service/request (repoWikiService, ModelClient, Generator, Catalog/Page tool Agent, Limits: collect the override parameters and all generation paths); unchanged: model selection and Reasoning, generation language/diagram/timeout/ordinary retry, workspace isolation, remote attachment and message-flow semantics. Order: update the budget contract in `docs/repo-wiki.md`; write unit tests and interaction E2E before deleting; clean references and update the feature graph if facts changed; review all generation entries for no leftover Wiki-private ceiling; typecheck, lint, related unit tests and MacBook Pro E2E, then commit.

## 5. Acceptance

- [x] Neither the ungenerated card nor the existing-Wiki toolbar shows a max-output picker; other settings and generate actions unchanged.
- [x] Catalog, Page, tool requests, static fallback and compression final all follow the final ruling for actual output ceilings.
- [x] Requests under different model ceilings show no 16K default, no Page halving, no old saved budget leaking in; API request fields are still decided by their own Maps.
- [x] The budget-raising rescue retry and its constants, state and parameters are deleted; truncation triggers no extra budget-upgrade call.
- [x] Old records carrying `maxOutputTokens` can still be viewed, regenerated, completed for failed pages and auto-refreshed; new records no longer persist the preference.
- [x] Truncated model output is still judged incomplete; ordinary failure retry, stop, timeout and page-count/tool resource limits do not regress.
- [ ] Desktop and phone Web layout, both themes and bilingual copy show no leftover entry; remote requests use the target Host's config.
- [x] Implementation commit, verification commands, test results, review conclusion and any open ruling recorded.
