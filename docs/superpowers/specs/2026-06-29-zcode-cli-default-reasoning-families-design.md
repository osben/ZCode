# zcode-cli Default Reasoning Family Completion Design

When users define custom providers/models, the App-side Catalog may lack reasoning metadata. The zcode-cli workspace dynamic provider overlay fills defaults, but previously covered only DeepSeek V4, GLM, GPT, and some Anthropic DeepSeek cases: Qwen, Kimi, and MiMo models without `reasoning` produced catalog overrides without `supportsReasoning` / `reasoning.levels`, leaving no thinking levels in session settings. This spec is zcode-cli only — App/UI Catalog generation and shared inference are out of scope.

Rules:

- Dynamic provider models without `reasoning` metadata get default reasoning by provider kind and model family.
- Qwen on OpenAI-compatible providers uses canonical `openaiCompatible.enable_thinking`, never the generic `thinking.type`.
- Kimi/MiMo use the generic thinking toggle: OpenAI-compatible via canonical `openaiCompatible.thinking.type`, Anthropic via `anthropic.thinking`.
- Existing DeepSeek V4, GLM-5.2, and GPT defaults are unchanged.
- Auto-inference emits canonical direct fields only, never `extra_body`.

Design: the only behavior entry point is the dynamic provider overlay in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`. `createDynamicProviderDefaultReasoning(kind, modelId)` becomes a function of the full `provider` and `model`, because Qwen needs provider-id prefix recognition. Default order:

1. Anthropic kind: DeepSeek V4 and GLM-5.2 keep their Anthropic reasoning depths; GLM, non-V4 DeepSeek, Kimi, MiMo and other catalog thinking-toggle families use the Anthropic thinking toggle.
2. OpenAI kind: GPT keeps OpenAI provider reasoning effort; other families get no generic OpenAI-compatible parameters.
3. OpenAI-compatible kind: GLM-5.2, GPT, and DeepSeek V4 keep their existing depths; Qwen uses the direct `enable_thinking` toggle; Kimi, MiMo, GLM, and non-V4 DeepSeek use the direct `thinking.type` toggle.

`isCatalogThinkingToggleProtocolModel` remains the shared recognition boundary for Kimi/MiMo/GLM/DeepSeek families; the Qwen branch must precede the generic thinking-toggle branch.

Non-goals: `packages/ui` thinking-level display, `packages/services` App Catalog storage and model editor, manual reasoning override form, moving the inference helper to a shared package.

Tests in `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`: Qwen OpenAI-compatible provider yields `enabled/disabled` levels mapped to `enable_thinking: true/false`; Moonshot Kimi OpenAI-compatible maps to `thinking.type`; Xiaomi MiMo Anthropic maps to `anthropic.thinking`.
