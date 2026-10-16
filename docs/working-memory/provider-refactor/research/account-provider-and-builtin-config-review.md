# Account Provider and Built-in Provider Config Research Report

> Date: 2026-08-28
>
> Status: Research conclusions; confirmed items have entered Built-in Provider Config revision 4
>
> Design basis: [`zcode-builtin-provider-config.md`](../design/registry/zcode-builtin-provider-config.md)

## 1. Scope and Conclusions

This document records the review of the following issues after the Provider Refactor:

1. Whether the Account Provider page has unexpected regressions relative to staging;
2. Whether the Built-in Provider Config's Provider model members and Model Config Rules are complete and factually accurate;
3. How Model, API Schema, Endpoint, and Provider Exact Rule should be separated;
4. Which models each Built-in Provider enables by default, and how file ordering is maintained.

The conclusions are as follows:

- Team Plan previously failed to display model details because navigation items carried an Individual Provider object. This is a UI identity projection bug, not a change in the Account Overlay or Provider Config design, and has been fixed in subsequent work.
- Most Built-in members can be parsed by generic rules, but "can be parsed" does not mean "factually accurate." Systematic calibration of Provider model members, the three API Schemas, Endpoint differences, and default enabled sets is still required.
- Model Config has only `match` and `provider-model` two types of Rule. Built-in/Personal are Source, not a third Rule type.
- Built-in Rule hierarchy is file writing order and the review mental model; no new priority, specificity, or dynamic sorting is added.
- Non-GLM generic facts should be expressed by `model + api.type` first; service line differences by `model + api.type + baseURL`. Provider-scoped Match Rules only carry service facts that hold for all members; Provider-Model Exact Rules only carry default `enabled` and narrow product facts for single combinations.
- The strictly JSON Schema capability field target name is `supportsJsonSchemaOutput`. Ordinary JSON or JSON Object Mode cannot serve as evidence for this field being `true`.
- Built-in Provider `builtinModelIds` writes the default-enabled models before others in release files; this is not a runtime sorting feature and does not override Personal `modelOrder`.
- Start/Individual/Team Plan static members add `GLM-5.3`, with physical order fixed as `GLM-5.3`, `GLM-5.3-Flash`, `GLM-5.2`, `GLM-5-Turbo`.
- Start/Individual/Team Plan model requests are first converted from Image/Video to text by the server-side vision model, so all model members of these Plan Providers declare Image/Video input; ordinary Account API does not inherit this service capability.

## 2. Account Provider Review

### 2.1 Historical Issue

The Provider Refactor split Individual and Team into independent Provider identities. The old UI, when generating Team navigation items, only replaced `presetId` but continued to carry the Individual Provider object:

```text
Team navigation item
├─ presetId = account:*:team-coding-plan
└─ provider.providerId = account:*:individual-coding-plan
                    |
                    v
Detail identity check fails
                    |
                    `-- displays plan status only, not Team model details
