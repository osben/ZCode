# M3: Provider Architecture Cutover

> Status: Current baseline implementation completed, pending integration decision and release gate
>
> Last updated: 2026-08-21
>
> Implementation carrier: the current Draft Merge Request; the source branch keeps historical M2 naming, phase and review semantics follow M3, with no separate parallel branch
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/03-provider-architecture-cutover.md`

M3 is a complete architecture cutover on top of the Provider Config, Registry, ModelFactory and production access
already in the current Merge Request (the former M2 foundation). It completes atomic Submission, model selection
state and the Provider settings page, and deletes the old protocols and runtime state they replace. The whole change
is reviewed and release-verified as one large Merge Request; M2 is not published separately.

Target designs: [`../design/registry/registry.md`](../design/registry/registry.md) (Config, Registry, Model
creation); [`../design/interaction/interaction.md`](../design/interaction/interaction.md) (Draft, Selection,
Submission, Queue, Guide); [`../design/registry/settings.md`](../design/registry/settings.md) (settings save,
reordering, connectivity testing); [`../design/execution/execution.md`](../design/execution/execution.md) (current
phase and execution-scoped Provider boundaries).

## Main Chain After M3

```text
Official Config -+
Personal Config -+-> Process Registry -- Settings View / Selection View / createModel(ModelSelection)
Account Config --+

Composer Draft / CLI Input (prompt, attachments, mode, ModelSelection)
  -> CoreSubmission -> CLI Admission (start-now | queue | guide)
  -> Session Selection + Active Model -> ModelRequest
```

Three boundaries:

1. Config and Account Source determine which Providers and models exist in the current Environment.
2. Submission freezes one user input and its model intent; delivery never reads the Composer's later state.
3. The Registry creates a Model from Selection; the Model and request results are the execution facts for Usage,
   Trace and error attribution.

Foundation already done (former M2, not re-implemented here): three-layer Provider Config; process Registry,
Settings/Selection Facade and ModelFactory; production assembly for Host, Worker, Prompt CLI and TUI; Account Provider
static config and request-period auth boundaries; retirement of old Catalog, Preset, Workspace Snapshot and Runtime
Provider static facts.

## Slices

**M3.0 Baseline and review structure (remote topology pending decision).** See
[`03-staging-integration.md`](./03-staging-integration.md). Local staging was historically reconstructed; do not
merge or rebase the remote branch before the user decides. M3 advances auditable slices from the current M2 working
tree. The topology decision and integration gate must complete before final release, retain only valid Provider
changes, and verify product semantics such as Video Input, model input types and ox-alpha reasoning; integration
must never restore an old implementation that staging already deleted. The Merge Request keeps multiple commits by
review area (reduce review cost; not coexisting dual tracks): A Config / Registry Foundation; B Submission /
Selection Protocol; C CLI Admission / Queue / Guide / Session; D ModelRef and Old Runtime State Retirement; E
Provider Settings Service; F Provider Settings UI; G Connectivity Testing / Model / Adapter; H Migration Cleanup,
Tests, Documentation.

**M3.1 Formal behavior Spec and test map.** Write atomic Submission into the long-term Spec and remove the old wording
"Queue reads the latest Session model when consuming". Synchronize: Conversation Protocol Declaration, Conversation
Product State Space, Conversation Case Catalog and Coverage Matrix, Feature Graph edges for Composer, Queue, Guide,
Edit, Retry and model switching, and desktop continuous / mobile replayable delivery boundaries for the same
Submission. Working Memory sets the migration target; the formal Spec sets post-release behavior; test cases are
extracted from the Spec, not from the current implementation.

**M3.2 Atomic `CoreSubmission`.** Shared Protocol, Renderer, Services and CLI use one structure:

```ts
interface CoreSubmission {
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: readonly SubmissionAttachment[];
  mode?: AgentMode;
}
```

Normal sending no longer depends on the call order `switchModelConfig` then `sendText`, nor passes "the model for the
next message" through mutable Runtime. Desktop continuous and Mobile replayable may use different transmission
recovery, but both carry the same complete Submission. Remote Workspaces keep passing `workspaceIdentity` and
`remoteSessionId`; owner, lease and replayable recovery responsibilities are unchanged.

**M3.3 CLI Admission is the execution authority.**

```text
Core idle  -> start-now: Registry creates Model; Session Selection = Submission Selection; start Agent Loop
Core busy  -> queue: Queue item stores the complete Submission
Guide accepted: the Request in flight continues with the old Model; at the Step boundary create and switch the new
  Model; Session Selection = Guide Selection; later Steps use the new Model
