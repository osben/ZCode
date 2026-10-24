# Todo 113: Recent New Model Catalog and Smart Config Update

> Status: **Round 2 implementation, local and whole-batch code review and local tests complete; real multi-end
> acceptance limits remain.** The user authorized the Round 2 Goal on 2026-09-11. Per-model official facts, aggregator
> differences and unconfirmed supply: [Round 2 research and rulings](./todo-113-round2-research.md); final evidence:
> [whole-batch review](./provider-stabilization-20260911-final-review.md). Unconfirmed Omni Beijing Messages, Bailian
> Kimi high-speed attachment/protocol and MiMo UltraSpeed commercial availability are not guessed into the catalog.
>
> Round 1 (2026-09-10) finished three official new models plus verified aggregator members and real-SDK request
> verification ([delivery review](./provider-todos-105-113-delivery-review.md)). Sections 1-4 below keep the Round 1
> record; Round 2 execution follows section 0.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-113-new-model-catalog-refresh.md`

## 0. Round 2: Catalog Gap Fill, Config Deep Check and Retirement Cleanup (2026-09-11)

### 0.1 Confirmed Principles

- **Retired models are removed directly from the corresponding provider's built-in model list**, not just kept disabled by
  default, together with their template exact rules. A vendor retirement is not assumed to retire third-party hosting;
  each access path is judged by its own facts.
- Not only names: the smart config must be supplied or corrected too. Template lists, template exact default rules,
  generic model matching and API/site mapping are checked together, so no model is "in the list but resolves to the
  unknown-model default config" (including when added manually).
- **Every new model is checked against the existing aggregators**, including a recheck of Round 1 models; only an official
  confirmation of concrete ID, protocol and service status adds it to an aggregator template.
- Already-decided models and conclusions are deep-researched again at execution; the survey fixed gaps and direction, not
  final parameters, protocols or request/regression acceptance. Unconfirmed details are verified rather than guessed;
  a product-semantics change, default-selection change or adapter-architecture extension is raised with a concrete question.

### 0.2 Baseline and Concrete Gaps

Surveyed at builtin revision 19 (no difference from the then-latest `origin/staging` for Provider config and
implementation); recheck the latest baseline at execution.

| Object                                                   | Confirmed state                                                                                                                                                               | Change                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vendor `deepseek-flash`                                  | added in Round 1; official ID is V4.1 Flash                                                                                                                                   | recheck vendor capacity, vision and three-protocol mapping; no re-add                                                                                                                             |
| `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`, `gpt-5.4-nano` | all four in the OpenCode Responses list with template exact rules only `enabled: false`; no generic model rule; vendor and prefixed aggregator access get no dedicated config | research each spec; add context, max output, input capability, tool/structured output, valid reasoning levels and per-access mapping; never apply GPT-5.6 wholesale, and do not enable by default |
| OpenRouter `deepseek/deepseek-v4.1-flash`                | listed officially; template lacks the member and the ID matches neither vendor `deepseek-flash` nor the old V4 Flash rule                                                     | add the OpenRouter member and exact default rule, V4.1 Flash name matching and the real OpenRouter protocol mapping; do not turn V4 Pro / old third-party V4 Flash into V4.1                      |
| `qwen3.8-omni-flash`                                     | official Bailian model; both Bailian templates and dedicated config lack it                                                                                                   | add per-region to Bailian templates; research capacity, text/image/audio/video input, text output, tools, structured output, reasoning levels separately from ordinary 3.8 Flash                  |
| `qwen3.7-max`, `qwen3.7-plus`, `qwen3.7-flash`           | some OpenRouter/OpenCode templates have the members but generic smart config is missing; vendor Bailian templates lack them                                                   | check Beijing/international availability, add to the vendor catalog with dedicated model and protocol rules; fix aggregator members                                                               |
| `qwen3.6-plus`, `qwen3.6-flash`                          | same: aggregator members present, dedicated config missing                                                                                                                    | per-region vendor catalog and smart config; check aggregator members; research separately from 3.7                                                                                                |
| `kimi-k2.7-code-highspeed`                               | offered by Kimi; vendor template lacks it; the suffix match currently inherits K2.7 Code config                                                                               | add the vendor member and default rule; compare parameters/capability/protocol with the base and keep shared rules if reusable; check aggregators                                                 |
| `qwen3.8-max-0902`, `qwen3.8-max-2026-09-02`             | official snapshot/alias exists; manual add hits the 3.8 Max rule                                                                                                              | recheck snapshot differences and alias semantics; whether to list them follows current policy; "not listed" is not "missing smart config"                                                         |
| `mimo-v2.5-pro-ultraspeed`                               | the announcement keeps old trial content while the top says the beta ended and the commercial version is pending; the suffix match yields the Pro config                      | confirm commercial availability, real ID and own parameters; not added to the official presets until confirmed                                                                                    |

Resolution evidence: OpenRouter V4.1 Flash, Qwen3.8 Omni Flash and the five Qwen3.7 / 3.6 models all resolved to `200000`
context, `32000` max output, vision off, only the `disabled` level. Kimi high-speed and MiMo UltraSpeed match their base
rules but identical configuration is unproven. GPT-5.4 (vendor `gpt-5.4`, OpenCode `gpt-5.4`, OpenRouter
`openai/gpt-5.4`, and vendor Pro/Mini/Nano) resolved to `200000` / `32000`, image off, levels only `disabled`: generic API
parameter mapping is still inherited but model-specific capability and value ranges are missing (a config gap, not a page
display problem). Which variants each aggregator really supports is verified individually; resolving a prefixed ID does
not mean the platform lists it.

### 0.3 Per-Template Built-in List Plan

Edit source: `config/provider/zcode-builtin.json` `providerConfigRules.templateRules[].config.builtinModelIds`, checking
`modelConfigRules.templateModelRules` alongside. Ordering and default enablement of new members follow current template
policy ("officially offered" is not "enabled by default"); undecidable cases are discussed at execution.

| Template ID                                                            | List change and kept boundary                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek`                                                             | keep `deepseek-flash`, `deepseek-v4-pro`; remove the retired vendor `deepseek-v4-flash` and its exact rule; `deepseek-v4-flash-vision-exp` is not added if still unlisted (removed per the retirement notice if listed)                                                                                                     |
| `moonshot-kimi`                                                        | add `kimi-k2.7-code-highspeed`; remove `kimi-k2.5`, `moonshot-v1-8k`, `moonshot-v1-32k`, `moonshot-v1-128k` and the three `moonshot-v1-*-vision-preview`; keep K3 / K2.7 Code / K2.6; the `k3`, `k3-256k` aliases are handled after verifying service and semantics (not retired merely because one page omits them)        |
| `xiaomi-mimo`                                                          | keep V2.5 Pro / V2.5; remove the confirmed-retired `mimo-v2-pro`, `mimo-v2-omni`; `mimo-v2-flash` is removed once the V2 retirement notice's endpoint destination is verified; UltraSpeed only after commercial availability and parameters are verified                                                                    |
| `qwen-alibaba-model-studio-cn`, `qwen-alibaba-model-studio-intl`       | per region verify and add `qwen3.8-omni-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.7-flash`, `qwen3.6-plus`, `qwen3.6-flash`; keep models still in service; 3.8 Max snapshot listing decided at research; the Beijing catalog is not unconditionally copied to international                                             |
| `openrouter`                                                           | add `deepseek/deepseek-v4.1-flash`; keep the five Qwen3.7 / 3.6 prefixed IDs and complete their config; verify exact prefixed IDs, supply status and protocol of new Omni, high-speed and other new models; vendor retirement does not directly remove aggregator members                                                   |
| `opencode-zen-responses`, `opencode-zen-messages`, `opencode-zen-chat` | for every new model check the Zen official catalog/model API and place by real Endpoint; check Qwen3.7 Max/Plus and 3.6 Plus config and missing models; new DeepSeek/Omni/Kimi high-speed IDs are not guessed or borrowed from vendor/OpenRouter                                                                            |
| `openai`                                                               | keep GPT-6 Astra and mainstream; add generic smart config for the four GPT-5.4 models, verify vendor service status, then decide built-in member backfill, order and default enablement by current policy; manual-add config support is not skipped just because the template omits them; GPT-5.6 parameters are not copied |
| `anthropic`                                                            | keep Round 1 Fable 5.1 and mainstream; deep recheck of exact ID, context/output, levels and request compatibility; check for stable new official models                                                                                                                                                                     |
| `minimax`, `xai`                                                       | MiniMax-M3 and Grok-4.6 already listed; keep checking for new models/variants/config changes, no list change without reliable facts                                                                                                                                                                                         |
| `zai-api`, `bigmodel-api`, `zai-standard-api`, `bigmodel-standard-api` | do not repeat [Todo126](./todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md)'s Flash PDF / plan API Turbo defaults; GLM-4.7 vision stays per ruling; include only independent new-model or retirement facts, stating the boundary with Todo126                                                                       |

