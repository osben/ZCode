# 16 Zeroing unplanned Model abstraction residue

> Status: done
>
> Date: 2026-08-25
>
> Source review: old-abstraction diff review after the Provider Refactor completed
>
> Related tasks: [`01`](./todo-01-core-model-adapter-boundary-cleanup.md),
> [`08`](./todo-08-legacy-model-catalog-retirement.md),
> [`13`](./todo-13-target-host-model-selection-authority.md),
> [`14`](./todo-14-post-refactor-mechanical-zero.md)
>
> Related design: [`../design/model/contract.md`](../design/model/contract.md),
> [`../design/model/model.md`](../design/model/model.md),
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md),
> [`../design/registry/registry.md`](../design/registry/registry.md),
> [`../design/registry/runtime.md`](../design/registry/runtime.md),
> [`../design/interaction/interaction.md`](../design/interaction/interaction.md),
> [`../design/interaction/selection-state.md`](../design/interaction/selection-state.md)

## 0. Position

This file collects old Model/Provider abstraction residue confirmed in the 2026-08-25 code review and not
yet covered by Todo 11-15. Items already planned by Todo 13 (target Host, structured `ModelSelection`,
temporary App, string-selection old chain) and Todo 14 (MCS, `RuntimeModelFactoryInput`, Legacy Provider
Store DTO, known dead files) are not repeated. No new domain abstraction is created: every change fixes an
omission of an existing design or zeroes a public contract.

```text
Target Host / Submission -> ModelSelection -> Required ModelFactory -> Active Model.properties/options -> Adapter private execution
Legacy serialized config -> importer-private parser/types -> current Personal Provider / Model Config
```

## 1. Confirmed problems and decisions

### 1.1 Remove Core's fake Model Selection and optional ModelFactory

`AgentRuntimeDeps.modelFactory` was optional; without `config.modelSelection`, `AgentRuntime` fabricated
`zcode-unconfigured/missing-model`, and Contracts exported the same-valued `DEFAULT_MODEL`. This conflicts
with the Todo 01 production boundary: every root execution Model comes from the formal ModelFactory and
Core never makes a fake Model, fake Selection or fallback Model.

