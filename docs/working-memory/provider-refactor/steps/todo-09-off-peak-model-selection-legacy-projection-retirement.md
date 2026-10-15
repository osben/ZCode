# 09 Off-Peak Model Selection Legacy Projection Retirement

> Unfinished runtime and failure localization of Off-Peak Desktop graphical E2E uniformly closed by Todo 78; this Todo no longer schedules separately.

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)

## 1. Task Objective

Delete Off-Peak's transition chain that reverse-projections new Provider Registry / Effective Model Config into old
`ModelProviderModelConfig`. Off-Peak model candidates, Reasoning Option Spec, submission validation, and dispatch validation uniformly
consume the same Registry model facts; actual execution continues submitting standard `ModelSelection`, created by normal Registry / ModelFactory into
Active Model.

This Todo only closes model selection facts and validation boundaries, not redesigning Off-Peak products:

- Remote `client/configs.offPeak.enable_offpeak_task` continues responsible for entry exposure only;
- Account / Coding Plan continues responsible for account support, Ticket admission, and request-period authentication;
- Hidden Built-in `builtin:offpeak-idle-plan` Provider continues responsible for model members and complete Model Config;
- Off-Peak Tasks continue to have their own form drafts, task records, and scheduling status;
- Idle automatic turns continue using execution-scoped standard `ModelSelection`; do not modify Session Selection.

```text
Current

Built-in Provider / Model Config
              |
              v
Effective Provider Resolution
              |
              v
buildOffPeakBuiltInModels()
              |
              +--> allowedModels: string[]
              `--> allowedModelConfigs: ModelProviderModelConfig[]
                            |
                            +--> UI manually constructs candidates and Reasoning controls
                            `--> Host takes default model from allowedModels[0]

Target

Complete Provider Registry
              |
              | fixed OFF_PEAK_PROVIDER_ID exact read
              v
Scoped ModelSelectionView
|- revision
`- builtin:offpeak-idle-plan
   `- models[]
      |- modelId
      `- Registry Model Config
         |- properties
         `- optionSpecs.reasoningLevel
              |
              +--> Off-Peak UI drafts
              +--> Create / edit validation
              +--> Host default selection
              `--> Dispatch validation -> ModelSelection -> ModelFactory
