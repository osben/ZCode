# Todo 63: Model Selection Invalidation and Request Budget Closeout

> Status: done
>
> Date: 2026-09-02
>
> Prerequisites: Todo 58 removed `default` from Model Option Spec; Todo 60 requires every Effective Model to have a complete, ordered Reasoning Spec. This Todo unifies Selection invalidation, recovers legacy off-peak tasks, and removes `maxOutputTokens` from Selection.

## 1. Goal

Static model facts, user choice and per-request parameters stay strictly separate:

```text
Model Config / Option Specs
├─ reasoningLevel.values: valid levels, sorted low to high
└─ maxOutputTokens.max: hard upper limit allowed by the model

ModelSelection
├─ providerId
├─ modelId
└─ reasoningLevel

Model Request
└─ maxOutputTokens: decided explicitly by the Agent framework for this call
```

`spec.max` is a legal and common request budget. The problem was never using the maximum, but ModelFactory or an Adapter silently filling it in when the caller made no decision.

## 2. ModelSelection contract

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options: {
    reasoningLevel: string;
  };
}
```

- `ModelSelection.options.maxOutputTokens` is removed everywhere (protocol, persistence, Recent, Session, Subagent, Automation, Off-Peak, timeline comparison, Hydration).
- A newly written Selection must carry a concrete `reasoningLevel`.
- A legacy Selection missing reasoning may get `values.at(-1)` only at the existing Host initialization boundary that creates a brand-new default selection. Business layers, Renderer, ModelFactory and Adapters never fill it in.
- An explicit but invalid reasoning is never auto-replaced.

## 3. Per-request budget

`maxOutputTokens` stays a Model Request Option and must be complete and legal before entering the Executor:

```text
concrete execution chain
    |  decides maxOutputTokens explicitly
    v
Active Model / Adapter
    |  only validates 0 < value <= spec.max
    v
model API
```

- Normal Turn, Off-Peak and normal Subagent may explicitly pick `spec.max`.
- Title, Goal, Memory, Git Commit, Connectivity and WebSearch/WebFetch keep their explicit budgets.
- Compact and Repo Wiki keep their own task semantics but the caller must pass the value explicitly.
- ModelFactory's `selection value ?? spec.max` is removed; Active Model no longer treats a Selection output budget as long-lived bound state.
- Adapters keep strict missing-argument errors: no clamp, no fill.

## 4. Unified Selection invalidation

```text
ModelSelection invalid
├─ structure cannot be parsed
├─ Provider missing or not in the current Selection View
├─ Model missing or not in the current Selection View
└─ reasoningLevel not in the current model's values
```

Reasoning invalidity is one reason within the unified invalidation, not a second repair flow. Validation keeps a structured reason so the UI can show an accurate message; returning only `false` and falling back silently is not allowed.

## 5. Uncommitted drafts

Drafts have no auto-execution side effects, so they reuse the existing default-selection priority:

```text
current/Recent Selection
        +-- valid --> keep
        `-- invalid --> drop the whole Selection
                        use Host preferredSelection
                        notify once
```

- A new draft with no history uses the normal default priority, no notification.
- A previously held selection invalidated by a Registry revision change shows the existing Toast style:
  - with fallback: `原来的模型选择已失效，已切换到当前默认模型，请确认后继续。` (the earlier model selection is no longer valid; switched to the current default model, confirm before continuing)
  - without fallback: `原来的模型选择已失效，请重新选择模型。` (the earlier model selection is no longer valid; choose a model again)
- Notify once per invalidation; no blocking Modal; no timeout to paper over state problems.

## 6. Created tasks and historical data

Tasks that already exist and may auto-execute never switch model silently:

```text
Persisted Task Selection
        +-- currently valid --------> run normally
        +-- reliably migratable ----> write back complete Selection, then run
        `-- cannot be recovered ----> keep the task
                                      mark model selection as needing repair
                                      forbid scheduling/execution
                                      wait for user edit
