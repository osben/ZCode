# Built-in Provider Flagship Models and Capability Evidence (2026-08)

> Status: Initial revision 4 release evidence; Kimi multimodal correction supplemented on 2026-09-01
>
> Design basis: [`zcode-builtin-provider-config.md`](../design/registry/zcode-builtin-provider-config.md)

## 1. Evidence Rules

This report only records the basis publishers use to maintain the Built-in Config, and does not add evidence, confidence, or provenance fields to runtime Config. Facts are ruled in the following order:

```text
ZCode product or account service confirmed contracts
          |
          v
Real-time successful response from Models API (if vendor provides)
          |
          v
Current official model/API documentation
          |
          v
Conservative inference from third-party compatible scenarios
```

- Officially declared context, max output, input formats, and protocol capabilities can enter the corresponding Model/API/Endpoint Rule.
- Capabilities additionally provided by the ZCode plan chain enter Provider-scoped Rules and cannot reverse-rewrite native model facts.
- Models API documentation examples only prove response shape, not real-time directories with current access materials.
- Candidates not listed on the website can keep conservative rules for third-party compatible services; not enabled by default before the target official Endpoint is confirmed.
- Request accepting a field, ignoring content, or not erroring does not equal the model consuming that input, nor constitutes capability evidence.
- "JSON Output" or JSON Object does not equal strict JSON Schema; the current field `supportsJsonSchemaOutput` is only enabled on proven strict Schema lines; the field rename was completed by Todo74 inheriting from Todo39.

## 2. Vendor Conclusion Matrix

| Vendor                  | Current Flagship/Unique Models                                    | Key Official Facts                                                                                     | Default Enabled This Round | Main Conservative Items                                                                          |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| GLM / Z.ai / BigModel   | `glm-5.3`, `glm-5.3-flash`, `glm-5v-turbo`                        | 5.3 is text flagship; 5.3 Flash native Text/Image/Video; 1M context, 128K output                        | All three                  | Regular Account API 5.3 does not declare vision; old 5.x/4.x default off                           |
| Coding Plan             | `GLM-5.3`, `GLM-5.3-Flash`, `GLM-5.2`, `GLM-5-Turbo`             | Individual/Team static members; Plan service provides Image/Video transcription for members              | All four                   | Does not infer Audio/PDF; Start still constrained by account-returned members                      |
| Kimi                    | `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`                          | K3 1M with Image/Video; K2.7 Code 256K with Image/Video; K2.6 256K with Text/Image/Video               | All three                  | `k3` supports Image/Video; `k3-256k` only Image; aliases and old K2.x/Moonshot V1 default off       |
| MiniMax                 | `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`            | M3 current latest flagship, 1M, Text/Image/Video, explicitly supports China region Anthropic/OpenAI Endpoints; M2.7 is 204800 | All three                  | M3 max output still conservative; Models API documentation examples are not real-time member lists |
| DeepSeek                | `deepseek-v4-flash`, `deepseek-v4-pro`                            | 1M context, 384K output, Text, Tool; supports Anthropic/ChatCompletions; new Pro/Flash supports low/high/max | Both                       | JSON Output does not diffuse to strict Schema; Responses strict Schema handled per API/Endpoint    |
| Qwen                    | `qwen3.8-max`, `qwen3.8-flash`                                    | 1M context, 131072 output, Text/Image/Video, Tool; both support strict JSON Schema                       | Both                       | Old 3.5/3.x retained but default off; native search does not equal app-side auto-enabling          |
| MiMo                    | `mimo-v2.5-pro`, `mimo-v2.5`                                      | Both 1M/128K; Pro is text; v2.5 supports Image/Video/Audio; old v2 series retired                       | Both                       | Structured output first conservative per current protocol; Audio only enters static facts          |
| OpenAI                  | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`                   | Three tiers 1.05M/128K, Text/Image, Tools, strict output; `gpt-5.6` is Sol alias                         | Three real IDs             | Aliases and old Codex default off, avoiding duplicate entry points                                 |
| Anthropic               | Fable 5, Opus 5, Sonnet 5, Haiku 4.5                              | All Text/Image/Tool; first three 1M/128K, Haiku 200K/64K                                                | Four unique tiers          | PDF is Messages API documentation capability, retaining current facts; no diffusion of Video/Audio  |
| xAI                     | `grok-4.6`, `grok-build-0.1`                                      | 4.6 is Text/Image, 500K, Tool, strict output; Build is 256K coding tier                                 | Both                       | `grok-4.3` default off                                                                           |

## 3. Account and Plan Vision Boundaries

Regular Account API and Coding Plan must be separated:

```text
Regular Account API + glm-5.3
└─ Native Text; Image/Video=false

