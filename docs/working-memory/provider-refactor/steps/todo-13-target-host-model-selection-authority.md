# 13 Target Host model-selection authority and retirement of the old preparation chain

> Status: done (2026-08-25)
>
> Predecessor: [`todo-12-model-selection-validation-boundary-cutover.md`](./todo-12-model-selection-validation-boundary-cutover.md)
>
> Related design: [`../design/interaction/selection-state.md`](../design/interaction/selection-state.md),
> [`../design/environment/environment.md`](../design/environment/environment.md),
> [`../design/registry/registry.md`](../design/registry/registry.md)

## 0. Goal

User model candidates, model Option Specs, Configured Default and the initial selection of a new Session
all come from the **Host of the target Environment**: Local Host for local Workspaces, Remote Host for
remote Workspaces. The Renderer no longer derives target-Environment model facts from the Base Host global
snapshot, a temporary Agent App, a Session Runtime Catalog or `configOptions`.

```text
Target Workspace
  -> Local Workspace  -> Local Host ModelSelection
  -> Remote Workspace -> Remote Host ModelSelection
  -> Entry Draft / App Recent
  -> Sparse Structured ModelSelection
  -> Target Worker Registry
  -> Active Model
```

The Host owns selection facts and returns `preferredSelection` (Configured Default/Fallback already
resolved) in the same View; the Renderer only layers Composer/Draft and workspace App Recent on top. The
Worker Registry / ModelFactory still does final execution validation and Model creation. The Host is not a
second execution Registry, and holding a Host View does not let the Renderer construct or guess Models.

## 1. Confirmed decisions

### 1.1 Model selection reads the target Host

- Local Workspace candidates come from Local Host `IModelSelectionService`; SSH, WSL, Docker and Server
  Workspaces from the matching Remote Host `IModelSelectionService`.
- `remote-waiting`, disconnect or an unavailable target Host stays loading/unavailable and never falls back to Base/Local Host.
- The Remote Host returns its own Provider/Model View; Desktop never injects a local Registry Snapshot into a remote.
- The Worker re-validates the Selection against its own Environment Registry/ModelFactory at execution time; a Host choice cannot bypass the final fail-closed.

### 1.2 Workspace key and App Recent

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
App Recent scope = App x workspaceKey
```

- No new `environmentId` and no new Host identity repository.
- Remote Workspaces carry the existing `workspaceIdentity` end to end; local may fall back to `workspacePath`. `remoteSessionId` routes remote connections/sessions but does not replace stable Workspace identity.
- Remote Workspaces with the same `workspacePath` but different `workspaceIdentity` never share Recent. `workspacePath` stays file/command/Git/display only.
- App Recent stores a structured sparse `ModelSelection`, updated only when the App accepts an ordinary user Submission. Menu browsing, model clicks, Goal auto-continuation, Background, Off-Peak and Subagent do not write it.

### 1.3 Host View atomically returns candidates and preferred Selection

- Configured Default belongs to the target Workspace. Desktop/Web Renderer never reads `.zcode/v2/model-selection.json`; the target Host reads it and resolves the preferred Selection atomically with the user-visible View.
- Prompt CLI and TUI need no Host/RPC but must reuse the same provider-domain preferred resolver and Workspace repository.
- Fallback uses only visible, enabled, selectable models of the current Host View (hidden Provider/Model excluded) and only initializes this Draft/Session; it never overwrites the persisted Configured Default.
- No separate `resolveInitialSelection()` RPC: candidates, Option Specs and `preferredSelection` are in one `ModelSelectionView`.

```text
App new Session:  existing Composer / Draft
                  > workspace App Recent still selectable in the current View
                  > Host preferredSelection
