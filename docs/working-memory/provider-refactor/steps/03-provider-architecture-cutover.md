# M3: Provider Architecture Cutover

> Status: Current baseline implementation completed, pending integration decision and release gate
>
> Last updated: 2026-08-21
>
> Implementation carrier: Current Draft Merge Request; source branch temporarily retains historical M2 naming, phase and review semantics are based on M3, without opening a separate parallel branch

M3 is a complete architecture cutover. The Provider Config, Registry, ModelFactory, and production access already completed in the current Merge Request form its foundation; this phase continues to complete atomic Submission, model selection state, Provider settings page, and delete old protocols and old runtime state replaced by the new chain. The entire change is accepted for review and release verification as a large Merge Request; this migration no longer publishes the already-completed M2 foundation separately and opens M3 separately.

Target designs are located at:

- [`../design/registry/registry.md`](../design/registry/registry.md): Config, Registry, and Model creation;
- [`../design/interaction/interaction.md`](../design/interaction/interaction.md): Draft, Selection, Submission, Queue, and Guide;
- [`../design/registry/settings.md`](../design/registry/settings.md): Settings page save, reordering, and connectivity testing;
- [`../design/execution/execution.md`](../design/execution/execution.md): Current phase and execution-scoped Provider boundaries.

This document organizes these confirmed designs into an executable, reviewable, and verifiable migration plan.

## Post-completion Main Chain

After M3, Provider static facts, user submission intent, and model execution each pass through a single entry point:

```text
Official Config ─┐
Personal Config ─┼─> Process Registry
Account Config ──┘        ├─ Settings View
                           ├─ Selection View
                           └─ createModel(ModelSelection)

Composer Draft / CLI Input
├─ prompt
├─ attachments
├─ mode
└─ ModelSelection
          |
          v
     CoreSubmission
          |
          v
CLI Admission
├─ start-now
├─ queue
└─ guide
          |
          v
Session Selection + Active Model
          |
          v
      ModelRequest
```

This chain forms three clear boundaries:

1. Config and Account Source determine which Providers and models exist in the current Environment.
2. Submission freezes a user's input and its model intent; the delivery process no longer reads the Composer's later state.
3. The Registry creates a Model based on Selection; the Model and request results are the execution facts for Usage, Trace, and error attribution.

## Current Foundation and Phase Relationships

The original M2 has already completed M3's Provider infrastructure:

- Three-layer Official, Personal, Account Provider Config;
- Process-level Registry, Settings/Selection Facade, and ModelFactory;
- Main production assembly for Host, Worker, Prompt CLI, TUI;
- Static config and request-period authentication boundaries for Account Providers;
- Retirement of the old Catalog, Preset, Workspace Snapshot, and Runtime Provider static facts.

These changes have not been independently merged, so the M2 in the Roadmap is treated as M3's completed foundation slice. M3 does not re-implement them; it completes the interaction and settings chain on the same branch, then enters release verification as a single self-consistent system.

## Implementation Scope

### M3.0: Freeze Baseline and Review Structure (Remote Topology Pending Decision)

See [`03-staging-integration.md`](./03-staging-integration.md) for the specific plan. The current local staging has undergone historical reconstruction; do not merge or rebase the remote branch before user decision; M3 first advances auditable slices using the current M2 working tree as authority. The topology decision and integration gate must still be completed before final release, confirming only valid Provider changes are retained, and completely verifying product semantics such as Video Input, model input types, and ox-alpha reasoning; no integration may restore the old implementation that staging has already deleted.

The large Merge Request retains multiple clearly职责-separated commits, organized by the following review areas:

```text
A  Config / Registry Foundation
B  Submission / Selection Protocol
C  CLI Admission / Queue / Guide / Session
D  ModelRef and Old Runtime State Retirement
E  Provider Settings Service
F  Provider Settings UI
G  Connectivity Testing / Model / Adapter
H  Migration Cleanup, Tests, and Documentation
```

Areas are used to reduce review cost and do not form dual-track implementations that can coexist long-term.

### M3.1: Update Formal Behavior Spec and Test Map

Before implementation, write atomic Submission to the long-term Spec, and eliminate the old wording "Queue reads the latest Session model when consuming" from existing documentation. Need to synchronously check:

- Conversation Protocol Declaration;
- Conversation Product State Space;
- Conversation Case Catalog and Coverage Matrix;
- Edges in the Feature Graph for Composer, Queue, Guide, Edit, Retry, and model switching;
- Delivery boundaries for desktop continuous and mobile replayable for the same Submission.

Working Memory determines the migration target; the formal Spec determines the post-release product behavior. Test cases are extracted from the Spec, not reverse-engineered from the current implementation.

### M3.2: Establish Atomic CoreSubmission Protocol

Shared Protocol, Renderer, Services, and CLI use the same Submission structure:

