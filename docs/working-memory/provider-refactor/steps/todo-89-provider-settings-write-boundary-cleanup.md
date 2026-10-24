# Todo 89: Provider Settings Write Rules and Edit Draft Cleanup

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: development and this round's verification done, 2026-09-08. Mobile-remote/SSH real runs and manual promotion of the new pending case are not counted as passed (see §8).
>
> Review baseline: `483e51c8459646f07236cbb7181c8d0d151c5430`, `provider-refactor-e2e-recovery`.
>
> User request: not only fix "adding a model to an Account Provider fails" but clean up the whole confusing save-rule area.

## 1. Goal and scope

Add, edit, enable/disable, rename, delete and sort follow one consistent member-ownership and write rule; results must not depend on whether the user dragged a model first. This carries over gaps from Todo 88 R08/R10 and does not redo migration, account entitlement, Selection resolution or request execution. The `provider_config.json` structure is unchanged: no data migration, no user config deletion. Layers: settings display, draft, validation, commit and Personal persistence. References: [Provider settings page](../design/registry/settings.md), [model membership and enablement](../design/registry/model-membership-and-enablement.md), [Todo 88](todo-88-provider-audit-regression-repair.md).

## 2. Confirmed problems

| ID  | Problem                                                                                                                           | Evidence                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| W01 | With no Personal Provider record, the first model add to an Account Provider fails; it works only after a drag creates the record | `config-service.ts` in-memory reproduction; edit/enable already write model config separately but do not fix the add                              |
| W02 | Adding a model regenerates order from the member list and drops the existing order (`[B,A]` + C becomes `[A,B,C]`)                | reproduced on Account and custom Providers                                                                                                        |
| W03 | A background View update creates a new model object that overwrites the open model edit draft                                     | DOM: typing 123456 returns to 200000 on an equivalent-object refresh                                                                              |
| W04 | With some model attributes missing, the whole row's edit/toggle/delete entries disappear                                          | DOM: after contextWindow is missing only the name and error remain                                                                                |
| W05 | The custom Provider form rebuilds `api` and drops static headers; an unedited form may be judged as needing save                  | form conversion and config service reproduction; no users in current built-in config or checked Air config, so real-account impact is not claimed |

## 3. Layering and single source of truth

```text
Built-in / Template / Account facts + Personal config -> Host consistent config snapshot
   -> Settings View (display, edit draft) | member and source context (validates this write)
   -> user submits operation -> Provider Config Service (atomic Personal update) -> refresh snapshot -> return result
```

- A Provider existing does not mean its Personal record exists; no user override and no Personal record is a legal, normal state.
- `providers[providerId]` holds Provider-level personal config, including personally added members `modelIds` and order `modelOrder`. `modelConfigRules` holds a model's personal config; editing a model must not create a purposeless Provider record.
- Member existence and source come from the resolved config snapshot, not only the executable Registry and never the static list at write time. An empty Account dynamic member list is also an explicit fact and is not filled back from the static list.
- Config Service receives only trusted read-only member facts from the Facade; it queries no account network and depends on no concrete Runtime; the Renderer submits no forgeable membership claims.
- Reuse the existing `ProviderModelMembership`, per-Provider write queue and repository atomic update; no second member resolver or save queue.

## 4. Write rules

Config Service centralizes Provider existence, Personal record acquisition and the decision of when a sparse override may be created. For a legitimately existing built-in/Account Provider with no Personal record, add or sort may create a sparse override on demand and never copy the whole Effective Config nor turn Account dynamic members, credentials or connection info into personal config. A deleted custom/template-instance Personal Provider fails for late operations (not resurrected). Member snapshot and Personal revision checks stay at the actual commit boundary, not only at click time.

| Operation             | Atomically changes                                                                                         | Must not                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| add personal model    | personal modelIds, current order with the new member appended, the model's initial config and enabled=true | require a prior sort; reset the old order; copy account members          |
| edit existing model   | that model's personal config and follow mode                                                               | rewrite the member list or other models' config                          |
| enable/disable        | that model's enabled leaf                                                                                  | send back a whole old config overwriting other edits; change follow mode |
| drag sort             | modelOrder                                                                                                 | write inherited members as personal; change enabled                      |
| rename personal model | personal member ID, order references, identity of the same model's config                                  | rename an inherited member; lose mode or other config                    |
| delete personal model | personal member, order references, matching config                                                         | delete an inherited member or other models' config                       |
| edit Provider field   | only the explicitly changed field                                                                          | clear form-unmanaged headers; materialize inherited values               |

