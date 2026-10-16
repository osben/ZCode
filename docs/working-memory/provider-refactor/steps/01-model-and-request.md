# M1: Model and ModelRequest Implementation

> Status: Completed and merged into staging
>
> Completion date: 2026-08-12
>
> MR: !2006

Target design is in [`../design/model/model.md`](../design/model/model.md). This document only records M1's implementation scope, actual results, and remaining issues.

## Implementation Goals

M1 unifies "how models are invoked." Previously, main Agent, Compact, Repo Wiki, and other auxiliary tasks independently read Runtime model ref, capability, provider options, API Key, or Adapter Registry, and model identity, request parameters, and Usage attribution could come from different states.

The phase goal is to route all production model requests through a single public boundary:

```text
Existing Config / Registry / Runtime / Plan inputs
                    |
                    | Unique compatible assembly entry
                    v
                  Model
                    |
                    v
              ModelRequest
                    |
                    v
            Existing Provider Adapter
```

M1 does not refactor the final Provider Registry. Old inputs are allowed to continue existing within the single compatible entry; business callers after the Model must not understand old Runtime and Registry.

## Planned Slices

```text
M1.1  Public types, Model Adapter Wrapper, and unit tests
M1.2  Main Agent Loop, Automatic Compact, Usage, and Trace
M1.3  Child Agent, Title, Goal verifier, and Project Memory
M1.4  Git, workspace/generateText, WebFetch / WebSearch
M1.5  Repo Wiki
M1.6  Delete callers' old ModelPort, Runtime, and Registry reads
```

Phase completion criteria are calculated for the entire M1. Implementation can be submitted in batches, but parallel model clients cannot be retained long simply because some callers have already migrated.

## Actual Results

M1 has converged all known production model calls to `Model.generateText()` or `Model.streamText()`, including Repo Wiki's original independent Provider request chain.

The Agent Loop obtains a Model at start time and maintains the reference during continuous execution. Ordinary Steps, Automatic Compact, and Child Agents no longer decide subsequent request model identity through mutable Runtime. Usage, Trace, and message attribution use the actual Model.

The public ModelRequest no longer carries model, Provider connection, or arbitrary provider options. Properties, Option Specs, and Options are handled at the unified entry; Provider-specific reasoning conversion is still handled by the existing Adapter path.

M1 retained `ModelDescriptor` per the then-input structure. The new Registry design will use ProviderConfig and ModelConfig to provide static viewing data, without changing the already-completed Model invocation boundary.

Complete implementation facts and independent decisions are in [`01-model-and-request-implementation-log.md`](./01-model-and-request-implementation-log.md).

## Scope Expanded During Implementation

Repo Wiki migration confirmed that its truncation recovery is a Wiki business strategy and should continue atop the unified Model. The minimal Model Adapter injection for old app-server also retained a clear compatible boundary.

Output budget responsibility was further clarified during implementation: the Model strictly validates caller inputs; if Compact, Memory, and other tasks need smaller budgets, the tasks compute them themselves, without silent clamping within the Model.

These decisions did not change M1's goal but went beyond the initial type definition details, all recorded in the implementation log.

## Post-Merge Review

No P0s were found in the review. The Model and ModelRequest main boundary is confirmed to have been established, along with the following closure items:

- Workflow Child not yet using formal Model Factory.
- Unknown states of some Properties may be hardened to "not supported."
- Guide's model switching behavior was undecided at review time; subsequently determined to take effect from the next Model Step within the current Loop.
- Dynamic header refresh still reacquires the full Provider object.
- Compatible entry points are still easier for new code to enter than the final goal.

Detailed evidence and priorities are in [`01-model-and-request-review.md`](./01-model-and-request-review.md). Issues related to Model source are further converged by M2's Registry and ModelFactory design.

Guide/"immediate" target timing is in [`../design/interaction/interaction.md`](../design/interaction/interaction.md); the "undecided" in the Review is preserved as a historical fact from that time.

## Completion Judgment

M1 is complete. Its stable boundary is:

```text
Business model calls
└─ Model.generateText() / streamText()

Single-call input
└─ ModelRequest

Continuous execution model identity
└─ Immutable Model held by Agent Loop
```

M2 replaces the Model creation source; it does not roll back this public invocation chain.
