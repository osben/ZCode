# Todo 74: Model Capability Layering and the PDF / Tool-Call / JSON Schema Output Contract

> Status: done (streaming JSON Schema is handled separately by Todo 80)
>
> Date: 2026-09-04
>
> Covers: GLM-5.3-Flash PDF, tool-call capability display, strict JSON Schema output
>
> Option `default` retirement, Reasoning Spec completion and explicit request budgets were finished by Todo 58, Todo 60 and later work and are not revisited here.

## 1. Goal

Separate the responsibilities of model-capability config so model facts, API-protocol mapping and provider/Endpoint special cases are not mixed in one layer. The current Effective Model Config is the only runtime capability source; Adapters and UI never guess capability from model names.

```text
Model ID -> Model + API Schema -> Provider Site / Base URL -> Template + Model
 -> Provider Instance + Model -> Personal Provider Instance + Model
 -> Effective Model Config -> UI capability display and Runtime request
```

## 2. Three product requirements

### 2.1 GLM-5.3-Flash supports PDF only under Anthropic Messages

- The Model baseline does not mark GLM-5.3-Flash as globally PDF-capable.
- Only a `glm-5.3-flash + anthropic-messages` Model + API Rule makes that combination support PDF.
- OpenAI Chat and OpenAI Responses stay PDF-unsupported with no later-layer override.
- Concrete PDF encoding belongs to the API Schema / Adapter layer.
- Covers settings display, Model Selection, attachment conversion and the real request chain.

### 2.2 Tool calling is no longer a settings item

- The settings page hides the "tool calling" edit item.
- Built-in Providers and Provider Templates share the baseline `supportsToolCall: true`.
- Runtime keeps using the capability field; hiding the UI must not remove the capability.

### 2.3 Structured Output becomes strict JSON Schema semantics

- The field actually means "the caller supplies a JSON Schema and requires the response to satisfy it"; it is renamed `supportsJsonSchemaOutput` to remove "plain JSON / JSON mode / prompt JSON" ambiguity.
- Capability is confirmed per Model, API Schema, Provider/Endpoint evidence, never inferred from the model ID globally.
- Streaming JSON Schema is Todo 80; this Todo does not widen the streaming result contract.

## 3. Model Config layering

This Todo uses the fixed order and Rule types defined by Todo 76 (no second Provider/Endpoint hierarchy):

```text
Model -> Model + API Schema -> Provider Site / Base URL -> Template Model -> Provider Model -> Personal Provider Instance overlay
```

It owns only field values, runtime pass-through and tests for PDF, tool calling and strict JSON Schema; each field is placed by Todo 76's maintenance scope and Site override rules. A minimal capability matrix records at which layer (Model, API Schema, Provider/Endpoint) each of GLM PDF, tool calling and strict JSON Schema is declared. The resolver stays a sequential overlay and consumes the unified Effective Model Config from Todo 76.

## 4. Acceptance criteria

- GLM-5.3-Flash shows PDF input capability in the settings and selection chain, and real attachment requests do not fail for missing config.
- No tool-calling switch in settings, yet tool-calling models still execute.
- The strict JSON Schema capability name, config and Runtime validation semantics agree; streaming follows Todo 80's boundary.
- The responsibilities of the Provider, API Schema and Endpoint layers are unique and explicit in code and docs.
- No new Option `default`; Reasoning and request-budget semantics unchanged.

## 5. Relation to older Todos

- 2026-09-09 review: Model Properties and Wiki test fixtures use `supportsJsonSchemaOutput`. Private `legacy*` DTOs/readers for already released old data keep the raw `supportsStructuredOutput` field (historical input formats are not renamed mechanically); the old Provider import still keeps only the model contextWindow and does not carry old capabilities into new config. The formal Model Option protocol still rejects both flat capability fields (old and new); capability comes only from properties. No unreleased intermediate-state compatibility; this Todo is not reopened.
- Todo 39's "strict JSON Schema output naming closeout" is covered here; Todo 39 is to be marked `superseded`.
- Todo 58 and Todo 60 stay done.

## 6. Outcome (2026-09-04)

- `supportsStructuredOutput` -> `supportsJsonSchemaOutput` switched repo-wide; the Schema keeps strict object validation and old fields have no migration compatibility.
- The "tool calling" edit item is removed from settings; the runtime capability field stays and the Builtin baseline supplies `supportsToolCall: true`.
- GLM-5.3-Flash PDF lives in the `modelApiRules` rule `glm-5\\.3-flash + anthropic-messages`; the Model baseline and other API Schemas do not declare PDF.
- A Builtin integrity regression confirms the Anthropic combination supports PDF, the Chat combination does not, and the config file has no old field; affected Provider, Adapter and UI tests, `pnpm typecheck` and `pnpm lint` pass.
- Streaming JSON Schema transfer remains untouched (Todo 80 draft boundary).