```

The Queue uses the Selection stored in the enqueued object when dequeuing; later Composer switches, other Session
inputs and Config updates cannot rewrite an accepted Queue item. Guide and "immediate" share semantics; if creating
the Model, injecting Context or updating Session state cannot complete as a whole, the complete Submission falls to
the Queue (never a partial state that only switches the model or only inserts text). Edit and Retry derive from the
source Submission and inherit its Selection by default; a future "retry with current model" must form an explicit
Submission carrying a new Selection.

**M3.4 Renderer Selection state.** Composer Selection expresses only the next Submission; the Renderer owns Draft and
App Recent and does not pre-modify the CLI Runtime:

```text
Composer edits Selection B -> updates Draft; Active Model A unaffected
User submits -> Submission B; App Recent updated after acceptance; CLI updates Session Selection at execution start
```

Initialization and write timing of App Recent, Configured Default, Draft, Session Selection and Active Model follow
[`../design/interaction/selection-state.md`](../design/interaction/selection-state.md). Prompt CLI and TUI do not
read or write App Recent.

**M3.5 Retire `ModelRef` and shared mutable model state.** Delete `ModelRef`, `defaultModelRef` and string
`providerId/modelId` internal protocols on the normal execution chain:

```text
ModelRef.providerId / modelId -> ModelSelection
ModelRef.variant              -> ModelSelection.options.reasoningLevel
ModelRef.role / Lite          -> deleted
ModelRef.source               -> Submission or Trace metadata
```

Structured `ModelSelection` is the model intent for in-process state and cross-process protocols. CLI human input may
keep the `provider/model` shorthand, parsed only at the Entry boundary (never stored, concatenated or re-parsed
internally). A reference audit confirms all production consumers migrated before deletion. `turnRuntimeModel` belongs
to the M4 execution-scoped boundary: this phase neither expands it nor requires its deletion.

**M3.6 Provider Settings Service.** The Renderer reads and modifies Providers through the target Environment's Provider
Settings Service, which: returns the Settings View; saves the complete Provider Draft and computes the sparse Personal
Overlay; handles Provider/Model add, rename, delete and reorder; waits for Config persistence and the corresponding
Registry revision; executes connectivity tests by creating a Model through the Registry; projects domain errors into a
stable settings error structure. The Renderer does not read physical configuration, run Overlay, judge Registry
admission or assemble Provider requests. Save completion point: Renderer submits Draft revision N -> Service saves
Personal Config -> Registry observes Config revision N -> Service returns Settings View revision N -> Renderer shows
"saved".

**M3.7 Settings page interaction.** Auto-save: text submits on blur, Enter or Provider switch; selections, toggles and
drags submit immediately after the operation; the page shows dirty, saving, success and failure, and a success check
appears only after the Host confirms the corresponding revision. Adding a Provider immediately creates
`new-provider[-N]` (no secondary "save" button); Provider ID and user name are unified and rename is one atomic
Service operation; Model IDs are edited on an independent model editing page (no inline name editing in the list);
Personal-only Providers and reorderable Personal models support dragging; after reordering Personal Overlays are
rearranged by Effective order while Official override items keep Official order; Desktop and Mobile Web share one
Service contract and follow UI specs and i18n.

**M3.8 Connectivity via the formal Model.** Clicking test flushes the unsaved Draft, waits for Config and Registry
update, then:

```text
flush Draft -> wait Registry revision -> createModel(ModelSelection)
  -> Model.streamText(minimal request) -> consume stream -> normalized result