```

## 2. Confirmed Architectural Boundaries

### 2.1 Hidden Provider Does Not Enter Normal Model Selection View

Normal `ModelSelectionFacade.getView()` continues filtering Providers with `visibility: "hidden"`. This is the correct boundary for normal user selection;
cannot be widened for Off-Peak.

Off-Peak product services only allow reading the target Provider exactly by fixed `OFF_PEAK_PROVIDER_ID` from complete Registry, and using the same projection logic as normal
Model Selection to generate scoped View. The following entry points prohibited:

- Normal model selector includes hidden Provider;
- Renderer queries hidden Provider by any Provider ID;
- Universal escape parameters like `includeHidden`, `trusted`, `executionOnly`;
- Off-Peak-specific complete Model Config DTO.

Target can return existing `ModelSelectionView` containing at most one `builtin:offpeak-idle-plan` Provider; or directly
return existing `ModelSelectionProviderView` in service interface. Regardless of which physical envelope selected, Provider and Model internal structures must reuse formal
Selection View types and same projector; cannot copy field definitions.

### 2.2 Four Categories of Facts Remain Separated

| Fact                                                        | Authoritative Source                                                   | This Todo Behavior                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Off-Peak entry exposure                                     | `client/configs.offPeak.enable_offpeak_task`                           | Retained; gates creation entry together with non-empty Registry candidates |
| Model members and Model Config                              | Complete Registry after Built-in / Account / Personal parsing          | Unified candidates, Reasoning, default model, and validation sources       |
| Whether account supports, Ticket and request authentication | Current Account Access, Off-Peak availability/ticket API, Request Auth | Do not migrate to Model Config; no changes                                 |
| Task drafts, selection, and scheduling status               | Renderer draft, Off-Peak Task Service/Repo, Scheduler                  | Continue owned by product itself; do not write Session Selection           |

Account Provider's dynamic `allowedModelIds` not participating in off-peak model lists. Current Off-Peak model members are product-level members of hidden Built-in Provider;
Coding Plan Account only decides account admission and request authentication.

### 2.3 Delete Old Reverse Projection

Delete the following model fact bridges:

- `OffPeakBuiltInModels.allowedModels`;
- `OffPeakBuiltInModels.allowedModelConfigs`;
- `OffPeakClientConfig.allowedModels`;
- `OffPeakClientConfig.allowedModelConfigs`;
- `buildOffPeakBuiltInModels()` and its old DTO construction responsibilities;
- `createOffPeakModelConfig()`;
- `createLegacyReasoningSpec()`;
- Off-Peak dependencies on `ModelProviderModelConfig`, `ModelProviderModality`, and
  `ModelProviderReasoningSpec`.

Deprecated aliases, dual-writes, or "migration-period DTOs" must not be retained. The current branch's Provider Refactor configurations have not been published as independent compatibility protocols; this Todo does not design so-called old/new version compatibility.

### 2.4 Product View Only Composes Facts, Does Not Re-interpret Facts

Current `OffPeakClientConfig` packs both remote switches and old model DTOs; names and responsibilities already inaccurate. Target service return values should be closed to
read-only product views like `OffPeakClientView`:

```ts
interface OffPeakClientView {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  readonly codingPlanActive?: boolean;
}
```

Target criteria for `enabled`:

```text
Product switch hits
AND at least one creatable model candidate exists in scoped Registry
```

`modelSelectionView` is product-scope projection of Registry View, not new Config or model fact source. Final physical naming can be fine-tuned at implementation by existing
Service type organization, but must not redefine model fields.

## 3. UI, Drafts, and Persistence

### 3.1 UI Directly Reads Standard Candidates

`OffPeakEditView` generates flat model candidates from scoped `ModelSelectionView`:

- Model IDs from `provider.models[].modelId`;
- Reasoning levels and defaults from `model.config.optionSpecs.reasoningLevel`;
- Reasoning controls reuse existing Registry Model Thought Option helpers;
- Do not read `reasoningMapping`; Provider request parameters only consumed forward by ModelFactory / Adapter;
- Do not copy Context, Input/Output Format, Tool capabilities, or Provider patches into Off-Peak drafts.

Continue reusing `ModelConfigSelect`'s flat display mode, without bringing normal conversation's Provider management entries, Session state, or inheritance semantics.

### 3.2 Drafts Use Standard Selection Semantics

Model drafts for create/edit pages interpreted as a standard selection:

```ts
{
  providerId: OFF_PEAK_PROVIDER_ID,
  modelId,
  options?: { reasoningLevel?: string }
}
```

On switching models, Reasoning current value must re-parse according to new model's Option Spec; models without Reasoning Option Spec do not display that
control, and cannot retain previous model's level as submission value.

### 3.3 Task Database Form Not Changed for Now

`ZCodeOffPeakTask.model` and `thoughtLevel` are Off-Peak Task's product persistence/API boundaries, not complete model fact sets. This
Todo does not require modifying SQLite columns or server task interfaces:

```text
ModelSelection.modelId                 -> task.model
ModelSelection.options.reasoningLevel  -> task.thoughtLevel
```

This projection only allowed at Off-Peak Task submission/read boundaries. Execution must forward-construct standard `ModelSelection`; task fields
cannot reverse-infer Model Properties, Reasoning Mapping, or Provider API.

New forms always submit one explicit model. Whether to continue allowing historical task records to lack `model`, handled by existing Off-Peak product compatibility scope;
do not manufacture defaults or fake Models outside Registry; on missing, only allowed to take first item from current scoped Registry's ordered candidates.

### 3.4 Behavior When Saved Selection Expired

| Scenario                                                      | Behavior                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| History / terminal-state-read-only task model exited Registry | Continue showing task-saved string facts; do not re-add to candidates; do not modify task  |
| Queued / paused edit: saved model expired                     | Show unavailable state and prevent original save; user must select current valid model     |
| Saved Reasoning level expired                                 | Show unavailable; select valid level before save or clear to current default semantics     |
| Registry updates during create                                | Re-validate at submission boundary by current Registry; do not trust page initial snapshot |

Silently replacing with first item and overwriting user's original selection prohibited.

## 4. Validation and Fail-Closed

### 4.1 Create and Edit Validation

Current create only validates title, Prompt, Workspace, and permission mode; edits also persist `model` / `thoughtLevel` to DB. Target is to
use current complete Registry to validate standard `ModelSelection` before actually taking Ticket or writing Repo:

```text
Renderer Submission
        |
        v
Host / Service constructs Off-Peak ModelSelection
        |
        v
Complete Registry exact validation
        |
        +--> Invalid: return stable local validation error; no Ticket request, no Repo write
        `--> Valid: continue create or edit
```

