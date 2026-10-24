# Todo 38: Project Memory Turn Model Ownership and Off-Peak Extraction Closeout

> Status: Completed
>
> Date: 2026-08-28
>
> Source: Provider Refactor background model selection review
>
> Related design: [`Project Memory model ownership and single-turn Extraction control`](../../../design/v2/project-memory-model-selection.md)

## 1. Background

Project Memory has three model chains with different purposes and lifecycles: Semantic Recall (starts with the
current Turn), Main Agent Loop followed by automatic Extraction after a successful Turn, and Dream (an independent
background consolidation path, to be refactored separately with no open product entry now). They must not share one
vague background-model rule. Provider Refactor's Active Model freeze applies: once a Turn creates a Model, later
Registry, Personal Config or Session Selection changes must not rewrite that Turn's model facts, so Recall and
Extraction must not re-read the mutable Session Selection when async work starts and must not search the Registry for
a "cheaper" or "more suitable" model. Off-Peak uses an execution-scoped Model and request-time access material; its
automatic Turn must not derive a Project Memory Extraction, so one-time execution material is not consumed again by
a background request outside the main Turn.

## 2. Decisions

### 2.1 Model ownership

```text
Turn admission -> create this Turn's Active Model
   ├─ Main Agent Loop
   ├─ Semantic Recall
   └─ Extraction Snapshot produced by a successful Turn
```

1. Semantic Recall uses the current Turn's Active Model; Extraction uses the Active Model of the completed Turn that
   produced the work.
2. Neither re-reads Session Selection, nor infers model capabilities by Provider ID, Model ID or API Type.
3. Registry and Config updates affect only later-created Models; a Snapshot already in the Extraction Scheduler stays
   frozen.
4. Dream is not adjusted this round.

### 2.2 Per-turn Extraction skip

An explicit policy in the existing CLI/Core single-turn execution context (the "CLI parameter" is an execution
parameter the App passes to CLI/Core via Protocol, not a public command-line flag):

```ts
modelExecution: {
  selectionScope: "execution";
  memoryExtraction?: "skip";
}
```

It affects only the one successful Turn that carries it; does not modify the Session's `memory.extractionEnabled`;
is not written to Session Selection, message history or persistent Config; does not affect ordinary Turns, foreground
Memory tool calls, or the behavior of failed/cancelled Turns. Off-Peak dispatch passes `"skip"`. A string enum is
used instead of a boolean to avoid `false` ambiguity, and no second Session-level Memory switch exists.

### 2.3 Recall request options

Recall's model identity is the current Turn Active Model, but single-call options can be overridden independently:
the Active Model's identity, Provider, Properties and access binding are unchanged; the Recall request inherits the
Active Model's total output budget and sets `reasoningLevel = optionSpecs.reasoningLevel.values[0]` (the lowest
public level, strength ordered low to high). It does not require the model to support turning Reasoning off, must
not scan `off`/`nothink` names, must not hand-assemble Anthropic/OpenAI/OpenAI-compatible dialect parameters, and
must not guess a Provider fixed-thinking budget. If the Active Model lacks `supportsJsonSchemaOutput`, the Selector
does not run and no model is auto-switched. Semantic Recall is not yet product-enabled: only the low-cost part that
adds no second model fact is implemented; the full default-index degradation is handled before Recall opens.

## 3. Call chains

```text
Desktop Off-Peak Host -- modelExecution.memoryExtraction = "skip" --> Protocol V4 Schema -> Bootstrap Command Adapter
 -> Core ModelExecutionContext -> Turn success: skip -> no Extraction; absent -> schedule by Session Memory config
```

Every layer passes the field through unchanged; there must be a vertical proof (Protocol payload to Core
`SendInputOptions`), not only Protocol-accepts and Core-handles proofs separately.

```text
Main Loop uses Active Model -> Turn success -> Extraction Snapshot (Active Model + message boundary + tool/read state)
   ├─ running (at most one)
   └─ latest pending (at most one)
```

