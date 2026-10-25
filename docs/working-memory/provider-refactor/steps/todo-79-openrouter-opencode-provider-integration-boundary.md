# Todo 79: OpenRouter / OpenCode Provider Integration Boundary and Existing Foundations

> Status: done (first-round Builtin template integration)
>
> Date: 2026-09-04
>
> Source: migrated from Todo 22's OpenRouter/OpenCode Zen sections; Todo 22 keeps Azure, Volcano Ark, AWS Bedrock and other Providers.

## 1. Existing foundations

- **OpenRouter Model ID**: stored as a plain string inside the structured `providerId + modelId`. IDs containing `/` or `:free` (for example `vendor/model:free`) are never split into Provider, slugified or rewritten. The existing OpenRouter colon-model E2E covers saving and restoring this.
- **OpenRouter attribution**: `packages/shared/src/openrouter-attribution.ts` recognizes OpenRouter by the final `baseURL` (HTTPS, host `openrouter.ai` or a subdomain) and adds `X-OpenRouter-Title: ZCode` and `X-OpenRouter-Categories: programming-app`. It covers model requests, connectivity tests, Repo Wiki/Git commit requests and bootstrap Provider headers; it does not mean the Built-in Template integration was done.
- **OpenCode Model ID**: `packages/shared/src/opencode-model-id.ts` is unrelated to OpenRouter; it only generates a stable runtime ID `<provider-slug>-<provider-hash>/<modelName>` for OpenCode Agent custom models, avoiding ID conflicts across custom Providers.

## 2. OpenRouter Built-in Template scope

Maintained members follow the [`Builtin Provider maintenance list`](../design-v2/builtin-provider-inventory.md). OpenRouter covers all maintained models of the ordinary API Templates in that table: an upstream model enters the OpenRouter Template whenever OpenRouter currently serves it (the same vendor's Account Provider is not counted twice). Each vendor has at least one key model enabled by default, the rest generally maintained and default-off. OpenRouter does not copy its own full dynamic catalog; models outside ZCode's maintained scope are used through custom Providers.

An actual OpenRouter naming example: upstream model ID `gpt-5.6-sol` corresponds to `openai/gpt-5.6-sol`. This is OpenRouter's member/naming fact, not a generic format of aggregators and not config reuse or runtime ID conversion. OpenRouter still maintains its own Model/API/Site config because an aggregator site can change protocol fields, capabilities and parameter mapping.

OpenRouter offers Chat Completions, Responses and Anthropic Messages entries. Per the project-wide principle the official template uses Anthropic Messages, display name `OpenRouter`. Without evidence that a maintained model cannot use Anthropic Messages, all maintained models are assumed to support it; no separate Chat or Responses OpenRouter templates and no splitting for lack of per-model protocol notes. Public docs confirm the entries exist but do not give a complete "model to Schema" matrix (Models API `supported_parameters` and per-model endpoints are not a substitute for request verification), so the product assumption is explicit: maintained models go into the Anthropic template; "docs do not say" is not read as "unsupported". Only explicit counter-evidence would open a later Todo for other Schema templates.

- Confirm the public API Schema, Endpoint, auth and recommended model members.
- Keep `/` and `:free` Model IDs verbatim across ModelSelection, Registry, Runtime and persistence.
- Confirm the Anthropic entry's reasoning, tool call, JSON Schema, web search, usage and streaming contracts.
- Put OpenRouter site differences into Provider Site Config, never hardcoding aggregator capability into the Model baseline.
- Smoke the Anthropic template and connectivity test with representative real requests; per-model verification does not decide whether to split templates.

## 3. OpenCode Zen Built-in Template scope

"OpenCode" here means the OpenCode Zen API, not the OpenCode Agent runtime. Zen is in the Builtin maintenance list and covers the still-valid models of every brand in the official table (key models vs general maintenance follow the list's global principle). The official table shows one Zen Base URL serving:

```text
Responses              gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / GPT series
Anthropic Messages     claude-opus-5 / claude-sonnet-5 / qwen3.7-max etc.
OpenAI-compatible Chat kimi-k3 / deepseek-v4-* / minimax-m3 / glm-5.2 etc.
```

ProviderTemplate's API config is single-valued. Following the principle, Zen models that can use Anthropic Messages go to `opencode-zen-messages`; those supporting only Responses or OpenAI-compatible Chat go to `opencode-zen-responses` or `opencode-zen-chat`. Models of different Schemas are not mixed in one fixed template, and no temporary per-model API field is invented; a shared site shell would need a separate type design. Maintained members and default-enable strategy follow the list: each upstream brand has at least one default-enabled model, other official models of the brand are generally maintained and default-off.

- Confirm Zen's API Schema, Endpoint, auth and model catalog.
- Keep OpenCode Agent's runtime ID conversion separate from Provider Config `modelId` semantics.
- Confirm reasoning, tool call, JSON Schema, usage and streaming contracts.
- Complete Built-in Template, Access, Model Config and real-request verification.

## 4. Boundaries and non-goals

- Do not pass off OpenRouter or OpenCode Zen as finished beyond the first-round templates; do not reuse OpenCode's runtime Model ID conversion for OpenRouter; do not infer OpenRouter model capability from the attribution header.
- No Google Gemini native Schema, Azure, Volcano Ark or AWS Bedrock here.
- Todo 22 keeps the other Providers; Todo 76's Builtin Config layering applies (Model baseline -> Model + API Schema -> Provider Site -> Template Model -> Provider Model -> Personal Provider Instance).

Sources: OpenRouter Models guide, OpenRouter Models API reference, OpenCode Zen docs (dev.opencode.ai/docs/zen).

## 5. Outcome (2026-09-04)

- A separate `openrouter` Template uses `https://openrouter.ai/api`; model IDs are stored with the aggregator's real naming (no vendor-prefix stripping, no reuse of upstream Runtime config).
- Three Templates `opencode-zen-responses`, `opencode-zen-messages`, `opencode-zen-chat` map to Zen's three protocol entries; one site's different protocols are no longer mixed in one ProviderTemplate.
- OpenRouter and OpenCode members are registered per the maintenance list: key members default-enabled, the rest default-off; each member has its own `template-model` record and a minimal complete output limit.
- A Builtin integrity test confirms the aggregator Templates' independent API config, model members and Registry Provider order; Provider Node tests, `pnpm typecheck` and `pnpm lint` pass (0 error).
- No change to OpenCode Agent runtime ID conversion; aggregator config capability is not mapped as reuse of upstream Provider rules.

### Name correction (2026-09-15)

- By user request the OpenRouter template's Chinese and English names are both `OpenRouter` (the `(Anthropic)` suffix removed); cards and tooltips use the same config name. The first-round name was `OpenRouter (Anthropic)`.
- The production config is the only edit source; the test config is generated by the existing sync script. Template ID `openrouter`, the Anthropic Messages protocol, URL, models and reasoning mapping are unchanged.
- Personal names of already created providers are not migrated or renamed; OpenCode and other template names are unchanged.
- Verification: the new name assertion failed (2 items) before the change; after it the OpenRouter contract tests (16) pass; browser checks of narrow-width zh light and wide-width en dark cards and hover tips pass; root typecheck, Desktop `typecheck:e2e` and the config sync check pass; lint 0 errors (42 existing warnings). Browser pending does not substitute full Electron / mobile remote acceptance.
