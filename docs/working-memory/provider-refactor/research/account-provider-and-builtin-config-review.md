# Account Provider and Built-in Provider Config Research Report

> Date: 2026-08-28
>
> Status: Research conclusions; confirmed items have entered Built-in Provider Config revision 4
>
> Design basis: [`zcode-builtin-provider-config.md`](../design/registry/zcode-builtin-provider-config.md)

## 1. Scope and Conclusions

This document reviews: (1) Account Provider page regressions relative to staging; (2) completeness and factual accuracy of Built-in Provider model members and Model Config Rules; (3) how Model, API Schema, Endpoint, and Provider Exact Rules separate; (4) which models each Built-in Provider enables by default and how file ordering is maintained.

Conclusions:

- Team Plan failed to display model details because navigation items carried an Individual Provider object — a UI identity projection bug, not an Account Overlay or Provider Config design change; fixed in subsequent work.
- Most Built-in members parse by generic rules, but "parseable" does not mean "factually accurate"; Provider model members, the three API Schemas, Endpoint differences, and default enabled sets still require systematic calibration.
- Model Config has only `match` and `provider-model` Rule types. Built-in/Personal are Source, not a third Rule type.
- Built-in Rule hierarchy is file writing order and the review mental model; no new priority, specificity, or dynamic sorting is added.
- Non-GLM generic facts are expressed by `model + api.type` first; service line differences by `model + api.type + baseURL`. Provider-scoped Match Rules only carry service facts holding for all members; Provider-Model Exact Rules only carry default `enabled` and narrow product facts for single combinations.
- The strict JSON Schema capability field is `supportsJsonSchemaOutput`. Ordinary JSON or JSON Object Mode is not evidence for `true`.
- Built-in Provider `builtinModelIds` writes default-enabled models before others in release files; this is not a runtime sorting feature and does not override Personal `modelOrder`.
- Start/Individual/Team Plan static members add `GLM-5.3`, with physical order fixed as `GLM-5.3`, `GLM-5.3-Flash`, `GLM-5.2`, `GLM-5-Turbo`.
- Start/Individual/Team Plan model requests are converted from Image/Video to text by the server-side vision model, so all model members of these Plan Providers declare Image/Video input; ordinary Account API does not inherit this service capability.

## 2. Account Provider Review

### 2.1 Historical Issue

The Refactor split Individual and Team into independent Provider identities. The old UI, when generating Team navigation items, replaced only `presetId` while still carrying the Individual Provider object (`provider.providerId = account:*:individual-coding-plan`), so the detail identity check failed and displayed plan status only, not Team model details.

The correct boundary: plan status and quotas come from Team entitlement; Provider API, model members, and model editing objects come from the same ID's Effective Team Provider; model editing still only writes Personal Model Config Rule. Do not revert to "Team reusing Individual Provider."

### 2.2 Relationship with Built-in Provider Config Research

The Account Overlay continues to constrain the corresponding Built-in Account Provider: `enabled` expresses availability under the current account; the model set returned by Start Plan can constrain the Provider's model members; the set returned by Account does not overwrite ZCode Built-in Model Rules; Personal Provider Config and Personal Model Rules still override the configurable leaf values they are allowed to cover. Account page issues therefore do not change the Built-in Provider Config writing rules in the rest of this document.

## 3. Current Built-in Config Structure

`config/provider/zcode-builtin.json` atomically contains Provider Map and Model Config Rules, covering three API Schemas: `anthropic-messages`, `openai-chat-completions`, `openai-responses`. Revision 2 had 21 Providers and 120 Model Rules with no `baseURLMatch` Rule; revision 3 added flagship models, Endpoint specialization, and Provider-Model Exact enabled, while the generic baseline keeps complete conservative values for unknown Personal Models. Remaining maintenance risks:

1. A family covering only one or two schemas, with the third accidentally inheriting generic values;
2. Website proving only JSON Object, misread as strict JSON Schema;
3. The same model's capabilities on official and third-party compatible Endpoints incorrectly merged;
4. Old models, aliases, and current flagships all inheriting `enabled=true`;
5. Provider model member order not synchronized with default enabled state.

## 4. Rule Writing Model

The Built-in file is maintained in this physical order:

