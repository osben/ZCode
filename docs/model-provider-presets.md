# Model Provider Presets

> **Supersession note (2026-10):** the removal of official codex/claude/gemini OAuth presets below
> remains in effect EXCEPT for chatgpt. OpenAI runs an official "Sign in with ChatGPT" (SIWC)
> token-sharing program for open-source agents providing a legitimate plan-backed provider; the
> `account:chatgpt-plan` preset is intentionally added under that program. See
> https://developers.openai.com/siwc (in particular
> https://developers.openai.com/siwc/token-sharing-open-source). This does not reinstate
> codex/claude/gemini OAuth presets.

## Current boundary

- Auto-refreshed preset providers include only current Z.ai and BigModel API Key, Coding Plan, and
  Start Plan entries.
- `default-*` custom provider templates are removed; preset refresh no longer adds OpenRouter,
  Moonshot, MiniMax, DeepSeek, MiMo, Qwen default templates.
- Official codex/claude/gemini OAuth is no longer a model provider settings entry and no longer
  exposes model provider service RPC.

## Remote model capability enrichment

- `client/configs.builtinModels` carries official model facts keyed by model ID, not only for
  builtin providers.
- After every preset provider sync, all providers — including Start Plan and user-created custom
  providers — may fetch remote `reasoning` and `modalities` for existing models by model ID; this
  path never adds or removes models.
- Model IDs match on the full `trim + lowercase` string; no alias, prefix, suffix, substring or
  fuzzy matching; the local provider's model ID is kept on hit.
- `reasoning` is fill-only: use the remote fact when local is absent, keep local intact when
  configured. `modalities` merge per input/output side only when `modalitiesConfigured !== true`;
  once the user configures them, local values are kept whole. This path never overwrites context
  window, max output tokens or other local model metadata.
- Start Plan's model set stays governed by billing/balance entitlement; enrichment only enriches
  models already in the plan — never widen plan selection via `builtinModels`.

## GLM default models

- Z.ai / BigModel API Key preset default GLM list: `GLM-5.2`, `GLM-5-Turbo`.
- Z.ai / BigModel Coding Plan preset default GLM list: `GLM-5.2`, `GLM-5-Turbo`.
- Start Plan free entry model list: `GLM-5.2`, `GLM-5-Turbo`.
- API Key entries let users customize model context window; saved explicit values win over preset
  defaults, and the settings page and `config.json` must stay consistent.
- Coding Plan and Start Plan entries let users manually append model configs; locally saved user
  models only express client-selectable models and never change server-side plan entitlement,
  whitelist or quota validation.
- In Coding Plan and Start Plan entries, `GLM-5.2` context window is fixed at `1_000_000`; the
  settings model list uses English compact token notation (`128K`, `1M`).
- Default list order is the UI and model-selection display priority; remote or local sync must not
  reinsert legacy hosted GLM models into the default list.
- `GLM-5.1` no longer appears in Z.ai / BigModel API Key, Coding Plan or Start Plan default model
  selections.

## Start Plan naming

- `builtin:zai-start-plan` display name is fixed as `Z.ai - Coding Plan`.
- `builtin:bigmodel-start-plan` display name is fixed as `BigModel- Coding Plan`.
- Historical Chinese or `Start Plan` names already persisted by old versions are read as legacy
  data only; the display layer normalizes to the fixed names above.
- In the zh-CN purchase entry banner the Start Plan entry title shows “体验套餐”; English locales
  keep `Start Plan`.

## Coding Plan detail page

- With Coding Plan active, the detail page keeps URL, Models and other config; Models allow manual
  appends; the status-card upgrade entry only opens the purchase flow and never replaces or hides
  the config section below.
- Not logged in, not connected, not subscribed, or entitlement fetch failed: the detail page shows
  only the Coding Plan status card and a hint banner below — no API Key, URL or Models config — so
  a managed plan entry is not mistaken for manual configuration.
- BigModel signed out: no trial-plan title or trial quota copy; below the status card, three
  full-width entry banners “Start Plan”“个人套餐”“团队套餐”. Start Plan uses the Start Plan quota
  banner's soft green emphasis; 个人套餐 and 团队套餐 use Pro blue and Max gold respectively, with
  the Start Plan top-left radial gradient, bare icon, title, description and right arrow. When the
  150% quota campaign config is available, both 未登录 “个人套餐” and “团队套餐” entry titles show the
  compact campaign badge.
- BigModel signed in with neither Start Plan nor Coding Plan entitlement: no trial title or quota
  copy; below the status card, two full-width banners “个人套餐” and “团队套餐” with the same Pro
  blue / Max gold styling, gradient, icon, title, description and arrow.
- In Upgrade Coding Plan, non-purchasable plan action buttons uniformly use outline disabled
  style; purchasable / upgradable / renewable buttons keep the default primary style. Sold out,
  current plan, already included, not purchasable and unavailable billing period are all outline
  disabled.
- BigModel signed in with enterprise plan pricing returned: the team entry no longer shows a single
  generic “团队套餐” banner but reuses the Upgrade Coding Plan team group to render multiple team
  banners (e.g. “标准版”“高级版”) with prices from the matching team plan products. Signed out or
  team pricing not yet available keeps the single “团队套餐” lead-in entry.
- The personal plan entry banner leads with sold-out status when signed in with a usable purchase
  token: if all personal plan products are `soldOut`, the price slot shows “暂时售罄” instead of the
  lowest price. Signed out shows no sold-out state and keeps the normal entry and price fallback.
- Z.ai has no team plans today: purchase panel and detail entry show personal plans only, no team
  entry.
- BigModel team plan list cards express selection via border and background only, with no
  “已选择” text label.
- With Start Plan or Coding Plan active, opening upgrade or the purchase panel does not collapse
  the today-balance and remaining-quota cards (5h, 1w, Tool) below the status card; the purchase
  action only appends the purchase panel.
- With Coding Plan active, the 5h, 1w and MCP remaining-quota cards below the status card show the
  API's `nextResetTime`, formatted like the sidebar remaining quota: 5h shows date-time with the
  date omitted same-day; 1w and MCP show the date.

## Legacy data migration

Loading the local provider store cleans up legacy `default-*` providers:

- Empty `apiKey`: never enabled by the user — deleted.
- Non-empty `apiKey`: treated as user-customized, kept as an ordinary custom provider with no
  default-template ordering or auto-refill.

Preset refresh updates builtin provider metadata only; an ordinary preset refresh never implicitly
modifies user API keys.