Prompt CLI / TUI: explicit Draft / argument > domain preferredSelection
```

Restoring an existing Session never reads Configured Default; the persisted Session Selection wins.

### 1.4 Formal selection and persistence use sparse structured `ModelSelection`

Composer Draft, App Recent, Session Selection, Automation record, Repo Wiki generation settings, Bot model
preference/config, Off-Peak task selection, Custom/Workspace/Built-in Subagent model override and any future
product config that creates a Model no longer assemble a selection from a `model` string plus a separate
`thoughtLevel`. The only target structure:

```ts
interface ModelSelection {
  providerId: ProviderId;
  modelId: ModelId;
  options?: {
    reasoningLevel?: string;
    maxOutputTokens?: number;
  };
}
```

- `options` holds only options explicitly given by the user/caller; Option Spec defaults are not copied. `options` and each leaf may be absent; `options: {}` normalizes to missing; a formal Selection never stores option `null`.
- Patch/update APIs may use `null` to clear an explicit override; the repository deletes the leaf instead of persisting `null`.
- Explicitly choosing a value equal to the current default is still an explicit pin and is saved; only "use default" deletes the leaf.
- `inherit` is expressed by the outer field missing or an explicit product union, never a fake model string.
- A picker may use string key/value internally but restores `ModelSelection` at the `onSelect` boundary. CLI arguments and the published Legacy importer may parse strings; formal Domain, RPC, Registry, Runtime and new writes never store string selections.
- `modelSelectionSchema` (defined only in Shared) is the single strict schema; UI, Services, Provider Node, Contracts, Protocol and Bootstrap reuse it, no copied parsers.
- Published persistent formats are converted one-way at the repository/importer boundary; unpublished in-branch formats get no dual read/write or v1/v2 compatibility.

ModelFactory is the default-resolution boundary:

```text
product Draft / Config / Record (modelSelection?: does the product fix a model)
  -> ModelSelection { providerId + modelId, options: explicit overrides only }
  -> + current Model Config Option Spec defaults
  -> Target Worker ModelFactory
  -> Active Model.options (complete, immutable execution fact)
