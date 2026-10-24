# GLM-5.3 Model Adapter Design

## Background

GLM-5.3 is delivered by the App's dynamic provider configuration. A vendor may use the official model ID or
wrap it with ToB routing identifiers, so all of these IDs denote the same capability identity:

- `glm-5.3`;
- `toB-glm-5.3`;
- `proxy/GLM-5.3-cc`.

The recognition rule is a case-insensitive "contains `glm-5.3`", where the token must not be followed by a
decimal digit, so future models such as `glm-5.30` and `glm-5.31` are not mistaken for GLM-5.3. The model ID is
used only for capability recognition; the final provider request keeps the original configured ID.

Current catalog default facts:

- model ID: `glm-5.3`;
- context window: 1,000,000 tokens;
- max output: 128,000 tokens;
- input/output modality: text -> text;
- reasoning levels: `low` / `high` / `max`, default `max`.

These context, output and modality values are the catalog's default metadata for the exact model, not a forced
override of App dynamic providers. When the App creates and reads models it first normalizes a missing or
illegal context to 200K and tries to resolve max output from known metadata; the context, max output and input
modality the user later changes stay as explicit configuration. Read-time catalog enrichment does not take part
in context override; max output is fill-only: any existing legal value is kept and the catalog value is filled
only when the field is missing; when the catalog has no matching output either, the existing 32K runtime
fallback stays.

The CLI default policy and the workspace dynamic projection must give these model identities the highest
capability-decision priority and, before reading possibly missing or stale inbound reasoning metadata, rebuild
the three official levels by the real transport. Otherwise a routing alias that also contains other tokens such
as DeepSeek, Claude or GPT could be overridden by a broad policy.

App catalog metadata enrichment keeps a narrower persistence boundary: it fills missing canonical metadata only
for the case-insensitive exact `glm-5.3` ID. Real routing IDs with a path, prefix or suffix are not associated
with canonical metadata in the App store and are handed entirely to the CLI default policy and the workspace
dynamic overlay.

GLM-5.3 image capability uses GLM-5.2's existing provider-aware decision rather than hard-coding by model
identity:

- `supportsImages=true/false` explicitly delivered by the provider registry or catalog takes priority;
- unknown capability over the OpenAI Chat transport is treated as text-only;
- unknown real suffix variants `glm-5.2-*` / `glm-5.3-*` stay unknown, decided by explicit configuration or the
  provider; the exception is when the normalized final model segment is exactly `glm-5.2-highspeed` or
  `glm-5.3-highspeed`, which is case-insensitively text-only; OpenAI Chat is still uniformly text-only;
- unknown capability over the Anthropic transport of the official GLM provider/host stays unknown, allowing the
  existing provider-side media chain to handle it;
- other unknown third-party GLM providers fail closed as not supporting image.

