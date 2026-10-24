# Provider Refactor Migration Roadmap

> Status: Work planning
>
> Last updated: 2026-08-24
>
> Current phase: M4 and the known cleanup Todos are completed; the Provider Refactor final full verification is in progress
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/migration-roadmap.md`

## Strategy

The migration converges upward along the model call main chain: unify the model execution interface, then organize
the Registry and Provider sources, then converge Submission, config and Environment ownership. Each phase can split
into several mergeable slices, but no parallel business semantics remain at the end of a phase; the old system reaches
the new abstraction only through one explicit compatibility entry.

## Phase Overview

| Phase             | Topic                                                        | Status                                                               | Completion sign                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0                | Macro architecture and current status map                    | Round one completed                                                  | Work goal and the main historical fork persisted                                                                                                                 |
| M1                | Model and ModelRequest                                       | Completed                                                            | All production model calls use the unified Model                                                                                                                 |
| M2                | Provider config, Registry and Model creation                 | Completed; base slice of the current M3 Merge Request                | Three-layer config and normal Model creation are in the unified chain; old Snapshot, Workspace Provider Catalog fallback and dead code are gone                  |
| M3                | Provider architecture cutover and Model format consolidation | Completed                                                            | Config/Registry, atomic Submission, model selection, settings page and input/output format form the only production chain                                        |
| M4                | Model execution chain, idle tasks and Subagent               | Completed                                                            | Idle task uses the complete hidden Provider, the same Registry/ModelFactory and request-period authentication; does not change Session Selection                  |
| M5                | Config storage boundary and Built-in assembly                | Provider Refactor scope completed                                    | Storage shell is privatized; Built-in/Personal/Selection are assembled only through the formal Source/Repository                                                 |
| M6                | Account Provider                                             | Provider Refactor scope completed                                    | Structured selection, Account Overlay, complete Access and request-period authentication form the only chain                                                     |
| Independent topic | Environment config and Provisioning                          | Not part of this Provider Refactor                                   | Remote settings, login, config sync and target Environment product capabilities are designed separately                                                         |

The phase order can be fine-tuned by implementation facts; update this roadmap and Working Memory when adjusting, and
never create temporary code just to keep numbering.

## M0: Macro architecture and status map

Working language: Fact source -> Provider construction -> Registry aggregation -> Model -> ModelRequest. The round-one
investigation of Runtime, Registry, Provider Options, Reasoning, Plan, idle task, Subagent and peripheral model calls
is complete; M0 only receives later fact evidence and carries no implementation details.

## M1: Model and ModelRequest

> Completed on 2026-08-12, merged into `staging` via MR !2006.

M1 places all production model calls under one final public boundary (how the model is called), without requiring the
final Registry and Provider source refactoring at the same time:

```text
Model: Properties, Option Specs, Options, bind(), generateText(), streamText()
```

Slices: M1.1 fixed types (including ModelResult / ModelEvent), Model Adapter Wrapper and unit tests; M1.2 main Agent
Loop, Automatic Compact, Usage and Trace; M1.3 Child Agent, Title, Goal verifier and Project Memory; M1.4 Git,
workspace `generateText`, WebFetch and WebSearch; M1.5 Repo Wiki; M1.6 delete business callers' reading of Runtime
model state, Provider options, ModelPort and independent Provider clients. Existing Runtime, Registry, Plan and
temporary model inputs enter the new chain through one compatible Model Factory. At M1 completion all production model
calls use `Model.generateText()` / `Model.streamText()`; no parallel business model client remains.

## M2: Provider config, Registry and Model creation

Plan: [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md); target design
[`../design/registry/registry.md`](../design/registry/registry.md); retirement result
[`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md); aggregation, notification
and cross-process refresh research [`../research/m2-registry-aggregation-and-refresh.md`](../research/m2-registry-aggregation-and-refresh.md).
The three-layer Config, Registry aggregation, Model creation and main production assembly of the normal long-term
Provider are done and serve as the base slice of the M3 implementation branch (the unified cutover is completed
together with Submission, selection state and the settings page).

```text
ProviderConfigService (ZCode Built-in Provider Config, Account Provider Config, Personal Provider Config,
  ZCode Built-in Model Config Rules, Personal Model Config Rules)
  -> ProviderRegistryService (Provider[] / { modelId, config: ModelConfig }[]; createModel(selection))
  -> ModelFactory -> Model
```

Main questions handled: ordered per-field override semantics of ProviderConfig and ModelConfigRules; the Account
Source produces the Account Provider Config and supplements account-kind `accessId` and `models` after Built-in and
before Personal; the Registry's Provider/ModelConfig View, query index, change notification and object lifecycle; the
dedicated Views of the Settings Facade and model selection Facade; ModelFactory, Adapter and dynamic authentication
dependency; save, external file modification and official update refresh chain; the idle task's transition Runtime
Model reuses resolution and ModelFactory with a single-execution lifecycle.