```

The correct boundary is: plan status and quotas come from Team entitlement; Provider API, model members, and model editing objects come from the same ID's Effective Team Provider; model editing still only writes Personal Model Config Rule. We cannot revert to the old identity of "Team reusing Individual Provider."

### 2.2 Relationship with Built-in Provider Config Research

The Account Overlay continues to constrain the corresponding Built-in Account Provider:

- `enabled` expresses whether the Provider is available under the current account;
- The model set returned by Start Plan can constrain the Provider's model members;
- The model set returned by Account does not overwrite ZCode Built-in Model Rules;
- Personal Provider Config and Personal Model Rules still override the configurable leaf values they are allowed to cover.

Therefore, Account page issues do not change the writing rules for the Built-in Provider Config in the rest of this document.

## 3. Current Built-in Config Structure

The current `config/provider/zcode-builtin.json` atomically contains Provider Map and Model Config Rules, covering three API Schemas:

- `anthropic-messages`
- `openai-chat-completions`
- `openai-responses`

During the revision 2 audit, there were 21 Providers and 120 Model Rules, with no `baseURLMatch` Rule yet. Revision 3 has added current flagship models, Endpoint specialization, and Provider-Model Exact enabled; the generic baseline continues to provide complete conservative values for unknown Personal Models, but specific model facts still carry the following maintenance risks:

1. A family covers only one or two schemas, with the third schema accidentally inheriting generic values;
2. The website only proves JSON Object, but it is misread as strict JSON Schema;
3. The same model's capabilities on the official Endpoint and third-party compatible Endpoints are incorrectly merged;
4. Old models, aliases, and current flagship models all inherit `enabled=true`;
5. Provider model member order is not synchronized with default enabled state.

## 4. Rule Writing Model

The Built-in file is maintained in the following physical order:

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

Each layer's responsibilities:

| Layer                        | Main Facts                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Complete Baseline            | Complete, conservative default values for unknown Personal Models                     |
| Model Match                  | Model facts that do not vary by line: context, max output, I/O formats                |
| Model + API Match            | Tool, JSON Schema, MCS, Options, and reasoning mapping under Schema                   |
| Model + API + Endpoint Match | Confirmed differences of the same Schema on specific official or compatible Endpoints |
| Provider-scoped Match        | Service capabilities that hold for all current/future members of the Provider         |
| Provider-Model Exact         | Default enabled, single Provider-Model combination product facts                      |

This is only the author specification for the Built-in JSON. The Resolver still traverses by array physical order; the later hit explicit leaf overrides previous ones; no Rule is computed as "more specific," and no additional priority is implemented.

Non-GLM models typically do not need a Provider-Model Exact Rule to duplicate request capabilities. If two Providers point to the same API Schema and Endpoint, they naturally obtain the same set of Endpoint facts. Only service capabilities that cannot be distinguished by Endpoint and hold for all current/future members of the Provider enter the Provider-scoped Match Rule; Exact Rules appear only at default-enabled or single-combination true product differences.

## 5. Capability Field Determination

### 5.1 JSON Schema Output

Target field:

```ts
properties.supportsJsonSchemaOutput: boolean;
```

It only indicates that the current Effective Model can receive `ModelRequest.responseJsonSchema` and encode it by the current Adapter/API/Endpoint as strict JSON Schema constraint output. The following evidence is insufficient:

- Prompting the model to output JSON;
- Only supporting `response_format={type:"json_object"}`;
- The website broadly writing "Structured Output" without corresponding to the current Schema/Endpoint;
- Another compatible Endpoint succeeding.

### 5.2 MCS

`supportsMidConversationSystem` indicates that the current Adapter and Endpoint can reliably encode mid-conversation system messages, not whether a model is "smart" or vendor marketing capabilities. It should be placed in Model + API or Model + API + Endpoint Rules, not enabled family-wide by common sense.

### 5.3 Coverage of Three Schemas

"Covering three Schemas" means each maintained model has a clear, auditable parse result under all three Schemas. It does not mean the vendor's official Endpoint must natively support all three protocols. When a vendor does not provide a certain protocol, conservative results can be left for third-party compatible Endpoints, but high-risk capabilities stay `false` until there is official documentation or reproducible Endpoint evidence.

## 6. Per-Model-Family Research

Evidence falls into three categories: official confirmation, product confirmation, and Endpoint pending-verification. Evidence categories only enter review materials, not runtime Config.

### 6.1 GLM / BigModel / Z.ai

Current product flagship models confirmed:

- `glm-5.3`
- `glm-5.3-flash`

Public website content may still lag behind old versions, which is public material lag and does not justify labeling 5.3 as suspicious or alpha-only. 5.3/5.3 Flash should be maintained as "product confirmation" current flagship models. Whether `GLM-5.2` belongs to Coding Plan Provider's model members is determined by the corresponding Account Overlay and Built-in Provider Config, and should not reverse-replace the ordinary GLM API's 5.3 flagship models.

The BigModel current official model overview lists `GLM-5.3` as the text flagship and `GLM-5.3-Flash` as the native multimodal model, explicitly stating Flash natively understands images and video; the Chat Completion documentation's image and video examples also use Flash. Therefore, the native facts of the ordinary Account API are:

| Model         | Image | Video | Evidence            |
| ------------- | ----- | ----- | ------------------- |
| GLM-5.3       | false | false | Official text model |
| GLM-5.3-Flash | true  | true  | Official multimodal |

`glm-5v-turbo` and `glm-5-turbo` are not speed-tier relationships. The former's `V` denotes Vision, a Text/Image/Video/File multimodal model for visual Coding/GUI Agents; the latter is a Text-only Agent model for OpenClaw long-chain execution, tool calling, and continuous task optimization. Both current official specifications are 200K context, 128K max output, and should be maintained as two parallel specialized models, not allowed to overwrite each other's capabilities just because they both carry `Turbo`.

Start, Individual, and Team Plans have additional product facts: requests are first converted from Image/Video to text by the server-side vision model, so all model members of Plan Providers can receive these two types of visual input. This is a Provider service capability that does not change the native model facts of GLM-5.3, nor infer Audio/PDF.

The static member order for Individual and Team plans is fixed as:

```text
GLM-5.3
GLM-5.3-Flash
GLM-5.2
GLM-5-Turbo
```

Start Plan members are still dynamically constrained by `billing/balance` in the Account Overlay; this round does not add 5.3 statically on behalf of upstream in the Built-in Provider Config, but regardless of which members upstream returns, the Plan Provider's Image/Video service capability should be applied.

In the real product chain of the official Mac App, a settings page screenshot containing a Provider list, model list, and red arrow was used to complete the following real tests:

| Connection Method              | Model         | Result                                                                             |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------- |
| BigModel Team Coding Plan      | GLM-5.3-Flash | Accurately identified Provider list, pointed arrow to `glm-5.3-flash`              |
| BigModel Team Coding Plan      | GLM-5.2       | Accurately identified Provider list, pointed arrow to `glm-5.3-flash`              |
| BigModel Account API (API Key) | glm-5.3       | Request did not error, but confirmed the model API does not consume visual content |
| BigModel Account API (API Key) | glm-5.3-flash | Image received normally; Agent accurately identified Provider list and arrow       |

The Team Plan GLM-5.2 result conforms to the product fact of "Plan service providing unified visual transcription." The ordinary Account API has been confirmed to have no visual capability: the interface accepts image-carrying requests without error, which only means the server tolerates or ignores the content, not that the model consumes images. Model Config native facts therefore continue to be maintained per official documentation: `GLM-5.3` stays text-only, `GLM-5.3-Flash` declares Image/Video.

Prior HTTP 401 responses from sending requests directly with disk-cacheed normal, Individual, and Team keys were later proven by runtime logs to use the team project key refreshed at runtime by the official app; the disk values were already expired. This 401 cannot serve as model capability evidence, nor be used to negate the above official app real tests.

Further verification against real Endpoints is still needed:

- 5.3/5.3 Flash context, max output, Image/Video, Tools, and three Schema capabilities;
- Z.ai, BigModel, Coding Plan Endpoint MCS, JSON Schema, and reasoning parameter differences;
- Whether `glm-5v-turbo` remains the uniquely visual model enabled by default;
- Case-sensitive Model IDs are only for request identity and should not cause the same model facts to diverge.

References: [BigModel Model Overview](https://docs.bigmodel.cn/cn/guide/start/model-overview),
[Z.ai Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion),
[Z.ai Core Parameters](https://docs.z.ai/guides/overview/concept-param).

### 6.2 Kimi

The current Built-in Provider Config includes K3, K2.x, and Moonshot V1 together. Kimi's current materials show K3, K2.7 Code, and K2.6; K3 has 1M context, K2.7 Code/K2.6 has 256K. The current Provider model members are missing K2.7 Code, and whether aliases like `k3`, `k3-256k` are real Endpoint IDs needs confirmation.

Kimi Chat API has provided response format evidence in `json_schema` form, which can enable strict JSON Schema in the corresponding official API/Endpoint Rules; it should not automatically diffuse to other compatible protocols.

References: [Kimi Model Homepage](https://platform.kimi.ai/), [Kimi Chat API](https://platform.kimi.ai/docs/api/chat).

### 6.3 MiniMax

MiniMax current public direct API has M3 as the latest flagship, continuing to provide M2.7/M2.7-highspeed. The China region official model call documentation explicitly provides call examples for M3 at `https://api.minimaxi.com/anthropic` and `https://api.minimaxi.com/v1`, making it the first default-enabled member of the MiniMax Built-in Provider. M3 has 1M context, native Text/Image/Video; M2.7 series has 204800 context, continuing to be enabled by default as different speed tiers.

