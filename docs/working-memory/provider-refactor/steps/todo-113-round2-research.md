# Todo113 Round 2: Official Facts and Implementation Rulings

Checked 2026-09-11. Implementation baseline revision 21 (includes Todo126), not the revision 19 of the first survey. Run
under the user's batch authorization; Round 1 results are not a substitute for Round 2 acceptance.

> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-113-round2-research.md`

## Conclusion and Scope

General config follows vendor specs; aggregator-gateway capacity and protocol differences go in site rules; personal
config, history selections and running Models are untouched. A vendor retirement removes only that template member and its
exact default rule, keeping the old model's generic matching for personal and third-party use. Newly filled members are
disabled by default; mainstream models and their order are kept; a catalog gap fill does not change the user's default selection.

| Model                    | Official fact -> current gap -> implementation                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.4 / Pro            | 1,050,000 context / 128,000 output; base none/low/medium/high/xhigh, Pro only medium/high/xhigh, vendor Pro Responses-only [1]. Previously unknown config; add vendor, aggregator-prefix and snapshot rules; vendor and OpenRouter get all four, Zen's existing four stay disabled. Image/PDF, tools and Schema follow the corresponding API; no extension to other 5.x or image-generation variants |
| GPT-5.4 Mini / Nano      | 400,000 / 128,000 each; none/low/medium/high/xhigh, image input, text output [2]. Separate rules; they must not inherit the base capacity                                                                                                                                                                                                                                |
| DeepSeek V4.1 Flash      | vendor `deepseek-flash`, 1M/384K, vision, can be turned off, low/high/max; the old vendor V4 Flash is a retired alias route and the new notice states V4 Pro keeps serving [3]. Vendor keeps Flash/Pro and drops the old Flash catalog entry. OpenRouter `deepseek/deepseek-v4.1-flash` is 1,048,576/384,000, so a site override sets capacity and its unified reasoning/structured-output protocol is used; third-party old V4 Flash unchanged |
| Qwen3.7 Max              | Beijing and international, 1,000,000/131,072, hybrid thinking. The default ID equals the 2026-05-20 snapshot and is **text-only**; the 2026-06-08 snapshot adds image/video [4]. Add catalog, generic rule and exact vision snapshot rules; do not make the whole family vision                                                                                            |
| Qwen3.7 Plus / Flash     | both 1,000,000/131,072, text/image/video, hybrid thinking; Plus supports strict Schema; Flash's "structured output" does not equal Chat JSON Schema [5]. Separate configs; OpenRouter Flash currently caps output at 65,536 and Plus currently does not advertise video, so gateway-scoped rules rather than changing vendor capability                                      |
| Qwen3.6 Plus / Flash     | both 1,000,000/65,536, text/image/video, hybrid thinking; the thinking-chain limit is not maxOutputTokens (81,920/131,072 must not become the output cap) [6]. Add Beijing/international catalog and protocol mapping; Chat strict Schema not on by default                                                                                                                  |
| Qwen3.8 Omni Flash       | the model page search index lists 65,536/16,384, text/image/audio/video input, text-only output, none/minimal/low/medium/high/xhigh/max, no search/Schema; Beijing and Singapore list quotas [7]. The page currently redirects to the old Omni guide and Messages support is unproven. Add verifiable generic and Chat/Responses config and the international Chat template; the Beijing template defaults to Messages and **the Provider protocol is not changed just to add the catalog entry**, so its catalog entry is pending confirmation |
| Kimi K2.7 Code Highspeed | officially the same model as ordinary Code, 256K, faster output. Code does not allow turning thinking off, so the existing disabled/enabled value range is wrong [8]. Add the vendor high-speed member (disabled), narrow the shared Code value range to enabled, K2.6 unchanged; keep the existing 98,304 output cap (the current quickstart gives only a 32K default, which is not taken as a hard cap) |
| Kimi / MiMo retirement   | K2.5 and the whole moonshot-v1 line retired 8/31; MiMo v2-pro/omni/flash retired 6/30 [9]. Remove only the vendor catalog entries and paired exact rules; the K3 short alias has no explicit retirement evidence and stays default-disabled                                                                                                                              |
| MiMo UltraSpeed          | the 9/8 announcement says at the top that the beta ended and the commercial version is pending; the old trial text below is not availability evidence [10]. Not added; the existing generic Pro-suffix config is not deleted                                                                                                                                                |

## Aggregator Check per Model

OpenRouter `/api/v1/models` and Zen `/zen/v1/models` were actually read (both HTTP 200) and the Zen endpoint docs checked
[11]. An API listing proves supply, not that any Key has permission.

| Model / check                          | OpenRouter                                                            | OpenCode Zen                                                                                    | Bailian third-party                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.4 four models                    | `openai/gpt-5.4{,-pro,-mini,-nano}` all listed; Messages/Chat gateway conversion | all four listed, Responses                                                                 | unconfirmed, not guessed                                                                                                                                             |
| GPT-6 Astra / Fable 5.1                | `openai/gpt-6-astra`, `anthropic/claude-fable-5.1` both listed        | original IDs both listed, Responses / Messages respectively                                     | unconfirmed                                                                                                                                                          |
| DS V4.1 Flash                          | `deepseek/deepseek-v4.1-flash` listed                                 | not listed in this API/docs, ID not guessed                                                     | new Flash unconfirmed; old V4 Pro/Flash is not evidence of new-version supply                                                                                        |
| Qwen3.7 Max/Plus/Flash, 3.6 Plus/Flash | all five `qwen/` IDs listed, existing members kept                    | API lists only 3.6 Plus now; existing 3.7 Max/Plus have no explicit retirement evidence, so the disabled members stay (not deleted for one absence) | added after vendor verification in both regions                                                                                                                      |
| Qwen3.8 Omni                           | not listed                                                            | not listed                                                                                      | vendor as above, Messages pending                                                                                                                                    |
| Kimi Code Highspeed                    | not listed                                                            | not listed                                                                                      | officially lists `kimi/kimi-k2.7-code-highspeed`, but the guide only confirms Chat, images only as public URL; the Beijing template defaults to Messages and local attachments are Base64; "model exists" is not written as fully executable in the current template (adaptation limit kept) [12] |
| MiMo UltraSpeed                        | not listed                                                            | not listed                                                                                      | unconfirmed                                                                                                                                                          |
| Qwen3.8 Max snapshot                   | lists `qwen/qwen3.8-max-0902`; the undated ID was not listed this time | not listed                                                                                      | vendor 0902/2026-09-02 alias rules already cover it; snapshots are not batch-listed. OR adds the verified snapshot (disabled); the original member has no retirement evidence and is not deleted |

## Other Mainstream Models and Boundary Review

- Fable 5.1 is still 1M/128K, always Adaptive, low/medium/high/xhigh/max; vendor and both aggregators list it; the
  Round 1 rules and tool constraints keep being verified [13].
- GPT-6 Astra is still 1,050,000/128,000; tool use follows Responses and the existing vendor/Zen templates are Responses.
  OpenRouter's Messages is its conversion service, and the gateway is not turned off by vendor limits [14].
- MiniMax mainstream is still M3 and xAI Grok 4.6; no stable same-period text model to add was found; no extension to
  audio/video generation products [15].
- The four GLM manual templates and the account catalog keep Todo126's Flash PDF, GLM-5.3 bridge label and Turbo default
  rulings; the account list is untouched.
- The new catalog does not guarantee that previously saved invalid levels keep executing, and does not migrate or clear
  those selections; capacity display does not depend on execution validation passing (Todo123).
- OpenRouter Qwen3.8 Max 0902 offers minimal/low/medium/high/xhigh and 3.6 Plus/Flash explicitly support Schema, as site
  overrides only, not extended to the vendor. The GPT-6 Astra Pro aggregator variant involves the separate semantics of
  `reasoning.mode`; the existing Astra effort config is not passed off as adapted, left for independent confirmation.

```text
official/aggregator facts -> Built-in Model / API / Site / template defaults -> Personal-first merge
  -> shared Registry -> all selectors -> new execution objects read the new config; existing execution objects stay frozen
