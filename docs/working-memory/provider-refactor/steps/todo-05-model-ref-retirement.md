# 05 ModelRef Retirement

> Status: Completed
>
> Confirmed boundaries: `ModelSelection` captures already-accepted selection intent and cannot be generically
> reverse-rebuilt from `Model.options` containing defaults; no unified Selection/Target comparison helper; consumers
> compare by their own business semantics; Telemetry this round only does type decoupling, not overall refactoring.
>
> Date: 2026-08-24
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Completed prerequisite: [`todo-01-core-model-adapter-boundary-cleanup.md`](./todo-01-core-model-adapter-boundary-cleanup.md)
>
> Related, not blocking: [`todo-04-core-model-connection-port-retirement.md`](./todo-04-core-model-connection-port-retirement.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-05-model-ref-retirement.md`

## 0. Actual Deliverables

- `ModelSelection` closed into `@zcode/shared` as the sole strict contract for cross-process selection intent.
- Current execution uniformly holds `Model`; Core, Compact, Memory, Subagent and Adapter no longer receive a public
  `ModelRef`.
- `ModelRef`, `ZCodeModelRef`, `variant` reasoning identity, parse/format/equality helpers and same-shape public aliases
  are deleted.
- Result, Stream, Session persistence and Telemetry store Selection or explicit provider/model fields by their own
  semantics (no shared pseudo-identity object).
- Bot, TUI, Protocol, CLI admission, historical hydration and the SQLite codec use standard `ModelSelection`; only
  explicit published history fields are read at migration/codec boundaries; current writes no longer produce old forms.

## 1. Objective

Delete the old `ModelRef` that carried Selection, execution identity, reasoning variant, request ownership and result
ownership at once. Each call site moves to an existing abstraction by real semantics (or drops the redundant field); no
universal `ModelIdentity`. Mapping: future selection intent -> `ModelSelection`; current execution -> `Model`; results
whose calling Model is known -> delete the duplicate model field; persisted state needing continued execution ->
`ModelSelection`; existing observations -> read providerId/modelId from the Model at the production point; legacy input
-> one-time conversion at the importer boundary.

Why not retain `ModelRef`: its `variant` duplicates `ModelSelection.options.reasoningLevel` while `formatModelRef()` and
`modelRefsEqual()` ignore `variant` (neither a strict identity nor a complete selection). It appeared in about 50
non-test production files across Contracts, Core, Bootstrap, Adapter, Session events, persistence and telemetry, so each
consumer must be classified (future selection, current object, historical fact, or redundant); no global replacement
with a same-shape interface.

## 2. Core Decisions

1. **No ModelIdentity this round.** In-process current execution uses `Model`; state needing to re-create models later
   uses `ModelSelection`; results naturally owned by the calling Model lose duplicate identity; observation production
   points flatten-read providerId/modelId from the Model keeping existing payload. Only if several independent domains
   repeatedly need a serializable, options-free identity value should one be designed separately.
2. **Reasoning leaves identity.** User/product selection -> `ModelSelection.options.reasoningLevel`; bound execution
   value -> `Model.options.reasoningLevel`; Provider wire parameters from Model Config `reasoningMapping`; existing
   Telemetry request/mapped values stay in existing request observation fields.
3. **No domain types for serialization reasons.** When an event needs `providerId/modelId`, keep two explicit fields in
   that event schema; save a full `ModelSelection` only when the event means "subsequent execution should continue by
   this selection".
4. **Selection is not inferred from the Effective Model.** `Model.options` are bound execution values (may contain
   defaults filled by ModelFactory from Option Specs); `ModelSelection.options` express explicitly accepted selection
   intent. The system saves the original Selection and never uses `modelSelectionFromModel()` as a generic reverse
   projection (it would solidify current defaults as user explicit selections and block inheriting new Config defaults).
   Parent, Child, Compact etc. inheriting future selections read their authoritative Selection; to keep using current
   bound values they pass the current Model or handle it at a local execution boundary.
5. **Unified Selection contract, not unified comparison semantics.** `@zcode/shared` owns the strict Schema
   `{ providerId: string; modelId: string; options?: { reasoningLevel?: string; maxOutputTokens?: number } }`. No public
   `sameModelSelection()`, `sameModelTarget()` or configurable equality helper; each consumer compares explicitly and
   locks it by tests: complete selection changes compare `providerId`, `modelId` and all current explicit options
   (`reasoningLevel`, `maxOutputTokens`; reasoning differences are different); physical model target, catalog
   membership or cross-model compatibility compare only `providerId`, `modelId`; where variant was once a change signal
   consumers compare `options.reasoningLevel`; no string-formatted complete comparison. Public `modelRefsEqual()` (only
   `providerId/modelId`, no static references) is deleted with `ModelRef`, not renamed.

## 3. Consumer Migration

- **Selection and Runtime -> `ModelSelection`:** Session default/current selection; Submission, Guide and Queue item
  future execution intent; Subagent profile/override; independent model task selection; any input needing
  Registry/ModelFactory to re-create a Model. Bare model string / defaultProvider fallback is deleted; consumers judging
  complete Selection changes compare options explicitly.
- **Core current execution -> `Model`:** Agent Loop, Compact, Memory, Title, goal verification, Tool validation and
  requests, Subagent child execution, message persistence production points needing the actual executor. Helpers needing
  only providerId/modelId read from the Model (no identity DTO).
- **Adapter:** `createModel()` receives explicit providerId/modelId and static execution facts; runner/transform/error
  helpers needing only a model ID take an explicit scalar or an Adapter-private bound object; no `ModelRef | string`;
  delete `parseModelRef()`, default provider and variant branches; duplicate `model: ModelRef` in request/result is
  deleted where internal callers hold the Model. Two scalars in Adapter-private functions do not make a business
  identity type.
- **Result and Stream Event:** `Model.generateText()` results and `Model.streamText()` events are uniquely owned by the
  calling Model, so duplicate `model` is deleted (no identity in each chunk); an aggregator genuinely mixing concurrent
  Model streams stores the source at the aggregation boundary; Usage, finish reason, content and error keep semantics.
- **Session event and persistence by purpose:** selection changes store `ModelSelection` (including effective options);
  assistant message actual source keeps explicit providerId/modelId in the message schema if the product needs
  display/audit; where the caller or parent event uniquely determines the source, duplicate fields are deleted; legacy
  historical data converts to these current forms only at hydration/importer boundaries. Do not change all `modelRef` to
  `modelSelection` (request options would persist as model identity) nor delete all (selection or provenance lost
  across restarts).
- **Network Status and Telemetry:** Adapter fills existing providerId/modelId at existing event production points from
  the current Model/bound execution facts; if the existing schema must keep a same-shape `model` object, define a local
  field structure for that observation schema (not export/reuse Core's `ModelRef`); no new Context / Observation /
  Identity layer; no change to event count, sampling, privacy, persistence or reporting. Telemetry overall design is a
  deliberately separate later topic.
- **Protocol legacy boundary:** strict schemas still recognize necessary legacy versions of published `modelRef`/string
  forms; importer/hydrator immediately converts to `ModelSelection` or the event's explicit current fields; new writes,
  commands and domain objects never produce `ModelRef`; compatibility code stays concentrated at version boundaries
  with deletion conditions (no dual read in Core/Adapter).
- **Specific risks handled by tests first:** (1) `createInheritedSubagentModelFactory()` reused the parent Model by
  `providerId/modelId` only, wrongly reusing an already-bound parent Model when the target Selection carries different
  options; target semantics: inherit current execution facts by passing the parent Model directly, hand an explicit new
  Selection to ModelFactory for creation or binding, never decide reuse by target ID alone. (2) `SessionPane`'s custom
  provider recovery compared only `modelId` (the same modelId can exist in different Providers); verify
  `providerId/modelId` together before confirming recovery.

## 4. Tests

- **Selection:** providerId/modelId/reasoningLevel/maxOutputTokens round-trip; consumers judging complete Selection
  changes do not ignore options (reasoning/max output differences are changes); Queue/Guide/Subagent override use their
  own saved Selection; bare modelId not resolved by default provider; Registry/ModelFactory creation takes only
  ModelSelection/explicit input; consumers caring only about target compatibility/catalog ignore options.
- **Execution and results:** generate/stream results correctly attributed after removing the model field; concurrent or
  nested calls not mixed by removing chunk identity; Compact/Memory/Subagent use the actual Model; reasoning level flows
  Selection -> Model.options -> mapping (not variant); errors and Usage keep actual providerId/modelId observations.
- **Session/historical:** Selection change events store complete ModelSelection; assistant message provenance restores
  by the current product schema; legacy ModelRef/string recoverable at the unique importer boundary; new writes produce
  no `variant`/`modelRef`; hydrate -> continue does not change Session Selection; Desktop continuous and mobile
  replayable get the same projections for the same historical facts without changing recovery semantics.
- **Mechanical zero:** public Contracts no longer export `ModelRef`; no production `variant` as reasoning identity;
  `parseModelRef`, `formatModelRef`, `modelRefsEqual` deleted; no `ModelRef | string` in Adapter/Core public
  interfaces; literal legacy only in explicit importer/schema/test fixtures; no new `ModelIdentity`, same-shape aliases
  or public Selection/Target equality helpers.

## 5. Implementation Order

A. Consumer list from the ~50 production files, each reference marked selection / active execution / redundant
result-event / persisted provenance / telemetry-status / legacy importer with a target form per file (no direct
codemod). B. Migrate Selection and Adapter first: Runtime/Bootstrap use ModelSelection; cross-process Selection types
and strict Schema in `@zcode/shared` (delete same-shape per-package definitions); Adapter interfaces take explicit parsed
input; variant into options; delete string/default provider parsing; migrate comparisons by original semantics and first
fix Subagent reuse and the custom-recovery Provider comparison. C. Migrate Result/Event: detach from old type aliases,
delete duplicate model fields, local precise schemas for genuine cross-boundary provenance/selection. D. Migrate
persistence and legacy importer: strict Protocol/schema, centralized legacy conversion, verify hydration, continued
execution and replay projection. E. Delete public types (ModelRef, variant, parse/format/equality helpers); run
Contracts, Core, Bootstrap, Adapter tests, session hydration/replay regression, `pnpm typecheck`, `pnpm lint`,
`pnpm fmt:check`; independent Conventional Commit.

## 6. Completion Definition

`ModelSelection` expresses future selection and `Model` current execution. Results/Events carry no identity the caller
already knows; selections and provenance needing persistence use their own precise schemas; Telemetry gets minimal type
adaptation. Public `ModelRef`, `variant` and same-shape substitutes exit; there is no universal model equality helper;
each consumer states and tests its own comparison fields.
