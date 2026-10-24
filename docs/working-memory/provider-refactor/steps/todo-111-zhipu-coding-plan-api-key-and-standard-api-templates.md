# Todo 111: Four Zhipu API Templates and Request-Safety Validation for Coding Plan Manual Keys

> 2026-09-14 naming update: the two top-row templates are named `BigModel Coding Plan` and `Z.AI Coding Plan` in Chinese
> and English (the trailing `API` removed); the bottom row `BigModel API`, `Z.AI API` is unchanged. This supersedes the
> historical names below. Names still come from Built-in `templateNameMap`; production config is changed first and test
> config is generated from it, with no frontend special case. Template IDs, Access, URLs, model capabilities and existing
> Personal Provider names are untouched; no data migration.
>
> Status: Completed (2026-09-10): four templates, new Access, two-endpoint request-safety validation and browser
> verification. Evidence, boundary review and real-environment limits: [delivery review](./provider-todos-105-113-delivery-review.md).
>
> 2026-09-11 Goal update: Todo120 finished 32 paired groups plus shared lower-layer tests (147 items in total); both
> official addresses with both Access types completed request-safety validation and returned normal text (HTTP 200). This
> replaces the note below that the new Z.ai ordinary-Key path was untested. Limits on the Air / phone / SSH standalone
> installers remain (details in the last section of Todo120, which survives only in the official version).
>
> 2026-09-11 later ruling (implemented, full acceptance pending): an ordinary `api-key` that exactly matches the two
> official Coding Plan Anthropic URLs is also admitted to request-safety validation. This supersedes the old limit below
> that an ordinary Key never enters validation regardless of address; persisted Access is unchanged and no migration of old
> instances is added. Current boundary: [request protocol §5.2](../design/registry/request-compatibility-and-access-protocols.md#52-官方版本请求安全校验). The
> full equivalence verification and review requested by the user are owned by Todo120 and are not complete, so this
> supplement is not claimed as fully accepted.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md`

## 1. Goal and Ruled Scope

The existing `zai-api` / `bigmodel-api` templates use Coding Plan endpoints, so they are renamed to Coding Plan API and
join request-safety validation; two genuinely ordinary API templates are added, giving four manual-Key templates.

| Template display name    | Default API protocol      | Default Base URL                         | Access                          |
| ------------------------ | ------------------------- | ---------------------------------------- | ------------------------------- |
| Z.AI Coding Plan API     | `anthropic-messages`      | `https://api.z.ai/api/anthropic`         | new `zhipu-coding-plan-api-key` |
| BigModel Coding Plan API | `anthropic-messages`      | `https://open.bigmodel.cn/api/anthropic` | new `zhipu-coding-plan-api-key` |
| Z.AI API                 | `openai-chat-completions` | `https://api.z.ai/api/paas/v4`           | existing `api-key`              |
| BigModel API             | `openai-chat-completions` | `https://open.bigmodel.cn/api/paas/v4`   | existing `api-key`              |

- Coding Plan also has a Chat Completions endpoint at `/api/coding/paas/v4`, never mixed with ordinary `/api/paas/v4`;
  defaults are as in the table, not expanded to all protocol/template combinations.
- Account-authorized personal/team Providers stay separate and are not counted among the four manual-Key templates.
- A manual plan Key works without ZCode OAuth login; personal and team Keys share this Access and no organization,
  project or current-account fact is required for team Keys.
- Supporting a Key does not mean the vendor allows arbitrary Key distribution; the user's business description of
  distribution is not recorded as an officially verified authorization.

## 2. Request-Safety Validation Chain and Reuse

```text
account personal/team: zhipu-account -> account service supplies the request Key --+
manual plan: zhipu-coding-plan-api-key -> reads the user-entered Key --------------+-> shared official-version request-safety validation (remote switch / cache, retry / degrade)
ordinary api-key -> ordinary authentication, not in request-safety validation
```

1. The new Access builds on the existing manual-Key config, expressing at least `type` and `apiKey` and reusing template
   Key-acquisition URL metadata; no account-only `current`, `entitled`, organization or project fields.
2. Reuse the official version's existing request-safety validation implementation and transport (no copied algorithm); the
   new type never calls `AccountProviderRequestAuthService` for its Key and is not disguised as `zhipu-account`.
3. Admission follows the explicit Access; the 2026-09-11 supplement adds exact match of an ordinary `api-key` on the two
   official plan full URLs. Never by whole domain, model name, template ID or Key format; ordinary API addresses stay out.
4. The existing remote switch, per-Key isolated cache, cancel, retry and degrade are reused; a new type is not forced into
   validation in every case.
5. Switch off / fetch failure and degradable validation failures send without validation per existing rules; a specified
   validation error that still fails after refresh-retry keeps the existing degrade. Non-degradable errors (invalid
   credentials, missing required request context) are not swallowed by the new type.
6. Validation only calls an HTTPS address at the model endpoint's same origin, does not follow redirects and has no
   official-domain allowlist; "same origin" must not be called "sent only to the official site". Templates use the
   confirmed official defaults; changing editable address range or adding an allowlist needs a separate ruling.
7. The new type keeps the ordinary Key class's config completeness, model executability and personal config saving; it
   derives no account entitlement, plan quota, off-peak eligibility or automatic account switching.
8. Connectivity tests share the normal request chain and keep the existing whitelisted Prompt; no new probe message.

## 3. Config and Consumers Must Be Wired Through

The code only knew `api-key | zhipu-account`; adding a type cannot touch only the admission function.

- Sparse/complete Access schema, config objects, Overlay, deserialization, Registry complete type and serialization all
  support the new type; exhaustive branches must not drop it into the Account branch.
- Settings reuse the manual-Key display, initialization, dirty check, save and Key-acquisition entry. `ProviderDraftSave`
  hardcoded `type: api-key` on save and must preserve the real Access type, or editing would lose request-safety validation.
- Adapter config conversion keeps both Key and access-protocol facts, not only an account `accountAccess`.
- A shared "manual-Key class" check replaces incomplete two-way tests at call sites; account-only consumers keep explicitly checking `zhipu-account`.
- Local and remote Provider config delivery, Worker serialization and request-time binding do not drop type/Key; the
  validation runs in the existing execution Adapter, not per desktop/phone/SSH.
- Template names, descriptions and accessibility text are consistent in Chinese/English; with or without a Key the
  declared acquisition entry shows (Todo107).

### 3.1 Add Provider: Two Groups and Styling (ruled)

The same add page has two sections, "Zhipu" and "Other", with no tab, drawer, collapse or extra page; existing cards and
creation flow are reused.

```text
Add provider  | 20px
Zhipu  | 12px
[BigModel Coding Plan API] [Z.AI Coding Plan API]
[BigModel API]             [Z.AI API]
  | 24px (last card bottom to next group title)
Other  | 12px
[Create custom provider]   [other preset templates...]
```

- "Zhipu" is these four manual-Key templates, plan row first then ordinary row, BigModel before Z.AI; account login
  entries are not mixed in. "Other" starts with create-custom-provider, other templates keep the existing order; each
  template appears exactly once.
- Group titles align with the card left edge; no icon, rule, count badge, group background or outer frame. Follow
  `DESIGN.md` with existing semantic tokens; font sizes below are defaults and follow the UI font-size setting.

| Element                      | Style                                                                     |
| ---------------------------- | ------------------------------------------------------------------------- |
| "Add provider" page title    | unchanged `text-ui-lg font-semibold text-foreground`, default 16px        |
| "Zhipu / Other" group titles | `text-ui-base font-medium text-foreground-subtle`, default 14px           |
| title bar -> first group     | 20px                                                                      |
| group title -> its cards     | 12px                                                                      |
| card gap                     | 8px                                                                       |
| last cards -> next title     | 24px                                                                      |
| card size                    | base height 64px, 16px side padding, existing radius, logo, color, states |

Desktop/wide Web two columns, phone narrow single column; long names may wrap to two lines without relying on a tooltip,
and cards grow rather than clip when larger fonts need it. Chinese/English group titles are `智谱 / Zhipu` and
`其他 / Other`; both themes share semantic colors; keyboard accessibility and focus styles are kept.

## 4. Model Capability Layering

### 4.1 Vision: Model Itself vs Endpoint Enhancement

- The ordinary API `GLM-5.3` is text-only input and gets no image/video from Coding Plan's vision tool in general model rules.
- `GLM-5.3-Flash` is natively multimodal (image, video, file per the vendor) and must not be turned off with GLM-5.3;
  specific file/PDF encoding must still be checked against what the Adapter supports ("File" is not all formats).
- Existing model rules turn GLM-5.3 image/video off and Flash on; plan site rules turn input capabilities on separately.
  Keep this layering and check final resolved results; adding templates must not spread site capability.
- Coding Plan vision tools differ from native model vision; only enhancements the endpoint really accepts go in site rules
  (a standalone client MCP does not prove the endpoint accepts images). One site rule per URL, mainstream/official first,
  Personal final override; MCS and Start/off-peak fixes belong to Todo106.

### 4.2 Ordinary API Search: Service Capable, Adapter Not Wired

The vendors have both a standalone Web Search API and in-conversation search via Chat Completions
`tools: [{ type: "web_search", ... }]`; "only Coding Plan has search" is wrong. `toAiSdkProviderNativeTool()` only supports
Anthropic native WebSearch encoding and Chat Completions would report unsupported, so setting
`supportsNativeWebSearch: true` is not a valid hookup.

- Final ruling: ordinary BigModel/Z.ai API does not enable built-in WebSearch now; no search Adapter work this round, no
  longer a pending item. Their Chat Completions search is a vendor `tools[].web_search` extension, not OpenAI's top-level
  `web_search_options` nor OpenAI Responses' same-named tool; any future hookup needs separate request/result checks.
- The new ordinary templates must not falsely declare built-in search; existing Coding Plan search and other search tools
  are untouched; vendor examples for older models do not verify a GLM-5.3 search combination.

### 4.3 Other Config

Model lists for ordinary API and Coding Plan are checked separately (the broad existing list is not copied as plan
support). Reasoning levels/Mapping, output limit, structured output, MCS and media input are checked per model +
protocol + endpoint, never copying Anthropic config wholesale to Chat Completions. Model static capability, Access
authentication and account entitlement are not mixed into one judgment.

## 5. Key Acquisition URLs

2026-09-11 correction: the personal/team dual entry did not match user expectation and is fully revoked by
[Todo116](./todo-116-single-api-key-management-url.md): only `apiKeyManagementUrl` and one "Get API Key" button remain.

| Product / identity    | Official-doc link                                   |
| --------------------- | --------------------------------------------------- |
| BigModel ordinary API | `https://bigmodel.cn/usercenter/proj-mgmt/apikeys`  |
| BigModel Coding Plan  | `https://bigmodel.cn/coding-plan/personal/overview` |
| Z.ai ordinary API     | `https://z.ai/manage-apikey/apikey-list`            |
| Z.ai Coding Plan      | `https://z.ai/manage-apikey/apikey-list`            |

Z.ai ordinary and plan templates use the same main link (no invented URLs to reach four distinct ones); one plan template
accepts personal/team Keys but the acquisition entry is not split by identity and personal/team navigation inside the
console is left to the user, not guessed from the current ZCode account. The button opens the console directly (not an
explanation page) from `apiKeyManagementUrl` only, with no team-specific field or dual-entry UI, through the same platform
open mechanism and the Todo107 single-source template metadata, with no URL table in a component.

## 6. Template Tidy-Up, No Old-Data Migration

Implementation naming: `zai-api` / `bigmodel-api` stay as the internal identity of the existing plan templates with the
display name now carrying Coding Plan; new ordinary templates are `zai-standard-api` / `bigmodel-standard-api`, so the
existing login-entry template references are untouched and the tidy-up is not widened into rewriting historical Provider
IDs. Plan presets converge to current GLM-5.3 / GLM-5.3-Flash; ordinary templates keep the original ordinary catalog with
IDs normalized per Todo112 and the old broad catalog is not a plan-entitlement claim.

- Ruling: the two templates had no users yet, so no migration or compatibility for old data. The earlier "Provider ID
  also changes" was clarified to "no data migration needed", not a rewrite of personal Provider identity.
- `templateId` identifies a preset template; `providerId` is the concrete Provider identity in Personal config after
  creation; instances reuse existing creation and identity mechanisms and are not rebuilt when templates are renamed.
- No old template alias, old Access / Personal Overlay conversion, old endpoint recognition or historical Selection
  rewrite; no compat branches or migration tests for unshipped intermediate config; an existing explicit Overlay does not
  automatically get the new Access.
- No Session database migration and no bulk modification or cleanup of user Keys, model config or other personal data.

## 7. Evidence and Sources

Official sources (checked 2026-09-10): Zhipu Coding Plan / ordinary API quick-start and HTTP API docs
(`docs.bigmodel.cn`), Z.ai Coding Plan quick start (`docs.z.ai/devpack/quick-start`) and API introduction, GLM-5.3 and
GLM-5.3-Flash guides (text vs native multimodal), Zhipu / Z.ai web-search docs (standalone vs in-conversation search; not
evidence that all models were tested).

Main code: `config/provider/zcode-builtin.json`; `packages/provider/src/config/provider-data-schema.ts`,
`provider-config.ts`, `schema.ts`, `packages/provider/src/resolver.ts`;
`packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts`, `InlineEditableProviderCard.tsx`;
`apps/zcode-cli/packages/adapters/src/model/model-execution.ts`, `tool-transform.ts`; the official version's
request-safety validation; `packages/services/src/model-provider/accountProviderRequestAuthService.ts`.

The existing design `design/registry/request-compatibility-and-access-protocols.md` limited official request-safety
validation to account personal/team; this Todo adds an explicit Access. The spec and feature graph are updated before
implementing; ordinary `api-key` stays out (apart from the exact-URL supplement), and the new Access is not written into
Model Config. Prior read-only checks (request-safety validation / switch / account authentication 54 items, Adapter model
execution 33 items) passed and do not prove the new type.

## 8. Acceptance (all done within the ruled scope)

Spec updated first (Key entry per Todo116's single-entry ruling; ordinary-API search excluded); Schema / Overlay /
serialization tests first (new type valid and fully round-trips, not mixed with the account type, a missing Key affects
only that Provider's completeness); four templates' default name, protocol, address, Access, Key link and list with
discriminating capability assertions (ordinary/plan, GLM-5.3/Flash); Key edit/save keeps the new type, entry shown with
and without a Key, Chinese/English and narrow screens usable; without OAuth/account connection a manual plan Key still
works through the same validation while account personal/team keep their behavior and ordinary Key, Start / off-peak are
not pulled in; mock transport with the real Adapter captures final requests for both plan endpoints (switch, validation)
and ordinary API requests do not enter validation, covering per-Key isolation, degrade on failure and non-degradable
errors, without real user credentials; the new Access survives target Host/Worker delivery, config refresh and Model
binding with no phone-specific Runtime or second SSH validation chain; creating instances from the four templates gives
the right template reference, Access and personal Provider identity with no old template/Overlay migration; ordinary
templates do not enable built-in WebSearch and existing Coding Plan search is unaffected; add-provider group members,
order and creation behavior and the section 3.1 styling (desktop two columns, phone single column, Chinese/English, both
themes, long names, keyboard); settings E2E updated and targeted regression, typecheck, lint and architecture check run by
risk batch; final review of template completeness, Access/Model/Account layering, ordinary billing vs plan semantics,
implicit consumers and updated old rulings. Document landing or old-test passing is not whole-item completion.

## 9. 2026-09-11 URL Admission Supplement: Verification and Review

- Single implementation point stays the Adapter's official-version request-safety admission entry, using the bound
  Access/Base URL; matching only decides whether the same validation is entered. No config migration, persisted write,
  extra cache, UI/Host branch or model-name special case.
- Tests red then green: ordinary Key official URLs, trailing slash and equivalent standard forms did not enter validation
  before and now do; ordinary API paths, other paths, similar/third-party domains, non-default ports, HTTP, query and
  fragment do not. With the switch off a match does not enter validation; the explicit plan type still supports its
  original custom endpoints.
- Adapter targeted 2 files / 51 items, shared request-safety / switch 2 files / 47 items, 98 in total, including the
  existing account Start/Off-Peak exclusion, per-Key isolation, cache, retry/degrade and error boundaries.
- With a user-authorized Key, in an isolated in-memory config keeping Access as `api-key`, a real request to the BigModel
  official plan endpoint completed the official request-safety validation and the final model request returned HTTP 200.
  The Prompt was strictly system `You are ZCode connectivity probe.` / user `hi`; Key and validation material are not
  written to documents, config or diagnostics; no Air config was changed.
- Root typecheck, Adapter typecheck, root lint (41 existing warnings, 0 errors), changed-file format check and the
  architecture check (baseline/new 0) pass. Whole-directory Adapter lint still fails on unchanged files' existing max-lines
  etc. and is not widened here; changed-file lint passes.
- No interaction or message-delivery boundary changed, so no new UI E2E; both addresses have real SDK + offline transport
  assertions. The new ordinary-Key path was tested online only against BigModel, which must not be written as Z.ai, Air
  installer, real phone or SSH accepted.
