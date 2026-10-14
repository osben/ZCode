# Chat Input Context

> **Current status**: this document is calibrated to the V4 composer wiring. Context usage comes
> from the V4 conversation snapshot; the legacy task runtime/store is no longer read.

## Goal

Turn the context usage entry at the bottom of the chat input bar from static text into the
AI Elements `Context` compound component.

## Current implementation

- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
  - Maps the snapshot's `usage.contextWindow.usedTokens` / `maxTokens` / cache / breakdown into the input-bar display model
  - Reuses `ChatContextUsage` from `packages/ui/src/chat-input-toolbar/contextUsage.tsx`
  - Reuses the already-loaded Z.ai / BigModel Coding Plan entitlement instead of issuing duplicate quota requests from the context menu
  - Coding Plan `Usage Remaining` reuses the paid Coding Plan entitlement/state parsing utilities, but the display entry stays limited to the input-bar context and the Usage page
  - The footer badge and the input-bar context share one provider/apiKey fingerprint cache for the Coding Plan entitlement and align paid-plan query parameters, so quotas from the same source are not split into two caches
  - Uses `ContextTrigger` as the context entry point
  - Uses `ContextContentBody` to show context window usage, breakdown, cache hit rate, and Coding Plan `Usage Remaining`
  - Cache hit rate is shown only when the main-turn cumulative hit rate is ≥ 78%; lower values are not displayed in the compact context panel
  - Coding Plan usage inside the input-bar context renders independently and does not reuse the sidebar menu panel UI
- `packages/ui/src/components/ai-elements/context.tsx`
  - Added a zero upper-bound guard so the progress percentage can never become invalid
  - Percentages, compact numbers, and currency now follow the current environment locale
- `packages/ui/src/CodingPlanUsageRemainingPanel.tsx`
  - Hosts the remaining-quota number rows and provider switching shared by the Usage page and the input-bar context
  - Exports entitlement/state parsing utilities so the input-bar context can reuse the data semantics
  - The three Coding Plan quota bars in the input-bar context menu use the usage chart blue, green, and purple in order: `--color-usage-chart-1` / `--color-usage-chart-2` / `--color-usage-chart-3`
  - The Coding Plan quota bars use the settings-page Start Plan compact height, `h-1.5`
  - Coding Plan bar text stacks vertically: subtle label, `percent · reset`; the percentage uses mono, the reset time uses `text-ui-xs` and is not mono
  - Coding Plan usage columns adapt to the number of displayable quotas: 1 quota → 1 column, 2 → 2, 3 → 3; each item keeps the compact label / remaining percent / bar vertical structure
  - The Coding Plan block follows the body padding and no longer uses footer-style outset margins or a top border separator
  - The Coding Plan title row reuses the compact `Context window` title style instead of a separate header divider layer
  - Start Plan `Today's balance` renders independently and does not reuse the settings-page `StartPlanBalanceCard` or the Coding Plan panel components; the layout follows Coding Plan's compact title, meter, and separator rhythm
  - Start Plan `Today's balance` shows only when the current model belongs to a Start Plan provider; an `Upgrade` button on the title's right leads directly to that Start Plan provider's plan upgrade entry
  - The Start Plan `Upgrade` button mirrors the settings-page Start Plan upgrade button: a gradient rounded-pill style during active discounts, with a discount badge
  - Start Plan `Today's balance` shows remaining percent, renew time, and a bar; renew time prefers `subscription.details[0].renewTime` and falls back to the balance item's `nextResetTime`; today shows time only as `99% · 23:02`, another day shows date and time as `99% · Jun 15 23:02`; no used/remaining/total text is displayed, the bar height is `h-1.5`, and the bar stays `success` green
  - Start Plan balance columns adapt the same way: 1 quota → 1 column, 2 → 2, 3 → 3; each item keeps the compact model label / remaining percent / bar vertical structure
  - The `Context windows` and `Coding Plan` section titles both use `text-ui-base`
  - The used / total summary next to the `Context windows` title uses localized compact token units; English uses uppercase `K` / `M` / `B`, Chinese uses `万` / `亿`
  - The `Context windows` progress segments are based on the Coding Plan blue `--color-usage-chart-1` and fade step by step in proportion order
  - The Coding Plan details entry in the input-bar context menu renders as link-style `More` text with a right arrow
  - Clicking the Coding Plan `More` entry closes the context panel first, then opens the usage details, so no overlay is left behind after navigation
  - The Coding Plan block shows its top separator and top spacing only when the `Context windows` usage block is displayed above it
  - When a Coding Plan reset opportunity appears, the context trigger reuses the project-wide `ControlHintTooltip` with its default offset and enables the wrapper's `standalone` Provider boundary to support independent SSR/test rendering; the Tooltip immediately shows a persistent gift icon with `{count} reset quotas`; once the user hovers, focuses, or taps to open the context panel, the first reminder collapses for this window; the business layer controls only display state and rich content, and does not compose low-level Tooltip primitives directly
  - When the same opportunity's earliest expiry enters its final 3 minutes, the Tooltip again shows a persistent alarm icon with a live countdown `Reset quota expires {time}`; if the first reminder has not been dismissed, it switches to the urgent reminder in place
  - The gift icon uses the theme semantic success color and the urgent alarm uses the theme semantic warning color; the countdown `{time}` in urgent copy uses a fixed `h-3.5` (14px), `text-ui-xs px-1.5`, a light warning background, warning text, and `tabular-nums` compact pill styling; the alarm sways left and right continuously and stands still under `prefers-reduced-motion`; after the urgent reminder has been viewed, the same opportunity does not repeat, and it collapses immediately when the opportunity becomes invalid, the quotas are full, or it expires
  - The round context trigger button expresses the current opportunity state on its own: with a valid opportunity and more than 3 minutes left it uses only the success foreground color without a state background; inside the final 3 minutes it switches to a light warning background with warning foreground; dismissing the Tooltip does not clear the button state color, and the default color returns once the opportunity becomes invalid or expires
  - The context trigger Tooltip shows only one state at a time, with the priority "resetting/reset" > "urgent opportunity" > "first opportunity"; the Tooltip only reminds — the reset action still happens in the context panel
  - Both the first and urgent opportunity Tooltips provide a round close button on the right; closing only marks the current phase as read — it does not open the context panel or affect the opportunity itself; the read state is shared by the current renderer window, so after switching sessions or remounting the session component, the same phase of the same `sourceKey + earliestExpiresAt` opportunity does not show again; this state is not persisted and does not cross windows, and a new expiry still reminds as a new opportunity; the button reuses the shared `Button` `icon-xs` size overridden to `rounded-full`, uses no negative margin, and has the `关闭提醒` / `Dismiss reminder` accessibility label
  - In the urgent reminder the alarm and the copy keep `gap-1.5`, while the countdown text group and the close button use `gap-0` to avoid extra space on the right
  - The opportunity reminder content uses the model Tooltip's `text-ui-sm` size; because the round close button is fixed at `20px`, the reminder Tooltip uses `bg-background py-0.5 pr-0.5` so its overall size aligns with the model Tooltip and uses the page background color
