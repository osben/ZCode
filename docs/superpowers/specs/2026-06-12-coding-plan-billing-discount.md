# Coding Plan Limited-Time Quota Promotion

`GET https://zcode.z.ai/api/v1/client/configs?app_version=<ZCODE_VERSION>&platform=<platform>-<arch>` may return `data.configs.codingPlanBillingDiscount`, which drives the Coding Plan limited-time quota promotion UI.

Semantics:

- Field absent: no promotion UI, no badge or banner.
- Field present: the UI reads the locale-scoped copy the field delivers; there is no hardcoded fallback copy, and if the current locale (or a required string) is missing, that promotion UI is not shown.
- Shape: `{"zh-CN": {"cardTitle": "...", "cardBody": "...", "badgeBody": "..."}, "en-US": {...}}`.
- Copy expresses a quota promotion, never a price discount.

Presentation:

- Context usage remaining: the title ("剩余额度") carries a compact short badge (`text-ui-xs`, default gradient); the composer context usage popover shows it, but the sidebar usage-remaining Coding Plan title does not (menu-title overload).
- Model Settings: short badge beside the personal and team plan status card titles; not on Start Plan status/plan card titles, not on provider navigation entries or family headers — only where Coding Plan entitlement semantics are explicit.
- Coding Plan plan list: top banner with the `astroid` icon, `text-base` title. The banner's right edge shows the short badge plus an `info` icon trigger via `CodingPlanBillingDiscountBadge` (`<>badge div + info</>`, no Button wrapper); clicking `info` opens the existing Dialog explaining the GLM-5.2 150% quota conversion rules. Inside the gradient banner the badge switches to `surface` style (`bg-white text-[#191A1D]`) so it stays visible against the banner background.
- `CodingPlanBillingDiscountBadge` always renders badge + info; contexts nested inside a button use the plain pill `CodingPlanBillingDiscountBadgePill` to avoid a Dialog trigger inside a Button.
- The rules Dialog body uses the existing Markdown renderer with `text-foreground`; an `##` heading, list-form rules, original promotion wording, `max-w-lg` width, `div.p-3.!space-y-3` wrapper. Content: using GLM-5.2 via Coding Plan in ZCode consumes quota at a 0.67 coefficient for the whole cycle — the same model usage deducts only 67%, i.e. roughly 1.5× usable quota; peak hours 14:00–18:00 change from 3x to 2x, off-peak from 1x to 0.67x; expiry follows official announcements. No greetings or thanks. All Dialog copy goes through i18n, never hardcoded in the component.
- Start Plan: the upgrade button shows the short badge (`bg-white text-[#191A1D] rounded-full`, no `trending-up` icon, text only, e.g. `150% 配额` / `150% Quota` from `badgeBody`), and the active upgrade button's right side carries the same `info` trigger reusing the Dialog — for the plan card, the chat context panel upgrade button, and the chat Start Plan quota banner. With existing Start Plan entitlements the upgrade button uses `button-gradient dark:bg-[#484A58]`.
- Chat quota banner specifics: the embedded badge uses `pr-px` (1px promotion background edge next to the button's right side); Model Settings keeps its own card button spacing. The banner's active upgrade button has no fixed height — badge and content size it naturally, avoiding crowding/clipping against `h-6`.
- All short badges use badge-level `text-ui-xs`, single line, no wrap; compact variants shrink spacing/icon only, never the font-size tier.

Fetch and cache:

- The service reads the field through `BigModelCodingPlanSubscriptionProvider.getClientConfigs()`, reusing the existing `clientConfigSnapshot` / `clientConfigRequest` so sidebar, context usage, and settings do not issue duplicate on-screen requests.
- `clientConfigSnapshot` and the UI promotion-state cache both use a 1-hour TTL; expiry triggers the next `/api/v1/client/configs` request.
- The UI lazy-loads promotion state on mount without blocking usage remaining, Start Plan, or plan list rendering.