```ts
interface CoreSubmission {
  prompt: string;
  modelSelection: ModelSelection;
  attachments?: readonly SubmissionAttachment[];
  mode?: AgentMode;
}
```

The protocol accepts a single atomic submission of prompt, attachments, mode, and ModelSelection. Normal sending no longer relies on the call sequence of `switchModelConfig` and `sendText`, nor passes "the model for the next message" through mutable Runtime.

Desktop continuous and Mobile replayable can use different transmission recovery mechanisms, but both carry the same complete Submission. Remote Workspaces continue to pass `workspaceIdentity` and `remoteSessionId`; the Provider refactoring does not change the remote control's owner, lease, or replayable recovery responsibilities.

### M3.3: Make CLI Admission the Execution Authority

The CLI explicitly chooses one admission result when receiving a Submission:

```text
Core idle
└─ start-now
   ├─ Registry creates Model
   ├─ Session Selection = Submission Selection
   └─ Start Agent Loop

Core busy
└─ queue
   └─ Queue item saves complete Submission

Guide accepted
├─ Currently sent Request continues using old Model
├─ Step boundary creates and switches new Model
├─ Session Selection = Guide Selection
└─ Subsequent Steps use new Model
```

The Queue uses the Selection from the enqueued object when dequeuing. Later Composer switches, other inputs during the Session, and Config updates cannot rewrite an already-accepted Queue item.

Guide and "immediate" use the same semantics. When creating a Model, injecting Context, or updating Session state cannot be completed as a whole, the complete Submission transitions to the Queue, without leaving a partial state that only switches the model or only inserts text.

Edit and Retry are derived from the source Submission, defaulting to inheriting the source Selection; if "retry with the current model" is provided in the future, it must form an explicit Submission carrying a new Selection.

### M3.4: Converge Renderer's Selection State

Selection in the Composer only expresses the next Submission. The Renderer is responsible for Draft and App Recent, and does not pre-modify the CLI Runtime:

```text
Composer edits ModelSelection B
├─ Updates Draft
└─ Does not affect Active Model A

User submits
├─ Forms Submission B
├─ App updates App Recent after acceptance
└─ CLI updates Session Selection after starting execution
```

The initialization and write timing for App Recent, Configured Default, Draft, Session Selection, and Active Model continue to follow [`../design/interaction/selection-state.md`](../design/interaction/selection-state.md). The Prompt CLI and TUI do not read/write App Recent.

### M3.5: Retire ModelRef and Shared Mutable Model State

M3 deletes `ModelRef`, `defaultModelRef`, and string-based `providerId/modelId` internal protocols on the normal execution chain. Existing fields are migrated by their true semantics:

```text
ModelRef.providerId / modelId -> ModelSelection
ModelRef.variant              -> ModelSelection.options.reasoningLevel
ModelRef.role / Lite          -> Deleted
ModelRef.source               -> Submission or Trace metadata
```

Structured `ModelSelection` is the model intent for in-process state and cross-process protocols. CLI human input can continue to provide `provider/model` shorthand, but parsing only occurs at the Entry boundary; internally, no saving, concatenating, or re-parsing of that string.

Use a reference audit to confirm all production consumers have migrated before deletion. The `turnRuntimeModel` belongs to the M4 boundary of execution-scoped Providers; this phase neither expands its usage nor uses its deletion as the M3 completion condition.

### M3.6: Complete Provider Settings Service

The Renderer reads and modifies Providers through the target Environment's Provider Settings Service. The Service is responsible for:

- Returning a Settings View suitable for the settings page;
- Saving the complete Provider Draft, and computing sparse Personal Overlay;
- Provider/Model addition, renaming, deletion, and reordering;
- Waiting for Config persistence and the corresponding Registry revision to take effect;
- Using the Registry to create a Model and execute connectivity testing;
- Projecting domain errors into a stable settings page error structure.

The Renderer does not read physical configuration, does not execute Overlay, does not judge Registry admission, and does not assemble Provider requests.

The save timing needs to form a clear completion point:

```text
Renderer submits Draft revision N
        |
        v
Settings Service saves Personal Config
        |
        v
Registry observes Config revision N
        |
        v
Service returns Settings View revision N
        |
        v
Renderer displays "saved"
```

### M3.7: Complete Settings Page Interaction

The settings page adopts the already-determined auto-save semantics: text is submitted on blur, Enter, or Provider switch; selections, toggles, and drags are submitted immediately after the operation completes. The page displays dirty, saving, success, and failure states, showing a success checkmark only after the Host confirms the corresponding revision.

This slice simultaneously completes:

- Adding a Provider immediately creates `new-provider[-N]`, without retaining a secondary "save" button;
- Provider ID and user name are unified; renaming is completed through an atomic Service operation;
- Model IDs are modified on an independent model editing page; the list does not provide inline name editing;
- Personal-only Providers and reorderable Personal models support dragging;
- After reordering, Personal Overlays are rearranged by Effective order; Official override items maintain the Official order;
- Desktop and Mobile Web use the same Service contract; layout and feedback follow the project's UI specifications and internationalization requirements.

