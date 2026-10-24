# Anthropic Authorization Header

Anthropic Messages requests default to the AI SDK `apiKey` flow (`x-api-key`). Some Anthropic-compatible gateways also read the same credential from `Authorization`; sending only `x-api-key` made main requests, connectivity probes, and Repo Wiki short requests authenticate inconsistently.

Rules:

- Regular Anthropic transport requests carry both `x-api-key: <api-key>` and `Authorization: Bearer <api-key>`.
- An explicitly configured `Authorization` (user or runtime) wins, preserving Start Plan, security-check headers, and proxy-side auth semantics.
- The Start Plan Anthropic endpoint keeps `Authorization: Bearer <zcode-jwt>` and additionally sends `x-api-key: <zcode-jwt>`, matching the dual-header shape.
- `anthropic-version: 2023-06-01` and existing `anthropic-beta`/runtime headers are unchanged.

Affected surfaces: the Anthropic provider registry in `@zcode/adapters` (agent main model requests), the Anthropic endpoint check in `packages/services` (settings connectivity probe), and the hand-written Anthropic Messages HTTP request in Repo Wiki.

Non-goals: OpenAI / OpenAI-compatible / Responses / Gemini auth headers; changing Start Plan Bearer semantics to a bare token; new protocol fields (this is provider runtime header assembly).