```

Resolved defaults are never written back to Composer, Session, App Recent or product records. A Config
default change only affects Models created later from a sparse Selection and never hot-edits an Active
Model. Audits needing the real option store Active Model/execution facts, not reinterpret an old
Selection with new defaults.

### 1.5 Subagent config belongs to each Environment; this round's UI manages Local only

Each Environment owns and persists its own Subagent config (user, workspace, built-in overrides).

- Settings UI uses only Local Host `ISubagentsService`; candidates and Option Specs come from the Local Host Model Selection View.
- Remote Workspaces are not listed as an edit scope; when a remote Workspace is active the entry stays explicitly "local config" or shows that remote management is unsupported.
- Desktop never writes local Subagent Markdown/state into a Remote Environment.
- Remote Agent execution reads the Remote Environment's existing Subagent config and validates/creates the child Model with Remote Registry/ModelFactory.
- Remote Subagent config browsing, editing, sync and conflict handling is a later independent product capability.

### 1.6 Relation to Todo 12 validation boundary

The generic `IModelSelectionService.validate()` is not restored.

```text
Host user surface: getView(), onDidChange() -> one View with visible/selectable candidates, Option Specs, preferredSelection
Execution: ModelSelection -> Target Worker Registry -> ModelFactory final full validation
```

- Conversation submits the structured Selection to the Worker; the final failure is reported by ModelFactory.
- The Renderer may show unavailable from the Host View but does not duplicate an authoritative option validator.
- Automation, Repo Wiki, Bot, Off-Peak and Subagent may do narrow early checks at their own Host product Service save/dispatch boundary (to avoid saving obviously invalid config or wasting resources); these never enter the public user Facade nor replace Worker validation.
- Hidden Off-Peak keeps using the Host-internal Registry/scoped View and never enters the ordinary user View.

### 1.7 Relation to earlier phase documents

- Todo 09's "do not change the Task database shape" only bound Todo 09's scope; Off-Peak repository/API moves to structured `ModelSelection` here and no longer keeps a `model + thoughtLevel` projection.
- `docs/subagents-built-in-model-overrides.md` reconciling candidates/reasoning through the `workspace/readState` Runtime Catalog is old implementation fact; now Settings reads the Local Host View and Remote Subagent execution reads the Remote Environment's own Registry.
- Todo 12's final validation boundary stays; this Todo only adds target Host routing and Host View preferred resolution.

These overrides concern only model-selection source, persistence shape and validation boundary; Todo 09 Ticket/scheduling semantics are untouched.

## 2. Problems removed

1. **Global Base Host View polluted remote selection.** Root connected `modelSelectionService` once; conversation, Automation, Subagent and Repo Wiki read the same global snapshot via `useModelSelectionView()`, and the `SessionPane` readiness gate bound `baseWorkspaceServices.modelSelectionService`. Remote pickers could show missing models or fail only at the Remote Worker.
2. **Temporary App used as a model projector.** `workspace/readState` created a full temporary `ZCodeApp` with a state-only fake Adapter and `mapSessionSettings()` to produce `model + thought + configOptions`; also used by Automation preview, Repo Wiki, Subagent reconciliation, Bot, Off-Peak user models and the Git Commit sidecar. The Host View already contains Model Config and Option Specs.
3. **Duplicate default owners:** Renderer global `localStorage` model/thought preference, Agent Server `workspaceModelPreferences.defaultModel/lastUsedModel/defaultThoughtLevel`, Environment `.zcode/v2/model-selection.json` Configured Default, and the active/temporary App projection.
4. **String selections and duplicate schemas:** `provider/model$reasoning` cannot round-trip `maxOutputTokens`; UI, Services, Provider Node, Contracts and Bootstrap each had format/parse/Schema.
5. **Effective Option written back into explicit Selection** (for example Session restore materialized an absent `maxOutputTokens`, turning "follow the default" into "pin the old value"):

```text
wrong:   Sparse Selection + Model Config Default -> Effective Option -> written back to Selection
correct: Sparse Selection stays as is; + Model Config Default -> Active Model.options (this execution's complete fact)
```

The same risk was checked in Session restore, Model switch, Automation/Off-Peak dispatch, Compact/Memory/Subagent, CLI arguments, RPC round-trip and Draft persistence. UI showing the current default is not a user selection; only a real edit creates an override. 6. **One type is not one product owner.** `ModelSelection` unifies only how a future Model is referenced:

| Product state     | Meaning of missing `modelSelection`                                          | Resolution timing / owner       |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| Composer / Draft  | initial value by initialization priority                                     | Renderer Draft                  |
| Session           | may be absent before first execution; accepted Selection must be saved after | Session Store/Core              |
| Automation        | resolve target Host preferred at form creation and fix a concrete Selection  | Automation record/service       |
| Repo Wiki         | use target Workspace preferred                                               | each generation submit boundary |
| Bot               | product default rule of the Workspace for the Bot context                    | Bot config/task submission      |
| Subagent override | inherit Parent Active Model; no Workspace default lookup                     | Parent/child execution boundary |
| Off-Peak          | task creation forms its own exact provider/model Selection                   | Off-Peak record/dispatcher      |

Whole `modelSelection` missing means the product fixes no model; `modelSelection.options` missing means identity is fixed and options follow Model Config defaults. Do not conflate them with an empty string, an `inherit` fake ID or a global fallback helper. Automation UI has no "follow Workspace"/"default model" virtual state: the create form, old records without a Selection and target-Workspace switches initialize a concrete provider/model from the target Host `preferredSelection` (reasoning resolved from the target Option Spec) and always save a complete `modelSelection`; later Workspace preferred changes do not affect saved Automations.

## 3. Impact summary

Change layers: `option-source`, `draft-default`, `validation`, `persistence`, `recovery`. Out of scope:
Provider Provisioning, Access/Auth, model request encoding, Queue/Goal state machine, remote Subagent config management.

| Scenario                  | Candidate/default source                       | Draft owner           | Commit sink                | Final authority                     |
| ------------------------- | ---------------------------------------------- | --------------------- | -------------------------- | ----------------------------------- |
| Conversation local        | Local Host View/preferred                      | Composer Draft        | Submission command         | Local Worker Registry/ModelFactory  |
| Conversation remote       | Remote Host View/preferred                     | Composer Draft        | Remote Submission command  | Remote Worker Registry/ModelFactory |
| Automation                | Host of the form's Workspace                   | Automation form       | Automation Service/record  | executing Environment ModelFactory  |
| Repo Wiki                 | current project's Host                         | generation settings   | Repo Wiki Service          | target Environment ModelFactory     |
| Bot                       | Host for the Bot context                       | Bot command draft     | Bot config/Task submission | target Environment ModelFactory     |
| Off-Peak                  | Local Host scoped hidden View                  | Off-Peak form         | Off-Peak Service/record    | Local Worker ModelFactory           |
| Subagent Settings         | Local Host View                                | Subagent form         | Local `ISubagentsService`  | Local Environment config            |
| Remote Subagent execution | no UI this round                               | Remote profile/config | Agent tool                 | Remote Worker ModelFactory          |
| Git Commit sidecar        | request target Host initial/explicit selection | single request        | text generation service    | target Environment ModelFactory     |

State owners: Model Selection View = target Host Provider Registry Facade (UI snapshot cached per Host
service instance, changes on Registry revision); Composer Draft = Entry/Renderer; App Recent = App x
workspaceKey; Configured Default = target Workspace repository (resolved into `preferredSelection`);
Session Selection = Session Store/Core (written when a Submission starts the Loop / Guide accepted); Active
Model = Agent Loop (not persisted); product selections = each product Service/Repo; Subagent Config = each
Environment's repository (Settings sees Local only).

Graph drift: the Feature Graph still linked some candidate edges to old `useModelProviders`/app-global
metadata and described Workspace Subagent reasoning as the `workspace/readState` Runtime Catalog; these
were updated to "ordinary product candidates from target Host; Subagent Settings from Local Host".

## 4. Host contract

```ts
interface ModelSelectionView {
  revision: number;
  providers: readonly ModelSelectionProviderView[];
  preferredSelection?: ModelSelection;
}
interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(): Promise<ModelSelectionView>;
}
```

- Model View's full Model Config contains `properties` and `optionSpecs`; UI reads them directly and never creates a Session to obtain them. `preferredSelection` belongs to the same-revision visible, enabled, selectable View and may be absent for an empty View.
- The Host resolves Configured Default and fallback when building the View. Entry's own workspace App Recent is not uploaded; the Renderer checks only whether it is still in the current View (valid wins, else `view.preferredSelection`). This candidate matching serves initial display only, does not resolve hidden exact execution selections and is not a ModelFactory-replacing validator.
- Target-scoped hook:

```text
workspacePath + workspaceIdentity + remoteSessionId + remoteTarget
  -> useWorkspaceServicesResolution
     local-ready  -> Local Host IModelSelectionService
     remote-ready -> Remote Host IModelSelectionService
     remote-waiting/disconnected -> unavailable (no fallback)
