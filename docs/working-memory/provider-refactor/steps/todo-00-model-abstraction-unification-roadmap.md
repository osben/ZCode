# 00 Model Abstraction Unification Cleanup Roadmap

> Status: Completed
>
> Date: 2026-08-25
>
> Source review: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Target design: [`../design/design.md`](../design/design.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-00-model-abstraction-unification-roadmap.md`

## 0. Completion Result

Todos 01-10 are all implemented. The production main chain retains only
`ModelSelection -> Provider Registry -> ModelFactory -> Model`: Core no longer queries Connection or Adapter Registry,
and model capabilities and request compatibility come exclusively from the complete Model Config; account connection
selection, Off-Peak and ZCode Built-in Config use the same structured fact chain.

Todo 11 only saves the follow-up review of the Provider Runtime composition boundary and is "Draft / Not to be
implemented". Todos 12-14 are completed: user selection Facade and execution validation separated; target Host,
workspaceKey, sparse structured product Selection and Local-only Subagent Settings closed; MCS, Factory Contract,
Legacy DTO and dead code mechanical residue reduced to zero. They do not change the completion conclusion of Todos
01-10.

The post-completion reverse review on 2026-08-27 found that completion claims for Todos 05/07/12-14/20/21 still
differed from code (public `accessId`, `ForkModelRef`, Selection strings, Model edit transactions, inheritance UI).
Todo 23 closed the Selection and Settings transaction gap; Todo 24 replaced its Access slice with a final decision
(deleting account binding at creation time and closing request-period authorization and signature); Todo 25 retired
the ZAPI product entry. This roadmap's mechanical-zero conclusion covers these gaps.

Remaining old fields exist only in explicitly defined historical read boundaries: the Session Store codec and the CLI
Personal Config importer. They convert published data to the current structure and do not expose old types to the
Registry, Runtime or new write paths. Scripts restoring old sessions write directly to the current message contract and
no longer produce new legacy data.

## 1. Planning Goal

M4 incorporated Off-Peak, Compact and Subagent special executions into the `ModelSelection -> Provider Registry ->
ModelFactory -> Model` chain. This roadmap physically deletes old abstractions that can still express, assemble or
execute models, leaving one set of business model semantics. Division of labor with the parallel new-code compliance
review: that review checks whether new Config / Registry / ModelFactory implement confirmed design; this roadmap
deletes old execution interfaces, old query interfaces and mixed-identity types remaining after the new chain.

Final structure:

```text
Persisted / Protocol: ModelSelection
  -> Effective Provider Config + Effective Model Config Rules -> Business Provider Registry -> ModelFactory
  (one-time parse and freeze of Provider / Model static facts) -> Active Model
     (providerId / modelId, properties / optionSpecs / options, generateText / streamText)
  -> Adapter internal AI SDK execution (Provider API encoding, per-attempt execution-provided resolution,
     proxy / CA / endpoint routing / signing, retry / stream recovery / error normalization, status / telemetry unchanged)
  -> Provider API
```

## 2. Parallel Abstractions to Disappear

Before: Core -> `ModelConnectionPort`, and Core -> ModelFactory -> Model -> Adapter private execution closure -> AI SDK,
with `ModelRef` also expressing identity / result / event. Goal: Core -> ModelFactory -> Model -> Adapter private
execution closure -> AI SDK; future selection uses only `ModelSelection`; current execution uses only `Model`. What is
retired is not the Adapter's network capability but its second set of model assembly and query semantics exposed to
the business layer.

## 3. Confirmed Boundaries

1. **Unique business abstraction.** `ModelSelection` expresses what Model will be created next (persistable, cross-process);
   `ModelFactory` is the sole business-layer entry for creating root execution Models (an existing `Model` may derive
   a Bound Model with the same identity, static facts and Executor via `Model.bind()`); `Model` is the sole object for
   current execution (Core does not recognize Adapters or Connections); Adapters only convert already-parsed static
   facts and requests into Provider API calls.
2. **No new intermediate business state.** No `ExecutionModelBinding`, `ExecutionModelConfig`, `ModelIdentity` or
   Execution Registry. Adapters may use private parameter objects, closures and caches but they never become
   selectable, queryable, persistable or synchronizable business model state.
3. **Lifecycle.** A Model created at Registry revision N freezes revision-N static facts; revision N+1 creates Model B
   with N+1. Request-period Request Auth parses dynamic access material per attempt and does not rewrite endpoint,
   `api.type` or properties. Config updates affect only later-created Models (no hot swap of Endpoint, API type,
   Provider Options or capabilities through an Adapter Registry); dynamic authorization may still refresh per request
   attempt.
4. **Telemetry** has known design issues but is explicitly not refactored this round: no new Telemetry Context or
   Observation DTO, no `ModelIdentity` from cleaning up `ModelRef`, no Product Status / Telemetry split; type
   migrations only as needed to preserve existing event behavior.

## 4. Phased Todos

Status values: `Draft` (needs discussion, not authorized), `Pending` (decision clear, may implement but not verified),
`Completed` (implementation, tests, documents and commits done).

| Todo                                                                         | Status    | Task                                              | Goal                                                                                                                     | Primary dependency                   |
| ---------------------------------------------------------------------------- | --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| [`01`](./todo-01-core-model-adapter-boundary-cleanup.md)                     | Completed | Core Model Adapter Boundary Cleanup               | Delete Core `modelAdapter`, Compatibility Model, old ModelPort and Adapter direct execution entry                        | M4 completed                         |
| [`02`](./todo-02-ai-sdk-execution-registry-retirement.md)                    | Completed | AI SDK Execution Registry Retirement              | Delete the Adapter's mutable Provider Registry and reverse query surface; assemble once at Model creation                | Completed with Todo 03               |
| [`03`](./todo-03-provider-model-ownership-and-property-totality.md)          | Completed | Provider/Model New Implementation Compliance      | Complete member ownership, enabled/visibility and Properties completeness                                                | Completed with Todo 02               |
| [`04`](./todo-04-core-model-connection-port-retirement.md)                   | Completed | Core Model Connection Port Retirement             | Capabilities read Active Model.properties only; Connection stays in Adapter private implementation                       | Todos 02, 03                         |
| [`05`](./todo-05-model-ref-retirement.md)                                    | Completed | ModelRef Retirement                               | Selection uses ModelSelection, execution uses Model, redundant identity fields deleted per consumer                      | Todo 01                              |
| [`06`](./todo-06-config-storage-envelope-repository-privatization.md)        | Completed | Config Storage Envelope Privatization             | Document, version envelope and migration exit the Provider Domain                                                        | After Todos 03, 05                   |
| [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md) | Completed | Account Connection Closure                        | Structured connection selection, Account Access, Request Auth, Off-Peak and MCP use one fact chain                       | Todo 03                              |
| [`08`](./todo-08-legacy-model-catalog-retirement.md)                         | Completed | Legacy Model Catalog Retirement                   | Delete Catalog/override, Reasoning State; Config-driven MFJS Tool Schema projection                                      | Todos 02, 03                         |
| [`09`](./todo-09-off-peak-model-selection-legacy-projection-retirement.md)   | Completed | Off-Peak Old Model Projection Retirement          | Hidden Provider through a scoped Selection View: candidates, Reasoning, dual validation                                  | Todos 03, 08                         |
| [`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md)            | Completed | ZCode Built-in Config Naming Cutover              | Provider Config `official` domain, code and physical naming exit atomically, no compatibility                            | Independent                          |
| [`11`](./todo-11-provider-runtime-composition-boundary-cleanup.md)           | Draft     | Provider Runtime Composition Boundary Cleanup     | Review Node Config resources, Host/Agent composition roots and the unique lifecycle owner                                | Needs item-by-item manual decision   |
| [`12`](./todo-12-model-selection-validation-boundary-cutover.md)             | Completed | Model Selection Validation Boundary Closure       | Facade provides user candidates only; Registry/ModelFactory bears authoritative execution validation                     | Independent                          |
| [`13`](./todo-13-target-host-model-selection-authority.md)                   | Completed | Target Host Model Selection Authority Closure     | local/remote read the target Host; delete temporary App/string selections; isolate state by workspaceKey                 | After Todo 12                        |
| [`14`](./todo-14-post-refactor-mechanical-zero.md)                           | Completed | Post-Refactor Mechanical Zero                     | Fix Full Compact MCS, tighten Factory, privatize Legacy DTO, delete dead code                                            | With Todos 12/13                     |
| [`23`](./todo-23-provider-refactor-decision-gap-closure.md)                  | Completed | Decision Gap and Settings Transaction Closure     | Delete public connection ID / identically shaped ModelRef; close Selection and Model edit transactions                   | Todo 24 replaces Access details      |
| `24` (document kept in official version only)                                | Completed | Access and Request Authorization Contract Closure | Narrow Account Overlay, authorize per current connection, mechanical zero for Access Type and authorization admission    | Replaces Todo 23 Access              |
| [`25`](./todo-25-zapi-product-entry-retirement.md)                           | Completed | ZAPI Product Entry Retirement                     | Delete current product identity, exclusive Gate, UI entry and Legacy migration special case                             | Independent product decision         |

