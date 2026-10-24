# Todo 67: Complete Selection Before Formal Model Creation

> Status: Completed
>
> Source: Account Provider connectivity-test regression on a real device and a review of all execution entries.

## 1. Background and root cause

Provider Registry defines `reasoningLevel` as a required fact of an execution Selection. ModelFactory only validates and assembles a complete Selection and no longer guesses defaults for callers.

The connectivity test had already decided to use the lowest public level `values[0]` of the model's Reasoning Spec, but the order was wrong:

```text
settings page submits only providerId/modelId
      -> ModelFactory validates the Selection first
      X reasoningLevel missing
(the planned values[0] binding happened after Model creation, so it was never reached)
```

This was a deterministic local failure, not an Account plan, request Header, credential or server network problem.

The review found the same incomplete Selection in Git commit-message generation, Subagent explicit-model saving and Session creation's split `model`/`thoughtLevel` input. An explicit Title Generation Model Override had the same latent contract gap.

## 2. Principles

### 2.1 Identity Selection vs execution Selection

`ModelSelection` can stay a model identity across processes, history storage and UI selection, so the shared Schema is not made globally Reasoning-required. But any execution Selection entering the formal ModelFactory must already carry a legal `reasoningLevel` for that model:

```text
identity Selection -> boundary owning the Registry (select/create)
  -> complete execution Selection -> ModelFactory
```

Do not loosen ModelFactory, restore a Runtime fallback, or guess a level from Provider ID, modelId or strings such as `off`/`nothink`.

### 2.2 Normal selection vs auxiliary requests

- Normal user model selection defaults to the last item of the ordered `values`.
- Connectivity test, Git commit message and title generation use the lowest public level `values[0]`; `values[0]` is not equivalent to the string `disabled`.
- No `reasoningLevelPolicy` or second default abstraction.
- Output budgets stay explicitly bound by each auxiliary request's existing rule.

## 3. Scope and outcome

- **Provider connectivity test**: the settings page submits only Provider/Model identity. The App/Bootstrap boundary that owns the formal Registry reads the target Model's `optionSpecs.reasoningLevel.values[0]` and forms a complete execution Selection before calling ModelFactory. Core keeps the auxiliary-request binding `reasoningLevel = values[0]` and `maxOutputTokens = min(5000, optionSpecs.maxOutputTokens.max)`. No Account, Start, Individual, Team or specific-model branches.
- **Git commit message**: the Host Selection provider already returns a complete Selection, so the generator no longer strips `options`. Bootstrap validates the complete Selection; Core still lowers the actual auxiliary request to `values[0]`, so the Git request does not inherit the interactive session's high Reasoning. The old test assertion that conflated "drop interactive Reasoning" with "drop the whole Selection" is deleted.
- **Subagent explicit model**: saving an explicit Subagent model persists the Registry-resolved default Reasoning level together with Provider/Model (the UI used to show `high` but persist `undefined`). Legacy missing values may be completed once at an explicit read/migration boundary; ModelFactory never falls back.
- **Session create**: the protocol keeps the compatibility fields `model` and `thoughtLevel`; before building App/Runtime Config they are merged atomically: `model.options.reasoningLevel` wins, else the separate `thoughtLevel`, else the formal Registry selection boundary completes a normal new selection. An incomplete Selection never reaches ModelFactory first. Later `setModel`/`setThoughtLevel` only emit session-state events. Normal Host calls already merge before creation; the shared protocol still allows reading legacy identity Selections.
- **Title Generation explicit Override**: normal title generation uses the complete Session Selection unchanged. A retained explicit `titleGeneration.modelSelection` must be complete at its production/loading boundary. It currently has no production config writer, so no consumer-less compatibility branch was added.

ModelFactory's strict integrity validation is unchanged.

## 4. Tests

Written first: connectivity test with identity-only input through the real `ProviderRegistry -> ApiProviderModelRuntime -> Core` chain shows the Adapter receives `values[0]` and the capped output budget; parameterized over API Key, Start Plan, Team Plan (no Provider specialization); Git generator keeps the complete input Selection while the formal request uses `values[0]`; Subagent model switch saves the displayed legal level without touching the Reasoning control; Session Create merges split Model/Thought before App construction; an explicit Title Override (if retained) is tested Registry-backed; Desktop Provider Settings E2E really clicks the connectivity-test button (not just the Account page and model list). Core fake-ModelFactory tests only verify bind behavior and are not Registry vertical proof.

## 5. Completion criteria

- Account Provider and API Key Provider connectivity tests no longer report missing Reasoning and use `values[0]` without recognizing any Provider/model.
- Git, Subagent and Session Create never send an incomplete execution Selection to ModelFactory.
- Normal chat, Compact, Memory, Repo Wiki, Automation, Bot and Off-Peak unchanged; Registry/ModelFactory not loosened; no second Reasoning default fact.
- Targeted unit tests, Desktop E2E typecheck, root `pnpm typecheck` and `pnpm lint` pass; all formal ModelFactory call sites re-audited; real E2E environment limits recorded.