```

Snapshot/cache is isolated per target service instance and `workspaceKey`. Switching target cancels the old
subscription and drops late Views; the same revision number from different Hosts never overwrites each other
(late events dropped by connection generation).

## 5. Deletions and changes (done)

- UI/Services: removed Root singleton `modelSelectionSnapshot` and `useRootModelSelectionSnapshot`; `useModelSelectionView()` is target-scoped; `SessionPane` readiness gate uses the pane's target Host; `ModelConfigSelect` separates internal value from business `ModelSelection`; Automation switches Host View atomically on Workspace change (late results never written to the new target); Repo Wiki uses the current project Host View and drops the deferred draft Session reasoning preview; Bot uses its target Host and fails closed when the remote connection is missing; Git Commit sidecar gets selection from the target Host; Subagent Settings is pinned to Local Host Model Selection/Subagents Service with the remote scope removed.
- Agent Protocol/temporary App: `workspace/readState` no longer returns Model Selection/Option Specs; removed `workspaceModelPreferences.defaultModel/lastUsedModel/defaultThoughtLevel`, `workspace/setDefaultModel`, `workspace/setDefaultThoughtLevel` (RPC, adapter, mock, tests), `createWorkspaceStateOnlyModelAdapter()` and the temporary `ZCodeApp` state path. Non-model mode/slash-command needs use their own minimal interface. Session active projection reports the Session's actual Selection only.
- Structured persistence: App Recent is `workspaceKey -> ModelSelection`; Automation, Repo Wiki, Bot, Off-Peak and Subagent shared types, strict schema, RPC and repository use `ModelSelection` and persist only explicit options (empty `options` and cleared leaves normalized away); removed every restore/preview/save helper writing resolved defaults back; Custom Subagent Markdown frontmatter and Built-in override state use one structured Selection field (no model/thought double map); published old storage is converted only at repository/importer read boundaries; `formatModelSelection()` remains only for explicit CLI/picker/legacy variants; duplicate `modelSelectionSchema`, `parseModelSelectionValue` and business-layer local parsers removed.
- Kept: Provider Registry, ModelFactory, Active Model and Adapter execution chain; Session Submission, Queue, Guide, Edit, Retry structured intent; hidden Off-Peak Provider scoped View and pre-dispatch narrow checks; separate write timings of App Recent, Configured Default, Session Selection, Active Model; Prompt CLI/TUI in-process Entry (no forced Host RPC).

## 6. Accepted cases

| Case ID | Setup                                                                 | Action                                 | Assertions                                                                               |
| ------- | --------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| HMS-01  | Local Workspace, Local Host has model A                               | open new Draft                         | candidates and initial Selection come from Local Host                                    |
| HMS-02  | Remote Host only has B, Local Host only A                             | open remote Draft                      | only B shown; never shows or falls back to A                                             |
| HMS-03  | Remote Host waiting/disconnected                                      | open model menu / send                 | loading/unavailable; Local Host not called                                               |
| HMS-04  | two remote Workspaces, same path, different workspaceIdentity         | each accepts a Submission              | App Recent isolated by workspaceKey                                                      |
| HMS-05  | App Recent invalid in target Host View, preferred valid               | create new Draft                       | uses Host preferred; Recent/Default not overwritten                                      |
| HMS-06  | Recent invalid and Host View has no preferred                         | create new Draft                       | stays unavailable; Renderer does not pick the first item                                 |
| HMS-07  | Registry removes the current model after Draft creation               | keep editing                           | original Selection kept and shown unavailable; no silent swap                            |
| HMS-08  | existing Session Selection becomes invalid                            | restore / next execution               | Session intent kept; ModelFactory fails explicitly; Default not read                     |
| HMS-09  | Queue/Guide/Edit/Retry carry partial explicit options                 | admission/execution                    | Selection keeps explicit leaves and adds no absent leaves                                |
| HMS-10  | Automation switches between local and remote projects                 | switch target, pick model, cancel/save | View follows Host; cancel does not change Conversation; save writes structured Selection |
| HMS-11  | Repo Wiki picks a reasoning model                                     | open/generate                          | Option Specs from target Host; no preview Session                                        |
| HMS-12  | Settings opens Subagent in a remote Workspace context                 | view/edit entry                        | expresses local config or remote unsupported; no Remote config read/write                |
| HMS-13  | Remote Agent has its own Subagent config                              | trigger child                          | reads Remote config; Remote ModelFactory creates the Model                               |
| HMS-14  | old product storage holds model + thought                             | repository read then save              | one-way converted to ModelSelection; new writes do not split fields                      |
| HMS-15  | Desktop continuous and Mobile replayable control the same remote task | select and send                        | same Remote Host; queue/snapshot/replay owners unchanged                                 |
| HMS-16  | Selection fixes only provider/model; Model Config has default options | create Model                           | Active Model gets full defaults; Selection stays without options                         |
| HMS-17  | user explicitly picks reasoning equal to current default              | save and reload                        | explicit leaf kept; later default changes do not move the pin                            |
| HMS-18  | patch clears the last explicit option                                 | save and reload                        | no persisted `null` or `options: {}`                                                     |
| HMS-19  | Session restore meets absent maxOutputTokens                          | restore and create Model               | default only enters Active Model, not Session Selection                                  |
| HMS-20  | switch from model A to B with different Option Specs                  | pick B                                 | A's options not inherited; only explicit choices for B saved                             |
| HMS-21  | Automation create form, target Host has preferredSelection            | save without picking a model           | saves concrete provider/model/reasoning; button submittable                              |
| HMS-22  | Automation saved with a concrete modelSelection                       | change Host preferred, dispatch        | keeps the saved Selection, no drift with Workspace preferred                             |

Pruned: Provider API type combinations (no Adapter encoding change); remote Subagent Settings CRUD/sync/conflict;
merging the Off-Peak hidden View into the ordinary View; Queue, Goal, Compact, Background, permission and
recovery state machines; extra Host processes for Prompt CLI/TUI; compat matrix for unpublished in-branch formats.

Mechanical gate: these production concepts must be zero (or only explicit compatibility boundaries):
`modelSelectionSnapshot`, `useRootModelSelectionSnapshot`, `GLOBAL_AGENT_MODEL_STORAGE_SCOPE`,
`workspaceModelPreferences.defaultModel`, `workspaceModelPreferences.lastUsedModel`,
`workspaceModelPreferences.defaultThoughtLevel`, `workspace/setDefaultModel`,
`workspace/setDefaultThoughtLevel`, `createWorkspaceStateOnlyModelAdapter`,
`previewAutomationThoughtLevelOption`, `prepareRepoWikiThoughtCatalog`,
`useSubagentWorkspaceCatalogReconciliation`. `formatModelSelection`, `parseModelSelection`, `model` +
`thoughtLevel` are not zeroed by name: CLI arguments, legacy importers and non-model business fields may
legitimately keep them; only formal selections must migrate.

Test layers: unit/service (workspaceKey fallback and isolation, preferred/default/fallback/unavailable
priority and revision consistency, visible/hidden/invalid options, local/remote/remote-waiting routing,
late subscriptions and rapid target switches, sparse option normalization, ModelFactory default resolution,
restore/switch no write-back, repository round-trips, legacy importer one-way, Subagent Local-only scope);
integration/E2E (Local A / Remote B real first request, reconnect, per-workspaceKey Recent, Worker creates
Model for first and later messages, Automation/Repo Wiki/Bot/Git Commit target Environment, Subagent local
CRUD vs Remote runtime config, desktop continuous and Web/Mobile replayable paths).

## 7. Definition of done and non-goals

Done (all met): ordinary candidates and Option Specs come from the target Host; Remote UI/defaults/product
entries never read Local/Base Host Registry; App Recent isolated by `workspaceKey` with sparse structured
Selection and no `environmentId`; Configured Default/fallback resolved by the target Host and returned in the
same View (Prompt CLI/TUI reuse the pure domain resolver); formal selections of Conversation, Automation,
Repo Wiki, Bot, Off-Peak and Subagent are structured and persist only explicit options; Subagent config is
per-Environment and Settings manages Local only; `workspace/readState`, temporary App and `configOptions`
no longer carry model catalog, capabilities or defaults; Todo 12 ModelFactory final validation stays;
no Local fallback or identity mixing across local/remote/reconnect/workspaceKey caches; Desktop continuous,
Mobile replayable, Queue, Goal, Session recovery and Provider Provisioning unchanged; Design, Feature Graph,
tests and deletion audit written back.

Non-goals: remote Provider/credential Provisioning; remote Subagent config UI/sync/merge; Account Access,
Request Auth or server authorization; Adapter encoding, Retry, Stream Recovery, Telemetry; Model Properties,
Provider membership, enabled/visibility semantics; writing Host View, workspaceKey or remoteSessionId into
Session Selection; any new Model Catalog, Runtime capability DTO, Execution Registry or ModelIdentity.

## 8. Implementation result

- `ModelSelectionView` from the target Local/Remote Host provides candidates, Option Specs and `preferredSelection`; Remote unavailable never falls back to Local.
- `SessionPane` resolves the target Host View once; Composer, row display and submission share it. App Recent stores sparse Selection per `workspaceKey` and updates only after an ordinary user Submission is accepted.
- Workspace presentation keeps only mode and slash commands.
- Automation, Repo Wiki, Bot, Off-Peak and Subagent config, protocol and repository are structured `ModelSelection`; old strings are read one-way only inside each published-format importer.
- An Automation record remains a Select that may lack a model; each `automation_runs` row fixes the Submission Selection atomically on first dispatch, and scheduler retries read it back and never re-read Host preferred.
- Subagent Settings connects only to Local Host; a Child Submission without override inherits the Parent Active Model; an explicit override creates and freezes its own Model through the Worker ModelFactory.
- Editing the same model keeps option leaves that are not displayed but were saved explicitly; cross-model switch rebuilds the Selection and inherits no old options.
- Removed legacy production entries: Root global Snapshot, Workspace model preferences, Draft Global Seed, Repo Wiki Runtime Thought Catalog, Subagent Workspace Catalog reconciliation, plus helpers, tests and exports.