Dependency chain: Todo 01 -> Todos 02-10 decided and implemented item by item -> mechanical zero, full verification
and final audit. Todos 02/03 establish complete Model Properties and unique Registry type boundaries; 04/05 delete
Core Connection queries and mixed model identities; 06 reclaims the storage envelope; 07 establishes structured
Account Connection; 08-10 delete Catalog, Off-Peak old projection and incorrect Official naming. Todo 11 is an
independent composition boundary draft discovered afterwards (not in the completion chain; not implementable before a
manual decision); Todo 12 is an independently reviewed validation boundary cleanup; Todo 13 closes Host user
selection facts, Workspace defaults and product persistence on Todo 12's final validation boundary; Todo 14 completes
only the confirmed contract's final mechanical zero. Telemetry overall refactoring is outside this roadmap.

## 5. Impact Brief

**5.1 Summary.** Intent: delete old model abstractions and unify Provider/Model assembly and execution boundaries.
Capability: Provider Registry, Model creation, model execution. Layer: `commit-effect`, `validation`, `persistence
contract`. Mode: incremental cleanup. Primary seeds: `AgentRuntime`, `ApiProviderModelRuntime`,
`ModelConnectionPort`, `ModelRef`. Out of scope: Telemetry refactoring, account authorization product design, model
selection product semantics, Queue/Recovery, Remote Provisioning.