```text
Complete Baseline Match Rule
          |
          v
Model Match Rule
          |
          v
Model + API Match Rule
          |
          v
Model + API + Endpoint Match Rule
          |
          v
Provider-scoped Match Rule
          |
          v
Provider-Model Exact Rule
```

| Layer                        | Main Facts                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Complete Baseline            | Complete, conservative default values for unknown Personal Models                     |
| Model Match                  | Model facts that do not vary by line: context, max output, I/O formats                |
| Model + API Match            | Tool, JSON Schema, MCS, Options, and reasoning mapping under Schema                   |
| Model + API + Endpoint Match | Confirmed differences of the same Schema on specific official or compatible Endpoints |
| Provider-scoped Match        | Service capabilities that hold for all current/future members of the Provider         |
| Provider-Model Exact         | Default enabled, single Provider-Model combination product facts                      |

This is only the author specification for the Built-in JSON. The Resolver traverses by array physical order; the later hit explicit leaf overrides previous ones; no Rule is computed as "more specific," and no additional priority is implemented.

Non-GLM models typically need no Provider-Model Exact Rule duplicating request capabilities: two Providers pointing to the same API Schema and Endpoint naturally obtain the same Endpoint facts. Only service capabilities indistinguishable by Endpoint that hold for all current/future members enter the Provider-scoped Match Rule; Exact Rules appear only at default-enabled or single-combination true product differences.

## 5. Capability Field Determination

### 5.1 JSON Schema Output

```ts
properties.supportsJsonSchemaOutput: boolean;
```

It only indicates the current Effective Model can receive `ModelRequest.responseJsonSchema` and encode it by the current Adapter/API/Endpoint as strict JSON Schema constraint output. Insufficient evidence: prompting the model to output JSON; only supporting `response_format={type:"json_object"}`; the website broadly writing "Structured Output" without mapping to the current Schema/Endpoint; another compatible Endpoint succeeding.

### 5.2 MCS

`supportsMidConversationSystem` indicates the current Adapter and Endpoint can reliably encode mid-conversation system messages, not whether a model is "smart" or vendor marketing. It belongs in Model + API or Model + API + Endpoint Rules, not enabled family-wide by common sense.

### 5.3 Coverage of Three Schemas

"Covering three Schemas" means each maintained model has a clear, auditable parse result under all three Schemas — not that the vendor's official Endpoint must natively support all three protocols. When a vendor does not provide a protocol, conservative results can be left for third-party compatible Endpoints, but high-risk capabilities stay `false` until official documentation or reproducible Endpoint evidence.

## 6. Per-Model-Family Research

Evidence categories — official confirmation, product confirmation, and Endpoint pending-verification — enter review materials only, not runtime Config.

### 6.1 GLM / BigModel / Z.ai

Current product flagship models confirmed: `glm-5.3`, `glm-5.3-flash`. Public website lag does not justify labeling 5.3 suspicious or alpha-only; maintain 5.3/5.3 Flash as "product confirmation" current flagships. Whether `GLM-5.2` belongs to Coding Plan Provider members is determined by the corresponding Account Overlay and Built-in Provider Config, and must not reverse-replace the ordinary GLM API's 5.3 flagship models.

BigModel's official model overview lists `GLM-5.3` as text flagship and `GLM-5.3-Flash` as native multimodal (natively understands images and video); the Chat Completion image/video examples also use Flash. Native facts of the ordinary Account API:

| Model         | Image | Video | Evidence            |
| ------------- | ----- | ----- | ------------------- |
| GLM-5.3       | false | false | Official text model |
| GLM-5.3-Flash | true  | true  | Official multimodal |

`glm-5v-turbo` and `glm-5-turbo` are not speed tiers: the former's `V` denotes Vision, a Text/Image/Video/File multimodal model for visual Coding/GUI Agents; the latter is a Text-only Agent model for OpenClaw long-chain execution, tool calling, and continuous task optimization. Both are 200K context, 128K max output; maintain as two parallel specialized models — do not overwrite each other's capabilities because both carry `Turbo`.

Start, Individual, and Team Plans have the additional product fact that requests are converted from Image/Video to text by the server-side vision model, so all Plan Provider model members can receive visual input. This is a Provider service capability: it does not change GLM-5.3 native facts and does not infer Audio/PDF. Individual and Team static member order is fixed as:

```text
GLM-5.3
GLM-5.3-Flash
GLM-5.2
GLM-5-Turbo
```

Start Plan members remain dynamically constrained by `billing/balance` in the Account Overlay; the Built-in Provider Config does not statically add 5.3 on upstream's behalf, but regardless of which members upstream returns, the Plan Provider's Image/Video service capability applies.

Real tests on the official Mac App (settings-page screenshot with Provider list, model list, and red arrow):

| Connection Method              | Model         | Result                                                                             |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------- |
| BigModel Team Coding Plan      | GLM-5.3-Flash | Accurately identified Provider list, pointed arrow to `glm-5.3-flash`              |
| BigModel Team Coding Plan      | GLM-5.2       | Accurately identified Provider list, pointed arrow to `glm-5.3-flash`              |
| BigModel Account API (API Key) | glm-5.3       | Request did not error, but confirmed the model API does not consume visual content |
| BigModel Account API (API Key) | glm-5.3-flash | Image received normally; Agent accurately identified Provider list and arrow       |

The Team Plan GLM-5.2 result conforms to "Plan service provides unified visual transcription." The ordinary Account API is confirmed to have no visual capability: accepting image-carrying requests without error means only that the server tolerates or ignores the content. Model Config native facts therefore keep `GLM-5.3` text-only and `GLM-5.3-Flash` declaring Image/Video. (Earlier HTTP 401s from disk-cached normal/Individual/Team keys were later shown by runtime logs to be expired disk values — the official app refreshes the team project key at runtime — so those 401s are not capability evidence.)

Still needing real-Endpoint verification: 5.3/5.3 Flash context, max output, Image/Video, Tools, and three-Schema capabilities; Z.ai, BigModel, Coding Plan Endpoint MCS, JSON Schema, and reasoning parameter differences; whether `glm-5v-turbo` remains the uniquely visual default-enabled model; case-sensitive Model IDs are request identity only and must not cause the same model facts to diverge.

