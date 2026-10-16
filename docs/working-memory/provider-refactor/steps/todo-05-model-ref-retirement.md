# 05 ModelRef Retirement

> Status: Completed
>
> Confirmed boundaries: `ModelSelection` captures already-accepted selection intent and cannot generically reverse-rebuild from `Model.options` containing defaults; no unified Selection/Target comparison helper established; consumers compare by their own business semantics; Telemetry this round only does type decoupling, not overall refactoring.
>
> Date: 2026-08-24
>
> Overall roadmap: [`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> Completed prerequisite: [`todo-01-core-model-adapter-boundary-cleanup.md`](./todo-01-core-model-adapter-boundary-cleanup.md)
>
> Related but not blocking: [`todo-04-core-model-connection-port-retirement.md`](./todo-04-core-model-connection-port-retirement.md)

## 0. Actual Deliverables

- `ModelSelection` closed to `@zcode/shared` as the sole strict contract for cross-process selection intent;
- Current execution uniformly holds `Model`; Core, Compact, Memory, Subagent, and Adapter no longer receive public `ModelRef`;
- `ModelRef`, `ZCodeModelRef`, `variant` reasoning identity, parse/format/equality helpers, and same-shape public aliases deleted;
- Result, Stream, Session persistence, and Telemetry save Selection or explicit provider/model fields by their own semantics,
  no longer sharing a pseudo-identity object;
- Bot, TUI, Protocol, CLI admission, historical hydration, and SQLite codec switched to standard `ModelSelection`; only explicit
  published history fields read at migration/codec boundaries; current writes no longer produce old forms.

## 1. Task Objective

Delete the old `ModelRef` that simultaneously carries Selection, execution identity, reasoning variant, request ownership, and result ownership. Each call site changes to existing abstractions by
real semantics or deletes redundant fields, without adding a universal `ModelIdentity`.

```text
Current ModelRef
├─ providerId
├─ modelId
└─ variant?
   |
   +--> runtime selection
   +--> adapter resolution
   +--> request / result / stream event
   +--> session event / persistence
   `--> network status / telemetry

Target

Future selection intent ----------------> ModelSelection
Current execution --------------------> Model
Invocation site already knows current Model's result ---> delete duplicate model field
Persisted state needing continued execution -----> ModelSelection
Existing observations --------------------> read providerId/modelId from Model at production point
legacy input -----------------> one-time conversion at importer boundary
```

## 2. Why Not Retain ModelRef

Current `variant` actually duplicates `ModelSelection.options.reasoningLevel`, while `formatModelRef()` and
`modelRefsEqual()` ignore `variant`. This shows it is neither a strict identity nor a complete selection.

Static scan shows `ModelRef` still appears in approximately 50 non-test production files, covering Contracts, Core, Bootstrap, Adapter,
Session event, persistence, and telemetry. Cannot globally replace with another same-shape interface; must answer per consumer "is this future
selection, current object, historical fact, or fundamentally redundant."

## 3. Core Decisions

### 3.1 No ModelIdentity This Round

- In-process current execution directly uses `Model`;
- State needing to re-create models later uses `ModelSelection`;
- When result naturally owned by calling Model, delete duplicate identity;
- Observation production points can flatten-read providerId/modelId from Model, keeping existing payload;
- Only if multiple independent domains repeatedly need the same serializable, options-free identity value later, prove and design Identity separately.

### 3.2 Reasoning Leaves Identity

`variant` exits:

- User/product selection enters `ModelSelection.options.reasoningLevel`;
- Bound execution values enter `Model.options.reasoningLevel`;
- Provider wire parameters produced by Model Config `reasoningMapping`;
- If existing Telemetry records request/mapped values, keep them in existing request observation fields, not stuffed back into identity.

### 3.3 Do Not Manufacture Domain Types for Serialization Reasons

When an event truly needs `providerId/modelId`, keep two explicit fields in that event schema. Only save full `ModelSelection` when that event expresses
"subsequent execution should continue by this selection." Do not introduce cross-domain ModelIdentity to save typing two fields.

### 3.4 Selection Not Inferred from Effective Model

`Model.options` are bound execution values, which may contain default values filled by ModelFactory based on current Option Specs;
`ModelSelection.options` only expresses call-site explicitly accepted and prepared-for-persistence selection intent. System must save original Selection; must not use
`modelSelectionFromModel()` as a generic reverse projection, otherwise current defaults incorrectly solidify as user explicit selections, and prevent subsequently
creating Models that inherit new Config defaults.

Parent, Child, Compact, and other consumers needing to inherit future selections, read their authoritative Selection; when truly needing to continue using current bound
execution values, directly pass current Model or handle explicitly at local execution boundaries; cannot mix into universal Model -> Selection conversion.

### 3.5 Unified Selection Contract, Not Unified Comparison Semantics

`@zcode/shared` owns the sole strict `ModelSelection` Schema and cross-process types:

```ts
{
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
    maxOutputTokens?: number;
  };
}
```

But public layer does not provide `sameModelSelection()`, `sameModelTarget()`, or configurable general equality helper. Whether same is consumer's
own domain judgment, must express explicitly at call site and locked by testing:

- When judging complete selection changes, compare `providerId`, `modelId`, and all current explicit options; current is
  `reasoningLevel`, `maxOutputTokens`; reasoning differences must judge as different;
- When judging physical model target, catalog membership, or cross-model compatibility, only compare `providerId`, `modelId`, ignoring options;
- After old `providerId/modelId/variant` judgment migration, consumers where variant was once a change correspondingly compare
  `options.reasoningLevel`;
- Do not elevate a local comparison function to public "identity" abstraction, nor complete comparison by formatting strings.

Current public `modelRefsEqual()` only compares `providerId/modelId` and has no static references; should be deleted along with `ModelRef`, not
retained under a new name.

## 4. Consumer Migration Classification

### 4.1 Selection and Runtime

Migrate to `ModelSelection`:

- Session default/current selection;
- Submission, Guide, Queue item future execution intent;
- Subagent profile/override;
- Independent model task selection;
- Any input needing Registry/ModelFactory to re-create Model.

Delete bare model string/defaultProvider fallback. Consumers needing to judge complete Selection changes must explicitly compare options'
real semantics; cannot reuse `formatModelRef/modelRefsEqual` that ignores reasoning, nor switch to new public comparison helper.

### 4.2 Core Current Execution

Migrate to `Model`:

- Agent Loop, Compact, Memory, Title, goal verification;
- Tool validation and requests;
- Subagent child current execution;
- Message persistence production points needing to know the actual executor of this round.

Core helpers needing only providerId/modelId read directly from Model, without creating identity DTO.

### 4.3 Adapter

- `createModel()` receives explicit providerId/modelId and static execution facts;
- runner/transform/error helpers needing only model ID receive explicit scalar or Adapter private bound object;
- Do not accept `ModelRef | string`;
- Delete Adapter `parseModelRef()`, default provider, and variant branches;
- Duplicate `model: ModelRef` in request/result deleted when internal callers already hold Model.

Adapter private functions receiving two scalars does not equal establishing new business identity types.

### 4.4 Result and Stream Event

Per-field judgment:

- `Model.generateText()` Result uniquely owned by calling Model, default delete duplicate `model`;
- `Model.streamText()` events same; default do not repeat identity in each chunk;
- If an aggregator truly mixes multiple concurrent Model streams, source saved at aggregation boundary, not polluting all Model events;
- Usage, finish reason, content, and error keep existing semantics.

### 4.5 Session Event and Persistence

Classified by event purpose:

1. Express selection changes: save `ModelSelection`, including effective options;
2. Express assistant message actual source: keep explicit providerId/modelId in message schema (if product needs display/audit);
3. Caller or parent event uniquely determines source: delete duplicate fields;
4. legacy historical data: only convert to above current forms at hydration/importer boundaries.

Cannot uniformly change all `modelRef` to `modelSelection`, otherwise request options incorrectly persisted as "model identity"; cannot uniformly delete, otherwise losing selection or message provenance needed across restarts.

### 4.6 Network Status and Telemetry

This Todo does not refactor Telemetry. Handling limited to:

- Adapter fills existing providerId/modelId at existing event production points from current Model/bound execution facts;
- If existing schema must temporarily retain same-shape `model` object, can first define as local field structure for that observation schema, cannot continue exporting/reusing `ModelRef` from Core;
- No new Context, Observation, or Identity layer;
- No change to event count, sampling, privacy, persistence, or reporting channels.

This is an intentional temporary boundary: public `ModelRef` can exit; Telemetry overall design handled separately later.

### 4.7 Protocol Legacy Boundary

If published protocols or historical files use `modelRef`/strings:

- Strict schemas continue recognizing necessary legacy versions;
- importer/hydrator immediately converts to ModelSelection or that event's explicit current fields;
- New writes, new commands, and domain objects no longer produce ModelRef;
- Compatible code concentrated at version boundaries with deletion conditions, not dual-read universally in Core/Adapter.

### 4.8 Confirmed Specific Risk Points

The following two must be handled with tests first during implementation, not mechanically migrated as-is:

1. `createInheritedSubagentModelFactory()` currently reuses parent Model by `providerId/modelId` only. If target Selection carries
   different options, it incorrectly reuses the already-bound parent Model. Target semantics: inherit current execution facts by directly passing parent Model; when explicit new Selection exists, hand to ModelFactory for creation or binding; cannot decide reuse by same target ID alone.
2. `SessionPane`'s custom provider recovery currently only compares `modelId`. The same modelId can exist in different
   Providers; must verify `providerId/modelId` together before confirming recovery success.

## 5. Tests First

### 5.1 Selection

1. providerId/modelId/reasoningLevel/maxOutputTokens complete round-trip;
2. Consumers judging complete Selection changes do not ignore options; reasoning/max output differences judged as changes by existing business semantics;
3. Queue/Guide/Subagent override use their own saved Selection;
4. Bare modelId not resolved by default provider;
5. Registry/ModelFactory creation only receives ModelSelection/explicit input.
6. Consumers only caring about model target compatibility and catalog ignore options, not falsely judging cross-model on reasoning changes.

### 5.2 Execution and Results

1. generate/stream results still correctly attributed after removing model field;
2. Concurrent or nested calls not mixed by removing chunk identity;
3. Compact/Memory/Subagent use actual Model;
4. reasoning level flows Selection -> Model.options -> mapping, not through variant;
5. Errors and Usage retain actual providerId/modelId existing observations.

### 5.3 Session/Historical

1. Selection change events save complete ModelSelection;
2. Assistant message provenance restored by current product schema;
3. legacy ModelRef/string recoverable at unique importer boundary;
4. New writes do not produce `variant` or `modelRef`;
5. Hydrate -> continue does not change Session Selection;
6. Desktop continuous and mobile replayable get same projections for same historical facts, without changing respective recovery semantics.

### 5.4 Mechanical Zero

- Public Contracts no longer export `ModelRef`;
- Production code has no `variant` as reasoning identity;
- `parseModelRef`, `formatModelRef`, `modelRefsEqual` deleted;
- Adapter/Core public interfaces have no `ModelRef | string`;
- Literal legacy only exists in explicit importer/schema/test fixtures;
- No new `ModelIdentity`, same-shape aliases, or public Selection/Target equality helpers.

## 6. Implementation Order

### Step A: Build Consumer List

Using current approximately 50 production files as baseline, mark each reference as:

- selection;
- active execution;
- redundant result/event;
- persisted provenance;
- telemetry/status;
- legacy importer.

The list must have target forms per file; cannot directly codemod.

### Step B: Migrate Selection and Adapter First

- Runtime/Bootstrap uniformly use ModelSelection;
- Cross-process Selection types and strict Schema closed to `@zcode/shared`; delete same-shape public definitions per package;
- Adapter interfaces changed to explicit parsed input;
- variant enters options;
- Delete string/default provider parsing;
- Migrate comparisons by consumers' original semantics, and first fix Subagent reuse and custom recovery missing Provider comparison issues.

### Step C: Migrate Result/Event

- New Model Result/Event脱离 (detach) from old type aliases;
- Delete duplicate model fields callers already know;
- Define local accurate schemas for truly cross-boundary provenance/selection.

### Step D: Migrate Persistence and Legacy Importer

- Update strict Protocol/schema;
- Centralize legacy conversion;
- Verify historical hydration, continued execution, and replay projection.

### Step E: Delete Public Types and Verify

- Delete ModelRef, variant, and parse/format/equality helpers;
- Run Contracts, Core, Bootstrap, Adapter unit tests;
- Run session hydration/replay representative regression;
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`;
- Independent Conventional Commit.

## 7. Completion Definition

System uses `ModelSelection` to express future selection, `Model` to express current execution. Result/Events do not redundantly carry caller-already-known
identity; selections and provenance needing persistence use their own accurate schemas; Telemetry does minimal type adaptation. Public
`ModelRef`, `variant`, and same-shape substitute types all exit; system has no universal model equality helper; each consumer explicitly expresses and
tests their own comparison fields.
