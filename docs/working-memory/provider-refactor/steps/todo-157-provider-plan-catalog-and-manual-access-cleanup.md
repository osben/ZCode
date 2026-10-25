# Todo157: Vendor plan entries, Go model completion and manual-Key Access cleanup

> Status: pending; new vendors are candidates to be evaluated. This round (2026-09-16) only organized the
> Todo and index; no product code or config was changed.
>
> Source: the discussion comparing Kimi API / Coding Plan, other vendors' plans and the OpenCode Go
> catalog. The user explicitly cancelled the custom-proxy-domain security-signing allowance of the special
> manual Access; the visual-badge approach based on template identity is recorded below.

## Goals and order

1. Complete API / subscription entries of existing vendors and the OpenCode Go catalog, so users do not put a plan Key into a pay-as-you-go endpoint.
2. Remove `zhipu-coding-plan-api-key`: manual Keys unify to `api-key`; its independent security-signing admission is cancelled and the visual badge no longer depends on that type.
3. Evaluate the first batch of new vendors, then onboard them one by one on a clear product entry and real protocol evidence; a candidate is not a verified release.

Each slice is verified and committed independently. This Todo continues the scope of
[Todo22 new vendor plan](./todo-22-additional-builtin-providers-and-cloud-access.md),
[Todo113 model catalog refresh](./todo-113-new-model-catalog-refresh.md) and
[Todo149 Go support](./todo-149-opencode-go-support.md) without repeating finished work. Before
implementing, sync the final contract to the [current design](../design-v2/design.md) and the matching
feature specs; history is read by the [authority order](../design-v2/README.md).

## 1. Product entries of existing vendors (survey baseline 2026-09-16; re-verify endpoints, members and plan rights at implementation)

| Vendor          | Current problem                                                                                                       | Target                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kimi            | `moonshot-kimi` points to the open platform but includes the Code-side `k3` / `k3-256k` and has no subscription entry | split Kimi API and Kimi Coding Plan (Kimi Code), each with its endpoint, Key page, model members and capabilities                                    |
| MiniMax         | only the ordinary MiniMax entry                                                                                       | add Token Plan; make the subscription-Key vs pay-as-you-go-Key difference clear; verify domestic/international credentials per the official contract |
| Alibaba Bailian | only China / international API                                                                                        | add Coding Plan and Token Plan; verify personal/team, region and protocol separately, no duplicate templates by plan name alone                      |
| Xiaomi MiMo     | only the ordinary API                                                                                                 | add Token Plan; match the plan `tp-` Key vs ordinary `sk-` Key and regional plan endpoints separately                                                |
| Z.ai / BigModel | API and Coding Plan already separate templates but manual plans use a special Access                                  | keep the four template identities and current names; the plan Access becomes the generic `api-key`                                                   |

- Kimi Code's official model IDs are `k3`, `k3-256k`, `kimi-for-coding`, `kimi-for-coding-highspeed` (then `kimi-for-coding` was K2.8 Preview). Open-platform version names are not Code request IDs, and not every member is assumed to hold every model right.
- New API-Key-type plans reuse `api-key` first; no special Access per vendor plan. OAuth, credential renewal or account-entitlement refresh need a separately designed real auth contract.
- The same endpoint does not imply the same billing credential; the same Key/endpoint with different model rights need not be mechanically split into templates. Each entry has a clear Key page, API type, Base URL and model range.
- Existing instances' Provider ID, name, Key, personal overrides, order and historical ModelSelection are not bulk rebuilt. Kimi's existing template stays as the open-platform entry; before cleaning the default catalog, check old options and the recovery boundary of user-defined models.

