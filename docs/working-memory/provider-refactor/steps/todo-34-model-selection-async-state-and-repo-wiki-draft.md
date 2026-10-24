# Todo 34: Model Selection Async State and Repo Wiki Draft Consolidation

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promoted items moved to
> [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules here; historical
> evidence is retained and the transfer does not mean the tests passed.

> Later Desktop graphical E2E untested items are consolidated by Todo 78; this Todo is no longer scheduled
> separately.

> Status: Implemented; core automation re-validated; Repo Wiki Desktop WDIO still awaiting a current-commit macOS
> real run
>
> Date: 2026-08-28
>
> Source: official package Repo Wiki real-device failure and Model Selection Renderer boundary review
>
> Related tasks: [`Todo 13`](./todo-13-target-host-model-selection-authority.md),
> [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md),
> [`Todo 32`](./todo-32-team-plan-settings-effective-provider-boundary.md)

## 1. Runtime Evidence and Direct Failure

On a MacBook Pro official package, opening Repo Wiki showed the Section Error Boundary text `Model selection missing
Provider:`. Logs from the same period proved the target Host did not lack models (`model-selection.getView`
completed, Registry published `account:bigmodel-team-coding-plan / GLM-5.3-Flash`, Provider Runtime reported the
model ready). Real sequence:

```text
Repo Wiki first render -> useModelSelectionView initial return null -> null projected to empty groups, default model "" 
 -> resolveRepoWikiThoughtLevelOption parses "" -> parseModelPickerValue throws -> Error Boundary unloads Repo Wiki
 -> getView subsequently succeeds, cannot update the unloaded page
```

Section Retry may repeat the same first-render sequence. Not a Registry, Account Team Plan or official config
problem: Renderer sent a normal async front-state into a strict parse boundary that accepts only a complete
Selection.

## 2. Broader Design Issues

- **`null` erases async lifecycle.** `useModelSelectionServiceView()` / `useModelSelectionView()` returned
  `ModelSelectionView | null`, where `null` meant first read in progress, target Remote Workspace not connected,
  Service missing or read disabled, or `getView()` failed but only logged. These need different UI, retry and
  submission semantics. On target Host switching, the returned state must bind to the current Service/workspace
  target so an old Host View is never briefly consumed by the new target (the generation guard only prevents late
  Promise override). Also `useModelSelectionView(null)` did not mean "missing target": it parsed by local target and
  fell back to Base/Current Host, so callers must first form an explicit Workspace Target and enter unavailable when
  there is none.
- **`null -> [] -> ""` creates pseudo-business facts.** `buildRegistryModelSelectGroups()` projected un-loaded to an
  empty array and Repo Wiki projected empty candidates to an empty `modelValue`, making "View not yet obtained"
  indistinguishable from "View obtained and providers truly empty".
- **Repo Wiki Store saved control encoding, not domain Selection** (`modelValue: string; modelTouched: boolean;
  thoughtLevel?: string; thoughtLevelTouched: boolean`). The `provider/model` string is only the control encoding of
  `ModelConfigSelect`; Repo Wiki should save a sparse explicit `ModelSelection` and format strings only at the
  Select boundary.
- **Renderer duplicated Host fallback.** Target Host's `ModelSelectionView` atomically contains candidates and
  `preferredSelection` (Configured Default if still selectable; else first visible Registry candidate with models;
  must belong to the View, Provider not hidden, Model exists, options valid; initialization result only, never
  written back to the persistent Configured Default). Repo Wiki self-selected `modelGroups[0].items[0]`, a second
  Fallback Policy that could silently switch an invalid explicit selection to another Provider/Model.
- **Generate admission ignored Model state.** `generateDisabled` considered only project, shared settings and task
  running; loading, remote waiting, read failure, ready-empty and invalid explicit selection silently exited in the
  handler.
- **Adjacent callers:** Repo Wiki (initial empty value into strict parser, page crash); Subagent Settings (read
  failure/unavailable can permanently look like loading); Automation Settings (empty menu while loading; falls back
  to Base/Current Host with no explicit target); Composer (empty candidates while loading, cannot express the real
  reason); Root login entry (`view !== null` wait for hydration, cannot finish startup on read failure); Provider
  Settings (Snapshot/Service Hooks keep first read failure as loading forever). Read-only display may tolerate
  missing extra model metadata; what needs explicit lifecycle state is the candidate read Owner, interaction
  admission and Submission boundary.

## 3. Decided Principles

1. Registry, `IModelSelectionService` and strict `parseModelPickerValue()` are not the root cause; do not widen the
   parser to accept an empty string nor build a placeholder Provider/Model for loading.
2. RPC `getView()` can keep returning a complete View asynchronously; loading, unavailable, error and retry are the
   Renderer Service Adapter's responsibility.
3. `ModelSelectionView.providers` empty means only "read and no candidates", never loading.
4. Candidates, `preferredSelection` and revision come from the same View of the target Host; Remote not connected
   must not fall back to Local/Base Host.
5. `preferredSelection` only takes part in Effective Selection parsing for new product Drafts without explicit
   intent; it is not written to the Draft's explicit `modelSelection`, and is not the current Session Selection,
   Active Model, recently used model or a forced recommendation.
6. Renderer does not duplicate Configured Default, Registry ordering or Fallback Policy.
7. Product Draft saves `ModelSelection`; the Select encoding string exists only at the control boundary; Submission
   fixes the complete `ModelSelection`.
8. An invalid explicit Selection keeps the original intent, shows unavailable and disables submission; it is never
   silently switched to the first menu item. `preferredSelection` is inherited only without explicit intent.
9. Error Boundary handles only unexpected render errors; loading, unavailable, ready-empty and read failure are
   normal page states.
10. Created Session/Active Model stay frozen; this Todo changes only candidate read, Draft initialization and
    pre-submission admission.
11. First read failure enters error; a background refresh failure after a Ready View keeps the previous successful
    View and records a warning (Service events publish only successful Views; the RPC/Event protocol is not
    expanded to show background refresh errors).

## 4. Target State Chain

### 4.1 Renderer Service State

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
        +-- not exists ----------------> unavailable/missing-target
        `-- exists -> Workspace Service Resolution
                          +-- remote-waiting --> unavailable/remote-waiting
                          `-- Host Service ----> Service State Hook -> loading/error/ready(view)
```

Two explicit entry points: components already inside the target `ServiceProvider` read the Host Service directly;
products reading across Workspaces first pass an explicit Workspace Target then do Workspace Service Resolution. The
Hook handles subscription-first, first read, target key, revision monotonicity, late-result discard, first error and
reload; this Renderer lifecycle type does not enter Provider Config, Registry or Protocol DTOs. After a
Service/Target change, if the Hook sees its internal owner key mismatch in the same render it must project loading
immediately, not wait for `useEffect` to clear the old View. Background refresh failure keeps the Last Known Good
Ready View.

### 4.2 Ready-only projection

`buildRegistryModelSelectGroups()` accepts only `ModelSelectionView`. Candidate menus, admission and Submission
callers branch on `ModelSelectionState.status` first; the helper never folds non-ready state to `[]`. Read-only leaf
components needing only optional Label/Metadata may receive an upper-layer-extracted optional Ready View.

### 4.3 Repo Wiki Draft

The generation settings model section is a domain object `modelSelection?: ModelSelection`:

- `undefined`: no Repo Wiki explicit model override; a value: the user explicitly chose Provider, Model and options
  for this Wiki.
- First display of `preferredSelection` or the existing Wiki Selection forms a parse result only and is not written
  back; only a real user change of model or reasoning writes an explicit Selection.
- A model change clears reasoning options incompatible with the old model; a reasoning change updates
  `options.reasoningLevel` directly.
- `ModelConfigSelect` renders strings; its selection event parses once at the boundary and writes the Selection back.
- The parallel empty-string / `modelTouched` / `thoughtLevelTouched` state is deleted.

### 4.4 Repo Wiki final model parse

A pure parse entry takes the target Host Ready View, Repo Wiki Draft and existing Wiki record and returns a
discriminated result:

```text
Repo Wiki explicit Selection
        +-- valid in current View --> ready(explicit)
        `-- invalid -----------> unavailable, no silent fallback
No explicit Selection
        -> existing Wiki Selection still valid in current View -> ready(existing)
           else Host preferredSelection -> ready(preferred) | ready-empty / no-model
```

"Valid in current View" reuses the complete `isSelectionInView()` semantics (Provider/Model membership, reasoning
level, max output tokens); no weaker Repo Wiki-only check. The Ready result carries the final `ModelSelection`,
control groups and the reasoning option; display and Generate use the same result.

### 4.5 Page behavior

| Model Selection status             | Repo Wiki behavior                                                        |
| ---------------------------------- | ------------------------------------------------------------------------- |
| loading                            | Display model loading state, model control and Generate disabled          |
| remote-waiting                     | Display waiting for target Workspace connection, do not access Local Host |
| error                              | Display read failure and reload, do not disguise as no model              |
| ready + providers empty            | Display currently no available models, Generate disabled                  |
| ready + explicit selection invalid | Display invalid selection and repair entry, Generate disabled             |
| ready + valid Selection            | Normal display reasoning and allow Generate                               |

`generateDisabled` includes the final Repo Wiki Model State; the event handler keeps invariant assertions but does
not replace UI admission with a silent return.

### 4.6 Adjacent entries

| Entry             | loading / unavailable                                                                                  | error                                                                              | ready                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Root startup gate | Keep waiting for the first Model Selection View                                                        | End silent waiting, show read failure and reload; never interpret as "no Provider" | Complete startup check by existing Provider availability rules                |
| Composer          | Preserve Draft/Session Selection, model control shows loading and cannot submit a new selection        | Preserve Selection, control shows read failure and reload                          | Candidates by target Host View; Session/Active Model ownership unchanged      |
| Automation        | missing-target/remote-waiting shown in the model control, no fallback to Base Host                     | Preserve form Draft, control shows read failure and reload                         | Candidates only from the selected Workspace Host                              |
| Subagent Settings | Preserve form Draft, model controls show loading                                                       | Preserve form Draft, model area shows read failure and reload                      | Keep using Local Environment View                                             |
| Provider Settings | Panel shows loading, `null` not treated as empty Provider list                                         | Panel shows read failure and reload                                                | Display that Environment's Provider Settings View                             |

Root's error ends the infinite wait controlled only by a `hydrated` boolean but must not fabricate an empty
`ModelSelectionView` to trigger the "no available Provider" branch. Provider Settings keeps its own domain state and
does not reuse `ModelSelectionState`.

## 5. Scope

Split Model Selection read into explicit Host Service and Workspace Target entry points with lifecycle state, owner
key, first error and reload; migrate Root, Composer, Repo Wiki, Automation and Subagent (no nullable compatibility
Hook kept); Ready-only Registry Model Groups projection; Repo Wiki Draft model field becomes `ModelSelection`; a
single Repo Wiki model parse result drives label, reasoning, disabled state and Submission; delete Repo Wiki
Renderer's menu first-item fallback, empty-string model facts and duplicate parse; give `useProviderSettingsServiceView()`
and the root Provider Settings Snapshot loading/error/reload state (own domain state, no Provider
Settings/Account Overlay semantic change); audit remaining model string parsers in Subagent, Composer and Session
Catalog (control boundary may keep strings, product Draft/Record adds none); rewrite `docs/repo-wiki.md` model
selection and capability source sections (delete deferred session/prewarm and Service secondary selection chains;
Generate Submission explicitly fixes `ModelSelection`); add Renderer async read state to the model selection Design
and Feature Graph, keeping `preferredSelection`, Configured Default, App Recent, Session Selection and Active Model
priority and Owner unchanged.

Not modified: Provider Config Overlay order; Account Provider model members or Access; Registry
integrity/execution admission; Configured Default physical storage and Fallback algorithm; Repo Wiki model requests,
Prompts, retries, timeouts or generated content; normal session Selection, queue, recovery and Active Model
lifecycle.

## 6. Acceptance Scenarios

### 6.1 Hook and async state

1. First subscription is loading; ready after `getView()` completes.
2. `getView()` failure enters error; reload success enters ready.
3. remote-waiting and missing-target are explicitly unavailable and do not call Local Host.
4. Switching Host in the same render does not expose the old Host View; old Host late Promise/events cannot override
   the new Host.
5. Same-Host revision only advances monotonically; events completing before the first read keep the newer View.
6. Background refresh failure after ready keeps Last Known Good, later success events still update.
7. ready-empty is distinguishable from loading/error/unavailable.

### 6.2 Repo Wiki pure state and components

1. A delayed Model View does not throw on first render and shows `preferredSelection` after arrival.
2. Valid explicit Selection beats existing Wiki Selection and Host preferred.
3. Invalid explicit Selection keeps the original intent and disables Generate (no fallback to first item).
4. No explicit Selection: valid existing Wiki Selection first; Host preferred when invalid.
5. Host with no preferred and no candidates shows no-model.
6. Reasoning option is parsed only from the final Selection's Ready View; switching model clears incompatible
   options.
7. The Repo Wiki Store never saves an empty model string; Submission carries a complete `ModelSelection`.
8. loading, unavailable, error, ready-empty and ready show correct status and button admission.
9. Retry in a normal error state calls real reload; the Section Error Boundary no longer handles such expected state.
10. First display of preferred/existing Selection does not write the Draft; with no user change a new Host View can
    update the Effective Selection.
11. Explicit/existing Selection whose reasoning level or max output tokens the current View rejects is invalid and
    does not enter Submission.

### 6.3 Affected entry regression

1. Composer first load and Host switching neither clear nor cross-use Draft/Session Selection.
2. Automation without explicit target does not read Base Host; with a ready target shows its candidates.
3. Subagent distinguishes loading, unavailable and error; no permanent spinning.
4. Root login entry judges Provider availability on Ready View only; first read failure ends startup waiting, shows
   reload and does not enter the "no Provider" branch.
5. Remote Workspace disconnect/reconnect does not leak Local Provider.
6. Provider Settings target Service Hook and root Snapshot both distinguish first loading/error/ready and retry after
   failure.
7. Desktop continuous and Web Remote replayable task/stream behavior unchanged.

Desktop E2E must cover at least a delayed ModelSelection View then opening Repo Wiki, Remote waiting and ready-empty.

## 7. Completion Criteria

Model candidate read Owner, interaction admission and Submission boundary no longer express loading/error/unavailable
as nullable View, empty candidates or empty string; projection helpers like `buildRegistryModelSelectGroups` do not
accept nullable View; Repo Wiki Domain Store holds no control strings or empty-string sentinels; Host
preferred/existing Selection only participates in Effective Selection parsing; Repo Wiki render never calls the
strict Selection parser in non-Ready state; no second Registry first-item fallback in Renderer; invalid explicit
models/options are never silently replaced and Generate accepts only a Ready `ModelSelection` validated by the
complete Selection check; target Host, revision and error status are proven by automation; Provider Settings first
read failure no longer looks like loading forever; Repo Wiki docs, model selection Design, Feature Graph and the
mandatory `ModelSelection` protocol agree.

## 8. Implementation Outcome and Verification

- `useModelSelectionServiceView()` and the Workspace entry are a `loading / unavailable / error / ready`
  discriminated union with explicit `reload()`; subscription before first read, revision monotonic, old Host late
  results discarded by generation, Ready post-read failure keeps Last Known Good, missing target / remote-waiting
  never read Model Selection Service or fall back to Base/Local Host.
- Repo Wiki Store holds only sparse `modelSelection?: ModelSelection`; `resolveRepoWikiModelState()` runs
  explicit > existing > Host preferred; loading, remote waiting, target missing, error, ready-empty and
  invalid-explicit are normal page states, Generate accepts only Ready Selection.
- Root, Composer, Automation and Subagent use explicit lifecycle; existing Draft/Session Selection is not cleared by
  non-Ready state. Provider Settings root snapshot and target Service Hook distinguish loading/error/ready and keep
  a Ready snapshot.
- Deleted: Repo Wiki empty-string model facts, touched parallel state, menu first-item fallback, duplicate Submission
  parser and the reasoning restore helper. Desktop continuous, Web Remote replayable, Session Selection and Active
  Model lifecycle unchanged. No Protocol DTO, Registry copy or second model facts added.
- `docs/repo-wiki.md` and model selection Design updated; Feature Graph adds Renderer Model Selection Read and
  Provider Settings Service nodes and deletes the Repo Wiki/Composer/Automation/Subagent direct-connect old Model
  Provider Service drift edges. Repo Wiki E2E adds async Ready/Error Boundary anti-regression and ready-empty
  admission assertions; Remote waiting no Local fallback is fixed by a no-external-SSH Hook automation.

Verification: Provider/Model Selection, Repo Wiki, Root, Composer, Automation and Subagent directed unit tests; root
`pnpm typecheck`; `pnpm --filter @zcode/desktop typecheck:e2e`; root `pnpm lint` (0 errors); Feature Graph YAML
parse and `git diff --check`; full `pnpm test:unit` 12,683 passed / 25 skipped (one pre-existing CUA socket close
race occasionally fails under full concurrency, isolated rerun 22/22; Vitest worker heap limit hit once, affected
tests rerun split and passed). Desktop E2E built but the Linux executor lacks `xvfb-run` so Chrome exits before
creating a session (display environment blockage, not an assertion failure).

2026-09-01 re-validation: 4 directed test files (`useModelSelectionView`, Workspace target, Repo Wiki Model State,
fact source) passed, 15 tests; `pnpm --filter @zcode/desktop typecheck:e2e` passed; the Linux executor still lacks
`xvfb-run` and the inability to create a browser session is not recorded as E2E pass; the MacBook Air working copy is
on another commit, so an old build is not used to fake verification. Open follow-up: sync the current commit, then
run `repo-wiki-generation-settings.test.ts` and `repo-wiki-generation-produces-wiki.test.ts` for real.