Reuse existing domain operations and extract only truly shared rules (no generic CRUD framework or arbitrary JSON Patch). Enable/disable uses a narrow semantic operation updating enabled on the latest config inside the transaction (not borrowing the full model dialog save); old and new ways must not coexist with different behavior. Sorting reuses `owned-order.ts`: new unsorted inherited members first, the user's existing valid order kept, unsorted personal members after; relative order of existing members is unchanged by an add and the new personal member is appended. The Provider form takes the Personal Draft as commit base keeping untouched fields (`api` is not rebuilt from the UI's type/baseURL alone and never falls back to the whole Effective Config); no edit means no save.

## 5. Draft and error recovery

```text
open model dialog -> capture that model's draft + baseline revision
  external View refresh: updates list facts, never overwrites the open draft
  user edits: change only the draft
  save: success ends the edit | validation/version conflict keeps the draft and explains
```

- The dialog manages the edit lifecycle by open/close and model identity, not by the model object reference changing.
- Save keeps the existing revision check; a stale draft never silently overwrites newer config and is not auto-reset or merged (the user reloads explicitly; no per-field auto-merge this round).
- Provider inline auto-save and the model dialog's explicit save stay separate boundaries; the follow-recommended switch only changes the dialog draft.
- Incomplete config is still editable: the model row and a suitable repair control stay, missing inputs show as empty, and saving works after repair.
- Inherited models still cannot change ID or be deleted; an incomplete personal model can be deleted; enabling an incomplete model does not bypass Registry validation into the executable set.
- A failure keeps user input; an atomic failure leaves no half member/order/model config; the optimistic list ends consistent with the Host result.

## 6. Impact

| Entry                          | Shared implementation                                                      | Focus                                                                               |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Provider field form            | `ProviderDraftSave.ts`, `providerPersonalSave.ts`; the card owns the draft | partial-field save without losing untouched config                                  |
| model add/edit/enable          | `InlineEditableProviderCard.tsx`, `ProviderFormControls.tsx`               | narrow operations, edit lifecycle, keep on failure                                  |
| model rows and drag            | `ProviderCardSections.tsx`, existing optimistic-sort hook                  | repairable incomplete models; order not reset by add                                |
| all settings operations        | `packages/provider/src/facades.ts`, `config-service.ts`                    | trusted member facts, serialization, atomic commit                                  |
| inherited config and execution | config resolution, Account snapshot, Registry                              | editable in settings vs executable stay separate                                    |
| downstream selection           | existing Selection View update chain                                       | refresh after save, no change to selection restore or default-level rules           |
| multi-end and remote           | same settings Service on the target Host, common UI                        | do not write the wrong environment; mobile layout usable                            |
| session flow                   | desktop continuous / web replayable                                        | invariant only: no change to Session protocol, queue, reconnect or remote send sync |

Codegraph was unavailable; precise search and call-chain reading traced Facade, Config Service, Personal writes and View return. The old `modelProviderServiceStorage.ts` graph seed was updated to the current `NodePersonalProviderConfigRepository` and Facade/Config Service added; the old Service is not restored from the old graph.

## 7. Regression cases

| Case   | Setup and action                                                                                | Must observe                                                                                 | Evidence                                 |
| ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| W89-01 | Account Provider with no Personal record adds a model directly; also edit/toggle first then add | both orders succeed; only the necessary override created, no account models copied           | config service + Electron                |
| W89-02 | sort to B,A then add C; Account, template instance, custom                                      | B,A,C; save, reopen and restart agree                                                        | config service + Electron                |
| W89-03 | Account returns members outside the static list; edit and sort                                  | saves normally; inherited members still non-deletable/ID-fixed; duplicate add rejected       | Facade + UI                              |
| W89-04 | edit in the open dialog, push an equivalent View and a real external change                     | draft not lost; stale save does not overwrite external change, draft remains after the error | DOM + Electron representative            |
| W89-05 | personal/inherited model with missing attributes                                                | opens for repair; personal deletable, inherited not; unrepaired does not become executable   | DOM + Registry + Electron representative |
| W89-06 | custom Provider with headers: no edit, rename, change Base URL                                  | no edit no save; other edits keep headers; inherited fields not materialized                 | form + config service                    |
| W89-07 | concurrent enable and config edit; pinned/follow models                                         | only own fields change; enabled and mode do not contaminate each other                       | Facade/config service                    |
| W89-08 | stale member snapshot, deleted model/Provider, duplicate add, repository write failure          | clear failure without resurrection or partial write; no fake success                         | service fault tests + DOM                |
| W89-09 | save via the target environment's settings Service, check the other                             | only the target changes; shared UI operable at narrow width                                  | service isolation + multi-end smoke      |

