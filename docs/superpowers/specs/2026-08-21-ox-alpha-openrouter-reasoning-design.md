# ox-alpha Series OpenRouter Reasoning Adaptation Design

> **2026-08-22 M3 closure:** this document records the design background before the staging merge. The
> current implementation no longer consumes `/client/configs.magic_name` and no longer builds reasoning
> policies from specific model IDs in source; the effective behavior is written into the ZCode Built-in Model
> Config Rules and serialized by the generic Adapter. On conflict,
> `docs/working-memory/provider-refactor/steps/03-staging-integration.md` prevails.

## Background

`ox-alpha`, `GLM-x-preview-f` and `x-preview-f-free` are public IDs of the same confidential multimodal model
routed through OpenRouter. The product exposes and persists only the IDs the user actually configured; the
underlying real model name must not be recorded in source, config, logs or docs, and requests are not rewritten
between these public IDs.

Model settings already provide context window, max output tokens and input/output type configuration, so this
adaptation adds no dedicated context, output, modality, tool call or structured output defaults for these
public IDs. Missing values keep using the existing settings and the generic runtime fallback; input types are
declared entirely by the user or by authoritative remote facts.

Currently an unknown model falls back to the generic `enabled` / `disabled` thinking toggle under both
OpenAI-compatible and Anthropic transports. These IDs actually support the three levels `low` / `high` / `max`,
default `max`, so the reasoning capability must be rebuilt by the real transport once the model identity
matches.

Another public ID that was not fixed in advance is delivered dynamically by `data.configs.magic_name` of
`/api/v1/client/configs`. The field is currently a plain string: the test environment delivers `GLM-Flash` and
production delivers an empty string. The client must not hard-code these two environment values and consumes
only the server's fact.

## Confirmed product semantics

- A model ID matches if it case-insensitively contains `ox-alpha`; provider path, prefix and suffix are
  allowed.
- Every letter of `GLM-x-preview-f` is case-insensitive; a provider path is allowed, but the last path segment
  must equal `glm-x-preview-f` exactly, with no extra prefix or suffix.
- `x-preview-f-free` uses the same matching boundary as `GLM-x-preview-f`: case-insensitive, provider path
  allowed, last path segment exactly `x-preview-f-free`, no extra prefix or suffix.
- `magic_name` is treated as a JavaScript regular expression: empty after trim means disabled; otherwise it is
  compiled with `iu` flags. One expression may match several names with `|`; with illegal syntax the matcher is
  ignored and must not block Provider sync.
- Users can choose `low`, `high`, `max`, default `max`.
- OpenAI-compatible Chat Completions: maps to `openaiCompatible.reasoningEffort`, final wire
  `reasoning_effort`.
- Anthropic Messages: maps to `anthropic.thinking.type="adaptive"` and `anthropic.effort`, final wire
  `thinking.type="adaptive"` and `output_config.effort`.
- Anthropic does not send `thinking.budget_tokens` and does not reuse the fixed budget of the GLM-5.3 official
  API.
- OpenAI Responses does not currently enable the dedicated reasoning mapping for these IDs, to avoid wrongly
  sending the Chat Completions `openaiCompatible` option.
- The original model ID in the final request is not rewritten.
- No dedicated context, max output, modality, tool call, structured output or temperature default policy is
  added for these IDs.

## Request mapping

```text
modelId matches a built-in pattern
or carries reasoningProfile="ox-alpha" from magic_name matching
        |
        v
reasoning levels = low / high / max
default = max
        |
        +-- openai-compatible
        |      `-- openaiCompatible.reasoningEffort
        |                  `-- wire: reasoning_effort
        |
        `-- anthropic
               +-- anthropic.thinking.type = adaptive
               `-- anthropic.effort
                           `-- wire: output_config.effort