After M2 the Agent Loop obtains the current Model from the process Registry; an update creates a new object and the old
Loop keeps the old Model. M2 only established the boundary for the Account Provider and the idle task transition chain
to access the unified ModelFactory; Account Provider identity, entitlement, dynamic credentials and refresh state are
rebuilt in M6, and idle-task/Subagent submission and lifecycle semantics are consolidated in M4 (which deletes the
transition Runtime Model chain).

## M3: Provider architecture cutover

Plan: [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md); target semantics
[`../design/interaction/interaction.md`](../design/interaction/interaction.md) and
[`../design/registry/settings.md`](../design/registry/settings.md). M3 combines the M2 Config/Registry foundation with
atomic Submission, model selection state, the Provider settings page and Model input/output format into one cutover,
implemented in the same integration branch and organized by responsibility-separated commits and review areas (Config/Registry,
Submission, CLI admission, ModelRef retirement, Settings Service, Settings UI, Connectivity, Model Format, cleanup
tests); no single area ends as a long-term dual track. The interaction main chain changes "switch the model first,
then send the text" into one atomic Submission (`prompt`, `attachments`, `mode`, `modelSelection`) and converges
Composer Draft, App Recent, Session Selection, Queue, Guide/"immediate", Edit, Retry, Prompt CLI and TUI model
semantics; it completes settings auto-save, reorder and formal Model connectivity testing; and deletes ModelRef, shared
mutable Runtime model state and the independent Connectivity Probe. The Session persists only the Selection; a
Submission starting a new Agent Loop obtains the Model from the Registry and binds Options. M3 is completed in one
large MR.

## M4: Model execution chain, idle tasks and Subagent

Plan: [`04-model-execution-cutover.md`](./04-model-execution-cutover.md); long-term semantics
[`../design/execution/execution.md`](../design/execution/execution.md). No special Model type is added; the idle task
is consolidated onto the normal chain:

- `builtin:offpeak-idle-plan` is a complete Built-in Provider with `visibility: "hidden"` (hidden affects only the
  settings page and model selector), `access.type = "request-auth"` (dynamic authentication injected per request,
  failing before the network when missing).
- The idle Submission carries the standard ModelSelection and a narrow execution context and creates the Model through
  the same Registry/ModelFactory; it does not write App Recent, Configured Default, Session Selection or the normal
  Queue, hence no recovery step.
- After permission approve/deny the same automatic turn keeps using the idle Provider (no handoff). The idle Foreground
  Child Agent uses the idle selection and access context and creates its own Model; the Background Child Agent is
  explicitly rejected. Normal Subagent override, Goal, Background, Guide and Compact keep their own Selection ownership.
- M4 deletes the unpublished `executionOnly`, the Runtime Provider Overlay and temporary `setModel`; no special Model
  creation interface, second model binding or second Registry.

## M5: Config storage boundary and Built-in assembly

Completed within a single Environment: Personal config persistence and external modification listening; the ZCode
Built-in config enters the Registry through the unique release file, Node Source, watch/revision and Desktop/CLI
startup assembly; Host, Prompt CLI and TUI use the same config read/write implementation in their own target
Environment; migration and cleanup of the old CLI Config and the current Environment Config. Old config compatibility
is concentrated at the Storage read boundary and does not enter Registry resolution or Model creation. Cross-Environment
Provisioning, local-to-remote sync, remote editing and remote login are an independent product topic, not a completion
condition of M5 or this Provider Refactor.

## M6: Account Provider

Static and dynamic boundaries: [`../design/environment/environment.md`](../design/environment/environment.md) and
[`../design/registry/model-creation.md`](../design/registry/model-creation.md). Completed identity and execution state
chain for Start Plan, Individual Coding Plan and Team Plan: Settings saves the structured connection selection; the
Account Resolver produces the Account Overlay by the `family + planKind` declared by the Built-in Provider; the
Registry/Active Model fixes the complete Account Access; Request Auth resolves dynamic material per request and
validates the current account still matches the Access; Off-Peak and the Official MCP reuse the same Account Access
(old string keys are no longer parsed); Account API model members constrain only the corresponding Account Provider and
are not an independent Model Config fact source. Plan purchase, quota and remote-service final authorization stay with
their original services.

## Independent Topic: Environment config and Provisioning

Not part of this Provider Refactor nor a completion condition of M4 or the whole refactor (semantics:
[`../design/environment/environment.md`](../design/environment/environment.md)). Local, SSH and Cloud Environments each
save and execute their own Provider config (Entry -> Target Environment: Provider facts, Registry Service, Agent
execution). Config sync is an explicit operation and never becomes an online dependency of model requests; the
Management Service publishes the Catalog and management information, and an offline Environment still runs on existing
config.

## Cross-phase Constraints

- New abstractions use final semantics; no long-term transition type; compatibility logic concentrates on the
  unmigrated side; a new caller cannot read both the new Model and old Runtime/Registry state.
- Usage, Trace and errors of each Model Request attribute to the actual Model.
- When the shared command protocol changes, only representative regression confirmation of Desktop continuous, Mobile
  replayable and Remote Workspace identity is done (those delivery and recovery mechanisms are not part of the
  Provider Refactor).
- Each slice updates the phase design and tests first, then code; after a phase completes update the phase document,
  Roadmap and Working Memory entry.