- `packages/ui/src/i18n/locales/en-US.ts`
- `packages/ui/src/i18n/locales/zh-CN.ts`
  - Added the hover card copy

## Result

- The chat input bar keeps a compact context entry
- Hovering reveals a fuller context explanation plus the current Coding Plan remaining quota
- The component shape stays consistent with the `elements.ai-sdk` context docs

## Context budget tone (ZCO-19, additive)

The context meter must warn at the same token counts the runtime actually compacts at, not at
arbitrary fixed percentages. The compaction threshold math therefore lives in one place,
`packages/shared/src/contextBudgetPolicy.ts`, and the CLI compact policy
(`apps/zcode-cli/packages/core/src/compact/policy.ts`, `microcompact.ts`) consumes the same
constants from `@zcode/shared`; the UI reuses them via the shared helpers. Shared constants are
the single source of truth; the core modules re-export them so existing import paths keep working.

Threshold math (defaults, mirroring the runtime policy):

- `autoCompactThreshold = max(0, contextWindow − min(maxOutputTokens ?? 32K, 21K) − 13K)` — the
  token count at which the next model step triggers a full summary compaction.
- `microcompactThreshold = max(0, floor(autoCompactThreshold × 0.9) − 2K)` — the token count at
  which old tool results start being cleared.

UI tone mapping (`resolveContextBudgetTone`):

- `critical`: `usedTokens ≥ autoCompactThreshold` — auto-compact fires on the next model step.
- `warning`: `usedTokens ≥ microcompactThreshold` — microcompact is actively clearing old tool
  results.
- `normal`: below the microcompact threshold, or invalid input (`usedTokens ≤ 0`/non-finite).

Rendering rules:

- The round trigger recolors via foreground semantic tokens: `warning` → `text-warning`,
  `critical` → `text-destructive`. A quota-reset opportunity tone on the same trigger keeps
  priority (transient state wins over steady state).
- The context panel gains one label/value row `chat.contextUsage.autoCompact` showing the
  auto-compact point as `≈{compact tokens} ({percent of window})`, styled like the cache-hit-rate
  row.
- The trigger carries `data-usage-tone={tone}`; the hidden `TID_V4_MODEL_CONFIG` anchor adds the
  same attribute for E2E assertions.
- Assumption: the UI does not know the model's `maxOutputTokens`, so the reserve falls back to
  the 21K preflight cap — identical to the runtime whenever the model's max output is ≥ 21K.

Acceptance scenarios:

1. 200K window, no max output: thresholds are micro 147 400 / auto 166 000; used 147 399 renders
   normal, 147 400 warning, 166 000 critical; the panel row shows `≈166K (83%)` in en-US.
2. Quota-reset reminder visible with `usedTokens ≥ autoCompactThreshold`: trigger keeps the
   quota tone (success/urgent) and does not apply the budget tone.
3. Invalid usage (`used = 0` or non-finite): no trigger recolor, tone attribute reads `normal`.