```

This reuses the formal Adapter, Request Auth, Reasoning Mapping and error boundaries. The independent Connectivity
Probe and Renderer/Host hand-assembled Endpoint/Header/body bypasses are deleted.

**M3.9 Delete old chains and full audit.** Deletion gate is behavioral, not by filename:

- normal sending has no `switchModelConfig -> sendText` timing;
- the Queue does not read the current Composer or latest Session model when consuming;
- the normal execution chain no longer reads `ModelRef`, `defaultModelRef` or Lite role;
- the Renderer no longer parses Provider Config, Account state or Registry admission;
- connectivity testing has no independent Probe;
- Provider static facts do not flow back from Catalog, Preset, Workspace Snapshot or old CLI Config;
- Usage and Trace take model identity from the actual Model;
- old compatibility code remains only for M4, M6, M7 boundaries named in Design.

Old code with no provable production consumer is deleted directly, with no new fallback.

## Verification Matrix

Each item needs unit or integration tests; cross-process, recovery and UI timing are covered by E2E.

| Scenario                                       | Required result                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Loop is using A, Composer switches B           | Current Request and later Steps continue A until a new Submission or Guide arrives                    |
| Submit B when idle                             | Submission, Session Selection, Active Model and Usage use B                                           |
| B enqueued when busy, then Composer switches C | B still uses B when dequeued                                                                          |
| Guide uses B                                   | Request in flight uses A, later Steps use B, Session Selection becomes B                              |
| Edit / Retry                                   | Inherit the source Submission's Selection by default                                                  |
| App restart or recovery                        | Draft, App Recent, Session Selection recover by their scopes; CLI/TUI do not consume App Recent      |
| API Key or Config update                       | Existing Active Model unchanged; next Model creation uses the latest Registry                         |
| Settings page test                             | Save first, wait for Registry, then call through the formal Model                                     |
| Provider / Model drag                          | Effective order and Personal Overlay order match settings design; UI rolls back on failure           |
| Provider / Model rename                        | Current selection migrates forward; completed history keeps the old identity                          |
| Desktop / Mobile submission                    | Both ends transmit the same complete Submission; continuous/replayable boundaries unchanged           |
| Remote Workspace                               | Uses the remote Environment Registry; no local Provider config or authentication transmitted          |

## Deferred

- execution-scoped Providers, idle tasks and Subagent forced model strategies: M4;
- remote management publishing, cross-Environment sync and independent login for Provider Config: M5/M7;
- Account Provider identity, entitlement and dynamic credential internal models: M6;
- Adapter Reasoning dialect refactoring is not mixed with atomic Submission (existing behavior stays compatible);
- `turnRuntimeModel` remains only in the already-defined special execution boundaries.

## Completion Definition

1. Three-layer Config and the process Registry are the sole fact source for normal Providers.
2. All user input enters Core as a complete Submission; Queue and Guide use the same structure.
3. Composer, App Recent, Session Selection and Active Model state and timing match the Design.
4. `ModelRef` and shared mutable Runtime model state exit the normal execution chain.
5. The settings page completes auto-save, editing, reordering and connectivity testing through the formal Service.
6. Old Provider, model switching and Connectivity Probe chains are deleted.
7. Type checks, Lint, affected unit tests, Provider/Conversation specialized tests and necessary E2E pass.
8. Merge Request commits and Changes trace back by review area; Working Memory and the formal Spec are synchronized
   with actual results.

Design gaps found during implementation go into the M3 implementation log with a recommended decision from existing
principles; decisions changing target semantics, public protocols or phase boundaries go to Human in the Loop before
the Design is modified.
