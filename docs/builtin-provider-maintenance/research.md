# Research Tracking and Findings

This page keeps the initial research and the ongoing tracking method. The later [2026-10-14 full expansion plan](./expansion-plan.md) adds public Models API reconciliation, actual rule resolution, new vendor and plan candidates, the MiniMax migration deadline and batch implementation suggestions; it marks which conclusions replace unverified items of the initial research.

New-addition authorization, discussion of existing changes and protocol postponement follow the [current scope principles](./scope.md#authorization-boundary-for-additions-and-existing-changes); to-be-confirmed descriptions in the initial research do not override later confirmed principles.

## Ongoing tracking method

Maintainers track new releases, interface changes, alias redirects, plan catalogs, retirement notices and cost/limit changes together. News, official social accounts and community feedback are used to find leads; final configuration is based on official API docs, concrete product catalogs, the Models API and real requests. A marketing name cannot be converted directly into a model ID.

Suggested rhythm: browse the official change and retirement pages of maintained vendors weekly and re-check scope and items to validate monthly; a major new model, parameter incompatibility or retirement notice triggers an immediate investigation. Each time record the check date, the source's own publication date and effective date; if no publication date can be found write "unmarked" and do not use the crawl date instead. This defines only the manual maintenance rhythm; no scheduled task or automated news ingestion is installed.

Source comparison is per "entry x model ID x protocol". A Models API may be filtered by account, region and plan; appearing does not mean all capabilities are usable, and absence alone cannot prove global retirement. On a conflict first keep the original link, time and a minimal redacted response, mark it to be confirmed, and do not change configuration from search snippets.

## Official source entries

These are the retrieval entries of 2026-10-14; "readable" only means the body was obtained, not that real calls passed. When continuing maintenance, enter the latest release, retirement, protocol and key pages from these and re-check redirects.

| Vendor/entry | Official source | Reading status this round and use |
| --- | --- | --- |
| Z.AI | [Model catalog](https://docs.z.ai/guides/overview/overview) | readable; model and capability entry, ordinary API and plans checked separately |
| BigModel | [Official docs](https://docs.bigmodel.cn/) | fetch timed out this round; browse or retry manually, and do not apply the Z.AI conclusion directly |
| Kimi | [Open platform docs](https://platform.kimi.com/docs/get-api-key) | old Moonshot docs redirect here; check keys and product entries |
| MiniMax | [Model release notes](https://platform.minimax.cn/docs/release-notes/models) | readable; the original minimaxi docs redirect; distinguish language and audio/video generation models |
| DeepSeek | [Change log](https://api-docs.deepseek.com/updates/?release=deepseek-coder) | the catalog fetch without query timed out; this official page is readable and contains alias routing changes |
| Qwen / Bailian | [Model catalog](https://help.aliyun.com/zh/model-studio/models) | readable; domestic/international products and protocols still need separate confirmation |
| MiMo | [Token Plan guide](https://mimo.mi.com/docs/tokenplan/subscription), [Access guide](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access), [Anthropic API](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api) | the main site is a dynamic page; search can obtain the official guide body; exact plan models continue to need manual/key validation |
| OpenAI | [Model catalog](https://developers.openai.com/api/docs/models), [Changelog](https://developers.openai.com/api/docs/changelog) | readable; watch concrete API IDs, protocols, thinking parameters and retirement pages |
| Anthropic | [Model catalog](https://platform.claude.com/docs/en/models/overview) | readable; provides model IDs, capabilities, Models API and retirement entry |
| xAI | [Model catalog](https://docs.x.ai/developers/models) | readable; check Responses and streaming protocol differences |
| OpenRouter | [Model description](https://openrouter.ai/docs/guides/overview/models) | readable; next, validate separately by the actual catalog intersection and routing |
| OpenCode | [Models / former Zen docs](https://opencode.ai/v2/docs/console/models/), [Go](https://opencode.ai/v2/docs/console/go/) | old docs redirect to the new version; endpoints and product catalogs must be re-verified |
| Google Gemini (watch) | [Model catalog](https://ai.google.dev/gemini-api/docs/models) | readable; native protocol, compatible entry and current Adapter capability investigated separately |
| Mistral (watch) | [Model catalog](https://docs.mistral.ai/models) | readable; contains general/code models, lifecycle and the retirement table |

## 2026-10-14 comparison results

The initial research baseline is staging `5e74234f498c` / revision 32. The table keeps the external evidence of that time, and the repository follow-up state is added where there was a clear change; the current inventory baseline has been updated to `68fac8de4fcc` / revision 33. Observation is not automatic integration authorization; this round obtained no vendor key, made no billable model API call and read no private post-login catalog. "Doc readable" has not been upgraded to "endpoint accepted".

| Item | Official evidence and event time | Difference from the repository / next step | State |
| --- | --- | --- | --- |
| OpenAI new models | The catalog lists `gpt-6.1-sol` and `gpt-6-luna`; the Changelog states the former was released 2026-09-29 | The `openai` template does not list these two IDs. Check whether the Responses tool loop, levels and aggregating entries provide them in sync; do not enable other new features in passing | source confirmed, to validate |
| Anthropic current series | The catalog lists `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; the catalog marks no unified release date | The current template is still Opus/Sonnet 5 and Haiku 4.5 etc. Check per model whether thinking can be turned off, effort, output and history replay; do not just inherit brand rules | source confirmed, to validate |
| Z.AI FlashX | The catalog lists GLM-5.3-FlashX; release date unmarked | The current ordinary template does not list the ID. Check the real API ID, ordinary/plan availability and the difference from Flash; BigModel gets separate evidence | source confirmed, to validate |
| xAI Grok 4.7 | The official model page states `grok-4.7` and describes the encrypted reasoning content behavior of Responses; release date unmarked | The current template has 4.6 etc. Request/response evidence is needed; do not just append the model and capacity | source confirmed, to validate |
| DeepSeek alias | The official change page says `deepseek-flash` points to V4.1 Flash, the old V4 Flash ID is temporarily forwarded; V4 Pro continues to be served after 2026-09-14 | The current official template already uses `deepseek-flash`; check vision capability and old IDs in aggregating entries, do not treat old-ID forwarding as a permanent promise, and do not mechanically delete V4 Pro | alias/retirement re-check |
| MiMo products and models | The official guides distinguish an ordinary API Key from a Token Plan dedicated Key/endpoint; a new integration example shows `mimo-v2.6-pro`; the event date of the queried material is not uniformly marked | At investigation only the V2.5 ordinary template existed; on 2026-10-14 staging merged the two templates and V2.6 Pro/Flash (revision 33). The Token Plan uses `https://token-plan-cn.xiaomimimo.com/anthropic`; members and default enablement are in the [current state](./current-state.md#xiaomi-mimo) | configuration implemented; real key and online adoption not verified this round |
| OpenCode endpoint and catalog | The new Models/Go pages list `/inference/v1/models` and `/inference/go/v1/models` separately, and the Go list adds several new series; migration effective date unmarked | The current templates are still `/zen/v1`, `/zen/go/v1`. First confirm whether the old endpoints stay compatible, the real IDs and per-protocol paths; a redirect does not mean the old API has stopped | verify first, do not replace the URL directly |
| Gemini | The official catalog includes 3.8 Flash, 3.5 Flash-Lite etc.; the audio/image generation catalog is not mixed into ordinary Agent templates | No built-in native template. First decide the native or compatible entry plan and authentication/tool support, then propose the integration design | scope watch / to design |
| Mistral | The official catalog lists Large 4, Small 4 etc., with separate code and retirement catalogs; Large 4 is marked v26.10 | No built-in template. Evaluate the concrete Agent-suited models, protocol and key; completion/Embedding models must not be treated as chat models | scope watch / to design |

The initial research did not complete Models API reconciliation of each entry nor re-investigate the cloud entry protocols. The later [expansion plan](./expansion-plan.md) completed the OpenRouter / OpenCode public catalog comparison and checked the official material for Azure v1, Bedrock Responses, Ark plans and TokenHub; other post-login catalogs and billable calls are still unverified. One must not conclude from this that "all vendors have caught up with the latest models".

## Source archive and next check

This directory already folds in the rationale for mainstream scope, official-first, product entry split, rule layering and the capacity baseline, in the [scope principles](./scope.md) and the [configuration spec](./configuration.md) respectively. The matching and capacity simplification of revision 32 and the MiMo two-product entries of revision 33 have landed; implementation, real API validation and online adoption are recorded separately. The inventory and implementation are verified against code; historical records are not a client catalog source and not a prerequisite for reading this directory.

Each observation entering implementation adds spec, state and acceptance per this directory's [maintenance workflow](./workflow.md); Issues are not filed remotely. Record the product owner, maintainer, validation collaborator, check date, next step and blocker. When done, update the result into the current state and keep this dated research evidence, without rewriting historical text as verified today.

When a new vendor is added, add official sources per the scope principles and periodically check dead links, cross-site redirects and source permissions. Community opinion, leaderboards and third-party catalogs in search results cannot become a runtime configuration source and cannot automatically raise default enablement.