```

### 6.1 Legacy off-peak tasks

Legacy rows have only `model` / `thought_level`, no Provider identity. The old implementation chose Z.ai or BigModel at execution time from the current account connection, so reliable migration happens once the current Off-Peak Selection View is ready, not in the SQLite Row Mapper:

```text
legacy model / thought_level + current Off-Peak Selection View
          |
          v
resolve a unique, currently valid complete Selection
          +-- success --> atomically write back model_selection
          `-- failure --> keep as repair-required
```

- The Repository tolerates a missing or illegal `model_selection` per row; one legacy row cannot fail `list()`, sync or other task scheduling.
- Repair-pending tasks stay in the list; terminal history remains viewable.
- Unrepaired non-terminal tasks cannot be claimed, continued or dispatched.
- Never delete legacy rows, guess the account Provider from the model name, or silently write the current default model into an existing task.

## 7. Registry update and Active Model

```text
Registry revision update
├─ new drafts: validate, handle per §5
├─ created tasks: validate, handle per §6
├─ later new requests: build Model from the new Registry
└─ Active Model already executing: stays frozen
```

Desktop continuous and Mobile replayable share only the Selection validation result; message flow, queues, owner/lease and recovery protocol are unchanged.

## 8. Test scope (written first)

1. Shared/Protocol: Selection rejects `maxOutputTokens`; structured reasoning round-trips.
2. Provider: validation returns structured provider/model/reasoning reasons; default init without reasoning takes the highest level; an explicit illegal value is not filled.
3. Agent Runtime: ModelFactory binds no output budget; normal Turn passes `spec.max` explicitly; every other chain has an explicit budget before the Executor.
4. UI unit: after Recent/current draft invalidation fall back to Host preferred and expose "invalidation happened"; a new draft with normal defaults does not misreport.
5. UI E2E: a Registry revision invalidating the draft switches the toolbar to a valid default with one notification; with no available model, require re-selection.
6. Off-Peak Repo/Service: a legacy row does not break the list; unique recovery writes back; unrecoverable rows are visible but unschedulable; other tasks keep syncing and claiming.
7. Regression: Selection and Request Options are not mixed across Session, Subagent, Automation, Repo Wiki, Title, Goal, Memory, Compact, Connectivity.

## 9. Outcome

- `ModelSelection` is Provider, Model and Reasoning only; no layer persists `maxOutputTokens`.
- ModelFactory does not bind or default the output budget. Normal Turn/Off-Peak/Subagent explicitly choose the model `spec.max`; Compact, Title, Goal, Memory, Git Commit, Connectivity, WebSearch/WebFetch and Repo Wiki keep explicit budgets.
- Provider Registry returns structured invalidation reasons for missing and illegal Reasoning; new selections go through `completeNewModelSelection()` which takes the last ordered level; explicit illegal values are not patched.
- After a Registry revision change a draft atomically clears the invalid Selection, falls back to Host preferred and shows one notification de-duplicated by workspace/revision; an already-executing Active Model is unchanged.
- The off-peak task Repository reads missing, legacy-schema or corrupt `model_selection` per row. The Service writes back only when the current Account Family Off-Peak Resolver can preserve the original model/reason. Unrecoverable tasks stay listed, are marked repair-required and lose scheduling eligibility; editing requires re-picking a full model and Reasoning.
- Deferred migration and invalidation writes re-read inside the SQLite write lock so they cannot overwrite a user repair finished by another process.

## 10. Verification state

- Targeted Provider/Services/UI (50), CLI Bootstrap/Contracts/Core (109), CLI Core full (2,201), root and CLI `typecheck`, `pnpm lint` (existing warnings), `oxfmt --check` and `git diff --check` passed.
- `pnpm test:unit`: 13,087 passed, 25 skipped; 2 unrelated existing failures (Desktop E2E Provider seed count assertion; pre-push mise assertion).
- Graphical Desktop E2E not run (no display); core interaction is covered by React Hook/state unit tests. A macOS WDIO run is still open.