Renderer's disabled state only provides timely feedback; Host / Service validation is submission boundary; cannot trust only UI snapshots.

### 4.2 Pre-Dispatch Re-Validation

Tasks may wait in queue for long periods; Scheduler/Host must re-validate against current Registry before dispatch:

- Provider does not exist;
- Model does not exist or disabled;
- Reasoning Level no longer supported;
- Scoped Provider currently has no creatable candidates.

These are deterministic configuration errors that must fail-closed before model network requests, mapped to Off-Peak permanent dispatch failure:
task set to `failed`, stop retry and re-queuing. Network, Agent lifecycle, and other recoverable errors continue using transient backoff.

This Todo does not modify normal user `ModelSelectionFacade.validate()` hidden visibility semantics; Off-Peak internal validation should directly use
complete Registry's exact selection validation, not infer by reverse-predicting normal user candidate View.

## 5. Mock Boundaries

### 5.1 Retain Off-Peak Mock Gateway

`ZCODE_OFFPEAK_MOCK=1` and its Ticket/Availability/lifecycle scenario variables continue for local development and Desktop E2E:

- Simulate remote entry switches and plan display states;
- Simulate Tickets, queued/ready/active, expired, and write-off;
- Simulate availability, quotas, 429, and Retry-After;
- Simulate request-period credentials and Off-Peak model API Endpoint.

This Todo does not delete `offPeakMockGateway`, nor spread Mocks to normal Providers, Official MCP, or production credential parsing.

### 5.2 Delete Model List Environment Variables

Delete `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS`. It originated from old design's stage where remote `client/configs.allowed_models` was model list
fact source; current real E2E does not depend on this variable; retaining it allows Mocks to manufacture Registry-nonexistent models.

Target test chain:

```text
ZCODE_OFFPEAK_MOCK
|- Simulate product switches, Tickets, and model services
`- Do not simulate model Registry

Test ZCode Built-in Config
`- Declare builtin:offpeak-idle-plan's Provider API and model members
```

Tests needing custom models must declare complete facts through test ZCode Built-in Config / Built-in Model Rules; cannot use environment variable strings,
temporary Model Config, fake Models, or fallback Models.

Retain `ZCODE_OFFPEAK_MOCK_NO_PLAN` and Ready/Active/Availability/Retry scenario variables; they simulate product or service states,
not contending with model Registry for fact ownership.

## 6. Impact Scope and State Ownership

### 6.1 Feature Summary

| Field            | Content                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Delete Off-Peak reverse projection from new Registry to old Model Config                                             |
| Capability       | Off-Peak Model Selection / Off-Peak Model Execution                                                                  |
| Change layer     | option-source, draft-default, validation, commit-effect, persistence boundary                                        |
| Operating mode   | planning                                                                                                             |
| Primary seeds    | `buildOffPeakBuiltInModels`, `getOffPeakClientConfig`, `OffPeakEditView`, `OffPeakTaskService`, `dispatchOffPeakRun` |
| Out of scope     | Ticket state machine, Account Access, Request Auth, Telemetry, Queue/Recovery, database migrations                   |

### 6.2 UI Surface Matrix

| User Scenario              | UI Entry                                                 | Display/Draft Owner  | Candidate/Default Source                                       | Validation/Gating                                           | Submission and Sink                                       | Mode Boundary                               |
| -------------------------- | -------------------------------------------------------- | -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| Create off-peak task       | Automations / New Task template enters `OffPeakEditView` | Renderer local draft | scoped Registry View; first candidate as create default        | Remote switch, Plan support, availability, current Registry | `OffPeakTaskService.createTask` -> Ticket + Off-Peak Repo | Desktop local; no new mobile/remote entries |
| Edit queued/paused task    | Automations `OffPeakEditView`                            | Renderer local draft | Saved selection; current Registry responsible for availability | Status guards + current Registry                            | `updateTask` -> Off-Peak Repo                             | Do not modify Session Selection             |
| View terminal/running task | Off-Peak cards/History                                   | Saved task facts     | Saved model/thought strings                                    | Read-only                                                   | No model submission                                       | Registry changes do not rewrite history     |

### 6.3 State Owners and Commit Sinks