```

| UI level | OpenAI-compatible wire    | Anthropic Messages wire                                   |
| -------- | ------------------------- | --------------------------------------------------------- |
| `low`    | `reasoning_effort="low"`  | `thinking.type="adaptive"`, `output_config.effort="low"`  |
| `high`   | `reasoning_effort="high"` | `thinking.type="adaptive"`, `output_config.effort="high"` |
| `max`    | `reasoning_effort="max"`  | `thinking.type="adaptive"`, `output_config.effort="max"`  |

## Implementation boundary

1. Shared keeps the built-in regex rules in `OX_ALPHA_REASONING_MODEL_ID_PATTERNS`, and
   `isOxAlphaReasoningModelId` decides via `some(test)` whether any rule hits; a caller may additionally pass a
   remote regex compiled from `magic_name`; no separate decision function is added per public ID.
2. The reasoning policy provides two factories, OpenAI-compatible and Anthropic; only the levels and default
   are shared, and provider options are separated by transport.
3. The default model policy fills only the reasoning capability and acts as the final reasoning override after
   the broad model-family rules; it carries no context/output/media capability values.
4. The standalone CLI configured model recognizes all built-in public IDs before the generic thinking toggle.
5. Even if a dynamic provider delivered by the App lacks reasoning metadata or carries a stale
   `enabled` / `disabled`, the workspace overlay still rebuilds the three levels by the unified reasoning
   identity.
6. Modalities keep reading `ModelProviderModelConfig.modalities`; they do not enter the GLM provider-aware
   media fallback.
7. The model-provider service builds the extra matcher from `client/configs.data.configs.magic_name`; a
   matching remote model is marked with a stable `reasoningProfile="ox-alpha"`. The profile persists with the
   model config and is projected to the Agent through the existing provider registry protocol; the Agent still
   rebuilds the provider options by the real transport inside the workspace dynamic overlay.
8. `magic_name` affects only the remote models delivered with the same `client/configs`; it does not change
   user-built providers, does not rewrite model IDs, and adds no separate network request, global singleton or
   cross-process mutable regex state.
9. `reasoningProfile` is a remote authoritative model fact: when a later sync no longer matches `magic_name`,
   the previously persisted profile must be cleared and must not be refilled from old local config or the
   previous `zcode` extension. A local model the user has modified keeps following the existing `modified`
   protection and does not accept remote overwrite; no migration is needed, and the next authoritative sync
   self-heals old data.
10. Production runtime code does not embed the confidential public ID string literals directly or add
    semantically named token constants for them; the built-in match tokens are constructed at runtime from
    neutral numbering and character codes. Comments may explain which model family a number corresponds to for
    maintainability. The constraint targets only a naive text scan of static source/build artifacts and does
    not change the protocol `modelId`, the remote `magic_name` or the actual vendor request value.

## Non-goals

- `ox-alpha` is not a GLM-5.3 alias.
- Not added to the public models.dev or the China model catalog.
- No automatic registration of an OpenRouter provider, API key, entitlement or default model.
- No change to the settings page context/output/type defaults.
- No extension of the audio/video/PDF runtime attachment protocol.
- No change to model selection, session, task, desktop continuous or web remote replayable semantics.
- No inference of unconfirmed reasoning parameters for OpenAI Responses.
- The server may not wrap the string as `/pattern/flags`; `magic_name` is only a pattern source and the client
  fixes the `iu` flags.

## Tests

- shared matcher: one regex list classifies by "any hit"; `ox-alpha` keeps case, provider path, prefix/suffix
  semantics; `GLM-x-preview-f` and `x-preview-f-free` cover all-lowercase, all-uppercase, mixed case and
  provider path, and reject near-miss IDs; an extra remote regex can hit one or several remote names.
- remote config: `magic_name="GLM-Flash|x-preview-f-free"` case-insensitively hits any remote model; blank,
  missing and illegal regexes set no profile.
- persistence/protocol: `reasoningProfile` survives preset sync write, read-back and provider registry
  projection; when the remote later withdraws the match, both the returned value and the persisted config clear
  the old profile while local `modified` models are kept.
- default policy: generates only reasoning; no context, max output or image/PDF capability.
- reasoning factory: three levels, default `max`, correct provider options namespace.
- OpenAI-compatible wire: each of the three levels generates the top-level `reasoning_effort` and no
  `thinking`.
- Anthropic wire: each of the three levels generates `thinking.type=adaptive` and `output_config.effort`, and
  no `thinking.budget_tokens` or `reasoning_effort`.
- standalone config: both Anthropic and OpenAI-compatible rebuild the three levels.
- configured wire: synthesize capability from config with mixed-case `GLM-x-preview-f`, then go through the
  final AI SDK request, asserting the original model ID is preserved.
- workspace dynamic overlay: both no metadata and a stale toggle rebuild the three levels, with the original
  model ID and context/output/modalities unchanged.

## Impact brief

### State Owners And Commit Sinks

| State/fact                 | Draft/display owner   | Authoritative owner    | Commit command/service        | Persistence/cache    | Evidence                    |
| -------------------------- | --------------------- | ---------------------- | ----------------------------- | -------------------- | --------------------------- |
| reasoning level candidates | shared model UI       | CLI capability overlay | existing session model config | runtime catalog      | adapter/bootstrap tests     |
| current thought level      | composer/session      | session runtime        | existing thought switch       | session settings     | existing model switch tests |
| context/output/types       | model settings draft  | provider registry      | model provider service        | config.json          | invariant-only              |
| `magic_name`               | remote client/configs | model-provider service | preset sync                   | config-version cache | service tests               |
| reasoning profile          | none (hidden fact)    | remote model config    | provider registry             | config.json          | storage/protocol tests      |

### Must-Preserve Invariants

| Invariant                                                     | Surfaces/modes       | Proof needed               | Evidence             |
| ------------------------------------------------------------- | -------------------- | -------------------------- | -------------------- |
| Only low/high/max, default max                                | all model selectors  | capability equality        | unit/integration     |
| The two transports use their own namespaces                   | request runtime      | final wire body            | wire tests           |
| The original model ID is not rewritten                        | all requests         | catalog key/request model  | bootstrap/wire tests |
| No context/output/media is filled                             | settings/CLI/runtime | defaults absence           | default-policy test  |
| An empty `magic_name` matches no model                        | production config    | no reasoning profile       | service tests        |
| A remote match withdrawal clears the old reasoning profile    | provider refresh     | returned + persisted state | service tests        |
| Local `modified` models are not affected by remote withdrawal | provider refresh     | local branch preserved     | service tests        |
| desktop continuous and mobile replayable unchanged            | all clients          | no protocol/state diff     | diff review          |

### Accepted Cases

| Case ID | Setup                                                           | Action                                               | Assertions                                                                                                    | Evidence layers       | E2E status |
| ------- | --------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- | ---------- |
| OXA-001 | standalone OpenAI-compatible provider                           | load `ox-alpha`                                      | three levels/default and reasoning_effort mapping correct                                                     | shared + adapter      | not-needed |
| OXA-002 | standalone Anthropic provider                                   | load `ox-alpha`                                      | adaptive + effort mapping, no budget                                                                          | adapter + wire        | not-needed |
| OXA-003 | dynamic provider, metadata missing/stale                        | upsert registry                                      | rebuild three levels by transport, other capabilities unchanged                                               | bootstrap integration | not-needed |
| OXA-004 | standalone, both transports                                     | load `GLM-x-preview-f` in any case                   | exactly the same three-level mapping as `ox-alpha`, no other default injected                                 | shared + adapter      | not-needed |
| OXA-005 | dynamic provider / OpenAI Responses                             | upsert `GLM-x-preview-f`                             | first two transports rebuild three levels; Responses explicitly does not enable the dedicated mapping         | bootstrap integration | not-needed |
| OXA-006 | `magic_name="GLM-Flash"`                                        | sync a remote mixed-case matching model              | persist and project `reasoningProfile="ox-alpha"`                                                             | service + shared      | not-needed |
| OXA-007 | `magic_name=""` / missing                                       | sync any remote model                                | no profile generated, existing reasoning unchanged                                                            | service               | not-needed |
| OXA-008 | dynamic provider carrying an ox-alpha profile                   | load as Anthropic/OpenAI-compatible                  | same low/high/max mapping as the built-in public IDs, original ID kept                                        | bootstrap integration | not-needed |
| OXA-009 | standalone, both transports                                     | load `x-preview-f-free` in any case                  | exactly the same mapping as the existing public IDs, near-miss IDs rejected                                   | shared + adapter      | not-needed |
| OXA-010 | `magic_name="foo\|bar"`                                         | sync remote models containing either name            | both names written to the same reasoning profile, illegal regex safely ignored                                | service               | not-needed |
| OXA-011 | first `magic_name` hit, later authoritative config withdraws it | sync two config versions in order with the same home | ordinary remote model's returned value and disk write both drop the profile; local `modified` model unchanged | service               | not-needed |