**5.2 UI surface.** Beyond the Provider model enable/disable, visibility, member source and conflict interactions in
Todo 03, no UI changes are planned. Normal model selection (Composer control; Model Selection Facade / Session
Selection; filter disabled/hidden; Active Model is not hot-swapped by UI), Provider settings (Settings Facade /
Personal Config; display and save enabled; do not expose hidden Providers), Automation/Subagent/Repo Wiki (each
Draft/Persistence + Selection Facade; option source unchanged; do not unify each commit sink).

**5.3 Impact surface.** must-inspect: Core Runtime -> ModelFactory/Model (`apps/zcode-cli/packages/core/src/runtime`);
Adapter runner -> AI SDK (preserve all Provider IO behavior while narrowing the assembly interface;
`adapters/src/model/runner.ts`, `model-execution.ts`); Contracts -> ModelRef/Result/Event (`ModelRef` mixes identity,
selection, variant; `contracts/src/model/index.ts`, `events/session.events.ts`). completed: Bootstrap -> Provider
Registry -> Adapter (second mutable AI SDK Registry deleted, one-time assembly at Model creation:
`provider-registry-model-runtime.ts`); Adapter old Registry tests reorganized by network responsibilities.
should-inspect: Compact/Memory/Subagent/Title/Tools (only consume Active Model). conditional: Protocol/session
persistence (when Todo 05 deletes or migrates fields). invariant-only: Off-Peak/Goal/Background (normal
Selection/Factory/Active Model); desktop/mobile/remote (continuous, replayable, Queue, workspace identity unchanged).

**5.4 State owners.** Provider/Model static facts: Business Provider Registry (Adapter no longer copies a mutable
query Registry). Future model selection: ModelSelection product state (not ModelRef or Adapter default Provider).
Current execution model: Agent Loop Active Model (Core capabilities and execution read it). Provider network
resources: Adapter private execution closure/process service (not a business Registry View). Dynamic Request Auth:
Model request dependency (parsed per attempt, not in Config/Selection/Persistence). Session events/history: existing
contract/persistence (Todo 05 decides per field: keep Selection, flatten identity, or delete).

**5.5 Invariants.**

1. All production model calls go through Models created by ModelFactory.
2. One Loop/Step uses a determined Active Model; Config updates do not hot-swap it.
3. Automatic Compact uses the current Active Model; Subagents create their own Model.
4. hidden Providers remain normal complete Registry members, only invisible in the user Facade.
5. execution-provided failures occur before the network and cover dynamic access material only.
6. Provider SDK encoding, proxy, CA, endpoint routing, signing, retry, stream recovery and error normalization are not
   lost.