The [official Zhipu general parameter docs](https://docs.bigmodel.cn/cn/guide/start/concept-param) confirm that
GLM-5.2 and later express reasoning depth with `reasoning_effort`.

## Goals

- Register `glm-5.3` in the Z.AI, BigModel and their Coding Plan providers of the China model catalog.
- Register `glm-5.3` in the corresponding four OpenAI-compatible providers of the bundled models.dev catalog.
- CLI default policy and the workspace dynamic overlay use the same GLM-5.3 identity check: case-insensitively
  contains `glm-5.3` with no digit after the token; GLM-5.3 is decided before all broad model policies, or is
  the final override in a sequentially merged policy list.
- The App catalog fills missing metadata only for the case-insensitive exact `glm-5.3` ID; IDs with a path,
  prefix or suffix get no canonical enrichment. A 200K or other legal context already on the exact model is
  also explicit configuration and is not upgraded to the catalog's 1M.
- Catalog and CLI default capability without explicit override is 1M context, 128K output and text -> text; App
  dynamic providers keep the inbound or user-configured context, max output and input modality, and only
  uniformly rebuild the three levels `low` / `high` / `max`, default `max`.
- When GLM-5.3 image metadata is missing, reuse GLM-5.2's provider-aware decision, without treating all GLM-5.3
  routing aliases as always text-only or always vision-capable.
- OpenAI-compatible requests project the chosen level to `openaiCompatible.reasoningEffort`; the final wire
  field is `reasoning_effort`.
- Anthropic dynamic providers project the three levels to `anthropic.effort` and a fixed thinking budget.
- The original model ID is never rewritten, so a ToB provider still receives its real routing name.

## Non-goals

- No `off`, `none`, `nothink`, `medium` or `xhigh` level for GLM-5.3.
- No change to GLM-5.2's `max` / `high` / `nothink` semantics.
- No change to the `enabled` / `disabled` thinking toggle of other GLM models.
- GLM-5.3 identity does not override user-configured context, max output or image capability.
- No change to the remote entitlement, default model or visibility decisions of builtin providers.
- No change to UI, model selection commit semantics, session/task state or the desktop continuous / web remote
  replayable boundary.

## Capability and request chain

```text
China model catalog              bundled models.dev snapshot
  Anthropic providers              OpenAI-compatible providers
  glm-5.3                          glm-5.3
  context=1,000,000                context=1,000,000
  output=128,000                   output=128,000
  low/high/max                     reasoning=true
          │                                │
          └──────────────┬─────────────────┘
                         ▼
                 CLI model catalog
                         │
          shared GLM-5.3 identity matcher
              contains glm-5.3, next != digit
                         │
                 default policy converges
                 levels=[low, high, max]
                 default=max
                         │
          session.settings.thoughtLevel
                         │
                         ▼
 OpenAI-compatible: reasoningEffort=level
                         │
                         ▼
 provider wire: reasoning_effort="low|high|max"

App dynamic provider (including ToB aliases)
          ├─ context / output / media: keep explicit configuration
          │                         │
          │                         └─ image unknown: reuse the GLM-5.2
          │                            provider-aware fallback
          │
          └─ shared identity matcher
             rebuilds the official three levels before inbound reasoning
                          │
                          ▼
             anthropic.effort + thinking budget
                          │
                          ▼
             provider wire: output_config.effort + thinking
```

Model capability remains the source of truth for thinking levels. The existing UI renders and switches levels
from the capability list and gets no `glm-5.3` model ID branch.

## Implementation

1. Add the GLM-5.3 three-level constants and the OpenAI-compatible factory in `reasoning-policy.ts`.
2. Add a unified model identity check in shared, used by `default-policy.ts`; the policy sits after all broad
   model policies as the final override of the sequential merge. A mutually exclusive branch checks GLM-5.3
   before the Kimi, DeepSeek, Claude, GPT and similar model checks.
3. Update `models_catalog_china_llm_zcode_2026-06-03.json` to add GLM-5.3 to the four Anthropic providers, with
   levels consistent with the current dynamic Anthropic request facts.
4. Update the four corresponding providers in `apps/zcode-cli/api.json` and regenerate
   `models-dev-snapshot.ts`.
5. The App catalog uses the canonical catalog metadata only when the model ID case-insensitively equals exactly
   `glm-5.3`; routing IDs with a path, prefix or suffix are not associated.
6. The workspace dynamic overlay recognizes GLM-5.3 before the generic GLM branch and rebuilds the official
   three levels and provider options by OpenAI-compatible or Anthropic transport; it does not override inbound
   context, max output or media capability.
7. The GLM-5.3 default reasoning policy does not declare `supportsImages`; when runtime media capability is
   missing it shares the provider-aware fallback with GLM-5.2 and brings `glm-5.3-*` suffix variants into the
   same unknown semantics; the exact Highspeed variant is the exception, a known text-only variant that fails
   closed.

## Tests

- shared/default policy: official ID, case, provider path, any prefix and non-digit suffix all hit
  1M/128K/three levels; GLM-5.3 prevails even when DeepSeek, Claude, GPT or Opus tokens are also present;
  `glm-5.30`, `glm-5.31` and GLM-5.2 are not falsely matched.
- reasoning factory: each of the three levels generates only the matching `openaiCompatible.reasoningEffort`,
  default `max`.
- models.dev snapshot: all four providers contain GLM-5.3's base capability.
- China model catalog: all four providers contain GLM-5.3, three-level reasoning and the Anthropic patch.
- wire: OpenAI-compatible `low` / `high` / `max` all generate the top-level `reasoning_effort`.
- App catalog: `glm-5.3` / `GLM-5.3` fill missing metadata such as output and extend canonical reasoning; a
  missing context uses the App's 200K default and any other existing legal context is kept; IDs with a path,
  prefix or suffix get no canonical enrichment, and non-catalog custom reasoning is unchanged.
- dynamic overlay: a GLM-5.3 alias without reasoning metadata or with a generic toggle is still rebuilt as
  `low` / `high` / `max` with parameters generated by the real transport; explicit context, max output and
  media configuration are unchanged.
- runtime media: like GLM-5.2, GLM-5.3 keeps explicit `supportsImages`; when missing, the provider-aware
  branches for OpenAI Chat, official Anthropic, third-party providers and suffix variants are covered; exact
  Highspeed is text-only, longer suffixes stay unknown.

## Impact brief

### State Owners And Commit Sinks

| State/fact                  | Draft/display owner         | Authoritative owner           | Commit sink              | Evidence                 |
| --------------------------- | --------------------------- | ----------------------------- | ------------------------ | ------------------------ |
| GLM-5.3 static capability   | each model-selection entry  | catalog + CLI default policy  | existing provider registry | catalog/adapter tests  |
| current reasoning level     | composer/runtime projection | session settings              | existing model switch    | wire test                |
| dynamic reasoning patch     | workspace overlay           | shared identity + CLI overlay | existing protocol sync   | protocol regression test |
| dynamic image capability    | provider registry / catalog | runtime media resolver        | provider request projection | model-selection tests |

### Must-Preserve Invariants

| Invariant                                              | Proof needed                                  | Evidence              |
| ------------------------------------------------------ | --------------------------------------------- | --------------------- |
| Only low/high/max, default max                         | capability equality                           | adapter/catalog tests |
| GLM-5.2 and ordinary GLM policies unchanged            | negative assertions + existing suite          | default-policy tests  |
| ToB alias does not fall into other broad model policies | still gets the official three levels under conflicting tokens | adapter/protocol test |
| The original ToB model ID is not canonicalized         | provider registry key and request model keep the original | service/wire test |
| App catalog does not enrich routing aliases            | prefix/suffix and path IDs keep inbound metadata | service test       |
| Explicit image config first, unknown decided like GLM-5.2 | provider/transport/suffix combination assertions | bootstrap unit tests |
| No change to provider entitlement and UI/session state | related files absent from diff                | diff review           |

## Case plan

| Case ID   | Setup                              | Action                              | Assertions                                   | Evidence layer        | E2E status |
| --------- | ---------------------------------- | ----------------------------------- | -------------------------------------------- | --------------------- | ---------- |
| GLM53-001 | models.dev disabled                | query official/ToB/path/near IDs    | non-digit suffix hits, digit continuation rejected | shared + adapter unit | not-needed |
| GLM53-002 | load bundled snapshot              | iterate the four providers          | all have GLM-5.3 base capability             | adapter integration   | not-needed |
| GLM53-003 | load China model catalog           | iterate the four providers          | three levels/default/Anthropic patch correct | service unit          | not-needed |
| GLM53-004 | OpenAI-compatible fake fetch       | select each of the three levels     | wire has the matching reasoning_effort       | adapter wire          | not-needed |
| GLM53-005 | dynamic Anthropic/OpenAI fixture   | sync a ToB alias without metadata   | three levels and matching transport options rebuilt | protocol integration | not-needed |
| GLM53-006 | App config with exact and routing IDs | load provider                    | exact ID filled; routing ID not enriched     | service integration   | not-needed |
| GLM53-007 | GLM-5.3 missing or explicit image metadata | resolve capability by provider/transport | consistent with GLM-5.2 fallback; explicit value first | bootstrap unit | not-needed |

No conversation E2E is added: no UI interaction, model switch commit, session state or realtime/replayable
semantics changed, and the layered unit and wire tests cover the new behavior directly.