References: [BigModel Model Overview](https://docs.bigmodel.cn/cn/guide/start/model-overview),
[Z.ai Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion),
[Z.ai Core Parameters](https://docs.z.ai/guides/overview/concept-param).

### 6.2 Kimi

Current Built-in Config includes K3, K2.x, and Moonshot V1 together. Kimi's materials show K3, K2.7 Code, and K2.6; K3 has 1M context, K2.7 Code/K2.6 has 256K. Current members are missing K2.7 Code; whether aliases like `k3`, `k3-256k` are real Endpoint IDs needs confirmation. Kimi Chat API provides response format evidence in `json_schema` form, enabling strict JSON Schema in the corresponding official API/Endpoint Rules; it does not automatically diffuse to other compatible protocols.

References: [Kimi Model Homepage](https://platform.kimi.ai/), [Kimi Chat API](https://platform.kimi.ai/docs/api/chat).

### 6.3 MiniMax

MiniMax's public direct API has M3 as the latest flagship, continuing M2.7/M2.7-highspeed. The China region official model call documentation explicitly provides M3 call examples at `https://api.minimaxi.com/anthropic` and `https://api.minimaxi.com/v1`, making M3 the first default-enabled member of the MiniMax Built-in Provider. M3 has 1M context, native Text/Image/Video; the M2.7 series has 204800 context, continuing default-enabled as speed tiers. (An earlier "direct Endpoint has not proven M3" judgment from outdated interface overviews and Models API documentation examples is overturned by the current model call documentation; Models API example responses prove protocol shape only — member validation uses real-time success responses carrying current access materials.)

Reference: [MiniMax Text Generation](https://platform.minimaxi.com/docs/guides/text-generation).

### 6.4 DeepSeek

`deepseek-v4-flash` and `deepseek-v4-pro` continue as two current product tiers. The official Responses documentation lists Flash only; Pro's Responses and JSON Schema capabilities must be independently verified, not copied from Flash.

Reference: [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/).

### 6.5 Qwen

The Built-in Provider Config currently features Qwen 3.5 Plus/Flash, but Alibaba Cloud's public model list shows 3.7/3.8, requiring a Provider model member upgrade ruling first. Qwen 3.5 Plus/Flash's 1M context, 64K output, Text/Image/Video, Tool capabilities have official basis. Strict JSON Schema covers partial models only; JSON Object support is broader; the two must not be conflated.

References: [Qwen Vision Model Capabilities](https://help.aliyun.com/en/model-studio/vision-model/),
[Qwen Structured Output](https://help.aliyun.com/en/model-studio/qwen-structured-output).

### 6.6 MiMo

MiMo v2.5/v2.5-pro are current flagship, official 1M context, 128K output; old v2-pro/v2-omni/v2-flash were announced for removal on 2026-06-30 and stay default disabled. Current structured output materials prove only JSON Object; `supportsJsonSchemaOutput` stays false before strict Schema evidence. Web Search is an Endpoint/Plugin capability, not a global model fact.

Reference: [MiMo Model Overview](https://mimo.mi.com/docs/en-US/quick-start/model).

### 6.7 OpenAI

Sol/Terra/Luna each provide different capabilities and cost tiers; official materials give approximately 1.05M context, 128K output, with Image, Tools, and Structured Output. The generic `gpt-5.6` is a Sol alias and must not be default-enabled alongside Sol, to avoid duplicate entry points.

Reference: [OpenAI Models](https://developers.openai.com/api/docs/models).

### 6.8 Anthropic

Fable, Opus, Sonnet, and Haiku are different capability/cost tiers that must not be deleted for "keeping only the latest." Current materials show the first three at 1M/128K, Haiku at 200K/64K; each tier can be independently default-enabled.

Reference: [Anthropic Models](https://platform.claude.com/docs/en/about-claude/models/overview).

### 6.9 xAI

Grok 4.6 is the current universal flagship with 500K context, Image, Tools, and strict Schema basis; Grok Build is a unique Coding tier, retained as default enabled; Grok 4.3 stays default disabled as an old model.

References: [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6),
[xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

## 7. Revision 4 Default Enabled Results

Confirmed items have been written to Config; members not proven by official direct Endpoints or superseded remain disabled for Personal/compatible services.

| Provider Family | Default enabled candidates                                                            | Default disabled / pending-confirmation                         |
| --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| GLM API         | `glm-5.3`, `glm-5.3-flash`, `glm-5v-turbo`                                            | Old 5.1/5/4.x                                                   |
| Coding Plan     | Individual/Team: 5.3, 5.3 Flash, 5.2, 5-Turbo; Start determined by Account return set | Do not statically expand Start account set                      |
| Kimi            | Unique tiers among K3, K2.7 Code, K2.6 still on current Endpoint                      | Old K2.x, Moonshot V1, duplicate aliases                        |
| MiniMax         | M3, M2.7, M2.7-highspeed                                                              | Older M2.x                                                      |
| DeepSeek        | `deepseek-v4-flash`, `deepseek-v4-pro`                                                | Strict Schema promoted only by official Responses Endpoint Rule |
| Qwen            | `qwen3.8-max`, `qwen3.8-flash`                                                        | Replaced 3.5/3.x models                                         |
| MiMo            | `mimo-v2.5-pro`, `mimo-v2.5`                                                          | Retired v2-pro/v2-omni/v2-flash                                 |
| OpenAI          | Sol/Terra/Luna                                                                        | `gpt-5.6` alias, replaced Codex models                          |
| Anthropic       | Fable/Opus/Sonnet/Haiku each unique tier                                              | No clear duplicates                                             |
| xAI             | `grok-4.6`, `grok-build-0.1`                                                          | `grok-4.3`                                                      |

On final write, each Provider's `builtinModelIds` physical order is "default enabled first, default disabled last"; no new enabled-first sorting at runtime; user ordering still only via Personal `modelOrder`.

## 8. Recommended Implementation Order

1. Call vendor Models APIs first, generating visible members from access materials and capability difference reports returned explicitly by the interface;
2. Use subsequent model-verification APIs to continuously generate Provider members × three Schemas × Endpoint real-test matrices;
3. Promote or roll back each Endpoint capability in revision 4 that still represents conservative inference;
4. Rename `supportsStructuredOutput` to `supportsJsonSchemaOutput` in one pass, synchronizing Config, Registry, Model, Runtime, Protocol, Settings, and tests, without keeping dual fields;
5. Continue filling in yet-to-be-documented Model + API + Endpoint differences;
6. Prove subsequent results with real Built-in Config completeness tests and three-Schema Adapter integration tests.

Any issue requiring changes to Account Overlay, model member ownership, Personal override order, or Runtime selection semantics must be ruled separately, not conveniently modified through Built-in Provider Config calibration.

## 9. Subsequent Implementation Impact Brief

Change layers are mainly `option-source`, `draft-default`, `validation`, and `persistence`; no changes to model selection, sessions, queues, or recovery semantics.

| Surface                    | Display/Default Source            | User Submission or Release Landing               | Boundaries to Maintain                                               |
| -------------------------- | --------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Built-in Provider settings | Effective Provider + Model Config | Personal Overlay                                 | Does not write back to Built-in Release                              |
| Account Provider settings  | Built-in + Account + Personal     | Personal Overlay; account facts still by Account | Team/Individual identity and members do not cross                    |
| Personal Provider settings | Generic Built-in Rules + Personal | Personal Provider/Model Rules                    | Personal Models also get complete conservative baseline              |
| Ordinary model selector    | Registry's selectable projection  | Session Selection                                | Only filters and preserves member order, does not re-sort by enabled |
| Runtime / Adapter          | Frozen Active Model               | Model API Request                                | Does not infer capabilities by modelId, Provider ID                  |

Plan Provider input capabilities still flow through the single facts chain to Runtime:

```text
Built-in Model native facts
          |
          v
Plan Provider-scoped Match Rule
          |
          v
Effective Model Config
          |
          v
Active Model.properties.input_format
          |
          v
Adapter media check and encoding
```

Runtime does not judge Plan ID, Access mode, or model name; it only reads the final Properties of the Active Model.

Implementation seeds to check: `config/provider/zcode-builtin.json` (members, physical order, Built-in Rules); `ModelConfigRules.composeEffective()` / `ModelConfigRules.resolve()` (sequential composition and matcher resolution); `packages/provider/src/resolver.ts` (completeness and Registry input); `packages/provider-node/test/zcode-builtin-integrity.test.ts` (real fact evidence); `packages/ui/src/settings/model-provider-section/` (default preview, sparse Personal overrides, model editing); per-Adapter `responseJsonSchema`, Tool, MCS, and reasoning request tests.

The current graph drift is already in the Feature Graph: Built-in Rule physical writing order, Endpoint layer, and "no new dynamic specificity" are explicit Provider Registry invariants. Implementations that only adjust the Built-in Config must not touch Desktop continuous, Mobile replayable, workspace identity, queues, or task recovery.

### 9.1 This Round's Boundaries and Acceptance Cases

| Case             | Setup                                | Assertion                                                     | Status   |
| ---------------- | ------------------------------------ | ------------------------------------------------------------- | -------- |
| ACCOUNT-PLAN-001 | Z.ai/BigModel Individual Provider    | Member order: 5.3, 5.3 Flash, 5.2, 5-Turbo                    | accepted |
| ACCOUNT-PLAN-002 | Z.ai/BigModel Team Provider          | Member order: 5.3, 5.3 Flash, 5.2, 5-Turbo                    | accepted |
| ACCOUNT-PLAN-003 | Any member of Start/Individual/Team  | Effective input supports Image/Video                          | accepted |
| ACCOUNT-PLAN-004 | Ordinary Account API + GLM-5.3       | Native fact stays text; no error does not mean visual support | accepted |
| ACCOUNT-PLAN-005 | Ordinary Account API + GLM-5.3-Flash | Native Image/Video; ZCode images end-to-end usable            | accepted |
| ACCOUNT-PLAN-006 | Team Plan + GLM-5.2/5.3 Flash        | Semantic screenshots all accurately understood                | accepted |
| ACCOUNT-PLAN-007 | Ordinary Account API carrying images | Service tolerates, but model does not consume visual content  | accepted |

Not included in this round: Audio/PDF request encoding entry, whether upstream adds 5.3 for Start, whether Off-Peak reuses visual transcription, Account entitlement/credential lifecycle, session and recovery semantics. MiMo v2.5 has recorded Audio as a static input fact per the website but does not trigger unimplemented Audio content projection this round.