Pruning: personal/Team/Start share one Account member algorithm, no per-brand full combinations (ordinary Account and Start dynamic members as representatives); Off-Peak hidden adds no ordinary settings entry; theme, language and narrow screen use representatives; real entitlement, migration, send sync and Session restore are not this item's E2E targets. E2E follows `e2e-case-lifecycle` (pending, independent fixture, real-operation assertions; catalog/matrix updated first), no real user data; Electron runs on the MacBook Pro, DOM tests do not substitute for a desktop conclusion, and CSS details are not heavily asserted. Concurrency tests cover: full draft saved then toggled keeps both edits; toggle committed first then an old-revision draft rejected; member change during queueing rejected; deleted Provider not resurrected.

## 8. Outcome and review

### Related problems found and fixed during implementation

| ID  | Root cause and fix                                                                                             | Evidence                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W06 | Account/preset detail missed the delete callback (delete changed only the UI); detail operation wiring unified | Pro: add then delete read-from-disk assertion failed; real delete verified after the callback was restored                                                |
| W07 | local member copy overwritten by late save/failed rollback; the add dialog closed before the write finished    | DOM: external add during delayed failure, add failure keeps input; duplicate member state removed                                                         |
| W08 | Start quota refresh temporarily became checking and unmounted the edit area of a confirmed available account   | Pro file refresh reproduced; edit area kept on the Account-confirmed state while the quota card refreshes independently; 200-item plan display tests pass |
| W09 | same-named models of different Providers reused the open draft                                                 | DOM red/green; edit subtree isolated by Provider identity                                                                                                 |
| W10 | Esc close and reopen during an unfinished save let the old save response close the new draft                   | DOM failed then passed; add and edit block close during save, a sync ref prevents duplicate submit                                                        |

### Verification (2026-09-08)

- Local: 27 unit files, 541 tests pass (`packages/provider/test`, `packages/provider-node/test`, `providerRuntime`, `providerFacadeServices`, `modelProviderDraftSave`, `modelProviderModelRowEditor`, `providerSettingsFormBoundary`, `modelProviderCodingPlan`); `pnpm typecheck` and `tsc --noEmit -p packages/desktop/tsconfig.e2e.json` pass; `pnpm lint` 0 errors, 40 existing warnings; graph 336 unique nodes and 672 edges, 4 existing dangling edges same as baseline.
- Electron (MacBook Pro, isolated workspace `/Users/dev/zcode-todo88-pro-e2e`): `desktop-e2e-20260908-062431-556` 12 passed, 1 skipped (no SSH target), 3 spec files (`start-plan-manual-claim-experience.test.ts`, `settings/manual-review/pending/provider-settings-write-recovery.test.ts`, `settings/settings-ui-polish.test.ts`); Start refresh fix alone 4 passed; fixtures isolated, no real user data or credentials; agent build unchanged. The new `provider-settings-write-recovery.test.ts` stays manual-review/pending: passing does not mean manual review or promotion to a formal gate.
- Acceptance map: W89-01/02 ConfigService no-root add, toggle-then-add, sorting + Electron dynamic Account first add and sort-then-add (file and reopen verified, not a restart per Provider); W89-03 Facade dynamic members + Electron edit/sort/delete personal member (inherited gets no ID/delete rights); W89-04 DOM equivalent View/real change, version conflict, cancel-reopen + Electron external file refresh (plus Start quota refresh and cross-Provider same-name models); W89-05 DOM missing attribute repair + Electron repair then edit/toggle/delete (Registry completeness unchanged); W89-06 form no-edit, rename, change address (no real header-dependent account, no extra model request); W89-07/08 Facade concurrency/revision/member invalidation, DOM delayed failure, Electron duplicate-add rejected with no duplicate in the file; W89-09 settings Service waits for target ready and calls only the target Facade, UI polish zh/en, both themes, 390×844. Mobile remote and SSH Host were not run (SSH has no target config; continuous/replayable chains unmodified).

### Review

- No new persistence format, migration or old-field compatibility; nothing copied from Account credentials, dynamic members or whole Effective Config into Personal. Config Service queries no account interface; no new save queue, App–Agent protocol or send barrier.
- W08 once passed with diagnostic logs and failed without them, so that pass was not used to claim the fix; after the rule and tests keeping the edit area under Account-available state, it was rerun without diagnostics.
- A format command scanned the repo because of an empty file list; after per-file `format(HEAD) == current` checks, 3,719 pure-format changes were reverted and 17 originally modified files were preserved by before/after comparison (pre-recovery content in `/tmp/todo89-format-recovery-W789JG`); later formatting only takes explicit non-empty file lists.
- No open product-behavior ruling. Account permission, selection restore, migration and request semantics are not extended.