The Scheduler keeps its bounded semantics and adds no Model Registry, Model Snapshot DTO or background Selection; the
Snapshot holds the immutable Model directly (no reference counting or dispose protocol until a Model acquires
resources needing explicit release). Recall Prefetch receives the Turn Active Model; Invocation Context, Telemetry,
Header refresh and abort signal may be bound per Recall but must not re-create or re-select the Model.

## 4. Requirements

- Protocol V4 strict `modelExecution` Schema adds `memoryExtraction?: "skip"`; Core `ModelExecutionContext` uses the
  same name and value; no renamed second Policy DTO.
- Desktop Off-Peak dispatch (first run and resume alike) passes `memoryExtraction: "skip"`; ordinary model requests,
  Automation, user start-now and queue input do not carry it; Core never infers Off-Peak from fixed Provider/Model
  IDs.
- Bootstrap projects `memoryExtraction` unchanged to Core, keeps existing `requestAuth` freezing and
  `requestDependencies` assembly, and the field does not enter a persistable Submission Intent; execution-scoped
  admission still requires an explicit Model Selection and idle/start-now.
- Extraction: the Turn creates and fixes the Active Model; a successful Turn passes it to scheduling; the Snapshot
  stores it; execution never calls `runtime.getSessionModelSelection()` or the Model Factory; `skip` wraps only the
  scheduling entry (Scheduler, Drain, Shutdown and Session Residency unchanged); telemetry, `skipTranscript`, Memory
  tool permission and the independent abort signal are unchanged.
- Recall: use the same Model's request-level `reasoningLevel: values[0]` then the normal `reasoningMapping`; Active
  Model binding state unchanged; no Registry search for replacements; no Semantic Recall product switch.
- Dream: no change of entry, model selection, queue, Prompt, tools or persistence; shared helpers keep Dream's
  behavior if a parameter is added.

## 5. Acceptance

- Protocol: `memoryExtraction: "skip"` passes the strict Schema; other strings, booleans and extra fields are
  rejected; `modelExecution` still requires explicit `modelSelection`.
- Bootstrap: execution-scoped payload conversion keeps `memoryExtraction: "skip"`; `requestAuth`, Subagent Policy
  and Selection unaffected; a vertical Protocol payload to Core `SendInputOptions` assertion.
- Core Extraction: a successful Turn with skip creates/schedules no Extraction; the next ordinary Turn still
  extracts (not a Session-level change); an ordinary Turn's Extraction reuses the Turn's Model; execution-scoped
  Selection does not fall back to the Session default at Extraction time; Registry updates affect only later
  Models; failed/cancelled Turns keep not scheduling; the Scheduler's running + latest pending bound is unchanged.
- Recall: same Model identity and frozen facts as Main Loop; total output budget inherited; reasoning from
  `values[0]`; no Selector request without strict JSON Schema support; no implicit Model creation/selection; the
  default-off branch issues no extra model request.

## 6. Not done and completion

No public CLI flag; no Session-level Memory Policy; no Off-Peak request-time access material in Config; no
Memory-specific Model Selection; no second Registry or Model capability DTO; no auto-pick of cheap/hidden models or
other Providers; no inference of Memory behavior from Provider ID, Model ID, API Type or regex; no Semantic Recall
opening; no Dream refactor; no change to ordinary queue, recovery, Desktop continuous or Mobile replayable.

Outcome (2026-08-28): Off-Peak Host passes `modelExecution.memoryExtraction: "skip"` through Protocol V4 and
Bootstrap to Core; Core skips Extraction only for the successful Turn carrying it; the Extraction Snapshot holds the
completed Turn's immutable Active Model; Recall Prefetch uses the current Turn Active Model and sends no Selector
request without strict structured output support; the Recall Request uses `values[0]` as `reasoningLevel` with the
normal `reasoningMapping`; tests added for Protocol, Bootstrap vertical projection, Core Extraction/Recall, Model
request boundary and Adapter protocol mapping; Dream and the Semantic Recall switch untouched.