| State/Fact                                 | Display or Cache              | Authoritative Owner                          | Commit sink / Persistence              |
| ------------------------------------------ | ----------------------------- | -------------------------------------------- | -------------------------------------- |
| Entry exposure                             | Off-Peak Zustand snapshot     | Remote `client/configs`                      | No independent persistence             |
| Model candidates, Properties, Option Specs | scoped Selection View         | Provider Registry                            | No independent persistence             |
| Plan support and Ticket availability       | Renderer masked snapshot      | Account Access / Off-Peak Server             | Existing Service caches                |
| Create/edit drafts                         | `OffPeakEditView` local state | Renderer draft                               | Not persisted before user confirmation |
| Selected model / thought                   | Task UI projection            | Off-Peak Task Service/Repo                   | `off_peak_tasks.model/thought_level`   |
| Actual execution Model                     | Current automatic turn        | Registry / ModelFactory created Active Model | Do not write Session Selection         |

### 6.4 Tiered Relationships

| Level          | Relationship                                          | Reason                                                                                       |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| must-inspect   | Registry -> scoped Off-Peak Selection View            | New unique candidates and Reasoning sources                                                  |
| must-inspect   | Off-Peak create/update -> Registry validation         | Prevent invalid selections from taking Ticket or entering DB                                 |
| must-inspect   | Scheduler/Host -> dispatch validation -> ModelFactory | Post-queue expiration must permanently fail-closed                                           |
| should-inspect | `ModelConfigSelect` / Model Thought helper            | Shared display implementation; drafts and submissions still belong to Off-Peak               |
| conditional    | Mock Gateway / E2E ZCode Built-in Config              | Affects only local development and E2E; does not enter production model facts                |
| invariant-only | Account Access / Ticket / Request Auth                | Continue responsible for admission and dynamic access materials; do not decide model members |
| invariant-only | desktop continuous / mobile replayable                | Do not change execution and recovery semantics; no new mobile Off-Peak                       |
| invariant-only | Session Selection / App Recent / Queue                | Idle selection only acts on automatic turns                                                  |

### 6.5 Graph Drift and Subsequent Graph Delta

Current Feature Graph has recorded `off-peak-model-execution -> provider-registry/model-capabilities`, but has not yet clearly recorded
create/edit UI's candidates from fixed hidden Provider's scoped Selection View, and the dual Registry validation at submission/dispatch.

Implementing this Todo supplements the following confirmed semantic edges:

```text
surface.off-peak-creation
  --options-from--> scoped offpeak ModelSelectionView

service.off-peak-task
  --validates-with--> complete Provider Registry

service.off-peak-task
  --persists-selection-boundary-to--> off_peak_tasks model/thought_level

capability.off-peak-model-execution
  --revalidates-before-dispatch-with--> complete Provider Registry
```

Feature graph has concurrent modifications; this plan does not modify graph files when committed, to avoid overwriting adjacent work's graph updates.

## 7. Cases and Pruning

### 7.1 Accepted Cases

| Case ID | Setup                                                 | Action                                    | Assertions                                                                                     | Evidence Layer               |
| ------- | ----------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| OPM-01  | Hidden Off-Peak Provider has two creatable models     | Open create page                          | Normal selection View excludes that Provider; Off-Peak scoped View exactly contains two models | Provider + Service + UI unit |
| OPM-02  | Model has Reasoning Option Spec                       | Switch model and levels                   | UI only reads values/default; submissions as standard Selection semantics                      | Provider + UI unit           |
| OPM-03  | Model without Reasoning Option Spec                   | Switch from reasoning model to this model | Reasoning control hidden; old levels not leaked on submission                                  | UI unit                      |
| OPM-04  | Model or level expired at submission                  | Create task                               | Local stable error; no takeTicket call; no Repo write                                          | Service unit                 |
| OPM-05  | Saved selection during queued/paused expired          | Edit and save                             | Show unavailable and prevent original save; no silent replacement with first item              | UI + Service unit            |
| OPM-06  | History model exited Registry                         | View history                              | Still shows saved strings; does not add to candidates or rewrite records                       | UI unit                      |
| OPM-07  | Model/level exits Registry while queued               | Scheduler dispatch                        | Refused before network; task permanently failed; no transient retry                            | Host/Scheduler unit          |
| OPM-08  | Task without explicit model and scoped View non-empty | Host resolves default                     | Only take current View's ordered first item; no inference from Connection/Catalog/fake Models  | Host unit                    |
| OPM-09  | `ZCODE_OFFPEAK_MOCK=1`                                | Run Off-Peak E2E                          | Product services driven by Mock; model candidates only from test ZCode Built-in Config         | Services + Desktop E2E       |
| OPM-10  | Test attempts unknown models                          | Construct test Registry / submit          | No `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS` entry; clear failures on missing Config                 | Config + Service unit        |

### 7.2 Explicit Pruning