### M3.8: Use Formal Models for Connectivity Testing

When the settings page clicks test, first submit the unsaved Draft, wait for Config and Registry updates to complete, then create a formal Model by the Registry:

```text
flush Draft
    -> wait Registry revision
    -> createModel(ModelSelection)
    -> Model.streamText(minimal request)
    -> consume stream
    -> normalized result
```

This chain reuses the formal Adapter, Request Auth, Reasoning Mapping, and error boundaries. M3 deletes the independent Connectivity Probe, and the Renderer/Host manual assembly of Endpoint, Header, or request body bypass.

### M3.9: Delete Old Chains and Complete Full Audit

The last slice deletes replaced code based on references and runtime verification. The deletion gate is behavioral conditions, not filename guessing:

- Normal sending has no `switchModelConfig -> sendText` timing;
- The Queue does not read the current Composer or latest Session model when consuming;
- The normal execution chain no longer reads `ModelRef`, `defaultModelRef`, or Lite role;
- The Renderer no longer parses Provider Config, Account state, or Registry admission;
- The connectivity testing has no independent Probe;
- Provider static facts no longer flow back from the Catalog, Preset, Workspace Snapshot, or old CLI Config;
- Usage and Trace obtain model identity from the actual Model;
- Old compatibility code only retains the M4, M6, M7 boundaries explicitly defined in the Design.

Old code for which no production consumer can be proven is directly deleted, without establishing new fallback.

## Verification Matrix

M3's minimum behavior matrix is as follows. Each item requires unit or integration tests; cross-process, recovery, and UI timing are covered by the corresponding E2E.

| Scenario                                       | Required Result                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Loop is using A, Composer switches B           | Current Request and subsequent Steps continue A, until a new Submission or Guide is received           |
| Submit B when idle                             | Submission, Session Selection, Active Model, and Usage use B                                           |
| B enqueued when busy, then Composer switches C | B still uses B when dequeued                                                                           |
| Guide uses B                                   | Currently sent Request uses A, subsequent Steps use B, Session Selection updated to B                  |
| Edit / Retry                                   | Default inheritance of source Submission's Selection                                                   |
| App restart or recovery                        | Draft, App Recent, Session Selection recovered by respective scopes; CLI/TUI do not consume App Recent |
| API Key or Config update                       | Existing Active Model unchanged; next Model creation uses the latest Registry                          |
| Settings page test                             | Save first, wait for Registry, then call through the formal Model                                      |
| Provider / Model drag                          | Effective order and Personal Overlay order match settings design; rollback UI on failure               |
| Provider / Model rename                        | Forward migration of current selection; completed history retains old identity                         |
| Desktop / Mobile submission                    | Both ends transmit the same complete Submission; continuous/replayable boundaries unchanged            |
| Remote Workspace                               | Uses remote Environment Registry; does not transmit local Provider config or authentication            |

## Explicitly Deferred to Subsequent Phases

M3 does not simultaneously expand the following issues:

- execution-scoped Providers, idle tasks, and Subagent forced model strategies continue to be handled by M4;
- Remote management publishing, cross-Environment sync, and independent login for Provider Config continue to be handled by M5/M7;
- Account Provider's identity, entitlement, and dynamic credentials internal models continue to be deepened by M6;
- Adapter's Reasoning dialect refactoring is not mixed with atomic Submission; existing behavior maintains compatibility;
- `turnRuntimeModel` only remains in the already-defined special execution boundaries.

These boundaries allow the current large Merge Request to completely switch the normal product chain, while simultaneously avoiding entangling idle tasks, plans, and remote account refactoring into this phase again.

## Completion Definition

M3 is only considered complete when the following conditions are simultaneously met:

1. Three-layer Config and process-level Registry are the sole fact source for normal Providers.
2. All user input enters Core as a complete Submission; the Queue and Guide use the same structure.
3. The state and timing of Composer, App Recent, Session Selection, and Active Model match the Design.
4. ModelRef and shared mutable Runtime model state exit the normal execution chain.
5. The settings page completes auto-save, editing, reordering, and connectivity testing through the formal Service.
6. Old Provider, model switching, and Connectivity Probe chains have been deleted.
7. Type checks, Lint, affected unit tests, Provider/Conversation specialized tests, and necessary E2E pass.
8. The Merge Request's commits and Changes can be traced back by review area; Working Memory and the formal Spec have been synchronized with actual results.

If issues not covered by the design arise during implementation, record them in the M3 implementation log and make recommended decisions based on already-determined principles to keep moving forward; decisions that change target semantics, public protocols, or phase boundaries enter Human in the Loop before modifying the Design.
