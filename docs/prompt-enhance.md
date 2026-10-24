# Prompt Enhance

The chat composer offers a "enhance prompt" action that polishes the current draft with the selected custom model provider before sending.

## Design

- The UI only collects the current draft and recent conversation context, and writes the enhanced text back into the composer.
- The actual network request lives in `modelProviderService.enhancePrompt()`; the host side re-reads the latest provider configuration by `modelProviderId`.
- Request format follows the current ZCode provider preference order:
  - `claude` prefers Anthropic
  - `codex` / `opencode` prefer Responses
  - `glm` prefers OpenAI Chat
  - `gemini` prefers Gemini
- If the preferred protocol fails, other compatible formats of the same provider are tried automatically.

## Current scope

- Only the "custom model provider" scenario is supported.
- Native CLI/native models are not covered: they do not expose a reusable direct-HTTP auth configuration.
