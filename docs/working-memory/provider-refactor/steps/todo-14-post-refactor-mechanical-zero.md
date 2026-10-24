# 14 Provider Refactor final mechanical zeroing

> Status: done (2026-08-25)
>
> Related tasks: [`04`](./todo-04-core-model-connection-port-retirement.md),
> [`08`](./todo-08-legacy-model-catalog-retirement.md),
> [`12`](./todo-12-model-selection-validation-boundary-cutover.md),
> [`13`](./todo-13-target-host-model-selection-authority.md)
>
> Related design: [`../design/model/contract.md`](../design/model/contract.md),
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md),
> [`../design/execution/execution.md`](../design/execution/execution.md)

## 0. Goal

Delete the mechanical residue the completed Provider Refactor design left in the implementation, and fix
one clear bug against the existing MCS formula. No new abstraction and no reopened product semantics.

```text
Model Config / Registry -> minimal RuntimeModelFactoryInput -> Active Model
  -> Provider message projection (force || Model property)
  -> Compact / Memory / Title / Child execution
Released legacy provider storage -> importer-private parser/types -> current Provider Config
Unused compatibility files -> delete
```

## 1. Decisions

### 1.1 Full Compact ignored `force MCS`

The existing formula:

```ts
useMidConversationSystem =
  runtime.config.midConversationSystem?.mode === "force" ||
  activeModel.properties.supportsMidConversationSystem;
```

Ordinary Provider message projection and Microcompact already used it, but Full/Active Compact read only
`compactModel.properties.supportsMidConversationSystem`. With property `false` and execution mode `force`,
Full Compact's selection, token estimate, preserved entries and final compact request used the wrong
history shape. Target behavior:

- After obtaining the run's `compactModel`, Full/Active Compact uses the same formula as ordinary requests and Microcompact.
- That boolean is passed to compact selection, token estimate, summary request and preserved segment.
- `force` overrides only this execution; it never changes Model properties or enters Model Config.
- Automatic Compact keeps using the current Loop Active Model; manual Compact keeps creating its Model by its own Submission/Loop semantics.
- No Provider kind / Endpoint / baseURL / modelId inference is reintroduced.

This is a bugfix of an existing contract and needs no new product decision.

### 1.2 Tighten `RuntimeModelFactoryInput`

| Field                       | Fact                                                        | Decision |
| --------------------------- | ----------------------------------------------------------- | -------- |
| `contextWindow`             | Registry Model properties already carry it                  | delete   |
| `properties`                | callers must not override Registry's full facts             | delete   |
| `midConversationSystemMode` | MCS override is judged at Provider message projection       | delete   |
| `providerOptions`           | Provider parameters come from Model Config reasoningMapping | delete   |
| `selection`                 | ModelFactory selection input                                | keep     |
| `visibleMaxOutputTokens`    | still part of fixed-thinking visible-output budget          | keep     |
| `reasoningMode`             | still expresses the auxiliary-call disable-reasoning intent | keep     |
| `requestDependencies`       | still binds request-auth etc. for this execution            | keep     |

Only proven-ineffective fields are removed; the three valid execution parameters are not redesigned. All
Core call sites drop the pass-through; no deprecated alias, optional field or unconsumed parameter is kept.
`RuntimeModelFactoryInput` stays "the input needed to create this Model from the Registry" and never
becomes another Sparse Model Config, Capability snapshot or Provider options channel.

### 1.3 Legacy Provider DTO leaves the Shared public contract

`ModelProviderConfig`, `ModelProviderModelConfig`, `ModelProviderModelEntry` and their create/guard helpers
were used only by `legacyModelProviderStoreReader.ts`, `legacyPersonalProviderConfigImporter.ts` and the
one-time Legacy reader injection of `ProviderConfigRuntime`. They describe the published old Provider
store, not the current Provider Domain.

```text
@zcode/shared public contracts: no longer export Legacy Provider store DTO/helper
packages/services/src/model-provider/legacy-*: private serialized types, private normalize/parser/helper,
  one-way conversion to ProviderConfigLayerUpdate
```

- First list the real callers of each `model-provider-types.ts` export with scope-less `pnpm dep:refs`.
- Move only what the Legacy reader/importer needs into its private module (not exported from the Services barrel); delete Shared Provider Catalog/store types and helpers with no current consumer.
- Legacy importer read compatibility stays until the published compatibility window ends separately; this Todo only privatizes and does not remove user-data migration.
- Importer tests build old serialized fixtures directly; UI and E2E tests must not use Shared Legacy constructors to build current config.
- If a Shared export still has a real current consumer, stop deleting and name its owner; do not copy a same-shape type to bypass the check.

### 1.4 Delete refactor leftovers with no callers

Confirmed by `knip` and symbol scans: `packages/ui/src/lib/zcodeDraftThoughtLevelSync.ts` (old Draft
Session string Model/Thought sync helper), `packages/ui/src/lib/modelInputPresentation.ts` (still on Legacy
`ModelProviderModality`), `packages/ui/src/settings/OffPeakToolbarSelect.tsx` (unused after Todo 09).
Re-run `knip`, `rg` and `dep:refs` first: still zero references -> delete files and tests/exports serving
only them; if Todo 13 already deleted one, only verify zero and do not restore; if a new real caller
appears, judge whether it re-depends on the old abstraction instead of mechanically keeping it; other
repo-wide knip noise stays out.

## 2. Out of scope

