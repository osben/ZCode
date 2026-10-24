# Todo 13 addendum: ModelSelection value construction and Option defaults

> Status: absorbed and done (2026-08-25). The sparse value construction and the Select/Submission
> two-stage semantics are part of the Todo 13 implementation and Design.
>
> Related: [`todo-13-target-host-model-selection-authority.md`](./todo-13-target-host-model-selection-authority.md)

## 1. Core rule

`ModelSelection` is an immutable selection value, not a mutable container patched in place.

```ts
interface ModelSelection {
  providerId: ProviderId;
  modelId: ModelId;
  options?: {
    reasoningLevel?: string;
    maxOutputTokens?: number;
  };
}
```

After a model switch or an Option edit, the initiator submits a new, complete `ModelSelection`.
Registry and ModelFactory consume the value; they never rewrite an old Selection into a new one.
Terminology: say "reconstruct a `ModelSelection`", not "reconstruct a Model Selection Option".

## 2. Model identity switch: the initiator rebuilds the Selection

Switching from model A to B does not overwrite `providerId/modelId` on the old Selection, and the common
layer has no "clear/migrate/compat old options" algorithm.

```text
old ModelSelection A -> user picks target B
  -> switcher builds from the target candidate and this user intent
  -> new ModelSelection B { providerId, modelId, options: only values explicitly given for B }
```

Use `{ providerId: target.providerId, modelId: target.modelId }`. Never spread the previous Selection as a
generic switch mechanism (`{ ...previousSelection, providerId, modelId }`): it leaks A's explicit options
into B. If an interaction later needs "switch carrying a setting", that interaction constructs the target
Selection explicitly and records its own product contract.

## 3. Option edit on the same model still yields a new value

Editing reasoning etc. keeps model identity but still produces a new `ModelSelection`
(`{ providerId, modelId, options: { reasoningLevel: "high" } }`). A same-model Option editor may keep
other still-valid explicit leaves (editing one selection intent), unlike automatic cross-model option
migration. Registry, ModelFactory and Session owner never mutate a Selection in place.

## 4. Options hold explicit intent only

- Leaves not explicitly specified are not written.
- `options: {}` normalizes to the whole `options` field missing.
- A formal Selection never stores `null`; a patch API may use `null` to clear, and the persisted result
  deletes the leaf.
- Explicitly choosing a value equal to the current default is still an explicit pin and is stored.
- UI merely displaying the current default is not an explicit assignment.

```text
new ModelSelection (explicit options) + current Model Config Option Spec defaults
  -> Target Worker ModelFactory -> Active Model.options (complete, immutable)
```

Defaults resolved by ModelFactory go only into the Active Model; they are never written back to Draft,
App Recent, Session Selection or other product records.

## 5. maxOutputTokens boundary

`maxOutputTokens` belongs to the generic `ModelSelection.options` contract, but no current model-selection
interface assigns it, so the leaf stays absent and ModelFactory uses the Model Config default. No
inheritance/clearing policy on switch, no writing the default back, no proactive filling in UI/RPC/repository
paths. If a product later exposes editing, it first defines interaction, persistence and inheritance; the
caller then writes the explicit choice into a new Selection.

## 6. Review checkpoints

1. Switch callers rebuild `ModelSelection` from the target candidate; no spreading of the old Selection.
2. Registry/ModelFactory offer no cross-model Options migration, clearing or guessing helper.
3. Paths without explicit `maxOutputTokens` input keep the field absent.
4. ModelFactory applies Model Config defaults to absent leaves and fixes the complete result only in the Active Model.
5. Session restore, RPC round-trip, UI display and repository saves never write Effective Options back to a Selection.
6. Tests prove: new Selection across models, explicit same-model Option edit, and absent `maxOutputTokens` not materialized.

## 7. Non-goals

- No separate Selection Builder domain service (small stateless pure functions are fine).
- `ModelSelection` does not become a mutable class.
- No change to Model Config Option Specs, ModelFactory validation or Active Model lifecycle.
- No settings page or product entry for the unexposed `maxOutputTokens`.
- Select and Submission stages do not get two model identity or Options schemas.

## 8. Select and Submission stages

All product state that references a model belongs to one of two stages; there is no per-product model
lifecycle for Automation, Repo Wiki, Bot, Off-Peak, Subagent or Sidecar.

```text
Select: user preference, draft or reusable product config
  - modelSelection may be absent (= take the product's established preferred source)
  - editable repeatedly; not a submitted unit of work
    | product triggers execution, resolves concrete provider/model
    v
Submission: must carry a concrete ModelSelection
  - options still hold explicit overrides only
  - not re-read after queue, wait, remote transport or retry
  - finally handed to Target Worker Registry / ModelFactory (defaults filled at creation)
    v
Active Model: complete, immutable fact of this execution
```

Select is a product-state stage; no domain type named `ModelSelect` is added. Both stages use the same
`ModelSelection` schema; they differ only in whether the outer state may omit it and when identity is fixed.

### 8.1 Stage transition rules

- Drafts, preferences and reusable configs are Select; an accepted, to-be-executed unit of work is Submission.
- A missing `modelSelection` in Select is resolved at the boundary where execution is triggered and the Submission formed.
- After a Submission is accepted, queue, wait, ticket claim, remote transport, recovery and Retry use its fixed Selection.
- If Host preferred, Provider Config or model visibility changes while waiting, there is no silent re-select; the Target Worker validates against the current Registry when building the Model and fails explicitly.
- "Concrete Selection" only requires `providerId/modelId`; it must not materialize Option Spec defaults into `options`.
- Edit/Retry that creates a new Submission may inherit the source Selection per that product's existing semantics (an explicit construction of a new value, not the old Submission re-reading defaults).

### 8.2 Product mapping

| Product/scenario | Select stage                                           | Boundary forming Submission                |
| ---------------- | ------------------------------------------------------ | ------------------------------------------ |
| Normal session   | Composer / Draft                                       | user sends and the system accepts          |
| Automation       | optional model preference in the record                | each scheduled trigger                     |
| Repo Wiki        | model choice in generate page or saved config          | user clicks generate                       |
| Bot              | model preference in Bot config                         | message received, a task is created        |
| Subagent         | optional model override in Profile                     | Child Agent creation                       |
| Off-Peak         | model choice on the create page                        | user submits and the system accepts        |
| Title/Memory/Git | usually no long-lived Select; intent from call context | each Sidecar call forms its own Submission |

- Automation set to "follow Workspace" stores no `modelSelection`; each trigger reads Host preferred at that time and forms that run's Submission; later Host preferred changes do not affect it.
- Off-Peak fixes the Selection when the task is accepted; waiting, ticket claim and dispatch execute only that Submission.
- A Subagent Profile without override takes model identity from the Parent Active Model when the Child Submission is created, and does not follow later parent model changes.

### 8.3 Checkpoints

1. Each product names its own Select owner and the existing event forming its Submission; no shared mutable Select Store.
2. Select may omit `modelSelection`; Submission may not omit a concrete provider/model.
3. Preferred-model resolution happens only at the Select-to-Submission boundary; scheduler, queue consumer and Retry runner never resolve again.
4. Submission persistence, protocol and remote transport keep the sparse structured `ModelSelection` intact.
5. Registry updates can only make an existing Submission fail explicitly at ModelFactory, never silently fall back.
6. Tests cover both timings: preferred model changes before Submission formation and after.