**"Remove" means removing from the provider's built-in supply catalog, not clearing personal config or migrating user
history.** Saved ModelSelection, messages, statistics and running bindings are not rewritten. Model capability rules of old
aliases that personal config, aggregator access or vendor-compatible routes still use are kept (not deleted wholesale with
the catalog); retired vendor models and still-supplied third-party old versions are treated differently.

GPT-5.4 aggregators: OpenCode Responses already has all four (keep default-disabled; add resolution config and request
mapping only, no re-add). OpenRouter and similar aggregators are verified variant by variant for exact ID, status and API;
confirmed ones get the missing member and paired exact rule, covering real prefixed forms like `openai/gpt-5.4`. Variants
are verified separately; Pro/Mini/Nano or other GPT versions must not match as base 5.4.

### 0.4 Deep Research Required at Execution

Each added or corrected model gets a short "official fact -> current resolution -> final change" record with source URL,
check date and unconfirmed items, not copied from the survey summary nor inferred from the base version.

- Identity and service status: exact vendor ID, snapshot/alias, public stable vs trial, domestic/international supply,
  retirement and redirects; similarly named models are not conflated.
- Capacity and capability: context and output separately (with K/M units and whether thinking budget counts apart);
  image/video/audio/PDF, tool calling, JSON Schema constrained output, MCS and native search separately. Ordinary JSON
  output is not Schema-constrained output; a file upload/extraction API is not native model PDF.
