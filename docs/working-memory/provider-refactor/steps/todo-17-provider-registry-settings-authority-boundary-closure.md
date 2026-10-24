# 17 Provider Registry and Settings authority boundary closure

> Status: done
>
> Historical note: the Host/Repository authority and fine-grained save boundary established here remain
> valid; the Provider/Model create, delete, source, enable, duplicate-member and ordering interactions were
> re-decided by [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md).
>
> Date: 2026-08-25
>
> Source: a clean review of the newly added Provider implementation and the manual decisions that followed
>
> Related tasks: [`03`](./todo-03-provider-model-ownership-and-property-totality.md),
> [`12`](./todo-12-model-selection-validation-boundary-cutover.md),
> [`13`](./todo-13-target-host-model-selection-authority.md),
> [`14`](./todo-14-post-refactor-mechanical-zero.md),
> [`16`](./todo-16-unplanned-model-abstraction-residue-cleanup.md)
>
> Related design: [`configuration.md`](../design/registry/configuration.md),
> [`settings.md`](../design/registry/settings.md),
> [`registry.md`](../design/registry/registry.md),
> [`model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md),
> [`model-creation.md`](../design/registry/model-creation.md)

## 0. Goal

No new Provider product capability: the implemented code is made to obey the existing design again,
deleting duplicate computation, whole-package write-back, hand-copied fields and early execution judgment
introduced by the new code. One configuration authority chain remains:

```text
Provider Config path
ZCode Built-in Provider Config (online config) + Account Built-in Provider Config (constrains only Built-in)
  -> Effective Built-in Provider Config + Personal Provider Config -> Effective Provider Config

Model Config path
ZCode Built-in Model Config Rules, resolved for the providerId/modelId/api.type of the current Effective Provider
  -> Effective Built-in Model Config + Personal Model Config Rules (array-later) -> Effective Model Config

Effective Provider / Model Config -> Registry complete-type creation entry
   incomplete: issues -> Settings display      complete: Registry Value -> ModelFactory / execution
```

Settings reads the layers the Resolver already computed and edits only Personal; the Registry consumes
only complete results; when a `ModelSelection` really executes, the target ModelFactory makes the final judgment.

## 1. Not done

No Remote Settings CRUD, remote provisioning, remote login, config sync or Remote E2E; no change to the
existing Workspace/Environment service routing (this Todo tidies one already-assembled Provider Service);
no Todo 11 process composition-root refactor; no change to M4, Access product semantics, account plan
resolution, Reasoning Mapping, model-selection persistence or the task queue; no legacy importer,
one-off migration or compat window (the branch is unreleased, so wrong internal formats are deleted
directly); the Provider Config Service never scans or rewrites Session, Composer, Workspace Recent,
Automation or historical Turns; no temporary Registry/Provider Config or second Overlay/completeness
algorithm for Settings.

## 2. Fixed design

### 2.1 The Resolver is the only computer of the three layers

Config Sources -> Resolver producing Effective Built-in Provider Config, Effective Provider Config,
Effective Built-in Model Config, Effective Model Config, conflict/member/enabled/visibility/completeness
issues and the complete Provider/Model that may enter the Registry -> the Settings Facade (organizes and
serializes only) and the Registry Builder (publishes only complete executable items). The Settings Facade
never re-runs the Overlay; the Registry cannot generate Settings data in reverse because it already dropped
disabled, incomplete, duplicate-member and paused Personal conflict items.

Built-in Model Rules act on the final `Effective Provider Config`: a Personal-only Provider and a
user-added Personal Model that match a Built-in Rule first get the Built-in default model config, then the
Personal Rules overlay. `Effective Built-in Model Config` is only the Built-in-Rules resolution for the
current model and does not replace the online config fact source `ZCode Built-in Model Config Rules`.

### 2.2 The Settings View returns layers; the Renderer edits only Personal

```ts
interface ProviderSettingsProvider {
  readonly effectiveBuiltinConfig?: ProviderConfigObject;
  readonly personalConfig?: ProviderConfigObject;
  readonly effectiveConfig: ProviderConfigObject;
}
interface ProviderSettingsModel {
  readonly effectiveBuiltinConfig: ModelConfigObject;
  readonly personalExactConfig?: ModelConfigObject;
  readonly effectiveConfig: ModelConfigObject;
}
```

A Personal-only Provider has no `effectiveBuiltinConfig`. `effectiveConfig` is the server-authoritative
preview for inherited values, final state and issues, never copied into a Personal Draft. It must be named
`personalExactConfig`: Personal Model Config Rules also allow batch-matching rules, and the single-model
page edits only the exact Rule of that `providerId/modelId` (it must not disguise the combined result of all
Personal Rules as one editable config). Restoring a field's default deletes that leaf in
`personalExactConfig`, deletes the exact Rule when empty, then the Resolver re-runs Built-in + all Personal
Rules and returns the new `effectiveConfig` (the restored value may come from another batch Personal Rule,
not necessarily back to the Built-in value).

### 2.3 Provider and Model are saved separately

The set currently shown on the settings page never serves as a full snapshot of the Personal Repository.
Writes follow the unit of the user's operation:

| User operation                                         | Domain write                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| Edit Provider API, Access, Endpoint, Provider enabled  | `savePersonalProvider(providerId, config)`                          |
| Edit Model enabled, Properties, Options, Reasoning Mapping | `savePersonalModelConfig(providerId, modelId, config)`          |
| Restore a Model field                                  | save the exact Config with that leaf deleted; delete the exact Rule when Config is empty |
| Add a Personal Model                                   | atomically add to `provider.modelIds` and save the initial exact Model Config |
| Delete a Personal Model                                | atomically delete the `modelIds` member and the exact Rule it owns  |
| Rename a Personal Model                                | atomically move the `modelIds` member and the exact Rule it owns    |
| Reorder Personal Models                                | only reorder `provider.modelIds`                                    |

A Model enabled button on the Provider page still writes Model Config (where a control appears does not
change config ownership). Remove from the normal save path `savePersonalProvider(providerId, providerConfig,
allVisibleExactModels)` and `replaceExactForProvider(providerId, visibleEntries)`. Deleting a Personal-only
Provider may delete its exact Rules in bulk but the interface must express deletion semantics (for example
`deleteExactRulesForProvider(providerId)`), not a "whole-package replace" that ordinary saves could misuse.

### 2.4 Writes of one Provider keep the user's operation order

The Renderer may keep a local Draft but async writes of one Provider commit in the order they occurred;
different Providers may run in parallel (edit field -> edit model -> rename -> test, each finishing before the next).
- A late response of an earlier save cannot overwrite newer local input or show as latest success.
- Rename waits for the in-flight save of the old ID, then switches later operations to the new ID; the old ID accepts no writes.
- Delete is terminal: after it starts, a late save cannot recreate the Provider.
- A connectivity test waits for pending saves of the related Provider and Model, then tests the saved config.
- Switching settings nodes may keep the local draft or let an already-submitted save finish, but an old node's response cannot overwrite the new node.
- On external refresh, unedited fields follow the new View while fields being edited keep local input; after a successful save the returned View confirms; a failed save keeps input and the error.

This is UI/Service-internal write ordering only: no persisted revision, CAS, transaction protocol or new domain object.

### 2.5 The Registry complete types own the only validated creation entry

`RegistryProviderConfig` and `RegistryModelConfig` express that Effective Config is complete; they are not
another config fact. The bare assertions `config as RegistryProviderConfig`, `config as RegistryModelConfig`
and `config.toJSON() as RegistryModelConfigObject` are folded into one runtime creation entry (API may be
`from()`, `parse()` or equivalent) returning
`RegistryConfigResult<T> = { ok: true; config: T } | { ok: false; issues: readonly ConfigValidationIssue[] }`.
- The entry recursively checks Registry-required fields; the single internal type proof must not leak to callers.
- The Resolver uses this one result for both Settings issues and the Registry value. Completeness answers only "are required fields complete"; enabled, visibility, member conflicts and registration stay with the Resolver.
- The serialization exit of a complete type returns a complete static structure (no optional fields re-exposed).
- Below the Registry there is no `requireComplete...`, no reading `unknown`, no defaults filled for required capabilities; delete every other `as RegistryProviderConfig`, `as RegistryModelConfig` and equivalent assertion in production code.

### 2.6 Fine-grained saving first, then the Visibility projection

`visibility` affects only user entries, not the internal Registry's exact execution: hidden Provider/Model
can still be created exactly by internal capabilities, while the Settings View and Model Selection filter
hidden items. Whole-package Model Rules write-back must be deleted before hiding Settings items, otherwise a
UI save would delete invisible config. On a Built-in vs Personal Model ID conflict Settings still returns
the minimal diagnostics needed to resolve the Personal conflict; ordinary hidden items do not re-enter
settings or model selection lists. The existing `builtinModelIds`, `modelIds`, Built-in-wins, Model enabled
and visibility designs are unchanged.

### 2.7 Provider rename is a pure identity move

`renamePersonalProvider(oldId, newId)` only moves the Personal ProviderConfigMap key `oldId -> newId` and the
exact Model Rules owned by that Provider `oldId/* -> newId/*`. The Provider Config object is kept as is
(`label`, `visibility`, `enabled`, `access`, `api`, `builtinModelIds`, `modelIds`); delete
`withoutProviderLabel()` and every equivalent logic that rebuilds Config by enumerating fields. The settings
page's current navigation node follows the new ID. The Provider Config Service does not rewrite Composer,
Session Selection, Workspace Recent, Automation or history; whether old references stay valid is handled by
the Selection validation at actual task submission and Model construction. The branch is unreleased, so
rename carries no historical-format cleanup, importer or migration.

### 2.8 Connectivity tests exactly one formal Model

User click -> wait for the pending saves of the current Provider/Model -> submit providerId + modelId -> the
target Agent exactly creates the Model with the current Registry's ModelFactory (failure returns the error;
success sends a minimal real request through the formal Adapter). The UI may use the current Settings View's
`executable` for button state, but the Renderer and Host Service no longer simulate final admission via
"Provider selectable + Model appears in the settings list"; a bypassed UI, concurrent invalidation or forged
Selection is rejected by the target ModelFactory. The test never assembles Endpoint, Header, Reasoning
parameters or request body, and creates no independent Probe Adapter; API Key, Request Auth, account access
and Adapter encoding go through the formal Model request chain. One operation tests one Model:

```ts
type ModelConnectivityResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: {
      readonly kind: "auth" | "model_not_found" | "rate_limit" | "network" | "server" | "unknown";
      readonly message: string; readonly httpStatus?: number; } };
```

Delete the single-element `results[]`, `EndpointConnectivityResult`, `endpointType` inference and the
aggregating UI. The test does not change Composer Draft, Session Selection, Workspace Recent or Active Model.

### 2.9 Delete Preview APIs with no production use

`previewPersonalProvider()` and `previewPersonalModelConfig()` have only Service forwarding and tests (no
production UI call) and are deleted. `previewModelConfig(providerId, modelId, apiType)` is used by the
add-Personal-Model page to resolve Built-in/Personal Rules defaults and is kept. The authoritative preview
after saving comes from the Settings View; no server-side whole-page simulation of an unsaved Personal Overlay remains.

## 3. Deviations that were fixed

Registry completeness (bare `as Registry...` -> one validated creation entry returning a complete type or
issues); Settings layers (Personal + Effective only -> Effective Built-in + Personal + Effective); Model
settings naming (`personalConfig` -> `personalExactConfig`); Provider save carrying all Model Config -> saves
only Provider Config; Model save bouncing back to a Provider whole-package save -> saves the one exact Model
Config; save timing (interleaved async requests -> ordered per Provider); Visibility (whole-package save
depending on the UI's current set -> fine-grained save first, then filter); Provider rename
(`withoutProviderLabel()` rebuilt the object and dropped `visibility` -> move Config and exact Rules as is);
Connectivity gate (UI and Host both judging from the Settings list -> the target ModelFactory decides);
Connectivity result (single-element Endpoint array -> one success/failure result); Preview (two simulation
APIs -> deleted, keeping the add-Model rule resolution).

## 4. Impact

Change layers: option-source, validation, commit-effect, persistence. Main entries: `ProviderConfigResolver`,
`ProviderSettingsFacade`, `ProviderConfigService`, `ModelProviderSection`, `InlineEditableProviderCard`, the
Connectivity Service and the target ModelFactory. Out of scope: Remote Settings/Provisioning, M4, Todo 11,
Access/Reasoning product semantics, task and model-selection lifecycle.

| User scenario          | UI entry           | Draft / display                        | Commit                    | Authority                        | Must isolate              |
| ---------------------- | ------------------ | -------------------------------------- | ------------------------- | -------------------------------- | ------------------------- |
| Edit Provider          | Provider detail    | Personal Provider Draft; 3-layer View  | `savePersonalProvider`    | Personal Provider Repository     | Model Rules, Selection    |
| Toggle Model           | Provider model list | single-model exact Draft               | `savePersonalModelConfig` | Personal Model Rules             | other models' Rules       |
| Edit Model             | Model sub-page     | single-model exact Draft               | upsert/delete exact Rule  | Personal Model Rules             | other Provider fields     |
| Add/rename/delete Model | list and sub-page | Personal member operations             | domain atomic operation   | `modelIds` + owned exact Rule    | Built-in members          |
| Rename Provider        | Provider name edit | current providerId Draft               | atomic rename             | Provider Map + owned exact Rules | Session/Recent/Automation |
| Test Model             | Model-row test button | no independent long-term Draft      | `testModelConnectivity`   | no new persistence; formal request | all Selection state      |

Desktop, Web and Mobile reuse the same UI/Service contract; no new remote config editing. Shared facts:
Overlay is computed by the Resolver (Settings keeps failed candidates, Registry only complete executable
items); Drafts express Personal intent only; Visibility comes from Provider/Model Config (internal Registry
keeps hidden, user entries filter); execution always goes through Registry/ModelFactory (Connectivity sends
a fixed minimal test request); the Personal Repository is the only user-config sink (Connectivity stores no
execution state or test-only config). State ownership: the Renderer owns only uncommitted input; the Personal
Repository owns user config; the Resolver owns three-layer computation and diagnostics; the Registry owns the
current executable index; ModelFactory owns the final build of a concrete Selection. The Feature Graph already
declares these semantics; only symbol moves require code-seed updates. No open scope-changing question.

## 5. Order (each slice: failing tests first, then implementation; not one commit)

A. Update the long-term specs (`configuration.md`, `registry.md`, `settings.md`, `runtime.md`, `model-membership-and-enablement.md`), deleting wrong statements (Remote Settings in scope, rename rewriting the current Model Selection, a legacy importer cleaning up, whole-package Provider+Model Draft). B. Registry complete types and Resolver output (tests for complete creation, recursive missing-field issues and complete serialization; unique validated entry; Resolver uses the same result for issues or Registry value; explicitly keep Effective Built-in Provider/Model Config; Personal-only Provider/Model still match Built-in Model Rules; delete optional/`unknown` adaptation and duplicate completeness checks below the Registry). C. Settings three-layer View (Provider View `effectiveBuiltinConfig/personalConfig/effectiveConfig`, Model View `effectiveBuiltinConfig/personalExactConfig/effectiveConfig`; restore a leaf then Resolver recomputes, never inferring Personal from Effective; Renderer copies only Personal / Personal Exact into Drafts; batch Personal Rules' effect on final Effective is kept). D. Separate Provider and Model saves (`savePersonalProvider()` drops the `exactModels` parameter; Model sub-page and Provider-list enabled use `savePersonalModelConfig()`; restoring deletes the leaf of the exact Config, an empty Config deletes the Rule; atomic add of member + initial exact Rule; delete/rename/reorder use explicit domain operations; delete `replaceExactForProvider()` from the normal path and `persistModelProvider()` iterating all models). E. Save order and Visibility (per-Provider ordering, tests for save-then-rename, save-then-delete, test waiting for save, page switching, late responses; external View updates only untouched fields; filter hidden only after fine-grained save; keep the minimal diagnostic for hidden Built-in vs Personal same-name). F. Provider rename (retention tests including `visibility`, `label`, Access, API, member fields; delete `withoutProviderLabel()`; move Config and owned exact Rules in order; navigation follows the new ID; delete rename-related importer/migration plans and tests). G. Connectivity (test waits for committed saves; delete UI helper and Host Service Registry admission duplicates; hand the exact `ModelSelection` to the target Agent via the existing Workspace execution chain; the target Agent validates with the current Registry/ModelFactory and sends through the formal Model/Adapter; single success/failure union; verify no change to Composer, Session, Recent, Active Model or Registry config). H. Delete useless new interfaces and glue (the two Personal preview APIs and forwarding/types/tests; keep `previewModelConfig()`; re-check via `pnpm dep:refs` and exact text search that old preview, whole-package save, bare complete-type assertions, `withoutProviderLabel()` and Endpoint connectivity types have no production references; update the implementation log; the Feature Graph only if a real symbol/code seed changes).

## 6. Accepted cases

| Case ID | Setup                                             | Action                              | Assertions                                                         | Evidence layer            |
| ------- | ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| PRS-01  | complete Effective Provider/Model                 | create Registry Config              | returns the complete static type; complete serialization           | Provider unit + typecheck |
| PRS-02  | missing Endpoint or Model format leaf             | create Registry Config              | precise issues; not entering the Registry                          | Provider unit             |
| PRS-03  | Built-in + Account Built-in + Personal, one Provider | get Settings View                | Effective Built-in, sparse Personal, final Effective               | Resolver/Facade unit      |
| PRS-04  | Personal-only Provider/Model matches a Built-in Rule | get Settings View                | Provider has no Built-in layer; Model gets the Built-in Rule defaults | Resolver/Facade unit   |
| PRS-05  | exact Rules for models A, B under a Provider      | save only A                         | B's match condition, content and order semantics unchanged         | Config Service unit       |
| PRS-06  | a Personal exact Rule the UI does not show        | edit Provider fields                | the invisible Rule is kept                                         | Service + UI unit         |
| PRS-07  | ordinary hidden Provider/Model                    | get Settings/Selection; internal exact create | not shown on user entries; internal creation still succeeds | Facade + Registry unit  |
| PRS-08  | hidden Built-in vs Personal same-ID conflict      | get Settings                        | only diagnostics that resolve the conflict; Built-in still executable internally | Resolver/Facade unit |
| PRS-09  | Personal Provider with all optional fields        | rename Provider                     | all Config fields and order kept; owned exact Rules migrate        | Config Service unit       |
| PRS-10  | quick consecutive edits of one Provider           | submit two operations               | final state follows user order; an old response does not overwrite new input | UI/Service unit |
| PRS-11  | disabled/incomplete Model                         | UI click or bypass-UI test call     | UI disabled; a bypass is rejected by the target ModelFactory       | UI + Agent unit           |
| PRS-12  | saved executable Model                            | test connectivity                   | the formal Model/Adapter finishes the request; single result; Selection state unchanged | Service/Core integration |
| PRS-13  | Registry update invalidates the model between save and request | test connectivity       | the target ModelFactory rejects by the current Registry, not trusting the Host's old View | Agent integration |
| PRS-15  | batch Personal Rule + single-model exact Rule     | restore the exact leaf              | final value recomputed from all Rules, may return to the batch Personal value | Resolver/Facade unit |
| PRS-16  | user editing while an external View updates       | receive the new View                | dirty fields kept; unedited fields updated                         | UI unit                   |
| PRS-17  | save unfinished                                   | rename Provider                     | old-ID save finishes first, then identity migrates; old ID not rebuilt | UI/Service unit        |
| PRS-18  | save unfinished                                   | delete Provider                     | a late save after deletion cannot resurrect the Provider           | UI/Service unit           |
| PRS-19  | Provider/Model has pending saves                  | click test                          | waits for saves, then tests the latest formal Model                | UI/Service integration    |
| PRS-20  | new Model input matches existing Rules            | request `previewModelConfig`        | returns rule-resolved defaults; nothing persisted                  | Facade/UI unit            |

PRS-05 compares the resolved Rule's identity, order, match condition and config content (not raw bytes such as indentation).

## 7. Pruning and invariants

Pruned: all Provider API/Access cartesian products (no Access/Adapter product semantics change; API Key and existing account/Request Auth keep one regression each); conversation phase, queue, goal (Settings owns no task state; Connectivity asserts Selection/Active Model unchanged); Remote Settings/Provisioning/login/sync (separate product capability; no PRS or Remote E2E); legacy importer/migration (unreleased branch, update current fixtures/schema); other scope of Todo 11, M4 and Todo 13.

Must hold: Provider Overlay order ZCode Built-in -> Account Built-in -> Personal; Account Built-in only constrains ZCode Built-in Providers and Personal always overrides last; Model Rules = ZCode Built-in Rules + Personal Rules acting on the Effective Provider; Personal Config and Personal exact Rule always stay sparse and never expand from Effective; ownership, conflict, order and enabled design of `builtinModelIds` and `modelIds` unchanged; Config updates affect only later-created Models (created Active Models are not hot-edited); hidden is product visibility, not an auth, security boundary or execution exemption; Connectivity changes no user model selection and stores no test Runtime state; Settings UI never calls the Repository directly nor parses Config Rules itself.

## 8. Verification and done

Tests per slice: failing Provider/Services/UI/Agent unit tests first (Provider unit: Overlay, complete type, serialization, conflict, Visibility, rename and exact-Rule mutation; Services unit: three-layer View, save order, Connectivity error projection; UI unit/component: separate Provider/Model save, Model sub-page, enable, restore, dirty Draft and test button; Agent/Core integration: ModelFactory final validation and the formal Adapter request); existing Provider Settings E2E covers the user main path (no new Remote Settings cases); finally `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check` and affected tests.

Done (all met): the Resolver is the only computer of Effective Built-in, Personal, Effective and diagnostics; Settings View returns explicit three-layer facts and the Renderer edits only Personal/Personal Exact; Registry complete types only come from the one validated entry (no `require`, `unknown` or bare assertions downstream); Provider and Model saves fully separate with no ordinary operation replacing other Model Rules wholesale; same-Provider async operations keep user order with tests for rename/delete/test and late responses; Visibility filtering loses no hidden config and conflict diagnostics plus internal exact execution stay correct; Provider rename does not rebuild Config, does no compat cleanup and rewrites no Selection across domains; Connectivity is finally validated by the target ModelFactory, returns a single result and keeps no Endpoint aggregation glue; the two Personal Preview APIs and forwarding are deleted (add-Model rule preview kept); long-term Design, implementation log and necessary code seeds match the final code; all accepted cases and mandatory checks pass; slices committed as Conventional Commits without mixing Todo 11, M4 or remote-config product capability.

## 9. Implementation record (2026-08-25)

- The Resolver now alone computes the Effective Built-in, Personal and Effective layers and uses the one complete-type creation entry to produce issues and the Registry Value; complete serialization no longer goes through a sparse `toJSON()` assertion.
- The Settings View explicitly returns Provider `effectiveBuiltinConfig/personalConfig/effectiveConfig` and Model `effectiveBuiltinConfig/personalExactConfig/effectiveConfig`; ordinary hidden items are filtered after fine-grained writes finish.
- Provider and Model saves are fully split. Adding a Personal Model atomically writes the member plus its initial exact Rule; delete, rename, reorder and restore-default use explicit domain operations; the normal UI path no longer iterates all visible models or replaces whole Rule sets.
- Writes of one Provider are serialized by the Facade; the success/failure identity boundaries of rename/delete, old-ID rejection, and merging of external View with dirty fields are tested; connectivity waits for that queue before submitting the exact Selection to the target Environment. Provider rename moves Config and owned exact Rules as is and modifies no Selection or other domain state.
- Connectivity uses the formal Agent ModelFactory/Adapter chain and returns a single result; the Host's duplicate admission judgment, Endpoint aggregation, `endpointType` inference and the two Personal Preview APIs with no production use are deleted.
- `pnpm knip` still reports the repo's large pre-existing unused/unlisted baseline; deleted symbols and the whole-package save entries were additionally confirmed to have no remaining production references via `dep:refs` and exact text search.
