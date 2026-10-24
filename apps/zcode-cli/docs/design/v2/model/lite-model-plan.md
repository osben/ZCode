# Lite Model Level Plan

## Background

The first version of ZCode model scheduling needs two capability levels:

- `main`: the primary model for the normal agent loop, code changes, complex reasoning and default tool
  calls.
- `lite`: a light model for low-risk, short-context, structured small tasks.

`lite` is optional. When the user does not configure `lite`, every lite request resolves to the current
`main`, so a single-model configuration stays complete and usable.

## Goals

1. Use the name `lite` consistently in spec, contracts, config and runtime.
2. Drop the legacy `small` / `small_model` config compatibility; expose only `lite`.
3. Provide one explicit model resolution entry so business logic expresses only the request role and
   never assembles model strings itself.
4. No automatic task-complexity classification in the first version; use `lite` only in explicit
   scenarios.

## Non-goals

- No large model catalog.
- No automatic main/lite classifier.
- No `ZCODE_MODEL_LITE` environment variable. If one is ever needed, first specify its purpose,
  precedence, error behavior and test coverage.
- No scattering of provider compatibility branches into the core runtime.

## Config contract

Recommended single-model config:

```json
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {}
      }
    }
  },
  "model": "deepseek/deepseek-v4-pro"
}
```

To distinguish `main` and `lite`:

```json
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-..."
      },
      "models": {
        "deepseek-v4-pro": {},
        "deepseek-chat": {}
      }
    }
  },
  "model": {
    "main": "deepseek/deepseek-v4-pro",
    "lite": "deepseek/deepseek-chat"
  }
}
```

Resolution rules:

1. A `model` string equals `model.main`; the value must be `provider/model`.
2. `model.main` / `model.lite` accept only `provider/model` strings, not inline targets.
3. `model.lite` is optional; when missing, the `lite` role resolves to the current `main`.
4. `small_model` and `model.small` are no longer accepted as compatibility input; the schema must
   reject them.
5. If `model.lite` points to a nonexistent provider/model, the error is `provider_not_configured` or
   `model_not_found`; it must not silently fall back to main.
6. `apiKey` and `headers` are provider connection config, read preferably from `provider.*.options`.
   When `apiKey` is not configured the adapter may fall back to environment variables, but no
   `apiKeyEnv` user field is exposed.

## Role resolution contract

A single resolution entry:

```typescript
type ModelRequestRole = "main" | "lite" | "compact" | "review" | "subagent";

interface ModelRoleResolver {
  resolve(role: ModelRequestRole, context: ModelRoleContext): ModelRef;
}
```

Default mapping:

| Role | Default model |
|------|----------|
| `main` | `model.main` |
| `lite` | `model.lite ?? model.main` |
| `compact` | `model.main` |
| `review` | `model.main` |
| `subagent` | parent model |

A role policy may later point `compact` or specific subagents at `lite`; the first version does not
change them automatically.

## First lite scenarios

Wire in only explicit low-risk scenarios:

- Local TUI session title generation. Without a configured `model.lite` the request must resolve to the
  current default/main model, but `modelRef.role` is still recorded as `lite`. The ZCode app-server and
  headless mode do not enable title generation by default.
- Short summaries of tool batches.
- Structured judgments for hook prompts.
- Away summary / idle summary.
- Simple permission explanations or read-only classifiers.

Not used for:

- The main agent loop that needs cross-file changes.
- Destructive tool decisions.
- The compact body summary, unless a later spec explicitly allows it.
- The final conclusion of review or security judgments.

## Implementation order

1. Spec updated: `docs/design/v2/model/README.md` and the loop interface drafts use `lite`.
2. Contracts:
   - `ModelRole.Small` becomes `ModelRole.Lite`.
   - `RuntimeConfig.model` is resolved from provider-first config into `{ main, lite? }`.
   - User config keeps no `RuntimeConfig.model.small` compatibility entry.
   - User config keeps no inline target compatibility entry.
3. Config adapter:
   - file config reads `model.lite`.
   - Reject `model.small`, `small_model` and inline targets.
   - Add no lite environment variable.
4. Bootstrap/runtime:
   - Introduce `ModelRoleResolver` or an equivalent helper.
   - The runtime no longer holds a single `defaultModelRef` as the only source for all requests.
   - Normal requests use `role: "main"`.
   - Explicit low-risk side tasks use `role: "lite"`.
5. Events/logging:
   - `model.request` and network status events record the final `ModelRef`.
   - Also record `requestedRole` to explain why a request went to `lite` or inherited `main`.
6. Tests:
   - Add contracts/config/resolver unit tests first.
   - Then runtime scenario tests.

## Test requirements

Must cover:

- Without `model.lite`, `lite` resolves to `main`.
- With `model.lite`, lite scenarios use lite and main scenarios still use main.
- The schema rejects `small_model`, `model.small` and inline targets.
- An unconfigured lite provider returns a structured error and does not silently fall back.
- Session/model events contain the final `ModelRef` and the request role.
- A subagent inherits the parent by default and is not downgraded just because lite exists.

Verification commands:

```text
npm run lint
npm test
```

## Acceptance criteria

- Single-model users keep working without new configuration.
- Dual-model users only configure `model.lite` to make explicit side tasks use the light model.
- Core business logic does not read config keys or environment variables; it gets models only through
  the role resolver.
- `small` / `small_model` are no longer user config, events or public API input.