Sources: [Kimi platform differences](https://www.kimi.com/code/docs/kimi-code/faq.html), [Kimi Code models](https://www.kimi.com/code/docs/kimi-code/models.html), [MiniMax Token Plan](https://platform.minimax.io/docs/token-plan/quickstart), [Bailian plan access](https://help.aliyun.com/zh/model-studio/more-tools), [MiMo Token Plan](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access).

## 2. OpenCode Go catalog gaps

Production and test configs hold 25 models; the official endpoint table lists 28. Missing:

| Missing Model ID             | Target template         | Protocol         |
| ---------------------------- | ----------------------- | ---------------- |
| `longcat-2.0`                | `opencode-go-chat`      | Chat Completions |
| `muse-spark-1.3-contributor` | `opencode-go-responses` | Responses        |
| `muse-spark-1.2-contributor` | `opencode-go-responses` | Responses        |

- The existing 25 models' grouping matches the official table; `minimax-m2.5` is still in the table and is not removed because the intro list omits it. Zen's `muse-spark-1.2-contributor-free` does not count as Go coverage (no reuse of its ID or rights).
- Reuse Todo149's site rules, real requests and default-enable boundary: Muse Contributor defaults off pending region and data-use checks and is not a default recommendation.
- When adding members also check input capabilities, context, max output, tool calls, reasoning levels and mappings; fields the source cannot prove are not guessed from model names.
- Direct `/zen/go/v1/models` returned HTTP 403 in this round; the gap comes from the [official endpoint table](https://opencode.ai/docs/go/#endpoints). No Key-based request was made, so catalog comparison is not an online call pass.

## 3. Remove the special manual-plan Access

### 3.1 Security-signing ruling

The user cancelled the behavior where `zhipu-coding-plan-api-key` lets a manual Key at a custom proxy
address enter the signing flow regardless of domain. No new field, template ID or implicit check restores that bypass.

```text
Access + Base URL bound to the Model
  zhipu-account / Start or Off-Peak -> no security signing; keep the original JWT / Key / Ticket
  zhipu-account / personal or team Coding Plan -> keep the existing account signing admission
  manual api-key -> only existing official domains or exact test hostnames enter the signing flow
  everything else -> not in the signing flow
then: original remote switch -> HTTPS constraint -> official-version request signing / retry / degradation
```

- Keep the official `z.ai` / `bigmodel.cn` root domains and subdomains, and the exact `api.z.ai` / `zcode.z.ai` test-domain rules; the hostname boundary is not widened.
- Only the manual special Access entry is cancelled; the account personal/team signing rules stay. The Start / Off-Peak priority exclusion stays valid. Existing signing, switch, cache, error and cancellation semantics are kept with no second validation state.
- This supersedes the manual-special-Access independent admission part of [Todo111](./todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md) and Todo136; Todo142's account exception stays (these two documents exist only in the official version).

### 3.2 GLM-5.3 vision badge

Minimal display change: manual plans are recognized by `templateId`; account plans keep being recognized by
the existing Access mode. Both Views already carry template identity; the settings page and model menu share
the check; no new Model capability Schema.

| Condition (model ID exactly `glm-5.3` ignoring case)           | Vision badge              |
| -------------------------------------------------------------- | ------------------------- |
| Template `zai-api` / `bigmodel-api`                            | hidden                    |
| Account personal/team Coding Plan or Start Plan                | hidden                    |
| Ordinary API template, template-less custom Provider, Off-Peak | shown per `supportsImage` |

- Every model first needs `supportsImage === true` to be shown; GLM-5.3-Flash and other models keep showing by capability. GLM-5.3's real image input capability is kept: never set `supportsImage` false to hide the badge, nor change attachment upload, validation or request encoding.
- No guessing of plan templates from display name, Provider ID prefix, Key content or official domain. An instance already linked to a plan template keeps template-identity display even if renamed or re-URLed; that grants no signing admission or plan entitlement. A template-less old special Access, once normalized, displays as an ordinary custom Provider (no fake template link to keep the historical badge).
- Supersedes how [Todo126](./todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md) / [Todo137](./todo-137-start-plan-glm53-vision-badge.md) recognize manual plans; their image capability and account-plan display boundaries stay.

### 3.3 Config compatibility and retirement

- The formal Schema, domain objects, serialization and Runtime keep only the generic `api-key` and the existing `zhipu-account`; no long-term two manual-Key semantics.
- Before implementing, audit Built-in cache, Personal config, import and remote-config read boundaries. At the single explicit compatibility decode/migration entry, old manual types are normalized to `api-key`, keeping Key, management page, existing templateId and personal overrides; an old value must not make the whole config read fail or lose the Key on overwrite.
- The compatibility layer neither restores the special signing behavior nor double-writes the old type. Record the concrete entry, sources that may still deliver old config, test evidence and exit condition; deleting the enum alone is not completion.
- No rebuild of historical Provider / ModelSelection; account Access and credential owners unchanged; local and remote each handle their own config and never mix Host credentials.

## 4. New-vendor candidates and exit conditions

Candidates come from a public third-party provider preset survey (this round); priority is this round's
suggestion and no entry is proven releasable. Promotional links, historical plans and client-specific config are not copied directly.

| Batch  | Candidate                                                | Settle before implementing                                                                                                                                                                  |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First  | Volcano Ark / Doubao                                     | valid entries of API, Agent Plan and old Coding Plan, model identity, existing-user boundary; [Agent Plan](https://www.volcengine.com/activity/agentplan)                                   |
| First  | Tencent TokenHub                                         | Token Plan first; general / Hy plans share Key and endpoint but differ in model rights, avoid duplicate templates; [access docs](https://cloud.tencent.com/document/product/1823/130119)    |
| First  | Baidu Qianfan                                            | API and personal Token Plan; the old Coding Plan stopped renewal and is not a new default; [upgrade notice](https://cloud.baidu.com/news/notice_e839687d-1cf7-4a5b-afbd-ea2f7bcd325d)       |
| First  | SiliconFlow                                              | China / international address, Key ownership and models each protocol actually supports; [access docs](https://docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-ClaudeCode)           |
| First  | Google Gemini API                                        | evaluate only the official OpenAI-compatible interface and API Key, verifying tool calls, thinking signatures and image chain; [compat notes](https://ai.google.dev/gemini-api/docs/openai) |
| Second | StepFun, LongCat, PPIO, ModelScope, NVIDIA NIM, BytePlus | evaluate by user demand for product entry, existing protocol expressiveness and model evidence; no half-finished templates released                                                         |

- Gemini candidacy does not lift Todo22's exclusion of a native Google Adapter / Vertex; if the compat interface cannot meet the contract, record the gap and design separately. Bedrock, Azure and other complex cloud auth stay in Todo22 and are not mixed into ordinary template gaps; a new type needs a real auth need, and hand-written URLs must not hide region, deployment identity or signing differences.
- Before a candidate becomes an implementable slice, list its exact name, Template ID, Key page, endpoint, original Model IDs, default-enable range, capability and parameter evidence and the real verification conditions.

## 5. Implementation entries and acceptance

Config entry `config/provider/zcode-builtin.json`: edit only the production source, generate the test config
with `pnpm provider:config:sync-test` and run `pnpm provider:config:check-test`; bump the actual latest
revision (not the round's baseline 28); no auto online publish. Access and read boundaries: check
`packages/provider/src/config/`, `packages/provider/src/resolver.ts`, `packages/provider-node/` and existing
persistence/import consumers; the signing admission entry is
`apps/zcode-cli/packages/adapters/src/model/model-execution.ts`; display entries are
`packages/ui/src/lib/modelVisionBadge.ts`, `modelSelectionGroups.ts`, the settings `ProviderFormControls.tsx` and its props chain.

- [ ] Re-check baseline and user changes, do architecture impact analysis for matched directory rules, update the matching specs and historical-conflict rulings (research candidates are not written as current fact).
- [ ] Tests first: all four Zhipu templates are `api-key`; old special type reads normalize, Key save/overwrite does not lose it, template link and historical selection kept.
- [ ] Signing tests cover official / exact test domains, lookalike domains, custom proxy, switch off, HTTPS and degradation; a proxy manual Key does not enter signing, the account exception does not regress.
- [ ] Settings page and model menu cover the two manual plan templates, ordinary API, template-less custom, personal/team/Start/Off-Peak; GLM-5.3 exact match, Flash and the underlying image capability kept.
- [ ] Load the real Built-in and verify each entry's members, default enablement, full capabilities and mappings; the Go catalog gap reaches zero or each deferral is explained (region-restricted models are not assumed available to all accounts).
- [ ] New entries verify the final generate / stream request, tool calls, reasoning and usage; template and manual same-endpoint with no personal override execute identically; record unverified scope when no real Key.
- [ ] Root typecheck, lint, `pnpm architecture:check --changed`, affected tests; CLI changes also run CLI typecheck/lint and related package tests.
- [ ] E2E workflow: reuse/maintain settings and model-selection cases for desktop/phone, light/dark and zh/en; shared-component browser evidence does not stand in for the native or phone remote chain; pending is not auto-promoted.
- [ ] Check local/remote config and credential isolation, continuous/replayable boundaries; check template create, edit, restart recovery and old-config compatibility.
- [ ] Self-review the diff, record verification and leftovers per slice, then commit locally; push, MR and online config release run only on user request.

## Delivery and open items

This round only added this Todo and the index; product implementation, config update, old-type migration and
the acceptance above were not executed. At survey time the existing CLI signing admission/equivalence two
files (134 tests) passed; they prove current behavior and official-endpoint equivalence, not the new
behavior after removing the special type (old proxy-domain expectations must change at implementation).
The final template list of new vendors, models available per plan and real-call evidence remain to be
filled in; candidates stay candidates with no automatic release or account authorization.
