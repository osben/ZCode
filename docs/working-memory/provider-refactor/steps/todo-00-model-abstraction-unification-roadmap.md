# 00 Model Abstraction Unification Cleanup Roadmap

> Status: Completed
>
> Date: 2026-08-25
>
> Source review: [`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> Target design: [`../design/design.md`](../design/design.md)

## 0. Completion Result

Todos 01–10 have all been implemented. The production main chain retains only `ModelSelection -> Provider Registry -> ModelFactory -> Model`:
Core no longer queries Connection or Adapter Registry, and model capabilities and request compatibility come exclusively from the complete Model Config; account connection selection,
Off-Peak, and ZCode Built-in Config have also been switched to the same structured fact chain.

The newly added Todo 11 saves only the subsequent review of the Provider Runtime composition boundary, currently at "Draft / Not to be implemented". Todos 12–14 are completed:
user selection Facade and execution validation separated; target Host, workspaceKey, sparse structured product Selection, and Local-only Subagent
Settings have been closed; MCS, Factory Contract, Legacy DTO, and dead code mechanical residue have also been reduced to zero. These follow-up items do not change the completion conclusion of Todos
01–10.

The post-completion reverse review on 2026-08-27 found that completion claims for Todos 05/07/12–14/20/21 still differed from current code, including public
`accessId`, `ForkModelRef`, Selection strings, Model edit transactions, and inheritance UI. Todo 23 has closed the Selection and Settings
transaction gap; Todo 24 replaces its Access slice with a final decision, deleting account binding at creation time and closing request-period authorization and signature; Todo 25 simultaneously retires
the ZAPI product entry. The mechanical zero conclusion of the current roadmap covers these reverse review gaps.

The remaining old fields exist only in explicitly defined historical read boundaries: Session Store codec and CLI Personal Config importer. They only convert
published data to the current structure, not exposing old types to Registry, Runtime, or new write paths. Scripts for restoring old sessions have been changed to
write directly to the current message contract, no longer producing new legacy data.

## 1. Planning Goal

The Provider Refactor has established the `ModelSelection -> Provider Registry -> ModelFactory -> Model` main chain, and M4 has also incorporated
Off-Peak, Compact, and Subagent special executions into this chain. This roadmap handles the next step: physically deleting old abstractions that can still express, assemble,
or execute models, so the system ultimately has only one set of business model semantics.

This roadmap's division of labor with the parallel "new Provider/M4 code compliance review" is as follows:

```text
New code compliance review
`- Check whether new Config / Registry / ModelFactory correctly implements confirmed design

This cleanup roadmap
`- Delete old execution interfaces, old query interfaces, and mixed-identity types that remain after the new chain is established
```

The final structure is:

```text
Persisted / Protocol
    ModelSelection
          |
          v
Effective Provider Config + Effective Model Config Rules
          |
          v
  Business Provider Registry
          |
          v
      ModelFactory
          |
          | One-time parse and freeze Provider / Model static facts
          v
      Active Model
      |- providerId / modelId
      |- properties / optionSpecs / options
      `- generateText / streamText
          |
          v
     Adapter internal AI SDK execution implementation
     |- Provider API encoding
     |- execution-provided per-attempt resolution
     |- proxy / CA / endpoint routing / signing
     |- retry / stream recovery / error normalization
     `- status / telemetry (unchanged this round)
          |
          v
      Provider API
```

## 2. Parallel Abstractions to Disappear

```text
Residual after Todo 02/03 completion

Core ------------------> ModelConnectionPort
  |
  +--> ModelFactory --> Model --> Adapter private execution closure --> AI SDK
  `--> ModelRef still simultaneously expresses identity / result / event and other semantics

Goal

Core --> ModelFactory --> Model --> Adapter private execution closure --> AI SDK
  |
  +--> Future selection only uses ModelSelection
  `--> Current execution only uses Model
```

What needs to be retired is not the Adapter's network capabilities, but its second set of model assembly and query semantics exposed to the business layer.

## 3. Confirmed Boundaries

### 3.1 Unique Business Abstraction

- `ModelSelection` expresses what Model will be created next; it can be persisted and transmitted across processes;
- `ModelFactory` is the sole business-layer entry point for creating root execution Models; existing `Model` can derive a Bound Model with the same identity,
  same static facts, and same Executor via `Model.bind()`;
- `Model` is the sole model object used for current execution; Core does not directly recognize Adapters or Connections;
- Adapters only convert already-parsed static facts and requests into Provider API calls.

### 3.2 No New Intermediate Business State

This round does not introduce `ExecutionModelBinding`, `ExecutionModelConfig`, `ModelIdentity`, or another Execution Registry.
Adapters may use private parameter objects, closures, and caches internally, but they do not become selectable, queryable, persistable, or synchronizable business
model state.

### 3.3 Lifecycle

```text
Registry revision N ----> create Model A ----> A freezes static facts from revision N

Registry revision N+1 --> create Model B ----> B uses revision N+1

Request-period Request Auth ----> parse dynamic access material per attempt
                         `- Does not rewrite A/B's endpoint, api.type, or properties
```

Config updates only affect later-created Models. Created Models do not hot-swap Endpoint, API type,
Provider Options, or model capabilities through Adapter Registry. Dynamic authorization can still refresh on each request attempt of an existing Model.

### 3.4 Telemetry

Telemetry has known issues in its current design, but this round explicitly does not refactor it:

- No new Telemetry Context or Observation DTO;
- No establishing `ModelIdentity` by cleaning up `ModelRef`;
- No splitting Product Status and Telemetry;
- Necessary type migrations kept to the extent needed to preserve existing event behavior.

## 4. Phased Todos

Status uses only three stable values: `Draft` means further item-by-item discussion is still needed and implementation is not yet authorized; `Pending` means the decision is clear and implementation may proceed but
has not yet completed verification; `Completed` means implementation, testing, documentation, and commits are all done.

| Todo                                                                         | Status    | Task                                                 | Goal                                                                                                                         | Primary dependency                    |
| ---------------------------------------------------------------------------- | --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [`01`](./todo-01-core-model-adapter-boundary-cleanup.md)                     | Completed | Core Model Adapter Boundary Cleanup                  | Delete Core `modelAdapter`, Compatibility Model, old ModelPort, and Adapter direct execution entry                           | M4 completed                          |
| [`02`](./todo-02-ai-sdk-execution-registry-retirement.md)                    | Completed | AI SDK Execution Registry Retirement                 | Delete the Adapter's mutable Provider Registry and reverse query surface, change to one-time assembly at Model creation time | Completed synchronously with Todo 03  |
| [`03`](./todo-03-provider-model-ownership-and-property-totality.md)          | Completed | Provider/Model New Implementation Compliance Closure | Complete member ownership, enabled/visibility, and Properties completeness                                                   | Completed synchronously with Todo 02  |
| [`04`](./todo-04-core-model-connection-port-retirement.md)                   | Completed | Core Model Connection Port Retirement                | Capabilities read Active Model.properties only; Connection remains in Adapter private implementation                         | Todos 02, 03 completed                |
| [`05`](./todo-05-model-ref-retirement.md)                                    | Completed | ModelRef Retirement                                  | Selection uses ModelSelection, execution uses Model, delete redundant identity fields per consumer                           | Todo 01 completed                     |
| [`06`](./todo-06-config-storage-envelope-repository-privatization.md)        | Completed | Config Storage Envelope Privatization                | Document, version envelope, and migration exit Provider Domain                                                               | Suggested after Todos 03, 05          |
| [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md) | Completed | Account Connection Closure                           | Structured connection selection, Account Access, Request Auth, Off-Peak, and MCP use the same fact chain                     | Todo 03 complete type boundary        |
| [`08`](./todo-08-legacy-model-catalog-retirement.md)                         | Completed | Legacy Model Catalog Retirement                      | Delete Catalog/override, Reasoning State, and use Config-driven MFJS Tool Schema projection                                  | Todos 02, 03 completed                |
| [`09`](./todo-09-off-peak-model-selection-legacy-projection-retirement.md)   | Completed | Off-Peak Old Model Projection Retirement             | Hidden Provider unified through scoped Selection View: candidates, Reasoning, and dual validation                            | Todos 03, 08                          |
| [`10`](./todo-10-zcode-builtin-provider-config-naming-cutover.md)            | Completed | ZCode Built-in Config Naming Cutover                 | Provider Config's `official` domain, code, and physical naming atomically exit, no compatibility retained                    | Can execute independently             |
| [`11`](./todo-11-provider-runtime-composition-boundary-cleanup.md)           | Draft     | Provider Runtime Composition Boundary Cleanup        | Review Node Config resources, Host/Agent composition roots, and unique lifecycle owner                                       | Requires item-by-item manual decision |
| [`12`](./todo-12-model-selection-validation-boundary-cutover.md)             | Completed | Model Selection Validation Boundary Closure          | Facade only provides user candidates; Registry/ModelFactory bears authoritative execution validation                         | Can execute independently             |
| [`13`](./todo-13-target-host-model-selection-authority.md)                   | Completed | Target Host Model Selection Authority Closure        | local/remote read target Host; delete temporary App/string selections and isolate state by workspaceKey                      | Suggested after Todo 12               |
| [`14`](./todo-14-post-refactor-mechanical-zero.md)                           | Completed | Post-Refactor Mechanical Zero                        | Fix Full Compact MCS, tighten Factory, privatize Legacy DTO, and delete dead code                                            | Coordinated with Todos 12/13          |
| [`23`](./todo-23-provider-refactor-decision-gap-closure.md)                  | Completed | Decision Gap and Settings Transaction Closure        | Delete public connection ID / identically shaped ModelRef; close Selection and Model edit transactions                       | Todo 24 replaces Access details       |
| `24` (document kept in official version only)                                | Completed | Access and Request Authorization Contract Closure    | Narrow Account Overlay, authorize per current connection, Mechanical zero for Access Type and authorization admission        | Replaces Todo 23 Access               |
| [`25`](./todo-25-zapi-product-entry-retirement.md)                           | Completed | ZAPI Product Entry Retirement                        | Delete current product identity, exclusive Gate, UI entry, and Legacy migration special case                                 | Independent product decision          |

Numbers represent the stable identity of the cleanup list. Implemented item by item, item by item; the final dependency chain is now fully closed:

```text
Todo 01 completed and verified
        |
        v
Todos 02–10 decided and implemented item by item
        |
        v
Mechanical zero, full verification, and final audit
```

Todos 02/03 establish complete Model Properties and unique Registry type boundaries; Todos 04/05 subsequently delete Core Connection queries and
mixed model identities; Todo 06 reclaims storage envelope; Todo 07 establishes structured Account Connection; Todos 08–10 finally delete Catalog,
Off-Peak old projection, and incorrect Official naming. Todo 11 is an independent composition boundary draft discovered after the above work, not included in the existing completion chain,
and cannot be implemented before manual decision; Todo 12 is an independent reviewed validation boundary cleanup; Todo 13 closes
Host user selection facts, Workspace defaults, and product persistence on top of Todo 12's final validation boundary; Todo 14 completes only the confirmed contract's final mechanical zero. Telemetry overall
refactoring is outside this roadmap.

## 5. Impact Brief

### 5.1 Functional Summary

| Field            | Conclusion                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Delete old model abstractions, unify Provider/Model assembly and execution boundaries                                               |
| Capability       | Provider Registry, Model creation, model execution                                                                                  |
| Change layer     | `commit-effect`, `validation`, `persistence contract`                                                                               |
| Operating mode   | incremental cleanup                                                                                                                 |
| Primary seeds    | `AgentRuntime`, `ApiProviderModelRuntime`, `ModelConnectionPort`, `ModelRef`                                                        |
| Out of scope     | Telemetry refactoring, account authorization product design, model selection product semantics, Queue/Recovery, Remote Provisioning |

### 5.2 UI Surface Matrix

In addition to the Provider model enable/disable, visibility, member source, and conflict interactions already specified in Todo 03, the remaining Todos do not plan UI modifications. The following entries share candidate
facts, but each state and submission sink remains independent:

| User scenario                 | UI entry               | Authoritative source                       | This round requirement   | Must be isolated                   |
| ----------------------------- | ---------------------- | ------------------------------------------ | ------------------------ | ---------------------------------- |
| Normal model selection        | Composer model control | Model Selection Facade / Session Selection | Filter disabled/hidden   | Active Model not hot-swapped by UI |
| Provider settings             | Provider Settings      | Settings Facade / Personal Config          | Display and save enabled | Do not expose hidden Provider      |
| Automation/Subagent/Repo Wiki | Each model control     | Each Draft/Persistence + Selection Facade  | Option source unchanged  | Do not unify each commit sink      |

### 5.3 Tiered Impact Surface

| Level          | Relationship                              | Why must inspect                                                                    | Evidence                                                   |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| must-inspect   | Core Runtime -> ModelFactory/Model        | Delete old Adapter and Connection entries                                           | `apps/zcode-cli/packages/core/src/runtime`                 |
| completed      | Bootstrap -> Provider Registry -> Adapter | Second mutable AI SDK Registry deleted; one-time assembly at Model creation time    | `provider-registry-model-runtime.ts`                       |
| must-inspect   | Adapter runner -> AI SDK                  | Preserve all Provider IO behavior, while narrowing assembly interface               | `adapters/src/model/runner.ts`, `model-execution.ts`       |
| must-inspect   | Contracts -> ModelRef/Result/Event        | `ModelRef` mixes identity, selection, and variant                                   | `contracts/src/model/index.ts`, `events/session.events.ts` |
| should-inspect | Compact/Memory/Subagent/Title/Tools       | Multiple model execution branches must only consume Active Model                    | Core call sites and Todo 01 tests                          |
| conditional    | Protocol/session persistence              | Only enters when Todo 05 deletes or migrates fields                                 | Session events, timeline/message persistence               |
| invariant-only | Off-Peak/Goal/Background                  | Continue using normal Selection/Factory/Active Model                                | M4 execution spec                                          |
| invariant-only | desktop/mobile/remote                     | Do not change continuous, replayable, Queue, or workspace identity                  | Provider Environment design                                |
| completed      | Adapter old Registry tests                | Reorganized by network responsibilities, no longer retains Registry query semantics | `adapters/tests/registry.test.ts` etc.                     |

### 5.4 State Owner and Submission Sink

| State/Fact                  | Authoritative owner                               | This round result                                                         |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Provider/Model static facts | Business Provider Registry                        | Adapter no longer copies as mutable query Registry                        |
| Future model selection      | ModelSelection product state                      | Do not express using ModelRef or Adapter default Provider                 |
| Current execution model     | Agent Loop's Active Model                         | Core capabilities and execution unified read from it                      |
| Provider network resources  | Adapter private execution closure/process service | Do not become business Registry View                                      |
| Dynamic Request Auth        | Model request dependency                          | Parse per attempt, do not enter Config/Selection/Persistence              |
| Session events/history      | Existing Session contract/persistence             | Todo 05 judgment per field: retain Selection, flatten identity, or delete |

### 5.5 Invariants to Maintain

1. All production model calls go through Models created by ModelFactory;
2. One Loop/Step uses a determined Active Model; Config updates do not hot-swap it;
3. Automatic Compact uses the current Active Model; Subagents create their own Model;
4. hidden Providers remain normal complete Registry members, only invisible in user Facade;
5. execution-provided failures occur before the network, and only cover dynamic access material;
6. Provider SDK encoding, proxy, CA, endpoint routing, signing, retry, stream recovery, and error normalization are not lost;
7. Do not change Session Selection, App Recent, Queue, Goal, Background, or Off-Peak admission;
8. Do not spread replayable recovery semantics to desktop continuous, or change workspace identity;
9. Do not create a second set of capability, identity, connection, or execution config DTOs;
10. Telemetry behavior remains as-is, not expanding payload or introducing new context due to cleanup.

### 5.6 Code Facts and Graph Drift

- `AiSdkModelRegistry`, config hot updates, and Bootstrap full synchronization have already been zeroed in Todo 02;
- `ModelConnectionPort` spread through barrel export to Core Runtime, Tools, WebSearch, MCS, and Embedded Search;
- `ModelRef` currently appears in approximately 50 non-test production files;
- The repository `dep:refs` default glob does not include `apps/zcode-cli/packages/*`; must use
  `--scope apps/zcode-cli/packages`; barrel imports may cause some interface symbol results to be underestimated, so deletion verification must also combine
  `rg`, TypeScript, and package tests;
- The feature graph already has Provider Registry, Model capabilities, and Off-Peak execution nodes; this plan supplements execution abstraction cleanup
  seeds and invariants, with no new UI surface.

## 6. Case Planning and Pruning

### 6.1 Primary Dimensions

| Dimension          | Representative values                                     | Handling                                 |
| ------------------ | --------------------------------------------------------- | ---------------------------------------- |
| Model lifecycle    | Config update before creation / update after creation     | Must test                                |
| Access             | api-key / zhipu-account / execution-provided              | Must test                                |
| Request form       | generate / stream / retry                                 | Must test                                |
| Execution source   | main / compact / subagent / off-peak                      | Representative coverage                  |
| Provider API       | Anthropic / OpenAI Responses / OpenAI-compatible          | Must test projection                     |
| Client/remote mode | desktop continuous / mobile replayable / remote workspace | Invariant regression, no state expansion |
| Telemetry          | status / trace / usage                                    | Regression only, no new state design     |

### 6.2 Pruning Decisions

- Do not enumerate UI surface x Provider API: this round does not modify UI or candidate generation;
- Do not enumerate Queue/Recovery x Adapter implementation: no state or protocol semantic changes, only main chain regression;
- Do not create cases per model ID: capabilities come from Config, modelId hardcoding is not allowed;
- Do not migrate every old Registry single test as-is: reorganize behavior tests by retained network responsibilities;
- Do not create new case catalogs for Telemetry: only verify that existing events have not lost critical fields due to type migrations.

### 6.3 Stable Verification Cases

| Case ID | Setup                                 | Action                                      | Assertions                                                                       |
| ------- | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| MAU-01  | Create Model A at Registry revision N | Continue requesting A after updating to N+1 | A's API/Endpoint/Properties unchanged                                            |
| MAU-02  | Registry already updated to N+1       | Create Model B                              | B uses N+1                                                                       |
| MAU-03  | execution-provided Model              | Request without Source                      | Type failure before network                                                      |
| MAU-04  | execution-provided Model              | Refresh auth on Retry                       | Only auth changes, static execution facts unchanged                              |
| MAU-05  | Main/Compact/Subagent                 | Each execute one request                    | Core only via Model, no Adapter/Connection fallback                              |
| MAU-06  | Image/PDF/Video capability            | Allow/Deny request                          | Only read Model.properties; Adapter encoding restrictions still apply            |
| MAU-07  | legacy ModelRef persistence           | Restore historical data                     | Convert to current semantics only at boundaries; domain no longer saves ModelRef |
| MAU-08  | desktop/mobile/remote representative  | Execute model request                       | Selection, queue, and recovery semantics unchanged                               |

These are cross-Todo stable Case IDs. Specific single test files and finer assertions are written in each Todo; E2E only covers true cross-process or existing main chain
regression, no large-scale UI E2E is added for pure TypeScript abstraction deletions.

## 7. Uniform Implementation Rules for Each Todo

1. Before starting, wait for or avoid overlapping files in parallel work trees;
2. Update the corresponding spec/Todo first, then write failing tests;
3. Migrate production assembly and test helpers first, then delete interfaces;
4. Do not prolong old abstractions with deprecated aliases, `any`, or compatibility fallbacks;
5. Verify each Todo with `rg`/`dep:refs` zero conditions, affected single tests, `pnpm typecheck`, `pnpm lint`, and
   `pnpm fmt:check`;
6. Todos should remain independently reviewable; when dependent on the same fact chain and atomic switch, they can be merged into a single Conventional Commit;
7. If a product state, Protocol recovery, or Telemetry semantic change is discovered, stop that Todo and decide separately, do not expand scope opportunistically.

## 8. Subsequent Unnumbered Issues

The following issues are known but have not yet completed item-by-item design discussion, and are not included in the above Todos:

- Long-term ownership of Account Provider dynamic credentials and runtime header refresh;
- Overall refactoring of Telemetry, Status, Context, and Observation.

These items will be discussed one by one in the future. Until decided, dead code with no remaining callers can be deleted in prior Todos, but no new long-term
abstractions or product semantics may be invented opportunistically.
