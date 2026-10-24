# GLM Responses Model Selection Design

GLM Agent supports OpenAI Responses upstreams, so model selection must treat Responses (`/responses`) providers as selectable for GLM.

Current state:

- Settings can save a provider with `apiFormat: "openai-responses"` and models that support `responses`.
- The chat model menu and Bot `/model` selector filter providers by the active ZCode provider before rendering. For `glm` the filters accept `anthropic` and `openai` (OpenAI-compatible Chat Completions) plus providers exposing a Responses endpoint.

Rules:

- GLM chat model selection accepts models whose supported formats include `responses`; provider inclusion accepts Responses-only providers.
- Bot `/model` selection follows the same GLM format boundary as the chat model menu.
- Non-GLM agent types are unchanged; Responses stays distinct from OpenAI-compatible Chat Completions in shared type mapping.
- Runtime request conversion is owned by GLM Agent and is not part of the selection layer. Remote control stream, workspace identity, provider registry sync, and task replay are out of scope.

Verification:

- `getProviderModelsForSelection("glm", provider)` returns a responses-only model.
- `shouldIncludeModelProviderInSelection("glm", provider)` accepts a responses-only provider.
- Bot model selection accepts the same responses-only provider for `glm`.
