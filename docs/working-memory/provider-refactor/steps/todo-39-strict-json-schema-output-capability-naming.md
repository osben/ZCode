# Todo 39: Strict JSON Schema Output Capability Naming Closeout

> Status: superseded by Todo 74 (draft was never executed here)
>
> Date: 2026-08-28
>
> Source: Project Memory Model Selection Review

The Model Properties field `supportsStructuredOutput` was ambiguous: it reads as "can output JSON", "supports JSON
mode" or generic structured text, but in the runtime chain it means the narrower fact that the model and the target
API Schema accept a caller-provided JSON Schema and strictly constrain the response. The field is both a Model Config
static fact and the Runtime gate before sending `responseJsonSchema`, so the wide name risks wrong Built-in Model
Config declarations.

Goals recorded by the draft (now delivered by
[Todo 74](./todo-74-model-capability-layer-and-media-output-contract.md); the field is now
`supportsJsonSchemaOutput`):

- one accurate, unique name for "strictly constrain the model response to the caller's JSON Schema", used by Config,
  Effective Model Config, Active Model, Runtime, Adapter, Protocol, UI and tests;
- distinguish strict JSON Schema output from plain JSON mode, prompt-requested JSON text and Tool Call;
- capability checks keep coming from the frozen Properties of the current Active Model, never inferred by Model ID,
  Provider or API Type at runtime;
- no residue of the old name: only one authoritative field remains.
