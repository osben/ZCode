# Provider Refactor Migration Roadmap

> Status: Work planning
>
> Last updated: 2026-08-24
>
> Current phase: M4 and the known cleanup Todo are completed; currently executing the Provider Refactor final full verification

## Migration Strategy

The migration converges upward step by step along the model call main chain: first unify the model execution interface, then organize the Registry and Provider source, and subsequently converge the Submission, config, and Environment ownership.

Each phase can be split into multiple mergable code slices, but no parallel business semantics can be retained at the end of the phase. The old system can only access the new abstraction through one explicit compatibility entry.

## Phase Overview

| Phase             | Topic                                                                | Status                                                               | Completion Sign                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0                | The macro architecture and the current status map                    | Round one completed                                                  | The work goal and the main historical fork are persisted                                                                                                              |
| M1                | The Model and ModelRequest                                           | Completed                                                            | All production model calls use the unified Model                                                                                                                      |
| M2                | The Provider config, Registry, and Model creation                    | Completed, serving as the base slice of the current M3 Merge Request | The three-layer config and the normal Model creation have entered the unified chain; the old Snapshot, Workspace Provider Catalog fallback, and dead code have exited |
| M3                | The Provider architecture cutover and the Model format consolidation | Completed                                                            | The Config/Registry, atomic Submission, model selection, settings page, and input/output format form the unique production chain                                      |
| M4                | The model execution chain, idle tasks, and Subagent                  | Completed                                                            | The idle task uses the complete hidden Provider, the same Registry/ModelFactory, and the request-period authentication; does not change the Session Selection         |
| M5                | The Config storage boundary and Built-in assembly                    | The Provider Refactor scope is completed                             | The storage shell has been privatized; Built-in/Personal/Selection is only assembled through the formal Source/Repository                                             |
| M6                | The Account Provider                                                 | The Provider Refactor scope is completed                             | The structured selection, Account Overlay, complete Access, and request-period authentication form the unique chain                                                   |
| Independent topic | The Environment config and Provisioning                              | Not part of this Provider Refactor                                   | The remote settings, login, config sync, and target Environment product capabilities are designed separately                                                          |

The phase order can be fine-tuned based on the implementation facts. When adjusting, update this roadmap and Working Memory; do not create temporary code just to maintain the numbering.

## M0: The Macro Architecture and Current Status Map

The M0 establishes the current working language:

```text
Fact source
    -> Provider construction
    -> Registry aggregation
    -> Model
    -> ModelRequest
```

The round one investigation of the Runtime, Registry, Provider Options, Reasoning, Plan, idle task, Subagent, and peripheral model calls is also completed.

The M0 only supplements new fact evidence subsequently, without carrying the implementation details.

## M1: The Model and ModelRequest

> Completed on 2026-08-12, merged into `staging` via the MR !2006.

The M1 first places all production model calls under one final public boundary. The phase goal is to unify "how the model is called," without requiring the final Registry and Provider source refactoring to be completed simultaneously:

```text
Model
├─ Properties
├─ Option Specs
├─ Options
├─ bind()
├─ generateText()
└─ streamText()
```

The main slices:

1. M1.1: Fixed types (including ModelResult / ModelEvent), build the Model Adapter Wrapper and the unit test.
2. M1.2: Migrate the main Agent Loop, Automatic Compact, Usage, and Trace.
3. M1.3: Migrate the Child Agent, Title, Goal verifier, and Project Memory.
4. M1.4: Migrate the Git, workspace generateText, WebFetch, and WebSearch.
5. M1.5: Migrate the Repo Wiki.
6. M1.6: Delete the business caller's reading of the Runtime model state, Provider options, ModelPort, and independent Provider client.

The existing Runtime, Registry, Plan, and temporary model input enters the new chain through the unique compatible Model Factory. The M1 does not require the simultaneous refactoring of the Registry Service, Builtin Provider, settings page, atomic Submission, or config refresh; the new Model must be able to take over these existing inputs.

When the M1 is completed, all production model calls use the `Model.generateText()` or `Model.streamText()`. The phase allows the batch merge; no parallel business model client is retained at the end of the phase.