- Options and protocols: valid reasoning levels, whether off is allowed, order, CEL Map and real request fields; Messages /
  Chat Completions / Responses checked per supported protocol; raw vendor fields are not written as SDK config fields.
- Layering: general model capability -> Model; protocol differences -> Model+API; endpoint enhancement and aggregator
  conversion -> Site; catalog default enable -> template exact rules; Personal keeps its priority. No broad regex lets a
  new model override old models, other variants or account products.
- Aggregators must be checked: at least OpenRouter and OpenCode Zen; Bailian's third-party catalog for applicable members.
  Each new model records "supported (exact ID / Endpoint) / not listed officially / trial or restricted / insufficient
  evidence" (the last two are not claimed as support); "a base version exists" does not prove a high-speed or newer
  version is listed.
- Request verification: final Resolver config and real SDK serialized requests; public specs, gateway conversion and the
  Adapter's actual capability are evidenced separately; issues config cannot express get a minimal concrete proposal, not
  broad Runtime work.

Specific points: OpenRouter V4.1 Flash shows `1,048,576` context while the vendor doc says 1M (units checked before
merging); Qwen3.8 Omni's capacity differs from other 3.8 models (not 1M); Qwen3.7 / 3.6 reasoning mappings and snapshot
vision changes are checked separately; Kimi high-speed inheritance and MiMo UltraSpeed suffix hits are current code facts,
not official equivalence.

### 0.5 Official Facts and Evidence (checked 2026-09-11; recheck at execution)

- DeepSeek updates and model specs (`api-docs.deepseek.com`): V4.1 Flash vendor ID `deepseek-flash`; old V4 Flash / Vision
  Exp retired but the old vendor name temporarily routes to the new Flash; **V4 Pro continues after Sep 14 at the original
  price. The old plan "Pro switches to Flash on Sep 14" is superseded by the latest notice and is not executed.**
- OpenRouter V4.1 Flash page: exact aggregator ID, vision, capacity and output notes.
- Bailian pages for Qwen3.8 Omni Flash, the Omni guide, the text-model catalog, new-release listing, Qwen3.7 Plus/Flash and
  Qwen3.6 Plus/Flash (`help.aliyun.com/zh/model-studio`): catalog, region and config-gap basis; watch redirects and shared
  series notes.
- Kimi official model list and K2.7 Code quickstart (`platform.kimi.com/docs`): high-speed offered; K2.5 / moonshot-v1
  retired on Aug 31.
- MiMo latest announcement and token-plan FAQ (`mimo.mi.com/docs`): UltraSpeed commercial status; V2 Pro/Omni etc. retired;
  stale trial paragraphs in the same announcement are not a basis.
