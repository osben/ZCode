# 09 Off-Peak Model Selection Legacy Projection Retirement

> Status: Completed (2026-08-24). Unfinished runtime and failure localization of the Off-Peak Desktop graphical E2E is
> closed by Todo 78.
>
> Source review: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-09-off-peak-model-selection-legacy-projection-retirement.md`

## 1. Task Objective

The transition chain that reverse-projected the Provider Registry / Effective Model Config into the old
`ModelProviderModelConfig` is deleted. Off-Peak model candidates, Reasoning Option Spec, submission validation and
dispatch validation all consume the same Registry model facts; execution submits a standard `ModelSelection`, which
the normal Registry / ModelFactory turns into the Active Model.

Unchanged by this todo:

- Remote `client/configs.offPeak.enable_offpeak_task` only gates entry exposure.
- Account / Coding Plan owns account support, Ticket admission and request-period authentication.
- Hidden Built-in `builtin:offpeak-idle-plan` Provider owns model members and complete Model Config.
- Off-Peak Tasks own their form drafts, task records and scheduling status.
- Idle automatic turns use an execution-scoped standard `ModelSelection`; Session Selection is not modified.

Target chain:

```text
Built-in / Account / Personal Config -> complete Provider Registry
  -> (fixed OFF_PEAK_PROVIDER_ID exact read) scoped ModelSelectionView { revision, builtin:offpeak-idle-plan.models[] }
  -> Off-Peak UI drafts / create-edit validation / Host default selection / dispatch validation
  -> ModelSelection -> ModelFactory -> Active Model -> Request