```

## Implementation Acceptance

SDK discriminating tests found an existing missed wiring: the OpenAI Compatible `supportsStructuredOutputs` was not
assembled and defaulted to false, so requests whose config allows Schema were downgraded by the SDK to JSON object. The
minimal fix freezes the Model's `supportsJsonSchemaOutput` at bind time and passes it to the SDK factory, with no Provider
special case or protocol field. Tests cover supported/unsupported, existing Model freezing and new-Model config taking
effect.

Gap-reproduction tests first; after the config edit verify each added model's full resolution, alias/neighbor negatives,
gateway differences, exact default members and Personal priority; real SDK capture of three-protocol requests for
reasoning / limit / tools / media. Final file revision 22 with the release-integrity gate rerun. Real paid endpoints
without credentials are not claimed as passed; desktop/phone shared reading is recorded in the whole-batch acceptance.

## Sources (all official, checked on the same day)

[1]: https://developers.openai.com/api/docs/models/gpt-5.4
[2]: https://developers.openai.com/api/docs/models/gpt-5.4-mini
[3]: https://api-docs.deepseek.com/updates/
[4]: https://help.aliyun.com/zh/model-studio/qwen3-7-max
[5]: https://help.aliyun.com/zh/model-studio/qwen3-7-plus
[6]: https://help.aliyun.com/zh/model-studio/qwen3-6-plus
[7]: https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash
[8]: https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart
[9]: https://mimo.mi.com/docs/zh-CN/updates/deprecate
[10]: https://mimo.mi.com/docs/en-US/news/latest/beta-extended
[11]: https://opencode.ai/docs/zen/
[12]: https://help.aliyun.com/zh/model-studio/kimi-api-by-moonshot-ai
[13]: https://platform.claude.com/docs/en/models/fable-5-1/overview
[14]: https://developers.openai.com/api/docs/models/gpt-6-astra
[15]: https://docs.x.ai/developers/models

Supplementary per-variant / protocol sources: [GPT5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro), [Nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano), [Qwen3.7 Flash](https://help.aliyun.com/zh/model-studio/qwen3-7-flash), [Qwen3.6 Flash](https://help.aliyun.com/zh/model-studio/qwen3-6-flash), [Thinking mode](https://help.aliyun.com/zh/model-studio/deep-thinking), [Chat Schema support list](https://help.aliyun.com/en/model-studio/qwen-structured-output), [Messages extension](https://help.aliyun.com/zh/model-studio/anthropic-api-messages), [Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses), [Kimi retirement](https://platform.kimi.com/docs/models), [MiniMax](https://platform.minimax.io/docs/guides/models-intro), [OpenRouter model facts](https://openrouter.ai/api/v1/models), [OpenRouter Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages), [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
