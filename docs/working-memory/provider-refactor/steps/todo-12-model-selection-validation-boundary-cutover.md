# 12 Model Selection Validation Boundary Cutover

> Status: Completed (2026-08-25)
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Related design: [`../design/registry/registry.md`](../design/registry/registry.md), [`../design/registry/model-creation.md`](../design/registry/model-creation.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-12-model-selection-validation-boundary-cutover.md`

## 0. Confirmed Goal

The authoritative Model Selection validation happens at the boundary where a task actually starts executing and
`ModelFactory` is about to build a Model. The user Facade only provides user-visible candidates and no longer doubles as an
internal execution validator.

```text
user candidates: ModelSelectionFacade { getView(), onDidChange() } -> visible Provider / Model
execution facts: submitted task carries ModelSelection -> current Agent-process Provider Registry
  -> validateSelection() -> ModelFactory builds the Model
```

Off-Peak validates early with the same Registry semantics at create, edit and before dispatch (create validation happens
before the Ticket request; dispatch validation guards against config expiring while queued); none of these replaces
ModelFactory's final validation. Visibility only affects user candidates, is not a permission, and introduces no `trusted`,
`execution-only` or similar concepts.

## 1. Problems Fixed

1. `ModelSelectionFacade.getView()` filters hidden Providers/Models, but `validate()` delegated straight to the full
   Registry, so one Facade expressed both user candidates and internal exact execution.
2. Ordinary UI only consumed `getView()`/`onDidChange()`; the production caller of `IModelSelectionService.validate()` was
   mainly Desktop Off-Peak dispatch, making it a shortcut for hidden Providers.
3. `ApiProviderModelRuntime.modelFactory` only looked up Provider/Model exactly and did not uniformly call the Registry's
   reasoning-level and max-output-tokens Selection option validation at the build entry.
4. Off-Peak create/edit already used exact Registry validation, so the same product had two validation entries.

## 2. Rules

### A. The User Facade Retires Execution Validation

- Delete `ModelSelectionFacade.validate()`; delete `IModelSelectionService.validate()` with the RPC adapter, Home-only
  stub, mocks and tests; delete `validateSelection()` from `ProviderRegistryFacadeSource` (exposed only for the Facade).
- Keep `validateSelection()` on `ProviderRegistryService` / `ProviderRegistry` for ModelFactory and internal products.
- The Facade keeps only the user candidate View and change events; the Renderer does not copy an authoritative option
  validation from the View.

### B. ModelFactory Is the Final Validation Boundary

- `ApiProviderModelRuntime.modelFactory` validates the complete `ModelSelection` against the current process Registry
  before reading and freezing Provider/Model facts. A missing Provider/Model, unsupported Reasoning Level or out-of-range
  Max Output Tokens fails closed before the Model is created.
- The shared `ModelSelectionValidation -> ModelProtocolError` mapping is extracted from the existing Registry selection
  helper: `provider-not-found` -> `ProviderNotFound`, `model-not-found` -> `ModelNotFound`, option errors ->
  `InvalidModelRequest`. ModelFactory and the existing Selection resolver must not each keep a `switch`; the fallback
  helper that returns `undefined` for `provider-not-found` must not be reused (ModelFactory must fail explicitly).
- A hidden but complete, enabled model stays in the Registry and can be created from an internal exact Selection.
- Every newly created root execution Model passes this ModelFactory boundary; `Model.bind()` and Automatic Compact
  inheriting the current Active Model inherit already validated, frozen facts and do not re-query the Registry.

### C. Off-Peak Keeps a Narrow Early Check

- Desktop Off-Peak no longer calls the user `IModelSelectionService.validate()`; it reuses the existing complete-Registry
  `OffPeakTaskServiceDeps.resolveModelSelection`, and when the Desktop Host needs it, only the concrete `OffPeakTaskService`
  provides a Host-private dispatch-validation method (not on the Renderer RPC interface).
- No new Registry Service, RPC or stateful generic Validation Service. Validation runs before `takeTicket()` on create,
  before persistence on edit and before starting the Agent turn on dispatch; dispatch failure keeps producing
  `OffPeakModelUnavailableError` and a permanent dispatch failure; after the early check passes, building the off-peak
  Model still runs the final validation again.

### D. Selection State Is Unchanged

No change to Composer Draft, App Recent, Configured Default or Session Selection; Configured Default/fallback candidate
resolution; the Model Selection protocol and persistence; UI candidate order, grouping or hidden filtering; Desktop
continuous, Mobile replayable, remote workspace, Queue or recovery.

## 3. Impact

Capability: Model Selection, Provider Registry, ModelFactory, Off-Peak execution; layers `validation`, `commit-effect`;
seeds `ModelSelectionFacade`, `IModelSelectionService`, `ApiProviderModelRuntime.modelFactory`, `dispatchOffPeakRun`;
out of scope: candidate UI, selection state, persistence, Access/Auth, Runtime composition, Telemetry.

| User scenario                 | Candidate source                          | Commit sink                | Final validation                                  | Visible change |
| ----------------------------- | ----------------------------------------- | -------------------------- | ------------------------------------------------- | -------------- |
| Ordinary chat model selection | `ModelSelectionFacade.getView()`          | Submission / Session       | Agent Registry + ModelFactory                     | none           |
| Automation/Subagent/Repo Wiki | same candidate View, each with its own Draft | each entry's own config/command | when the Model is actually created          | none           |
| Off-Peak hidden model         | internal product config / exact Selection | Off-Peak dispatch          | early Registry check + ModelFactory final check   | none           |

Must-inspect: Facade -> Services/RPC/mocks (full-chain deletion of `validate()` with no empty implementation);
ModelFactory -> Registry (full Selection validation before build, shared error mapping); Off-Peak dispatch -> Registry
(reuse the resolver, keep permanent failure). Should-inspect: Client/Remote service proxy (narrowed interface keeps proxy,
Bot and remote workspace assembly working); Configured Default/fallback (early resolution does not replace final
validation). Invariant-only: all model-selection UIs; Desktop/Mobile/Remote delivery, Queue, Recovery and workspace
identity. No codegraph interface was available; evidence is Feature Graph, `dep:refs`, exact call scans and source.

## 4. Accepted Cases and Pruning

| Case ID | Setup                                          | Action                         | Assertions                                                          |
| ------- | ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| MSV-01  | visible Provider/Model                         | submit normally and create Model | Registry validation passes, Model created once                    |
| MSV-02  | Provider or Model gone from the current Registry | start building the Model     | stable Provider/Model error before creation                         |
| MSV-03  | invalid Reasoning or Max Output option         | start building the Model       | `InvalidModelRequest` before creation, never reaching the Adapter   |
| MSV-04  | hidden Off-Peak Provider complete and enabled  | dispatch and build the Model   | early check and final validation pass, user View still hides it     |
| MSV-05  | Registry changes after the Off-Peak early check | final Model build             | ModelFactory fails closed on the latest Registry                    |
| MSV-06  | ordinary model candidate UI                    | read and switch candidates     | View, selection state and submission unchanged, no Facade validate call |
| MSV-07  | created and validated Active Model             | `bind()` or Automatic Compact  | inherits frozen facts, no re-read of the current Registry           |

Pruned: no UI surface x Provider API expansion (candidates and Adapter encoding are unchanged) and no new large E2E;
ModelFactory and Off-Peak cross-boundary unit tests are enough, existing representative UI/Off-Peak E2E only regress.

## 5. Verification

Update the formal Design first; write failing tests first (ModelFactory option fail-closed, hidden exact creation, bound
Model not re-querying the Registry, Off-Peak permanent failure); extract the shared mapping and complete ModelFactory final
validation; Off-Peak dispatch reuses `OffPeakTaskServiceDeps.resolveModelSelection`; delete Facade/Service `validate()`,
`ProviderRegistryFacadeSource.validateSelection()` and all placeholders; `rg` and `dep:refs` confirm zero production
references to `ModelSelectionFacade.validate`, `IModelSelectionService.validate`, `modelSelectionService.validate`,
`ProviderRegistryFacadeSource.validateSelection`; run affected Provider, Services, Bootstrap, Client, Server, Desktop and
Web unit tests (explicitly `RemoteServiceAccess`, Bot remote proxy, remote workspace service collection, Web Home-only
stub) plus `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.

## 6. Non-Goals

No change to Provider/Model visibility, enabled, members or Overlay; hidden is not a permission or trusted identity; no
change to Model Selection persistence or Session lifecycle; Off-Peak Selection is not written to the ordinary Session
Selection; no Provider Runtime composition work; no Access, Request Auth, Telemetry, Queue or Recovery refactor.

## 7. Result (2026-08-25)

- `ModelSelectionFacade` and the cross-Host `IModelSelectionService` no longer have the general `validate()`; the Web
  Home-only stub, tests and Facade Source are zeroed accordingly.
- `ApiProviderModelRuntime.modelFactory` fully validates the Selection against the current Agent Registry before Adapter
  creation, sharing the single `ModelSelectionValidation -> ModelProtocolError` mapping with the Registry selection
  resolver; missing Provider/Model map to `ProviderNotFound` / `ModelNotFound`, invalid reasoning and max output to
  `InvalidModelRequest` before the Adapter; hidden, complete, enabled Provider/Model still pass ordinary exact Registry creation.
- Off-Peak dispatch uses the concrete `OffPeakTaskService.validateDispatchModelSelection()` narrow check; create/edit reuse
  the same resolver and the final ModelFactory validation is unchanged.
- The zero scan found no residue of `ModelSelectionFacade.validate`, `modelSelectionService.validate` or Facade Source
  `validateSelection`; targeted Provider, Services, Web and Bootstrap tests and root `pnpm typecheck` pass.