- Production `AgentRuntime` construction must receive a `RuntimeModelFactory` (required in the type); production `AgentRuntimeConfig` must receive a structured `ModelSelection` (Todo 13's target-Host initial selection provides it).
- Delete `zcode-unconfigured/missing-model`, `DEFAULT_MODEL` and the resolution, display and test assertions built around them; delete the deferred runtime branch only reachable when no ModelFactory is configured.
- Low-level tests inject a Fake or Unavailable ModelFactory and an explicit test Selection; no new `stateOnly`, `unconfigured`, `default` or sentinel Model type. `Model.bind()` stays the legitimate path to derive a bound Model from an existing Active Model.
- This depends on Todo 13 first removing the production temporary App/state-only Runtime; if a production construction still cannot obtain the target-Host Selection, go back to Todo 13 to fix the source instead of keeping a fake Selection fallback.

### 1.2 Remove the redundant `reasoning.enabled` state

Protocol `ZCodeModelReasoningOptions` had both `enabled` and `levels`, but the production Mapper creates the
object only when a Reasoning Option Spec exists and always writes `enabled: true`: the existence of the
object/Option Spec already expresses it.

- Delete `enabled` from `zcodeModelReasoningOptionsSchema` and `ZCodeModelReasoningOptions`; Bootstrap Mapper, Agent Model State, UI Projection and tests neither read nor generate it.
- `reasoning === undefined` means no Reasoning option; when present use `levels/defaultLevel`. No substitute via empty levels, a disabled enum or another boolean.
- The Legacy importer may keep reading the published old field `reasoning.enabled` only as importer-private input, immediately projected to the current Personal Model Config Rule. `ModelSelection.options.reasoningLevel`, Option Spec defaults and Adapter `reasoningMapping` are unchanged.

### 1.3 Remove zero-reference old Provider DTOs from the ZCode Protocol

`packages/shared/src/zcode-protocol/index.ts` still exported old Provider input/output Schemas with no
production consumer: `ZCodeModelProviderKind`, `ZCodeModelProviderSource`, `ZCodeModelProviderModel`,
`ZCodeModelProviderConfig`, `ZCodeModelProviderInput`, the Secret Input/Ref and API Format used only by
them, and old fields such as `models-dev`, `apiKeyRequired`, `providerOptions`, `modelsDevProviderId`.

- Re-check zero references per export with `pnpm dep:refs`, then delete Schemas, types and tests serving only them; do not move them to another Shared file or add deprecated aliases.
- Keep the still-used `ZCodeAccountAccess` and its independent Schema (do not delete it for being adjacent in the file). A DTO used only by test fixtures: the fixture switches to the current Provider Config contract. If a real Legacy importer consumer is found, move only the minimal serialized shape into the importer-private module and do not restore a public protocol.

### 1.4 Move Legacy CLI Model Config into the importer-private boundary

Contracts still exported `ModelProviderKind`, `ModelTargetConfig` and `RuntimeModelConfig`, describing the
old CLI `main/lite/available` and `kind/baseURL/apiKey/apiKeyRequired/headers/providerOptions` format, used
only by the Legacy CLI Personal Config importer.

- Move the minimal serialized DTO, Zod parser and normalize helper the importer needs into the Legacy CLI importer's private directory; private types are not exported from Contracts, Adapters, Bootstrap or Services barrels.
- After reading, the legacy file converts immediately to current Personal Provider Config / Personal Model Config Rules; Runtime, Registry, ModelFactory, UI and new persistence never touch the old DTO.
- Compatible reading of the published old CLI config is kept (the compat window is not ended here); importer tests build old JSON fixtures directly without republishing old types.

### 1.5 Remove the second model-fact channel in Runtime

Todo 14 removes ineffective `contextWindow/properties/providerOptions` from `RuntimeModelFactoryInput`, but
`AgentRuntimeConfig` still held and propagated `modelProviderOptions`, and Compact etc. still fell back from
the Active Model to `AgentRuntimeConfig.contextWindow/maxOutputTokens`.

```text
execution static facts -> Active Model.properties      execution-bound options -> Active Model.options
future selection intent -> ModelSelection              idle candidates/default display -> Target Host ModelSelectionView
```

- Delete `AgentRuntimeConfig.modelProviderOptions`, the same-named pass-through of Title/Memory/Compact/Workflow/Subagent, getters, updaters and tests that only verify the channel.
- Normal requests, Microcompact, Full/Reactive Compact, Memory, Title, Goal and Child Agent read only `Model.properties.contextWindow` and `Model.options.maxOutputTokens` once the run's Model is obtained; no `runtimeConfig ?? model` or `model ?? runtimeConfig` fallback; where the semantics need the execution Model its type becomes required and is created at the call boundary.
- `model.selected` and other execution events project model facts from the actually created Model, not copied from Runtime Config. Idle-state display and the configured default come from Todo 13's target-Host View, not a retained Runtime copy.
- After consumers migrate, `AgentRuntimeConfig.contextWindow/maxOutputTokens` with no independent non-execution meaning are deleted; any real non-execution consumer found must prove its authoritative source and lifecycle and become an explicit narrow DTO that never takes part in model requests, Compact or ModelFactory creation. `ModelSelection.options.maxOutputTokens` is unchanged (explicit user intent); the final value ModelFactory fills from Option Specs lives only in Active Model.options.

### 1.6 Correct old design docs still treated as current fact

Two kinds of problem: documents still describing Catalog, models.dev, Provider/modelId inference or flat
media capability — `apps/zcode-cli/docs/design/v2/model/model-capability-resolution.md`,
`docs/chat/manual-model-switch-resolution-chain.md`, `docs/model-request-output-tokens.md`,
`docs/compact-media-capability-projection.md`, the old Catalog/Modality nodes of
`apps/dev-docs/src/data/productCapabilityMap.ts`; and documents already inside the Provider Refactor Design
that still write the old Registry/Model relation as current contract — `design/model/model.md` using
`registry.createModel()` as a direct entry and the public `Model` exposing `providerConfig/modelConfig`, and
`design/interaction/interaction.md`, `design/registry/registry.md`, `design/registry/runtime.md` still drawing
`createModel(selection)` as a Provider Registry index method.

The only accurate relation:

```text
Provider Registry (lookup, validate) -> ModelFactory -> Adapter private createModel -> Active Model
  (identity, properties, optionSpecs, options, generateText / streamText)
```

The full `RegistryProviderConfig/RegistryModelConfig` is the private creation input ModelFactory hands to
the Adapter, not a queryable field of the public `Model`; `Model.bind()` stays the legitimate way to derive a
bound Model from an existing Model.
- Documents serving as current design entry are rewritten around Provider Config + Model Config Rules + Registry + ModelFactory + Active Model; pure historical documents are marked historical/retired at the title and opening with a link to the current Design; normative wording that would lead readers to implement Catalog, models.dev fallback, modelId hardcode or capability maps is deleted; historical plans, migration records and Git archaeology evidence are not deleted wholesale; the dev-docs capability map no longer lists retired files as current owners.

### 1.7 Tighten ineffective projections of the current Model Option Protocol

Besides the old Provider DTOs, the current `zcodeModelOptionSchema` kept fields with no effective product
semantics: `providerSource` and `providerLogoUrl` (no producer, no Renderer/Services consumer) and
`supportsTools` / `supportsStructuredOutput` (flattened by Bootstrap from the full Model Properties, with no
Renderer consumer, forming a second capability projection beside `Model.properties`). The same-named fields
of the old `zcodeModelProviderModelSchema` are deleted with the old Provider DTO per 1.3, not conflated.

- Delete `providerSource`, `providerLogoUrl`, `supportsTools`, `supportsStructuredOutput` from the current `zcodeModelOptionSchema/ZCodeModelOption`; delete Bootstrap's duplicate internal `ZCodeModelOption` DTO and intermediate projection, keeping the one direct Registry-to-current-Protocol projection without those fields and their dedicated tests.
- Do not move `supportsTools/supportsStructuredOutput` into another display DTO; a future real UI case first designs a minimal projection from the current Model Properties contract. Keep the same-structure Protocol contract of `properties.input_format/output_format` (no return to flat media fields). Fields with real consumers (`ref`, `label`, `providerLabel`, Reasoning options, context/output display facts) are unaffected; re-run a repo-wide reference scan before implementing to confirm no concurrent work added consumers.

### 1.8 Remove the hardcoded Built-in Provider display names in Bootstrap

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-mapper.ts` kept `BUILTIN_PROVIDER_LABELS`,
hardcoding display names for Z.AI, BigModel, ZAPI etc. by Provider ID: a second static Provider metadata
source beside the ZCode Built-in Provider Config.

```text
Registry Provider Config.label -> Protocol providerLabel   (label missing -> providerId)
```

Delete `BUILTIN_PROVIDER_LABELS` and the lookup by Provider ID; the Mapper prefers the Registry-provided
label and falls back only to `providerId`; no other Built-in label map in Bootstrap, UI or Protocol. Coding
Plan product, purchase, usage and account-family branches keep working by their business Provider IDs
(out of scope). Only the display-metadata source is consolidated: Provider ID, candidate order, visibility,
enablement, auth and model execution are unchanged.

## 2. Boundary with Todo 13 and 14

Todo 13 (target Host selection authority, structured `ModelSelection` persistence/protocol, temporary App
removal, string-selection business-chain retirement) -> Todo 16.1 (Runtime constructor can require a real
Selection + ModelFactory). Todo 14 (`RuntimeModelFactoryInput` narrowing, Full Compact MCS force, Legacy
Provider Store DTO privatization, known dead files). Todo 16 covers: Core fake sentinel removal,
`reasoning.enabled`, zero-reference ZCode Protocol Provider DTO removal, current Model Option Protocol
projection narrowing, Legacy CLI Model Config privatization, the AgentRuntime secondary model-fact channel,
Built-in Provider label hardcode, and current Design/document correction. Where Todo 13/14 already changed
the same file, this Todo re-checks zero references against the latest implementation and restores nothing;
it does not copy their tests or change lists. Todo 16.1 depends on Todo 13; the rest can proceed
independently when file conflicts are controllable. Todo 11's Provider Runtime composition/lifecycle draft
and Todo 15's real-environment/release validation are not part of this Todo.

## 3. Impact summary

Change layer: `presentation`, `option-source`; the document part is an architecture-contract correction.
Out of scope: model candidate state, Selection defaults, submission, execution, config persistence,
remote/continuous/replayable and Telemetry. Candidate display by `zcodeSessionProjection` is Desktop/Web/Mobile
isomorphic; Provider label comes from the Registry Provider Config for all candidates (product/usage screens
may keep their own commercial copy); execution facts come only from the full Model Properties/Options and
Protocol carries only the minimal display projection; per-product Draft, commit sink and persistence remain
isolated. State owners: Provider display name = Registry Provider Config (Built-in/Personal Provider Config);
Model execution capability = Active Model properties/options (Model Config Rules); user model selection =
each product's existing sink (unchanged). Must preserve: candidate set/order/grouping/enablement/visibility
and fallback; the `ModelSelection` Schema, default resolution and ModelFactory final validation; the full
Provider/Model Config is not exposed on the public Model or Protocol; Desktop, Web, Mobile, Local, Remote,
continuous and replayable behavior; commerce, account, usage and auth branches are not mistaken for static
Provider label config. No codegraph tool was available (depth-2 static substitute via feature-graph seeds,
`rg`, `dep:refs`, `knip`); the graph delta is none. No unresolved questions: all eight items are mechanical
closures of existing decisions.

## 4. Order

A. Zeroing tests and dependency evidence (failing tests for Required ModelFactory/Selection, no `reasoning.enabled`, Active-Model-only Compact; `dep:refs`/`rg`/`knip` to fix consumer lists of Protocol DTOs, current Model Option fields, Legacy CLI types and the sentinel; update the formal Design first; record overlap with Todo 13/14 without restoring fixtures). B. Core Runtime (Required ModelFactory and ModelSelection after Todo 13's initial-Selection chain; delete sentinel/`DEFAULT_MODEL`/deferred failure; tests inject Factory/Selection explicitly; delete the `modelProviderOptions` state; executions read only the run's Active Model). C. Protocol and Reasoning Projection (delete zero-reference old Provider Protocol DTOs, keep `ZCodeAccountAccess`, delete `reasoning.enabled`, zero-consumer Model Option fields and Bootstrap's flat capability output, delete `BUILTIN_PROVIDER_LABELS` so `providerLabel = config label ?? providerId`, verify Desktop, Web/Remote and Agent strict protocol parsing agree). D. Privatize Legacy CLI Config (extract the importer's minimal old shape, move parser/adapter/importer and fixtures, delete old types/entries from Contracts/Adapters public barrels, verify old config still converts one-way to the equivalent current Personal Config). E. Docs and mechanical acceptance (update current documents or mark historical, unify Registry -> ModelFactory -> Adapter private execution -> Model, rerun zero-reference scans, targeted tests, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, update the Todo status and commit).

## 5. Accepted cases

| Case ID | Scenario                                  | Expected                                                                  |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| RZ-01   | production creates AgentRuntime           | the type requires ModelFactory and structured ModelSelection              |
| RZ-02   | tests build a non-executable Runtime      | an explicit Unavailable ModelFactory; no sentinel Model                   |
| RZ-03   | model without a Reasoning Option Spec     | `reasoning` absent in Protocol/UI, no `enabled=false`                     |
| RZ-04   | model with a Reasoning Option Spec        | only levels/defaultLevel; no fixed `enabled=true`                         |
| RZ-05   | Shared Protocol export scan               | old ZCode Provider DTOs and fields belonging only to them are zero        |
| RZ-06   | reading a published old CLI config        | the importer parses privately and produces the current Personal Config    |
| RZ-07   | normal request, Compact, Memory, Title, Child | context/output facts come only from the run's Active Model            |
| RZ-08   | Model Config default max output updated   | affects only later-created Models; no write-back to old Selection/Runtime snapshot |
| RZ-09   | local and remote model execution          | each created by the target Environment's ModelFactory, no local fallback  |
| RZ-10   | reading the current model design docs     | Catalog, models.dev or capability map no longer presented as current authority |
| RZ-11   | reading the current Model Option Protocol | no zero-consumer field and no flat tools/structured capability            |
| RZ-12   | a Built-in Provider has a label           | candidates show the Registry Config label                                 |
| RZ-13   | Provider label missing                    | candidates fall back to providerId only, never a Bootstrap static name table |
| RZ-14   | reading the Model creation Design         | the Registry lookup/validate vs ModelFactory/Adapter creation boundary is clear |

## 6. Definition of done and non-goals

Zero for: `AgentRuntimeDeps.modelFactory?`, `zcode-unconfigured/missing-model`, public `DEFAULT_MODEL`;
`ZCodeModelReasoningOptions.enabled`; zero-reference old ZCode Provider Protocol DTOs and public
Schema/exports; public Contracts/Adapters Legacy CLI `RuntimeModelConfig/ModelTargetConfig`;
`AgentRuntimeConfig.modelProviderOptions` and its chain; Runtime `contextWindow/maxOutputTokens` fallback in
paths that have an Active Model; `providerSource/providerLogoUrl/supportsTools/supportsStructuredOutput` in
the current Model Option Protocol; Bootstrap `BUILTIN_PROVIDER_LABELS` or an equivalent Provider-ID-to-label
table. Legacy CLI compatibility exists only at the importer-private boundary (formal Config/Registry/Runtime
never read the old structure); current docs no longer claim old Catalog/Capability inference as formal
architecture; the formal Design no longer lets the public Model expose the full Provider/Model Config nor
describes Model creation as a Registry index method; no second implementation of Todo 13/14 scope; targeted
tests, typecheck, lint and format pass.

Not done: redesigning ModelSelection, Provider Config, Model Config Rules or Access; Todo 11 Host/Agent
Provider Runtime composition; ending the published Legacy CLI/Provider Store compat window; a new Model
identity, capability DTO, Runtime model snapshot or fallback model; Queue, Goal, Off-Peak scheduling,
desktop continuous, mobile replayable or remote recovery semantics; wholesale deletion of historical docs
and Git archaeology evidence.

## 7. Implementation record (2026-08-25)

- Core production construction requires a real `ModelSelection` and `ModelFactory`; tests inject test facts through explicit helpers; the production sentinel, `DEFAULT_MODEL` and the deferred missing-Factory branch are deleted.
- Runtime's second fact chain `modelProviderOptions/contextWindow/maxOutputTokens` and its pass-through in Compact, Memory, Child and Workflow are deleted; executions uniformly read the run's Active Model.
- Shared Protocol: zero-reference old Provider DTOs, `reasoning.enabled` and the unconsumed flat Model Option fields are deleted; Bootstrap projects the current protocol directly from the Registry View and takes the label from Provider Config.
- The minimal Zod Schema and types of the old CLI Provider/Model JSON moved into a bootstrap-importer-private module; the public types, parser and barrel exports of Contracts and Adapters are deleted; Adapter tests no longer treat the one-time importer as the formal Config parser.
- The current Design is unified as `Registry lookup/validate -> ModelFactory -> Adapter private create -> Active Model`; the old Model Catalog document is marked retired; the capability map and related runtime docs switched to Model Config Rules / Active Model.
- Dependency scan confirms the deleted Shared DTOs have no production references; targeted Protocol, Legacy importer, Adapter Config and Core Runtime tests and the Contracts/Adapters/Core/Bootstrap package typechecks pass. Repo-wide mechanical verification is recorded in this Todo's commit.