Regular Account API + glm-5.3-flash
└─ Native Text/Image/Video

Start / Individual / Team Plan
└─ Provider service provides Image/Video transcription for actual members
```

Regular Account API accepting image-carrying requests without error only means the server tolerates or ignores the content, not that `glm-5.3` has vision capabilities. Therefore this round keeps its native vision capability as `false`. The Plan's vision capability comes from the ZCode product chain, an independent Provider service fact.

## 4. This Round's Provider Members and Initial Order

The physical order of `builtinModelIds` follows "default enabled first, default disabled last." This is only the initial order of release files; no runtime sorter is added, and user-draged Personal `modelOrder` remains the user order fact.

- GLM API: 5.3, 5.3 Flash, 5V Turbo first, remaining historical members later.
- Individual/Team: 5.3, 5.3 Flash, 5.2, 5-Turbo.
- Kimi: K3, K2.7 Code, K2.6 first.
- MiniMax: M3 first; M2.7, M2.7 Highspeed as still-normal service speed tiers following, all three default enabled.
- Qwen: China and international Providers both start with 3.8 Max, 3.8 Flash.
- MiMo: 2.5 Pro, 2.5 first.
- OpenAI: Sol, Terra, Luna first, aliases and old models later.
- Anthropic: All four unique price/speed tiers enabled.
- xAI: 4.6, Build first, 4.3 later.

## 5. Official Materials

- GLM: [Model Overview](https://docs.bigmodel.cn/cn/guide/start/model-overview)
- Kimi: [API Model Selection](https://www.kimi.ai/help/kimi-api/api-model-selection), [K3 Release Notes](https://www.kimi.com/news/kimi-k3), [K2.7 Code Model Description](https://www.kimi.ai/resources/kimi-k2-7-code), [Kimi Code Model Table](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- MiniMax: [Model Calling](https://platform.minimaxi.com/docs/guides/text-generation), [Anthropic Models API](https://platform.minimaxi.com/docs/api-reference/models/anthropic/list-models), [OpenAI Models API](https://platform.minimaxi.com/docs/api-reference/models/openai/list-models)
- DeepSeek: [Models and Pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Update Log](https://api-docs.deepseek.com/updates/), [Responses API](https://api-docs.deepseek.com/api/create-response/)
- Qwen: [Qwen3.8 Max](https://help.aliyun.com/en/model-studio/qwen3-8-max), [Qwen3.8 Flash](https://help.aliyun.com/en/model-studio/qwen3-8-flash), [Structured Output](https://help.aliyun.com/en/model-studio/qwen-structured-output)
- MiMo: [Model Overview](https://mimo.mi.com/docs/en-US/quick-start/model), [Audio Understanding](https://mimo.mi.com/docs/en-US/usage-guide/multimodal-understanding/audio-understanding)
- OpenAI: [Models](https://developers.openai.com/api/docs/models)
- Anthropic: [Models Overview](https://platform.claude.com/docs/en/models/overview)
- xAI: [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6), [Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)

## 6. Known Imperfections and Next-Round Verification

This round's goal is to form a more credible release baseline than revision 3, and does not claim completion of Endpoint real-tests with real access materials. Subsequent model verification APIs should first call vendor Models APIs, then verify capabilities not provided by the interface:

1. Model lists, aliases, and optional capability metadata for each real Endpoint with current access materials;
2. Tools, reasoning, MCS, and strict JSON Schema under three API Schemas;
3. Whether Image/Video/Audio/PDF are truly consumed, not merely accepted or ignored;
4. Max output, default reasoning tiers, and server-side limitations;
5. Automatic reporting when official documentation and account product interfaces drift.

OpenAI-compatible Models APIs usually return only basic identity; Anthropic's official Models API can currently additionally return token limits, Image/PDF, Thinking, Effort, and Structured Outputs capabilities. Third-party compatible services may implement only subsets; parsing and evidence acceptance must proceed by actual fields, not by protocol name completion.

## 7. 2026-09-01 Kimi Evidence Correction

This round's review found that revision 4 refreshes treated "summary did not record multimodal" as "does not support," and subsequent configs continued this error. Current official materials have made clear:

- Kimi API model selection page declares `kimi-k3` has native vision understanding; K3 release materials further clarify native architecture understanding of text, images, and video;
- Kimi K2.7 Code official FAQ explicitly declares Text, Image, Video input;
- Kimi Code model table declares `k3` supports Image/Video, while `k3-256k` only supports Image.

Therefore revision 7 corrects these three facts. Future capability downgrades from already-released `true` to `false` must have clear negative evidence or reproducible request results, and can no longer use material absence as justification.