- OpenCode Zen docs and the OpenRouter model catalog API: aggregator supply is verified per model and per Endpoint;
  catalog availability does not mean every Key/plan has permission.
- OpenAI Astra, Claude model list, MiniMax and xAI model lists: mainstream models are rechecked for stable new members; no
  extension to unrelated speech/image generation products.

### 0.6 Round 2 Acceptance and Status

```text
vendor facts + each aggregator's real supply -> template list / model and protocol rules -> personal override + same Resolver
  -> settings page / every selector / new Model request;  old selections and history not rewritten, bound executions do not switch models
```

- [x] Deep research of the known candidates and other maintained vendors' stable models and retirement status; uncertain items resolved or left with an explicit blocking reason.
- [x] OpenRouter, OpenCode and other applicable aggregators verified per new model; confirmed ones update the built-in list, unconfirmed IDs are not guessed.
- [x] Final per-template add/remove/keep list with default enablement and order; paired exact rules; retired members removed; personal and history boundaries kept.
- [x] Failing tests first, then config: catalog/dedicated rules correspond, context/output/media/levels, alias positives and neighbor-model negatives, vendor vs third-party differences, personal explicit override.
- [x] GPT-5.4 base/Pro/Mini/Nano each have dedicated-config evidence and resolution assertions (vendor, OpenCode Responses, verified OpenRouter prefix, access mapping) keeping existing default enablement and personal override; the new assertions first reproduced the gap.
- [x] Real SDK request verification of reasoning, output parameters, tools and supported media encoding (static JSON correctness is not request correctness); real paid-service verification not possible without credentials, stated honestly.
- [ ] Check desktop and phone and all selectors sharing the config result; no change to continuous / replayable, account state, persistence or bound executions. Code and two-size browser checked; real multi-end remains limited by the environment recorded in the final review.
- [x] Round 1 and Round 2 results recorded separately; latest builtin revision incremented; related tests, typecheck, lint and architecture gate run; no Schema migration. Existing CLI lint failures recorded; no automatic publish; branch push followed the Goal's later explicit authorization.

Round 2 implementation record:

- Revision 21 -> 22: verified vendor and aggregator catalogs, smart config, exact default rules and retirement cleanup;
  all additions disabled, keeping the original enabled prefix. Vendor/aggregator capacity, Schema, levels and snapshot
  differences are scoped to their layers (member lists and limits in the Round 2 research).
- 15 catalog/parameter gaps reproduced first, then implemented; final 22 new config tests plus the historical catalog,
  rule and Map batches pass. Real SDK capture tests cover three protocols, tools, Schema, image/audio/video and binding
  freeze; with signature and existing Model tests 173 items pass; these credential-less paid endpoints were not called.
- Request layer: config allowed Schema but the Chat SDK downgraded it to JSON object by default; minimal fix passes the
  capability through the binding and freezes it, with no vendor check or new protocol; red then green, with assertions for
  the existing off capability and that config edits do not affect a bound model.
- A whole-batch regression found Todo95's test assumed every historical source always supports "off"; it now expects an
  explicit rejection for Kimi Code that no longer supports off. The old rename table, saved selections and history are untouched.
- Local review: rule completeness, neighbor models not mis-matched, Personal priority, catalog/exact-rule pairing and
  system/interface field ownership checked; desktop and phone still share the Registry, no new account/protocol/data
  migration. Root and Adapter typecheck, root lint (0 errors / 42 warnings) and architecture (0 violations) pass. Final
  build/browser/multi-end limits are in the execution ledger and these local results do not replace whole-batch acceptance.

## 1. Round 1 Goal and Findings (history)

Fill models released during development, first covering three, while checking other maintained vendors' recent official
updates (not a whole-web model collection).

| Model               | Verified official facts                                                                                                                                    | Config gap                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GPT-6 Astra         | ID `gpt-6-astra`; 1,050,000 context, 128,000 max output; public levels low / medium / high / xhigh / max                                                   | OpenAI template mainly GPT-5.6; no GPT-6 matching or member                                               |
| Claude Fable 5.1    | ID `claude-fable-5-1`; 1M context, 128K max output; Adaptive thinking always on; vendor-documented forced tool call and cross-model thinking block changes | template still Fable 5; 5.1 hits the broad Claude 5 rule, which is not a correct adaptation               |
| DeepSeek V4.1 Flash | released Sep 10; official API ID `deepseek-flash`, native vision; the old Flash name still accepted and routed to the new one                              | template/rules target `deepseek-v4-flash` / `deepseek-v4-pro`; new ID, vision and protocol mapping needed |