## M2: The Provider Config, Registry, and Model Creation

The implementation plan of the M2 is at [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md); the target design is at
[`../design/registry/registry.md`](../design/registry/registry.md). The three-layer Config, Registry
aggregation, Model creation, and main production assembly of the normal long-term Provider are completed; the retirement result is at
[`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md). These changes serve as the base slice of the M3
implementation branch, and the unified cutover is completed together with the Submission, selection state, and settings page.

The Registry aggregation, notification, and the M2 cross-process refresh chain research are documented at [`../research/m2-registry-aggregation-and-refresh.md`](../research/m2-registry-aggregation-and-refresh.md).

The M2 converges the first-stage compatibility assembly into the formal Registry:

```text
ProviderConfigService
├─ ZCode Built-in Provider Config
├─ Account Provider Config
├─ Personal Provider Config
├─ ZCode Built-in Model Config Rules
└─ Personal Model Config Rules
                   |
                   v
            ProviderRegistryService
                     ├─ Provider[] / { modelId, config: ModelConfig }[]
                     └─ createModel(selection)
                                  |
                                  v
                             ModelFactory
                                  |
                                  v
                                Model
```

The main questions:

- The ordered, per-field override semantics of the ProviderConfig and ModelConfigRules.
- The Account Source produces the Account Provider Config and supplements the account-kind `accessId` and `models` after the Built-in and before the Personal.
- The Registry's Provider/ModelConfig View, the query index, the change notification, and the object lifecycle.
- The Settings Facade and the model selection Facade's special View.
- The ModelFactory, Adapter, and dynamic authentication dependency.
- The save, the external file modification, and the official update refresh chain.
- The idle task's transition Runtime Model reuses the resolution and ModelFactory, and limits the lifecycle to a single execution.

After the M2, the Agent Loop obtains the current Model from the process-level Registry; the updated creation creates a new object, and the old Loop continues to hold the old Model.

The M2 only establishes the boundary for the Account Provider and the idle task transition chain that can access the unified ModelFactory, maintaining the behavior at that time.
The identity, entitlement, dynamic credentials, and refresh state of the Account Provider are reconstructed in M6; the submission and lifecycle
semantics of the idle task and Subagent are consolidated in M4, and this transition Runtime Model chain is deleted.

## M3: The Provider Architecture Cutover

The complete implementation plan is at [`03-provider-architecture-cutover.md`](./03-provider-architecture-cutover.md); the target semantics are at [`../design/interaction/interaction.md`](../design/interaction/interaction.md) and [`../design/registry/settings.md`](../design/registry/settings.md).

The M3 combines the M2's completed Config/Registry foundation with the atomic Submission, model selection state, Provider settings page, and the Model input
output format into one complete cutover. The implementation is concentrated in the same integration branch, organized internally by clearly-职责-separated commits and review areas.

The interaction main chain changes the current "switch the model first, then send the text" to one atomic Submission:

```text
Submission
├─ prompt
├─ attachments
├─ mode
└─ modelSelection
```

It also needs to converge the Composer Draft, App Recent, Session Selection, Queue, Guide/"immediate", Edit, Retry, Prompt CLI, and TUI model semantics, complete the settings page auto-save, reorder, and formal Model connectivity testing, and delete the ModelRef, shared mutable Runtime model state, and independent Connectivity Probe.

The Session only persists the Selection. When the Submission starts a new Agent Loop, the Model is obtained from the Registry and the Options are bound.

The M3 is completed in one large MR. The phase is reviewed in the areas of the Config/Registry, Submission, CLI admission, ModelRef retirement, Settings
Service, Settings UI, Connectivity, Model Format, and cleanup tests; no single area concludes with a long-term dual-track
semantics.

## M4: The Model Execution Chain, Idle Tasks, and Subagent

The formal phase design is at [`04-model-execution-cutover.md`](./04-model-execution-cutover.md); the long-term target semantics are at
[`../design/execution/execution.md`](../design/execution/execution.md).

The M4 does not add a special Model type, but consolidates the idle task to the normal model execution chain:

- The `builtin:offpeak-idle-plan` becomes the complete Built-in Provider with `visibility: "hidden"`; the hidden only affects the settings page and the model selector.
- The Provider uses `access.type = "request-auth"`; the dynamic authentication is injected for each request, and fails before the network request when missing.
- The idle Submission carries the standard ModelSelection and the narrow execution context, and creates the Model through the same Registry/ModelFactory.
- The idle execution does not write the App Recent, Configured Default, Session Selection, or normal Queue; therefore, there is no recovery step.
- After the permission approval or rejection, the same automatic turn continues to use the idle Provider, without the Provider handoff.
- The idle Foreground Child Agent uses the idle selection and the access context, and creates its own Model; the Background Child Agent is explicitly rejected.
- The normal Subagent override, Goal, Background, Guide, and Compact maintain their own existing Selection ownership.

The M4 deletes the unpublished `executionOnly`, the Runtime Provider Overlay, and the temporary `setModel`; does not establish the special Model creation
interface, the second model binding, or the second Registry.

## M5: The Config Storage Boundary and Built-in Assembly

The Provider Refactor has completed the physical storage boundary and the Built-in assembly within a single Environment:

- The Personal config persistence and the external modification listening.
- The ZCode Built-in config enters the Registry through the unique release file, Node Source, watch/revision, and the Desktop/CLI startup assembly.
- The Host, Prompt CLI, and TUI use the same config read/write implementation within their respective target Environment.
- The migration and cleanup of the old CLI Config and the current Environment Config.

The old config compatibility is concentrated in the Storage read boundary, without entering the Registry resolution and Model creation.

The cross-Environment Provisioning, the sync from the local to the remote, the remote editing, and the remote login belong to the independent product topic; they are not the completion condition of the M5 or this Provider Refactor.

## M6: The Account Provider

The static and dynamic boundaries are documented at [`../design/environment/environment.md`](../design/environment/environment.md) and [`../design/registry/model-creation.md`](../design/registry/model-creation.md).

This refactoring has completed the identity and execution state chain of the Start Plan, Individual Coding Plan, and Team Plan:

- The Settings saves the structured connection selection;
- The Account Resolver produces the Account Overlay by the `family + planKind` declared by the Built-in Provider;
- The Registry/Active Model fixes the complete Account Access;
- The Request Auth resolves the dynamic material for each request, and validates that the current account still matches the Access;
- The Off-Peak and the Official MCP reuse the same Account Access; the old string key is no longer parsed;
- The Account API returns the model members that only constrain the corresponding Account Provider; they are not the independent Model Config fact source.

The plan purchase, quota, remote service final authorization, and other product logic still each belong to their original service; they are not the Provider static fact.

## Independent Subsequent Topic: The Environment Config and Provisioning

This topic is not part of this Provider Refactor, nor is it the completion condition of the M4 or the entire Provider Refactor.

The target semantics are documented at [`../design/environment/environment.md`](../design/environment/environment.md).

The Local, SSH, and Cloud Environment each save and execute the Provider config:

```text
Entry
  |
  v
Target Environment
├─ Provider facts
├─ Registry Service
└─ Agent execution
```

The config sync is an explicit operation; it does not become the online dependency of the model request. The Management Service publishes the Catalog and the management information; the Environment can still run with the existing config when it is offline.

## Cross-Phase Constraints

- The new abstraction uses the final semantics; no long-term transition type is established.
- The compatibility logic is concentrated on the unmigrated side.
- The new caller cannot simultaneously read the new Model and the old Runtime/Registry state.
- The Usage, Trace, and errors of each Model Request must be attributed to the actual Model.
- When the shared command protocol changes, only the representative regression confirmation of the Desktop continuous, Mobile replayable, and the Remote Workspace identity is made without accidental damage; these delivery and recovery mechanisms are not part of the Provider Refactor.
- Each slice first updates the phase design and the test, and then implements the code.
- After the phase is completed, update the corresponding phase document, Roadmap, and Working Memory entry.