Todo 11 Node Config / Host / Agent composition root and sole dispose owner; Todo 12 Selection
Facade/ModelFactory validation migration (coordinate in same-file edits); Todo 13 target Host, Environment
ID, structured product persistence and temporary App deletion; Dynamic Request Auth, Runtime Header
Refresh, official-version security signing or account credential lifecycle; Telemetry, Status, Context,
Observation; Provider Adapter encoding, Reasoning Mapping, MFJS Tool Schema, new model capabilities;
Queue, Goal, Background, Off-Peak scheduling, desktop continuous, mobile replayable or remote workspace
state semantics; ending the Legacy importer compatibility window.

## 3. Impact

Change layers: `commit-effect`, `validation`, `persistence boundary`. No UI change except deleting the unused
Off-Peak component; Full vs Micro Compact keep their own compression algorithms; remaining ModelFactory
callers may still pass valid execution parameters; Legacy persistence is read only at the importer boundary
and converted one-way; the current Config Repository is unchanged.

State owners: MCS static support = Active Model.properties (unchanged); MCS `force` = current Agent Runtime
execution config (consumed at request/Compact projection, never enters the Factory); Model static Config =
current-process Registry (callers cannot override through Factory input); Legacy serialized provider =
Legacy reader/importer private boundary (projected at once to the current Layer Update); current Provider
Config = Provider Config Service/Repository (no Legacy Shared DTO dependency).

Graph drift candidates: add the invariant "Full Compact shares the MCS force formula with ordinary
requests" and its code seed to the Feature Graph; replace retired `ModelConnectionPort`, `ModelRef`,
`AiSdkModelRegistry` seeds with current Registry/ModelFactory seeds; remove `modelInputPresentation.ts`
from the capability seeds after deletion.

## 4. Accepted cases

| Case ID | Setup                                               | Action                               | Assertions                                               |
| ------- | --------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| MZ-01   | Model MCS=false, runtime mode=force                 | Full Compact                         | whole chain selects, estimates and requests in MCS shape |
| MZ-02   | Model MCS=false, runtime mode=auto                  | Full Compact                         | keeps legacy user reminder shape                         |
| MZ-03   | Model MCS=true, runtime mode=auto                   | Full Compact                         | requests in MCS shape                                    |
| MZ-04   | Automatic Compact holds Active Model A              | triggers after Registry updates to B | still uses A and the current runtime force               |
| MZ-05   | every Core ModelFactory call site                   | typecheck/unit                       | no longer passes the four ineffective fields             |
| MZ-06   | fixed-thinking / auxiliary execution / request-auth | create and call Model                | the three valid execution parameters unchanged           |
| MZ-07   | published Legacy Provider store fixture             | start importer                       | conversion identical to before; Shared has no old DTO    |
| MZ-08   | current Provider/Model Config                       | normal start and settings read       | never enters the Legacy parser/type                      |
| MZ-09   | the three candidate dead files                      | knip + dep:refs + delete             | no production, test, barrel or dynamic-entry residue     |

No new conversation state combination, so the Formal Proof state machine is unchanged; MZ-01 to MZ-04 use
Core unit/integration tests; no new Desktop E2E (affected existing Provider/Compact regressions only).

## 5. Mechanical zero and verification

```text
RuntimeModelFactoryInput.contextWindow / properties / midConversationSystemMode / providerOptions = 0
those fields in Core createRuntimeModel() calls = 0
Legacy Provider store DTO in Shared public exports = 0
UI dependency on ModelProviderModality = 0
zcodeDraftThoughtLevelSync.ts, modelInputPresentation.ts, OffPeakToolbarSelect.tsx = deleted
```

`ModelProviderConfig` etc. may remain as importer-private type names; the zero target is the Shared /
current business public contract, not forbidding the Legacy parser from modeling published JSON.

Run: Core MCS, Full Compact, Microcompact and Model lifecycle tests; Bootstrap Provider Registry Model
runtime and request-auth tests; Services Legacy reader/importer tests; affected Shared, UI and Desktop
Provider fixtures; scope-less `pnpm dep:refs` per deleted Shared export; `pnpm knip` (only this Todo's
targets must disappear); `pnpm typecheck`; `pnpm lint`; `pnpm fmt:check`; `pnpm test:unit:affected`.

## 6. Result

- Full/Auto Compact computes `mode === "force" || model.properties.supportsMidConversationSystem` once after obtaining this run's `compactModel`; selection, estimate, summary request and preserved history share it; a `property=false + force` regression test was added.
- `RuntimeModelFactoryInput` keeps only `selection`, `visibleMaxOutputTokens`, `reasoningMode` and `requestDependencies`; all Core call sites dropped the four ineffective fields; the test Factory simulates Registry facts from the Model itself.
- Published old Provider Store DTO/parser/helper moved into Services-private `legacyModelProviderSerialized.ts`; Shared public exports and old public-type tests removed; the Legacy reader/importer keeps one-way migration.
- The three dead files, plus the old model preference / Snapshot / Runtime Catalog helpers proven unused together with Todo 13, were deleted.
- Feature Graph seeds `ModelConnectionPort`, `ModelRef`, `AiSdkModelRegistry` and the old capability seed were replaced by the current Registry/ModelFactory/Active Model entries.
- `dep:refs` shows the Legacy DTO has only importer-private consumers; `knip` no longer reports this Todo's targets (other repo-wide unused baseline is out of scope).