Evidence (checked 2026-09-10): OpenAI GPT-6 Astra page (`gpt6` is a product shorthand, not an API ID); Claude Fable 5.1
overview (legal effort, MCS and forced tool calls checked at implementation, not copied from older models); DeepSeek
updates and thinking-mode docs (the then-recorded Sep 14 12:00 Beijing "V4 Pro routes to V4.1 Flash" notice is superseded
by the 2026-09-11 continued-Pro notice; see 0.5).

## 2. Round 1 Implementation Spec (2026-09-10)

GPT-6 Astra and Fable 5.1 levels: low, medium, high, xhigh, max, no off level, using Responses `reasoning.effort` and
Messages adaptive + `output_config.effort` respectively. DeepSeek Flash: 1M / 384K, text and image, disabled, low, high,
max, with three-protocol mapping; the old Flash alias vision rule on the official endpoint is declared separately (the
third-party old V4 Flash is not forced into the new model). The vendor template adds the new ID, keeps the old member but
disables the old Flash by default, old selections and personal overrides unchanged. OpenCode's official catalog lists
GPT-6 / Fable 5.1; OpenRouter pages confirm vendor-prefixed IDs; unconfirmed aggregator DeepSeek IDs are not guessed.
Fable 5.1 ordinary auto tool calls and JSON schema output reuse the existing chain; forced tool choice is never silently
changed to auto; cross-model signed thinking is handled by the existing generic filter (negative cases added, no new beta).

- [x] Catalog: vendor template members and exact rules; aggregator templates only where their official catalog confirms an ID; user selections and Personal untouched.
- [x] Smart config: context, output, input types, structured output, levels and parameter mapping layered by Model / API / Endpoint, one URL one rule, existing Map style; no generic match spreading new capability to old models.
- [x] Request compatibility: Fable 5.1 always-on thinking, tool calls and thinking blocks; DeepSeek new ID three-protocol mapping and native vision; config first, minimal code fix only when config cannot express and it blocks basic use.
- [x] Completeness and regression: spec and targeted tests first; catalog members, exact default rules, model matching, final request parameters and old-model negatives covered; whole-batch verification.

## 3. Boundaries

No automatic change of user-selected models, history, usage statistics, running executions or bound Tickets, and no
database migration; these models are not added to Zhipu account plans (Account lists follow their real service catalog);
Todo106 owns MCS correction and Todo111 / Todo112 own the Zhipu templates and GLM case; no change to account sync,
effective selection, default selection or per-entry save timing; no vendor-specific UI; not every beta feature is wired.
No open product choice; remaining parameter, aggregator ID and Adapter-compatibility checks are implementation
investigation, and broad Runtime changes (forced tool choice, thinking blocks) would be recorded as a concrete gap first.

## 4. Brief Impact Brief

Capability: model catalog and smart config; layers option-source / validation; seeds are the templates, model rules,
API/site rules and template exact rules of `config/provider/zcode-builtin.json`; out of scope: selection persistence,
account architecture, UI redesign.

| Entry                                            | Shared source / validation                                | Draft and commit owner                                                           | Multi-end isolation                                                       |
| ------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Add provider, model settings                     | Template / ProviderSettingsFacade, public rule resolution | template creates Personal; edits follow existing save                            | desktop and phone share config; no default parameters stuffed into the UI |
| Chat, automation, Subagent, Wiki model selection | Registry and public selection resolution                  | each entry's own draft, Session / task / Markdown / Wiki config; no cross-writes | only candidates and capabilities change, not send or save timing          |

Shared: Built-in publication, Personal override and Resolver; template members, account supply and business persistence
keep their owners. New defaults affect only normal config resolution and write no session database; bound executions never
switch models. Must-inspect: template member / exact-rule alignment, model/API/site override order, final request
encoding (config is the source of truth). Should-inspect: model settings and selectors consuming the result. Invariant:
Personal priority, old selections kept, bound executions fixed, desktop continuous / phone replayable isolated. Evidence
only: `packages/provider/test/model-config-rules.test.ts`, `model-rule-collections.test.ts`, `provider-template.test.ts`
and Adapter tests. No codegraph tool was available; the graph is untouched.