```

## 2. Architectural Boundaries

### 2.1 Hidden Provider Does Not Enter Normal Model Selection View

Normal `ModelSelectionFacade.getView()` keeps filtering `visibility: "hidden"` Providers. Off-Peak product services may
only read the target Provider exactly by fixed `OFF_PEAK_PROVIDER_ID` from the complete Registry, through the same
projection logic as normal Model Selection. Prohibited: the normal selector including hidden Providers; Renderer
querying hidden Providers by arbitrary ID; escape parameters like `includeHidden`, `trusted`, `executionOnly`; an
Off-Peak-specific complete Model Config DTO.

The result may be an existing `ModelSelectionView` with at most one `builtin:offpeak-idle-plan` Provider, or an existing
`ModelSelectionProviderView`. Either way Provider/Model structures reuse the formal Selection View types and projector.

### 2.2 Four Categories of Facts Stay Separate

| Fact                                            | Authoritative source                                           | Behavior                                                |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Off-Peak entry exposure                         | `client/configs.offPeak.enable_offpeak_task`                   | Kept; gates creation together with non-empty candidates |
| Model members and Model Config                  | Complete Registry (Built-in / Account / Personal parsed)       | Source of candidates, Reasoning, default model, checks  |
| Account support, Ticket, request authentication | Account Access, Off-Peak availability/ticket API, Request Auth | Not moved to Model Config                               |
| Task drafts, selection, scheduling status       | Renderer draft, Off-Peak Task Service/Repo, Scheduler          | Product-owned; never written to Session Selection       |

Account Provider dynamic `allowedModelIds` do not participate in the off-peak model list; members are product-level
members of the hidden Built-in Provider; Coding Plan Account decides only admission and request authentication.

### 2.3 Old Reverse Projection Deleted

Deleted: `OffPeakBuiltInModels.allowedModels`/`allowedModelConfigs`, `OffPeakClientConfig.allowedModels`/
`allowedModelConfigs`, `buildOffPeakBuiltInModels()`, `createOffPeakModelConfig()`, `createLegacyReasoningSpec()`, and
Off-Peak dependencies on `ModelProviderModelConfig`, `ModelProviderModality`, `ModelProviderReasoningSpec`. No
deprecated aliases, dual-writes or migration-period DTOs (the Provider Refactor configuration was never published as an
independent compatibility protocol).

### 2.4 Product View Composes Facts, Does Not Re-interpret Them

`OffPeakClientConfig` is closed to a read-only product view:

```ts
interface OffPeakClientView {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  readonly codingPlanActive?: boolean;
}
```

`enabled` = product switch hits AND at least one creatable model candidate exists in the scoped Registry.
`modelSelectionView` is a product-scope projection of the Registry View, not a new fact source. Physical naming may
follow existing Service type organization but must not redefine model fields.

## 3. UI, Drafts, and Persistence

### 3.1 UI Reads Standard Candidates

`OffPeakEditView` builds flat model candidates from the scoped `ModelSelectionView`: model IDs from
`provider.models[].modelId`; reasoning levels/defaults from `model.config.optionSpecs.reasoningLevel`; reasoning
controls reuse the Registry Model Thought Option helpers. It does not read `reasoningMapping` and does not copy Context,
Input/Output Format, Tool capabilities or Provider patches into drafts. `ModelConfigSelect` flat display mode is reused
without Provider management entries, Session state or inheritance semantics.

### 3.2 Drafts Use Standard Selection Semantics

```ts
{ providerId: OFF_PEAK_PROVIDER_ID, modelId, options?: { reasoningLevel?: string } }
```

On model switch the reasoning value is re-parsed against the new model's Option Spec. Models without a Reasoning Option
Spec hide the control and cannot submit the previous model's level.

### 3.3 Task Database Form Unchanged

`ZCodeOffPeakTask.model` and `thoughtLevel` are Off-Peak Task product persistence/API boundaries; no SQLite or server
interface change:

```text
ModelSelection.modelId                 -> task.model
ModelSelection.options.reasoningLevel  -> task.thoughtLevel
```

This projection is allowed only at Off-Peak Task submission/read boundaries. Execution forward-constructs a standard
`ModelSelection`; task fields never reverse-infer Model Properties, Reasoning Mapping or Provider API. New forms always
submit one explicit model. For historical tasks without `model`, no defaults or fake Models are created outside the
Registry; only the first ordered candidate of the current scoped Registry may be taken.

### 3.4 Expired Saved Selection

| Scenario                                                | Behavior                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| History / terminal read-only task model exited Registry | Show saved strings; do not add to candidates; do not modify the task             |
| Queued / paused edit: saved model expired               | Show unavailable state and block the original save; user picks a current model   |
| Saved Reasoning level expired                           | Show unavailable; pick a valid level or clear to current default before save     |
| Registry updates during create                          | Re-validate at submission against the current Registry, not the initial snapshot |

Silently replacing with the first item and overwriting the user's selection is prohibited.

## 4. Validation and Fail-Closed

### 4.1 Create and Edit Validation

Host / Service constructs the Off-Peak `ModelSelection` and validates it exactly against the complete Registry before
taking a Ticket or writing the Repo. Invalid: stable local validation error, no Ticket request, no Repo write. The
Renderer's disabled state is only feedback; Host / Service validation is the submission boundary.

### 4.2 Pre-Dispatch Re-Validation

Scheduler/Host re-validates against the current Registry before dispatch: Provider missing; Model missing or disabled;
Reasoning Level no longer supported; scoped Provider has no creatable candidates. These deterministic configuration
errors fail closed before model network requests and map to Off-Peak permanent dispatch failure (task `failed`, no
retry or re-queue). Network, Agent lifecycle and other recoverable errors keep transient backoff. Normal
`ModelSelectionFacade.validate()` hidden-visibility semantics are unchanged; Off-Peak validation uses the complete
Registry's exact selection validation.

## 5. Mock Boundaries

1. `ZCODE_OFFPEAK_MOCK=1` and its Ticket/Availability/lifecycle scenario variables stay for local development and
   Desktop E2E (entry switches, plan display, Tickets, queued/ready/active/expired/write-off, availability, quotas, 429,
   Retry-After, request-period credentials, Off-Peak model API Endpoint). `offPeakMockGateway` is not deleted and Mocks do
   not spread to normal Providers, Official MCP or production credential parsing.
2. `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS` is deleted (it dated from when remote `client/configs.allowed_models` was the model
   list source; keeping it lets Mocks manufacture Registry-nonexistent models). `ZCODE_OFFPEAK_MOCK_NO_PLAN` and the
   Ready/Active/Availability/Retry variables stay: they simulate product/service states, not model Registry facts.
3. Tests needing custom models declare complete facts through test ZCode Built-in Config / Built-in Model Rules
   (`builtin:offpeak-idle-plan` Provider API and members), never environment strings, temporary Model Config, fake or
   fallback Models.

## 6. Impact Scope and State Ownership

Change layer: option-source, draft-default, validation, commit-effect, persistence boundary. Seeds:
`buildOffPeakBuiltInModels`, `getOffPeakClientConfig`, `OffPeakEditView`, `OffPeakTaskService`, `dispatchOffPeakRun`.
Out of scope: Ticket state machine, Account Access, Request Auth, Telemetry, Queue/Recovery, database migrations.

### 6.1 UI Surfaces

| Scenario                   | Entry                                              | Candidate/default source                       | Validation                                                  | Sink                                                      |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| Create off-peak task       | Automations / New Task template, `OffPeakEditView` | scoped Registry View; first candidate default  | Remote switch, Plan support, availability, current Registry | `OffPeakTaskService.createTask` -> Ticket + Off-Peak Repo |
| Edit queued/paused task    | Automations `OffPeakEditView`                      | Saved selection; Registry decides availability | Status guards + current Registry                            | `updateTask` -> Off-Peak Repo                             |
| View terminal/running task | Off-Peak cards/History                             | Saved model/thought strings                    | Read-only                                                   | none; Registry changes do not rewrite history             |

Desktop local only; no new mobile/remote entries; Session Selection is never modified.

### 6.2 State Owners

| State/Fact                                 | Authoritative owner                          | Sink / persistence                     |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------- |
| Entry exposure                             | Remote `client/configs`                      | none                                   |
| Model candidates, Properties, Option Specs | Provider Registry                            | none                                   |
| Plan support and Ticket availability       | Account Access / Off-Peak Server             | Existing Service caches                |
| Create/edit drafts                         | Renderer (`OffPeakEditView` local state)     | Not persisted before user confirmation |
| Selected model / thought                   | Off-Peak Task Service/Repo                   | `off_peak_tasks.model/thought_level`   |
| Actual execution Model                     | Registry / ModelFactory created Active Model | Not written to Session Selection       |

### 6.3 Relationships

Must inspect: Registry -> scoped Off-Peak Selection View (unique candidate/Reasoning source); create/update ->
Registry validation (no invalid Ticket/DB writes); Scheduler/Host -> dispatch validation -> ModelFactory (post-queue
expiry fails permanently). Should inspect: `ModelConfigSelect` / Model Thought helper (shared display). Invariant only:
Account Access / Ticket / Request Auth (admission and access materials, not model members); desktop continuous / mobile
replayable (unchanged, no new mobile Off-Peak); Session Selection / App Recent / Queue.

Feature Graph edges to add when the graph is next updated (not written by this todo, to avoid overwriting concurrent
graph work):

```text
surface.off-peak-creation --options-from--> scoped offpeak ModelSelectionView
service.off-peak-task --validates-with--> complete Provider Registry
service.off-peak-task --persists-selection-boundary-to--> off_peak_tasks model/thought_level
capability.off-peak-model-execution --revalidates-before-dispatch-with--> complete Provider Registry
```

## 7. Cases and Pruning

### 7.1 Accepted Cases

| Case ID | Setup                                                 | Action                              | Assertions                                                                                     | Evidence layer               |
| ------- | ----------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| OPM-01  | Hidden Off-Peak Provider has two creatable models     | Open create page                    | Normal selection View excludes that Provider; Off-Peak scoped View contains exactly two models | Provider + Service + UI unit |
| OPM-02  | Model has Reasoning Option Spec                       | Switch model and levels             | UI reads only values/default; submissions use standard Selection semantics                     | Provider + UI unit           |
| OPM-03  | Model without Reasoning Option Spec                   | Switch from a reasoning model to it | Reasoning control hidden; old level not leaked on submission                                   | UI unit                      |
| OPM-04  | Model or level expired at submission                  | Create task                         | Local stable error; no takeTicket call; no Repo write                                          | Service unit                 |
| OPM-05  | Saved selection expired while queued/paused           | Edit and save                       | Unavailable shown, original save blocked; no silent replacement with first item                | UI + Service unit            |
| OPM-06  | History model exited Registry                         | View history                        | Saved strings still shown; not added to candidates; records not rewritten                      | UI unit                      |
| OPM-07  | Model/level exits Registry while queued               | Scheduler dispatch                  | Refused before network; task permanently failed; no transient retry                            | Host/Scheduler unit          |
| OPM-08  | Task without explicit model and scoped View non-empty | Host resolves default               | Only the current View's ordered first item; no inference from Connection/Catalog/fake Models   | Host unit                    |
| OPM-09  | `ZCODE_OFFPEAK_MOCK=1`                                | Run Off-Peak E2E                    | Product services driven by Mock; candidates only from test ZCode Built-in Config               | Services + Desktop E2E       |
| OPM-10  | Test attempts unknown models                          | Construct test Registry / submit    | No `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS` entry; clear failure on missing Config                  | Config + Service unit        |

### 7.2 Explicit Pruning

- Mobile `/remote` create/edit Off-Peak: unsupported by the product; DTO cleanup adds no entries.
- Remote Workspace Off-Peak: Off-Peak targets Desktop local Workspaces only.
- Auto-rewriting saved tasks after Registry updates: records keep historical selections; validated only at
  edit/dispatch.
- Account `allowedModelIds` filtering idle models; Mock injecting arbitrary models; modifying Session Selection, App
  Recent or the normal busy queue.

Test emphasis: Provider/Services/UI/Host/Scheduler unit tests; existing Off-Peak Desktop E2E only verifies the Mock +
test ZCode Built-in Config main chain (no new large Conversation E2E, no conversation case catalog change).

## 8. Completion Invariants

- No Off-Peak production reference to `ModelProviderModelConfig`, `allowedModelConfigs`/`allowedModels` for model
  facts, `createOffPeakModelConfig()`, `createLegacyReasoningSpec()` or old Off-Peak Reasoning helpers.
- Normal `ModelSelectionView` still filters hidden Providers; the Off-Peak scoped View parses only fixed
  `OFF_PEAK_PROVIDER_ID` and reuses the formal View projector.
- UI, create/edit validation, default model and dispatch validation read the same Registry revision/structure.
- No `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS`; no fake/fallback Models, temporary Model Config or capability inference outside
  the Registry.
- Expired selections do not take a Ticket or write the Repo at create/edit and fail closed permanently at dispatch.
- Task databases, Tickets, Account Access, Request Auth, Telemetry, desktop continuous and mobile replayable semantics
  are unchanged.
