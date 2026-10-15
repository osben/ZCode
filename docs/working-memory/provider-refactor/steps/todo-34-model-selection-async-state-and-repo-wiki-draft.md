# Todo 34: Model Selection Async State and Repo Wiki Draft Consolidation

> Verification ownership update (2026-09-09): Remaining untested/failed/manual-promoted items uniformly transferred to [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules in this document; historical evidence retained, transfer does not represent test passing.

> Subsequent Desktop graphical E2E untested items uniformly consolidated by Todo 78, this Todo no longer scheduled separately.

> Status: Implemented; core automation re-validated, Repo Wiki Desktop WDIO still awaiting current-commit macOS environment real-run
>
> Date: 2026-08-28
>
> Source: Official package Repo Wiki real-device failure and Model Selection Renderer boundary review
>
> Related tasks: [`Todo 13`](./todo-13-target-host-model-selection-authority.md),
> [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md),
> [`Todo 32`](./todo-32-team-plan-settings-effective-provider-boundary.md)

## 1. Runtime Evidence and Direct Failure

MacBook Pro official package opens Repo Wiki, Section Error Boundary shows:

```text
Model selection missing Provider:
```

Official package logs from same time period prove target Host does not lack models:

- `model-selection.getView` completes normally;
- Registry published `account:bigmodel-team-coding-plan / GLM-5.3-Flash`;
- Provider Runtime reports corresponding model ready.

Real sequence:

```text
Repo Wiki first render
        |
        v
useModelSelectionView initial return null
        |
        v
null projected to empty groups, default model becomes ""
        |
        v
resolveRepoWikiThoughtLevelOption parses ""
        |
        v
parseModelPickerValue throws error
        |
        v
Error Boundary unloads Repo Wiki
        |
        `-- getView subsequently succeeds, cannot update already unloaded page
```

Repeatedly clicking Section Retry may still repeat same first-render sequence. Therefore this is not Registry, Account Team Plan, or official config missing models,
but Renderer sending normal async front-state into strict parse boundary accepting only complete Selection.

## 2. Broader Design Issues

### 2.1 `null` Erases Async Lifecycle

Current `useModelSelectionServiceView()` / `useModelSelectionView()` returns
`ModelSelectionView | null`, where `null` simultaneously expresses:

- First read in progress;
- Target Remote Workspace not yet connected;
- Service missing or read disabled;
- `getView()` failed but only logged.

These states have different UI, retry, and submission semantics, cannot continue sharing one empty value. On target Host switching, return state must also bind current Service/
workspace target, avoiding old Host View briefly consumed by new target before Effect cleanup; existing generation guard only prevents late Promise override,
does not make return type prove current View's owner.

Additionally, current `useModelSelectionView(null)` does not express "missing target," but parses by local target and falls back to Base/Current Host. Therefore
Workspace entry point can no longer imply "target existence" through group of nullable scalars; caller must first form explicit Workspace Target, entering unavailable when no target, cannot call Workspace Service Resolution.

### 2.2 `null -> [] -> ""` Continuously Creates Pseudo-Business Facts

`buildRegistryModelSelectGroups()` currently accepts nullable View, and projects un-loaded to empty array. Repo Wiki further projects empty candidates to empty
`modelValue`. Thus the following two facts indistinguishable:

```text
ModelSelectionView not yet obtained
!=
ModelSelectionView obtained and providers truly empty
```

Loading state therefore escapes TypeScript checks, finally entering strict parser at render time.

### 2.3 Repo Wiki Store Saves Control Encoding, Not Domain Selection

Repo Wiki draft currently saves:

```ts
modelValue: string;
modelTouched: boolean;
thoughtLevel?: string;
thoughtLevelTouched: boolean;
```

`provider/model` string is only control encoding for `ModelConfigSelect`, should not be Repo Wiki Draft's model facts. Code therefore repeatedly parses at display,
reasoning projection, and Submission, and allows `""` into product state. Existing Provider Refactor already clearly unified independent model tasks to
reference `ModelSelection`; Repo Wiki should directly save sparse explicit Selection, formatting strings only at Select control boundary.

### 2.4 Renderer Reduplicates Host Fallback

Target Host's same `ModelSelectionView` already atomically contains candidates and `preferredSelection`:

```text
Configured Default still selectable
        |
        +-- yes --> preferredSelection = Configured Default
        `-- no --> first visible Registry candidate with models
```

Configured Default must belong to current View, Provider cannot hidden, Model must exist, and explicit options must valid. Fallback only as
this entry initialization result, does not write back persistent Configured Default.

Repo Wiki currently self-selects `modelGroups[0].items[0]` when no match value, forming second Fallback Policy. Renderer should not duplicate
Host algorithm; especially when user explicit selection already invalid, cannot silently switch to another Provider/Model.

### 2.5 Generate Admission Does Not Depend on Model State

Current `generateDisabled` only considers project, shared settings, and task running status, does not cover Model Selection loading, remote waiting,
read failure, ready-empty, or explicit selection invalid. Silently exits in event handler after clicking, not complete interaction admission.

### 2.6 Adjacent Callers Have Similar Risks

| Caller              | Current behavior or risk                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Repo Wiki           | Initial empty value enters strict parser, page directly crashes                                    |
| Subagent Settings   | Read failure and unavailable may permanently disguise as loading                                   |
| Automation Settings | Degenerates to empty menu during loading; falls back to Base/Current Host when no explicit target  |
| Composer            | Candidates empty during loading, not crashed but cannot express real reason                        |
| Root login entry    | Extra uses `view !== null` to wait for hydration, cannot complete startup judgment on read failure |
| Provider Settings   | Both Snapshot/Service Hooks permanently retain first read failure as loading                       |

Adjacent code also contains old boundaries re-sending persistent model strings to strict parser. They need item-by-item confirmation when migrating callers, but this fault should not generalize to
"all nullable data must change to state machine": read-only display allows missing additional model metadata, what genuinely needs explicit lifecycle state is candidate read Owner,
interaction admission, and Submission boundary.

## 3. Decided Principles

1. Registry, `IModelSelectionService`, and strict `parseModelPickerValue()` not root cause of this fault; must not widen parser accepting empty string,
   nor construct Placeholder Provider/Model for loading state.
2. RPC `getView()` can continue asynchronously returning complete View; loading, unavailable, error, and retry belong to Renderer Service Adapter responsibility.
3. `ModelSelectionView.providers` empty only expresses "read and no candidates," no longer doubles as loading.
4. Model Selection candidates, `preferredSelection`, and revision must from same View of target Host; Remote not connected must not fall back
   to Local/Base Host.
5. `preferredSelection` only participates in Effective Selection parsing for new product Drafts without explicit intent; does not write to Draft's explicit
   `modelSelection`, not current Session Selection, Active Model, recently used model, or forced recommended model.
6. Renderer does not duplicate Configured Default, Registry ordering, or Fallback Policy.
7. Product Draft saves `ModelSelection`, Select's encoding string exists only at control boundary; Submission directly fixes complete
   `ModelSelection`.
8. When user explicit Selection invalid, preserve original intent, display unavailable, and disable submission; do not silently switch to menu first item. Only inherit
   `preferredSelection` when no explicit intent.
9. Error Boundary only handles unexpected render errors; loading, unavailable, ready-empty, and read failure must become normal page states.
10. Created Session/Active Model continues frozen; this Todo only changes candidate read, Draft initialization, and pre-submission admission, not running models.
11. First read failure enters error; background refresh failure after obtaining Ready View retains previous successful View and records warning. Current Service events
    only publish successful View, this round does not expand RPC/Event protocol for displaying background refresh errors.

## 4. Target State Chain

### 4.1 Renderer Service State

Model selection lifecycle Hook returns discriminated union, not nullable View. Specific names unified at implementation, semantics fixed as:

```ts
type ModelSelectionState =
  | { status: "loading" }
  | { status: "ready"; view: ModelSelectionView }
  | {
      status: "unavailable";
      reason: "remote-waiting" | "missing-target";
    }
  | { status: "error"; error: Error };

interface ModelSelectionRead {
  state: ModelSelectionState;
  reload(): void;
}
```

```text
Explicit Host Service ----------------> Service State Hook

Explicit Workspace Target
        |
        +-- not exists ----------------> unavailable/missing-target
        |
        `-- exists
              |
              v
     Workspace Service Resolution
              |
              +-- remote-waiting --> unavailable/remote-waiting
              `-- Host Service ----> Service State Hook
                                           |
                                           v
                                  loading/error/ready(view)
```

Implementation retains two explicit entry points: components already in target `ServiceProvider` directly read Host Service; products needing cross-Workspace read first pass explicit
Workspace Target, then do Workspace Service Resolution. Hook internally handles subscription-first, first read, target key, revision monotonicity, late
result discard, first error, and reload; this Renderer lifecycle type does not enter Provider Config, Registry, or Protocol DTO.

After Service/Target change, if Hook discovers internal state's owner key mismatch in same render, must immediately project loading, not wait for
`useEffect` to clear old View. Background refresh failure continues retaining Last Known Good Ready View.

### 4.2 Ready-Only Projection

`buildRegistryModelSelectGroups()` changed to accept only `ModelSelectionView`. Candidate menus, admission, and Submission callers must first branch
on `ModelSelectionState.status`; candidate projection helper not allowed to fold non-ready state to `[]`. Read-only leaf components if only
missing optional Label/Metadata, can receive upper-layer already-extracted optional Ready View, no need to propagate complete state machine.

### 4.3 Repo Wiki Draft

Repo Wiki generation settings model section changed to domain object:

```ts
modelSelection?: ModelSelection;
```

- `undefined`: no Repo Wiki explicit model override;
- Has value: user explicitly selected Provider, Model, and options for this Wiki;
- First display `preferredSelection` or existing Wiki Selection forms parse result only, does not write back `modelSelection`; only user actually modifies
  model or reasoning writes explicit Selection;
- Model changes clear incompatible reasoning option for old model;
- Reasoning changes directly update Selection's `options.reasoningLevel`;
- `ModelConfigSelect` renders as string, selection event parses once at boundary then writes back to Selection;
- Delete parallel state simulating inheritance, explicit override, and complete Selection using empty string and `modelTouched`/`thoughtLevelTouched`.

### 4.4 Repo Wiki Final Model Parse

Create pure parse entry, inputting target Host Ready View, Repo Wiki Draft, and existing Wiki record, outputting discriminated result:

```text
Repo Wiki explicit Selection
        |
        +-- valid in current View --> ready(explicit)
        `-- invalid -----------> unavailable, no silent fallback

No explicit Selection
        |
        v
Existing Wiki Selection still valid in current View
        |
        +-- yes --> ready(existing)
        `-- no --> Host preferredSelection
                         |
                         +-- exists --> ready(preferred)
                         `-- not exists -> ready-empty / no-model
```

"Valid in current View" must reuse existing `isSelectionInView()` complete semantics, uniformly validating Provider/Model members, reasoning level, and
max output tokens; must not write weaker validation in Repo Wiki only checking Provider/Model existence.

Ready result should simultaneously carry final `ModelSelection`, control groups, and corresponding reasoning option. Display and Generate use same result,
no longer each parse or re-fallback.

### 4.5 Page Behavior

| Model Selection status             | Repo Wiki behavior                                                        |
| ---------------------------------- | ------------------------------------------------------------------------- |
| loading                            | Display model loading state, model control and Generate disabled          |
| remote-waiting                     | Display waiting for target Workspace connection, do not access Local Host |
| error                              | Display read failure and reload, do not disguise as no model              |
| ready + providers empty            | Display currently no available models, Generate disabled                  |
| ready + explicit selection invalid | Display invalid selection and repair entry, Generate disabled             |
| ready + valid Selection            | Normal display reasoning and allow Generate                               |

`generateDisabled` must include final Repo Wiki Model State; event handler still maintains invariant assertions, but does not replace UI admission with silent return.

### 4.6 Adjacent Entry Behavior

When discriminated union migrates to other callers, only consolidates each entry's genuinely used model candidate lifecycle, not changing their respective Draft and submission semantics:

| Entry             | loading / unavailable                                                                                       | error                                                                                    | ready                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Root startup gate | Continue waiting first Model Selection View                                                                 | End silent waiting, display read failure and reload; must not interpret as "no Provider" | Complete startup check by existing Provider availability rules                       |
| Composer          | Preserve current Draft/Session Selection, model control shows loading state and cannot submit new selection | Preserve current Selection, model control shows read failure and reload                  | Display candidates by target Host View, do not change Session/Active Model ownership |
| Automation        | missing-target/remote-waiting displayed in model control, no fallback to Base Host                          | Preserve form Draft, model control shows read failure and reload                         | Read candidates only from selected Workspace Host                                    |
| Subagent Settings | Preserve form Draft, model-related controls show loading state                                              | Preserve form Draft, model-related area shows read failure and reload                    | Continue using Local Environment View                                                |
| Provider Settings | Panel shows loading state, does not treat `null` as empty Provider list                                     | Panel shows read failure and reload                                                      | Display that Environment's Provider Settings View                                    |

Root's error must end current infinite waiting controlled only by `hydrated` boolean, but must not fabricate empty `ModelSelectionView` triggering current "no available Provider"
branch. Provider Settings continues using own domain state, does not reuse `ModelSelectionState` type.

## 5. Implementation Scope

1. Split Model Selection read into explicit Host Service and explicit Workspace Target entry points, adding lifecycle state, owner key,
   first error, and reload;
2. Migrate Root, Composer, Repo Wiki, Automation, and Subagent all callers, no nullable compatibility Hook retained;
3. Tighten Registry Model Groups projection's Ready-only input;
4. Change Repo Wiki Generation Draft model field to `ModelSelection`;
5. Drive model label, reasoning, disabled state, and Submission by single Repo Wiki model parse result;
6. Delete Repo Wiki Renderer's menu first-item fallback, empty-string model facts, and duplicate parse;
7. Consolidate `useProviderSettingsServiceView()` and root-level Provider Settings Snapshot first loading/error/reload state; both can
   reuse internal subscription mechanism, but continue exposing own domain state, not changing Provider Settings/Account Overlay semantics;
8. Audit remaining model string parsers in Subagent, Composer, and Session Catalog when migrating callers: control boundary can retain strings, product
   Draft/Record does not add string facts; historical compatibility unrelated to this lifecycle does not expand modification;
9. Rewrite `docs/repo-wiki.md` model selection and capability source chapters, delete deferred session/prewarm and Service secondary selection obsolete chains,
   unify to Generate Submission explicitly fixing `ModelSelection`;
10. Supplement Renderer async read state in model selection Design and Feature Graph, delete Repo Wiki direct reading old Model Provider Service
    drift description, maintaining `preferredSelection`, Configured Default, App Recent, Session Selection, and Active Model existing
    priority and Owner unchanged.

This Todo does not modify:

- Provider Config Overlay order;
- Account Provider model members or Access;
- Registry integrity/execution admission;
- Configured Default physical storage and Fallback algorithm;
- Repo Wiki model requests, Prompts, retries, timeouts, or generated content;
- Normal session Selection, queue, recovery, and Active Model lifecycle.

## 6. Test Plan

Write failing tests first, then modify production implementation.

### 6.1 Hook and Async State

1. First subscription as loading, enters ready after `getView()` completes;
2. `getView()` failure enters error, reload success enters ready;
3. remote-waiting and missing-target explicitly unavailable, does not call Local Host;
4. Same render switching Host does not expose old Host View;
5. Old Host late Promise/events cannot override new Host;
6. Same Host revision only monotonically advancing, events completing before first read retain newer View;
7. Background refresh failure after ready retains Last Known Good View, subsequent success events can still update;
8. ready-empty distinguishable from loading/error/unavailable.

### 6.2 Repo Wiki Pure State and Components

1. Model View delayed return first render does not throw, after return displays `preferredSelection`;
2. Explicit Repo Wiki Selection valid prioritized over existing Wiki and Host preferred;
3. Explicit Selection invalid preserves original intent and disables Generate, no fallback to first item;
4. No explicit Selection: valid existing Wiki Selection prioritized; falls back to Host preferred when invalid;
5. Host no preferred and no candidates displays no-model;
6. Reasoning option only parsed from final Selection's corresponding Ready View; switching model clears incompatible option;
7. Repo Wiki Store no longer saves empty model string, Submission directly carries complete `ModelSelection`;
8. loading, unavailable, error, ready-empty, and ready each display correct status and button admission;
9. Retry button in normal error state calls real reload; Section Error Boundary no longer handles such expected state.
10. First display of preferred/existing Selection does not write to Draft; when user unmodified, new Host View can update Effective Selection;
11. Explicit/existing Selection reasoning level or max output tokens not accepted by current View judged invalid, does not enter Submission.

### 6.3 Affected Entry Regression

1. Composer first load and Host switching does not clear or cross-use existing Draft/Session Selection;
2. Automation no explicit target does not read Base Host, target ready displays corresponding candidates;
3. Subagent distinguishes loading, unavailable, and error, no permanent spinning;
4. Root login entry only judges Provider availability on Ready View; first read failure ends startup waiting, displays reload, and does not enter "no Provider"
   branch;
5. Remote Workspace disconnect/reconnect does not leak Local Provider;
6. Provider Settings target Service Hook and root-level Snapshot both distinguish first loading/error/ready, can retry after failure;
7. Desktop continuous and Web Remote replayable task/stream behavior unchanged.

UI interaction involved, must add or update Desktop E2E: at minimum covering delayed ModelSelection View then opening Repo Wiki, Remote waiting, and
ready-empty, cannot prove only by helper unit tests. Finally execute directed unit tests, related E2E, `pnpm typecheck`, `pnpm lint`, modified file format check
and `git diff --check`.

## 7. Completion Criteria

- Model candidate read Owner, interaction admission, and Submission boundary no longer express loading/error/unavailable as nullable View, empty candidates, or empty
  string;
- Formal projection helpers like `buildRegistryModelSelectGroups` do not accept nullable View;
- Repo Wiki Domain Store does not save model selection control strings or empty-string sentinels;
- Host preferred/existing Selection only participates in Effective Selection parsing, not falling into explicit Draft when user unmodified;
- Repo Wiki render time does not call strict Selection parser in non-Ready state;
- Renderer no longer implements second Registry first-item fallback;
- Explicitly invalid models or options not silently replaced, Generate only accepts Ready `ModelSelection` validated by existing complete Selection;
- Model Selection target Host, revision, and error status proven by automation;
- Provider Settings first read failure no longer permanently disguises as loading;
- Repo Wiki documentation, model selection Design, Feature Graph, and current mandatory `ModelSelection` protocol consistent;
- All directed tests, interaction E2E, root typecheck, and lint pass;
- Submit Conventional Commit upon completion.

## 8. Implementation Results and Phase Review

### 8.1 Renderer Lifecycle

- `useModelSelectionServiceView()` and Workspace entry changed to `loading / unavailable / error / ready` discriminated union, providing explicit `reload()`; switching Service same render does not expose old View.
- Subscription before first read, revision monotonic; old Host late results discarded by generation, Ready post-read failure retains Last Known Good, subsequent events can still recover update.
- Workspace missing target or in remote-waiting does not read Model Selection Service, no fallback to Base/Local Host.
- `buildRegistryModelSelectGroups()` accepts only complete `ModelSelectionView`, non-Ready branches must be handled by callers first.

Phase review: Hook, owner, revision, reload, Last Known Good, missing-target, and remote-waiting all have direct unit tests; no Protocol DTO, Registry copy, or second model facts added.

### 8.2 Repo Wiki and Adjacent Entries

- Repo Wiki Store only saves sparse explicit `modelSelection?: ModelSelection`; control strings only encoded/parsed at Select boundary.
- `resolveRepoWikiModelState()` uniformly executes explicit > existing > Host preferred; invalid explicit Selection or options preserves original intent and blocks Generate, no fallback to menu first item.
- loading, remote waiting, target missing, error, ready-empty, and invalid-explicit all become normal page states; read failure provides reload, Generate only accepts Ready Selection.
- Root, Composer, Automation, Subagent all migrated to explicit lifecycle; existing Draft/Session Selection not cleared by non-Ready state.
- Provider Settings root snapshot and target Service Hook also distinguish loading/error/ready, supporting first failure retry and Ready snapshot retention.

Phase review: deleted Repo Wiki empty-string model facts, touched parallel state, menu first-item fallback, duplicate Submission parser, and reasoning restore helper no longer in production calls. Desktop continuous, Web Remote replayable, Session Selection, and Active Model lifecycle unchanged.

### 8.3 Documentation, Feature Graph, and Verification

- `docs/repo-wiki.md` and model selection Design changed to target Host Ready View, structured Draft Selection, and submission-time precise fixation.
- Feature Graph adds Renderer Model Selection Read and Provider Settings Service nodes, and deletes Repo Wiki/Composer/Automation/Subagent direct-connect old Model Provider Service drift edges.
- Repo Wiki E2E adds async Ready/Error Boundary anti-regression and ready-empty admission assertions; Remote waiting no Local fallback fixed by no-external-SSH-dependency Hook automation.

Passed:

- Provider/Model Selection, Repo Wiki, Root, Composer, Automation, Subagent directed unit tests;
- Root `pnpm typecheck`;
- `pnpm --filter @zcode/desktop typecheck:e2e`;
- Root `pnpm lint` (0 error; repository pre-existing warnings not in this Todo scope);
- Feature Graph YAML parse, incremental node/seed existence, and `git diff --check`.

Full `pnpm test:unit` completed 12,683 passed, 25 skipped; one pre-existing CUA socket close race condition occasionally fails under full concurrency, isolated re-run 22/22 passed. Full concurrency also hit Vitest worker heap limit once; all affected tests by this Todo split and re-run passed.

Desktop E2E actually launched and completed production build, but current Linux executor missing `xvfb-run`, Chrome exits before creating session; this is display environment blockage, not test assertion failure. Detailed failure report located in `.e2e-artifacts` generated by this run, tests remain executable on CI/macOS with display environment.

### 8.4 2026-09-01 Status Re-Validation

- `useModelSelectionView`, Workspace target, Repo Wiki Model State, and fact source 4 directed test files real-run passed, 15 total;
- `pnpm --filter @zcode/desktop typecheck:e2e` passed;
- Current Linux executor still not installed `xvfb-run`, does not record unable-to-create-browser-Session as E2E pass;
- MacBook Air current working copy located at another commit, not using old build to fake verification against current HEAD. Subsequent needs to sync current commit then real-run
  `repo-wiki-generation-settings.test.ts` and `repo-wiki-generation-produces-wiki.test.ts`.
