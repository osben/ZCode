# Project Memory Model Ownership and Single-Turn Extraction Control

## Conclusion

Project Memory's model selection follows causal ownership, rather than re-reading the mutable Session Selection at the start of background work:

```text
Current Turn's Active Model
        |
        +--> Semantic Recall (feature still disabled)
        |
        `--> Extraction scheduled after Turn completes

Dream
`--> No product entry points currently; not adjusted this round; decided separately during the overall refactor
```

- Semantic Recall service serves the current Turn, so it uses the Active Model already created for that Turn.
- Extraction is produced by a successful Turn, so the Snapshot saves the Active Model of that Turn.
- Both paths must not re-read Session Selection or mutable Registry at async boundaries to select a model.
- The model's identity, Provider, Properties, and access bindings remain frozen; a single Memory request can still override `maxOutputTokens`, reasoning, and other call options via `ModelRequest.options`.

## Semantic Recall

Semantic Recall remains disabled for now. This round only implements this low-cost model ownership, clearing the way for subsequent removal of Session Selection re-reading:

```text
Turn admission
      |
      v
Create this Turn's Active Model
      |
      +--> Main Loop
      `--> Recall Selector
             ├─ Inherits Active Model's already-configured total output budget
             └─ Uses one single invocation of the lowest public reasoning tier (when the model declares this Option)
```

The Selector depends on strict JSON Schema output. If the Active Model does not declare this capability, do not automatically search for another model from the Registry. The complete `MEMORY.md` default index downgrade must be completed before Semantic Recall formally opens; during the feature's disabled period, do not add a second Context assembly branch for it.

Recall expresses low-cost reasoning through request-specific Options:

```ts
model.generateText({
  // ...
  options: {
    reasoningLevel: model.optionSpecs.reasoningLevel?.values[0],
  },
});
```

`reasoningLevel.values` is ordered from lowest to highest intensity; Recall directly uses the first item in the current `ModelRequest` and continues through the normal Option Spec Map/Adapter chain. The lowest tier does not require the model to support disabling Reasoning.
Recall does not guess Provider thinking budgets in Core; the total output budget is inherited from the Active Model, with reasoning and max-output projected through the same Option Map chain. Strict JSON Schema continues to constrain response shapes.

## Extraction

The Extraction Scheduler retains its existing bounded semantics: at most one running Snapshot and one latest pending Snapshot. The current implementation already holds a Model created at scheduling time within the Snapshot; switching to save the Turn's Active Model that produced the work does not increase the number of滞留 models, nor add new resource lifecycles.

```text
Successful Turn
   |
   | Active Model + message boundaries + tool/read state
   v
Extraction Snapshot
   |
   +--> running (at most one)
   `--> latest pending (at most one, overriding earlier pending)
```

Extraction continues to attach independent telemetry, `skipTranscript`, and Memory tool permissions to its model requests, but these belong to the Invocation Context and must not be used to recreate or re-select a model.

## Single-Turn Skip Extraction

CLI/Core adds an optional parameter within the existing single `modelExecution`:

```ts
modelExecution: {
  // ... existing execution-scoped Selection constraints
  memoryExtraction?: "skip";
}
```

It has the following boundaries:

- Only affects successful Turns carrying this parameter.
- Does not modify Session's `memory.extractionEnabled`.
- Does not write to Session Selection, message history, or persistent configuration.
- Does not affect Recall, foreground Memory tool calls, or Dream.
- Normal Turns do not pass this by default, continuing to follow Session-level Extraction toggles.
- Off-Peak dispatch explicitly passes `"skip"`, confirming no automatic Memory Extraction runs, avoiding single-use credentials being used again by background work after the main Turn ends.

Protocol and call chain:

```text
Host Off-Peak dispatch
        |
        | sendText.modelExecution.memoryExtraction = "skip"
        v
Protocol V4 admission
        |
        v
SubmitPromptOptions / ExecuteTurnOptions
        |
        v
Turn success
        |
        +-- skip --> do not schedule Extraction
        `-- absent -> schedule per Session-level toggle
```

This field shares the existing `modelExecution` single-turn boundary with execution-scoped Selection, request-period access materials, and subagent constraints; it does not enter normal queuable Submission Intents. The current caller is only Off-Peak dispatch, which requires idle start-now, so it will not be lost in the CommandInbox.