The previous judgment that "the direct Endpoint has not proven M3" came from outdated interface overviews and Models API documentation examples, which has been overturned by the current model call documentation. The Models API example response only proves protocol shape; what is truly used for member validation is the real-time success response carrying current access materials.

Reference: [MiniMax Text Generation](https://platform.minimaxi.com/docs/guides/text-generation).

### 6.4 DeepSeek

Built-in's `deepseek-v4-flash` and `deepseek-v4-pro` can continue as two current product tiers. The official Responses documentation currently only explicitly lists Flash, so Pro's Responses and JSON Schema capabilities must be independently verified, not copied from Flash.

Reference: [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/).

### 6.5 Qwen

The Built-in Provider Config currently features Qwen 3.5 Plus/Flash, but Alibaba Cloud's public model list now shows Qwen 3.7/3.8, requiring a Provider model member upgrade ruling first.

Qwen 3.5 Plus/Flash's 1M context, 64K output, Text/Image/Video, Tool, and other capabilities have official basis. Strict JSON Schema only covers partial models; JSON Object support scope is broader, and the two cannot be conflated.

References: [Qwen Vision Model Capabilities](https://help.aliyun.com/en/model-studio/vision-model/),
[Qwen Structured Output](https://help.aliyun.com/en/model-studio/qwen-structured-output).

### 6.6 MiMo

MiMo v2.5/v2.5-pro are current flagship, with official 1M context, 128K output; old v2-pro/v2-omni/v2-flash have been announced for removal on 2026-06-30 and should remain disabled by default. The current structured output materials only suffice to prove JSON Object, so `supportsJsonSchemaOutput` stays false before there is strict Schema evidence. Web Search is an Endpoint/Plugin capability and should not be written as a global model fact.

Reference: [MiMo Model Overview](https://mimo.mi.com/docs/en-US/quick-start/model).

### 6.7 OpenAI

Sol/Terra/Luna each provide different capabilities and cost tiers; official current materials give approximately 1.05M context, 128K output, with support for Image, Tools, and Structured Output. The generic `gpt-5.6` points to Sol as an alias and should not be enabled by default alongside Sol to avoid duplicate entry points.

Reference: [OpenAI Models](https://developers.openai.com/api/docs/models).

### 6.8 Anthropic

Fable, Opus, Sonnet, and Haiku are different capability/cost product tiers that should not be deleted just for "keeping only the latest." The current materials show the first three at 1M/128K, Haiku at 200K/64K; each tier can be independently enabled by default.

Reference: [Anthropic Models](https://platform.claude.com/docs/en/about-claude/models/overview).

### 6.9 xAI

Grok 4.6 is the current universal flagship with 500K context, Image, Tools, and strict Schema basis; Grok Build is a unique Coding tier and can be retained as default enabled; Grok 4.3 stays default disabled as an old model.

References: [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6),
[xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).

## 7. Revision 4 Default Enabled Results

The following confirmed items have been written to Config; members not proven by official direct Endpoints or superseded remain disabled for Personal/compatible services.

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

On final write, each Provider's `builtinModelIds` physical order is adjusted so "default enabled first, default disabled last"; no new enabled-first sorting at runtime; user sorting still only handled by Personal `modelOrder`.

## 8. Recommended Implementation Order

1. Call vendor Models APIs first, generating visible members from access materials and capability difference reports returned explicitly by the interface;
2. Use subsequent model-verification APIs to continuously generate Provider members × three Schemas × Endpoint real-test matrices;
3. Promote or roll back each Endpoint capability in revision 4 that still represents conservative inference;
4. Rename `supportsStructuredOutput` to `supportsJsonSchemaOutput` in one pass, synchronizing Config, Registry, Model, Runtime, Protocol, Settings, and tests, without keeping dual fields;
5. Continue filling in yet-to-be documented Model + API + Endpoint differences;
6. Use real Built-in Config completeness tests and three Schema Adapter integration tests to prove subsequent results.

Any issues requiring changes to Account Overlay, model member ownership, Personal override order, or Runtime selection semantics must be ruled separately and cannot be conveniently modified through Built-in Provider Config calibration.

## 9. Subsequent Implementation Impact Brief

The change layers are mainly `option-source`, `draft-default`, `validation`, and `persistence`; they do not change model selection, sessions, queues, or recovery semantics.

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

Implementation seeds that must be checked:

- `config/provider/zcode-builtin.json`: Provider members, physical order, and Built-in Rules;
- `ModelConfigRules.composeEffective()` / `ModelConfigRules.resolve()`: sequential composition and matcher resolution;
- `packages/provider/src/resolver.ts`: Effective Provider/Model completeness and Registry input;
- `packages/provider-node/test/zcode-builtin-integrity.test.ts`: real Built-in Provider/Model Config fact evidence;
- `packages/ui/src/settings/model-provider-section/`: default value preview, Personal sparse overrides, and model editing;
- Per-Adapter `responseJsonSchema`, Tool, MCS, and reasoning request tests.

The current Graph drift has been added to the Feature Graph: Built-in Rule physical writing order, Endpoint layer, and "no new dynamic specificity" are explicit invariants of the Provider Registry. Subsequent implementations that only adjust the Built-in Config should not touch Desktop continuous, Mobile replayable, workspace identity, queues, or task recovery.

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

Not included in this round: Audio/PDF request encoding entry, whether upstream adds 5.3 for Start, whether Off-Peak reuses visual transcription, Account entitlement/credential lifecycle, session and recovery semantics. MiMo v2.5 has recorded Audio as a static input fact per the website, but will not trigger unimplemented Audio content projection for this round.