| Combination                                                   | Handling | Reason                                                                                        |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| Mobile `/remote` create or edit Off-Peak                      | pruned   | Current product explicitly unsupported; do not add entries via DTO cleanup                    |
| Remote Workspace Off-Peak                                     | pruned   | Current Off-Peak targets Desktop local Workspaces only                                        |
| Auto-rewrite saved tasks after Registry updates               | pruned   | Task records save historical selections; validated only at edit/dispatch boundaries           |
| Account allowedModelIds filtering idle models                 | pruned   | Account responsible for admission/authentication; does not own off-peak product model members |
| Mock injecting arbitrary models                               | pruned   | Model facts must come from test ZCode Built-in Config / Registry                              |
| Modifying Session Selection, App Recent, or normal busy queue | pruned   | Existing invariants of execution-scoped idle turns                                            |

This Todo focuses on Provider/Services/UI/Host/Scheduler unit tests. Existing Off-Peak Desktop E2E only needs to verify Mock + test ZCode
Built-in Config representative main chain; no new large-scale Conversation E2E added; no changes to conversation case catalog.

## 8. Implementation Order

### Step A: Spec and Failing Tests

- Update Off-Peak spec with candidate View, dual validation, and Mock model fact boundaries;
- Write failing tests for scoped hidden Provider View, UI Reasoning, create/update validation, dispatch permanent failure, and Mock
  ZCode Built-in Config;
- Confirm Todo 03 has published complete Registry Model Config types; if Todo 08 already deleted independent Reasoning State, directly reuse its
  Selection View helpers.

### Step B: Unified Registry Projection

- Extract normal Model Selection and scoped Off-Peak shared Provider/Model View projector at Provider layer;
- Normal Facade continues filtering hidden first, then calling projector;
- Off-Peak services read by fixed Provider ID exactly and call same projector;
- No new `includeHidden` universal parameters.

### Step C: Service Contract and UI

- Close `OffPeakClientConfig` to product views carrying scoped standard Selection View;
- UI directly construct flat selectors from Registry model candidates;
- Reasoning reuses formal Model Thought Option helpers;
- Delete `allowedModels` / `allowedModelConfigs` and Off-Peak legacy thought helpers.

### Step D: Submission and Dispatch Validation

- Create/update validate current Selection before Ticket/Repo;
- Pre-dispatch re-validation; deterministic expiration mapped to permanent failure;
- Host default model reads first ordered item from scoped View;
- No fallbacks from Connection, Catalog, Provider types, or modelId hardcoding.

### Step E: Mock and Old Code Zeroing

- Delete `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS` production parsing, tests, and documentation;
- Retain Mock Gateway and product/service state scenario variables;
- E2E continues deriving test Providers from formal ZCode Built-in Config; only covering Endpoints and necessary test facts;
- Delete call-site-less legacy DTO construction, type imports, helpers, and test fixtures.

### Step F: Verification and Commit

- Run Provider, Coding Plan Subscription, Off-Peak Service, UI, Host/Scheduler affected unit tests;
- Run representative Off-Peak Desktop E2E;
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
- Update Feature Graph confirmed semantic edges;
- Independent Conventional Commit.

## 9. Completion Definition

- Off-Peak production code no longer references `ModelProviderModelConfig`;
- No `allowedModelConfigs` or `allowedModels` used for model facts;
- No `createOffPeakModelConfig()`, `createLegacyReasoningSpec()`, or old Off-Peak Reasoning helpers;
- Normal `ModelSelectionView` still filters hidden Providers;
- Off-Peak scoped View can only parse fixed `OFF_PEAK_PROVIDER_ID`, and reuses formal View projector;
- UI, create/edit validation, default model, and dispatch validation read same Registry revision/structure;
- No `ZCODE_OFFPEAK_MOCK_ALLOWED_MODELS`; test models only from test ZCode Built-in Config / Registry;
- No fake Models, fallback Models, temporary Model Config, or Registry-out-of-model capability inference;
- Expired selections not taking Ticket or writing Repo at create/edit; fail-closed permanently at dispatch;
- Task databases, Tickets, Account Access, Request Auth, Telemetry, desktop continuous, and mobile replayable
  semantics unchanged.

Upon completion, Off-Peak from candidate display to actual execution has only one model abstraction chain:

```text
Built-in / Account / Personal Config
              |
              v
Complete Provider Registry
              |
              v
Scoped ModelSelectionView
              |
              v
ModelSelection
              |
              v
ModelFactory -> Active Model -> Request
```