7. Session Selection, App Recent, Queue, Goal, Background and Off-Peak admission do not change.
8. Replayable recovery semantics do not spread to desktop continuous; workspace identity unchanged.
9. No second set of capability, identity, connection or execution config DTOs.
10. Telemetry behavior stays as-is (no payload expansion or new context due to cleanup).

**5.6 Code facts and graph drift.** `AiSdkModelRegistry`, config hot updates and Bootstrap full synchronization were
zeroed in Todo 02. `ModelConnectionPort` spread through barrel export to Core Runtime, Tools, WebSearch, MCS and
Embedded Search. `ModelRef` appeared in about 50 non-test production files. `dep:refs` default glob excludes
`apps/zcode-cli/packages/*`; use `--scope apps/zcode-cli/packages`; barrel imports may underestimate interface symbol
results, so deletion verification also combines `rg`, TypeScript and package tests. The feature graph already has
Provider Registry, Model capabilities and Off-Peak execution nodes; this plan supplements execution abstraction cleanup
seeds and invariants with no new UI surface.

## 6. Case Planning and Pruning

Dimensions: model lifecycle (update before / after creation: must test); Access (api-key / zhipu-account /
execution-provided: must test); request form (generate / stream / retry: must test); execution source (main / compact /
subagent / off-peak: representative); Provider API (Anthropic / OpenAI Responses / OpenAI-compatible: projection must
test); client/remote mode (desktop continuous / mobile replayable / remote workspace: invariant regression only);
Telemetry (status / trace / usage: regression only).

Pruning: no UI surface x Provider API enumeration; no Queue/Recovery x Adapter enumeration; no per-model-ID cases
(capabilities come from Config, no modelId hardcoding); do not migrate every old Registry single test as-is
(reorganize behavior tests by retained network responsibilities); no new Telemetry case catalogs.

| Case ID | Setup                                  | Action                                      | Assertions                                                                        |
| ------- | -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| MAU-01  | Create Model A at Registry revision N  | Continue requesting A after updating to N+1 | A's API/Endpoint/Properties unchanged                                             |
| MAU-02  | Registry already at N+1                | Create Model B                              | B uses N+1                                                                        |
| MAU-03  | execution-provided Model               | Request without Source                      | Type failure before network                                                       |
| MAU-04  | execution-provided Model               | Refresh auth on Retry                       | Only auth changes, static execution facts unchanged                               |
| MAU-05  | Main/Compact/Subagent                  | Each executes one request                   | Core only via Model, no Adapter/Connection fallback                               |
| MAU-06  | Image/PDF/Video capability             | Allow/Deny request                          | Only read Model.properties; Adapter encoding restrictions still apply             |
| MAU-07  | legacy ModelRef persistence            | Restore historical data                     | Convert to current semantics only at boundaries; domain no longer saves ModelRef  |
| MAU-08  | desktop/mobile/remote representative   | Execute model request                       | Selection, queue and recovery semantics unchanged                                 |

These are cross-Todo stable Case IDs; single test files and finer assertions live in each Todo. E2E covers only true
cross-process or existing main chain regression (no large-scale UI E2E for pure TypeScript abstraction deletions).

## 7. Uniform Implementation Rules for Each Todo

1. Before starting, wait for or avoid overlapping files in parallel work trees.
2. Update the corresponding spec/Todo first, then write failing tests.
3. Migrate production assembly and test helpers first, then delete interfaces.
4. Do not prolong old abstractions with deprecated aliases, `any` or compatibility fallbacks.
5. Verify each Todo with `rg`/`dep:refs` zero conditions, affected single tests, `pnpm typecheck`, `pnpm lint` and
   `pnpm fmt:check`.
6. Todos stay independently reviewable; ones depending on the same fact chain and atomic switch may merge into one
   Conventional Commit.
7. If a product state, Protocol recovery or Telemetry semantic change is discovered, stop that Todo and decide
   separately.

## 8. Subsequent Unnumbered Issues

Known but not yet designed item by item (not in the Todos above): long-term ownership of Account Provider dynamic
credentials and runtime header refresh; overall refactoring of Telemetry, Status, Context and Observation. Until
decided, caller-less dead code may be deleted by earlier Todos, but no new long-term abstractions or product semantics
may be invented opportunistically.
